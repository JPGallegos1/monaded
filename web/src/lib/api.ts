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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: 'application/json' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return body as T
}

export const getHealth = () => getJson<Health>('/health')
export const getTemplates = () =>
  getJson<{ templates: Template[] }>('/templates').then((r) => r.templates)
