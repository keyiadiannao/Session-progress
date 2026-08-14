/**
 * replay-eval.mjs - replay real sessions through the NEW facts-based state
 * machine and measure the metrics the review asked for (NOT MAE):
 *
 *   stage regression rate   - how often progress_stage goes BACKWARD
 *   stage oscillation       - validating -> integrating -> validating flapping
 *   false ready rate        - ready reached while substantial work remains
 *   stage transition histogram
 *
 * Usage: node replay-eval.mjs [sessionsRoot]
 */
import { discoverSessionDirs, decodeSessionLog, evaluateSession } from './index.mjs'
import { stageIndex } from './stage-rule.mjs'
import path from 'node:path'
import os from 'node:os'

const root = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')
const sessions = discoverSessionDirs(root)
console.log(`replaying ${sessions.length} sessions from ${root}\n`)

let totalSamples = 0
let regressions = 0
let oscillations = 0
let falseReady = 0
let readyCount = 0
const transition = {}

for (const s of sessions) {
  const events = decodeSessionLog(s.log)
  if (events.length < 3) continue
  // sample stage every K events (prefix replay)
  const K = Math.max(1, Math.floor(events.length / 30))
  const stages = []
  for (let i = 0; i < events.length; i += K) {
    const a = evaluateSession(events.slice(0, i + 1), Date.now())
    stages.push({ idx: i, stage: a.stage, mode: a.mode, toolCalls: a.toolCallCount })
  }
  // final stage at full log
  const fin = evaluateSession(events, Date.now())
  stages.push({ idx: events.length, stage: fin.stage, mode: fin.mode, toolCalls: fin.toolCallCount })

  totalSamples += stages.length
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1], cur = stages[i]
    if (prev.stage === 'no-data' || cur.stage === 'no-data') continue
    const key = `${prev.stage}->${cur.stage}`
    transition[key] = (transition[key] || 0) + 1
    // regression: stage index goes backward
    if (stageIndex(cur.stage) < stageIndex(prev.stage)) regressions++
    // oscillation: leave validating then come back (validating -> X -> validating)
    if (i >= 2 && stages[i - 2].stage === 'validating' && prev.stage !== 'validating' && cur.stage === 'validating') oscillations++
  }
  // false ready: reached ready, but > 30% of the session's tool calls come AFTER
  const readyIdx = stages.find((x) => x.stage === 'ready')
  if (readyIdx) {
    readyCount++
    const callsAfter = fin.toolCallCount - readyIdx.toolCalls
    if (callsAfter > 0.3 * Math.max(1, fin.toolCallCount)) falseReady++
  }
}

console.log('=== stage transition histogram (top 12) ===')
for (const [k, v] of Object.entries(transition).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${k.padEnd(26)} ${v}`)
}
console.log()
console.log('=== metrics ===')
console.log(`  samples sampled               : ${totalSamples}`)
console.log(`  stage regressions             : ${regressions}  (${(100 * regressions / Math.max(1, totalSamples)).toFixed(1)}%)`)
console.log(`  validating oscillations       : ${oscillations}`)
console.log(`  sessions reaching ready       : ${readyCount}`)
console.log(`  false ready (>30% calls after): ${falseReady}`)
