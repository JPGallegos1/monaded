/**
 * Minimal chain helper Worker — signs TemplateMarketplace.publishFor with the
 * relayer key. Bound to edtech-monad-api as `CHAIN` (service binding).
 *
 * Why a TS Worker: secp256k1 signing in pure Python exceeds Workers Free
 * (~10 ms CPU). viem runs in the V8 isolate with acceptable CPU.
 *
 * RelayerDO: single-flight coordinator so concurrent publishFor *sends* cannot
 * collide on the same EOA nonce (see contracts/README.md).
 *
 * Endpoints:
 *   POST /publishFor/send    — sign+broadcast; returns {txHash} immediately
 *   POST /publishFor/receipt — wait for receipt of a prior txHash; parse event
 *   POST /publishFor         — send then receipt (legacy convenience)
 *
 * Secrets: RELAYER_PRIVATE_KEY
 * Vars: MARKETPLACE_ADDRESS, MONAD_RPC_URL, MONAD_CHAIN_ID
 */
import { DurableObject } from 'cloudflare:workers'
import {
  createWalletClient,
  http,
  publicActions,
  parseEventLogs,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'

const marketplaceAbi = [
  {
    type: 'function',
    name: 'publishFor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'price', type: 'uint256' },
      { name: 'parentId', type: 'uint256' },
      { name: 'uri_', type: 'string' },
    ],
    outputs: [{ name: 'templateId', type: 'uint256' }],
  },
  {
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
  },
] as const

const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
  },
})

export interface Env {
  RELAYER_PRIVATE_KEY: string
  MARKETPLACE_ADDRESS?: string
  MONAD_RPC_URL?: string
  MONAD_CHAIN_ID?: string
  RELAYER: DurableObjectNamespace
}

type PublishBody = {
  creator?: string
  priceWei?: string | number
  parentId?: string | number
  uri?: string
}

type ReceiptBody = {
  txHash?: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function validatePublishBody(body: PublishBody): Response | null {
  const creator = body.creator
  const uri = body.uri
  if (!creator || !creator.startsWith('0x') || creator.length !== 42) {
    return json({ error: 'creator required' }, 400)
  }
  if (!uri || typeof uri !== 'string') {
    return json({ error: 'uri required' }, 400)
  }
  if (uri.length > 2048) {
    return json({ error: 'uri too long' }, 400)
  }
  try {
    const priceWei = BigInt(body.priceWei ?? 0)
    if (priceWei <= 0n) {
      return json({ error: 'price must be positive' }, 400)
    }
    BigInt(body.parentId ?? 0)
  } catch {
    return json({ error: 'invalid priceWei or parentId' }, 400)
  }
  return null
}

function makeClient(env: Env) {
  const pk = env.RELAYER_PRIVATE_KEY.startsWith('0x')
    ? (env.RELAYER_PRIVATE_KEY as Hex)
    : (`0x${env.RELAYER_PRIVATE_KEY}` as Hex)
  const account = privateKeyToAccount(pk)
  const rpc = env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz'
  const marketplace = (env.MARKETPLACE_ADDRESS ||
    '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e') as Address
  const client = createWalletClient({
    account,
    chain: monadTestnet,
    transport: http(rpc),
  }).extend(publicActions)
  return { account, marketplace, client }
}

/** Sign + broadcast only. Returns the tx hash immediately (no receipt wait). */
async function sendPublishFor(env: Env, body: PublishBody): Promise<Response> {
  if (!env.RELAYER_PRIVATE_KEY) {
    return json({ error: 'RELAYER_PRIVATE_KEY not configured' }, 503)
  }
  const creator = body.creator as Address
  const uri = body.uri as string
  const priceWei = BigInt(body.priceWei ?? 0)
  const parentId = BigInt(body.parentId ?? 0)
  const { account, marketplace, client } = makeClient(env)

  const hash = await client.writeContract({
    address: marketplace,
    abi: marketplaceAbi,
    functionName: 'publishFor',
    args: [creator, priceWei, parentId, uri],
    account,
    chain: monadTestnet,
  })

  return json({ txHash: hash, relayer: account.address }, 200)
}

/** Wait for a previously sent tx and parse TemplatePublished. */
async function waitPublishReceipt(env: Env, txHash: Hex): Promise<Response> {
  if (!env.RELAYER_PRIVATE_KEY) {
    return json({ error: 'RELAYER_PRIVATE_KEY not configured' }, 503)
  }
  const { account, client } = makeClient(env)

  let receipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash: txHash })
  } catch (e) {
    console.error('waitForTransactionReceipt failed', { txHash, error: String(e) })
    return json({ error: 'receipt unavailable', code: 'pending', txHash }, 404)
  }

  if (receipt.status !== 'success') {
    console.error('publishFor reverted', { hash: txHash, status: receipt.status })
    return json({ error: 'publish transaction reverted', code: 'reverted', txHash }, 502)
  }

  let templateId: string | undefined
  try {
    const logs = parseEventLogs({
      abi: marketplaceAbi,
      eventName: 'TemplatePublished',
      logs: receipt.logs,
    })
    if (logs[0]?.args?.templateId !== undefined) {
      templateId = logs[0].args.templateId.toString()
    }
  } catch (parseErr) {
    console.error('TemplatePublished parse failed', parseErr)
  }

  return json({ txHash, relayer: account.address, templateId }, 200)
}

/**
 * Single Durable Object instance serializes all relayer *writes*.
 * blockConcurrencyWhile keeps the input gate closed across the send so two
 * publishFor calls cannot prepare the same EOA nonce concurrently.
 * Receipt waits do NOT hold this lock (nonce already consumed after send).
 */
export class RelayerDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405)
    }
    const url = new URL(request.url)
    let body: PublishBody
    try {
      body = (await request.json()) as PublishBody
    } catch {
      return json({ error: 'invalid JSON body' }, 400)
    }
    const invalid = validatePublishBody(body)
    if (invalid) return invalid

    try {
      // Only the send path needs the concurrency lock.
      if (url.pathname.endsWith('/receipt')) {
        return json({ error: 'use /publishFor/receipt on the worker' }, 400)
      }
      return await this.ctx.blockConcurrencyWhile(() => sendPublishFor(this.env, body))
    } catch (e) {
      console.error('publishFor send failed', e)
      return json({ error: 'publish transaction failed' }, 502)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'edtech-monad-chain' })
    }

    if (request.method === 'POST' && url.pathname === '/publishFor/receipt') {
      let body: ReceiptBody
      try {
        body = (await request.json()) as ReceiptBody
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
      const txHash = body.txHash
      if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
        return json({ error: 'txHash required' }, 400)
      }
      try {
        return await waitPublishReceipt(env, txHash as Hex)
      } catch (e) {
        console.error('publishFor receipt failed', e)
        return json({ error: 'publish receipt failed', txHash }, 502)
      }
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/publishFor/send' || url.pathname === '/publishFor')
    ) {
      let body: PublishBody
      try {
        body = (await request.json()) as PublishBody
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
      const invalid = validatePublishBody(body)
      if (invalid) return invalid
      if (!env.RELAYER_PRIVATE_KEY) {
        return json({ error: 'RELAYER_PRIVATE_KEY not configured' }, 503)
      }
      // Route every write through one RelayerDO so nonces stay serialized.
      const stub = env.RELAYER.get(env.RELAYER.idFromName('relayer'))
      const sendResp = await stub.fetch(
        new Request('https://relayer.internal/publishFor/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
      // Legacy /publishFor: send then receipt in one HTTP call (API prefers split).
      if (url.pathname === '/publishFor/send') {
        return sendResp
      }
      if (!sendResp.ok) return sendResp
      const sent = (await sendResp.json()) as { txHash?: string }
      if (!sent.txHash) {
        return json({ error: 'chain worker missing txHash' }, 502)
      }
      return waitPublishReceipt(env, sent.txHash as Hex)
    }

    return json({ error: 'not found' }, 404)
  },
}
