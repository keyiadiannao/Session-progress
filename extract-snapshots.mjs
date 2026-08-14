/**
 * extract-snapshots.mjs - Phase 0b: per-tool-call progress snapshots.
 *
 * The fundamental goal is to update the progress estimate after each (or
 * every few) tool calls. This extractor therefore emits one snapshot record
 * AFTER each tool/result: the accumulated state at that moment (steps, tool
 * calls, files produced, errors, tokens, todo coverage, elapsed) - the exact
 * input a progress regressor will consume, one row per update point.
 *
 * LABELS (progress_pct at this snapshot) are added separately in
 * snapshot-labels.jsonl (agent-judged).
 *
 *   node extract-snapshots.mjs [sessionsRoot] [outFile]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodeSessionLog, discoverSessionDirs } from './index.mjs'
import { actionSummary, resultSummary } from './summarize.mjs'

const ERROR_PATTERN = /(?:\[exit code: (?!0\b)\d+\]|Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED)/i

function extractUserText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : '')).join(' ')
  return ''
}
function extractToolText(message) {
  const walk = (x) => {
    if (typeof x === 'string') return x
    if (Array.isArray(x)) return x.map(walk).join('\n')
    if (x && typeof x === 'object') {
      if (x.type === 'text' && typeof x.text === 'string') return x.text
      return Object.values(x).map(walk).join('\n')
    }
    return ''
  }
  return walk(message).slice(0, 4000)
}

/**
 * Extract the agent's own task analysis from the FIRST assistant message:
 * its content[0] is the "reasoning" block (the model's deep-think about scope,
 * constraints, and approach) - the richest turn-start anchor we have. This is
 * the denominator's shape, declared by the agent before any tool call.
 */
function extractReasoning(message) {
  const content = message?.content
  if (Array.isArray(content) && content[0]?.type === 'reasoning' && typeof content[0].text === 'string') {
    return content[0].text
  }
  return ''
}

/**
 * Cheap deterministic task-type hint from the instruction text. A small model
 * can later refine this; it exists so every snapshot carries a task-semantics
 * anchor without spending tokens. Marked as a guess, not a label.
 */
const TASK_TYPE_HINTS = [
  ['debug', /报错|调试|修|崩溃|闪退|bug|fix|crash|error|失败|不行|坏/],
  ['research', /研究|调研|搜索|文献|梳理|推荐|有什么|哪些|开源项目|评估一下|分析/],
  ['writing', /写.*(论文|文章|章节|草稿|报告)|论文|文章|报告|draft|paper/],
  ['tooling', /实现|做一个|写一个|脚本|插件|工具|自动|搭建|集成|构建|build|实现/],
  ['discussion', /怎么(看|做|办)|建议|方案|觉得|如何|能不能|吗[？?]|讨论/],
]
function guessTaskType(taskText) {
  if (!taskText) return 'unknown'
  for (const [type, re] of TASK_TYPE_HINTS) if (re.test(taskText)) return type
  return 'other'
}

/** Normalize a tool name to a canonical category (framework-agnostic). */
function category(name) {
  const n = String(name || '').toLowerCase()
  if (/taskcreate|taskupdate|taskstop|tasklist|todowrite|todo_write|plan/.test(n)) return 'todo'
  if (/^task$/.test(n)) return 'subagent'
  if (/bash|pwsh|powershell|cmd|shell|terminal|python|node|run|npm|git|npx/.test(n)) return 'run'
  if (/write|edit|str_replace|apply_patch|replace|patch/.test(n)) return 'write'
  if (/read|grep|glob|ls\b|list|search_file|find|globtool/.test(n)) return 'inspect'
  if (/web_search|webfetch|web_fetch|websearch|browser|fetch/.test(n)) return 'search'
  if (/report|deliverable/.test(n)) return 'report'
  if (/subagent|delegate|spawn/.test(n)) return 'subagent'
  if (/ask_user|askuser|question/.test(n)) return 'ask_user'
  if (/mcp/.test(n)) return 'mcp'
  if (/skill/.test(n)) return 'skill'
  if (/job_|task_kill|kill/.test(n)) return 'job'
  return 'other'
}

function newAcc() {
  return {
    steps: 0, toolCalls: 0, callIndex: 0, tools: {}, toolsCat: {}, toolHistory: [], toolHistoryCat: [], filesWritten: [], recentResults: [], activity: [], errors: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    todoDone: 0, todoTotal: 0, hadTodo: false, producedArtifact: false,
    firstTime: null, lastTime: null, lastTool: null, lastCat: null, lastAction: '',
  }
}

/** Emit one snapshot per completed tool call (after tool/result). */
export function turnSnapshots(sessionId, events) {
  const out = []
  let inTurn = false
  let turnNum = 0
  let acc = newAcc()
  let task = ''
  let anchor = ''
  for (const e of events) {
    const t = e.type
    if (t === 'turn/start') { inTurn = true; turnNum += 1; acc = newAcc(); task = ''; anchor = ''; continue }
    if (t === 'turn/end') { inTurn = false; continue }
    if (!inTurn) continue
    if (typeof e.time === 'number') { if (acc.firstTime === null) acc.firstTime = e.time; acc.lastTime = e.time }
    if (t === 'step/start') acc.steps += 1
    else if (t === 'user/message') { const c = extractUserText(e.data?.content); if (c && !task && !c.startsWith('<system-reminder>')) task = c }
    else if (t === 'tool/call') {
      const name = e.data?.name ?? '?'
      const cat = category(name)
      acc.toolCalls += 1
      acc.tools[name] = (acc.tools[name] ?? 0) + 1
      acc.toolsCat[cat] = (acc.toolsCat[cat] ?? 0) + 1
      acc.toolHistory.push(name)
      acc.toolHistoryCat.push(cat)
      acc.lastTool = name
      acc.lastCat = cat
      acc.lastAction = actionSummary(name, e.data?.arguments)
      if ((name === 'write' || name === 'edit' || name === 'str_replace_editor') && e.data?.arguments) {
        try {
          const a = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments
          const p = a.file_path ?? a.path
          if (typeof p === 'string' && p) { acc.filesWritten.push(p); acc.producedArtifact = true }
        } catch { /* non-JSON args */ }
      }
    } else if (t === 'tool/result') {
      acc.callIndex += 1
      const resultText = extractToolText(e.data?.message)
      const isErr = ERROR_PATTERN.test(resultText)
      if (isErr) acc.errors += 1
      // content summary: "做了什么 → 结果如何" (the human-readable activity log)
      acc.activity.push({ action: acc.lastAction || acc.lastTool, result: resultSummary(resultText), ok: !isErr })
      if (acc.activity.length > 30) acc.activity.shift()
      // keep the last 3 result snippets so each node carries recent execution CONTENT
      acc.recentResults.push({ tool: acc.lastTool, snippet: resultText.replace(/\s+/g, ' ').slice(0, 400) })
      if (acc.recentResults.length > 3) acc.recentResults.shift()
      out.push({
        sessionId,
        framework: 'dsh',
        turn: turnNum,
        callIndex: acc.callIndex,
        task: task.slice(0, 600),
        taskTypeGuess: guessTaskType(task),
        anchorReasoning: anchor.slice(0, 4000),
        tool: acc.lastTool,
        toolCat: acc.lastCat,
        toolHistory: acc.toolHistory.slice(-30),
        toolHistoryCat: acc.toolHistoryCat.slice(-30),
        tools: { ...acc.tools },
        toolsCat: { ...acc.toolsCat },
        filesWritten: [...new Set(acc.filesWritten)].slice(0, 30),
        recentResults: [...acc.recentResults],
        activity: acc.activity.slice(-25),
        activityText: acc.activity.slice(-25).map((x) => x.action + (x.result ? ' → ' + x.result : '')).join('\n'),
        steps: acc.steps,
        toolCalls: acc.toolCalls,
        toolKinds: Object.keys(acc.tools).length,
        filesWrittenCount: new Set(acc.filesWritten).size,
        producedArtifact: acc.producedArtifact,
        errors: acc.errors,
        todoDone: acc.todoDone,
        todoTotal: acc.todoTotal,
        hadTodo: acc.hadTodo,
        elapsedSec: acc.firstTime !== null && acc.lastTime !== null ? Math.round((acc.lastTime - acc.firstTime) / 1000) : 0,
        tokens: { ...acc.tokens },
      })
    } else if (t === 'todo/write' && Array.isArray(e.data?.todos)) {
      acc.hadTodo = true
      acc.todoTotal = e.data.todos.length
      acc.todoDone = e.data.todos.filter((x) => x.status === 'completed').length
    } else if (t === 'assistant/message') {
      if (!anchor) {
        const r = extractReasoning(e.data?.message)
        if (r) anchor = r
      }
      if (e.data?.usage) {
        const u = e.data.usage
        acc.tokens.input += u.inputTokens ?? 0
        acc.tokens.output += u.outputTokens ?? 0
        acc.tokens.reasoning += u.reasoningTokens ?? 0
        acc.tokens.cacheRead += u.cacheReadTokens ?? 0
      }
    }
  }
  return out
}

function main() {
  const sessionsRoot = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')
  const outFile = process.argv[3] ?? path.join(process.cwd(), 'snapshots.jsonl')
  const all = []
  for (const s of discoverSessionDirs(sessionsRoot)) {
    const events = decodeSessionLog(s.log)
    if (events.length === 0) continue
    all.push(...turnSnapshots(s.name, events))
  }
  fs.writeFileSync(outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  console.log(`[snapshots] ${all.length} per-call snapshots -> ${outFile}`)
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
