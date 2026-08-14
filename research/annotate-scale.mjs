/**
 * annotate-scale.mjs - does the task DESCRIPTION carry enough info to estimate
 * the total task size (the denominator)?  This is the make-or-break check for
 * the "estimate the denominator up front" direction.
 *
 * flash reads ONLY the task description (prefix t=0, no trajectory) and gives a
 * PERT 3-point estimate of the FINAL tool-call count.  We then measure:
 *   - mid estimate vs actual final tool_calls_total (relative error)
 *   - how often the actual lands inside [low, high] (interval coverage)
 *
 * If coverage is decent and mid error is small, the direction is viable.
 * If not, the denominator is genuinely unobservable (gpt's contrary argument),
 * and we must fall back to a WIDE prior interval + honest range reporting.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bySid = new Map()
for (const s of snaps) { if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, []); bySid.get(s.sessionId).push(s) }
for (const v of bySid.values()) v.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)

const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 3)

function prompt(task) {
  return [
    '你是一个软件任务规模估计员。只看下面的任务描述，估计这个任务最终总共会执行多少次工具调用（一次工具调用 = 一次 read/write/run/search 等操作）。',
    '给出三点估计：low(乐观，较少调用) / mid(最可能) / high(悲观，较多调用)。',
    '不要看任何执行过程，只根据任务描述的复杂度、范围、是否涉及多文件/调试/反复验证来估计。',
    '',
    `任务描述: ${(task || '(未提供)').slice(0, 600)}`,
    '',
    '只输出一行 JSON: {"low": 整数, "mid": 整数, "high": 整数}',
  ].join('\n')
}

const results = await mapLimit(sessions, 6, async ([sid, session]) => {
  const task = session[0].task || ''
  const actual = session[session.length - 1].derived.tool_calls_total
  const raw = await deepseekFlash(prompt(task), { maxTokens: 200, temperature: 0 })
  let p = null
  try { p = JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { /* ignore */ }
  if (!p || !Number.isFinite(p.mid)) return null
  return { sid, task: task.slice(0, 60), actual, low: Number(p.low), mid: Number(p.mid), high: Number(p.high) }
})

const rows = results.filter(Boolean)
const relErr = (a, m) => Math.abs(a - m) / Math.max(1, a)
const mids = rows.map((r) => relErr(r.actual, r.mid)).sort((a, b) => a - b)
const inRange = rows.filter((r) => r.actual >= r.low && r.actual <= r.high).length
console.log(`labeled ${rows.length} sessions (task description -> 3-point total tool calls)`)
console.log(`mid relative error: median=${(mids[Math.floor(mids.length / 2)] * 100).toFixed(0)}%  p75=${(mids[Math.floor(mids.length * 0.75)] * 100).toFixed(0)}%  p90=${(mids[Math.floor(mids.length * 0.9)] * 100).toFixed(0)}%`)
console.log(`actual inside [low, high]: ${inRange}/${rows.length} = ${(inRange / rows.length * 100).toFixed(0)}%`)
console.log()
const worst = [...rows].sort((a, b) => relErr(b.actual, b.mid) - relErr(a.actual, a.mid)).slice(0, 4)
console.log('worst mid estimates (task / actual / est):')
for (const r of worst) console.log(`  actual=${r.actual}  mid=${r.mid}  [${r.low},${r.high}]  "${r.task}"`)
// save
fs.writeFileSync(path.join(DS, 'scale-estimates.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log(`\nsaved scale-estimates.jsonl (${rows.length})`)
