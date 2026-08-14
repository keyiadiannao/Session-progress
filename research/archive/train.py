"""
train.py - minimal smoke-test for the progress regression pipeline.

Joins per-call snapshots with per-call labels, trains the SIMPLEST model
(Ridge) on numeric + task-type features, and evaluates HONESTLY with
leave-one-turn-out (train on 2 turns, predict the 3rd) so same-turn sample
correlation cannot inflate the score.

This is a PIPELINE validation, not a production model: 81 samples from 3
turns are far too few to generalize. The point is to (a) prove the train/eval
loop works, (b) get a baseline, (c) measure how far we are from usable.

Usage: python train.py
"""
import json
import os
import pickle

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

snap = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]
lab = {}
for l in open(os.path.join(DS, 'snapshot-labels.jsonl'), encoding='utf-8'):
    r = json.loads(l)
    lab[(r['sessionId'], r['turn'], r['callIndex'])] = r['label']

rows = []
for s in snap:
    k = (s['sessionId'], s['turn'], s['callIndex'])
    if k not in lab:
        continue
    L = lab[k]
    rows.append({
        'sessionId': s['sessionId'], 'turn': s['turn'],
        'taskType': s.get('taskTypeGuess', 'unknown'),
        'steps': s['steps'], 'toolCalls': s['toolCalls'], 'callIndex': s['callIndex'],
        'toolKinds': s['toolKinds'], 'filesWrittenCount': s['filesWrittenCount'],
        'producedArtifact': int(s['producedArtifact']), 'errors': s['errors'],
        'hadTodo': int(s['hadTodo']),
        'todoRatio': (s['todoDone'] / s['todoTotal']) if s['todoTotal'] else 0.0,
        'elapsedSec': s['elapsedSec'],
        'tokensIn': s['tokens']['input'], 'tokensOut': s['tokens']['output'],
        'anchorLen': len(s.get('anchorReasoning', '') or ''),
        'taskLen': len(s.get('task', '') or ''),
        'anchorText': (s.get('anchorReasoning', '') or '') + ' ' + (s.get('task', '') or ''),
        # cumulative execution CONTENT: what has been done so far, not just counts
        'historyText': (s.get('anchorReasoning', '') or '') + ' ' + (s.get('task', '') or '') +
            ' TOOLS ' + ' '.join(s.get('toolHistory', [])) +
            ' FILES ' + ' '.join(s.get('filesWritten', [])) +
            ' RESULTS ' + ' '.join((r.get('tool', '') + ': ' + r.get('snippet', '')) for r in s.get('recentResults', [])),
        'progress': L['progress_pct'],
    })

df = pd.DataFrame(rows)
print(f'labeled samples: {len(df)}  |  turns: {df.groupby(["sessionId", "turn"]).ngroups}')
print(f'turn sizes: {sorted(df.groupby(["sessionId","turn"]).size().tolist())}')

FEAT = ['steps', 'toolCalls', 'callIndex', 'toolKinds', 'filesWrittenCount', 'producedArtifact',
        'errors', 'hadTodo', 'todoRatio', 'elapsedSec', 'tokensIn', 'tokensOut', 'anchorLen', 'taskLen']
CAT = ['taskType']
TEXT = 'historyText'
y = df['progress'].values


def make_pre(text=False):
    cols = [
        ('num', StandardScaler(), FEAT),
        ('cat', OneHotEncoder(handle_unknown='ignore'), CAT),
    ]
    if text:
        cols.append(('text', TfidfVectorizer(max_features=300, ngram_range=(1, 2), sublinear_tf=True), TEXT))
    return ColumnTransformer(cols, sparse_threshold=0.0)  # dense: HGB needs dense, and 394x~300 is tiny


def model_ridge(text=False):
    return Pipeline([('pre', make_pre(text)), ('m', Ridge(alpha=1.0))])


def model_hgb(text=False):
    return Pipeline([('pre', make_pre(text)), ('m', HistGradientBoostingRegressor(max_leaf_nodes=7, max_iter=100))])


def leave_one_turn_out(model_fn):
    maes = []
    for key, g in df.groupby(['sessionId', 'turn']):
        test_idx = g.index
        train_idx = df.index.difference(test_idx)
        base_pred = np.full(len(test_idx), y[train_idx].mean())
        base_mae = mean_absolute_error(y[test_idx], base_pred)
        m = model_fn()
        m.fit(df.loc[train_idx], y[train_idx])
        pred = m.predict(df.loc[test_idx])
        mae = mean_absolute_error(y[test_idx], pred)
        maes.append((key, len(test_idx), round(base_mae, 1), round(mae, 1)))
    return maes


print('\n=== leave-one-turn-out（对比：无文本 vs 含 TF-IDF 文本）===')
print(f'{"turn":20} {"n":>3} {"baseline":>8} {"Ridge":>7} {"HGB":>7} {"HGB+text":>9} {"Ridge+text":>11}')
ridge_rows = leave_one_turn_out(model_ridge)
hgb_rows = leave_one_turn_out(model_hgb)
hgb_t_rows = leave_one_turn_out(lambda: model_hgb(text=True))
ridge_t_rows = leave_one_turn_out(lambda: model_ridge(text=True))
for r, h, ht, rt in zip(ridge_rows, hgb_rows, hgb_t_rows, ridge_t_rows):
    key, n, b, rm = r
    print(f'{str(key):20} {n:>3} {b:>8.1f} {rm:>7.1f} {h[3]:>7.1f} {ht[3]:>9.1f} {rt[3]:>11.1f}')
print(f'{"mean":20} {"":>3} {np.mean([r[2] for r in ridge_rows]):>8.1f} {np.mean([r[3] for r in ridge_rows]):>7.1f} {np.mean([r[3] for r in hgb_rows]):>7.1f} {np.mean([r[3] for r in hgb_t_rows]):>9.1f} {np.mean([r[3] for r in ridge_t_rows]):>11.1f}')

# fit a final model (HGB + text) on ALL data, save it
final = model_hgb(text=True)
final.fit(df, y)
with open(os.path.join(BASE, 'progress-model.pkl'), 'wb') as f:
    pickle.dump(final, f)
print(f'\nsaved progress-model.pkl (HGB + TF-IDF text, trained on all {len(df)} samples)')
