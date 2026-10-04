import { GAS_BUFFER_BPS } from './constants'

/**
 * Monad charges the full gas LIMIT (not just gas used).
 * Prefer estimateGas + 20% over any fixed ceiling (audit / brief).
 */
export function applyGasBuffer(estimate: bigint, bufferBps: number = GAS_BUFFER_BPS): bigint {
  if (estimate <= 0n) throw new Error('gas estimate must be positive')
  // bufferBps 12000 = 120% of estimate
  return (estimate * BigInt(bufferBps)) / 10_000n
}
