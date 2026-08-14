/**
 * summarize.mjs - lightweight CONTENT extraction for tool actions (shared by
 * both extractors). Turns a raw tool call + its result into one human-readable
 * line: "做了什么 → 结果如何", instead of discarding the semantics to a bare
 * category chip. Pure rules, zero cost.
 */

export function category(name) {
  const n = String(name || '').toLowerCase()
  if (/taskcreate|taskupdate|taskstop|tasklist|todowrite|todo_write|plan/.test(n)) return 'todo'
  if (/^task$/.test(n)) return 'subagent'
  if (/bash|pwsh|powershell|cmd|shell|terminal|python|node|run|npm|git|npx/.test(n)) return 'run'
  if (/write|edit|str_replace|apply_patch|replace|patch/.test(n)) return 'write'
  if (/read|grep|glob|ls\b|list|search_file|find|globtool/.test(n)) return 'inspect'
  if (/web_search|webfetch|web_fetch|websearch|browser|fetch/.test(n)) return 'search'
  if (/report|deliverable/.test(n)) return 'report'
  if (/subagent|delegate|spawn/.test(n)) return 'subagent'
  if (/ask_user|askuser|question/.test(n)) return 'ask_user'
  if (/mcp/.test(n)) return 'mcp'
  if (/skill/.test(n)) return 'skill'
  if (/job_|task_kill|kill/.test(n)) return 'job'
  return 'other'
}

function short(s, n = 100) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/** First meaningful line of a written file (title / docstring / heading / class / func). */
function firstMeaningfulLine(content) {
  const t = String(content ?? '')
  const lines = t.split('\n')
  for (const l of lines) {
    const s = l.trim()
    if (!s) continue
    // skip common noise lines
    if (/^[#!]|^<\?|^import |^from |^\/\*|^\* |^@|^use strict|^'use strict'/.test(s)) continue
    return short(s, 60)
  }
  return ''
}

/** Parse tool arguments (DSH or Claude) into a flat object. */
function parseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return { command: String(raw).slice(0, 200) } }
}

/** "做了什么" for one tool call. */
export function actionSummary(name, rawArgs) {
  const cat = category(name)
  const a = parseArgs(rawArgs)
  switch (cat) {
    case 'write': {
      const p = a.file_path || a.path || ''
      const first = firstMeaningfulLine(a.content)
      const lines = String(a.content || '').split('\n').length
      return `写 ${short(p, 70)}${first ? ' · "' + first + '"' : ''} (${lines} 行)`
    }
    case 'run': {
      const cmd = a.command || a.cmd || a.script || a.code || ''
      return `运行 ${short(cmd, 120)}`
    }
    case 'inspect': {
      if (a.file_path) return `读 ${short(a.file_path, 80)}`
      if (a.pattern) return `搜索匹配 ${short(a.pattern, 60)}`
      if (a.path) return `看 ${short(a.path, 80)}`
      return `查看 ${name}`
    }
    case 'search': return `搜索 ${short(a.query || a.q || '', 80)}`
    case 'todo': return '更新任务清单'
    case 'report': return '输出报告/交付物'
    case 'ask_user': return `询问用户 ${short(a.question || a.prompt || '', 60)}`
    case 'subagent': return `委派子任务 ${short(a.prompt || a.description || a.task || '', 80)}`
    default: return `${name} ${short(JSON.stringify(a), 80)}`
  }
}

/** "结果如何" for one tool result. */
export function resultSummary(rawText) {
  const t = String(rawText ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  const tail = lines.slice(-2).join(' ⟩ ')
  return tail.slice(0, 160)
}
