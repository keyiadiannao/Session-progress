"""
train-full.py - fit a model to the FULL-TRAJECTORY labels (stage + percent).

Targets = flash's god's-eye labels from annotate-full.mjs (stage + percent).
Features (prefix-only) = facts OR text (TF-IDF) OR both.
Two heads: stage (classification) + percent (regression).

The decisive comparison: does TEXT lift stage/percent beyond FACTS?
"""
import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.model_selection import GroupKFold
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix, mean_absolute_error

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

snaps = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r
         for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
labels = [json.loads(l) for l in open(os.path.join(DS, 'stage-percent-labels.jsonl'), encoding='utf-8')]


def facts(s):
    d = s['derived']
    f = {'tool_calls_total': d['tool_calls_total'], 'writes_succeeded': d['writes_succeeded'],
         'tests_run': d['tests_run'], 'tests_failed': d['tests_failed'], 'errors_total': d['errors_total'],
         'recent_errors': d['recent_errors'], 'todo_done': d['todo_done'], 'todo_total': d['todo_total'],
         'todo_ratio': d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0,
         'produced_artifact': int(d['produced_artifact']), 'files_count': len(s['observations']['files'])}
    exts = {fl['ext'].lower() for fl in s['observations']['files']}
    f['has_report'] = int(any(e in ('.md', '.tex') for e in exts) or any('readme' in fl['path'].lower() for fl in s['observations']['files']))
    f['has_code'] = int(any(e in ('.py', '.js', '.ts', '.mjs', '.sh', '.ps1') for e in exts))
    cc = {c: 0 for c in CATS}
    for tc in s['observations']['tool_calls']:
        cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS:
        f['cat_' + c] = cc.get(c, 0)
    return f


def text(s):
    acts = s['observations'].get('activity') or []
    lines = [(a.get('action') or '') + ' ' + (a.get('result') or '') for a in acts[-14:]]
    return (s.get('task') or '') + '\n' + '\n'.join(lines)


rows = []
for lab in labels:
    s = snaps.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    if not s:
        continue
    rows.append({**facts(s), 'sessionId': lab['sessionId'], 'stage': lab['stage'], 'percent': lab['percent'], 'text': text(s)})
df = pd.DataFrame(rows)
FACT_COLS = [c for c in df.columns if c not in ('sessionId', 'stage', 'percent', 'text')]

print(f'samples {len(df)} | sessions {df.sessionId.nunique()}')
print('stage dist:', dict(df.stage.value_counts()))

tfidf = TfidfVectorizer(max_features=1500, analyzer='char_wb', ngram_range=(2, 4), sublinear_tf=True)
Xsem = tfidf.fit_transform(df['text'].tolist()).toarray()


def build(tr, te, uf, us):
    pts = []
    if uf: pts.append(df.iloc[tr][FACT_COLS].values)
    if us: pts.append(Xsem[tr])
    Xtr = np.hstack(pts)
    pts = []
    if uf: pts.append(df.iloc[te][FACT_COLS].values)
    if us: pts.append(Xsem[te])
    Xte = np.hstack(pts)
    return Xtr, Xte


res = {k: {'acc': [], 'macro': [], 'mae': [], 'rec': {s: [] for s in STAGES}} for k in ('facts', 'text', 'both')}
gkf = GroupKFold(n_splits=5)
for tr, te in gkf.split(df, df['stage'], groups=df['sessionId']):
    for k, (uf, us) in [('facts', (True, False)), ('text', (False, True)), ('both', (True, True))]:
        Xtr, Xte = build(tr, te, uf, us)
        # stage head
        m = LogisticRegression(max_iter=500, random_state=0)
        m.fit(Xtr, df.iloc[tr]['stage'])
        pred = m.predict(Xte)
        y = df.iloc[te]['stage']
        res[k]['acc'].append(accuracy_score(y, pred))
        res[k]['macro'].append(f1_score(y, pred, average='macro', labels=STAGES, zero_division=0))
        cm = confusion_matrix(y, pred, labels=STAGES)
        for i, s in enumerate(STAGES):
            res[k]['rec'][s].append(cm[i, i] / cm[i].sum() if cm[i].sum() else 0.0)
        # percent head
        r = Ridge(alpha=1.0)
        r.fit(Xtr, df.iloc[tr]['percent'])
        res[k]['mae'].append(mean_absolute_error(df.iloc[te]['percent'], np.clip(r.predict(Xte), 0, 100)))

print('\n=== stage classification (5-fold GroupKFold, mean) ===')
print(f"{'features':8} {'acc':>6} {'macroF1':>8}  " + '  '.join(f"{s[:4]}" for s in STAGES))
for k in ('facts', 'text', 'both'):
    acc = np.mean(res[k]['acc']); macro = np.mean(res[k]['macro'])
    recs = '  '.join(f"{np.mean(res[k]['rec'][s]) * 100:4.0f}" for s in STAGES)
    print(f"{k:8} {acc*100:6.1f} {macro*100:8.1f}  {recs}")

print('\n=== percent regression (MAE, pp) ===')
for k in ('facts', 'text', 'both'):
    print(f"  {k:8} {np.mean(res[k]['mae']):.1f} pp")
