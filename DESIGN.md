# dsh-session-progress 设计文档（定稿 v3）

> 目标、信息模型、主链、不变量与 Roadmap 的单一来源。开源时让读者理解我们
> 为什么这么设计，而不是只看到代码。

## 1. 目标

每次工具调用后，**独立于对话**给出任务进展评估，开销 <2% 任务 token。
三个硬约束：**独立信号**（不进对话）、**诚实**（不编无依据的百分比，能精确才
给高置信）、**省**（语义理解算一次，逐调用更新靠规则）。

**核心原则（v3 新增）**：进度**不预测未来**。进度 = 时刻 T 已发生的可观测事实
的有序里程碑。"测试最终会不会通过"是预测，不是进度；"测试**已经**通过"才是
进度。

## 2. 核心洞察

**进度 = f(任务规模, 活动状态)**。工具调用情况是「规模盲」的——同样的
`read→edit→write→test` 对写 hello world 是 100%、对写论文才 5%。规模在
「题面 + 计划」里。追问型指令（"你检查全了么"）本身无信息，规模在**跨 turn
上下文**里。

## 3. 时刻 T 的信息清单（只含 ≤T，不含未来）

| 来源 | 信息 | 价值 |
|---|---|---|
| 用户指令 | 原始文本（可能很短/追问） | 分母题面 |
| 滑动窗口上下文 | 之前 turn 的指令 + 结论（可见，非 reasoning） | 补全追问题面 |
| 显式计划 | todo / plan / task list（可见，**非内部推理**） | 显式分母 |
| 决策/里程碑事件 | "测试通过""发现 bug""切换方案""准备交付" | **最强信号**，从可见文本/todo 提取 |
| 工具调用 | 名 + 完整参数（命令/文件路径/文件内容/查询） | 做了什么 |
| 工具结果 | 完整输出（成功/失败/产出/报错） | 结果如何 |
| 产出文件 | 路径 + 内容 | 里程碑证据 |
| 成本 | token、耗时、步数 | 弱特征（诊断用） |

**不包含**：内部 reasoning / chain-of-thought 全文（不稳定、跨模型不可比、
常不暴露）；未来事件；任务总长度。

## 4. 主链（v3）

```
Prefix Events
  → Fact Extraction（去噪/压缩，抽可验证事实）
  → Semantic Evidence（"写 X→成功" "跑 Y→测试通过"）
  → Structured Snapshot（题面/计划/里程碑/摩擦/cost）
  → 阶段规则（prefix 事实 → 有序里程碑）   ← 诚实、确定、可验证
  → 语义总结层（LLM 每 N 步，读滑动窗口）   ← 信息内容"完成了什么"
```

**阶段与语义分离**：阶段是**规则**（prefix 事实 → milestone），规则即进度语义的
规范，不是"伪 judge"；语义总结是**LLM**，负责说出"已写 X / 正在 Y / 待办 Z"。

## 5. 四层快照（不是两层）

```
raw prefix events
  → observable facts    （可验证、带 provenance）
  → derived facts       （聚合计数，如 tests_run/tests_failed）
  → semantic interpretation（milestones，可被模型推翻）
  → progress estimator
```

**事实层边界（收紧）**：
- `exit_ok` 只有在工具**明确返回** exit_code=0/success 时才算 fact，标注
  `status_source: "tool_metadata"`；
- 从 `"23 passed"` 推断出的"测试通过"是 **derived fact**（tests_run/tests_failed
  计数），不是 fact；
- 可见文本里的"测试通过"是 **visible_claim**（`{text, source_event_id, source}`），
  不是 fact。

每条 fact/claim 都带 provenance（`source_event_id` + `source`），extractor 判错
可以回退到事实层重解释，不必重解析 transcript。

## 6. 结构化快照 schema v2

```json
{
  "schema_version": "2.0",
  "task": {...},
  "observations": {
    "tool_calls":   [{id, name, category, args_summary}],
    "tool_results": [{id, tool_call_id, status, status_source, tail}],
    "visible_claims": [{text, source_event_id, source}],
    "files":        [{path, ext, lines}],
    "activity":     "写 X → 成功；跑 Y → 测试通过",   // v3 补回语义流水
    "activityText": "同上，人类可读"
  },
  "derived": {
    "writes_succeeded": 2, "tests_run": 1, "tests_failed": 0,
    "errors_total": 0, "recent_errors": 0,
    "todo_done": 3, "todo_total": 4, "produced_artifact": true
  },
  "interpretation": {
    "milestones": [{type, confidence, evidence_ids}]
  },
  "cost": {"tokens": 0, "elapsed": 0, "steps": 0}
}
```

- `activity`/`activityText`（语义活动流水）是**语义总结层的输入**，也是 v3 阶段
  规则之外唯一承载"完成了什么"信息的通道；
- **cost 默认不进模型**，只用于诊断（卡住/框架成本/节奏）；
- **v1/v2 并行输出**：不替换 v1，加 `schema_version` 字段。

## 7. 四条纠正（定稿）

1. **不依赖内部 reasoning**——提取**显式决策/里程碑事件**，不把 CoT 全文当
   特征（这样换 Claude/Codex/GPT 都能工作）；
2. **阶段规则与语义总结不串联**——阶段由规则从 prefix 事实给出；语义总结由
   LLM 读滑动窗口给出；两者各自独立、可单独验证；
3. **百分比非精确标量**——先输出 `stage + within-stage band + confidence`
   （如 `validating · 60–75% · 0.72`）；
4. **token/耗时/步数 = 弱特征**——进 `cost/meta`，默认低权重，避免"框架捷径"。

## 8. 不变量（优先级高于一切）

- **prefix-only**：时刻 T 的任何特征只来自 ≤T 的信息；
- **不预测未来**：进度不含未来事件；"测试已通过"是事实，"测试会通过"不是进度；
- **禁止自我评估**：不得用规则自己生成的标签去证明规则/模型的性能；
- **规则即规范**：阶段规则是"进度"这个词的定义，不是待学习的伪 ground truth。

## 9. 数据飞轮 + 跨框架

- canonical adapter：DSH 与 Claude Code 都映射到同一 schema，工具名归一到
  `run/write/inspect/search/todo/report/...` 类别；
- 每调用产出**语义活动流水**（`写 X → 成功`），而非类别筹码；
- fail-closed pipeline：prefix-invariance property test 失配即停。

## 10. 滑动窗口 + 部分多轮上下文（采纳）

**采纳，且有界**：快照的「题面」字段加入最近 K turn 的（指令 + 可见结论），
默认 K=3、每 turn ~500 字。理由：修复追问型指令的上下文缺失；只取**可见**
内容（非 reasoning）；prefix-only 天然成立。它是题面的一部分，不是完整转录
回放。

## 11. 阶段标签（prefix-only，v3 定稿）

阶段是**前缀可观测事实的有序里程碑**，每个条件都只依赖 ≤t 的信息：

| 阶段 | 判定（全部 ≤t） |
|---|---|
| `planned` | 尚无实质动作（无产物、无 write/run） |
| `executing` | 在干活，尚无可见产物 |
| `first_output` | 第一个可见产物出现（writes_succeeded≥1 或 artifact） |
| `integrating` | 多产物整合（文件数≥2，或 todo 完成率≥60%） |
| `validating` | 测试**已经**跑过且**已经**通过 |
| `ready` | 交付物已产出（报告文件 / ready_to_deliver claim） |

- `activity_mode`（此刻在做什么）与 `progress_stage`（整体成熟度）分离：
  `validating + rework` = 阶段已达验证但此刻在返工，stage 不倒退；
- 与旧 full-trajectory 标签的唯一区别：`validating` 从"测试**最终会**通过"改成
  "测试**已经**通过"。这消除了"预测未来"这个病态目标。

## 12. 诊断结论（封口，2026）

五项诊断，一次跑完：

1. **标注器自一致性 100%** —— 旧 `annotate-v2.py` 是纯 `if/elif` 确定性函数，
   无随机、无模型调用，所以"自一致 100%"是构造上的必然，不证明标签质量；
2. **R_future(stage) = 41.5%** —— 旧 full-trajectory 标注确实用了未来信息
   （final deliverable set / final test-pass / final report），3682/8882 条快照的
   标签被未来改写；
3. **Model A（facts-only）学不到未来依赖部分** —— 跨框架 claude→dsh acc 64.6%
   macro-F1 28.4%、dsh→claude acc 77.0% macro-F1 37.8%；`validating` recall
   0–28%、`ready` recall 7–32%；97~99% 的 leave-one-session-out 被 61% 的
   `executing` 多数类 + 单调结构灌水；
4. **语义特征救不了它** —— 加 `task` 全文 + `tool_results[].tail` + claims 的
   TF-IDF 后，validating/ready recall 依然 ≈0（claude→dsh valid 0→1.3%、ready
   0→6.9%）。原因：**"测试最终会不会通过"在测试跑完前不存在可观测前兆，本质
   不可预测**；
5. **结论**：把"预测最终阶段"当作监督目标是**病态定义**。进度必须重新定义为
   前缀已发生事实（→ §11）。这不是"ML 赢不了规则"，而是"目标函数要求预测未来"
   本身错了。

## 13. 最终架构（v4，规则 + 轻量模型）

诊断的终点不是"放弃 ML"，而是给出唯一正确的闭环：**大模型只做离线标注，
运行时用轻量模型**。命名统一（2026-08-14 第二轮 review 后）：

```
[离线，一次]
  完整轨迹 ──flash 全轨迹标注──▶ retrospective completion estimate（回顾性完成度估计）
                                    NOT progress ground truth（不是进度真值）
                                     │
  前缀 facts（≤t）──▶ 训练决策树回归 ──▶ percent-model.json（67 节点，零依赖）
[运行时，零大模型]
  当前会话日志 ──▶ 前缀 facts ──▶ 树遍历预测 ──▶ completion forecast（完成度预测，次要）
  progress_stage + evidence ──▶ 主进度信号（阶段 band + 已完成事实）
```

**为什么这样不循环**：离线标注是 flash 看**完整轨迹**的回顾性估计（不是规则生成），
模型学的是"前缀 facts → 回顾性完成度"的映射，不是"规则 → 规则"。

**实测**（leave-one-session-out MAE，123 会话 721 标注）：

| 估计器 | MAE |
|---|---|
| 规则基线（todo 完成率 / 阶段 band） | 27.7 pp |
| 决策树 d=6（facts + 规则信号） | **18.7 pp** |
| HGB 集成 | 18.2 pp |

决策树与 HGB 几乎同精度，且可导出为 JSON 在 Node 零依赖遍历 → 选决策树。
特征相关性：`tool_calls_total`(0.58)、`cat_inspect`(0.45) 等 prefix facts 远强于
规则信号 `band_mid`(0.20)——这正是模型能修正规则的原因（规则太粗糙）。

**可见证据**：本会话 todo 6/6 全完成时，规则报 100%（明显错，任务还在进行）；
模型报 77%（facts 显示 631 步仍在增长 + 测试有失败）。

## 14. 总规模不可估（封口结论，2026-08-14）

继续提升 MAE 的方向被两个实验证伪后，问题的本质才清晰：**进度 = 已完成/总规模，
但"总规模"（分母）在 prefix 里不可观测**。

- **标注噪声不是瓶颈**：flash 对同一点标 3 次，自一致 **1.7 pp**；
- **数据量不是瓶颈**：标注 721→1602，MAE 反而 18.7→19.8；
- **残差是系统性的规模盲**：early 0-30% 段模型高估 **+15.8 pp**、late 70-100% 段
  低估 **−27.3 pp**（看不到总规模，只能往中间挤）；
- **任务描述估不出总规模**：flash 光看任务描述估最终 tool-call 数，中位相对误差
  **62%**、真实值落在 [low,high] 内的比例仅 **33%**（合理区间应 ~90%）。

**结论**：规模盲是**不可约的部分可观测问题**，不是换模型/加数据能解决的。任何
prefix-only 的精确 % 都会系统性偏。

## 15. 业界范式（gpt 二次调研，2026-08-14）

让 ChatGPT 独立调研了"生产 agent 可观测性工具如何报告进度"，结论与我们一致：

**主导模式不是"估总工作量再报 %"，而是暴露一个演进组合：**
`workflow stage + agent 任务清单 + 完成证据 + 活性/验证信号`。

- **Replit Agent**：任务经 Draft→Active→Queued→Ready→Applying→Done 状态机；
- **Claude Code / Agent SDK**：结构化 task（pending/in_progress/completed），
  文档明确演示 completed/total 显示——但那个 total 是**当前 todo 列表**，不是任务
  真实规模（agent 可增删任务）；
- **Devin**：结构化进度 schema `{current_task, completed_tasks, next_task,
  requirements_met, created files, test outcomes}`——最干净的"非百分比进度 API"先例；
- **OpenAI Symphony**：`stall_timeout_ms`（默认 5 分钟无事件判定停滞）——活性检测；
- **LangSmith / Langfuse**：记录执行事实（runs/traces），不是声称的分母；
- **ETA 未被验证**：上述产品的公开文档里**没有**校准过的 in-run 剩余时间估计；
  Cognition 的事后工程时间估计明确说 2–3× 误差常见。

**关键区分（gpt 提炼，采纳）**：progress **evidence**（证据）vs progress
**prediction**（预测），自然层级：

```
verified facts → workflow state → provisional plan → remaining-work forecast → ETA/%
```

越往右，需要的校准数据越多。标量 % 隐含声称"知道还剩多少看不见的工作"，这在
无 todo 时是过度声称。**最强反方**：内生分母（agent 稳定计划）可能"足够好"——
这正是 Claude 用 completed/total todo 做的。

## 16. 最终落地形态（v5，诚实区间）

采纳"证据 + 区间"而非"精确 %"。命名统一（见 §13）：

- **主进度信号**：`progress_stage`（阶段，事实）+ `progress_band`（阶段区间，事实投影）；
- **次要信号**：`completion_forecast`（模型中心估计 `~90%`，轻量决策树，标注 ±约 19pp，
  预测性/不确定，视觉降级为 secondary，绝不作主进度）；
- **进度条**：高亮 band 区间段 + forecast 中心填充点；
- **事实行**：`已写 N 文件 · 测试通过/失败 M · 已做 K 步`；
- **终端状态**：turn 正常结束（status=completed）才报 100%；
- **新会话**：`pickActiveSession` 自动切换最新会话，`evaluateSession` 每次从头
  重算 events → 新会话自然从 0/低开始，无跨会话污染。

## 17. 当前状态

- [x] 实时 dashboard（http://127.0.0.1:3278）：`~90% · 区间 92–99%` + 事实行
- [x] 运行时零大模型：中心=轻量决策树，区间=规则 band，终端=completed→100%
- [x] 离线闭环：`annotate-percent.mjs`（721/1602 标签）→ `export-model.py` →
      `percent-model.json`；`annotate-scale.mjs` 证明总规模不可估
- [x] 指标：模型 MAE 18.7 pp vs 规则 27.7 pp；规模盲残差 early +15.8 / late −27.3
- [x] gpt 三次调研（规模估计方法、进度报告范式、六方向头脑风暴）+ 独立核实

## 18. 最终封口：精确 % 的经验误差地板（2026-08-14，穷尽验证）

用户追问"真的实现不了吗"后，我们对 gpt 头脑风暴推荐的方向逐一做了离线验证，
结果**三条路全部撞墙**，收敛到同一个结论：

| 方法 | MAE / 误差 | 结论 |
|---|---|---|
| 规则基线（todo / band） | 27.7 pp | 最粗 |
| **决策树（prefix facts）** | **18.7 pp** | **最优** |
| HGB 集成 | 18.2 pp | 略优于决策树，可忽略 |
| 子目标覆盖度（分层分解） | 20.5 pp | 更差——分解把分母问题上推一层 |
| LLM 看 prefix 估剩余（rollout） | 22.9 pp | 更差——LLM 也看不到剩余 |
| 任务描述估总规模 | 62% 相对误差 | 无效 |
| 前沿 SOTA（reasoning，条件更好） | ~16 pp | 同量级，且承认多为结构性信号 |

**为什么都无效**：`进度 = 已完成/总规模`，而"总规模"是**潜在变量**，在 prefix 里
难以观测。三条路分别用三种方式试图重建分母，都失败：
- 子目标分解 → 子目标列表本身是推断的，分母问题在更高层级重现（gpt 预言的失败模式）；
- LLM rollout → LLM 从 prefix 估剩余，系统性低估剩余（早期高估进度 +24pp），与"任务描述估规模"同源；
- 直接回归 → 只能学到单调结构（early 高估 / late 低估）。

**最终结论（有完整证据链）**：在**当前数据、特征与已测试方法**下，prefix-only 的精确 %
观察到约 **16–19pp 的经验误差地板**——这是实证结果，不是形式化的信息论下界证明
（我们没有不可辨识性证明或 Bayes error lower bound，不应声称"信息论下限"）。
我们的产品（`阶段 band 区间 + 模型中心 + 已完成事实`）是这个约束下最优的诚实形态。
标量 % 只在**有 todo（内生分母）**时才可辩护，无 todo 时只能给区间。

## 19. Runtime state machine v2（Sprint 1，暂停 ML，修 live 正确性）

外部 review 指出"研究结论正确、live 实现没跟上设计"。本轮**完全不碰 ML**，把
`stage-rule + live fact extraction + tests` 重构成 causal、event-based 的 state machine。

### 修复的 P0 bug

| bug | 修复 |
|---|---|
| write 失败也触发 first_output（artifact 在 tool/call 时记录） | artifact 只在 **tool/result 成功**后记录 |
| files 不去重（同文件写两次 → integrating） | 用 `Set` 按 path 去重 |
| 任意 `.md`/`.tex`/README → ready | ready 只由 `ready_to_deliver` claim 触发，不再看文件扩展名 |
| 累计计数导致"第一次 fail 就永远进不了 validating" | 引入 **validation episode**：`validationPassedOnce` 单调闩锁 |

### 状态语义（采纳 review 建议）

```
progress_stage   // 到过的最高成熟度，单调不倒退（其驱动 facts 单调：artifacts 只增、
                 //   validationPassedOnce 只闩 true、readyEvidence 只闩 true）
activity_mode    // 此刻在做什么，可往返（rework <-> validating）
```

- stage 判定：`readyEvidence → validating(曾通过) → integrating(≥2 artifact 或 plan≥60%)
  → first_output(≥1 artifact) → executing → planned`
- mode 判定：`validationJustFailed → rework`；`validationInProgress → validating`；
  `readyEvidence → delivering` 等。

### ready 判断的已知局限（regex 边界）

`ready_to_deliver` 用 regex 从 assistant 文本提取，**无法区分"引用某里程碑词"vs
"实际表达交付"**（例如 agent 写文档时引用"准备交付"这个词，或说"三件事全部完成"——
后者是子任务完成）。因此取**最保守正则**（只匹配"准备/可以/即将 + 交付/提交/上线"
和 "ready to deliver/ship/submit"）：

- **宁可漏报 ready（停在 validating），不误报 false ready（过早 ready）**；
- 未来改进方向：用 LLM 判断交付意图，或用结构化事件（agent 主动 emit `delivered`）。

### replay 验证（7 个真实 DSH session，逐步重放）

```
stage regressions       : 0 / 224 样本 (0.0%)   ← 单调性成立
validating oscillations : 0
false ready             : 0（收紧后；收紧前 6/7）
```

### 测试

`test.mjs` 重写为匹配新 ontology（33 项断言），覆盖上述全部 P0 修复 + zstd round-trip。
`package.json` 增加 `scripts.test`（`npm test` 或 `node test.mjs`）。

## 20. Runtime state machine v3（Sprint 2，四个核心语义）

第二轮 review 指出四个必须修的地方，本轮继续**完全不碰 ML**：

### ① result ↔ call 精确关联（P0）

DSH 事件有原生 `callId`（`tool/call.data.callId` ↔ `tool/result.message.source.callId`）。
原来用 `state.lastTool` 配对，遇到并行/交错 call 会串。改为 `pendingCalls Map` 按
callId join；顺带用 `tool/result.content[0].isError` 作为**权威错误信号**（fallback
regex）。Claude adapter 本就正确（`pending Map + tool_use_id`），现在 DSH 也一致。

### ② validation 绑定 candidate revision

引入 `artifactRevision`（每次成功写 +1）与 `validatedRevision`（验证通过时记录）。
`validationStale = validationPassedOnce && artifactRevision > validatedRevision`。

- stage **保持单调**：`validating` 只由 `validationPassedOnce`（闩锁）触发，不因 stale
  回退（第一轮 review 的"stage 不倒退"仍然成立）；
- stale 通过 **`mode = rework`** 表达（第二轮 review："UI 不能把旧 test pass 当当前已验证"）。

### ③ ready 从 claim 升级为 evidence conjunction

`ready` 不再由裸 claim 触发，而是：

```
ready_claim（visible claim，非 fact）
+ artifactCount >= 1
+ !validationStale（当前候选已验证）
+ !validationJustFailed
+ recentErrors === 0
→ readyEvidence
```

### ④ 删除 todoRatio → integrating 硬跳转

`integrating` 只由 `artifactCount >= 2`（或显式整合事件）触发；todo 完成率只作
within-stage evidence / plan coverage，不再提升 milestone。

### 命名统一（§13/§16）

- full-trajectory LLM `%` label → **retrospective completion estimate**（不是 progress
  ground truth）；
- percent-model 预测 → **completion forecast**（secondary / 低置信）；
- `progress_stage + evidence` → **primary live progress**。

### replay 验证（7 个真实 DSH session）

```
stage regressions       : 0 / 224 (0.0%)   ← 单调性成立
validating oscillations : 0
false ready             : 0
sessions reaching ready : 0/7（conjunction 严格，宁漏报；未来靠结构化 delivered 事件改善覆盖）
```
