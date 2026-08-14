/**
 * llm.mjs - thin DeepSeek V4 Flash client for the semantic summary layer.
 *
 * Model: deepseek-v4-flash with reasoning DISABLED (reasoning_effort:"none") -
 * the cheap "不深度思考" mode the user asked for.  Key is read from the harness
 * credentials file (~/.dsh/.credentials.yaml) so no secret lives in source.
 *
 * Framework-agnostic: any OpenAI-compatible endpoint works by changing
 * {base, model} at the call site.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml')

export function readDeepseekKey() {
  try {
    const m = fs.readFileSync(CRED, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    if (m) return m[1]
  } catch { /* fall through to env */ }
  return process.env.DEEPSEEK_API_KEY || ''
}

/**
 * One chat completion. Returns the assistant text content.
 * @param {string} prompt
 * @param {object} [opts]  {model, base, reasoningEffort, maxTokens, temperature}
 */
export async function deepseekFlash(prompt, opts = {}) {
  const {
    model = 'deepseek-v4-flash',
    base = 'https://api.deepseek.com',
    reasoningEffort = 'none',
    maxTokens = 320,
    temperature = 0.2,
  } = opts
  const key = readDeepseekKey()
  if (!key) throw new Error('no DeepSeek API key')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      reasoning_effort: reasoningEffort,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`api:${res.status} ${JSON.stringify(j.error ?? {})}`)
  return j.choices?.[0]?.message?.content ?? ''
}

/** Run `fn` over `items` with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await fn(items[idx], idx) } catch (e) { out[idx] = { error: String(e.message || e) } }
    }
  })
  await Promise.all(workers)
  return out
}
