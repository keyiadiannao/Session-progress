/**
 * review-server.mjs - minimal human review UI for the rule-based estimator.
 *
 * Smart-samples snapshots (transitions, rework, artifacts, framework-balanced),
 * serves a single-page UI that HIDES the rule stage until the human has picked
 * one independently (avoids anchoring), then reveals the rule + evidence and
 * records human_stage / agreement / confidence / comment to human-labels.jsonl.
 *
 *   node review-server.mjs [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DS = path.join(HERE, 'dataset')
const OUT = path.join(DS, 'human-labels.jsonl')
const PORT = Number(process.argv[2] ?? 3299)

const STAGES = ['understood', 'planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
const STAGE_ZH = { understood: '已理解', planned: '已规划', executing: '执行中', first_output: '首个产出', integrating: '整合中', validating: '验证中', ready: '收尾' }
const STAGE_PCT = { understood: '0–10%', planned: '10–25%', executing: '25–45%', first_output: '45–65%', integrating: '65–80%', validating: '80–92%', ready: '92–99%' }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

function loadSamples() {
  const snaps = fs.readFileSync(path.join(DS, 'snapshots.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const labs = {}
  for (const l of fs.readFileSync(path.join(DS, 'stage-labels.jsonl'), 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(l)
    labs[`${r.sessionId}#${r.turn}#${r.callIndex}`] = r.label
  }
  return snaps.map((s) => {
    const key = `${s.sessionId}#${s.turn}#${s.callIndex}`
    const L = labs[key]
    if (!L) return null
    return { ...s, ruleStage: L.stage, ruleEvidence: L.evidence }
  }).filter(Boolean)
}

function smartSample(samples, target = 100) {
  const byTurn = new Map()
  for (const s of samples) {
    const k = `${s.sessionId}#${s.turn}`
    if (!byTurn.has(k)) byTurn.set(k, [])
    byTurn.get(k).push(s)
  }
  const transitions = new Set()
  for (const list of byTurn.values()) {
    list.sort((a, b) => a.callIndex - b.callIndex)
    for (let i = 1; i < list.length; i++) if (list[i].ruleStage !== list[i - 1].ruleStage) transitions.add(list[i])
  }
  const strata = { transition: [], rework: [], artifact: [], other: [] }
  for (const s of samples) {
    if (transitions.has(s)) strata.transition.push(s)
    else if (s.errors >= 2) strata.rework.push(s)
    else if (s.producedArtifact && s.ruleStage === 'first_output') strata.artifact.push(s)
    else strata.other.push(s)
  }
  const caps = { transition: 40, rework: 20, artifact: 20, other: 20 }
  const picked = []
  for (const [name, list] of Object.entries(strata)) {
    const dsh = list.filter((s) => s.framework === 'dsh')
    const claude = list.filter((s) => s.framework === 'claude')
    const half = Math.floor(caps[name] / 2)
    picked.push(...shuffle(dsh).slice(0, half), ...shuffle(claude).slice(0, caps[name] - half))
  }
  return shuffle(picked).slice(0, target)
}

const samples = smartSample(loadSamples())
console.log(`[review] sampled ${samples.length} snapshots for review`)

const server = http.createServer(async (req, res) => {
  const u = (req.url || '').split('?')[0]
  if (u === '/api/samples') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(samples))
    return
  }
  if (u === '/api/judge' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    const j = JSON.parse(body)
    const record = {
      ...j, ts: new Date().toISOString(),
      ruleStage: j.ruleStage, humanStage: j.humanStage,
      agreement: j.ruleStage === j.humanStage ? 'yes' : 'no',
    }
    fs.appendFileSync(OUT, JSON.stringify(record) + '\n', 'utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, done: countDone() }))
    return
  }
  if (u === '/api/done') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ done: countDone(), total: samples.length }))
    return
  }
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }
  res.writeHead(404); res.end('not found')
})

function countDone() {
  if (!fs.existsSync(OUT)) return 0
  return fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).length
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[review] open http://127.0.0.1:${PORT}  (independent human review, rule stage hidden first)`)
})

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>进度规则人工审查</title>
<style>
:root{color-scheme:dark} *{box-sizing:border-box;margin:0;padding:0}
body{background:#0b1020;color:#e8ecf4;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px;max-width:820px;margin:0 auto}
h1{font-size:18px;color:#7aa2ff;margin-bottom:4px} .sub{color:#7b8499;font-size:12px;margin-bottom:16px}
.panel{background:#141a2e;border:1px solid #232c47;border-radius:10px;padding:14px;margin-bottom:12px}
.panel h2{font-size:13px;color:#7aa2ff;margin-bottom:8px}
.k{color:#7b8499;font-size:11px} .task{color:#c9d4ea;word-break:break-all}
.res{background:#0f1424;border:1px solid #232c47;border-radius:6px;padding:6px;margin:4px 0;font-family:Consolas,monospace;font-size:11px;color:#aab3c9;white-space:pre-wrap;max-height:120px;overflow:auto;word-break:break-all}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0} .chip{background:#1d2640;border-radius:999px;padding:2px 10px;font-size:12px}
.stage-btn{background:#1d2640;border:1px solid #33406b;color:#e8ecf4;border-radius:8px;padding:10px 8px;cursor:pointer;font-size:13px;flex:1;min-width:88px}
.stage-btn:hover{border-color:#7aa2ff} .stage-btn.sel{background:#0f2a4a;border-color:#7aa2ff;color:#7aa2ff}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
#reveal{display:none} .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px}
.b-agree{background:#123d24;color:#58e08a}.b-disagree{background:#3d1216;color:#ff6b6b}
.conf{background:#1d2640;border:1px solid #33406b;color:#e8ecf4;border-radius:8px;padding:8px;cursor:pointer;margin-right:6px}
.conf.sel{background:#0f2a4a;border-color:#7aa2ff}
textarea{width:100%;background:#0f1424;border:1px solid #232c47;border-radius:8px;color:#e8ecf4;padding:8px;margin-top:8px;font:inherit}
#submit{background:#4d6bff;color:#fff;border:0;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px;margin-top:10px}
#progress{color:#7b8499;font-size:12px;margin-top:8px}
</style></head><body>
<h1>进度规则人工审查</h1><div class="sub" id="sub"></div>
<div id="root"><div class="panel">加载中…</div></div>
<script>
let samples=[], idx=0, humanStage=null, confidence=null
const STAGE_ZH=${JSON.stringify(STAGE_ZH)}, STAGE_PCT=${JSON.stringify(STAGE_PCT)}, STAGES=${JSON.stringify(STAGES)}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const el=(t,c,h)=>{const n=document.createElement(t);if(c)n.className=c;if(h!=null)n.innerHTML=h;return n}
async function init(){const r=await fetch('/api/samples');samples=await r.json();render()}
function render(){
  document.getElementById('sub').textContent='规则 stage 已隐藏——先独立判断，再显示复核 · 进度 '+idx+'/'+samples.length
  const s=samples[idx]; const root=document.getElementById('root'); root.innerHTML=''; humanStage=null; confidence=null
  const rv=document.getElementById('reveal'); if(rv) rv.remove()
  root.appendChild(panel('会话上下文', '<div class="k">'+esc(s.sessionId.slice(0,60))+' · '+s.framework+' · turn '+s.turn+' · 第 '+s.callIndex+' 次调用</div>'+
    '<div class="task">任务：'+esc(s.task||'(无)')+'</div>'+
    '<div class="k" style="margin-top:6px;white-space:pre-wrap;max-height:240px;overflow:auto">首轮思考：'+esc(s.anchorReasoning||'(无)')+'</div>'))
  root.appendChild(panel('活动流水（做了什么 → 结果如何）',
    '<div class="k">'+esc(s.sessionId.slice(0,60))+' · '+s.framework+' · turn '+s.turn+' · 第 '+s.callIndex+' 次调用 · 报错 '+s.errors+' · 耗时 '+Math.round(s.elapsedSec)+'s · todo '+s.todoDone+'/'+s.todoTotal+'</div>'+
    ((s.activity||[]).slice(-20).map((x,i)=>'<div class="res">'+(i+1)+'. '+esc(x.action)+(x.result?'<br><span style="color:#7b8499">↳ '+esc(x.result)+'</span>':'')+'</div>').join('')||'<div class="k">(无活动)</div>')))
  const r=panel('请独立判断：当前进度处于哪个阶段？','<div class="row">'+STAGES.map(st=>'<button class="stage-btn" data-s="'+st+'">'+STAGE_ZH[st]+'<br><small>'+STAGE_PCT[st]+'</small></button>').join('')+'</div>')
  root.appendChild(r)
  r.querySelectorAll('.stage-btn').forEach(b=>b.onclick=()=>{humanStage=b.dataset.s;r.querySelectorAll('.stage-btn').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');reveal(s)})
}
function reveal(s){
  const d=el('div','panel'); d.id='reveal'; d.style.display='block'
  d.appendChild(el('h2','','规则判断（现在才显示）'))
  const agree=s.ruleStage===humanStage
  d.appendChild(el('div','','规则阶段：<span class="badge '+(agree?'b-agree':'b-disagree')+'">'+STAGE_ZH[s.ruleStage]+' '+STAGE_PCT[s.ruleStage]+'</span> · 你的判断：'+STAGE_ZH[humanStage]+' · <b>'+(agree?'一致':'不一致')+'</b>'))
  d.appendChild(el('div','k','规则依据：'+esc(s.ruleEvidence||'')))
  d.appendChild(el('div','', '置信度：'+ ['low','medium','high'].map(c=>'<button class="conf" data-c="'+c+'">'+c+'</button>').join('')))
  const ta=el('textarea'); ta.placeholder='可选：备注（为什么这样判 / 规则错在哪）'; d.appendChild(ta)
  const sub=el('button'); sub.id='submit'; sub.textContent='提交并下一个'; d.appendChild(sub)
  d.appendChild(el('div','', '<div id="progress"></div>'))
  d.querySelectorAll('.conf').forEach(b=>b.onclick=()=>{confidence=b.dataset.c;d.querySelectorAll('.conf').forEach(x=>x.classList.remove('sel'));b.classList.add('sel')})
  sub.onclick=async()=>{
    await fetch('/api/judge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:s.sessionId,turn:s.turn,callIndex:s.callIndex,framework:s.framework,humanStage,confidence:confidence||null,comment:ta.value})})
    idx++; if(idx>=samples.length){document.getElementById('root').innerHTML='<div class="panel">全部完成！标注已写入 dataset/human-labels.jsonl</div>';return} render()
  }
  document.getElementById('root').appendChild(d); d.scrollIntoView()
}
function panel(h,inner){const p=el('div','panel');p.appendChild(el('h2','',h));const d=el('div');d.innerHTML=inner;p.appendChild(d);return p}
init()
</script></body></html>`
