import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { templateMarketplaceAbi } from './abi'
import {
  MARKETPLACE_ADDRESS,
  MONAD_CHAIN_ID,
  MONAD_RPC_URL,
  RELAYER_ADDRESS,
  ROYALTY_BPS_PER_LEVEL,
  MAX_LINEAGE_DEPTH,
} from './constants'
import { applyGasBuffer } from './gas'
import type { LineageAncestor, OnchainTemplate, SplitRow, TemplateLineage } from './types'

const monadChain = {
  id: MONAD_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC_URL] } },
} as const

let _publicClient: PublicClient | null = null

export function getMarketplacePublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: monadChain,
      transport: http(MONAD_RPC_URL),
    })
  }
  return _publicClient
}

export async function readExists(templateId: bigint): Promise<boolean> {
  const client = getMarketplacePublicClient()
  return client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'exists',
    args: [templateId],
  })
}

export async function readGetTemplate(templateId: bigint): Promise<OnchainTemplate> {
  const client = getMarketplacePublicClient()
  const t = await client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'getTemplate',
    args: [templateId],
  })
  return {
    id: templateId,
    creator: t.creator,
    paymentToken: t.paymentToken,
    price: t.price,
    parentId: t.parentId,
    metadataURI: t.metadataURI,
  }
}

export async function readUri(templateId: bigint): Promise<string> {
  const client = getMarketplacePublicClient()
  return client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'uri',
    args: [templateId],
  })
}

export async function readHasLicense(account: Address, templateId: bigint): Promise<boolean> {
  const client = getMarketplacePublicClient()
  return client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'hasLicense',
    args: [getAddress(account), templateId],
  })
}

export async function readBalanceOf(account: Address, templateId: bigint): Promise<bigint> {
  const client = getMarketplacePublicClient()
  return client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'balanceOf',
    args: [getAddress(account), templateId],
  })
}

/**
 * previewSplit with zero-amount rows removed (audit Info finding).
 * Role heuristic: index 0 = creator; remaining with amount > 0 = ancestors then optional platform.
 */
export async function readPreviewSplit(templateId: bigint): Promise<SplitRow[]> {
  const client = getMarketplacePublicClient()
  const [recipients, amounts] = await client.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'previewSplit',
    args: [templateId],
  })
  const rows: SplitRow[] = []
  for (let i = 0; i < recipients.length; i++) {
    const amount = amounts[i] ?? 0n
    if (amount === 0n) continue
    let role: SplitRow['role'] = 'ancestor'
    if (i === 0) role = 'creator'
    // Platform fee recipient is last when platformFeeBps > 0; currently 0 on testnet.
    rows.push({ recipient: recipients[i], amount, role })
  }
  return rows
}

const templatePublishedEvent = {
  type: 'event',
  name: 'TemplatePublished',
  inputs: [
    { name: 'templateId', type: 'uint256', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'parentId', type: 'uint256', indexed: true },
    { name: 'price', type: 'uint256', indexed: false },
    { name: 'paymentToken', type: 'address', indexed: false },
    { name: 'metadataURI', type: 'string', indexed: false },
    { name: 'publisher', type: 'address', indexed: false },
  ],
} as const

/** Deploy block of TemplateMarketplace on Monad testnet (see contracts/deployments). */
const MARKETPLACE_FROM_BLOCK = 67_913_228n

/** Whether TemplatePublished.publisher for this id is the official relayer. */
export async function isRelayerPublished(templateId: bigint): Promise<boolean> {
  const client = getMarketplacePublicClient()
  const logs = await client.getLogs({
    address: MARKETPLACE_ADDRESS,
    event: templatePublishedEvent,
    args: { templateId },
    fromBlock: MARKETPLACE_FROM_BLOCK,
    toBlock: 'latest',
  })
  if (!logs.length) return false
  const publisher = logs[0].args.publisher
  if (publisher) {
    return getAddress(publisher) === getAddress(RELAYER_ADDRESS)
  }
  try {
    const decoded = decodeEventLog({
      abi: [templatePublishedEvent],
      data: logs[0].data,
      topics: logs[0].topics,
    })
    if (decoded.eventName !== 'TemplatePublished') return false
    const pub = decoded.args.publisher
    return Boolean(pub && getAddress(pub) === getAddress(RELAYER_ADDRESS))
  } catch {
    return false
  }
}

/** Walk up to 3 parents; mark trusted only when each TemplatePublished.publisher == relayer. */
export async function readLineage(templateId: bigint): Promise<TemplateLineage> {
  const self = await readGetTemplate(templateId)
  const ancestors: LineageAncestor[] = []
  let parentId = self.parentId
  let fullyTrusted = true

  for (let level = 1; level <= MAX_LINEAGE_DEPTH && parentId !== 0n; level++) {
    const exists = await readExists(parentId)
    if (!exists) break
    const t = await readGetTemplate(parentId)
    const trusted = await isRelayerPublished(parentId)
    if (!trusted) fullyTrusted = false
    ancestors.push({
      id: parentId,
      creator: t.creator,
      parentId: t.parentId,
      level,
      trusted,
      earnBps: ROYALTY_BPS_PER_LEVEL,
    })
    parentId = t.parentId
  }

  // Self publish trust matters when this template claims a parent
  if (self.parentId !== 0n) {
    const selfTrusted = await isRelayerPublished(templateId)
    if (!selfTrusted) fullyTrusted = false
  }

  return {
    templateId,
    creator: self.creator,
    ancestors,
    fullyTrusted,
  }
}

export type BuyTxParams = {
  walletClient: WalletClient
  account: Address
  templateId: bigint
  /** Exact onchain price in wei — must match getTemplate.price. */
  priceWei: bigint
}

/**
 * buy(id) with EXACT price as value; gas = estimateGas + 20%.
 * Caller must check hasLicense first (duplicate buys charge again — audit L2).
 */
export async function buyTemplate(params: BuyTxParams): Promise<Hex> {
  const { walletClient, account, templateId, priceWei } = params
  const publicClient = getMarketplacePublicClient()

  const gasEstimate = await publicClient.estimateContractGas({
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'buy',
    args: [templateId],
    account,
    value: priceWei,
  })
  const gas = applyGasBuffer(gasEstimate)

  const hash = await walletClient.writeContract({
    chain: monadChain,
    address: MARKETPLACE_ADDRESS,
    abi: templateMarketplaceAbi,
    functionName: 'buy',
    args: [templateId],
    account,
    value: priceWei,
    gas,
  })
  return hash
}

export async function waitForTx(hash: Hex) {
  return getMarketplacePublicClient().waitForTransactionReceipt({ hash })
}
