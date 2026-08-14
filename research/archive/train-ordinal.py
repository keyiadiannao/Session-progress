"""
train-ordinal.py - Phase 1: ordinal stage classifier (target = stage, not %).

The model predicts an ORDINAL STAGE (7 classes: understood..ready); the
percentage is only a UI projection of the stage band. This is easier to label,
easier to learn, and gives a more stable product than a continuous regression.

Evaluation: leave-one-turn-out (train on all-but-one turn, predict that turn),
reporting accuracy + mean absolute stage distance mapped to nominal % (MAE%).
"""
import json
import os
import pickle

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

STAGES = ['understood', 'planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
NOMINAL = {'understood': 5, 'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72, 'validating': 86, 'ready': 96}

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]
labs = {}
for l in open(os.path.join(DS, 'stage-labels.jsonl'), encoding='utf-8'):
    r = json.loads(l)
    labs[(r['sessionId'], r['turn'], r['callIndex'])] = r['label']

rows = []
for s in snaps:
    k = (s['sessionId'], s['turn'], s['callIndex'])
    if k not in labs:
        continue
    L = labs[k]
    rows.append({
        'sessionId': s['sessionId'], 'turn': s['turn'],
        'taskType': s.get('taskTypeGuess', 'unknown'),
        'framework': s.get('framework', 'dsh'),
        'steps': s['steps'], 'toolCalls': s['toolCalls'], 'toolKinds': s['toolKinds'],
        'filesWrittenCount': s['filesWrittenCount'], 'producedArtifact': int(s['producedArtifact']),
        'errors': s['errors'], 'hadTodo': int(s['hadTodo']),
        'todoRatio': (s['todoDone'] / s['todoTotal']) if s['todoTotal'] else 0.0,
        'elapsedSec': s['elapsedSec'], 'tokensIn': s['tokens']['input'],
        'historyText': (s.get('anchorReasoning', '') or '') + ' ' + (s.get('task', '') or '') +
            ' TOOLS ' + ' '.join(s.get('toolHistoryCat') or s.get('toolHistory', [])) +
            ' EXTS ' + ' '.join(sorted({os.path.splitext(f)[1].lower() for f in (s.get('filesWritten') or []) if os.path.splitext(f)[1]})) +
            ' RESULTS ' + ' '.join((r.get('tool', '') + ': ' + r.get('snippet', '')) for r in s.get('recentResults', [])),
        'stageIndex': L['stageIndex'],
    })

df = pd.DataFrame(rows)
# A/B filter: --framework dsh|claude|both
import sys as _sys
_fw = 'both'
if '--framework' in _sys.argv:
    _fw = _sys.argv[_sys.argv.index('--framework') + 1]
if _fw in ('dsh', 'claude'):
    df = df[df.framework == _fw].copy()
    labs = {k: v for k, v in labs.items() if True}  # labs already keyed; df filtered
print(f'samples: {len(df)} | turns: {df.groupby(["sessionId","turn"]).ngroups} | framework={_fw}')
print(f'stage 分布: {df.stageIndex.value_counts().sort_index().to_dict()}')

FEAT = ['steps', 'toolCalls', 'toolKinds', 'filesWrittenCount', 'producedArtifact', 'errors', 'hadTodo', 'todoRatio', 'elapsedSec', 'tokensIn']
CAT = ['taskType', 'framework']
y = df['stageIndex'].values


def pre():
    return ColumnTransformer([
        ('num', StandardScaler(), FEAT),
        ('cat', OneHotEncoder(handle_unknown='ignore'), CAT),
        ('text', TfidfVectorizer(max_features=120, ngram_range=(1, 1), sublinear_tf=False), 'historyText'),
    ], sparse_threshold=0.0)


def model():
    return Pipeline([('pre', pre()), ('m', HistGradientBoostingClassifier(max_leaf_nodes=7, max_iter=40))])


# leave-one-session-out (group by sessionId), sampled when there are many sessions.
# Grouping by SESSION (not turn) is the honest cross-trajectory generalization
# test: consecutive snapshots within a turn are strongly correlated.
import random as _random
sessions = list(df.groupby('sessionId'))
if len(sessions) > 8:
    _random.seed(0)
    sessions = _random.sample(sessions, 8)
rows_out = []
for i, (sid, g) in enumerate(sessions):
    print(f'  session {i + 1}/{len(sessions)} {str(sid)[:44]} (n={len(g)})', flush=True)
    test_idx = g.index
    train_idx = df.index.difference(test_idx)
    base_pred = np.full(len(test_idx), np.bincount(y[train_idx]).argmax())
    base_acc = accuracy_score(y[test_idx], base_pred)
    base_mae = np.mean([abs(NOMINAL[STAGES[y[test_idx][i]]] - NOMINAL[STAGES[base_pred[i]]]) for i in range(len(test_idx))])
    m = model(); m.fit(df.loc[train_idx], y[train_idx])
    pred = m.predict(df.loc[test_idx])
    acc = accuracy_score(y[test_idx], pred)
    mae = np.mean([abs(NOMINAL[STAGES[y[test_idx][i]]] - NOMINAL[STAGES[pred[i]]]) for i in range(len(test_idx))])
    rows_out.append((sid, len(test_idx), base_acc, acc, base_mae, mae))

print(f'\n=== leave-one-session-out (ordinal stage, {len(sessions)} sessions) ===')
print(f'{"session":44} {"n":>5} {"baseAcc":>8} {"acc":>6} {"baseMAE%":>9} {"MAE%":>7}')
for sid, n, ba, a, bm, m in rows_out:
    print(f'{str(sid):44} {n:>5} {ba:>8.2f} {a:>6.2f} {bm:>9.1f} {m:>7.1f}')
print(f'{"mean":44} {"":>5} {np.mean([r[2] for r in rows_out]):>8.2f} {np.mean([r[3] for r in rows_out]):>6.2f} {np.mean([r[4] for r in rows_out]):>9.1f} {np.mean([r[5] for r in rows_out]):>7.1f}')

final = model(); final.fit(df, y)
with open(os.path.join(BASE, 'stage-model.pkl'), 'wb') as f:
    pickle.dump(final, f)
print(f'\nsaved stage-model.pkl (ordinal classifier, {len(df)} samples)')
