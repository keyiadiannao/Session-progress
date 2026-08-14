/**
 * annotate-stage.mjs - flash labels the NEW-ontology stage for a sample of
 * snapshots, to test whether TEXT features can beat facts features on the
 * high-maturity stages (integrating/validating/ready).
 *
 * Same blind prompt as blind-prefix-agreement.mjs: flash sees task + activity
 * text UP TO that snapshot, no future, no hint of our rule.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'

const DS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dataset')
const SAMPLE = 2000

const STAGE_DEF = [
  'planned 规划：任务刚开始，尚无实质动作或产物',
  'executing 执行中：在做动作，但还没有可见产物',
  'first_output 初见产出：第一个可见产物已出现（如写成了某个文件）',
  'integrating 整合中：多个产物在组装/整合/完善',
  'validating 验证中：已经跑过验证（如测试）并通过',
  'ready 可交付：交付物已就绪（有明确交付声明 + 产物 + 无阻塞）',
].join('\n')

const snaps = fs.readFileSync(path.join(DS, 'snapshots-v2.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
console.log(`total snapshots: ${snaps.length}`)

// group by session, sample uniformly per session
const bySid = new Map()
for (const s of snaps) { if (!bySid.has(s.sessionId)) bySid.set(s.sessionId, []); bySid.get(s.sessionId).push(s) }
const sample = []
for (const [sid, list] of bySid) {
  list.sort((a, b) => a.turn - b.turn || a.callIndex - b.callIndex)
  const k = Math.min(Math.ceil(SAMPLE / bySid.size), list.length)
  for (let j = 0; j < k; j++) {
    sample.push(list[Math.round((j * (list.length - 1)) / Math.max(1, k - 1))])
  }
}
// if over budget, thin down
const final = sample.slice(0, SAMPLE)
console.log(`sampling ${final.length} snapshots across ${bySid.size} sessions`)

function activityLines(s) {
  const acts = s.observations?.activity || []
  return acts.slice(-14).map((x, k) => `${k + 1}. ${(x.action || '?').replace(/\s+/g, ' ').slice(0, 60)}${x.result ? ' → ' + x.result.replace(/\s+/g, ' ').slice(0, 60) : ''}`)
}

function prompt(s) {
  return [
    '你是一个任务进度评判员。下面是一个 agent 任务"到目前为止"的执行记录（不含未来）。',
    '请判断：此刻任务处于下面 6 个阶段中的哪一个？只输出阶段名（planned/executing/first_output/integrating/validating/ready），不要其他文字。',
    '',
    '阶段定义：',
    STAGE_DEF,
    '',
    `任务: ${(s.task || '(未提供)').slice(0, 300)}`,
    '',
    '到目前为止的执行记录：',
    activityLines(s).join('\n'),
  ].join('\n')
}

const results = await mapLimit(final, 8, async (s) => {
  const raw = await deepseekFlash(prompt(s), { maxTokens: 40, temperature: 0 })
  const m = String(raw).match(/(planned|executing|first_output|integrating|validating|ready)/i)
  return { sessionId: s.sessionId, turn: s.turn, callIndex: s.callIndex, stage: m ? m[1].toLowerCase() : null }
})

const valid = results.filter((r) => r.stage)
fs.writeFileSync(path.join(DS, 'stage-labels-flash.jsonl'), valid.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const dist = {}
for (const r of valid) dist[r.stage] = (dist[r.stage] || 0) + 1
console.log(`labeled ${valid.length} snapshots -> stage-labels-flash.jsonl`)
console.log('stage distribution:', JSON.stringify(dist))
