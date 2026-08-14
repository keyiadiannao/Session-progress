"""
analyze-divergence.py - diagnostic report: where does the prefix-only RULE
systematically disagree with the full-trajectory ANNOTATOR?

Buckets: framework, transition vs not, rework vs not, has-final-artifact,
has-errors, coverage (low/med/high), long vs short. Plus the confusion matrix
(rule stage x full-trajectory stage).

This tells us whether ML has a clear target (structured disagreement) or not
(boundary-only noise).
"""
import json
import os
from collections import defaultdict, Counter

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

RULE = {}
for l in open(os.path.join(DS, 'stage-labels.jsonl'), encoding='utf-8'):
    r = json.loads(l)
    RULE[(r['sessionId'], r['turn'], r['callIndex'])] = r['label']['stage']

FULL = {}
for l in open(os.path.join(DS, 'v2-labels.jsonl'), encoding='utf-8'):
    r = json.loads(l)
    FULL[(r['sessionId'], r['turn'], r['callIndex'])] = r

SNAPS = {}
for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8'):
    r = json.loads(l)
    SNAPS[(r['sessionId'], r['turn'], r['callIndex'])] = r

# per-turn final files (future info, for coverage bucket)
final_files_by_turn = defaultdict(set)
turn_snap_keys = defaultdict(list)
for k, s in SNAPS.items():
    turn_snap_keys[(k[0], k[1])].append(k)
for (sid, tn), keys in turn_snap_keys.items():
    keys.sort(key=lambda x: x[2])
    last = SNAPS[keys[-1]]
    final_files_by_turn[(sid, tn)] = {f['path'] for f in last['observations']['files']}

NOMINAL = {'understood': 5, 'planned': 18, 'executing': 35, 'first_output': 55, 'integrating': 72, 'validating': 86, 'ready': 96}

rows = []
for k, fl in FULL.items():
    if k not in RULE or k not in SNAPS:
        continue
    rs = RULE[k]
    fs = fl['progress_stage']
    s = SNAPS[k]
    ff = final_files_by_turn[(k[0], k[1])]
    fn = {f['path'] for f in s['observations']['files']}
    coverage = (len(fn & ff) / len(ff)) if ff else 0.0
    rows.append({
        'k': k, 'rule': rs, 'full': fs,
        'agree': rs == fs,
        'dist': abs(NOMINAL.get(rs, 0) - NOMINAL.get(fs, 0)),
        'framework': s.get('framework', 'dsh'),
        'mode': fl['activity_mode'],
        'is_rework': fl['activity_mode'] == 'rework',
        'has_artifact': bool(ff),
        'has_error': s['derived']['errors_total'] > 0,
        'coverage': coverage,
        'long': s['derived']['tool_calls_total'] >= 20,
    })

n = len(rows)
agree = sum(r['agree'] for r in rows)
mae = sum(r['dist'] for r in rows) / n
print(f'=== 总体 ===')
print(f'样本数 {n} | 一致 {agree} ({agree/n*100:.1f}%) | 平均阶段距离 {mae:.1f}pp')

def bucket(name, fn):
    g = defaultdict(lambda: [0, 0])
    for r in rows:
        b = fn(r)
        g[b][0] += 1
        g[b][1] += 1 if r['agree'] else 0
    print(f'\n=== {name} ===')
    for b in sorted(g, key=str):
        c, a = g[b]
        print(f'  {str(b):28} n={c:6} 一致={a/c*100:5.1f}%')

bucket('framework', lambda r: r['framework'])
bucket('activity_mode', lambda r: r['mode'])
bucket('rework', lambda r: 'rework' if r['is_rework'] else 'not')
bucket('has_final_artifact', lambda r: 'yes' if r['has_artifact'] else 'no')
bucket('has_error', lambda r: 'yes' if r['has_error'] else 'no')
bucket('coverage', lambda r: 'low<0.25' if r['coverage'] < 0.25 else ('mid<0.9' if r['coverage'] < 0.9 else 'high>=0.9'))
bucket('length', lambda r: 'long>=20' if r['long'] else 'short<20')

# transition bucket: full stage differs from previous snapshot in same turn
prev_by_turn = {}
for (sid, tn), keys in turn_snap_keys.items():
    keys.sort(key=lambda x: x[2])
    prev = None
    for k in keys:
        if k in FULL:
            prev_by_turn[k] = prev
            prev = FULL[k]['progress_stage']
def is_transition(r):
    return r['full'] != prev_by_turn.get(r['k'])
bucket('transition', lambda r: 'transition' if is_transition(r) else 'steady')

# confusion matrix (rule x full), highlight off-diagonal
print('\n=== 混淆矩阵（行=规则，列=全量标注，值=数量）===')
stages = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
mat = Counter((r['rule'], r['full']) for r in rows)
print(f'{"":12}' + ''.join(f'{s:>14}' for s in stages))
for rs in stages:
    line = f'{rs:12}'
    for fs in stages:
        line += f'{mat[(rs, fs)]:>14}'
    print(line)

# 结构性分歧：规则 vs 全量的系统性偏移（偏早/偏晚）
print('\n=== 系统性分歧（规则≠全量，按对分组，top 12）===')
mismatch = Counter((r['rule'], r['full']) for r in rows if not r['agree'])
for (rs, fs), c in mismatch.most_common(12):
    dirn = '规则偏早' if NOMINAL[rs] < NOMINAL[fs] else '规则偏晚'
    print(f'  {rs:13} → {fs:13}  n={c:5}  ({dirn})')
