/**
 * label-seed.mjs - per-call progress labels (agent-judged) for the seed set.
 *
 * Demonstrates the per-tool-call labeling method across task types:
 *  - implementation turns (session-3dba0711 #12, #23): precise milestone
 *    judgments, high confidence;
 *  - research turn (e2c19368 #1): coarse monotonic estimate, LOW confidence
 *    mid-flight - exploration progress is inherently fuzzy, and we must not
 *    pretend otherwise.
 *
 *   node label-seed.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const base = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const snaps = fs.readFileSync(path.join(base, 'dataset', 'snapshots.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((x) => JSON.parse(x))

// implementation turn 12 (progress-bar.ps1): explicit milestone judgments
const t12 = { 1: 55, 2: 70, 3: 75, 4: 80, 5: 85, 6: 90, 7: 93, 8: 97 }
const t12notes = { 1: '主脚本已写，未测', 2: '首次测试', 5: '复测', 6: '补文档', 8: '收尾' }

// implementation turn 23 (v2 budget evaluator): explicit milestone judgments
const t23 = { 1: 8, 2: 20, 3: 25, 4: 30, 5: 35, 6: 45, 7: 55, 8: 62, 9: 68, 10: 74, 11: 78, 12: 82, 13: 86, 14: 90, 15: 92, 16: 95, 17: 97, 18: 100 }

const labels = []
for (const s of snaps) {
  const is12 = s.sessionId.startsWith('session-3dba0711') && s.turn === 12
  const is23 = s.sessionId.startsWith('session-3dba0711') && s.turn === 23
  const isR = s.sessionId.startsWith('e2c19368') && s.turn === 1
  if (!is12 && !is23 && !isR) continue

  if (is12) {
    labels.push({
      sessionId: s.sessionId, turn: s.turn, callIndex: s.callIndex,
      label: {
        progress_pct: t12[s.callIndex],
        confidence: 'high',
        task_type: 'tooling',
        label_source: 'agent-judge',
        note: t12notes[s.callIndex] ?? '迭代实现中',
      },
    })
  } else if (is23) {
    labels.push({
      sessionId: s.sessionId, turn: s.turn, callIndex: s.callIndex,
      label: {
        progress_pct: t23[s.callIndex],
        confidence: 'high',
        task_type: 'tooling',
        label_source: 'agent-judge',
        note: s.callIndex === 1 ? '阅读现有代码' : s.callIndex === 8 ? '配置就绪' : s.callIndex >= 14 ? '测试验证' : '迭代实现中',
      },
    })
  } else {
    // research: coarse monotonic, LOW confidence mid-flight
    const pct = Math.round(3 + (s.callIndex / 55) * 97)
    labels.push({
      sessionId: s.sessionId, turn: s.turn, callIndex: s.callIndex,
      label: {
        progress_pct: Math.min(100, pct),
        confidence: s.callIndex < 40 ? 'low' : 'medium',
        task_type: 'research',
        label_source: 'agent-judge',
        note: s.callIndex < 40 ? '探索阶段，进度粗估' : '信息已足，转入综合',
      },
    })
  }
}

const out = path.join(base, 'dataset', 'snapshot-labels.jsonl')
fs.writeFileSync(out, labels.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
console.log(`[label] ${labels.length} per-call labels -> ${out}`)
console.log(`[label] 覆盖: turn12=${labels.filter((x) => x.turn === 12).length}, turn23=${labels.filter((x) => x.turn === 23).length}, research=${labels.filter((x) => x.turn === 1 && x.sessionId.startsWith('e2c19368')).length}`)
