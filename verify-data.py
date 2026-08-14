import json, os

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]
labs = [json.loads(l) for l in open(os.path.join(DS, 'snapshot-labels.jsonl'), encoding='utf-8')]

print('=== 1. 快照与标签总量 ===')
print('snapshots:', len(snaps), ' labels:', len(labs))

# group snapshots by (session, turn)
from collections import defaultdict
snap_by_key = defaultdict(list)
for s in snaps:
    snap_by_key[(s['sessionId'], s['turn'])].append(s)

print('\n=== 2. 每个 turn 的快照数 vs 标签数 ===')
lab_by_key = {}
for l in labs:
    k = (l['sessionId'], l['turn'])
    lab_by_key[k] = lab_by_key.get(k, 0) + 1
labeled_keys = set(lab_by_key)
all_turn_keys = set(snap_by_key)
mismatch = 0
for k in sorted(all_turn_keys):
    sn = len(snap_by_key[k]); lb = lab_by_key.get(k, 0)
    if k in labeled_keys and sn != lb:
        mismatch += 1
        print(f'  {k[0][:12]}#{k[1]}: snapshots={sn} labels={lb}  <<< 不一致!')
print('已标注 turn 数:', len(labeled_keys))
print('已标注 turn 中存在快照/标签数不一致的:', mismatch)
print('未标注的 turn 数:', sum(1 for k in all_turn_keys if k not in labeled_keys))
print('已标注快照数:', sum(1 for k in all_turn_keys if k in labeled_keys for _ in snap_by_key[k]))
print('未标注快照数:', sum(1 for k in all_turn_keys if k not in labeled_keys for _ in snap_by_key[k]))

print('\n=== 3. 逐条对齐抽查：turn12 前3次调用 (tool, progress) ===')
for s in snap_by_key[('session-3dba0711-a17c-4f98-ba23-6dbb7e0a6a9d', 12)][:3]:
    print(f'  #{s["callIndex"]} tool={s["tool"]} task={s["task"][:30]!r}')
for l in [x for x in labs if x['turn']==12][:3]:
    print(f'  #{l["callIndex"]} progress={l["label"]["progress_pct"]} note={l["label"]["note"]}')

print('\n=== 4. turn 编号是否漂移：turn12 的任务是否仍是"可以做做看" ===')
t12 = snap_by_key[('session-3dba0711-a17c-4f98-ba23-6dbb7e0a6a9d', 12)]
print('  turn12 task:', repr(t12[0]['task'] if t12 else 'MISSING'))
print('  turn12 anchor 前80字:', (t12[0].get('anchorReasoning','') or '')[:80] if t12 else '')

print('\n=== 5. 研究型 turn (e2c19368#1) 快照与标签区间 ===')
r = snap_by_key[('e2c19368-bad0-4a8e-82b4-2db582ee6aca', 1)]
rl = [x for x in labs if x['sessionId'].startswith('e2c19368')]
print(f'  snapshots={len(r)} labels={len(rl)} callIndex 范围 {min(s["callIndex"] for s in r)}..{max(s["callIndex"] for s in r)}')
print(f'  label callIndex 范围 {min(x["callIndex"] for x in rl)}..{max(x["callIndex"] for x in rl)}')

print('\n=== 6. 标签覆盖度小结（诚实版）===')
total_snaps = len(snaps)
labeled_snaps = sum(len(snap_by_key[k]) for k in labeled_keys)
print(f'  总快照 {total_snaps}，已标注 {labeled_snaps}，覆盖率 {labeled_snaps/total_snaps*100:.1f}%')
