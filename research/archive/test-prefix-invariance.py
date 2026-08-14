"""
test-prefix-invariance.py - the acceptance property test for temporal consistency.

Take any trajectory prefix (drop some later turns, and/or truncate a turn at
some call), and the labels of the SURVIVING snapshots must be byte-identical.
If this ever fails, the labeler is peeking at future information.

Usage: python test-prefix-invariance.py
"""
import json
import os
import random

from label_stages import classify

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]


def label_map(snaps):
    m = {}
    for s in snaps:
        r = classify(s)
        if r is not None:
            m[(s['sessionId'], s['turn'], s['callIndex'])] = r[0]  # stage
    return m


full = label_map(snaps)
random.seed(0)
fails = 0
for trial in range(50):
    # random prefix: drop some later turns entirely, truncate some turns
    turn_keys = sorted({(s['sessionId'], s['turn']) for s in snaps})
    keep = set(random.sample(turn_keys, random.randint(1, len(turn_keys))))
    truncated = []
    for s in snaps:
        k = (s['sessionId'], s['turn'])
        if k not in keep:
            continue
        # randomly truncate this turn at some call index
        cap = random.randint(1, max(1, len([x for x in snaps if (x['sessionId'], x['turn']) == k])))
        if s['callIndex'] <= cap:
            truncated.append(s)
    prefix_labels = label_map(truncated)
    for key, stage in prefix_labels.items():
        if full[key] != stage:
            fails += 1
            print(f'FAIL trial {trial}: {key} full={full[key]} prefix={stage}')
            break

print(f'property test: {50} trials, {fails} mismatches')
if fails == 0:
    print('PASS: labels are prefix-invariant (no future peeking)')
    raise SystemExit(0)
else:
    print(f'FAIL: {fails} mismatches - pipeline must stop (fail-closed)')
    raise SystemExit(1)
