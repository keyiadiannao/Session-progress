"""
annotate-v2.py - full-trajectory annotator (agent-as-annotator).

Annotation MAY use the FULL turn trajectory (final files, final outcome, whether
tests eventually passed) - this is the ground-truth label, NOT the prefix-only
inference. The label at snapshot t answers: "knowing how this turn actually
ended, what milestone was GENUINELY reached at time t?"

The future-informed signal (final deliverable set, final validation) is exactly
what a prefix-only model CANNOT see, so the model must learn to predict it from
observations - that is the real task (not rule distillation).

Outputs v2-labels.jsonl: {sessionId, turn, callIndex, progress_stage, band,
activity_mode, confidence, label_source:'agent-judge-full-trajectory'}.
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

STAGE_BAND = {
    'planned': (10, 25), 'executing': (25, 45), 'first_output': (45, 65),
    'integrating': (65, 80), 'validating': (80, 92), 'ready': (92, 99), 'delivered': (99, 100),
}

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots-v2.jsonl'), encoding='utf-8')]
turns = defaultdict(list)
for s in snaps:
    turns[(s['sessionId'], s['turn'])].append(s)

labels = []
for (sid, tn), tlist in sorted(turns.items()):
    tlist.sort(key=lambda x: x['callIndex'])
    final = tlist[-1]
    # ---- full-trajectory signals (future info, legitimate for annotation) ----
    final_files = {f['path'] for f in final['observations']['files']}
    final_milestones = {m['type'] for m in final['interpretation']['milestones']}
    final_tests_pass = 'validation_passed' in final_milestones and 'validation_failed' not in final_milestones
    final_has_report = any(f.lower().endswith(('.md', '.tex')) or 'readme' in f.lower() for f in final_files) or any(c['type'] == 'ready_to_deliver' for c in final['observations']['visible_claims'])
    total = final['derived']['tool_calls_total']

    for s in tlist:
        files_now = {f['path'] for f in s['observations']['files']}
        d = s['derived']
        # coverage: how much of the FINAL deliverable set already exists at t
        coverage = (len(files_now & final_files) / len(final_files)) if final_files else 0.0
        last_tool = s['observations']['tool_calls'][-1]['category'] if s['observations']['tool_calls'] else None
        is_last = s is final

        # ---- progress_stage (overall maturity genuinely reached by t) ----
        if is_last and final_has_report:
            stage = 'ready'
        elif is_last and final_tests_pass:
            stage = 'validating'
        elif final_tests_pass and d['tests_run'] >= 1 and d['tests_failed'] == 0 and coverage >= 0.5:
            stage = 'validating'
        elif coverage >= 0.9:
            stage = 'integrating'
        elif coverage >= 0.25 or d['produced_artifact']:
            stage = 'first_output'
        elif d['tool_calls_total'] > 0:
            stage = 'executing'
        else:
            stage = 'planned'

        # ---- activity_mode (what is happening AT t, not overall maturity) ----
        if d['recent_errors'] >= 2:
            mode = 'rework'
        elif last_tool == 'run' and ('test' in (s['observations']['tool_calls'][-1].get('args_summary', '') or '').lower() or d['tests_run'] >= 1):
            mode = 'validating'
        elif last_tool == 'report' or (is_last and final_has_report):
            mode = 'delivering'
        elif d['produced_artifact'] and last_tool == 'write':
            mode = 'executing'
        elif d['tool_calls_total'] > 0 and not d['produced_artifact']:
            mode = 'exploring'
        else:
            mode = 'executing'

        # ---- confidence ----
        if is_last:
            conf = 'high'
        elif stage in ('validating', 'integrating') and coverage >= 0.7:
            conf = 'high'
        elif stage == 'first_output':
            conf = 'medium'
        else:
            conf = 'low'

        labels.append({
            'sessionId': sid, 'turn': tn, 'callIndex': s['callIndex'],
            'progress_stage': stage,
            'band': STAGE_BAND[stage],
            'activity_mode': mode,
            'confidence': conf,
            'label_source': 'agent-judge-full-trajectory',
        })

out = os.path.join(DS, 'v2-labels.jsonl')
with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in labels) + '\n')

from collections import Counter
dist = Counter(l['progress_stage'] for l in labels)
mode_dist = Counter(l['activity_mode'] for l in labels)
print(f'[annotate-v2] {len(labels)} labels -> v2-labels.jsonl')
print(f'[annotate-v2] stage 分布: {dict(dist)}')
print(f'[annotate-v2] mode 分布: {dict(mode_dist)}')
