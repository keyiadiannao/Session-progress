"""
train-subgoal.py - is EXPLICIT subgoal coverage more learnable than direct % ?

Same prefix facts, same decision tree, same leave-one-session-out — only the
TARGET changes:
  - direct continuous % (percent-labels.jsonl)   [known: 18.7pp MAE]
  - subgoal coverage    (subgoal-labels.jsonl)   [new]

If subgoal-coverage MAE is materially lower, the hierarchical direction is
worth building out.  Uses a PAIRED comparison on the same snapshots.
"""
import json
import os

import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeRegressor
from sklearn.metrics import mean_absolute_error

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
BAND_MID = {'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72, 'validating': 86, 'ready': 96}
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

snaps = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r
         for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
subgoal = [json.loads(l) for l in open(os.path.join(DS, 'subgoal-labels.jsonl'), encoding='utf-8')]
percent = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r['percent']
           for r in [json.loads(l) for l in open(os.path.join(DS, 'percent-labels.jsonl'), encoding='utf-8')]}


def stage_of(s):
    d = s['derived']; files = s['observations']['files']
    if any(f['path'].lower().endswith(('.md', '.tex')) or 'readme' in f['path'].lower() for f in files): return 'ready'
    if d['tests_run'] >= 1 and d['tests_failed'] == 0: return 'validating'
    tr = d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0
    if len(files) >= 2 or d['writes_succeeded'] >= 2 or tr >= 0.6: return 'integrating'
    if d['produced_artifact'] or d['writes_succeeded'] >= 1 or len(files) >= 1: return 'first_output'
    if d['tool_calls_total'] > 0: return 'executing'
    return 'planned'


def feats(s):
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
    for tc in s['observations']['tool_calls']: cc[tc['category']] = cc.get(tc['category'], 0) + 1
    for c in CATS: f['cat_' + c] = cc.get(c, 0)
    f['band_mid'] = BAND_MID.get(stage_of(s), 35)
    return f


# paired rows: subgoal coverage + matching direct % (same snapshot)
rows = []
for lab in subgoal:
    s = snaps.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    if not s: continue
    p = percent.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    rows.append({**feats(s), 'sessionId': lab['sessionId'],
                 'subgoal': lab['subgoal_ratio'] * 100, 'percent': p, 'has_pct': p is not None})
df = pd.DataFrame(rows)
FEATS = [c for c in df.columns if c not in ('sessionId', 'subgoal', 'percent', 'has_pct')]
paired = df[df['has_pct']].copy()
print(f'subgoal labels {len(df)} | paired with direct-% {len(paired)}')


def loo_mae(frame, target, depth=6):
    maes = []
    for sid in frame.sessionId.unique():
        te, tr = frame[frame.sessionId == sid], frame[frame.sessionId != sid]
        if len(te) == 0 or len(tr) == 0: continue
        m = DecisionTreeRegressor(max_depth=depth, min_samples_leaf=8, random_state=0)
        m.fit(tr[FEATS], tr[target])
        maes.append(mean_absolute_error(te[target], np.clip(m.predict(te[FEATS]), 0, 100)))
    return np.mean(maes)


print('=== paired leave-one-session-out MAE (pp, same snapshots, same tree) ===')
m_sub = loo_mae(paired, 'subgoal')
m_pct = loo_mae(paired, 'percent')
print(f'  direct % target       : {m_pct:.1f} pp')
print(f'  subgoal coverage target: {m_sub:.1f} pp')
print(f'  delta                 : {m_sub - m_pct:+.1f} pp')
print()
print('=> 若 subgoal coverage 的 MAE 明显更低，说明显式子目标结构比连续 % 更可识别。')
