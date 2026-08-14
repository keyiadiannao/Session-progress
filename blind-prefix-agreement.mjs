/**
 * blind-prefix-agreement.mjs - external validation of the stage rule by an
 * INDEPENDENT blind judge.
 *
 * For each sampled prefix moment, we show a judge (deepseek-v4-flash) ONLY the
 * task + the activity log UP TO that moment (no future, and CRUCIALLY no hint of
 * our own stage label).  The judge picks a stage from the same 6-value
 * vocabulary.  We then compare our rule's stage against the blind judge's stage.
 *
 * This is the closest available substitute for human prefix agreement: the
 * judge is independent (does not see our rule's output) and prefix-only.
 *
 * Metrics: exact agreement, off-by-one agreement (adjacent stages), per-stage.
 */
import { discoverSessionDirs, decodeSessionLog, evaluateSession } from './index.mjs'
import { deepseekFlash, mapLimit, readDeepseekKey } from './llm.mjs'
import path from 'node:path'
import os from 'node:os'

const STAGE_DEF = [
  'planned 规划：任务刚开始，尚无实质动作或产物',
  'executing 执行中：在做动作，但还没有可见产物',
  'first_output 初见产出：第一个可见产物已出现（如写成了某个文件）',
  'integrating 整合中：多个产物在组装/整合（≥2 个文件或明确在合并）',
  'validating 验证中：已经跑过验证（如测试）并通过',
  'ready 可交付：交付物已就绪（有明确交付声明 + 产物 + 无阻塞）',
].join('\n')

function prompt(task, prefixLines) {
  return [
    '你是一个任务进度评判员。下面是一个 agent 任务"到目前为止"的执行记录（不含未来）。',
    '请判断：此刻任务处于下面 6 个阶段中的哪一个？只输出阶段名（planned/executing/first_output/integrating/validating/ready），不要其他文字。',
    '',
    '阶段定义：',
    STAGE_DEF,
    '',
    `任务: ${(task || '(未提供)').slice(0, 300)}`,
    '',
    '到目前为止的执行记录：',
    prefixLines.join('\n'),
  ].join('\n')
}

const STAGES = ['planned', 'executing', 'first_output', 'integrating', 'validating', 'ready']
const ORDER = { planned: 0, executing: 1, first_output: 2, integrating: 3, validating: 4, ready: 5 }

async function main() {
  if (!readDeepseekKey()) { console.error('no key'); process.exit(1) }
  const root = process.argv[2] ?? path.join(os.homedir(), '.dsh', 'sessions')
  const sessions = discoverSessionDirs(root)
  const tasks = []

  for (const s of sessions) {
    const events = decodeSessionLog(s.log)
    if (events.length < 5) continue
    // sample up to 6 prefix moments per session, spread across the timeline
    const K = Math.min(6, events.length)
    const idxs = new Set()
    for (let j = 0; j < K; j++) idxs.add(Math.round((j * (events.length - 1)) / (K - 1)))
    for (const i of [...idxs].sort((a, b) => a - b)) {
      const prefix = events.slice(0, i + 1)
      const a = evaluateSession(prefix, Date.now())
      if (a.stage === 'no-data') continue
      // reuse evaluateSession's activity log for the prefix (last 14 entries)
      const acts = (a.activity || []).slice(-14)
      const lines2 = acts.map((x, k) => `${k + 1}. ${x.action}${x.result ? ' → ' + x.result : ''}`)
      tasks.push({
        session: s.name.slice(0, 10),
        idx: i,
        ourStage: a.stage,
        prompt: prompt(a.task, lines2),
      })
    }
  }

  console.log(`blind-judging ${tasks.length} prefix moments ...`)
  const results = await mapLimit(tasks, 6, async (t) => {
    const raw = await deepseekFlash(t.prompt, { maxTokens: 40, temperature: 0 })
    const m = String(raw).match(/(planned|executing|first_output|integrating|validating|ready)/i)
    return { ...t, judgeStage: m ? m[1].toLowerCase() : null }
  })

  let exact = 0, offOne = 0, n = 0
  const perStage = {} // ourStage -> {total, agree}
  for (const r of results) {
    if (!r.judgeStage || !STAGES.includes(r.judgeStage)) continue
    n++
    const d = Math.abs(ORDER[r.ourStage] - ORDER[r.judgeStage])
    if (d === 0) exact++
    if (d <= 1) offOne++
    perStage[r.ourStage] = perStage[r.ourStage] || { total: 0, agree: 0 }
    perStage[r.ourStage].total++
    if (d === 0) perStage[r.ourStage].agree++
  }

  console.log(`\n=== blind prefix agreement (n=${n}) ===`)
  console.log(`  exact agreement    : ${exact}/${n} = ${(100 * exact / n).toFixed(1)}%`)
  console.log(`  off-by-one agreement: ${offOne}/${n} = ${(100 * offOne / n).toFixed(1)}%`)
  console.log('  per-stage (our stage -> judge agreement):')
  for (const st of STAGES) {
    const p = perStage[st]
    if (p) console.log(`    ${st.padEnd(14)} ${p.agree}/${p.total} = ${(100 * p.agree / p.total).toFixed(0)}%`)
  }
  // print disagreements for inspection
  console.log('\n  disagreements:')
  for (const r of results) {
    if (r.judgeStage && r.judgeStage !== r.ourStage) {
      console.log(`    [${r.session}] ${r.ourStage} -> judge ${r.judgeStage}`)
    }
  }
}

main()
