/**
 * Standalone test for dsh-session-progress (no harness needed).
 *   node test.mjs
 */
import { evaluateSession, scanZstdFrames, decodeSessionLog, judgeAllowed, estimateCondensedTokens } from './index.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!cond) failures++
}

// ---- evaluateSession on a synthetic conversation ----
const t0 = Date.now() - 120_000
const events = [
  { type: 'session', time: t0 },
  { type: 'turn/start', time: t0 + 100, data: { turn: 1 } },
  { type: 'user/message', time: t0 + 200, data: { content: '写一个进度评估工具并测试' } },
  { type: 'step/start', time: t0 + 300, data: { turn: 1, step: 1 } },
  { type: 'todo/write', time: t0 + 400, data: { todos: [
    { content: '设计评估逻辑', status: 'completed' },
    { content: '实现解码', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ] } },
  { type: 'tool/call', time: t0 + 500, data: { name: 'pwsh', arguments: '{}' } },
  { type: 'tool/result', time: t0 + 600, data: { message: { content: [{ type: 'text', text: '启动失败: Error: EPERM operation not permitted' }] } } },
  { type: 'tool/call', time: t0 + 700, data: { name: 'write', arguments: '{}' } },
  { type: 'tool/result', time: t0 + 800, data: { message: { content: [{ type: 'text', text: 'Created file' }] } } },
  { type: 'assistant/message', time: t0 + 900, data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, reasoningTokens: 10 } } },
]

const a = evaluateSession(events, t0 + 2000) // last event at t0+900 -> idle ~1.1s -> running
check('status running (turn open)', a.status === 'running', a.status)
check('task captured', a.task.includes('进度评估'))
check('todo 1/3 done', a.todo.done === 1 && a.todo.total === 3, `${a.todo.done}/${a.todo.total}`)
check('current todo is in_progress item', a.todo.current && a.todo.current.includes('解码'))
check('tool calls counted', a.toolCallCount === 2)
check('error detected (EPERM)', a.errorCount === 1, `${a.errorCount}`)
check('smoothness attention', a.smoothness === 'attention', a.smoothness)
check('usage summed', a.usage.inputTokens === 100 && a.usage.outputTokens === 50 && a.usage.cacheReadTokens === 200)

// completed turn
const done = evaluateSession(events.concat([{ type: 'turn/end', time: t0 + 1000, data: { turn: 1, reason: { kind: 'completed' } } }]), t0 + 2000)
check('status completed after turn/end', done.status === 'completed', done.status)

// interrupted turn
const intr = evaluateSession(events.concat([{ type: 'turn/end', time: t0 + 1000, data: { turn: 1, reason: { kind: 'interrupted' } } }]), t0 + 2000)
check('status ended:interrupted', intr.status === 'ended:interrupted', intr.status)

// stall: turn open but idle > 60s
const stalled = evaluateSession(events, t0 + 240_000)
check('status stalled when idle > 60s', stalled.status === 'stalled', stalled.status)

// no data
const empty = evaluateSession([], t0)
check('empty events -> no-data', empty.status === 'no-data')

// tightened pattern: "-TimeoutSec" must NOT flag; "FAILED" must flag
const loose = evaluateSession([
  { type: 'tool/result', time: t0 + 5000, data: { message: { content: [{ type: 'text', text: 'All good, used -TimeoutSec 5, no issues' }] } } },
  { type: 'tool/result', time: t0 + 6000, data: { message: { content: [{ type: 'text', text: '3 TEST(S) FAILED' }] } } },
], t0 + 7000)
check('pattern: -TimeoutSec not flagged, FAILED flagged', loose.errorCount === 1, `${loose.errorCount}`)

// ---- plan coverage + stage ----
check('plan coverage 33% (1/3, agent-todo basis)', a.planCoverage && a.planCoverage.percent === 33 && a.planCoverage.basis === 'agent-todo', JSON.stringify(a.planCoverage))
check('stage executing with tools running', a.stage === 'executing', a.stage)
const finishing = evaluateSession(events.concat([{ type: 'tool/call', time: t0 + 1500, data: { name: 'x' } }]).map((e) => e.type === 'todo/write' ? { ...e, data: { todos: e.data.todos.map((t) => ({ ...t, status: 'completed' })) } } : e), t0 + 2000)
check('stage finishing when plan >=90% done', finishing.stage === 'finishing', finishing.stage)
const noTodo = evaluateSession(events.filter((e) => e.type !== 'todo/write'), t0 + 2000)
check('plan coverage null without todos', noTodo.planCoverage === null, JSON.stringify(noTodo.planCoverage))
check('stage executing without todos', noTodo.stage === 'executing', noTodo.stage)

// ---- judge budget math ----
const g1 = judgeAllowed(0, 800, 100_000, 0.02)
check('judge allowed within 2%', g1.allowed && g1.budget === 2000, JSON.stringify(g1))
const g2 = judgeAllowed(1999, 800, 100_000, 0.02)
check('judge denied when spend+est exceeds budget', !g2.allowed && g2.reason === 'budget', JSON.stringify(g2))
const g3 = judgeAllowed(0, 800, 10_000, 0.02)
check('judge denied when task too small (budget 200 < est)', !g3.allowed, JSON.stringify(g3))
const g4 = judgeAllowed(500, 400, 50_000, 0.02)
check('judge budget pct reported', g4.budgetPct === 90, `${g4.budgetPct}`)
check('condensed estimate positive & small', (() => { const t = estimateCondensedTokens({ task: 'x'.repeat(2000), plan: [] }); return t > 100 && t < 1200 })(), `${estimateCondensedTokens({ task: 'x'.repeat(2000), plan: [] })}`)

// ---- zstd frame round-trip (scan + decode a real compressed file) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-progress-'))
const logPath = path.join(tmp, 'session.jsonl.zstd')
const lines = events.map((e) => JSON.stringify(e)).join('\n')
fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(lines)))
const decoded = decodeSessionLog(logPath)
check('decode round-trip preserves events', decoded.length === events.length, `${decoded.length}`)
fs.rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
