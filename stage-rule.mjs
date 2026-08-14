/**
 * stage-rule.mjs - prefix-only progress stage + activity-mode rule (v3).
 *
 * The single source of truth for the stage rule, shared by:
 *   - index.mjs  (live dashboard: classify the current session)
 *   - demo.mjs   (historical replay)
 *
 * Every condition reads PREFIX facts only (<= t): no future info, no percent
 * guess.  Mirrors label-prefix.py exactly.
 *
 * A snapshot-like object has:
 *   derived  {tests_run, tests_failed, writes_succeeded, produced_artifact,
 *             todo_done, todo_total, tool_calls_total, recent_errors}
 *   observations {files:[{path}], visible_claims:[{type}], tool_calls:[{category,args_summary}]}
 *   interpretation {milestones:[{type}]}
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
export const MODE_CN = { exploring: '探索', executing: '执行', rework: '返工', validating: '验证', delivering: '交付' }

export function hasReport(s) {
  const files = s.observations?.files || []
  const claims = s.observations?.visible_claims || []
  return files.some((f) => /\.(md|tex)$/i.test(f.path || '') || /readme/i.test(f.path || ''))
    || claims.some((c) => c.type === 'ready_to_deliver')
}

export function stagePrefix(s) {
  const d = s.derived || {}
  const files = s.observations?.files || []
  const ms = (s.interpretation?.milestones || []).map((m) => m.type)
  if (hasReport(s)) return 'ready'
  const testsPass = (d.tests_run >= 1 && d.tests_failed === 0) || ms.includes('validation_passed')
  if (testsPass) return 'validating'
  const todoRatio = d.todo_total ? d.todo_done / d.todo_total : 0
  if (files.length >= 2 || (d.writes_succeeded || 0) >= 2 || todoRatio >= 0.6) return 'integrating'
  if (d.produced_artifact || (d.writes_succeeded || 0) >= 1 || files.length >= 1) return 'first_output'
  if ((d.tool_calls_total || 0) > 0) return 'executing'
  return 'planned'
}

export function modePrefix(s) {
  const d = s.derived || {}
  const calls = s.observations?.tool_calls || []
  const last = calls[calls.length - 1]
  const lastTool = last?.category || null
  if ((d.recent_errors || 0) >= 2) return 'rework'
  if (lastTool === 'run' && (/test/i.test(last?.args_summary || '') || (d.tests_run || 0) >= 1)) return 'validating'
  if (lastTool === 'report' || hasReport(s)) return 'delivering'
  if (d.produced_artifact && lastTool === 'write') return 'executing'
  if ((d.tool_calls_total || 0) > 0 && !d.produced_artifact) return 'exploring'
  return 'executing'
}
