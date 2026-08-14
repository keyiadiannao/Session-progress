"""
train-percent.py - train a LIGHTWEIGHT regressor: prefix facts -> completion %.

Target  = the offline full-trajectory % labels from annotate-percent.mjs
          (big model used ONLY offline, to annotate; never at runtime).
Features = prefix facts (<= t) + the RULE's own signal (todo ratio / stage band
          midpoint), so the model learns WHERE the rule is wrong and corrects it.

Eval = leave-one-session-out MAE, benchmarked against the RULE baseline (which
       is exactly what the live dashboard uses today).  If the model's MAE is
       materially lower than the rule's, the lightweight model earns its place;
       otherwise the rule stays.

Usage: python train-percent.py
"""
import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

BAND = {'planned': (10, 25), 'executing': (25, 45), 'first_output': (45, 65),
        'integrating': (65, 80), 'validating': (80, 92), 'ready': (92, 99)}
BAND_MID = {k: round((a + b) / 2) for k, (a, b) in BAND.items()}
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

snaps = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r
         for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
labels = [json.loads(l) for l in open(os.path.join(DS, 'percent-labels.jsonl'), encoding='utf-8')]


def stage_of(s):
    """Prefix-only stage rule (mirrors stage-rule.mjs / label-prefix.py)."""
    d = s['derived']
    files = s['observations']['files']
    has_report = any(f['path'].lower().endswith(('.md', '.tex')) or 'readme' in f['path'].lower() for f in files)
    if has_report:
        return 'ready'
    if d['tests_run'] >= 1 and d['tests_failed'] == 0:
        return 'validating'
    todo_ratio = d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0
    if len(files) >= 2 or d['writes_succeeded'] >= 2 or todo_ratio >= 0.6:
        return 'integrating'
    if d['produced_artifact'] or d['writes_succeeded'] >= 1 or len(files) >= 1:
        return 'first_output'
    if d['tool_calls_total'] > 0:
        return 'executing'
    return 'planned'


def feats(s):
    d = s['derived']
    f = {
        'tool_calls_total': d['tool_calls_total'], 'writes_succeeded': d['writes_succeeded'],
        'tests_run': d['tests_run'], 'tests_failed': d['tests_failed'],
        'errors_total': d['errors_total'], 'recent_errors': d['recent_errors'],
        'todo_done': d['todo_done'], 'todo_total': d['todo_total'],
        'todo_ratio': d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0,
        'produced_artifact': int(d['produced_artifact']),
        'files_count': len(s['observations']['files']),
    }
    exts = {fl['ext'].lower() for fl in s['observations']['files']}
    f['has_report'] = int(any(e in ('.md', '.tex') for e in exts) or any('readme' in fl['path'].lower() for fl in s['observations']['files']))
    f['has_code'] = int(any(e in ('.py', '.js', '.ts', '.mjs', '.sh', '.ps1') for e in exts))
    cc = {c: 0 for c in CATS}
    for tc in s['observations']['tool_calls']:
        cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS:
        f['cat_' + c] = cc.get(c, 0)
    # the RULE's own signal, so the model can learn to correct it
    f['band_mid'] = BAND_MID.get(stage_of(s), 35)
    return f


rows = []
for lab in labels:
    s = snaps.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    if not s:
        continue
    rows.append({**feats(s), 'sessionId': lab['sessionId'], 'percent': lab['percent']})
df = pd.DataFrame(rows)
FEATS = [c for c in df.columns if c not in ('sessionId', 'percent')]

# rule baseline = exactly what the live dashboard reports today
df['rule_pct'] = df.apply(lambda r: round(r['todo_ratio'] * 100) if r['todo_total'] > 0 else r['band_mid'], axis=1)

print(f'samples {len(df)} | sessions {df.sessionId.nunique()} | features {len(FEATS)}')
print(f'rule baseline MAE (vs labels): {mean_absolute_error(df["percent"], df["rule_pct"]):.1f} pp')
print()

# ---- leave-one-session-out ----
mae_model, mae_rule = [], []
for sid in df.sessionId.unique():
    te, tr = df[df.sessionId == sid], df[df.sessionId != sid]
    if len(te) == 0 or len(tr) == 0:
        continue
    m = HistGradientBoostingRegressor(max_leaf_nodes=15, max_iter=120, learning_rate=0.1, random_state=0)
    m.fit(tr[FEATS], tr['percent'])
    pred = np.clip(m.predict(te[FEATS]), 0, 100)
    mae_model.append(mean_absolute_error(te['percent'], pred))
    mae_rule.append(mean_absolute_error(te['percent'], te['rule_pct']))

print('=== leave-one-session-out MAE (pp) ===')
print(f'  model (facts + rule signal): {np.mean(mae_model):.1f}')
print(f'  rule baseline (todo/band)   : {np.mean(mae_rule):.1f}')
print(f'  improvement                 : {np.mean(mae_rule) - np.mean(mae_model):+.1f} pp')

# ---- per-bucket: where does the model beat the rule? ----
print()
print('=== MAE by % bucket (rule vs model, cross-session) ===')
buckets = [(0, 25, 'early 0-25'), (25, 60, 'mid 25-60'), (60, 90, 'late 60-90'), (90, 101, 'done 90-100')]
for lo, hi, name in buckets:
    sub = df[(df['percent'] >= lo) & (df['percent'] < hi)]
    if len(sub) < 10:
        continue
    # quick OOF estimate per bucket via full LOOCV already computed? approximate with a global fit is leaky;
    # instead report the rule MAE on this bucket and the model's LOOCV residual is not per-bucket here.
    print(f'  {name:14} n={len(sub):3}  rule MAE={mean_absolute_error(sub["percent"], sub["rule_pct"]):.1f} pp')

# ---- feature importances (permutation-free: absolute Pearson |corr| with target) ----
print('=== top features by |correlation with %| ===')
corr = []
for c in FEATS:
    r = np.corrcoef(df[c].astype(float), df['percent'].astype(float))[0, 1]
    corr.append((c, abs(r) if np.isfinite(r) else 0.0))
for name, v in sorted(corr, key=lambda x: -x[1])[:12]:
    print(f'  {name:20} {v:.3f}')
