/**
 * stage-rule.mjs - facts-based progress state rule (v2).
 *
 * Stage and mode are computed from SEMANTIC FACTS, not raw counters.  Decisive
 * changes vs the v1 snapshot-based rule:
 *   - `ready`      requires explicit delivery evidence (ready_to_deliver claim or
 *                  a delivered turn), NOT just any .md/.tex file.
 *   - `validating` requires that a validation episode PASSED AT LEAST ONCE
 *                  (monotonic), NOT that all accumulated test runs passed.
 *   - `first_output` / `integrating` count DISTINCT successfully-created
 *                  artifacts, not raw write attempts.
 *
 * `stageFromFacts` is a pure function; monotonicity (stage never regresses) is
 * the caller's job (index.mjs keeps the max stage seen so far).  `modeFromFacts`
 * reflects what is happening RIGHT NOW (may oscillate rework <-> validating).
 *
 * facts shape (produced by index.mjs evaluateSession):
 * {
 *   toolCallsTotal: number,
 *   artifactCount: number,           // distinct successful artifacts
 *   validationPassedOnce: boolean,   // any episode ever passed
 *   validationJustFailed: boolean,   // most recent episode failed
 *   validationInProgress: boolean,   // last tool is a test run
 *   readyEvidence: boolean,          // ready_to_deliver claim OR delivered turn
 *   todoRatio: number|null,          // plan completion ratio (0..1) or null
 *   recentErrors: number,            // errors in the last few tool results
 *   lastToolCategory: string|null,
 * }
 */

export const BAND = {
  planned: [10, 25], executing: [25, 45], first_output: [45, 65],
  integrating: [65, 80], validating: [80, 92], ready: [92, 99],
}
export const STAGE_COLOR = {
  planned: '#9aa4b2', executing: '#4a90d9', first_output: '#2bb3a3',
  integrating: '#8b5cf6', validating: '#e6a23c', ready: '#22c55e',
}
export const STAGE_CN = {
  planned: '规划', executing: '执行中', first_output: '初见产出',
  integrating: '整合中', validating: '验证中', ready: '可交付',
}
export const MODE_CN = { exploring: '探索', executing: '执行', rework: '返工', validating: '验证', delivering: '交付', idle: '空闲' }

const STAGE_ORDER = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']

/** Ordinal index of a stage (for monotonic max). */
export function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? 0 : i
}

/** Highest stage among two, by monotonic order. */
export function maxStage(a, b) {
  return stageIndex(a) >= stageIndex(b) ? a : b
}

/** progress_stage from facts (what maturity has been GENUINELY reached). */
export function stageFromFacts(f) {
  if (f.readyEvidence) return 'ready'
  if (f.validationPassedOnce) return 'validating'
  if (f.artifactCount >= 2 || (f.todoRatio != null && f.todoRatio >= 0.6)) return 'integrating'
  if (f.artifactCount >= 1) return 'first_output'
  if (f.toolCallsTotal > 0) return 'executing'
  return 'planned'
}

/** activity_mode from facts (what is happening AT this moment). */
export function modeFromFacts(f) {
  if (f.validationJustFailed || f.recentErrors >= 2) return 'rework'
  if (f.validationInProgress) return 'validating'
  if (f.readyEvidence || f.lastToolCategory === 'report') return 'delivering'
  if (f.artifactCount > 0 && f.lastToolCategory === 'write') return 'executing'
  if (f.toolCallsTotal > 0) return 'exploring'
  return 'idle'
}
