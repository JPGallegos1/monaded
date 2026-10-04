// Single place where the frontend talks to the backend.
// The web app NEVER talks to Supabase directly — only to the edtech-monad-api Worker
// (browser: same-origin `/api/*` proxy on the web Worker; SSR: `API` service binding).

/** Browser always uses same-origin `/api` so the session cookie is first-party. */
export const API_URL: string = '/api'

export type Health = {
  ok: boolean
  service: string
  supabase: { configured: boolean; reachable: boolean; status?: number; error?: string }
}

export type Template = {
  id: string
  title: string
  description?: string | null
  author_id?: string | null
  price_usd?: number | null
  price_mon?: number | null
  royalty_bps?: number | null
  parent_template_id?: string | null
  onchain_token_id?: string | number | null
  is_published?: boolean | null
  publish_tx_hash?: string | null
  created_at?: string
  [key: string]: unknown
}

/**
 * Browser: same-origin `/api/*` (proxied by web Worker → API binding).
 * SSR: `API` service binding, forwarding the incoming Cookie header.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('accept')) headers.set('accept', 'application/json')

  if (import.meta.env.SSR) {
    // Forward the browser session cookie into the API binding call.
    try {
      const { getRequestHeader } = await import('@tanstack/react-start/server')
      const cookie = getRequestHeader('cookie')
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
    } catch {
      // Outside a request context (build-time) — no cookie to forward.
    }
    try {
      const { env } = (await import('cloudflare:workers')) as { env: { API?: Fetcher } }
      if (env.API) {
        return env.API.fetch(`https://edtech-monad-api.internal${path}`, { ...init, headers })
      }
    } catch {
      // fall through to direct URL (local vite SSR without binding)
    }
    const direct = (import.meta.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
    return fetch(`${direct}${path}`, { ...init, headers, credentials: 'include' })
  }

  return fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return body as T
}

export const getHealth = () => getJson<Health>('/health')
export const getTemplates = () =>
  getJson<{ templates: Template[] }>('/templates').then((r) => r.templates)

// ---- Day 2: materials + AI-generated study templates ----------------------

export type Material = {
  id: string
  title: string
  r2_key: string
  owner_id?: string | null
  file_size_bytes?: number | null
  page_count?: number | null
  status: 'uploaded' | 'processing' | 'ready' | 'failed'
  error?: string | null
  created_at?: string
}

export type StudyTemplateContent = {
  title: string
  summary: string
  learning_objectives: string[]
  sections: { heading: string; explanation: string; key_concepts: string[] }[]
  definitions: { term: string; definition: string }[]
  worked_examples: { title: string; problem: string; steps: string[]; answer: string }[]
  practice_questions: {
    question: string
    type: 'multiple_choice' | 'short_answer' | 'computation'
    choices: string[]
    answer: string
    explanation: string
  }[]
  diagrams: { title: string; description: string; mermaid: string }[]
}

export type GeneratedTemplate = Template & {
  material_id?: string | null
  description?: string | null
  status?: 'generating' | 'ready' | 'failed'
  error?: string | null
  content?: StudyTemplateContent | null
  generation?: {
    model?: string
    source_pages?: { start: number; end: number; requested_end: number; total: number }
    truncated?: boolean
    generate_ms?: number
    input_chars?: number
    limits?: { max_pages: number; max_input_chars: number }
  } | null
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export function uploadMaterial(file: File, title?: string) {
  const form = new FormData()
  form.append('file', file)
  if (title) form.append('title', title)
  return send<{ material: Material }>('/materials', { method: 'POST', body: form })
}

export const extractMaterial = (id: string) =>
  send<{ material: Material; page_count: number; suggested_start_page: number; extract_ms: number }>(
    `/materials/${id}/extract`,
    { method: 'POST' },
  )

export const generateTemplate = (id: string, opts: { start_page?: number; end_page?: number } = {}) =>
  send<{ template: GeneratedTemplate }>(`/materials/${id}/templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  })

export const getTemplate = (id: string) =>
  getJson<{ template: GeneratedTemplate }>(`/templates/${id}`).then((r) => r.template)

/** Session-authenticated profile upsert (userId always taken from the cookie session). */
export function upsertUser(profile: { email?: string; display_name?: string; learning_style?: string } = {}) {
  return send<{ user: unknown }>('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  })
}
