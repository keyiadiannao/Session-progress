# research/ — 研究记录

这个目录记录了本项目核心结论（**prefix-only 的精确 % 不可行，MAE 下限 ~16–19pp**）的
完整推导过程。它们不是产品运行所需的，而是"结论如何得出"的可复现证据链。

> ⚠️ 这些脚本**不会**开箱即跑：它们依赖 `dataset/`（真实会话数据，已从仓库排除）和
> `DEEPSEEK_API_KEY`。要复现，你需要自己的会话数据 + 一个 DeepSeek key。

## 证据链导览（对应 DESIGN.md §12–§18）

| 结论 | 脚本 | 产出 |
|---|---|---|
| 规则标签循环（99.8% 是假成绩） | `diagnose-circularity.py` | R_future=41.5%、可推导性、消融 |
| 规模盲（早期高估/晚期低估） | `residual-analysis.py` | early +15.8 / late −27.3 pp |
| 语义特征救不了 future 部分 | `semantic-features.py` | validating/ready recall ≈0 |
| 规则 vs 全轨迹分歧 | `analyze-divergence.py` | 68.3% 一致、9.3pp 距离 |
| prefix-only 阶段规则 | `label-prefix.py` | v3-prefix-labels.jsonl |
| 离线 % 标注（唯一用大模型的地方） | `annotate-percent.mjs` | percent-labels.jsonl |
| 任务描述估总规模（62% 误差） | `annotate-scale.mjs` | scale-estimates.jsonl |
| 标注自一致性（1.7pp） | `annotate-consistency.mjs` | — |
| 子目标分解（20.5pp，不改善） | `annotate-subgoals.mjs` + `train-subgoal.py` | subgoal-labels.jsonl |
| LLM rollout 估剩余（22.9pp，不改善） | `annotate-remaining.mjs` | remaining-labels.jsonl |
| 训练 + 导出轻量决策树 | `train-percent.py` + `export-model.py` | `../percent-model.json`（67 节点） |

## 运行前提

```bash
# 1. 准备数据：把会话快照放到 dataset/snapshots-v2.jsonl（见 extractor-v2*.mjs）
# 2. 设置 key
export DEEPSEEK_API_KEY=sk-...          # 或写入 ~/.dsh/.credentials.yaml

# 3. 标注 + 训练（重训模型）
node annotate-percent.mjs               # flash 全轨迹标注 %
python export-model.py                  # 训练决策树 → percent-model.json
```

## 复现顺序（从零到模型）

```
extractor-v2.mjs (+ claude 版)  →  snapshots-v2.jsonl      [数据]
  └ annotate-percent.mjs        →  percent-labels.jsonl    [标注，用大模型]
      └ export-model.py         →  percent-model.json      [轻量模型，运行时零大模型]
```

## archive/ — 被取代的早期版本

`archive/` 里的脚本是开发过程中被推翻/取代的早期实现（旧 extractor、旧训练、废弃的
人工审查 UI、历史回放 demo）。保留它们只为完整历史，不应作为参考实现。
