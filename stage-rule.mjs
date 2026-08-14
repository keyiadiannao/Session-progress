/**
 * stage-rule.mjs - facts-based progress state rule (v3).
 *
 * Stage and mode are computed from SEMANTIC FACTS.  Key invariants (Sprint 2):
 *
 *   - `integrating` requires >= 2 DISTINCT artifacts (or explicit assembly
 *     evidence).  A todo ratio >= 0.6 is ONLY within-stage evidence, it never
 *     promotes the milestone (a plan can be 60% done with zero artifacts).
 *   - `validating` requires that validation PASSED AND the validated artifact
 *     revision is still CURRENT (validationStale == false).  Once the artifact
 *     is modified after a pass, validation evidence goes stale.
 *   - `ready` is a CONJUNCTION, not a bare claim: ready_claim (a visible claim,
 *     not a fact) AND >= 1 artifact AND no unresolved blocker AND (when
 *     validation applies) the current candidate validated.
 *
 * `stageFromFacts` is pure; monotonicity is NOT enforced here.  In practice the
 * validating branch stays latched via validationPassedOnce, but validationStale
 * and the ready conjunction can legitimately lower a stage — intentional, see
 * DESIGN.md §20.
 *
 * facts shape (produced by index.mjs evaluateSession):
 * {
 *   toolCallsTotal, artifactCount,           // distinct successful artifacts
 *   validationPassedOnce,                    // any episode ever passed (monotonic)
 *   validationStale,                         // artifact modified after last pass
 *   validationJustFailed, validationInProgress,
 *   readyClaim,                              // ready_to_deliver claim (a CLAIM)
 *   todoRatio,                               // evidence only, never a milestone
 *   recentErrors, lastToolCategory,
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

export function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  return i === -1 ? 0 : i
}
export function maxStage(a, b) {
  return stageIndex(a) >= stageIndex(b) ? a : b
}

/**
 * ready is an evidence CONJUNCTION, not a claim.  A visible "准备交付" alone is
 * a claim and must be corroborated by artifacts + no blocker + fresh validation.
 */
export function readyEvidence(f) {
  return Boolean(
    f.readyClaim &&
    f.artifactCount >= 1 &&
    !f.validationStale &&
    !f.validationJustFailed &&
    f.recentErrors === 0
  )
}

/** progress_stage from facts (what maturity has been GENUINELY reached). */
export function stageFromFacts(f) {
  if (readyEvidence(f)) return 'ready'
  // validating is MONOTONIC: once any validation episode passed, the stage stays
  // validating; a later artifact modification is expressed via mode=rework (and
  // validationStale flag), NOT by regressing the stage.
  if (f.validationPassedOnce) return 'validating'
  if (f.artifactCount >= 2) return 'integrating'
  if (f.artifactCount >= 1) return 'first_output'
  if (f.toolCallsTotal > 0) return 'executing'
  return 'planned'
}

/** activity_mode from facts (what is happening AT this moment). */
export function modeFromFacts(f) {
  if (f.validationStale || f.validationJustFailed || f.recentErrors >= 2) return 'rework'
  if (f.validationInProgress) return 'validating'
  if (readyEvidence(f) || f.lastToolCategory === 'report') return 'delivering'
  if (f.artifactCount > 0 && f.lastToolCategory === 'write') return 'executing'
  if (f.toolCallsTotal > 0) return 'exploring'
  return 'idle'
}
