/**
 * annotate-percent.mjs - OFFLINE ground-truth labeling of task completion %.
 *
 * The LLM (deepseek-v4-flash, reasoning off) reads the FULL execution timeline
 * of one session (so it can see what was ultimately delivered = the task size
 * denominator) and labels the completion % at a few sampled moments.
 *
 * This is the ONLY place a big model runs, and it is OFFLINE.  The runtime
 * estimator is a lightweight model trained on these labels + prefix facts, and
 * calls NO LLM at all.
 *
 * Output: percent-labels.jsonl  {sessionId, turn, callIndex, step, percent, reason}
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const K = 6 // sample points per session
const MAX_TL_STEPS = 120 // cap timeline steps fed to the LLM

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bySid = new Map()
for (const s of snaps) {
  if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, [])
  bySid.get(s.sessionId).push(s)
}
for (const v of bySid.values()) v.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)

/** one line of the timeline for a snapshot = its latest activity entry. */
function stepLine(s) {
  const act = s.observations?.activity || []
  const last = act[act.length - 1]
  const a = (last?.action || '?').replace(/\s+/g, ' ').slice(0, 70)
  const r = (last?.result || '').replace(/\s+/g, ' ').slice(0, 70)
  return r ? `${a} → ${r}` : a
}

/** evenly spaced sample indices (inclusive of first/last) */
function samplePoints(n, k) {
  if (n <= k) return [...Array(n).keys()]
  const idx = new Set()
  for (let j = 0; j < k; j++) idx.add(Math.round((j * (n - 1)) / (k - 1)))
  return [...idx].sort((a, b) => a - b)
}

function buildPrompt(task, session, pointIdx) {
  // build (possibly down-sampled) full timeline
  const step = Math.max(1, Math.ceil(session.length / MAX_TL_STEPS))
  const tl = []
  for (let i = 0; i < session.length; i += step) tl.push(`${i + 1}. ${stepLine(session[i])}`)
  const pts = pointIdx.map((i) => i + 1)
  return [
    '你是任务进度标注员。下面是一个 agent 会话的完整执行时间线（从开始到最终交付）。',
    '请基于全局视角（你已经看到最终交付了什么）判断：在指定时刻，任务整体完成了百分之多少（0-100 整数）。',
    '判断要点：percent 是"整个任务"的完成度；看最终交付物反推每个时刻已经做了多少；不要只看步数占比，要看实质产出的占比。',
    '',
    `任务: ${(task || '(未提供)').slice(0, 400)}`,
    '',
    '完整执行时间线:',
    tl.join('\n'),
    '',
    '请标注以下时刻的完成度（step 编号，从 1 开始）:',
    pts.map((p) => `- step ${p}`).join('\n'),
    '',
    '只输出一行 JSON，不要任何其他文字，键是 step 编号字符串，值是 0-100 整数。例如 {"3": 20, "10": 60, "29": 95}',
  ].join('\n')
}

async function main() {
  if (!readDeepseekKey()) { console.error('no DeepSeek key'); process.exit(1) }
  const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 3)
  console.log(`[annotate] labeling ${sessions.length} sessions (>=3 snapshots), ${K} points each`)
  const out = []

  const results = await mapLimit(sessions, 6, async ([sid, session]) => {
    const task = session[0].task || ''
    const pointIdx = samplePoints(session.length, K)
    const prompt = buildPrompt(task, session, pointIdx)
    const raw = await deepseekFlash(prompt, { maxTokens: 400 })
    let parsed = {}
    try { parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { /* leave empty */ }
    const labels = []
    for (const i of pointIdx) {
      const s = session[i]
      const p = Number(parsed[String(i + 1)])
      if (Number.isFinite(p)) {
        labels.push({ sessionId: sid, turn: s.turn, callIndex: s.callIndex, step: i + 1, percent: Math.max(0, Math.min(100, Math.round(p))) })
      }
    }
    return labels
  })

  for (const labels of results) if (Array.isArray(labels)) out.push(...labels)
  fs.writeFileSync(path.join(DS, 'percent-labels.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  const ok = out.filter((r) => r.percent != null).length
  console.log(`[annotate] ${out.length} labels -> percent-labels.jsonl (${sessions.length} sessions)`)
  const dist = {}
  for (const r of out) { const b = Math.floor(r.percent / 10) * 10; dist[b] = (dist[b] || 0) + 1 }
  console.log('[annotate] % distribution (by decile):', JSON.stringify(dist))
}

main()
