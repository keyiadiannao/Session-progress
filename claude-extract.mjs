/**
 * claude-extract.mjs - canonical adapter: Claude Code transcripts -> the SAME
 * snapshots.jsonl schema as the DSH extractor.
 *
 * Maps Claude Code's structure (assistant thinking/text/tool_use, user
 * tool_result, Task/TodoWrite) onto the canonical features, with tool names
 * normalized to CATEGORIES so the downstream rubric/model are framework-agnostic.
 *
 *   node claude-extract.mjs [projectsRoot] [outFile]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { actionSummary, resultSummary } from './summarize.mjs'

const ERROR_PATTERN = /(?:Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED|failed|error occurred|command not found|no such file|permission denied|not found|does not exist)/i

/** Claude Code injects interrupt markers as pseudo user messages - skip them. */
function isInterrupt(text) {
  const t = String(text || '').trim()
  return /^\[Request interrupted/i.test(t) || t === ''
}

/** Normalize a tool name (either framework) to a canonical category. */
export function category(name) {
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
    steps: 0, toolCalls: 0, callIndex: 0, tools: {}, toolsCat: {}, toolHistory: [], toolHistoryCat: [],
    filesWritten: [], recentResults: [], activity: [], errors: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    todoDone: 0, todoTotal: 0, hadTodo: false, producedArtifact: false,
    firstTime: null, lastTime: null, lastTool: null, lastCat: null,
  }
}

export function claudeSnapshots(sessionId, filePath) {
  const out = []
  let acc = null
  let turnNum = 0
  let task = ''
  let anchor = ''
  let pending = new Map() // tool_use_id -> { name, category }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : null
    const content = e.message?.content

    if (e.type === 'user') {
      if (typeof content === 'string') {
        // real instruction (or interrupt marker) as a plain string
        if (!isInterrupt(content)) {
          turnNum += 1
          acc = newAcc()
          task = content.slice(0, 600)
          anchor = ''
          pending = new Map()
          if (ts != null) acc.firstTime = ts
        }
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b) => b.type === 'text')
        if (textBlock && !isInterrupt(textBlock.text)) {
          turnNum += 1
          acc = newAcc()
          task = String(textBlock.text || '').slice(0, 600)
          anchor = ''
          pending = new Map()
          if (ts != null) acc.firstTime = ts
        }
        if (acc) {
          for (const b of content) {
            if (b.type !== 'tool_result') continue
          const meta = pending.get(b.tool_use_id)
          const name = meta?.name ?? '?'
          const cat = meta?.category ?? category(name)
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
          const isErr = b.is_error === true || ERROR_PATTERN.test(text)
          acc.callIndex += 1
          acc.toolCalls += 1
          acc.tools[cat] = (acc.tools[cat] ?? 0) + 1
          acc.toolsCat[cat] = (acc.toolsCat[cat] ?? 0) + 1
          acc.toolHistory.push(name)
          acc.toolHistoryCat.push(cat)
          acc.lastTool = name
          acc.lastCat = cat
          if (isErr) acc.errors += 1
          acc.activity.push({ action: meta?.action || actionSummary(name, {}), result: resultSummary(text), ok: !isErr })
          if (acc.activity.length > 30) acc.activity.shift()
          acc.recentResults.push({ tool: cat, snippet: text.replace(/\s+/g, ' ').slice(0, 400) })
          if (acc.recentResults.length > 3) acc.recentResults.shift()
          if (ts != null) acc.lastTime = ts
          out.push({
            sessionId: 'claude:' + sessionId,
            framework: 'claude',
            turn: turnNum,
            callIndex: acc.callIndex,
            task,
            taskTypeGuess: guessTaskType(task),
            anchorReasoning: anchor.slice(0, 4000),
            tool: name,
            toolCat: cat,
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
            toolKinds: Object.keys(acc.toolsCat).length,
            filesWrittenCount: new Set(acc.filesWritten).size,
            producedArtifact: acc.producedArtifact,
            errors: acc.errors,
            todoDone: acc.todoDone,
            todoTotal: acc.todoTotal,
            hadTodo: acc.hadTodo,
            elapsedSec: acc.firstTime != null && acc.lastTime != null ? Math.round((acc.lastTime - acc.firstTime) / 1000) : 0,
            tokens: { ...acc.tokens },
          })
          pending.delete(b.tool_use_id)
        }
      }
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      if (!acc) continue
      if (ts != null) { if (acc.firstTime == null) acc.firstTime = ts; acc.lastTime = ts }
      acc.steps += 1
      const u = e.message?.usage ?? {}
      acc.tokens.input += u.input_tokens ?? 0
      acc.tokens.output += u.output_tokens ?? 0
      acc.tokens.cacheRead += u.cache_read_input_tokens ?? 0
      for (const b of content) {
        if (b.type === 'thinking' && !anchor) anchor = String(b.thinking ?? '').slice(0, 4000)
        if (b.type === 'tool_use') {
          const cat = category(b.name)
          pending.set(b.id, { name: b.name, category: cat, action: actionSummary(b.name, b.input) })
          if ((b.name === 'Write' || b.name === 'Edit') && typeof b.input?.file_path === 'string' && b.input.file_path) {
            acc.filesWritten.push(b.input.file_path)
            acc.producedArtifact = true
          }
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            acc.hadTodo = true
            acc.todoTotal = b.input.todos.length
            acc.todoDone = b.input.todos.filter((t) => t.status === 'completed').length
          } else if (/TaskCreate|TaskUpdate|TaskStop|TaskList/.test(b.name)) {
            acc.hadTodo = true // Claude task-list completion is tracked via TaskUpdate/Stop; not fully resolved in v1
          }
        }
      }
    }
  }
  return out
}

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

function walkProjects(root) {
  const files = []
  const st = fs.statSync(root)
  if (!st.isDirectory()) return files
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) files.push(...walkProjects(p))
    else if (e.name.endsWith('.jsonl')) files.push(p)
  }
  return files
}

function main() {
  const root = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects')
  const outFile = process.argv[3] ?? path.join(process.cwd(), 'snapshots-claude.jsonl')
  const all = []
  let skipped = 0
  const files = walkProjects(root)
  for (const f of files) {
    const size = fs.statSync(f).size
    if (size > 100 * 1024 * 1024) { skipped++; console.log(`[skip] ${f} (${(size / 1048576).toFixed(0)}MB)`); continue }
    // unique per file: a session dir contains many subagent files whose paths
    // share a long prefix, so a truncated path would COLLIDE session ids.
    const sid = crypto.createHash('sha1').update(f).digest('hex').slice(0, 16)
    all.push(...claudeSnapshots(sid, f))
  }
  fs.writeFileSync(outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  console.log(`[claude-extract] ${all.length} snapshots from ${files.length - skipped} files (${skipped} skipped) -> ${outFile}`)
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
