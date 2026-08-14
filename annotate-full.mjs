/**
 * annotate-full.mjs - FULL-TRAJECTORY labeling (god's-eye view), the correct
 * annotation per DESIGN §11: the labeler sees the WHOLE session (start to final
 * delivery), so it can judge each sampled moment's TRUE stage + percent — this
 * is annotation (may use future), not inference.
 *
 * Output stage-percent-labels.jsonl:
 *   {sessionId, turn, callIndex, step, stage, percent}
 *
 * Then a model is FIT to predict {stage, percent} from PREFIX facts/text only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const K = 8 // sample moments per session
const MAX_TL = 140 // cap timeline lines fed to the LLM

const STAGE_DEF = 'planned(规划)|executing(执行中)|first_output(初见产出)|integrating(整合中)|validating(验证中)|ready(可交付)'

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bySid = new Map()
for (const s of snaps) { if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, []); bySid.get(s.sessionId).push(s) }
for (const v of bySid.values()) v.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)

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
function prompt(task, session, pts) {
  const step = Math.max(1, Math.ceil(session.length / MAX_TL))
  const tl = []
  for (let i = 0; i < session.length; i += step) tl.push(`${i + 1}. ${stepLine(session[i])}`)
  return [
    '你是任务进度标注员。下面是 agent 会话的完整执行时间线（从开始到最终交付）。',
    '基于全局视角（你已看到最终交付了什么），对每个采样时刻判断：',
    '1. stage：该时刻处于哪个阶段，只取 ' + STAGE_DEF,
    '2. percent：该时刻任务整体完成了百分之多少（0-100 整数）——按最终交付物反推此刻做了多少',
    '',
    `任务: ${(task || '(未提供)').slice(0, 300)}`,
    '',
    '完整执行时间线:',
    tl.join('\n'),
    '',
    '采样时刻（step 编号，从 1 开始）:',
    pts.map((p) => `- step ${p + 1}`).join('\n'),
    '',
    '只输出一行 JSON：{"3":{"stage":"executing","percent":30},"10":{"stage":"validating","percent":80},...}',
  ].join('\n')
}

const sessions = [...bySid.entries()].filter(([, v]) => v.length >= 3)
console.log(`full-trajectory labeling ${sessions.length} sessions, ${K} points each`)

const results = await mapLimit(sessions, 6, async ([sid, session]) => {
  const pts = samplePoints(session.length, K)
  const raw = await deepseekFlash(prompt(session[0].task, session, pts), { maxTokens: 700, temperature: 0 })
  let p = null
  try { p = JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { /* ignore */ }
  if (!p) return []
  const out = []
  for (const i of pts) {
    const e = p[String(i + 1)]
    if (!e || typeof e !== 'object') continue
    const stage = String(e.stage || '').toLowerCase()
    const pct = Number(e.percent)
    const validStage = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready'].includes(stage)
    if (!validStage || !Number.isFinite(pct)) continue
    out.push({ sessionId: sid, turn: session[i].turn, callIndex: session[i].callIndex, step: i + 1, stage, percent: Math.max(0, Math.min(100, Math.round(pct))) })
  }
  return out
})

const all = results.flat()
fs.writeFileSync(path.join(DS, 'stage-percent-labels.jsonl'), all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log(`labeled ${all.length} moments -> stage-percent-labels.jsonl`)
const sd = {}
for (const r of all) sd[r.stage] = (sd[r.stage] || 0) + 1
console.log('stage distribution:', JSON.stringify(sd))
const pd = {}
for (const r of all) { const b = Math.floor(r.percent / 10) * 10; pd[b] = (pd[b] || 0) + 1 }
console.log('percent distribution (deciles):', JSON.stringify(pd))
