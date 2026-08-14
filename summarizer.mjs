/**
 * summarizer.mjs - SEMANTIC progress summary layer (the "current percent" channel).
 *
 * Split from the stage rule on purpose:
 *   - stage        = pure rule over prefix facts (stage-rule.mjs)   [zero LLM]
 *   - percent      = LLM estimates the CURRENT completion % from the
 *                    task + plan + recent activity log              [every N steps]
 *
 * The % is an ESTIMATE, anchored to the plan/todo when present and conservative
 * otherwise.  The LLM must NOT predict the future - it restates what the prefix
 * activity shows.  `llm` is injected (deepseek-v4-flash via llm.mjs); when absent,
 * fallbackSummary() returns a deterministic % + template line at zero cost.
 */

// stage -> band midpoint, used when there is no plan to anchor on
const MID = { planned: 18, executing: 35, first_output: 55, integrating: 72, validating: 86, ready: 96, 'no-data': 0 }

/**
 * Assemble the prefix-only context handed to the LLM.
 * @param {object} snap   snapshot-like {task, observations:{activityText}, derived}
 * @param {number} maxLines  cap on activity lines fed to the model
 */
export function buildContext(snap, maxLines = 20) {
  const act = snap?.observations?.activityText || ''
  const lines = act.split('\n').filter(Boolean).slice(-maxLines)
  const d = snap?.derived || {}
  const todo = d.todo_total > 0
    ? `任务清单: ${d.todo_done}/${d.todo_total} 已完成${d.todo_total - d.todo_done > 0 ? `，${d.todo_total - d.todo_done} 待办` : ''}`
    : '任务清单: 无'
  return { task: (snap?.task || '').slice(0, 600), todo, activity: lines.join('\n') }
}

/** Prompt for the percent estimate. Binds the model to the activity log only. */
export function summarizePrompt(ctx) {
  return [
    '你是一个任务进度估计器。根据给定的任务、计划清单和活动流水，估计当前完成百分比（0-100 整数），并给一句不超过 60 字的话说明已完成什么、正在做什么。',
    '规则：百分比必须能从计划或活动证据中辩护；计划缺失时基于活动保守估计；不要预测未来，不要编造流水里没有的内容。',
    '',
    `任务: ${ctx.task || '(未提供)'}`,
    `${ctx.todo}`,
    '',
    '活动流水（最近，按时间顺序）:',
    ctx.activity || '(空)',
    '',
    '只输出一行 JSON，不要任何其他文字：{"percent": 数字, "one_line": "一句话"}',
  ].join('\n')
}

/**
 * Zero-cost deterministic fallback: % = plan completion if a plan exists, else
 * the stage band midpoint.  Used before the first LLM call or when no key.
 */
export function fallbackSummary(snap, stage = '') {
  const d = snap?.derived || {}
  const percent = d.todo_total > 0
    ? Math.round((d.todo_done / d.todo_total) * 100)
    : (MID[stage] ?? 35)
  const parts = []
  if (d.writes_succeeded > 0) parts.push(`已写 ${d.writes_succeeded} 文件`)
  if (d.tests_run > 0) parts.push(d.tests_failed === 0 ? `测试通过 ${d.tests_run} 次` : `测试 ${d.tests_failed} 失败`)
  if (d.todo_total > 0) parts.push(`清单 ${d.todo_done}/${d.todo_total}`)
  const one_line = parts.join('，') || `处于 ${stage || '未知'} 阶段`
  return { percent, one_line, confidence: 0.5 }
}

/**
 * Run the percent estimate.  `llm(prompt)` returns a string (JSON) when the
 * harness provides a model; otherwise the deterministic fallback is used.
 */
export async function summarize(snap, stage, llm) {
  const ctx = buildContext(snap)
  if (typeof llm !== 'function') return { ...fallbackSummary(snap, stage), via: 'fallback' }
  try {
    const raw = await llm(summarizePrompt(ctx))
    const obj = JSON.parse(String(raw).replace(/```json|```/g, '').trim())
    const p = Number(obj.percent)
    const percent = Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : fallbackSummary(snap, stage).percent
    return {
      percent,
      one_line: String(obj.one_line || '').slice(0, 120),
      confidence: Number.isFinite(obj.confidence) ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
      via: 'llm',
    }
  } catch {
    return { ...fallbackSummary(snap, stage), via: 'fallback' }
  }
}

/** CLI smoke test: read a v2 snapshot line, print context + fallback. */
async function main() {
  const fs = await import('node:fs')
  const file = process.argv[2]
  if (!file) { console.log('usage: node summarizer.mjs <snapshot.jsonl>'); return }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  for (const l of lines.slice(-2)) {
    const snap = JSON.parse(l)
    console.log('---', snap.sessionId, 'turn', snap.turn, 'call', snap.callIndex, '---')
    console.log('fallback:', JSON.stringify(fallbackSummary(snap), null, 0))
  }
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main()
}
