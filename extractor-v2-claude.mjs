/**
 * extractor-v2-claude.mjs - four-layer schema v2 for Claude Code transcripts.
 * Same structure as extractor-v2.mjs (DSH), mapped from Claude events.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { category, actionSummary, resultSummary } from './summarize.mjs'

const ERROR_PATTERN = /(?:Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED|failed|error occurred|command not found|no such file|permission denied|not found|does not exist)/i
const CLAIM_PATTERNS = [
  ['validation_passed', /(?:tests?|all)\s*(?:pass(?:ed)?)|passed|通过|success/i],
  ['bug_found', /found\s*(?:a\s*)?bug|发现\s*(?:bug|问题)|报错|失败|error|failed/i],
  ['approach_switched', /switch(?:ed)?\s*(?:approach|plan|strategy)|换(?:个|一种)?(?:思路|方案|方法)/i],
  ['ready_to_deliver', /ready\s*(?:to|for)\s*(?:deliver|ship|submit)|(?:准备|可以|即将)(?:交付|提交|完成)|完成|收尾/i],
]
const TEST_RESULT_RE = /(\d+)\s*pass|(\d+)\s*fail|(\d+)\s*error/i

function isInterrupt(t) { return /^\[Request interrupted/i.test(String(t || '').trim()) || String(t || '').trim() === '' }

function newAcc() {
  return {
    observations: { tool_calls: [], tool_results: [], visible_claims: [], files: [], activity: [] },
    derived: { writes_succeeded: 0, tests_run: 0, tests_failed: 0, errors_total: 0, recent_errors: 0, todo_done: 0, todo_total: 0, produced_artifact: false, tool_calls_total: 0 },
    interpretation: { milestones: [] },
    cost: { tokens: { input: 0, output: 0, reasoning: 0 }, elapsed: 0, steps: 0 },
    firstTime: null, lastTime: null,
    _recent: [],
  }
}

function deriveMilestones(acc) {
  const d = acc.derived
  const ms = []
  if (d.produced_artifact && d.writes_succeeded >= 1) ms.push({ type: 'first_output', confidence: 0.9, evidence_ids: ['derived.writes_succeeded'] })
  if (d.tests_run >= 1 && d.tests_failed === 0) ms.push({ type: 'validation_passed', confidence: 0.94, evidence_ids: ['derived.tests_run'] })
  if (d.tests_failed >= 1) ms.push({ type: 'validation_failed', confidence: 0.94, evidence_ids: ['derived.tests_failed'] })
  if (d.todo_total > 0 && d.todo_done / d.todo_total >= 0.9) ms.push({ type: 'integrating', confidence: 0.85, evidence_ids: ['derived.todo'] })
  return ms
}

function snapshot(sessionId, turnNum, acc, task) {
  return {
    schema_version: '2.0',
    sessionId: 'claude:' + sessionId, framework: 'claude', turn: turnNum, callIndex: acc.derived.tool_calls_total,
    task: task.slice(0, 600),
    observations: {
      tool_calls: acc.observations.tool_calls.slice(-20),
      tool_results: acc.observations.tool_results.slice(-20),
      visible_claims: acc.observations.visible_claims.slice(-15),
      files: acc.observations.files.slice(-20),
      activity: acc.observations.activity.slice(-25),
      activityText: acc.observations.activity.slice(-25).map((x) => x.action + (x.result ? ' → ' + x.result : '')).join('\n'),
    },
    derived: { ...acc.derived },
    interpretation: { milestones: acc.interpretation.milestones.slice(-5) },
    cost: acc.cost,
  }
}

export function claudeSnapshotsV2(sessionId, filePath) {
  const out = []
  let acc = null, turnNum = 0, task = '', eventId = 0
  let pending = new Map()
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    eventId += 1
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : null
    const content = e.message?.content
    if (e.type === 'user') {
      if (typeof content === 'string') {
        if (!isInterrupt(content)) { turnNum += 1; acc = newAcc(); task = content.slice(0, 600); pending = new Map(); if (ts != null) acc.firstTime = ts }
      } else if (Array.isArray(content)) {
        const tb = content.find((b) => b.type === 'text')
        if (tb && !isInterrupt(tb.text)) { turnNum += 1; acc = newAcc(); task = String(tb.text || '').slice(0, 600); pending = new Map(); if (ts != null) acc.firstTime = ts }
        if (acc) for (const b of content) {
          if (b.type !== 'tool_result') continue
          const meta = pending.get(b.tool_use_id)
          const name = meta?.name ?? '?'
          const cat = meta?.category ?? category(name)
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
          const isErr = b.is_error === true || ERROR_PATTERN.test(text)
          acc.derived.tool_calls_total += 1
          acc.derived.errors_total += isErr ? 1 : 0
          acc._recent.push(isErr); if (acc._recent.length > 6) acc._recent.shift()
          acc.derived.recent_errors = acc._recent.filter(Boolean).length
          let status = b.is_error === true ? 'error' : 'success'; const statusSource = b.is_error === true ? 'tool_metadata' : 'inferred'
          if (cat === 'write' && status === 'success') acc.derived.writes_succeeded += 1
          if (cat === 'run' && /pass|fail|error/i.test(text)) { acc.derived.tests_run += 1; if (isErr) acc.derived.tests_failed += 1 }
          acc.observations.tool_results.push({ id: `res_${eventId}`, tool_call_id: meta?.id, status, status_source: statusSource, tail: text.replace(/\s+/g, ' ').slice(-160) })
          if (acc.observations.tool_results.length > 25) acc.observations.tool_results.shift()
          acc.observations.activity.push({ action: meta?.action || meta?.name, result: resultSummary(text), ok: !isErr })
          if (acc.observations.activity.length > 30) acc.observations.activity.shift()
          acc.interpretation.milestones = deriveMilestones(acc)
          if (ts != null) acc.lastTime = ts
          acc.cost.elapsed = acc.firstTime != null && acc.lastTime != null ? Math.round((acc.lastTime - acc.firstTime) / 1000) : 0
          out.push(snapshot(sessionId, turnNum, acc, task))
          pending.delete(b.tool_use_id)
        }
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      if (!acc) continue
      if (ts != null) { if (acc.firstTime == null) acc.firstTime = ts; acc.lastTime = ts }
      acc.cost.steps += 1
      const u = e.message?.usage ?? {}
      acc.cost.tokens.input += u.input_tokens ?? 0; acc.cost.tokens.output += u.output_tokens ?? 0
      for (const b of content) {
        if (b.type === 'tool_use') {
          const cat = category(b.name)
          const p = (b.name === 'Write' || b.name === 'Edit') && typeof b.input?.file_path === 'string' ? b.input.file_path : ''
          acc.observations.tool_calls.push({ id: `call_${eventId}`, name: b.name, category: cat, args_summary: (b.input?.command || b.input?.file_path || b.input?.pattern || '')?.toString().slice(0, 80), action: actionSummary(b.name, b.input) })
          if (acc.observations.tool_calls.length > 20) acc.observations.tool_calls.shift()
          pending.set(b.id, { name: b.name, category: cat, id: `call_${eventId}`, action: actionSummary(b.name, b.input) })
          if (p) { acc.observations.files.push({ path: p, ext: path.extname(p), lines: String(b.input?.content || '').split('\n').length }); acc.derived.produced_artifact = true }
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) { acc.derived.todo_total = b.input.todos.length; acc.derived.todo_done = b.input.todos.filter((t) => t.status === 'completed').length }
        }
        if (b.type === 'text' && typeof b.text === 'string') {
          for (const [type, re] of CLAIM_PATTERNS) {
            if (re.test(b.text)) { acc.observations.visible_claims.push({ type, text: b.text.replace(/\s+/g, ' ').slice(0, 120), source_event_id: eventId, source: 'assistant_visible_text' }); break }
          }
        }
      }
    }
  }
  return out
}

function walkProjects(root) {
  const files = []
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return files
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) files.push(...walkProjects(p))
    else if (e.name.endsWith('.jsonl')) files.push(p)
  }
  return files
}

function main() {
  const root = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects')
  const outFile = process.argv[3] ?? path.join(process.cwd(), 'snapshots-v2-claude.jsonl')
  const all = []
  let skipped = 0
  for (const f of walkProjects(root)) {
    if (fs.statSync(f).size > 100 * 1024 * 1024) { skipped++; continue }
    const sid = crypto.createHash('sha1').update(f).digest('hex').slice(0, 16)
    all.push(...claudeSnapshotsV2(sid, f))
  }
  fs.writeFileSync(outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  console.log(`[extractor-v2-claude] ${all.length} snapshots (${skipped} skipped) -> ${outFile}`)
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
