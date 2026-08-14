"""residual-analysis.py - is the model's error systematic scale-blindness?"""
import json, os
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeRegressor

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')
BAND_MID = {'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72, 'validating': 86, 'ready': 96}
CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

snaps = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r for r in [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]}
labels = [json.loads(l) for l in open(os.path.join(DS, 'percent-labels.jsonl'), encoding='utf-8')]


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


rows = []
for lab in labels:
    s = snaps.get((lab['sessionId'], lab['turn'], lab['callIndex']))
    if s: rows.append({**feats(s), 'sessionId': lab['sessionId'], 'percent': lab['percent']})
df = pd.DataFrame(rows)
FEATS = [c for c in df.columns if c not in ('sessionId', 'percent')]

preds, trues = [], []
for sid in df.sessionId.unique():
    te, tr = df[df.sessionId == sid], df[df.sessionId != sid]
    t = DecisionTreeRegressor(max_depth=6, min_samples_leaf=8, random_state=0)
    t.fit(tr[FEATS], tr['percent'])
    preds += list(np.clip(t.predict(te[FEATS]), 0, 100)); trues += list(te['percent'])
preds = np.array(preds); trues = np.array(trues); resid = preds - trues
print('residual (pred-true) mean: %+.1f pp (正=高估, 负=低估)' % resid.mean())
for lo, hi, name in [(0, 30, 'early 0-30'), (30, 70, 'mid 30-70'), (70, 101, 'late 70-100')]:
    m = (trues >= lo) & (trues < hi)
    if m.sum() > 5:
        print(f'  {name:14} n={m.sum():3}  mean resid={resid[m].mean():+5.1f} pp')
print()
print('=> early 段系统性高估 + late 段系统性低估 = 规模盲(看不到总任务规模,往中间挤)')
