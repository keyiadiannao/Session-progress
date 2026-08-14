"""
label-stages.py - Phase 1: pure-rule ordinal stage labeler (prefix-only, causal).

The target is NOT a continuous 0-100 regression; it is an ORDINAL STAGE
(understood -> planned -> executing -> first_output -> integrating ->
validating -> ready). Percent is only a UI projection of the stage band.

Rules read ONLY the snapshot's own fields, which are already prefix-only
(cumulative state up to that call). No future events, no total length, no
interpolation from the outcome. Ambiguous -> abstain (drop the sample), so
coverage is sacrificed before temporal consistency.

"delivered" (100%) is terminal UI-only and is NOT emitted here: it requires
knowing the turn ended completed, which is future information for any
mid-task sample.

Usage: python label-stages.py
"""
import json
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

STAGES = ['understood', 'planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
BANDS = {
    'understood': (0, 10, 5),
    'planned': (10, 25, 18),
    'executing': (25, 45, 35),
    'first_output': (45, 65, 55),
    'integrating': (65, 80, 72),
    'validating': (80, 92, 86),
    'ready': (92, 99, 96),
}

ERR_RE = re.compile(r'Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED|\[exit code: [1-9]', re.I)


def recent_error_count(s):
    return sum(1 for r in s.get('recentResults', []) if ERR_RE.search(r.get('snippet', '')))


def classify(s):
    """Return (stage, confidence, evidence, band) or None to abstain."""
    if not s.get('task'):
        return None  # abstain: no user instruction yet
    hasPlan = bool(s.get('anchorReasoning')) or s.get('todoTotal', 0) > 0
    produced = s.get('producedArtifact', False)
    toolCalls = s.get('toolCalls', 0)
    files = s.get('filesWritten', []) or []
    history = s.get('toolHistoryCat') or s.get('toolHistory', []) or []
    wroteFinal = any(re.search(r'readme|report|\.md$', f, re.I) for f in files) or 'report' in history
    todoDone = s.get('todoTotal', 0) > 0 and s.get('todoDone', 0) / s.get('todoTotal', 1) >= 0.9
    errs = recent_error_count(s)
    ev = []

    # critical rework: recent errors dominate an artifact-producing phase
    if errs >= 2 and produced:
        return ('executing', 'low', 'recent errors indicate rework', BANDS['executing'])

    if not produced and toolCalls == 0:
        stage = 'planned' if hasPlan else 'understood'
        conf = 'high' if hasPlan else 'medium'
        ev.append('no tools yet' + ('; plan present' if hasPlan else '; no plan'))
    elif not produced:
        stage = 'executing'; conf = 'high'; ev.append('tools running, no artifact yet')
    elif wroteFinal:
        stage = 'ready'; conf = 'high'; ev.append('final artifact (report/readme) written')
    elif todoDone:
        stage = 'integrating'; conf = 'high'; ev.append('plan nearly complete')
    elif errs == 0 and 'run' in history:
        stage = 'validating'; conf = 'medium'; ev.append('tests running, no recent errors')
    else:
        stage = 'first_output'; conf = 'medium'; ev.append('artifact produced')

    return (stage, conf, '; '.join(ev), BANDS[stage])


def main():
    snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]
    labels = []
    abstained = 0
    for s in snaps:
        r = classify(s)
        if r is None:
            abstained += 1
            continue
        stage, conf, evidence, band = r
        labels.append({
            'sessionId': s['sessionId'], 'turn': s['turn'], 'callIndex': s['callIndex'],
            'label': {
                'stage': stage,
                'stageIndex': STAGES.index(stage),
                'progressBand': [band[0], band[1]],
                'nominalPct': band[2],
                'confidence': conf,
                'evidence': evidence,
                'label_source': 'rule-rubric',
            },
        })
    out = os.path.join(DS, 'stage-labels.jsonl')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in labels) + '\n')
    from collections import Counter
    dist = Counter(l['label']['stage'] for l in labels)
    print(f'[label-stages] {len(labels)} labeled, {abstained} abstained -> stage-labels.jsonl')
    print(f'[label-stages] 分布: {dict(dist)}')


if __name__ == '__main__':
    main()
