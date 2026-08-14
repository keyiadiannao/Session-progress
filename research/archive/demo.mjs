/**
 * demo.mjs - runnable demo of the progress estimator.
 *
 * Replays one real session's snapshot stream in order and renders a self-contained
 * HTML timeline: stage badge + band + activity-mode + a one-line summary per
 * milestone.  The stage/mode come from the prefix-only RULE (zero LLM, zero cost);
 * the summary is the semantic layer.
 *
 *   - by default, stage-jump nodes get a REAL LLM summary (deepseek-v4-flash,
 *     reasoning off) via summarizer.mjs + llm.mjs
 *   - pass --fallback to force the zero-cost template summary everywhere
 *
 * Usage:
 *   node demo.mjs [sessionIdPrefix] [out.html] [--fallback]
 *   node demo.mjs session-3dba0711 demo.html
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize } from './summarizer.mjs'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const ARGS = process.argv.slice(2)
const PREFIX = ARGS.find((a) => !a.startsWith('--')) ?? 'session-3dba0711'
const OUT = ARGS.find((a) => a.endsWith('.html')) ?? 'demo.html'
const FALLBACK = ARGS.includes('--fallback')

// ---------------- prefix-only stage rule (synced with label-prefix.py) ----------------
const BAND = { planned: [10, 25], executing: [25, 45], first_output: [45, 65], integrating: [65, 80], validating: [80, 92], ready: [92, 99] }
const STAGE_COLOR = { planned: '#9aa4b2', executing: '#4a90d9', first_output: '#2bb3a3', integrating: '#8b5cf6', validating: '#e6a23c', ready: '#22c55e' }
const MODE_CN = { exploring: '探索', executing: '执行', rework: '返工', validating: '验证', delivering: '交付' }

function hasReport(s) {
  const files = s.observations?.files || []
  const claims = s.observations?.visible_claims || []
  return files.some((f) => /\.(md|tex)$/i.test(f.path || '') || /readme/i.test(f.path || '')) || claims.some((c) => c.type === 'ready_to_deliver')
}
function stagePrefix(s) {
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
function modePrefix(s) {
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

// ---------------- zero-cost summary line (fallback) ----------------
function fallbackLine(s, stage) {
  const d = s.derived || {}
  const parts = []
  if (d.writes_succeeded > 0) parts.push(`已写 ${d.writes_succeeded} 文件`)
  if (d.tests_run > 0) parts.push(d.tests_failed === 0 ? `测试通过 ${d.tests_run} 次` : `测试 ${d.tests_failed} 失败`)
  if (d.todo_total > 0) parts.push(`清单 ${d.todo_done}/${d.todo_total}`)
  const act = (s.observations?.activity || []).slice(-2)
  const doing = act.map((a) => (a.action || '').replace(/["'\\]/g, '').slice(0, 44)).filter(Boolean).slice(-1).join('')
  if (doing) parts.push(`正在 ${doing}`)
  return parts.join(' · ') || `处于 ${stage} 阶段`
}

// ---------------- load + replay ----------------
const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const target = snaps.filter((s) => (s.sessionId || '').startsWith(PREFIX))
if (target.length === 0) { console.error(`no snapshots for prefix "${PREFIX}"`); process.exit(1) }
target.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)

const rows = target.map((s) => ({ s, stage: stagePrefix(s), mode: modePrefix(s), band: BAND[stagePrefix(s)], line: '', llm: null, jump: false }))
rows.forEach((r) => { r.line = fallbackLine(r.s, r.stage) })
rows.forEach((r, i) => { r.jump = i > 0 && r.stage !== rows[i - 1].stage })

const useLLM = !FALLBACK && readDeepseekKey() !== ''
if (useLLM) {
  const jumpIdxs = rows.map((r, i) => (r.jump ? i : -1)).filter((i) => i >= 0)
  console.log(`[demo] LLM summarising ${jumpIdxs.length} stage-jump nodes (deepseek-v4-flash, reasoning off) ...`)
  const sums = await mapLimit(jumpIdxs, 6, (idx) => summarize(rows[idx].s, rows[idx].stage, deepseekFlash))
  let ok = 0
  jumpIdxs.forEach((idx, k) => { rows[idx].llm = sums[k]; if (sums[k]?.via === 'llm') ok++ })
  console.log(`[demo] LLM summaries: ${ok}/${jumpIdxs.length} succeeded`)
}

const n = rows.length
const last = rows[n - 1]
const transitions = rows.filter((r) => r.jump).length
const writes = target.reduce((a, s) => a + (s.derived?.writes_succeeded || 0), 0)
const tests = target.reduce((a, s) => a + (s.derived?.tests_run || 0), 0)

// ---------------- render HTML ----------------
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const nodeIdx = new Set()
rows.forEach((r, i) => { if (r.jump || i % 5 === 0 || i === n - 1) nodeIdx.add(i) })

const nodes = [...nodeIdx].map((i) => {
  const r = rows[i]
  const [lo, hi] = r.band
  const viaLLM = r.llm && r.llm.via === 'llm'
  const line = viaLLM ? r.llm.one_line : r.line
  const src = viaLLM ? '<span class="src">LLM</span>' : ''
  return `<div class="node" style="--c:${STAGE_COLOR[r.stage]}">
    <div class="dot"></div>
    <div class="meta"><span class="idx">t${r.s.turn}.c${r.s.callIndex}</span>
      <span class="badge" style="background:${STAGE_COLOR[r.stage]}">${r.stage}</span>
      <span class="mode">${MODE_CN[r.mode] || r.mode}</span>
      <span class="band">${lo}–${hi}%</span>
      ${r.jump ? '<span class="jump">▲ 阶段跃迁</span>' : ''}${src}</div>
    <div class="line">${esc(line)}</div>
  </div>`
}).join('\n')

const [flo, fhi] = last.band
const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>进度估计器 demo · ${esc(PREFIX)}</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: "Segoe UI", system-ui, sans-serif; background:#0f1115; color:#e6e8ee; max-width:900px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:20px; font-weight:600; }
  .task { color:#9aa4b2; font-size:13px; line-height:1.5; margin:8px 0 20px; }
  .card { border:1px solid #262b36; border-radius:12px; padding:18px 20px; margin-bottom:22px; background:#161a21; }
  .stats { display:flex; gap:22px; flex-wrap:wrap; margin-top:10px; font-size:13px; color:#9aa4b2; }
  .stats b { color:#e6e8ee; }
  .bar { height:10px; background:#262b36; border-radius:6px; overflow:hidden; margin-top:12px; }
  .bar > div { height:100%; background:linear-gradient(90deg,#4a90d9,#22c55e); width:${fhi}%; transition:width .3s; }
  .timeline { position:relative; padding-left:22px; }
  .timeline::before { content:''; position:absolute; left:7px; top:6px; bottom:6px; width:2px; background:#262b36; }
  .node { position:relative; margin-bottom:16px; }
  .dot { position:absolute; left:-22px; top:5px; width:10px; height:10px; border-radius:50%; background:var(--c); box-shadow:0 0 0 3px rgba(255,255,255,.06); }
  .meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12px; }
  .idx { color:#6b7280; font-variant-numeric:tabular-nums; }
  .badge { color:#0b0d10; font-weight:700; padding:2px 8px; border-radius:5px; font-size:11px; }
  .mode { color:#c9ced9; }
  .band { color:#6b7280; }
  .jump { color:#f5c66b; font-weight:600; }
  .src { color:#22c55e; font-size:10px; border:1px solid #22c55e55; padding:0 4px; border-radius:4px; }
  .line { color:#9aa4b2; font-size:13px; margin-top:5px; line-height:1.5; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:#9aa4b2; margin-top:8px; }
  .legend span::before { content:'● '; }
</style></head><body>
<h1>会话进度回放 · ${esc(PREFIX)}</h1>
<div class="task">${esc((target[0].task || '(无任务描述)').slice(0, 500))}</div>

<div class="card">
  <div style="font-size:14px;color:#9aa4b2">最终状态</div>
  <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
    <span class="badge" style="background:${STAGE_COLOR[last.stage]};font-size:13px">${last.stage}</span>
    <span style="font-size:14px;color:#c9ced9">${MODE_CN[last.mode] || last.mode}</span>
    <span style="color:#6b7280">${flo}–${fhi}%</span>
  </div>
  <div class="bar"><div></div></div>
  <div class="stats">
    <span>快照 <b>${n}</b></span><span>阶段跃迁 <b>${transitions}</b></span>
    <span>写入 <b>${writes}</b></span><span>测试 <b>${tests}</b></span>
    <span>摘要方式 <b>${useLLM ? 'LLM(flash) + fallback' : 'fallback'}</b></span>
  </div>
  <div class="legend">
    ${Object.entries(STAGE_COLOR).map(([k, c]) => `<span style="color:${c}">${k}</span>`).join('')}
  </div>
</div>

<div class="timeline">
${nodes}
</div>
</body></html>`

fs.writeFileSync(OUT, html, 'utf8')
console.log(`[demo] ${n} snapshots, ${transitions} stage transitions -> ${OUT}`)
console.log(`[demo] final stage=${last.stage} (${flo}-${fhi}%) mode=${last.mode}`)
console.log(`[demo] summary: ${last.llm && last.llm.via === 'llm' ? last.llm.one_line : last.line}`)
