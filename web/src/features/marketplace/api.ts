/**
 * Marketplace API helpers (same-origin `/api` proxy). Never call Supabase from web.
 */
import { apiFetch, type GeneratedTemplate, type StudyTemplateContent, type Template } from '#/lib/api'
import { publishTemplate, verifyPurchase } from '#/lib/privy/session'
import type { MeEarningsResponse } from './types-earnings'

export type { Template, GeneratedTemplate, StudyTemplateContent }
export type { MeEarningsResponse, MeEarningsRecentItem, MeEarningsTotals } from './types-earnings'

export type PublishApiResult = {
  ok: boolean
  template?: Template
  tx?: { txHash?: string; templateId?: string | number }
  reconciled?: boolean
}

export async function publishTemplateOnchain(
  templateId: string,
  input: { priceWei: string | number; parentId?: number },
): Promise<PublishApiResult> {
  return publishTemplate(templateId, input) as Promise<PublishApiResult>
}

export async function verifyPurchaseTx(input: {
  txHash: string
  onchainTemplateId?: number | string
  templateId?: string
}) {
  return verifyPurchase(input)
}

/** Full content — session required; API checks ownership or onchain hasLicense. */
export async function getGatedTemplateContent(templateId: string): Promise<{
  template: GeneratedTemplate
  access: 'owner' | 'license'
}> {
  const res = await apiFetch(`/templates/${templateId}/content`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return body as { template: GeneratedTemplate; access: 'owner' | 'license' }
}

/** Create a draft fork (DB parent_template_id set) ready for publish. */
export async function forkTemplate(
  parentTemplateId: string,
  input: { title?: string } = {},
): Promise<{ template: GeneratedTemplate }> {
  const res = await apiFetch(`/templates/${parentTemplateId}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return body as { template: GeneratedTemplate }
}

export { getTemplates, getTemplate } from '#/lib/api'

/**
 * Creator earnings summary + latest 5 events (PR #6).
 * Returns `null` when the endpoint is missing (404) or the network fails so the UI
 * can degrade to the empty card until #6 is deployed.
 * Throws on 401 so callers can treat "not signed in" separately.
 */
export async function getMyEarnings(): Promise<MeEarningsResponse | null> {
  try {
    const res = await apiFetch('/me/earnings')
    if (res.status === 404) return null
    if (res.status === 401) throw new Error('Sign in to view earnings')
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Other server errors: treat as unavailable (endpoint may be mid-deploy).
      return null
    }
    return body as MeEarningsResponse
  } catch (e) {
    if (e instanceof Error && e.message === 'Sign in to view earnings') throw e
    return null
  }
}
