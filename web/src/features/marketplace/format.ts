import { formatEther, parseEther } from 'viem'
import { EXPLORER_ADDRESS_BASE, EXPLORER_TX_BASE } from './constants'

/** Parse a MON decimal string (e.g. "0.01") to wei. */
export function monToWei(mon: string): bigint {
  const trimmed = mon.trim()
  if (!trimmed || Number.isNaN(Number(trimmed))) {
    throw new Error('Enter a valid price in MON')
  }
  if (Number(trimmed) <= 0) {
    throw new Error('Price must be greater than zero')
  }
  return parseEther(trimmed)
}

/** Format wei as a human MON string (trim trailing zeros). */
export function weiToMon(wei: bigint | string | number): string {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei)
  const full = formatEther(value)
  if (!full.includes('.')) return full
  return full.replace(/\.?0+$/, '')
}

/**
 * Format wei → MON for earnings UI: at most `maxDecimals` places, no trailing zeros.
 */
export function weiToMonDisplay(wei: bigint | string | number, maxDecimals = 4): string {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei)
  const full = formatEther(value)
  if (!full.includes('.')) return full
  const [intPart, frac = ''] = full.split('.')
  const clipped = frac.slice(0, maxDecimals).replace(/0+$/, '')
  return clipped ? `${intPart}.${clipped}` : intPart
}

export function txExplorerUrl(txHash: string): string {
  return `${EXPLORER_TX_BASE}/${txHash}`
}

export function addressExplorerUrl(address: string): string {
  return `${EXPLORER_ADDRESS_BASE}/${address}`
}

export function shortAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`
}

/** Detect insufficient-funds style errors from viem / wallet / RPC. */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return (
    lower.includes('insufficient funds') ||
    lower.includes('insufficient balance') ||
    lower.includes('exceeds the balance') ||
    lower.includes('gas required exceeds') ||
    // Privy / common RPC codes
    lower.includes('code: -32000') ||
    lower.includes('insufficient mon')
  )
}
