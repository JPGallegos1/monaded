/**
 * Marketplace API helpers (same-origin `/api` proxy). Never call Supabase from web.
 */
import { apiFetch, type GeneratedTemplate, type StudyTemplateContent, type Template } from '#/lib/api'
import { publishTemplate, verifyPurchase } from '#/lib/privy/session'

export type { Template, GeneratedTemplate, StudyTemplateContent }

export type PublishApiResult = {
  ok: boolean
  template?: Template
  tx?: { txHash?: string; templateId?: string | number }
  reconciled?: boolean
}

export async function publishTemplateOnchain(
  templateId: string,
  input: { priceWei: string | number },
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
    const b = body as { error?: string; code?: string }
    const msg = b.error ?? `HTTP ${res.status}`
    throw new Error(b.code ? `${msg} (${b.code})` : msg)
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
    const b = body as { error?: string; code?: string }
    const msg = b.error ?? `HTTP ${res.status}`
    if (b.code === 'bad_parent' || /not published on-chain/i.test(msg)) {
      throw new Error(
        'Cannot fork: parent template is not published on-chain yet. Buy/publish the parent first.',
      )
    }
    if (b.code === 'rate_limited' || /rate limit/i.test(msg)) {
      throw new Error('Fork/publish rate limit exceeded. Try again later.')
    }
    throw new Error(b.code ? `${msg} (${b.code})` : msg)
  }
  return body as { template: GeneratedTemplate }
}

export { getTemplates, getTemplate } from '#/lib/api'
