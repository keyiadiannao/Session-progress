/**
 * annotate-consistency.mjs - measure the LLM's own labeling noise.
 *
 * If flash labels the SAME moment differently across runs, that disagreement is
 * the floor of any MAE we can reach: a model can't predict % more precisely than
 * the ground-truth annotator agrees with itself.  This tells us whether more
 * data helps, or whether the bottleneck is label noise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const REPEATS = 3
const N_SESSIONS = 5
const N_POINTS = 10

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bySid = new Map()
for (const s of snaps) { if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, []); bySid.get(s.sessionId).push(s) }
for (const v of bySid.values()) v.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)

function stepLine(s) {
  const act = s.observations?.activity || []
  const last = act[act.length - 1]
  const a = (last?.action || '?').replace(/\s+/g, ' ').slice(0, 60)
  const r = (last?.result || '').replace(/\s+/g, ' ').slice(0, 60)
  return r ? `${a} → ${r}` : a
}
function samplePoints(n, k) {
  if (n <= k) return [...Array(n).keys()]
  const idx = new Set()
  for (let j = 0; j < k; j++) idx.add(Math.round((j * (n - 1)) / (k - 1)))
  return [...idx].sort((a, b) => a - b)
}
function prompt(task, session, pts) {
  const step = Math.max(1, Math.ceil(session.length / 120))
  const tl = []
  for (let i = 0; i < session.length; i += step) tl.push(`${i + 1}. ${stepLine(session[i])}`)
  return [
    '你是任务进度标注员。看完整时间线，判断指定时刻任务整体完成百分比(0-100 整数)。',
    `任务: ${(task || '').slice(0, 300)}`,
    '完整时间线:', tl.join('\n'),
    '标注以下时刻:', pts.map((p) => `- step ${p + 1}`).join('\n'),
    '只输出 JSON: {"step编号": 整数}',
  ].join('\n')
}

const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 20).slice(0, N_SESSIONS)
const all = []
for (const [sid, session] of sessions) {
  const pts = samplePoints(session.length, N_POINTS)
  const pr = prompt(session[0].task, session, pts)
  // label the same points REPEATS times, independently
  const runs = await mapLimit([...Array(REPEATS)], 3, async () => {
    const raw = await deepseekFlash(pr, { maxTokens: 400 })
    try { return JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { return {} }
  })
  for (const i of pts) {
    const vals = runs.map((r) => Number(r[String(i + 1)])).filter((v) => Number.isFinite(v))
    all.push({ sid, step: i + 1, vals })
  }
}

// per-point std and pairwise disagreement
let sumPair = 0, nPair = 0, sumStd = 0, nStd = 0
const stds = []
for (const a of all) {
  if (a.vals.length < 2) continue
  const mean = a.vals.reduce((x, y) => x + y, 0) / a.vals.length
  const std = Math.sqrt(a.vals.reduce((x, y) => x + (y - mean) ** 2, 0) / a.vals.length)
  stds.push(std)
  sumStd += std; nStd++
  for (let i = 0; i < a.vals.length; i++) for (let j = i + 1; j < a.vals.length; j++) { sumPair += Math.abs(a.vals[i] - a.vals[j]); nPair++ }
}
stds.sort((a, b) => a - b)
console.log(`points labeled ${REPEATS}x: ${nStd}`)
console.log(`mean per-point std            : ${(sumStd / nStd).toFixed(1)} pp`)
console.log(`mean pairwise disagreement    : ${(sumPair / nPair).toFixed(1)} pp`)
console.log(`per-point std p50/p90         : ${stds[Math.floor(stds.length * 0.5)].toFixed(1)} / ${stds[Math.floor(stds.length * 0.9)].toFixed(1)} pp`)
console.log('=> the annotator disagrees with itself by ~this much; that is the MAE floor.')
