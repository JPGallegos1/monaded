/**
 * Minimal chain helper Worker — signs TemplateMarketplace.publishFor with the
 * relayer key. Bound to edtech-monad-api as `CHAIN` (service binding).
 *
 * Why a TS Worker: secp256k1 signing in pure Python exceeds Workers Free
 * (~10 ms CPU). viem runs in the V8 isolate with acceptable CPU.
 *
 * Secrets: RELAYER_PRIVATE_KEY
 * Vars: MARKETPLACE_ADDRESS, MONAD_RPC_URL, MONAD_CHAIN_ID
 */
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
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'edtech-monad-chain' })
    }
    if (request.method === 'POST' && url.pathname === '/publishFor') {
      try {
        const body = (await request.json()) as {
          creator?: string
          priceWei?: string | number
          parentId?: string | number
          uri?: string
        }
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
        const priceWei = BigInt(body.priceWei ?? 0)
        const parentId = BigInt(body.parentId ?? 0)
        if (priceWei <= 0n) {
          return json({ error: 'price must be positive' }, 400)
        }
        if (!env.RELAYER_PRIVATE_KEY) {
          return json({ error: 'RELAYER_PRIVATE_KEY not configured' }, 503)
        }
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

        const hash = await client.writeContract({
          address: marketplace,
          abi: marketplaceAbi,
          functionName: 'publishFor',
          args: [creator as Address, priceWei, parentId, uri],
          account,
          chain: monadTestnet,
        })

        const receipt = await client.waitForTransactionReceipt({ hash })
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

        return json({ txHash: hash, relayer: account.address, templateId }, 200)
      } catch (e) {
        // Log full error server-side; return a generic message to callers.
        console.error('publishFor failed', e)
        return json({ error: 'publish transaction failed' }, 502)
      }
    }
    return json({ error: 'not found' }, 404)
  },
}
