/**
 * Marketplace API helpers (same-origin `/api` proxy). Never call Supabase from web.
 */
import {
  apiFetch,
  type GeneratedTemplate,
  type PublicSectionRef,
  type StudyTemplateContent,
  type Template,
} from '#/lib/api'
import { publishTemplate, verifyPurchase } from '#/lib/privy/session'

export type { Template, GeneratedTemplate, StudyTemplateContent, PublicSectionRef }

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
