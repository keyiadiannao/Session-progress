/**
 * test.mjs - tests for the facts-based progress state machine (v2).
 *   node test.mjs
 *
 * Covers the P0 fixes:
 *   - a FAILED write must NOT trigger first_output;
 *   - artifacts are deduped by path (two writes of one file != integrating);
 *   - any .md file alone does NOT mean ready (needs ready_to_deliver evidence);
 *   - validation is episode-based: fail-then-pass still reaches validating,
 *     and a later failure drops MODE to rework but does NOT regress STAGE.
 */
import { evaluateSession, scanZstdFrames, decodeSessionLog } from './index.mjs'
import { stageFromFacts, modeFromFacts, stageIndex, maxStage } from './stage-rule.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!cond) failures++
}

// ================================================================ stage-rule unit
console.log('--- stageFromFacts / modeFromFacts ---')
const baseFacts = { toolCallsTotal: 1, artifactCount: 0, artifactModified: false, validationPassedOnce: false, validationStale: false, validationJustFailed: false, validationInProgress: false, readyClaim: false, todoRatio: null, recentErrors: 0, lastToolCategory: 'inspect' }
check('no facts -> planned', stageFromFacts({ ...baseFacts, toolCallsTotal: 0 }) === 'planned')
check('tools only -> executing', stageFromFacts(baseFacts) === 'executing')
check('1 artifact -> first_output', stageFromFacts({ ...baseFacts, artifactCount: 1 }) === 'first_output')
check('2 distinct artifacts (no modification) -> still first_output', stageFromFacts({ ...baseFacts, artifactCount: 2 }) === 'first_output')
check('artifactModified -> integrating', stageFromFacts({ ...baseFacts, artifactModified: true, artifactCount: 1 }) === 'integrating')
check('validation passed once -> validating', stageFromFacts({ ...baseFacts, validationPassedOnce: true }) === 'validating')
check('validation stale -> NOT validating', stageFromFacts({ ...baseFacts, validationPassedOnce: true, validationStale: true }) !== 'validating')
check('todoRatio 0.6 with 0 artifacts -> NOT integrating', stageFromFacts({ ...baseFacts, todoRatio: 0.6, artifactCount: 0 }) === 'executing')
check('readyClaim alone (no artifact) -> NOT ready', stageFromFacts({ ...baseFacts, readyClaim: true, artifactCount: 0 }) !== 'ready')
check('readyClaim + artifact + no blocker -> ready', stageFromFacts({ ...baseFacts, readyClaim: true, artifactCount: 1, recentErrors: 0 }) === 'ready')
check('readyClaim + artifact + recent error -> NOT ready', stageFromFacts({ ...baseFacts, readyClaim: true, artifactCount: 1, recentErrors: 1 }) !== 'ready')
check('stage order planned < ... < ready', stageIndex('planned') < stageIndex('first_output') && stageIndex('validating') < stageIndex('ready'))
check('maxStage keeps higher', maxStage('validating', 'integrating') === 'validating')

check('mode: validation just failed -> rework', modeFromFacts({ ...baseFacts, validationPassedOnce: true, validationJustFailed: true }) === 'rework')
check('mode: test in progress -> validating', modeFromFacts({ ...baseFacts, validationInProgress: true, lastToolCategory: 'run' }) === 'validating')
check('mode: ready -> delivering', modeFromFacts({ ...baseFacts, readyClaim: true, artifactCount: 1, recentErrors: 0 }) === 'delivering')
check('mode: recent errors >=2 -> rework', modeFromFacts({ ...baseFacts, recentErrors: 2 }) === 'rework')

// ================================================================ evaluateSession
console.log('--- evaluateSession (integration) ---')
const t0 = Date.now() - 120_000
const mk = (type, time, data) => ({ type, time: t0 + time, data })

// helper: a write tool call/result pair (success or failure)
function writePair(t, file, success) {
  return [
    mk('tool/call', t, { name: 'write', arguments: { file_path: file, content: 'x' } }),
    mk('tool/result', t + 1, { message: { content: [{ type: 'text', text: success ? 'Wrote file' : 'Error: EPERM write failed' }] } }),
  ]
}
// helper: a test run pair (passed or failed)
function testPair(t, passed) {
  return [
    mk('tool/call', t, { name: 'pwsh', arguments: { command: 'pytest -q' } }),
    mk('tool/result', t + 1, { message: { content: [{ type: 'text', text: passed ? '3 passed' : '1 failed, 2 passed' }] } }),
  ]
}

// --- P0: failed write must NOT produce first_output ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '写个文件' }),
    ...writePair(10, '/x/a.py', false), // failed write
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('failed write -> still executing (not first_output)', a.stage === 'executing', a.stage)
  check('failed write -> artifactCount 0', a.derived.produced_artifact === false)
}

// --- P0: successful write -> first_output; same path twice -> integrating (modify) ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '写文件' }),
    ...writePair(10, '/x/a.py', true),
    ...writePair(20, '/x/a.py', true), // same path again -> MODIFY -> integrating
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('first write -> first_output', evaluateSession(ev.slice(0, 4), t0 + 2000).stage === 'first_output')
  check('same path written twice -> integrating (modify, not dedup-invisible)', a.stage === 'integrating', a.stage)
}

// --- P0: two DISTINCT writes -> first_output (not integrating) ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '写两个文件' }),
    ...writePair(10, '/x/a.py', true),
    ...writePair(20, '/x/b.py', true),
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('two distinct artifacts -> first_output (not integrating)', a.stage === 'first_output', a.stage)
}

// --- P0: any .md alone does NOT mean ready ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '写个文档' }),
    ...writePair(10, '/x/DESIGN.md', true), // a .md file, but no delivery evidence
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('writing DESIGN.md alone -> first_output (not ready)', a.stage === 'first_output', a.stage)
}

// --- P0: ready_to_deliver claim -> ready ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '做完了' }),
    ...writePair(10, '/x/a.py', true),
    mk('assistant/message', 30, { message: { content: [{ type: 'text', text: '已完成，准备交付。' }] } }),
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('ready_to_deliver claim -> ready', a.stage === 'ready', a.stage)
}

// --- P0: validation episode (fail then pass still reaches validating) ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '跑测试' }),
    ...testPair(10, false), // first run: failed
    ...testPair(20, true),  // second run: passed
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('fail-then-pass -> validating (episode, not cumulative)', a.stage === 'validating', a.stage)
}

// --- P0: stage does NOT regress after a later failure; mode goes rework ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '跑测试' }),
    ...testPair(10, true),   // passed -> validating
    ...testPair(20, false),  // then failed -> mode rework, stage stays validating
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('stage stays validating after later failure', a.stage === 'validating', a.stage)
  check('mode = rework after later failure', a.mode === 'rework', a.mode)
}

// --- P0: validation goes stale after artifact modification (mode, not stage) ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '改代码 + 测试' }),
    ...writePair(10, '/x/a.py', true),   // artifact revision 1
    ...testPair(20, true),               // pass -> validating (bound to rev 1)
    ...writePair(30, '/x/a.py', true),   // modify -> rev 2, validation stale
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('pass then modify -> stage drops off validating (stale, back to integrating)', a.stage === 'integrating', a.stage)
  check('pass then modify -> mode = rework (stale)', a.mode === 'rework', a.mode)
}

// --- P0: pass then modify then re-pass -> validating again (fresh) ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '改代码 + 测试' }),
    ...writePair(10, '/x/a.py', true),
    ...testPair(20, true),
    ...writePair(30, '/x/a.py', true),   // stale
    ...testPair(40, true),               // re-validate current rev -> fresh again
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('re-validate after modify -> mode not rework (fresh again)', a.mode !== 'rework', a.mode)
}

// --- basic status/task/todo/errors/usage still work ---
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '写进度工具并测试' }),
    mk('todo/write', 2, { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }),
    mk('tool/call', 10, { name: 'pwsh', arguments: '{}' }),
    mk('tool/result', 11, { message: { content: [{ type: 'text', text: 'Error: EPERM' }] } }),
    mk('assistant/message', 30, { usage: { inputTokens: 100, outputTokens: 50 }, message: { content: [{ type: 'text', text: 'ok' }] } }),
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('status running', a.status === 'running', a.status)
  check('task captured', a.task.includes('进度工具'))
  check('todo 1/2 done', a.todo.done === 1 && a.todo.total === 2, `${a.todo.done}/${a.todo.total}`)
  check('error detected', a.errorCount === 1)
  check('usage summed', a.usage.inputTokens === 100 && a.usage.outputTokens === 50)
}

// completed turn -> ready + percent 100
{
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: '完成' }),
    mk('turn/end', 100, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const a = evaluateSession(ev, t0 + 2000)
  check('completed turn -> status completed', a.status === 'completed')
  check('completed turn -> percent 100', a.percent === 100)
}

// ================================================================ zstd round-trip
console.log('--- zstd frame round-trip ---')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-progress-'))
  const logPath = path.join(tmp, 'session.jsonl.zstd')
  const ev = [
    mk('turn/start', 0, { turn: 1 }),
    mk('user/message', 1, { content: 'hi' }),
  ]
  fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(ev.map((e) => JSON.stringify(e)).join('\n'))))
  const decoded = decodeSessionLog(logPath)
  check('decode round-trip preserves events', decoded.length === ev.length, `${decoded.length}`)
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
