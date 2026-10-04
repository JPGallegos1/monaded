/**
 * edtech-monad-indexer — Cron Worker that follows Monad testnet tip for
 * TemplateMarketplace logs and posts decoded batches to edtech-monad-api.
 *
 * Free-plan constraints (measured 2026-10-04 against https://testnet-rpc.monad.xyz):
 *   - eth_getLogs max block range: 100 (RPC error -32614)
 *   - chain tip growth: ~200 blocks/minute
 *   - Workers Free: 50 subrequests / invocation, ~10 ms CPU
 *
 * Cron `* * * * *` with LOG_RANGE_SIZE=100 and RANGES_PER_RUN=35 advances
 * up to 3500 blocks per minute (>> tip growth) while staying under 50 subrequests:
 *   1 eth_blockNumber + 1 API cursor GET + ≤35 getLogs + ≤8 getBlock + 1 API POST.
 */
import { createPublicClient, http, type Address, type Log } from 'viem'
import { decodeMarketplaceLogs, type DecodedIndexerEvent } from './decode'

export interface Env {
  API: Fetcher
  INDEXER_INTERNAL_SECRET: string
  MARKETPLACE_ADDRESS?: string
  MONAD_RPC_URL?: string
  MONAD_CHAIN_ID?: string
  LOG_RANGE_SIZE?: string
  RANGES_PER_RUN?: string
  DEPLOY_BLOCK?: string
}

const API_BASE = 'https://edtech-monad-api.internal'
const DEFAULT_MARKETPLACE = '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e'
const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz'
const DEFAULT_CHAIN_ID = 10143
/** Max getBlock calls per run for block_time enrichment (subrequest budget). */
const MAX_BLOCK_TIME_FETCHES = 8

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function envInt(env: Env, name: keyof Env, fallback: number): number {
  const raw = env[name]
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function marketplace(env: Env): Address {
  return (env.MARKETPLACE_ADDRESS || DEFAULT_MARKETPLACE).toLowerCase() as Address
}

function chainId(env: Env): number {
  return envInt(env, 'MONAD_CHAIN_ID', DEFAULT_CHAIN_ID)
}

async function apiFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const secret = env.INDEXER_INTERNAL_SECRET
  if (!secret) {
    throw new Error('INDEXER_INTERNAL_SECRET not configured')
  }
  const headers = new Headers(init.headers)
  headers.set('X-Edtech-Internal', secret)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return env.API.fetch(`${API_BASE}${path}`, { ...init, headers })
}

async function readCursor(env: Env): Promise<number> {
  const c = marketplace(env)
  const id = chainId(env)
  const resp = await apiFetch(
    env,
    `/internal/indexer/cursor?chain_id=${id}&contract=${c}`,
    { method: 'GET' },
  )
  const text = await resp.text()
  let body: { cursor?: { last_block?: number }; error?: string } = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`cursor parse failed: HTTP ${resp.status}`)
  }
  if (!resp.ok) {
    throw new Error(`cursor HTTP ${resp.status}: ${body.error || text.slice(0, 200)}`)
  }
  const last = body.cursor?.last_block
  if (typeof last !== 'number') {
    throw new Error('cursor missing last_block')
  }
  return last
}

async function postEvents(
  env: Env,
  payload: {
    chain_id: number
    contract: string
    from_block: number
    to_block: number
    events: DecodedIndexerEvent[]
    advance_cursor: boolean
  },
): Promise<unknown> {
  const resp = await apiFetch(env, '/internal/indexer/events', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { error: text.slice(0, 300) }
  }
  if (!resp.ok) {
    throw new Error(`events HTTP ${resp.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function enrichBlockTimes(
  client: ReturnType<typeof createPublicClient>,
  logs: Log[],
): Promise<Map<number, number>> {
  const unique = new Set<number>()
  for (const log of logs) {
    if (log.blockNumber != null) unique.add(Number(log.blockNumber))
  }
  const map = new Map<number, number>()
  const blocks = [...unique].sort((a, b) => a - b).slice(0, MAX_BLOCK_TIME_FETCHES)
  for (const bn of blocks) {
    try {
      const block = await client.getBlock({ blockNumber: BigInt(bn) })
      map.set(bn, Number(block.timestamp))
    } catch (e) {
      console.error('getBlock failed', { block: bn, error: String(e) })
    }
  }
  return map
}

export async function runIndexerTick(env: Env): Promise<{
  ok: boolean
  from_block: number | null
  to_block: number | null
  ranges: number
  logs: number
  events: number
  tip: string
  result?: unknown
  skipped?: string
}> {
  const rangeSize = Math.min(envInt(env, 'LOG_RANGE_SIZE', 100), 100)
  const rangesPerRun = Math.min(envInt(env, 'RANGES_PER_RUN', 35), 40)
  const rpc = env.MONAD_RPC_URL || DEFAULT_RPC
  const address = marketplace(env)
  const id = chainId(env)

  const client = createPublicClient({ transport: http(rpc) })

  const [tip, lastBlock] = await Promise.all([
    client.getBlockNumber(),
    readCursor(env),
  ])

  let start = BigInt(lastBlock) + 1n
  if (start > tip) {
    return {
      ok: true,
      from_block: null,
      to_block: null,
      ranges: 0,
      logs: 0,
      events: 0,
      tip: tip.toString(),
      skipped: 'already_at_tip',
    }
  }

  const allLogs: Log[] = []
  let fromBlock = Number(start)
  let toBlock = Number(start) - 1
  let ranges = 0

  for (let i = 0; i < rangesPerRun && start <= tip; i++) {
    const end = start + BigInt(rangeSize) - 1n > tip ? tip : start + BigInt(rangeSize) - 1n
    try {
      const logs = await client.getLogs({
        address,
        fromBlock: start,
        toBlock: end,
      })
      allLogs.push(...logs)
      toBlock = Number(end)
      ranges += 1
      start = end + 1n
    } catch (e) {
      console.error('eth_getLogs failed', {
        from: start.toString(),
        to: end.toString(),
        error: String(e),
      })
      // Post what we have so far (if any prior ranges succeeded).
      break
    }
  }

  if (ranges === 0) {
    return {
      ok: false,
      from_block: fromBlock,
      to_block: null,
      ranges: 0,
      logs: 0,
      events: 0,
      tip: tip.toString(),
      skipped: 'no_ranges',
    }
  }

  const times = allLogs.length ? await enrichBlockTimes(client, allLogs) : new Map()
  const events = decodeMarketplaceLogs(allLogs, times)

  const result = await postEvents(env, {
    chain_id: id,
    contract: address,
    from_block: fromBlock,
    to_block: toBlock,
    events,
    advance_cursor: true,
  })

  console.log(
    JSON.stringify({
      event: 'indexer_tick',
      from_block: fromBlock,
      to_block: toBlock,
      ranges,
      logs: allLogs.length,
      events: events.length,
      tip: tip.toString(),
    }),
  )

  return {
    ok: true,
    from_block: fromBlock,
    to_block: toBlock,
    ranges,
    logs: allLogs.length,
    events: events.length,
    tip: tip.toString(),
    result,
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        service: 'edtech-monad-indexer',
        marketplace: marketplace(env),
        chain_id: chainId(env),
      })
    }
    // Manual tick for local/dev via service binding (not publicly exposed).
    if (request.method === 'POST' && url.pathname === '/tick') {
      try {
        const out = await runIndexerTick(env)
        return json(out, out.ok ? 200 : 502)
      } catch (e) {
        console.error('tick failed', e)
        return json({ ok: false, error: String(e) }, 502)
      }
    }
    return json({ error: 'not found' }, 404)
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runIndexerTick(env).catch((e) => {
        console.error('scheduled tick failed', e)
      }),
    )
  },
}
