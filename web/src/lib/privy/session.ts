/**
 * Auth-aware API helpers: exchange Privy tokens for an HttpOnly session cookie,
 * then call the API with credentials included. Wallet address is never sent from the client.
 *
 * Browser traffic goes through same-origin `/api/*` (see web/src/server.ts proxy).
 */
import { apiFetch } from '../api'
import { getAccessToken } from '@privy-io/react-auth'

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
  const res = await apiFetch('/auth/session', { method: 'GET' })
  return (await res.json().catch(() => ({ ok: false }))) as SessionInfo
}

export async function logoutServerSession(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' })
}

/** Auth-aware JSON fetch (sends session cookie via same-origin `/api`). */
export async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export async function verifyPurchase(input: {
  txHash: string
  onchainTemplateId?: number | string
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
  input: { priceWei: string | number; parentId?: number },
) {
  return authedJson<{ ok: boolean; tx: { txHash: string } }>(`/templates/${templateId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      price_wei: input.priceWei,
      parent_id: input.parentId ?? 0,
      // uri is built server-side — never send it from the client
    }),
  })
}
