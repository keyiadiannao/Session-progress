"""
label-all.py - per-call progress labels for EVERY turn of the main conversation.

Each turn gets milestone anchors: (callIndex, progress_pct) I judged from the
tool sequence + task + anchor reasoning. Progress between anchors is linearly
interpolated (progress is smooth, not stepwise). Confidence varies by task
type: implementation -> high, research/debug -> medium, others -> as noted.

This replaces the 3-turn seed with full coverage. Still agent-judged weak
supervision - label_source stays 'agent-judge'.
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(BASE, 'dataset')

snaps = [json.loads(l) for l in open(os.path.join(DS, 'snapshots.jsonl'), encoding='utf-8')]

# milestone anchors per turn: turn -> list of (callIndex, progress_pct)
# (session-3dba0711 is the main conversation; e2c19368 is the plugin-review subagent)
S3 = 'session-3dba0711-a17c-4f98-ba23-6dbb7e0a6a9d'
E2 = 'e2c19368-bad0-4a8e-82b4-2db582ee6aca'

ANCHORS = {
    (S3, 1):  [(1, 5), (15, 25), (30, 45), (40, 70), (45, 90), (48, 100)],   # 更新方案+插件推荐(研究→写脚本)
    (S3, 2):  [(1, 80), (2, 100)],                                            # 收子代理报告
    (S3, 3):  [(1, 15), (10, 60), (19, 100)],                                  # 排查本机环境
    (S3, 4):  [(1, 10), (12, 60), (19, 100)],                                  # 网页GPT委派
    (S3, 6):  [(1, 8), (8, 50), (15, 80), (21, 100)],                          # 配额脚本
    (S3, 7):  [(1, 10), (6, 50), (11, 85), (13, 100)],                         # MCP修复+图标
    (S3, 8):  [(1, 10), (6, 60), (10, 100)],                                   # playwright浏览器修复
    (S3, 9):  [(1, 40), (4, 100)],                                             # 导航chatgpt
    (S3, 10): [(1, 60), (3, 100)],                                             # 验证登录
    (S3, 12): [(1, 55), (2, 70), (3, 75), (4, 80), (5, 85), (6, 90), (7, 93), (8, 97)],  # progress-bar.ps1
    (S3, 13): [(1, 10), (10, 60), (19, 100)],                                  # 排查"看不到进度条"
    (S3, 14): [(1, 40), (3, 100)],                                             # 调研"能否实现"
    (S3, 15): [(1, 8), (8, 55), (14, 85), (17, 95)],                           # 独立信号(后来证明方向有问题)
    (S3, 16): [(1, 30), (5, 100)],                                             # 连接拒绝诊断
    (S3, 17): [(1, 10), (8, 55), (14, 85), (18, 100)],                         # 闪退诊断
    (S3, 18): [(1, 8), (10, 45), (20, 80), (27, 100)],                         # 崩因定位+重做独立进程
    (S3, 19): [(1, 15), (8, 70), (12, 100)],                                   # 恢复MCP
    (S3, 20): [(1, 30), (6, 100)],                                             # 明确真实需求(转向)
    (S3, 21): [(1, 5), (8, 30), (15, 50), (25, 75), (32, 90), (37, 100)],      # 建会话评估器
    (S3, 23): [(1, 8), (2, 20), (3, 25), (4, 30), (5, 35), (6, 45), (7, 55), (8, 62), (9, 68), (10, 74), (11, 78), (12, 82), (13, 86), (14, 90), (15, 92), (16, 95), (17, 97), (18, 100)],  # v2 预算评估器
    (S3, 24): [(1, 40), (4, 100)],                                             # 调研开源方案
    (S3, 27): [(1, 8), (5, 50), (8, 85), (10, 100)],                           # 特征提取器+标注
    (S3, 28): [(1, 15), (4, 60), (6, 100)],                                    # 逐调用快照提取器
    (S3, 29): [(1, 30), (4, 100)],                                             # 任务语义锚点
    (S3, 30): [(1, 15), (5, 80), (6, 100)],                                    # 首轮思考锚点
}

CONFIDENCE = {
    (S3, 1): 'medium', (S3, 3): 'medium', (S3, 4): 'medium', (S3, 6): 'high',
    (S3, 13): 'medium', (S3, 14): 'medium', (S3, 15): 'medium', (S3, 24): 'high',
}


def interp(anchors, ci):
    if ci <= anchors[0][0]:
        return anchors[0][1]
    for i in range(len(anchors) - 1):
        a0, p0 = anchors[i]
        a1, p1 = anchors[i + 1]
        if a0 <= ci <= a1:
            return round(p0 + (p1 - p0) * (ci - a0) / (a1 - a0))
    return anchors[-1][1]


labels = []
for s in snaps:
    key = (s['sessionId'], s['turn'])
    # research subagent (e2c19368): coarse monotonic schedule, low conf mid-flight
    if s['sessionId'].startswith('e2c19368'):
        pct = min(100, round(3 + s['callIndex'] / 55 * 97))
        conf = 'low' if s['callIndex'] < 40 else 'medium'
        note = '探索阶段，进度粗估' if s['callIndex'] < 40 else '信息已足，转入综合'
        labels.append({
            'sessionId': s['sessionId'], 'turn': s['turn'], 'callIndex': s['callIndex'],
            'label': {
                'progress_pct': pct, 'confidence': conf, 'task_type': 'research',
                'label_source': 'agent-judge', 'note': note,
            },
        })
        continue
    if key in ANCHORS:
        pct = interp(ANCHORS[key], s['callIndex'])
        conf = CONFIDENCE.get(key, 'high')
        note = f'里程碑插值（{s["taskTypeGuess"]}型）'
        labels.append({
            'sessionId': s['sessionId'], 'turn': s['turn'], 'callIndex': s['callIndex'],
            'label': {
                'progress_pct': pct, 'confidence': conf, 'task_type': s.get('taskTypeGuess', 'unknown'),
                'label_source': 'agent-judge', 'note': note,
            },
        })

out = os.path.join(DS, 'snapshot-labels.jsonl')
with open(out, 'w', encoding='utf-8') as f:
    f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in labels) + '\n')

snaps_total = len(snaps)
print(f'[label-all] {len(labels)} per-call labels (of {snaps_total} snapshots) -> snapshot-labels.jsonl')
turns = {}
for l in labels:
    turns[(l['sessionId'][:8], l['turn'])] = turns.get((l['sessionId'][:8], l['turn']), 0) + 1
print(f'[label-all] 覆盖 turn 数: {len(turns)}')
