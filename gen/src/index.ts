/**
 * edtech-monad-gen — internal TypeScript Worker (only reachable via the API's `GEN` service binding).
 *
 *   GET  /health
 *   POST /extract   {material_id, r2_key, filename}           -> PDF (R2) -> Workers AI toMarkdown -> pages JSON in R2
 *   POST /generate  {material_id, text_r2_key, start_page?, end_page?, learning_style?}
 *                   -> slice pages -> TanStack AI chat() + outputSchema (OpenAI gpt-6-luna via @tanstack/ai-openai by default,
 *                      Workers AI via @tanstack/ai-cloudflare as the fallback)
 *                   -> template JSON also stored in R2 (templates/<material>/<ts>.json)
 *
 * It never talks to Supabase; the Python API persists everything.
 */
import { chat } from '@tanstack/ai'
import { CloudflareTextAdapter } from '@tanstack/ai-cloudflare'
import { OpenAITextAdapter, type OpenAIChatModel } from '@tanstack/ai-openai'
import { StudyTemplateSchema, type StudyTemplate } from './schema'

export interface Env {
  AI: Ai
  PDFS: R2Bucket
  AI_MODEL: string
  MAX_PAGES: string
  MAX_INPUT_CHARS: string
  MAX_OUTPUT_TOKENS: string
  /** Optional, for reasoning models (e.g. Qwen 3.8): 'low' | 'medium' | 'high'. Unset = model default. */
  AI_REASONING_EFFORT?: string
  /** 'true' = run non-streaming AI calls as a stream on the wire and aggregate (see streamAggregatingBinding). */
  AI_STREAM_AGGREGATE?: string
  /** 'openai' (default in wrangler.jsonc: gpt-6-luna, effort low) | 'cloudflare' (fallback, Workers AI; also used when unset) */
  LLM_PROVIDER?: string
  OPENAI_API_KEY?: string // secret
  OPENAI_MODEL?: string
  /** OpenAI reasoning effort, e.g. 'low' | 'medium' | 'high' | 'xhigh' | 'max' (passed through as-is). */
  OPENAI_REASONING_EFFORT?: string
  OPENAI_MAX_OUTPUT_TOKENS?: string
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }))

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    try {
      if (pathname === '/health') {
        const provider = (env.LLM_PROVIDER || 'cloudflare').toLowerCase()
        const openai = provider === 'openai'
        return json({
          ok: true,
          service: 'edtech-monad-gen',
          provider,
          model: openai ? env.OPENAI_MODEL || 'gpt-6-luna' : env.AI_MODEL,
          reasoning_effort: (openai ? env.OPENAI_REASONING_EFFORT : env.AI_REASONING_EFFORT) || null,
        })
      }
      if (request.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid JSON body')
      if (pathname === '/extract') return json(await extract(env, body))
      if (pathname === '/generate') return json(await generate(env, body))
      throw new HttpError(404, 'not found')
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      const message = e instanceof Error ? e.message : String(e)
      log('gen_error', { pathname, status, message })
      return json({ error: message }, status)
    }
  },
} satisfies ExportedHandler<Env>

// ---------------------------------------------------------------- extraction

/** toMarkdown output for PDFs contains `### Page N` headers; split on them. */
function splitPages(markdown: string): string[] {
  const parts = markdown.split(/\n### Page (\d+)\n/)
  const pages: string[] = []
  for (let i = 1; i < parts.length; i += 2) pages[Number(parts[i]) - 1] = parts[i + 1] ?? ''
  if (pages.length === 0) pages.push(markdown) // not paginated: treat as one page
  return Array.from(pages, (p) => p ?? '')
}

/** Strip private-use glyphs (TeX bracket pieces) and collapse whitespace. */
const clean = (s: string) =>
  s
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** First page that starts like a chapter and isn't the table of contents (dotted leaders). */
function suggestStart(pages: string[]): number {
  for (let i = 0; i < pages.length; i++) {
    const head = pages[i].trimStart().slice(0, 200)
    if (/^(chapter|unit|lesson|section)\b/i.test(head) && !/\.\s\.\s\./.test(pages[i].slice(0, 2000))) return i + 1
  }
  for (let i = 0; i < pages.length; i++) if (pages[i].trim().length > 500) return i + 1
  return 1
}

async function extract(env: Env, body: Record<string, unknown>) {
  const materialId = String(body.material_id ?? '')
  const r2Key = String(body.r2_key ?? '')
  if (!materialId || !r2Key) throw new HttpError(400, 'material_id and r2_key are required')
  const obj = await env.PDFS.get(r2Key)
  if (!obj) throw new HttpError(404, `PDF not found in R2: ${r2Key}`)
  const t0 = Date.now()
  const blob = new Blob([await obj.arrayBuffer()], { type: 'application/pdf' })
  const res = await env.AI.toMarkdown({ name: String(body.filename ?? 'document.pdf'), blob })
  if (res.format === 'error') throw new HttpError(502, `toMarkdown failed: ${res.error}`)
  // Free plan = 10 ms CPU per request, so keep work here minimal: one split, no per-page regex
  // cleanup (done later on the selected slice only). Pages are stored as one UTF-8 blob plus a
  // byte-offset index, so /generate can fetch just the pages it needs with an R2 range read.
  const pages = splitPages(res.data)
  const enc = new TextEncoder()
  const encoded = pages.map((p) => enc.encode(p))
  const offsets: number[] = [0]
  for (const b of encoded) offsets.push(offsets[offsets.length - 1] + b.byteLength)
  const blobOut = new Uint8Array(offsets[offsets.length - 1])
  encoded.forEach((b, i) => blobOut.set(b, offsets[i]))
  const textKey = `materials/${materialId}/pages.txt`
  const indexKey = `materials/${materialId}/pages-index.json`
  const suggested = suggestStart(pages)
  await env.PDFS.put(textKey, blobOut, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } })
  await env.PDFS.put(indexKey, JSON.stringify({ text_key: textKey, offsets, suggested_start_page: suggested }), {
    httpMetadata: { contentType: 'application/json' },
  })
  const ms = Date.now() - t0
  log('extracted', { materialId, pages: pages.length, chars: res.data.length, tokens: res.tokens, ms })
  return {
    text_r2_key: indexKey,
    page_count: pages.length,
    total_chars: res.data.length,
    suggested_start_page: suggested,
    extract_ms: ms,
    pages: pages.map((p, i) => ({ n: i + 1, chars: p.length, preview: p.slice(0, 90) })),
  }
}

// ---------------------------------------------------------------- generation

/**
 * The stock adapter implements `structuredOutputStream`, so `chat({ outputSchema })` streams the JSON
 * token by token through the TanStack engine (SSE parse + middleware per chunk). On the Workers Free
 * plan that measured ~1.9 s CPU for one template and the request died with "exceededCpu".
 * Hiding the streaming method makes TanStack AI fall back to the adapter's non-streaming
 * `structuredOutput` (one `stream: false` Workers AI call), which keeps CPU tiny. Same schema handling,
 * same validation; we just lose token streaming, which this server-to-server flow doesn't use.
 */
class NonStreamingCloudflareText<M extends string> extends CloudflareTextAdapter<M> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override structuredOutputStream = undefined as any
}

/**
 * Same idea for OpenAI. The Responses adapter declares native "combined tools + schema" support, which
 * makes chat({ outputSchema }) run a *streaming* request; turning that off (we use no tools) plus hiding
 * structuredOutputStream gives a single `stream: false` Responses call with strict json_schema.
 */
class NonStreamingOpenAIText<M extends OpenAIChatModel> extends OpenAITextAdapter<M> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override structuredOutputStream = undefined as any
  override supportsCombinedToolsAndSchema() {
    return false
  }
}

/** USD per 1M tokens, for cost_usd in generation metadata (completion tokens include reasoning). */
const PRICES_USD_PER_M: Record<string, { input: number; output: number; cached?: number }> = {
  'gpt-6-luna': { input: 0.1, output: 0.5, cached: 0.01 },
  '@cf/qwen/qwen3.8-27b': { input: 0.45, output: 3.2, cached: 0.05 },
}

const SYSTEM_PROMPT = `You are an expert teacher who turns textbook excerpts into clear, accurate study guides.
Rules:
- Write all text values in the same language as the excerpt (keep the JSON keys in English).
- Use ONLY facts from the excerpt; do not invent theorems, numbers or results.
- Write math in plain text or simple LaTeX like $x_1 + 2x_2 = 3$.
- Worked examples must show every step and a correct final answer; check your arithmetic.
- Practice questions need a correct answer and a one-sentence explanation. For multiple_choice give 4 choices and make the answer exactly one of them; for other types use an empty choices list.
- Diagrams: only Mermaid "flowchart TD" syntax, node labels in square brackets without quotes, parentheses or special characters. Use an empty list if no diagram helps.
- Every section heading and every practice question must be different; do not repeat items.
- Output a single JSON object that matches the schema. No markdown fences.`

async function generate(env: Env, body: Record<string, unknown>) {
  const materialId = String(body.material_id ?? '')
  const indexKey = String(body.text_r2_key ?? `materials/${materialId}/pages-index.json`)
  if (!materialId) throw new HttpError(400, 'material_id is required')
  const idxObj = await env.PDFS.get(indexKey)
  if (!idxObj) throw new HttpError(409, 'extracted text not found; run /extract first')
  const index = (await idxObj.json()) as { text_key: string; offsets: number[]; suggested_start_page: number }
  const pageCount = index.offsets.length - 1

  const maxPages = Number(env.MAX_PAGES) || 12
  const maxChars = Number(env.MAX_INPUT_CHARS) || 24000
  const start = clamp(Number(body.start_page) || index.suggested_start_page || 1, 1, pageCount)
  const requestedEnd = clamp(Number(body.end_page) || start + maxPages - 1, start, pageCount)
  const end = Math.min(requestedEnd, start + maxPages - 1)

  // Range-read only the selected pages (keeps CPU well under the 10 ms free-plan limit).
  const from = index.offsets[start - 1]
  const textObj = await env.PDFS.get(index.text_key, { range: { offset: from, length: index.offsets[end] - from } })
  if (!textObj) throw new HttpError(409, 'extracted text blob missing')
  const bytes = new Uint8Array(await textObj.arrayBuffer())
  const dec = new TextDecoder()
  const pageText = (p: number) => clean(dec.decode(bytes.subarray(index.offsets[p - 1] - from, index.offsets[p] - from)))

  /** Whole pages from `start` while they fit in `budget` chars (a single oversized page is cut). */
  const buildExcerpt = (budget: number) => {
    let text = ''
    let last = start - 1
    for (let p = start; p <= end; p++) {
      const chunk = `\n[Page ${p}]\n${pageText(p)}\n`
      if (text.length + chunk.length > budget) {
        if (p === start) {
          text = chunk.slice(0, budget)
          last = p
        }
        break
      }
      text += chunk
      last = p
    }
    return { text, last }
  }
  const first = buildExcerpt(maxChars)
  if (!first.text.trim()) throw new HttpError(422, 'selected pages contain no extractable text')
  let excerpt = first.text
  let lastPageUsed = first.last

  const style = typeof body.learning_style === 'string' && body.learning_style ? body.learning_style : 'balanced'
  const provider = (env.LLM_PROVIDER || 'cloudflare').toLowerCase()
  if (provider !== 'cloudflare' && provider !== 'openai') throw new HttpError(500, `unknown LLM_PROVIDER: ${provider}`)
  if (provider === 'openai' && !env.OPENAI_API_KEY) throw new HttpError(500, 'LLM_PROVIDER=openai but the OPENAI_API_KEY secret is not set')
  const model =
    provider === 'openai'
      ? env.OPENAI_MODEL || 'gpt-6-luna'
      : env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast'
  const effort = (provider === 'openai' ? env.OPENAI_REASONING_EFFORT : env.AI_REASONING_EFFORT) || undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adapter: any
  if (provider === 'openai') {
    adapter = new NonStreamingOpenAIText({ apiKey: env.OPENAI_API_KEY as string }, model as any)
  } else {
    // Cast: the adapter pins @cloudflare/workers-types v4, this project uses v5 (identical runtime binding).
    const binding = env.AI_STREAM_AGGREGATE === 'true' ? streamAggregatingBinding(env.AI) : env.AI
    adapter = new NonStreamingCloudflareText({ binding: binding as any }, model)
  }
  const modelOptionsFor = (attempt: number): Record<string, unknown> =>
    provider === 'openai'
      ? {
          // Responses API: reasoning models reject temperature; max_output_tokens covers reasoning + answer.
          max_output_tokens: Number(env.OPENAI_MAX_OUTPUT_TOKENS) || 64000,
          ...(effort ? { reasoning: { effort } } : {}),
        }
      : {
          max_tokens: Number(env.MAX_OUTPUT_TOKENS) || 6000,
          temperature: attempt === 1 ? 0.3 : 0.2,
          // Retry (after e.g. finish_reason=length from a repetition loop) adds a mild repetition penalty.
          ...(attempt > 1 ? { repetition_penalty: 1.1 } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
        }

  const t0 = Date.now()
  let template: StudyTemplate | null = null
  let lastErr: unknown
  let attempts = 0
  const usage = { prompt_tokens: 0, cached_prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 }
  const attemptMs: number[] = []
  for (attempts = 1; attempts <= 2 && !template; attempts++) {
    if (attempts > 1) {
      // Retry with fewer pages (~60% of the first excerpt) and record what was actually sent.
      const retry = buildExcerpt(Math.round(first.text.length * 0.6))
      excerpt = retry.text
      lastPageUsed = retry.last
    }
    const ta = Date.now()
    try {
      template = await chat({
        adapter,
        systemPrompts: [SYSTEM_PROMPT],
        messages: [
          {
            role: 'user',
            content: `Learning style: ${style}.\nCreate a study guide for this excerpt (pages ${start}-${lastPageUsed}).\n\nEXCERPT:\n${excerpt}`,
          },
        ],
        outputSchema: StudyTemplateSchema,
        // Token accounting across attempts (fires for the structured-output call too).
        middleware: [
          {
            name: 'usage-capture',
            onUsage: (_ctx: unknown, u: any) => {
              usage.prompt_tokens += u.promptTokens ?? 0
              usage.cached_prompt_tokens += u.promptTokensDetails?.cachedTokens ?? 0
              usage.completion_tokens += u.completionTokens ?? 0
              usage.reasoning_tokens += u.completionTokensDetails?.reasoningTokens ?? 0
            },
          },
        ],
        modelOptions: modelOptionsFor(attempts),
      })
    } catch (e) {
      lastErr = e
      log('generate_attempt_failed', { materialId, provider, model, attempt: attempts, ms: Date.now() - ta, error: e instanceof Error ? e.message : String(e) })
    }
    attemptMs.push(Date.now() - ta)
  }
  attempts -= 1
  const ms = Date.now() - t0
  if (!template) throw new HttpError(502, `AI generation failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)

  template = normalize(template)
  const price = PRICES_USD_PER_M[model]
  const cost_usd = price
    ? +(
        ((usage.prompt_tokens - usage.cached_prompt_tokens) * price.input +
          usage.cached_prompt_tokens * (price.cached ?? price.input) +
          usage.completion_tokens * price.output) /
        1e6
      ).toFixed(6)
    : null
  const generation = {
    provider,
    model,
    sdk:
      provider === 'openai'
        ? '@tanstack/ai + @tanstack/ai-openai (Responses API, non-streaming structured output)'
        : '@tanstack/ai + @tanstack/ai-cloudflare (Workers AI binding)',
    source_pages: { start, end: lastPageUsed, requested_end: requestedEnd, total: pageCount },
    // true when fewer pages than requested were sent (char budget, page cap, or a shorter retry)
    input_chars: excerpt.length,
    truncated: lastPageUsed < requestedEnd,
    limits: { max_pages: maxPages, max_input_chars: maxChars },
    attempts,
    attempt_ms: attemptMs,
    usage, // completion_tokens include reasoning_tokens
    cost_usd,
    reasoning_effort: effort ?? null,
    generate_ms: ms,
    learning_style: style,
  }
  const contentKey = `templates/${materialId}/${Date.now()}.json`
  const contentStr = JSON.stringify(template)
  await env.PDFS.put(contentKey, contentStr, { httpMetadata: { contentType: 'application/json' } })
  const hash = await sha256(contentStr)
  log('generated', { materialId, model, ms, attempts, sections: template.sections.length, questions: template.practice_questions.length })
  return { template, generation, content_r2_key: contentKey, content_hash: hash }
}

/** Light cleanup of common small-model slips (duplicates, fenced/unsafe Mermaid). */
function normalize(t: StudyTemplate): StudyTemplate {
  const seen = new Set<string>()
  const practice_questions = t.practice_questions
    .filter((q) => {
      const k = q.question.trim().toLowerCase()
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map((q) => ({ ...q, choices: q.type === 'multiple_choice' ? q.choices : [] }))
  return fixLatexEscapes({
    ...t,
    practice_questions,
    diagrams: t.diagrams
      .map((d) => ({ ...d, mermaid: safeMermaid(d.mermaid) }))
      .filter((d) => d.mermaid.length > 0),
  })
}

/**
 * Small models write LaTeX like "\text{...}" or "\frac" inside JSON without doubling the backslash, so
 * JSON.parse turns "\t"/"\f"/"\b"/"\r" into control characters ("\text" -> TAB + "ext"). Restore them.
 */
const LATEX_CTRL: [RegExp, string][] = [
  [/\t(?=ext|imes|heta|au|o\b|riangle|frac)/g, '\\t'],
  [/\f(?=rac|orall)/g, '\\f'],
  [/\x08(?=eta|ar|egin|inom|oxed)/g, '\\b'],
  [/\r(?=ightarrow|ho|angle)/g, '\\r'],
]
function fixLatexEscapes<T>(value: T): T {
  if (typeof value === 'string') {
    let s: string = value
    for (const [re, rep] of LATEX_CTRL) s = s.replace(re, rep)
    return s as T
  }
  if (Array.isArray(value)) return value.map(fixLatexEscapes) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixLatexEscapes(v)])) as T
  }
  return value
}

/**
 * Strip code fences and quote square-bracket node labels: small models put (), {}, = etc. inside
 * `A[...]` labels, which Mermaid parses as shape syntax. `A["..."]` accepts any text.
 */
function safeMermaid(src: string): string {
  return src
    .replace(/^```(?:mermaid)?\s*|\s*```$/g, '')
    .replace(/\b([A-Za-z][\w-]*)\[(?!")([^\]\n]*)\]/g, (_m, id: string, label: string) => `${id}["${label.replace(/"/g, '#quot;')}"]`)
    .trim()
}

/**
 * Long non-streaming Workers AI calls on some models (seen with @cf/qwen/qwen3.8-27b, ~5.5k output
 * tokens) fail with "408 AiError: Request timeout" (code 3046) after ~6 min, while the same request
 * streamed finishes in ~110 s. This wraps the AI binding so a `stream: false` chat call is sent with
 * `stream: true` and the SSE is folded back into one OpenAI chat.completion JSON. TanStack AI still
 * sees a normal non-streaming response, and the fold is a single cheap pass (low CPU).
 */
function streamAggregatingBinding(ai: Ai): Ai {
  const run = ai.run.bind(ai) as (m: string, i: Record<string, unknown>, o?: Record<string, unknown>) => Promise<unknown>
  const wrapped = {
    run: async (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => {
      if (inputs?.stream === true || !Array.isArray(inputs?.messages)) return run(model, inputs, options)
      const res = (await run(model, { ...inputs, stream: true }, { ...options, returnRawResponse: true })) as Response
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res
      const text = await res.text()
      let content = ''
      let reasoning = ''
      let finish: string | null = null
      let usage: unknown
      let id = ''
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        let e: any
        try {
          e = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (e.id) id = e.id
        if (e.usage) usage = e.usage
        const c = e.choices?.[0]
        if (c?.delta?.content) content += c.delta.content
        const r = c?.delta?.reasoning_content ?? c?.delta?.reasoning
        if (typeof r === 'string') reasoning += r
        if (c?.finish_reason) finish = c.finish_reason
        if (typeof e.response === 'string') content += e.response // native Workers AI stream shape
      }
      const body = {
        id: id || `agg-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            finish_reason: finish ?? 'stop',
            message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
          },
        ],
        usage,
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  return new Proxy(ai, { get: (t, k) => (k === 'run' ? wrapped.run : Reflect.get(t, k)) }) as Ai
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)))

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
