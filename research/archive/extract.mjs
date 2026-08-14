/**
 * extract.mjs - Phase 0: turn-level feature extractor for DSH session logs.
 *
 * Decodes session.jsonl.zstd, segments events into turns (turn/start ->
 * turn/end), and emits one JSONL record per turn with deterministic features.
 * LABELS ARE NOT PRODUCED HERE - they are added separately (agent-judged),
 * kept in labels.jsonl so the deterministic extract and the judgment stay
 * separable and versionable.
 *
 *   node extract.mjs [sessionsRoot] [outFile]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodeSessionLog, discoverSessionDirs } from './index.mjs'

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

function turnFeatures(sessionId, turnNum, events) {
  const f = {
    sessionId,
    turn: turnNum,
    task: '',
    steps: 0,
    toolCalls: 0,
    tools: {},
    filesWritten: [],
    errors: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
    elapsedSec: 0,
    todoDone: 0,
    todoTotal: 0,
    hadTodo: false,
    endedReason: null,
    producedArtifact: false,
  }
  let firstTime = null
  let lastTime = null
  let lastTool = null
  for (const e of events) {
    if (typeof e.time === 'number') { if (firstTime === null) firstTime = e.time; lastTime = e.time }
    const t = e.type
    if (t === 'step/start') f.steps += 1
    else if (t === 'user/message') {
      const c = extractUserText(e.data?.content)
      // take the first real user instruction (skip system-reminder injections)
      if (c && !f.task && !c.startsWith('<system-reminder>')) f.task = c
    }
    else if (t === 'tool/call') {
      f.toolCalls += 1
      const name = e.data?.name ?? '?'
      f.tools[name] = (f.tools[name] ?? 0) + 1
      lastTool = name
      // produced artifacts: write/edit tools declare a file_path argument
      if ((name === 'write' || name === 'edit' || name === 'str_replace_editor') && e.data?.arguments) {
        try {
          const a = typeof e.data.arguments === 'string' ? JSON.parse(e.data.arguments) : e.data.arguments
          const p = a.file_path ?? a.path
          if (typeof p === 'string' && p) { f.filesWritten.push(p); f.producedArtifact = true }
        } catch { /* non-JSON args */ }
      }
    } else if (t === 'tool/result') {
      if (ERROR_PATTERN.test(extractToolText(e.data?.message))) f.errors += 1
    } else if (t === 'todo/write' && Array.isArray(e.data?.todos)) {
      f.hadTodo = true
      f.todoTotal = e.data.todos.length
      f.todoDone = e.data.todos.filter((x) => x.status === 'completed').length
    } else if (t === 'assistant/message' && e.data?.usage) {
      const u = e.data.usage
      f.tokens.input += u.inputTokens ?? 0
      f.tokens.output += u.outputTokens ?? 0
      f.tokens.reasoning += u.reasoningTokens ?? 0
      f.tokens.cacheRead += u.cacheReadTokens ?? 0
    } else if (t === 'turn/end') {
      f.endedReason = e.data?.reason?.kind ?? 'unknown'
    }
  }
  f.task = f.task.slice(0, 200)
  f.filesWritten = [...new Set(f.filesWritten)].slice(0, 30)
  if (firstTime !== null && lastTime !== null) f.elapsedSec = Math.round((lastTime - firstTime) / 1000)
  return f
}

export function extractTurns(sessionId, events) {
  const turns = []
  let current = []
  let inTurn = false
  let turnNum = 0
  for (const e of events) {
    if (e.type === 'turn/start') {
      inTurn = true
      current = []
    } else if (e.type === 'turn/end') {
      turnNum += 1
      current.push(e)
      const f = turnFeatures(sessionId, turnNum, current)
      f.noWork = f.steps === 0 && f.toolCalls === 0
      turns.push(f)
      current = []
      inTurn = false
    } else if (inTurn) {
      current.push(e)
    }
  }
  return turns
}

function main() {
  const sessionsRoot = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')
  const outFile = process.argv[3] ?? path.join(process.cwd(), 'features.jsonl')
  const all = []
  for (const s of discoverSessionDirs(sessionsRoot)) {
    const events = decodeSessionLog(s.log)
    if (events.length === 0) continue
    all.push(...extractTurns(s.name, events))
  }
  const lines = all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : '')
  fs.writeFileSync(outFile, lines, 'utf8')
  console.log(`[extract] ${all.length} turns -> ${outFile}`)
  console.log(`[extract] sessions: ${discoverSessionDirs(sessionsRoot).length}`)
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
