# dsh-session-progress

[![CI](https://img.shields.io/github/actions/workflow/status/keyiadiannao/Session-progress/ci.yml?branch=main)](https://github.com/keyiadiannao/Session-progress/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen)](https://nodejs.org)

一个**独立的、诚实的 AI agent 会话进度监控器**。它读取当前会话的日志,用一个独立面板
报告任务进展——**绝不写进对话**,是一个与 agent 自身无关的外部信号。

> 核心立场:**不报假的精确百分比**。我们证明了(见 [DESIGN.md](DESIGN.md))在
> "只观察前缀、看不到任务总规模" 的前提下,精确的 "63% 完成" 在信息论上是不可行的
> (MAE 下限 ~16–19pp)。所以我们报告**可辩护的区间 + 事实**,而不是编一个数字。

## 为什么不做精确 %(一句话)

`完成度 = 已完成 / 总规模`,但 "总规模" 这个分母在任务执行过程中是**不可观测的**——
agent 自己经常都不知道还要做多少。强行估一个精确百分比,必然在早期高估、晚期低估。
详见 [DESIGN.md §18](DESIGN.md) 的完整证据链。

## 界面:四段式(业界范式)

面板采用生产级 agent 可观测性工具(Replit / Devin / Claude Code / LangSmith)共同的
形态——**不暴露标量 %**,而是暴露四类可辩护的事实:

```
┌ 阶段 STAGE   ── 阶段 badge + band 区间进度条(前缀事实) + 模型中心(仅供参考)
├ 计划 PLAN    ── agent 自维护的 todo 清单(done/total,标注"可动态修订,非真实总规模")
├ 证据 EVIDENCE ── 已写 N 文件 · 测试通过/失败 · 已做 N 步 · 最近活动
└ 健康 HEALTH  ── 活性/停滞/报错(疑似报错附原文片段)
```

## 架构

```
当前会话日志(zstd)
  → 前缀事实提取(工具调用/文件/测试/todo,prefix-only)
  → 阶段规则(stage-rule.mjs,零成本)        → band 区间
  → 轻量决策树(percent-model.json,67 节点) → 中心估计
  → 四段式面板(运行时零大模型调用)
```

- **运行时零大模型**:阶段 = 规则,中心 = 67 节点决策树(纯 `if/else` 遍历);
- **大模型只在离线用一次**:标注 ground truth(需要 `DEEPSEEK_API_KEY`,可选);
- **诚实**:terminal(会话正常结束)→ 100%;新会话自动从 0 开始,无跨会话污染。

## 运行

要求 Node ≥ 22.19(使用内置 `node:zlib` 解压 zstd)。

```bash
# 方式一:复制模板配置
copy config.example.json config.json   # Windows;或 cp
node index.mjs config.json

# 方式二:一键脚本(Windows)
start-dashboard.bat
```

打开 http://127.0.0.1:3278。它是**独立进程**,不加载进 agent harness,不影响其启动;
只绑定 `127.0.0.1`。

## 配置

`config.json`(模板见 `config.example.json`):

| key | 默认 | 含义 |
|---|---|---|
| `port` | 3278 | 面板端口 |
| `sessionsRoot` | `~/.dsh/sessions` | 会话日志根目录 |
| `sessionDir` | auto | 显式指定会话目录(可选;默认自动选最新活动会话) |
| `pollMs` | 2000 | 轮询间隔 |
| `stallSeconds` | 60 | 无活动多少秒判定"停滞" |

## 离线训练闭环(可选,非运行时必需)

仓库附带一个用示例数据训练的 `percent-model.json`(67 节点,只含特征名+阈值,不含数据)。
若要用自己的数据重训,需要 `DEEPSEEK_API_KEY`,跑:

```bash
node research/annotate-percent.mjs   # flash 全轨迹标注 %(离线,唯一用大模型的地方)
python research/export-model.py      # 训练决策树 → percent-model.json
```

## 目录结构

```
index.mjs                  # 入口:实时 dashboard 服务
stage-rule.mjs             # 阶段规则(prefix-only,零成本)
summarize.mjs / summarizer.mjs / llm.mjs   # 语义提取 + 总结 + 离线 LLM 客户端
extractor-v2*.mjs / *-extract.mjs          # 会话日志 → 结构化快照(DSH + Claude)
percent-model.json         # 67 节点决策树(示例模型)
config.example.json        # 配置模板
DESIGN.md                  # 设计文档 + 完整证据链
research/                  # 研究脚本:精确 % 不可行结论的可复现记录
research/archive/          # 被取代的早期版本
```

## 文档

- **[DESIGN.md](DESIGN.md)** —— 单一来源设计文档,含完整证据链:从"规则标签循环性"
  诊断、`R_future=41.5%`、"总规模不可估"(62% 误差),到三条突破路径(子目标分解
  20.5pp / LLM rollout 22.9pp / 直接回归 18.7pp)全部撞墙,最终收敛到诚实区间方案。

## 诚实局限(务必读)

1. **不报精确百分比是设计决定,不是缺陷**:分母"任务总规模"在运行中不可观测,精确 % 的
   MAE 下限约 16–19pp(见 [DESIGN.md](DESIGN.md) §18)。它给你的是"阶段 band + 事实"。
2. **stage 有规则天花板**:盲评 prefix agreement 显示精确 stage 的 exact 一致率停在
   ~31–60%(off-by-one 最高 64.3%)——结构化规则(数文件、记验证)无法完全替代语义判断。
   据此**宁可保守**:planned/executing/first_output 与盲评 100% 一致;ready 用严格
   conjunction,**宁可漏报、不误报**。
3. **百分比中心是离线决策树**:`percent-model.json` 是示例数据上离线训练的 67 节点树,是
   "completion forecast(低置信)",不是 ground truth;换工作流/工具集后需重训。
4. **词法信号仍有边界误判**:测试/错误识别基于命令与输出的词法匹配,不是类型化证据;
   已收紧(测试运行器词边界锚定、错误用 `isError` 权威字段 + regex 兜底),但"谈论测试"
   与"真的跑测试"在纯词法下仍可能混淆。

## License

MIT
