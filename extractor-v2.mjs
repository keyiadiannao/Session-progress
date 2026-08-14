/**
 * extractor-v2.mjs - four-layer structured snapshot (schema v2).
 *
 *   raw prefix events
 *     -> observations  (observable facts, with provenance)
 *     -> derived       (aggregate counts)
 *     -> interpretation (milestones, overridable by the model)
 *     -> cost          (weak features, diagnostics only)
 *
 * Unlike v1 (a flat "activity text"), v2 separates WHAT IS OBSERVED from WHAT IT
 * MEANS, and tags every observation/claim with provenance so a mistaken
 * extractor can be re-interpreted from the fact layer without re-parsing the
 * transcript.
 *
 * DSH path only for now; the Claude adapter applies the same mapping.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodeSessionLog, discoverSessionDirs } from './index.mjs'
import { category, actionSummary, resultSummary } from './summarize.mjs'

const ERROR_PATTERN = /(?:\[exit code: (?!0\b)\d+\]|Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED)/i
const TEST_RESULT_RE = /(\d+)\s*passed?|(\d+)\s*failed?|(\d+)\s*error/i

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
  return walk(message)
}

const CLAIM_PATTERNS = [
  ['validation_passed', /(?:测试|tests?|all)\s*(?:通过|passed)|^\s*(?:passed|success)\b|通过\b|passed\b/i],
  ['bug_found', /发现\s*(?:bug|问题|报错)|found\s*(?:a\s*)?bug|报错|失败|failed|error/i],
  ['approach_switched', /换(?:个|一种|了)?(?:思路|方案|方法|方向)|switch(?:ed)?\s*(?:approach|plan|strategy)|换个/i],
  ['ready_to_deliver', /(?:准备|可以|即将)(?:交付|提交|收尾)|ready\s*(?:to|for)\s*(?:deliver|ship|submit)|完成|收尾/i],
]

/** Extract visible claims from an assistant message's TEXT blocks (never reasoning). */
function extractClaims(content, eventId) {
  const claims = []
  const walk = (c) => {
    if (Array.isArray(c)) { for (const b of c) walk(b); return }
    if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
      const text = c.text
      for (const [type, re] of CLAIM_PATTERNS) {
        if (re.test(text)) {
          claims.push({ type, text: text.replace(/\s+/g, ' ').slice(0, 120), source_event_id: eventId, source: 'assistant_visible_text' })
          break // one claim per block
        }
      }
    }
  }
  walk(content)
  return claims
}

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
  if (d.tests_run >= 1 && d.tests_failed === 0) ms.push({ type: 'validation_passed', confidence: 0.94, evidence_ids: ['derived.tests_run', 'derived.tests_failed'] })
  if (d.tests_failed >= 1) ms.push({ type: 'validation_failed', confidence: 0.94, evidence_ids: ['derived.tests_failed'] })
  if (d.todo_total > 0 && d.todo_done / d.todo_total >= 0.9) ms.push({ type: 'integrating', confidence: 0.85, evidence_ids: ['derived.todo_done', 'derived.todo_total'] })
  return ms
}

export function turnSnapshotsV2(sessionId, events) {
  const out = []
  let acc = null
  let turnNum = 0
  let task = ''
  let eventId = 0
  let lastCall = null
  for (const e of events) {
    eventId += 1
    const t = e.type
    if (t === 'turn/start') { turnNum += 1; acc = newAcc(); task = ''; lastCall = null; continue }
    if (t === 'turn/end' || !acc) continue
    if (typeof e.time === 'number') { if (acc.firstTime === null) acc.firstTime = e.time; acc.lastTime = e.time }
    if (t === 'step/start') acc.cost.steps += 1
    else if (t === 'user/message') { const c = extractUserText(e.data?.content); if (c && !task && !c.startsWith('<system-reminder>')) task = c }
    else if (t === 'tool/call') {
      const name = e.data?.name ?? '?'
      const cat = category(name)
      let args = e.data?.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      lastCall = { id: `call_${eventId}`, name, category: cat, args_summary: (args?.file_path || args?.command || args?.pattern || args?.query || '')?.toString().slice(0, 80), action: actionSummary(name, args) }
      acc.derived.tool_calls_total += 1
      acc.observations.tool_calls.push(lastCall)
      if (lastCall.category === 'write') {
        const p = args?.file_path || args?.path
        if (p) {
          acc.observations.files.push({ path: p, ext: path.extname(p), lines: String(args?.content || '').split('\n').length })
          acc.derived.produced_artifact = true
        }
      }
    } else if (t === 'tool/result') {
      const text = extractToolText(e.data?.message)
      const isErr = ERROR_PATTERN.test(text)
      // status provenance: explicit exit code vs inference
      let status = null
      let statusSource = null
      const ec = text.match(/\[exit code: (\d+)\]/)
      if (ec) { status = Number(ec[1]) === 0 ? 'success' : 'error'; statusSource = 'tool_metadata' }
      else { status = isErr ? 'error' : 'unknown'; statusSource = 'inferred' }
      acc.derived.errors_total += isErr ? 1 : 0
      acc._recent.push(isErr); if (acc._recent.length > 6) acc._recent.shift()
      acc.derived.recent_errors = acc._recent.filter(Boolean).length
      if (lastCall?.category === 'write' && status === 'success') acc.derived.writes_succeeded += 1
      if (lastCall?.category === 'run') {
        const m = text.match(TEST_RESULT_RE)
        if (text.match(/passed|failed/i)) { acc.derived.tests_run += 1; if (status === 'error' || /failed|error/i.test(text)) acc.derived.tests_failed += 1 }
      }
      acc.observations.tool_results.push({ id: `res_${eventId}`, tool_call_id: lastCall?.id, status, status_source: statusSource, tail: text.replace(/\s+/g, ' ').slice(-160) })
      if (acc.observations.tool_results.length > 25) acc.observations.tool_results.shift()
      // semantic activity log: "做了什么 → 结果如何" (input to the semantic summarizer)
      acc.observations.activity.push({ action: lastCall?.action || lastCall?.name, result: resultSummary(text), ok: !isErr })
      if (acc.observations.activity.length > 30) acc.observations.activity.shift()
      acc.interpretation.milestones = deriveMilestones(acc)
      acc.cost.elapsed = acc.firstTime != null && acc.lastTime != null ? Math.round((acc.lastTime - acc.firstTime) / 1000) : 0
      out.push(snapshot(sessionId, turnNum, acc, task, eventId))
    } else if (t === 'todo/write' && Array.isArray(e.data?.todos)) {
      acc.derived.todo_total = e.data.todos.length
      acc.derived.todo_done = e.data.todos.filter((x) => x.status === 'completed').length
    } else if (t === 'assistant/message') {
      const u = e.data?.usage
      if (u) { acc.cost.tokens.input += u.inputTokens ?? 0; acc.cost.tokens.output += u.outputTokens ?? 0; acc.cost.tokens.reasoning += u.reasoningTokens ?? 0 }
      const claims = extractClaims(e.data?.message?.content, eventId)
      acc.observations.visible_claims.push(...claims)
      if (acc.observations.visible_claims.length > 15) acc.observations.visible_claims.splice(0, acc.observations.visible_claims.length - 15)
    }
  }
  return out
}

function snapshot(sessionId, turnNum, acc, task, eventId) {
  return {
    schema_version: '2.0',
    sessionId, turn: turnNum, callIndex: acc.derived.tool_calls_total,
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

function main() {
  const sessionsRoot = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')
  const outFile = process.argv[3] ?? path.join(process.cwd(), 'snapshots-v2.jsonl')
  const all = []
  for (const s of discoverSessionDirs(sessionsRoot)) {
    const events = decodeSessionLog(s.log)
    if (events.length === 0) continue
    all.push(...turnSnapshotsV2(s.name, events))
  }
  fs.writeFileSync(outFile, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8')
  console.log(`[extractor-v2] ${all.length} v2 snapshots -> ${outFile}`)
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
