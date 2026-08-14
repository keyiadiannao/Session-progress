/**
 * dsh-session-progress - independent evaluator of the CURRENT agent session.
 *
 * Reads the current session's conversation log (session.jsonl.zstd, decoded
 * with Node's built-in node:zlib zstd), evaluates how the task is progressing
 * and whether it is going smoothly, and serves an independent dashboard page.
 * Never writes into the conversation.
 *
 * Config (config.json):
 *   { "port": 3278,
 *     "sessionsRoot": "C:/Users/26433/.dsh/sessions",   // auto-pick newest session
 *     "sessionDir": "",                                  // optional explicit session dir
 *     "pollMs": 2000,
 *     "stallSeconds": 60 }
 *
 * Honest by design: agent tasks have no known total, so there is no fake
 * percent. The evaluation uses the agent's own structure: turn/step events,
 * todo/write plan items, tool call/result streams, and token usage.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stageFromFacts, modeFromFacts, BAND } from './stage-rule.mjs'
import { actionSummary, resultSummary, category } from './summarize.mjs'

const MAGIC = 0xFD2FB528

/* ------------------------------ zstd frame decoding ------------------------------ */
/* Frame-scan logic ported from dsh-session-persistence-jsonl (MIT). */

/** Locate structurally complete zstd frames in a concatenated frame stream. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decode a session.jsonl.zstd file into parsed events (skipping partial lines). */
export function decodeSessionLog(filePath) {
  if (!fs.existsSync(filePath)) return []
  const buf = fs.readFileSync(filePath)
  let text = ''
  for (const f of scanZstdFrames(buf)) {
    try { text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { /* skip torn frame */ }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* partial line while being appended */ }
  }
  return events
}

/* ------------------------------ evaluation ------------------------------ */

// Strong markers only: bare "failed"/"timeout" are too common in normal
// output (e.g. "-TimeoutSec" flags on every PowerShell call), so they are
// deliberately NOT matched. "FAILED" is kept because it appears in test
// summaries as a genuine failure signal.
const ERROR_PATTERN = /(?:\[exit code: (?!0\b)\d+\]|Error:|Traceback|EPERM|ENOENT|EACCES|EADDRINUSE|AssertionError|Exception|FAILED)/i

/* ------------------- lightweight percent model (offline-trained) ------------------- */
// A single decision tree trained offline on full-trajectory % labels
// (annotate-percent.mjs -> export-model.py).  Runtime walks the tree over prefix
// facts and calls NO LLM.  Fallback: the rule (todo ratio / stage band).
const CATS = ['run', 'write', 'inspect', 'search', 'todo', 'report', 'subagent', 'ask_user', 'mcp', 'skill', 'job', 'other']

function loadPercentModel() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const p of [path.join(here, 'percent-model.json'), path.join(here, 'dataset', 'percent-model.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* next */ }
  }
  return null
}
const PERCENT_MODEL = loadPercentModel()

/** Walk the exported decision tree over a feature object -> predicted %. */
function treePredict(node, f) {
  if (node.value !== undefined) return node.value
  return f[node.feature] <= node.threshold ? treePredict(node.left, f) : treePredict(node.right, f)
}

/** Build the EXACT feature vector the offline model was trained on (prefix facts). */
function modelFeatures(snap, band) {
  const d = snap.derived
  const files = snap.observations.files
  const tc = snap.observations.tool_calls
  const f = {
    tool_calls_total: d.tool_calls_total,
    writes_succeeded: d.writes_succeeded,
    tests_run: d.tests_run,
    tests_failed: d.tests_failed,
    errors_total: d.errors_total,
    recent_errors: d.recent_errors,
    todo_done: d.todo_done,
    todo_total: d.todo_total,
    todo_ratio: d.todo_total ? d.todo_done / d.todo_total : 0,
    produced_artifact: d.produced_artifact ? 1 : 0,
    files_count: files.length,
  }
  f.has_report = files.some((fl) => /\.(md|tex)$/i.test(fl.path || '') || /readme/i.test(fl.path || '')) ? 1 : 0
  const exts = new Set(files.map((fl) => (fl.ext || '').toLowerCase()))
  f.has_code = ['py', 'js', 'ts', 'mjs', 'sh', 'ps1'].some((e) => exts.has('.' + e)) ? 1 : 0
  const cc = {}
  for (const t of tc) cc[t.category] = (cc[t.category] || 0) + 1
  for (const c of CATS) f['cat_' + c] = cc[c] || 0
  f.band_mid = band ? Math.round((band[0] + band[1]) / 2) : 35
  return f
}

/** Recursively extract text from a tool-result message (nested content blocks). */
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
  return walk(message).slice(0, 8000)
}

function extractUserText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : '')).join(' ')
  return ''
}

/** Visible-claim patterns (same as extractor-v2.mjs) — from assistant TEXT only. */
const CLAIM_PATTERNS = [
  ['validation_passed', /(?:测试|tests?|all)\s*(?:通过|passed)|^\s*(?:passed|success)\b|通过\b|passed\b/i],
  ['bug_found', /发现\s*(?:bug|问题|报错)|found\s*(?:a\s*)?bug|报错|失败|failed|error/i],
  ['approach_switched', /换(?:个|一种|了)?(?:思路|方案|方法|方向)|switch(?:ed)?\s*(?:approach|plan|strategy)|换个/i],
  // NOTE: 只匹配"明确的交付声明"，刻意排除裸"完成/收尾/全部完成"——它们常指
  // 子任务完成，或"讨论某里程碑词"的元文本，而非整个任务交付就绪。regex 无法区分
  // "引用 vs 表达"，所以这里取最保守：宁可漏报 ready，不误报 false ready。
  ['ready_to_deliver', /(?:准备|可以|即将|现在)(?:交付|提交|上线|发布)|ready\s*(?:to|for)\s*(?:deliver|ship|submit|publish)/i],
]

/** Extract visible claims from an assistant message's TEXT blocks (never reasoning). */
function extractClaims(content) {
  const claims = []
  const walk = (c) => {
    if (Array.isArray(c)) { for (const b of c) walk(b); return }
    if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string') {
      for (const [type, re] of CLAIM_PATTERNS) {
        if (re.test(c.text)) {
          claims.push({ type, text: c.text.replace(/\s+/g, ' ').slice(0, 120), source: 'assistant_visible_text' })
          break
        }
      }
    }
  }
  walk(content)
  return claims
}

/** Is a `run` tool call actually a test run (as opposed to a generic command)? */
function isTestCommand(name, args) {
  const cmd = String(args?.command || args?.cmd || args?.code || args?.script || name || '').toLowerCase()
  return /(^|\s)(pytest|jest|mocha|npm\s+(run\s+)?test|yarn\s+test|go\s+test|cargo\s+test)|test|测试|run_tests/i.test(cmd)
}

/**
 * Evaluate one session's event log.
 * @param events - parsed session events (oldest first).
 * @param now - epoch ms for stall/idle computation.
 * @returns assessment object for the dashboard.
 */
export function evaluateSession(events, now = Date.now()) {
  const state = {
    task: '',
    turnCount: 0,
    turnOpen: false,
    lastTurnReason: null,
    stepCount: 0,
    todos: [],
    lastTodoAt: 0,
    toolCalls: [],
    lastTool: null,
    errors: [],
    lastResults: [], // rolling window of { error } for the most recent tool results
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    activities: [],
    // ---- semantic facts (for stage/mode rule) ----
    artifacts: new Set(),          // DISTINCT successfully-created artifact paths
    validationPassedOnce: false,   // any validation episode ever passed (monotonic)
    validationJustFailed: false,   // most recent validation episode failed
    validationInProgress: false,   // a test run is currently the last tool
    readyEvidence: false,          // ready_to_deliver claim seen
    visibleClaims: [],             // extracted assistant-text claims
    // ---- cumulative counters (only for the offline percent model features) ----
    files: [],
    activity: [],
    writesSucceeded: 0,
    testsRun: 0,
    testsFailed: 0,
    firstEventTime: null,
    lastEventTime: null,
  }

  for (const e of events) {
    if (typeof e.time === 'number') {
      if (state.firstEventTime === null) state.firstEventTime = e.time
      state.lastEventTime = e.time
    }
    const t = e.type
    if (t === 'turn/start') { state.turnOpen = true; state.turnCount += 1 }
    else if (t === 'turn/end') { state.turnOpen = false; state.lastTurnReason = e.data?.reason?.kind ?? 'unknown' }
    else if (t === 'step/start') state.stepCount += 1
    else if (t === 'user/message') { const c = extractUserText(e.data?.content); if (c) state.task = c }
    else if (t === 'todo/write' && Array.isArray(e.data?.todos)) { state.todos = e.data.todos; state.lastTodoAt = e.time ?? 0 }
    else if (t === 'tool/call') {
      const name = e.data?.name ?? '?'
      const cat = category(name)
      let args = e.data?.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
      const argSum = (args?.file_path || args?.command || args?.pattern || args?.query || '')?.toString().slice(0, 80) || ''
      const action = actionSummary(name, args)
      state.toolCalls.push({ name, time: e.time, category: cat, args_summary: argSum, action })
      state.lastTool = { name, time: e.time, category: cat, args_summary: argSum, action, args }
      // NOTE: artifact is NOT recorded here — it is recorded only on a SUCCESSFUL
      // tool/result (P0 fix: a failed write must not count as first_output).
      if (cat === 'run' && isTestCommand(name, args)) state.validationInProgress = true
    } else if (t === 'tool/result') {
      const text = extractToolText(e.data?.message)
      const isErr = ERROR_PATTERN.test(text)
      const success = !isErr
      state.lastResults.push({ error: isErr, time: e.time, name: state.lastTool?.name ?? '?' })
      if (state.lastResults.length > 6) state.lastResults.shift()
      // semantic activity log: "做了什么 → 结果如何"
      state.activity.push({ action: state.lastTool?.action || state.lastTool?.name, result: resultSummary(text), ok: success })
      if (state.activity.length > 30) state.activity.shift()

      const lt = state.lastTool
      // artifact: ONLY on a SUCCESSFUL write, deduped by path (P0 fix)
      if (lt?.category === 'write') {
        const p = lt.args?.file_path || lt.args?.path
        if (p && success) {
          if (!state.artifacts.has(p)) {
            state.artifacts.add(p)
            state.files.push({ path: p, ext: path.extname(p) })
          }
          state.writesSucceeded += 1 // cumulative, for the offline model features
        }
      }
      // validation episode: each test run closes the episode and updates state (P0 fix)
      if (lt?.category === 'run' && state.validationInProgress) {
        state.validationInProgress = false
        const passed = success && !/failed|error/i.test(text)
        if (passed) {
          state.validationPassedOnce = true // monotonic: once passed, stage never regresses
          state.validationJustFailed = false
        } else {
          state.validationJustFailed = true // mode goes rework, stage stays
        }
        state.testsRun += 1 // cumulative, for the offline model features
        if (!passed) state.testsFailed += 1
      }
      if (isErr) {
        state.errors.push({
          time: e.time,
          name: state.lastTool?.name ?? '?',
          snippet: text.replace(/\s+/g, ' ').slice(0, 260),
        })
      }
    } else if (t === 'assistant/message') {
      const u = e.data?.usage
      if (u) {
        state.usage.inputTokens += u.inputTokens ?? 0
        state.usage.outputTokens += u.outputTokens ?? 0
        state.usage.cacheReadTokens += u.cacheReadTokens ?? 0
        state.usage.reasoningTokens += u.reasoningTokens ?? 0
      }
      // semantic evidence: visible claims (ready_to_deliver etc.) from assistant TEXT
      for (const c of extractClaims(e.data?.message?.content)) {
        if (c.type === 'ready_to_deliver') state.readyEvidence = true
        state.visibleClaims.push(c)
        if (state.visibleClaims.length > 15) state.visibleClaims.shift()
      }
    }
    if (e.type === 'tool/call' || e.type === 'step/start' || e.type === 'user/message' || e.type === 'turn/end') {
      state.activities.push({ type: t, name: t === 'tool/call' ? e.data?.name : t, time: e.time })
    }
  }

  const lastTs = state.lastEventTime ?? state.firstEventTime
  const idleSec = lastTs != null ? Math.max(0, (now - lastTs) / 1000) : null
  const elapsedSec = state.firstEventTime != null && lastTs != null ? Math.max(0, (lastTs - state.firstEventTime) / 1000) : 0

  // status
  let status = 'no-data'
  if (events.length > 0) {
    if (state.turnOpen) status = idleSec != null && idleSec > 60 ? 'stalled' : 'running'
    else status = state.lastTurnReason === 'completed' ? 'completed' : state.lastTurnReason ? `ended:${state.lastTurnReason}` : 'idle'
  }

  // plan progress from the agent's own todos
  const doneTodos = state.todos.filter((t) => t.status === 'completed').length
  const currentTodo = state.todos.find((t) => t.status !== 'completed')
  const todoRatio = state.todos.length ? doneTodos / state.todos.length : null
  const planCoverage = todoRatio !== null
    ? { done: doneTodos, total: state.todos.length, percent: Math.round(todoRatio * 100), basis: 'agent-todo' }
    : null

  // recent errors (rolling window) — used by stage facts and smoothness
  const recentErrCount = state.lastResults.filter((r) => r.error).length

  // ---- progress_stage + activity_mode (facts-based; stage monotonic because its
  //      driving facts are monotonic: artifacts only grow, validationPassedOnce
  //      only latches true, readyEvidence only latches true) ----
  const snap = {
    derived: {
      tests_run: state.testsRun, tests_failed: state.testsFailed,
      writes_succeeded: state.writesSucceeded, produced_artifact: state.artifacts.size > 0,
      errors_total: state.errors.length, recent_errors: recentErrCount,
      todo_done: doneTodos, todo_total: state.todos.length,
      tool_calls_total: state.toolCalls.length,
    },
    observations: {
      files: state.files,
      visible_claims: state.visibleClaims,
      tool_calls: state.toolCalls.slice(-20),
      activity: state.activity,
    },
    interpretation: { milestones: [] },
  }
  const facts = {
    toolCallsTotal: state.toolCalls.length,
    artifactCount: state.artifacts.size,
    validationPassedOnce: state.validationPassedOnce,
    validationJustFailed: state.validationJustFailed,
    validationInProgress: state.validationInProgress,
    readyEvidence: state.readyEvidence, // ready_to_deliver claim only (completed turn is a 100% terminal, not stage=ready)
    todoRatio,
    recentErrors: recentErrCount,
    lastToolCategory: state.lastTool?.category || null,
  }
  const stage = events.length === 0 ? 'no-data' : stageFromFacts(facts)
  const mode = modeFromFacts(facts)
  const band = BAND[stage] ?? null

  // ---- current % estimate: lightweight model (prefix facts -> %), ZERO LLM ----
  // The model was trained OFFLINE on full-trajectory % labels; at runtime it only
  // walks a decision tree over prefix facts.  Falls back to the rule if the model
  // file is missing.  A completed turn is the only genuine 100% terminal state.
  let percent = 0
  let percentBasis = 'none'
  if (status === 'completed') {
    percent = 100
    percentBasis = 'completed'
  } else if (PERCENT_MODEL) {
    const mf = modelFeatures(snap, band)
    percent = Math.round(Math.max(0, Math.min(100, treePredict(PERCENT_MODEL.tree, mf))))
    percentBasis = 'model'
  } else if (todoRatio !== null) {
    percent = Math.round(todoRatio * 100); percentBasis = 'plan'
  } else if (band) {
    percent = Math.round((band[0] + band[1]) / 2); percentBasis = 'stage'
  }

  // smoothness from the rolling window of recent tool results
  let smoothness = 'normal'
  let smoothNote = '执行正常'
  if (status === 'stalled') { smoothness = 'stalled'; smoothNote = `疑似停滞：${Math.round(idleSec)} 秒无新活动` }
  else if (recentErrCount >= 3) { smoothness = 'problem'; smoothNote = `最近 ${state.lastResults.length} 个工具结果中 ${recentErrCount} 个疑似失败` }
  else if (recentErrCount >= 1) { smoothness = 'attention'; smoothNote = `最近出现 ${recentErrCount} 个疑似报错（见下方详情）` }

  const lastActivities = state.activities.slice(-10).reverse()

  // total model tokens the task itself consumed (budget base for the judge)
  const taskTokens = state.usage.inputTokens + state.usage.outputTokens + state.usage.cacheReadTokens + state.usage.reasoningTokens

  // semantic-summary context (input to the LLM summary layer)
  const summaryContext = {
    task: state.task.slice(0, 400),
    plan: state.todos.slice(0, 10).map((t) => ({
      s: t.status === 'completed' ? 'done' : (t.status === 'in_progress' || t.status === 'doing') ? 'doing' : 'todo',
      c: String(t.content ?? '').slice(0, 60),
    })),
    stage,
    steps: state.stepCount,
    toolCalls: state.toolCalls.length,
    lastTools: state.toolCalls.slice(-5).map((t) => t.name),
    recentErrors: recentErrCount,
    elapsedSec: Math.round(elapsedSec),
  }

  return {
    ok: true,
    sessionLabel: path.basename(path.dirname(state._file ?? '')),
    status,
    stage,
    mode,
    band,
    percent,
    percentBasis,
    smoothness,
    smoothNote,
    task: state.task.slice(0, 160),
    elapsedSec,
    idleSec: idleSec != null ? Math.round(idleSec) : null,
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    planCoverage,
    todo: { done: doneTodos, total: state.todos.length, current: currentTodo?.content ?? null, items: state.todos.slice(0, 12) },
    toolCallCount: state.toolCalls.length,
    lastTool: state.lastTool,
    errorCount: state.errors.length,
    errors: state.errors.slice(-3).reverse(),
    usage: state.usage,
    taskTokens,
    condensed: summaryContext,
    derived: snap.derived,
    snap,
    activity: state.activity.slice(-12),
    activityText: state.activity.slice(-12).map((x) => x.action + (x.result ? ' → ' + x.result : '')).join('\n'),
    lastActivities,
    updatedAt: now,
  }
}

/* ------------------------------ session discovery ------------------------------ */

/** Find session dirs under the sessions root (root/<workspace>/<session>/). */
export function discoverSessionDirs(sessionsRoot) {
  const out = []
  if (!fs.existsSync(sessionsRoot)) return out
  for (const ws of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(sessionsRoot, ws.name)
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const log = path.join(wsDir, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(log)) {
        out.push({ dir: path.join(wsDir, s.name), log, ws: ws.name, name: s.name, mtime: fs.statSync(log).mtimeMs })
      }
    }
  }
  return out
}

/** Pick the session with the most recent activity (by last event time). */
export function pickActiveSession(sessionsRoot, explicitDir = '') {
  if (explicitDir) {
    const log = path.join(explicitDir, 'session.jsonl.zstd')
    if (!fs.existsSync(log)) return null
    return { dir: explicitDir, log, ws: '', name: path.basename(explicitDir), mtime: 0 }
  }
  let best = null
  let bestTime = -1
  for (const s of discoverSessionDirs(sessionsRoot)) {
    const events = decodeSessionLog(s.log)
    let last = s.mtime
    for (const e of events) if (typeof e.time === 'number' && e.time > last) last = e.time
    if (last > bestTime) { bestTime = last; best = s }
  }
  return best
}

/* ------------------------------ dashboard server ------------------------------ */

export function loadConfig(configPath) {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  return {
    port: raw.port ?? 3278,
    sessionsRoot: raw.sessionsRoot ?? path.join(os.homedir(), '.dsh', 'sessions'),
    sessionDir: raw.sessionDir ?? '',
    pollMs: raw.pollMs ?? 2000,
    stallSeconds: raw.stallSeconds ?? 60,
    judge: raw.judge ?? { enabled: false },
  }
}

export function startServer(config = {}) {
  const { port = 3278, sessionsRoot, sessionDir, stallSeconds = 60 } = config
  let lastAssessment = null
  let lastError = null

  const refresh = () => {
    try {
      const picked = pickActiveSession(sessionsRoot, sessionDir)
      if (!picked) { lastAssessment = { ok: false, status: 'no-session', error: '未找到会话日志' }; return }
      const events = decodeSessionLog(picked.log)
      const a = evaluateSession(events, Date.now())
      a.sessionLabel = picked.name
      lastAssessment = a
    } catch (err) {
      lastError = err.message
      lastAssessment = { ok: false, status: 'error', error: lastError }
    }
  }
  refresh()
  const timer = setInterval(refresh, config.pollMs ?? 2000)
  timer.unref?.()

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]
    if (url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ...lastAssessment, stallSeconds }))
      return
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(DASHBOARD_HTML)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  server.on('error', (err) => console.error(`[dsh-session-progress] dashboard error: ${err.message}`))
  server.listen(port, '127.0.0.1')

  return {
    server,
    refresh,
    status: () => lastAssessment,
    close() {
      return new Promise((resolve) => {
        clearInterval(timer)
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}

/* --------------------------------- CLI main --------------------------------- */

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const configPath = process.argv[2] ?? path.join(here, 'config.json')
  const config = loadConfig(configPath)
  const app = startServer(config)
  console.log(`[dsh-session-progress] dashboard: http://127.0.0.1:${config.port}  (independent session-task evaluator)`)
  console.log(`[dsh-session-progress] sessions root: ${config.sessionsRoot}${config.sessionDir ? ` (explicit: ${config.sessionDir})` : ' (auto: newest activity)'}`)
  process.on('SIGINT', () => { app.close().then(() => process.exit(0)) })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

/* ------------------------------ dashboard html ------------------------------ */

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话进度 · dsh-session-progress</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b1020; color: #e8ecf4; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 24px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 16px; color: #7aa2ff; margin-bottom: 4px; }
  .sub { color: #7b8499; font-size: 12px; margin-bottom: 20px; }
  .panel { background: #141a2e; border: 1px solid #232c47; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .panel-title { font-size: 11px; color: #7b8499; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  .stage-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 13px; font-weight: 700; color: #0b0d10; }
  .mode { color: #c9d4ea; font-size: 13px; }
  .range { color: #7b8499; font-size: 13px; }
  .bar { height: 12px; background: #1c2333; border-radius: 999px; overflow: hidden; margin: 12px 0 6px; position: relative; }
  .bar > #band { position: absolute; top: 0; bottom: 0; border-radius: 999px; opacity: .4; }
  .bar > #fill { height: 100%; border-radius: 999px; transition: width .5s ease, background .4s; }
  .hint { color: #6b7280; font-size: 12px; }
  ul.todos { list-style: none; }
  ul.todos li { padding: 2px 0; color: #aab3c9; font-size: 13px; }
  ul.todos li.done { color: #58e08a; }
  ul.todos li.current { color: #f0e68c; }
  .ev { color: #aab3c9; font-size: 13px; }
  .ev b { color: #e8ecf4; }
  .act { font-size: 12px; color: #7b8499; font-family: Consolas, monospace; margin-top: 4px; }
  .health-badge { display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .h-normal { background: #123d24; color: #58e08a; }
  .h-attention { background: #3d2a12; color: #f0a050; }
  .h-problem { background: #3d1216; color: #ff6b6b; }
  .h-stalled { background: #3d2a12; color: #f0a050; }
  .err { color: #ff6b6b; font-size: 12px; font-family: Consolas, monospace; margin-top: 4px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #58e08a; margin-right: 6px; animation: pulse 1.2s infinite; vertical-align: 1px; }
  @keyframes pulse { 50% { opacity: .3; } }
</style>
</head>
<body>
  <h1><span class="dot"></span>会话任务进度</h1>
  <div class="sub" id="status">连接中…</div>

  <div class="panel">
    <div class="panel-title">阶段 · Stage</div>
    <div class="stage-row">
      <span class="badge" id="badge">—</span>
      <span class="mode" id="mode"></span>
      <span class="range" id="range"></span>
    </div>
    <div class="bar"><div id="band"></div><div id="fill" style="width:0%"></div></div>
    <div class="hint" id="stageHint"></div>
  </div>

  <div class="panel">
    <div class="panel-title">计划 · Plan</div>
    <div id="plan"></div>
  </div>

  <div class="panel">
    <div class="panel-title">证据 · Evidence</div>
    <div class="ev" id="evidence"></div>
    <div id="activity"></div>
  </div>

  <div class="panel">
    <div class="panel-title">健康 · Health</div>
    <div id="health"></div>
    <div id="errors"></div>
  </div>
<script>
const STAGE = { planned:'规划', executing:'执行中', first_output:'初见产出', integrating:'整合中', validating:'验证中', ready:'可交付', 'no-data':'无数据' }
const STAGE_COLOR = { planned:'#9aa4b2', executing:'#4a90d9', first_output:'#2bb3a3', integrating:'#8b5cf6', validating:'#e6a23c', ready:'#22c55e', 'no-data':'#7b8499' }
const MODE = { exploring:'探索', executing:'执行', rework:'返工', validating:'验证', delivering:'交付' }
const SMOOTH = { normal:['h-normal','正常'], attention:['h-attention','注意'], problem:['h-problem','有问题'], stalled:['h-stalled','停滞'] }
async function tick() {
  try {
    const s = await (await fetch('/api/status')).json()
    document.getElementById('status').innerHTML = '实时 · ' + new Date().toLocaleTimeString() + (s.sessionLabel ? ' · ' + s.sessionLabel : '')
    if (!s.ok) { document.getElementById('plan').textContent = s.error || '无数据'; return }
    const c = STAGE_COLOR[s.stage] || '#7b8499'

    // --- Stage ---
    const b = document.getElementById('badge')
    b.textContent = STAGE[s.stage] || s.stage
    b.style.background = c
    document.getElementById('mode').textContent = MODE[s.mode] || s.mode || ''
    const bandEl = document.getElementById('band')
    if (s.band) {
      bandEl.style.left = s.band[0] + '%'
      bandEl.style.width = (s.band[1] - s.band[0]) + '%'
      bandEl.style.background = c
      document.getElementById('range').textContent = '区间 ' + s.band[0] + '–' + s.band[1] + '%'
    } else {
      bandEl.style.width = '0%'
      document.getElementById('range').textContent = ''
    }
    const f = document.getElementById('fill')
    f.style.width = (s.percent ?? 0) + '%'
    f.style.background = c
    const hintParts = []
    if (s.percentBasis === 'completed') hintParts.push('已完成（终端状态）')
    else if (s.percentBasis === 'model') hintParts.push('模型中心估计 ~' + s.percent + '%（仅供参考，±约 19pp）')
    else hintParts.push('规则估计 ' + s.percent + '%')
    hintParts.push('区间为前缀事实')
    document.getElementById('stageHint').textContent = hintParts.join(' · ')

    // --- Plan ---
    const plan = document.getElementById('plan')
    plan.innerHTML = ''
    if (s.todo && s.todo.total > 0) {
      const ul = document.createElement('ul'); ul.className = 'todos'
      const done = (s.todo.items || []).filter((t) => t.status === 'completed')
      const rest = (s.todo.items || []).filter((t) => t.status !== 'completed')
      for (const it of s.todo.items) {
        const li = document.createElement('li')
        li.className = it.status === 'completed' ? 'done' : (it.content === s.todo.current ? 'current' : '')
        li.textContent = (it.status === 'completed' ? '✓ ' : '○ ') + it.content
        ul.appendChild(li)
      }
      plan.appendChild(ul)
      const sum = document.createElement('div')
      sum.className = 'hint'
      sum.textContent = '已完成 ' + done.length + ' · 当前已知剩余 ' + rest.length + ' 项（清单可被 agent 动态修订，非真实总规模）'
      plan.appendChild(sum)
    } else {
      const p = document.createElement('div'); p.className = 'hint'
      p.textContent = '无显式计划（agent 未维护 todo 清单）。有 todo 时才能给出可辩护的精确百分比。'
      plan.appendChild(p)
    }

    // --- Evidence ---
    const d = s.derived || {}
    const ev = document.getElementById('evidence')
    const evParts = []
    if (d.writes_succeeded > 0) evParts.push('已写 <b>' + d.writes_succeeded + '</b> 文件')
    if (d.tests_run > 0) evParts.push(d.tests_failed === 0 ? '测试通过 <b>' + d.tests_run + '</b> 次' : '测试 <b>' + d.tests_failed + '</b> 失败 / ' + d.tests_run + ' 次')
    evParts.push('已做 <b>' + (s.stepCount ?? 0) + '</b> 步 · <b>' + (s.toolCallCount ?? 0) + '</b> 次工具调用')
    ev.innerHTML = evParts.join(' · ')
    const act = document.getElementById('activity')
    act.innerHTML = ''
    const acts = (s.activity || []).slice(-3)
    for (const a of acts) {
      const div = document.createElement('div'); div.className = 'act'
      div.textContent = '· ' + (a.action || '') + (a.result ? ' → ' + a.result : '')
      act.appendChild(div)
    }

    // --- Health ---
    const h = document.getElementById('health')
    h.innerHTML = ''
    const [hc, hl] = SMOOTH[s.smoothness] || ['h-normal', s.smoothness]
    const hb = document.createElement('span'); hb.className = 'health-badge ' + hc; hb.textContent = hl
    h.appendChild(hb)
    if (s.smoothNote) {
      const n = document.createElement('span'); n.style.cssText = 'color:#7b8499;font-size:12px;margin-left:8px'; n.textContent = s.smoothNote
      h.appendChild(n)
    }
    const errs = document.getElementById('errors')
    errs.innerHTML = ''
    for (const e of (s.errors || []).slice(0, 2)) {
      const div = document.createElement('div'); div.className = 'err'
      div.textContent = '[' + (e.name || '?') + '] ' + (e.snippet || '').slice(0, 120)
      errs.appendChild(div)
    }
  } catch (err) {
    document.getElementById('status').innerHTML = '<span style="color:#ff6b6b">面板未连接 — 确认服务正在运行</span>'
  }
}
tick()
setInterval(tick, 2000)
</script>
</body>
</html>`
