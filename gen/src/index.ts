/**
 * edtech-monad-gen — internal TypeScript Worker (only reachable via the API's `GEN` service binding).
 *
 *   GET  /health
 *   POST /extract   {material_id, r2_key, filename}           -> PDF (R2) -> Workers AI toMarkdown -> pages JSON in R2
 *   POST /generate  {material_id, text_r2_key, start_page?, end_page?, learning_style?}
 *                   -> slice pages -> TanStack AI chat() + outputSchema (Workers AI via @tanstack/ai-cloudflare)
 *                   -> template JSON also stored in R2 (templates/<material>/<ts>.json)
 *
 * It never talks to Supabase; the Python API persists everything.
 */
import { chat } from '@tanstack/ai'
import { CloudflareTextAdapter } from '@tanstack/ai-cloudflare'
import { StudyTemplateSchema, type StudyTemplate } from './schema'

export interface Env {
  AI: Ai
  PDFS: R2Bucket
  AI_MODEL: string
  MAX_PAGES: string
  MAX_INPUT_CHARS: string
  MAX_OUTPUT_TOKENS: string
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
      if (pathname === '/health') return json({ ok: true, service: 'edtech-monad-gen', model: env.AI_MODEL })
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

  let excerpt = ''
  let lastPageUsed = start - 1
  for (let p = start; p <= end; p++) {
    const chunk = `\n[Page ${p}]\n${pageText(p)}\n`
    if (excerpt.length + chunk.length > maxChars) {
      if (p === start) excerpt = chunk.slice(0, maxChars) // single huge page
      if (p === start) lastPageUsed = p
      break
    }
    excerpt += chunk
    lastPageUsed = p
  }
  const truncated = lastPageUsed < requestedEnd
  if (!excerpt.trim()) throw new HttpError(422, 'selected pages contain no extractable text')

  const style = typeof body.learning_style === 'string' && body.learning_style ? body.learning_style : 'balanced'
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast'
  // Cast: the adapter pins @cloudflare/workers-types v4, this project uses v5 (identical runtime binding).
  const adapter = new NonStreamingCloudflareText({ binding: env.AI as any }, model)

  const t0 = Date.now()
  let template: StudyTemplate | null = null
  let lastErr: unknown
  let attempts = 0
  for (attempts = 1; attempts <= 2 && !template; attempts++) {
    try {
      template = await chat({
        adapter,
        systemPrompts: [SYSTEM_PROMPT],
        messages: [
          {
            role: 'user',
            content: `Learning style: ${style}.\nCreate a study guide for this excerpt (pages ${start}-${lastPageUsed}).\n\nEXCERPT:\n${attempts === 1 ? excerpt : excerpt.slice(0, Math.round(excerpt.length * 0.6))}`,
          },
        ],
        outputSchema: StudyTemplateSchema,
        // Retry (after e.g. finish_reason=length from a repetition loop) uses a shorter excerpt and a
        // mild repetition penalty.
        modelOptions: {
          max_tokens: Number(env.MAX_OUTPUT_TOKENS) || 6000,
          temperature: attempts === 1 ? 0.3 : 0.2,
          ...(attempts > 1 ? { repetition_penalty: 1.1 } : {}),
        },
      })
    } catch (e) {
      lastErr = e
      log('generate_attempt_failed', { materialId, attempt: attempts, error: e instanceof Error ? e.message : String(e) })
    }
  }
  attempts -= 1
  const ms = Date.now() - t0
  if (!template) throw new HttpError(502, `AI generation failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)

  template = normalize(template)
  const generation = {
    model,
    sdk: '@tanstack/ai + @tanstack/ai-cloudflare (Workers AI binding)',
    source_pages: { start, end: lastPageUsed, requested_end: requestedEnd, total: pageCount },
    input_chars: excerpt.length,
    truncated,
    limits: { max_pages: maxPages, max_input_chars: maxChars },
    attempts,
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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)))

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
