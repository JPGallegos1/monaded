import type { Address } from 'viem'
import type { PublicSectionRef } from '#/lib/api'

export type { PublicSectionRef }

/** Onchain TemplateMarketplace.Template struct. */
export type OnchainTemplate = {
  id: bigint
  creator: Address
  paymentToken: Address
  price: bigint
  parentId: bigint
  metadataURI: string
}

/** One non-zero row from previewSplit (zero amounts hidden per audit). */
export type SplitRow = {
  recipient: Address
  amount: bigint
  role: 'creator' | 'ancestor' | 'platform'
}

export type LineageAncestor = {
  id: bigint
  creator: Address
  parentId: bigint
  level: number
  /** True when TemplatePublished.publisher == official relayer (audit L3). */
  trusted: boolean
  /** Royalty share at this level (10% of net). */
  earnBps: number
}

export type TemplateLineage = {
  templateId: bigint
  creator: Address
  ancestors: LineageAncestor[]
  /** False if any ancestor (or self when forked) was not relayer-published. */
  fullyTrusted: boolean
}

export type BuyResult = {
  txHash: `0x${string}`
  verified: boolean
}

export type PublishResult = {
  txHash: `0x${string}`
  onchainTemplateId?: string
  reconciled?: boolean
  template?: unknown
}

export type MarketplaceListFilters = {
  q?: string
  minPriceMon?: number
  maxPriceMon?: number
  forkedOnly?: boolean
}

/**
 * Locked-detail outline from public GET /templates/{id}.
 * Shape: `{ section_count: number, sections: [{ title: string | null }] }`
 * Not present on GET /templates (catalog).
 */
export type PublicSectionOutline = {
  section_count: number
  sections: PublicSectionRef[]
}
