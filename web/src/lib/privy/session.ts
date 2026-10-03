/**
 * Auth-aware API helpers: exchange Privy tokens for an HttpOnly session cookie,
 * then call the API with credentials included. Wallet address is never sent from the client.
 */
import { API_URL } from '../api'
import { getAccessToken } from '@privy-io/react-auth'

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (import.meta.env.SSR) {
    const { env } = (await import('cloudflare:workers')) as { env: { API?: Fetcher } }
    if (env.API) return env.API.fetch(`https://edtech-monad-api.internal${path}`, init)
  }
  return fetch(`${API_URL}${path}`, { ...init, credentials: 'include' })
}

export type SessionInfo = {
  ok: boolean
  userId?: string
  walletAddress?: string
  exp?: number
  error?: string
}

/** Exchange Privy access (+ optional identity) token for a server session cookie. */
export async function createServerSession(opts?: {
  accessToken?: string
  identityToken?: string | null
}): Promise<SessionInfo> {
  const accessToken = opts?.accessToken ?? (await getAccessToken())
  if (!accessToken) throw new Error('Not authenticated with Privy')
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }
  if (opts?.identityToken) headers['Privy-Id-Token'] = opts.identityToken
  const res = await apiFetch('/auth/session', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const body = (await res.json().catch(() => ({}))) as SessionInfo
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export async function getServerSession(): Promise<SessionInfo> {
  const res = await apiFetch('/auth/session', {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  return (await res.json().catch(() => ({ ok: false }))) as SessionInfo
}

export async function logoutServerSession(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST', headers: { accept: 'application/json' } })
}

/** Auth-aware JSON fetch (sends session cookie). */
export async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export async function verifyPurchase(input: {
  txHash: string
  onchainTemplateId: number | string
  templateId?: string
}) {
  return authedJson<{ ok: boolean; purchase: unknown }>('/purchases/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tx_hash: input.txHash,
      onchain_template_id: input.onchainTemplateId,
      template_id: input.templateId,
    }),
  })
}

export async function publishTemplate(
  templateId: string,
  input: { priceWei: string | number; parentId?: number; uri?: string },
) {
  return authedJson<{ ok: boolean; tx: { txHash: string } }>(`/templates/${templateId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      price_wei: input.priceWei,
      parent_id: input.parentId ?? 0,
      uri: input.uri,
    }),
  })
}
