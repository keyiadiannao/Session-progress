"""
label-prefix.py - PREFIX-ONLY stage labels (the redefined target).

After the circularity diagnosis we stopped treating the full-trajectory
annotator as ground truth for "progress".  Progress, by definition, must not
predict the future.  This file redefines the stage label so that EVERY
condition is a prefix-observable fact at snapshot t (nothing looks ahead):

    planned       no substantive action yet (no artifact, no write/run)
    executing     acting, no visible artifact yet
    first_output  first visible artifact appeared (writes_succeeded>=1 or artifact)
    integrating   multiple artifacts assembling (>=2 files, or todo >=60% done)
    validating    tests HAVE run and HAVE passed by t
    ready         deliverable produced (report file / ready_to_deliver claim)

The only difference vs the old full-trajectory labels is that "validating" now
means "tests passed by t" (a fact) instead of "tests will eventually pass"
(a prediction).  This is a rule, and that is now HONEST: the rule is the spec
of what progress means, not a pseudo-judge pretending to see the future.

Also emits activity_mode (prefix-only, what is happening AT t).
"""
import json
import os
from collections import Counter, defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

STAGE_BAND = {
    'planned': (10, 25), 'executing': (25, 45), 'first_output': (45, 65),
    'integrating': (65, 80), 'validating': (80, 92), 'ready': (92, 99),
}

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]
turns = defaultdict(list)
for s in snaps:
    turns[(s['sessionId'], s['turn'])].append(s)

def has_report_now(files, claims):
    return (any(f.lower().endswith(('.md', '.tex')) or 'readme' in f.lower() for f in files)
            or any(c['type'] == 'ready_to_deliver' for c in claims))

def tests_pass_now(s):
    d = s['derived']
    ms = {m['type'] for m in s['interpretation']['milestones']}
    return ((d['tests_run'] >= 1 and d['tests_failed'] == 0)
            or 'validation_passed' in ms)

def stage_prefix(s):
    d = s['derived']
    files_now = {f['path'] for f in s['observations']['files']}
    claims = s['observations']['visible_claims']
    # deliverable already produced (prefix fact)
    if has_report_now(files_now, claims):
        return 'ready'
    # tests already ran and already passed (prefix fact, not prediction)
    if tests_pass_now(s):
        return 'validating'
    # multiple artifacts assembling
    todo_ratio = d['todo_done'] / d['todo_total'] if d['todo_total'] else 0.0
    if len(files_now) >= 2 or d['writes_succeeded'] >= 2 or todo_ratio >= 0.6:
        return 'integrating'
    # first visible artifact
    if d['produced_artifact'] or d['writes_succeeded'] >= 1 or len(files_now) >= 1:
        return 'first_output'
    # acting but nothing produced yet
    if d['tool_calls_total'] > 0:
        return 'executing'
    return 'planned'

def mode_prefix(s):
    d = s['derived']
    last_tool = s['observations']['tool_calls'][-1]['category'] if s['observations']['tool_calls'] else None
    last_args = s['observations']['tool_calls'][-1].get('args_summary', '') if s['observations']['tool_calls'] else ''
    if d['recent_errors'] >= 2:
        return 'rework'
    if last_tool == 'run' and ('test' in (last_args or '').lower() or d['tests_run'] >= 1):
        return 'validating'
    if last_tool == 'report' or has_report_now({f['path'] for f in s['observations']['files']}, s['observations']['visible_claims']):
        return 'delivering'
    if d['produced_artifact'] and last_tool == 'write':
        return 'executing'
    if d['tool_calls_total'] > 0 and not d['produced_artifact']:
        return 'exploring'
    return 'executing'

labels = []
for (sid, tn), tlist in sorted(turns.items()):
    tlist.sort(key=lambda x: x['callIndex'])
    for s in tlist:
        st = stage_prefix(s)
        labels.append({
            'sessionId': sid, 'turn': tn, 'callIndex': s['callIndex'],
            'progress_stage': st,
            'band': STAGE_BAND[st],
            'activity_mode': mode_prefix(s),
            'confidence': 'high',
            'label_source': 'prefix-only-rule-v3',
        })

out = os.path.join(DS, 'v3-prefix-labels.jsonl')
with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in labels) + '\n')

dist = Counter(l['progress_stage'] for l in labels)
mode_dist = Counter(l['activity_mode'] for l in labels)
print(f'[label-prefix] {len(labels)} labels -> v3-prefix-labels.jsonl')
print(f'[label-prefix] stage 分布: {dict(sorted(dist.items()))}')
print(f'[label-prefix] mode  分布: {dict(sorted(mode_dist.items()))}')

# ---- contrast with full-trajectory labels (how much future info we now exclude) ----
full = {tuple([r['sessionId'], r['turn'], r['callIndex']]): r for r in
        [json.loads(l) for l in open(os.path.join(DS, 'v2-labels.jsonl'), encoding='utf-8')]}
diffs = Counter()
for l in labels:
    f = full.get((l['sessionId'], l['turn'], l['callIndex']))
    if f and f['progress_stage'] != l['progress_stage']:
        diffs[(f['progress_stage'], '->', l['progress_stage'])] += 1
n_diff = sum(diffs.values())
print(f'[label-prefix] vs full-trajectory: {n_diff}/{len(labels)} = {n_diff/len(labels)*100:.1f}% 阶段被未来信息改写')
print('  主要改写方向 (full -> prefix):')
for (a, arrow, b), c in diffs.most_common(8):
    print(f'      {a} {arrow} {b}: {c}')
