"""
export-model.py - train + export the lightweight percent model for the Node runtime.

The runtime (index.mjs) is Node and must stay dependency-free, so we export a
SINGLE DECISION TREE (max_depth ~6) as a JSON tree that Node can walk directly.
We also report the HistGradientBoosting MAE for comparison; if the tree is close
enough we ship the tree, otherwise we ship HGB's ensemble as JSON too.

Output: dataset/percent-model.json = {features: [...], tree: {...}}
"""
import json
import os

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeRegressor
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
    d = s['derived']
    files = s['observations']['files']
    if any(f['path'].lower().endswith(('.md', '.tex')) or 'readme' in f['path'].lower() for f in files):
        return 'ready'
    if d['tests_run'] >= 1 and d['tests_failed'] == 0:
        return 'validating'
    tr = d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0
    if len(files) >= 2 or d['writes_succeeded'] >= 2 or tr >= 0.6:
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
df['rule_pct'] = df.apply(lambda r: round(r['todo_ratio'] * 100) if r['todo_total'] > 0 else r['band_mid'], axis=1)

# ---- LOOCV: HGB vs decision tree vs rule ----
mae_hgb, mae_tree, mae_rule = [], [], []
for sid in df.sessionId.unique():
    te, tr = df[df.sessionId == sid], df[df.sessionId != sid]
    if len(te) == 0 or len(tr) == 0:
        continue
    h = HistGradientBoostingRegressor(max_leaf_nodes=15, max_iter=120, learning_rate=0.1, random_state=0)
    h.fit(tr[FEATS], tr['percent'])
    mae_hgb.append(mean_absolute_error(te['percent'], np.clip(h.predict(te[FEATS]), 0, 100)))
    t = DecisionTreeRegressor(max_depth=6, min_samples_leaf=8, random_state=0)
    t.fit(tr[FEATS], tr['percent'])
    mae_tree.append(mean_absolute_error(te['percent'], np.clip(t.predict(te[FEATS]), 0, 100)))
    mae_rule.append(mean_absolute_error(te['percent'], te['rule_pct']))

print('=== leave-one-session-out MAE (pp) ===')
print(f'  HGB ensemble      : {np.mean(mae_hgb):.1f}')
print(f'  decision tree d=6 : {np.mean(mae_tree):.1f}')
print(f'  rule baseline     : {np.mean(mae_rule):.1f}')

# ---- export the decision tree as JSON (Node-walkable) ----
final = DecisionTreeRegressor(max_depth=6, min_samples_leaf=8, random_state=0)
final.fit(df[FEATS], df['percent'])
t = final.tree_


def node_to_json(i):
    if t.children_left[i] == -1:  # leaf
        return {'value': round(float(t.value[i][0][0]), 1)}
    return {
        'feature': FEATS[t.feature[i]],
        'threshold': round(float(t.threshold[i]), 3),
        'left': node_to_json(t.children_left[i]),
        'right': node_to_json(t.children_right[i]),
    }


model = {'features': FEATS, 'tree': node_to_json(0), 'n_nodes': t.node_count}
with open(os.path.join(DS, 'percent-model.json'), 'w', encoding='utf-8') as f:
    json.dump(model, f, ensure_ascii=False, separators=(',', ':'))
print(f'[export] decision tree ({t.node_count} nodes, {sum(1 for i in range(t.node_count) if t.children_left[i] == -1)} leaves) -> percent-model.json')
