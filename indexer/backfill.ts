#!/usr/bin/env npx tsx
/**
 * One-shot Creator Economy backfill: scan TemplateMarketplace logs from the
 * deploy block (or current indexer_cursor) to tip and POST batches to the api
 * internal ingest endpoint.
 *
 * Auth: INDEXER_INTERNAL_SECRET → header X-Edtech-Internal (same secret as the
 * api Worker). Prefer pointing API_BASE_URL at a local `pywrangler dev` or the
 * deployed workers.dev URL; the cron Worker uses a service binding instead.
 *
 * Env (no secrets committed):
 *   INDEXER_INTERNAL_SECRET  (required)
 *   API_BASE_URL             (default http://127.0.0.1:8787)
 *   MONAD_RPC_URL            (default https://testnet-rpc.monad.xyz)
 *   MARKETPLACE_ADDRESS      (default 0xC8c9…)
 *   MONAD_CHAIN_ID           (default 10143)
 *   LOG_RANGE_SIZE           (default 100 — public RPC hard cap)
 *   BATCH_RANGES             (ranges aggregated per API POST, default 20)
 *   START_BLOCK              (optional override; else cursor+1 or deploy)
 *   END_BLOCK                (optional; else tip)
 *   DRY_RUN                  (if "1", decode + print only, no API writes)
 *
 * Resumable: each successful POST advances indexer_cursor via the api.
 *
 * Usage:
 *   cd indexer && npm ci
 *   export INDEXER_INTERNAL_SECRET=...
 *   export API_BASE_URL=https://edtech-monad-api.<account>.workers.dev
 *   npx tsx backfill.ts
 */
import { createPublicClient, http, type Address, type Log } from 'viem'
import { decodeMarketplaceLogs } from './src/decode.ts'

const DEFAULT_MARKETPLACE = '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e'
const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz'
const DEPLOY_BLOCK = 67913228

function env(name: string, fallback = ''): string {
  return (process.env[name] || fallback).trim()
}

function envInt(name: string, fallback: number): number {
  const v = env(name)
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function withRetries<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const wait = Math.min(8000, 400 * 2 ** i)
      console.warn(`${label} failed (attempt ${i + 1}/${attempts}): ${String(e)}; retry in ${wait}ms`)
      await sleep(wait)
    }
  }
  throw last
}

async function apiJson(
  base: string,
  secret: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('X-Edtech-Internal', secret)
  if (init.body) headers.set('Content-Type', 'application/json')
  const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, headers })
  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 500) }
  }
  if (!resp.ok) {
    throw new Error(`API ${path} HTTP ${resp.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function main() {
  const secret = env('INDEXER_INTERNAL_SECRET')
  const dryRun = env('DRY_RUN') === '1'
  if (!secret && !dryRun) {
    console.error('INDEXER_INTERNAL_SECRET is required (or DRY_RUN=1)')
    process.exit(1)
  }

  const apiBase = env('API_BASE_URL', 'http://127.0.0.1:8787')
  const rpc = env('MONAD_RPC_URL', DEFAULT_RPC)
  const marketplace = env('MARKETPLACE_ADDRESS', DEFAULT_MARKETPLACE).toLowerCase() as Address
  const chainId = envInt('MONAD_CHAIN_ID', 10143)
  const rangeSize = Math.min(envInt('LOG_RANGE_SIZE', 100), 100)
  const batchRanges = envInt('BATCH_RANGES', 20)

  const client = createPublicClient({ transport: http(rpc) })
  const tip = Number(await client.getBlockNumber())

  let start: number
  if (env('START_BLOCK')) {
    start = envInt('START_BLOCK', DEPLOY_BLOCK)
  } else if (!dryRun) {
    const cursorBody = (await apiJson(
      apiBase,
      secret,
      `/internal/indexer/cursor?chain_id=${chainId}&contract=${marketplace}`,
    )) as { cursor?: { last_block?: number } }
    const last = cursorBody.cursor?.last_block
    start = typeof last === 'number' ? last + 1 : DEPLOY_BLOCK
  } else {
    start = DEPLOY_BLOCK
  }

  const end = env('END_BLOCK') ? envInt('END_BLOCK', tip) : tip
  console.log(
    JSON.stringify({
      event: 'backfill_start',
      start,
      end,
      tip,
      rangeSize,
      batchRanges,
      dryRun,
      marketplace,
      apiBase: dryRun ? null : apiBase,
    }),
  )

  if (start > end) {
    console.log('Nothing to do (start > end).')
    return
  }

  let cursor = start
  let totalLogs = 0
  let totalEvents = 0
  let batchLogs: Log[] = []
  let batchFrom: number | null = null
  let batchTo: number | null = null
  let rangesInBatch = 0

  async function flush() {
    if (batchFrom == null || batchTo == null) return
    const times = new Map<number, number>()
    const uniqueBlocks = [...new Set(batchLogs.map((l) => Number(l.blockNumber)))].slice(0, 50)
    for (const bn of uniqueBlocks) {
      try {
        const block = await withRetries(
          () => client.getBlock({ blockNumber: BigInt(bn) }),
          `getBlock ${bn}`,
        )
        times.set(bn, Number(block.timestamp))
      } catch (e) {
        console.warn('block_time skipped', bn, e)
      }
    }
    const events = decodeMarketplaceLogs(batchLogs, times)
    totalEvents += events.length
    console.log(
      JSON.stringify({
        event: 'backfill_batch',
        from_block: batchFrom,
        to_block: batchTo,
        logs: batchLogs.length,
        events: events.length,
        names: Object.fromEntries(
          events.reduce((m, e) => m.set(e.event_name, (m.get(e.event_name) || 0) + 1), new Map()),
        ),
      }),
    )
    if (!dryRun) {
      await withRetries(
        () =>
          apiJson(apiBase, secret, '/internal/indexer/events', {
            method: 'POST',
            body: JSON.stringify({
              chain_id: chainId,
              contract: marketplace,
              from_block: batchFrom,
              to_block: batchTo,
              events,
              advance_cursor: true,
            }),
          }),
        'POST /internal/indexer/events',
      )
    }
    batchLogs = []
    batchFrom = null
    batchTo = null
    rangesInBatch = 0
  }

  while (cursor <= end) {
    const to = Math.min(cursor + rangeSize - 1, end)
    const logs = await withRetries(
      () =>
        client.getLogs({
          address: marketplace,
          fromBlock: BigInt(cursor),
          toBlock: BigInt(to),
        }),
      `getLogs ${cursor}-${to}`,
    )
    if (batchFrom == null) batchFrom = cursor
    batchTo = to
    batchLogs.push(...logs)
    totalLogs += logs.length
    rangesInBatch += 1
    cursor = to + 1
    if (rangesInBatch >= batchRanges || cursor > end) {
      await flush()
    }
  }

  console.log(
    JSON.stringify({
      event: 'backfill_done',
      totalLogs,
      totalEvents,
      final_block: end,
      dryRun,
    }),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
