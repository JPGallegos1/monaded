import { useCallback, useState } from 'react'
import { useWallets } from '@privy-io/react-auth'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import { withdrawPending, waitForTx } from '../client'
import { pickEmbeddedWallet, walletClientFromPrivy } from '../wallet'

export type WithdrawStatus = 'idle' | 'signing' | 'confirming' | 'done' | 'error'

/**
 * Call TemplateMarketplace.withdraw() via the Privy embedded wallet.
 */
export function useWithdrawEarnings() {
  const { authenticated, login, walletAddress } = usePrivySession()
  const { wallets } = useWallets()
  const [status, setStatus] = useState<WithdrawStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null)

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setTxHash(null)
  }, [])

  const withdraw = useCallback(async () => {
    reset()
    if (!authenticated) {
      login()
      setError('Log in to withdraw')
      setStatus('error')
      return null
    }
    const wallet = pickEmbeddedWallet(wallets, walletAddress)
    if (!wallet || !walletAddress) {
      setError('No embedded wallet found. Log in again to create one.')
      setStatus('error')
      return null
    }
    setStatus('signing')
    try {
      const { walletClient, account } = await walletClientFromPrivy(wallet, walletAddress)
      const hash = await withdrawPending({ walletClient, account })
      setTxHash(hash)
      setStatus('confirming')
      await waitForTx(hash)
      setStatus('done')
      return { txHash: hash }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
      return null
    }
  }, [authenticated, login, reset, walletAddress, wallets])

  return {
    status,
    error,
    txHash,
    withdrawing: status === 'signing' || status === 'confirming',
    withdraw,
    reset,
  }
}
