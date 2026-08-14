/**
 * annotate-remaining.mjs - can an LLM, seeing ONLY the prefix (no future),
 * estimate the REMAINING tool calls?  This is the ceiling of the "rollout /
 * remaining-step" direction IF we allowed an LLM at runtime.
 *
 * For each sampled moment t, flash reads the activity log UP TO t and estimates
 * the remaining tool-call count.  Progress = k / (k + remaining).  We compare
 * that progress against the full-trajectory % label (percent-labels.jsonl).
 *
 * If this MAE is materially below 18.7pp, then "explicit remaining-work via LLM"
 * beats the prefix-facts regressor (but costs an LLM at runtime).  If not, even
 * an LLM looking at the prefix cannot see the remaining work — the denominator
 * is truly unobservable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const K = 6
const MAX_STEPS = 80 // cap prefix activity lines fed to the LLM

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bySid = new Map()
for (const s of snaps) { if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, []); bySid.get(s.sessionId).push(s) }
for (const v of bySid.values()) v.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)
function tuple2k(r) { return `${r.sessionId}|${r.turn}|${r.callIndex}` }
const pctMap = new Map()
for (const line of fs.readFileSync(path.join(DS, 'percent-labels.jsonl'), 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line)
  pctMap.set(tuple2k(r), r.percent)
}

function stepLine(s) {
  const act = s.observations?.activity || []
  const last = act[act.length - 1]
  const a = (last?.action || '?').replace(/\s+/g, ' ').slice(0, 55)
  const r = (last?.result || '').replace(/\s+/g, ' ').slice(0, 55)
  return r ? `${a} → ${r}` : a
}
function samplePoints(n, k) {
  if (n <= k) return [...Array(n).keys()]
  const idx = new Set()
  for (let j = 0; j < k; j++) idx.add(Math.round((j * (n - 1)) / (k - 1)))
  return [...idx].sort((a, b) => a - b)
}
function prompt(task, prefixLines, k) {
  return [
    '你是任务进度估计员。下面是一个 agent 任务"到目前为止"的执行记录（不含未来）。',
    '估计这个任务还需要多少次工具调用才能完成（剩余步数）。',
    '',
    `任务: ${(task || '(未提供)').slice(0, 300)}`,
    '',
    `已完成的执行记录（${k} 步）:`,
    prefixLines.join('\n'),
    '',
    '只输出一行 JSON: {"remaining": 整数}',
  ].join('\n')
}

async function main() {
  if (!readDeepseekKey()) { console.error('no key'); process.exit(1) }
  const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 3)
  const tasks = []
  for (const [sid, session] of sessions) {
    for (const i of samplePoints(session.length, K)) {
      const prefix = session.slice(0, i + 1)
      const step = Math.max(1, Math.ceil(prefix.length / MAX_STEPS))
      const lines = []
      for (let j = 0; j < prefix.length; j += step) lines.push(`${j + 1}. ${stepLine(prefix[j])}`)
      tasks.push({ sid, turn: session[i].turn, callIndex: session[i].callIndex, k: i + 1, prompt: prompt(session[0].task, lines, i + 1) })
    }
  }
  console.log(`[annotate-remaining] ${tasks.length} prefix->remaining queries`)

  const results = await mapLimit(tasks, 8, async (t) => {
    const raw = await deepseekFlash(t.prompt, { maxTokens: 120, temperature: 0 })
    let rem = null
    try { rem = Number(JSON.parse(String(raw).replace(/```json|```/g, '').trim()).remaining) } catch { /* ignore */ }
    if (!Number.isFinite(rem) || rem < 0) return { ...t, remaining: null }
    return { ...t, remaining: Math.round(rem) }
  })

  const rows = results.filter((r) => r.remaining != null)
  const out = rows.map((r) => ({ sessionId: r.sid, turn: r.turn, callIndex: r.callIndex, k: r.k, remaining: r.remaining }))
  fs.writeFileSync(path.join(DS, 'remaining-labels.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  // progress = k/(k+remaining) vs full-trajectory %
  let mae = 0, n = 0
  const diffs = []
  for (const r of rows) {
    const p = pctMap.get(`${r.sid}|${r.turn}|${r.callIndex}`)
    if (p == null) continue
    const prog = r.k / (r.k + r.remaining) * 100
    diffs.push(Math.abs(prog - p))
    mae += Math.abs(prog - p); n++
  }
  console.log(`[annotate-remaining] ${rows.length} valid remaining estimates`)
  console.log(`[annotate-remaining] progress(k/(k+rem)) vs full-trajectory %: MAE=${(mae / n).toFixed(1)} pp (n=${n})`)
  console.log(`[annotate-remaining] (baseline prefix-facts regressor = 18.7pp)`)
  // residual directionality
  const resid = []
  for (const r of rows) {
    const p = pctMap.get(`${r.sid}|${r.turn}|${r.callIndex}`)
    if (p == null) continue
    resid.push({ prog: r.k / (r.k + r.remaining) * 100 - p, p })
  }
  for (const [lo, hi, name] of [[0, 30, 'early 0-30'], [30, 70, 'mid 30-70'], [70, 101, 'late 70-100']]) {
    const m = resid.filter((x) => x.p >= lo && x.p < hi)
    if (m.length) console.log(`    ${name}: mean residual ${(m.reduce((a, b) => a + b.prog, 0) / m.length).toFixed(1)} pp`)
  }
}

main()
