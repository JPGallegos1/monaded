// Single place where the frontend talks to the backend.
// The web app NEVER talks to Supabase directly — only to the edtech-monad-api Worker.
export const API_URL: string = (
  import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
).replace(/\/+$/, '')

export type Health = {
  ok: boolean
  service: string
  supabase: { configured: boolean; reachable: boolean; status?: number; error?: string }
}

export type Template = {
  id: string
  title: string
  author_id?: string | null
  price_usd?: number | null
  price_mon?: number | null
  royalty_bps?: number | null
  parent_template_id?: string | null
  created_at?: string
  [key: string]: unknown
}

/**
 * In the browser: plain fetch to the public API URL.
 * During SSR (inside the edtech-monad-web Worker): go through the `API` service binding, because a
 * Worker cannot fetch another workers.dev Worker on the same account over the public URL (it 404s).
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (import.meta.env.SSR) {
    const { env } = (await import('cloudflare:workers')) as { env: { API?: Fetcher } }
    if (env.API) return env.API.fetch(`https://edtech-monad-api.internal${path}`, init)
  }
  return fetch(`${API_URL}${path}`, init)
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { headers: { accept: 'application/json' } })
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
  const res = await apiFetch(path, { ...init, headers: { accept: 'application/json', ...init.headers } })
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

export const generateTemplate = (
  id: string,
  opts: { start_page?: number; end_page?: number; learning_style?: string } = {},
) =>
  send<{ template: GeneratedTemplate }>(`/materials/${id}/templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  })

export const getTemplate = (id: string) =>
  getJson<{ template: GeneratedTemplate }>(`/templates/${id}`).then((r) => r.template)
