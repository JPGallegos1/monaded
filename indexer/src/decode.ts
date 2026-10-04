import { decodeEventLog, type Hex, type Log } from 'viem'
import { INDEXED_EVENT_NAMES, marketplaceEventsAbi } from './abi'

export type DecodedIndexerEvent = {
  event_name: string
  args: Record<string, unknown>
  block_number: number
  block_time: number | null
  tx_hash: string
  log_index: number
}

function serializeArg(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(serializeArg)
  if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
    return value.toLowerCase()
  }
  return value
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    // viem includes both named and numeric keys; keep named only.
    if (/^\d+$/.test(k)) continue
    out[k] = serializeArg(v)
  }
  return out
}

/**
 * Decode a single eth_getLogs result into an indexer event payload, or null if
 * the log is not one of the TemplateMarketplace events we persist.
 */
export function decodeMarketplaceLog(
  log: Log,
  blockTimeByNumber: Map<number, number> = new Map(),
): DecodedIndexerEvent | null {
  let decoded: { eventName: string; args: Record<string, unknown> } | null = null
  try {
    const result = decodeEventLog({
      abi: marketplaceEventsAbi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: false,
    })
    decoded = {
      eventName: result.eventName,
      args: result.args as unknown as Record<string, unknown>,
    }
  } catch {
    return null
  }
  if (!INDEXED_EVENT_NAMES.has(decoded.eventName)) return null

  const blockNumber = Number(log.blockNumber)
  const logIndex = Number(log.logIndex)
  const txHash = (log.transactionHash || '').toLowerCase()
  if (!Number.isFinite(blockNumber) || !Number.isFinite(logIndex) || !txHash.startsWith('0x')) {
    return null
  }

  return {
    event_name: decoded.eventName,
    args: serializeArgs(decoded.args),
    block_number: blockNumber,
    block_time: blockTimeByNumber.get(blockNumber) ?? null,
    tx_hash: txHash,
    log_index: logIndex,
  }
}

export function decodeMarketplaceLogs(
  logs: Log[],
  blockTimeByNumber: Map<number, number> = new Map(),
): DecodedIndexerEvent[] {
  const out: DecodedIndexerEvent[] = []
  for (const log of logs) {
    const ev = decodeMarketplaceLog(log, blockTimeByNumber)
    if (ev) out.push(ev)
  }
  // Stable order for idempotent batches
  out.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)
  return out
}
