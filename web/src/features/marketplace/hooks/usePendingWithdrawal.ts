import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { readPendingWithdrawals } from '../client'
import { usePrivySession } from '#/lib/privy/usePrivySession'

/**
 * Live pending MON from pendingWithdrawals(address(0), wallet).
 * Prefer this over /me/earnings.pending_withdrawal (indexer lag ~1 min).
 */
export function usePendingWithdrawal() {
  const { walletAddress } = usePrivySession()
  const [pendingWei, setPendingWei] = useState<bigint>(0n)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!walletAddress) {
      setPendingWei(0n)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    readPendingWithdrawals(walletAddress as Address)
      .then((v) => {
        if (!cancelled) setPendingWei(v)
      })
      .catch((e) => {
        if (!cancelled) {
          setPendingWei(0n)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [walletAddress, tick])

  return { pendingWei, loading, error, refresh }
}
