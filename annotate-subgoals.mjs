/**
 * annotate-subgoals.mjs - test whether an EXPLICIT subgoal decomposition gives a
 * more learnable progress signal than a direct continuous %.
 *
 * Hypothesis (from the brainstorm): direct % regression is hard because total
 * task scale is a latent variable.  If we instead decompose the task into named
 * subgoals and measure SUBGOAL COVERAGE (fraction of subgoals completed), that
 * denominator is discrete and anchored to observable milestones, so it may be
 * more identifiable from prefix facts.
 *
 * flash reads the FULL timeline and, in one call, (a) lists the task's subgoals
 * and (b) marks, for each sampled moment, which subgoals are already done.
 * Subgoal coverage = mean(done).  We then train a prefix model on it and compare
 * its MAE to the direct-% model's 18.7pp.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const K = 6
const MAX_TL_STEPS = 120

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
function buildPrompt(task, session, pts) {
  const step = Math.max(1, Math.ceil(session.length / MAX_TL_STEPS))
  const tl = []
  for (let i = 0; i < session.length; i += step) tl.push(`${i + 1}. ${stepLine(session[i])}`)
  return [
    '你是任务分析员。看下面这个 agent 会话的完整执行时间线（从开始到最终交付）。',
    '请做两件事：',
    '1. 把这个任务分解成 3-6 个主要的子目标（离散的、可观测的工作单元，如"写提取脚本"、"跑测试"、"修 bug"、"写文档"）。',
    '2. 对下面指定的每个采样时刻，判断每个子目标是否已经完成（0=未完成，1=完成；进行中记为 0）。',
    '',
    `任务: ${(task || '(未提供)').slice(0, 400)}`,
    '',
    '完整执行时间线:',
    tl.join('\n'),
    '',
    '采样时刻（step 编号，从 1 开始）:',
    pts.map((p) => `- step ${p + 1}`).join('\n'),
    '',
    '只输出一行 JSON，不要任何其他文字：',
    '{"subgoals": ["子目标1", "子目标2", ...], "progress": {"3": [0,1,0], "10": [1,1,0], ...}}',
    'progress 的键是 step 编号字符串，值是长度为 len(subgoals) 的 0/1 数组，按 subgoals 顺序对应每个子目标是否完成。',
  ].join('\n')
}

async function main() {
  if (!readDeepseekKey()) { console.error('no key'); process.exit(1) }
  const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 3)
  console.log(`[annotate-subgoals] ${sessions.length} sessions, ${K} points each`)
  const out = []

  const results = await mapLimit(sessions, 6, async ([sid, session]) => {
    const pts = samplePoints(session.length, K)
    const raw = await deepseekFlash(buildPrompt(session[0].task, session, pts), { maxTokens: 600, temperature: 0 })
    let p = null
    try { p = JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { /* ignore */ }
    if (!p || !Array.isArray(p.subgoals) || p.subgoals.length === 0) return null
    const labels = []
    for (const i of pts) {
      const arr = p.progress?.[String(i + 1)]
      if (!Array.isArray(arr) || arr.length !== p.subgoals.length) continue
      const cov = arr.reduce((a, b) => a + (b === 1 || b === '1' ? 1 : 0), 0) / p.subgoals.length
      labels.push({ sessionId: sid, turn: session[i].turn, callIndex: session[i].callIndex, step: i + 1, subgoal_ratio: cov, n_subgoals: p.subgoals.length })
    }
    return labels
  })

  for (const labels of results) if (Array.isArray(labels)) out.push(...labels)
  fs.writeFileSync(path.join(DS, 'subgoal-labels.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  console.log(`[annotate-subgoals] ${out.length} labels -> subgoal-labels.jsonl`)
  const dist = {}
  for (const r of out) { const b = Math.round(r.subgoal_ratio * 10) / 10; dist[b] = (dist[b] || 0) + 1 }
  console.log('[annotate-subgoals] subgoal-coverage distribution:', JSON.stringify(dist))
}

main()
