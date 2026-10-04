import { useCallback, useState } from 'react'
import { useWallets } from '@privy-io/react-auth'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import { verifyPurchaseTx } from '../api'
import { buyTemplate, readHasLicense, waitForTx } from '../client'
import { isInsufficientFundsError } from '../format'
import { pickEmbeddedWallet, walletClientFromPrivy } from '../wallet'

export type BuyStatus = 'idle' | 'checking' | 'signing' | 'confirming' | 'verifying' | 'done' | 'error'

export type UseBuyTemplateResult = {
  status: BuyStatus
  error: string | null
  txHash: `0x${string}` | null
  /** Set when the embedded wallet needs MON. */
  fundAddress: string | null
  alreadyOwned: boolean
  buy: (args: {
    onchainTemplateId: number | string | bigint
    priceWei: bigint
    templateUuid?: string
  }) => Promise<{ txHash: `0x${string}` } | null>
  reset: () => void
}

/**
 * Buy flow: hasLicense guard → writeContract buy(exact price) → POST /purchases/verify.
 * Gas = estimate + 20%. Blocks double purchase (audit L2).
 */
export function useBuyTemplate(): UseBuyTemplateResult {
  const { walletAddress, authenticated, login } = usePrivySession()
  const { wallets } = useWallets()
  const [status, setStatus] = useState<BuyStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null)
  const [fundAddress, setFundAddress] = useState<string | null>(null)
  const [alreadyOwned, setAlreadyOwned] = useState(false)

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setTxHash(null)
    setFundAddress(null)
    setAlreadyOwned(false)
  }, [])

  const buy = useCallback(
    async (args: {
      onchainTemplateId: number | string | bigint
      priceWei: bigint
      templateUuid?: string
    }) => {
      reset()
      if (!authenticated) {
        login()
        setError('Log in to buy a license')
        setStatus('error')
        return null
      }
      const wallet = pickEmbeddedWallet(wallets, walletAddress)
      if (!wallet || !walletAddress) {
        setError('No embedded wallet found. Log in again to create one.')
        setStatus('error')
        return null
      }

      const templateId = BigInt(args.onchainTemplateId)
      setStatus('checking')
      try {
        const owned = await readHasLicense(walletAddress as `0x${string}`, templateId)
        if (owned) {
          setAlreadyOwned(true)
          setError('You already hold a license for this template. Duplicate purchases are charged twice onchain.')
          setStatus('error')
          return null
        }

        setStatus('signing')
        const { walletClient, account } = await walletClientFromPrivy(wallet, walletAddress)
        const hash = await buyTemplate({
          walletClient,
          account,
          templateId,
          priceWei: args.priceWei,
        })
        setTxHash(hash)
        setStatus('confirming')
        await waitForTx(hash)

        setStatus('verifying')
        await verifyPurchaseTx({
          txHash: hash,
          onchainTemplateId: templateId.toString(),
          templateId: args.templateUuid,
        })
        setStatus('done')
        return { txHash: hash }
      } catch (e) {
        if (isInsufficientFundsError(e)) {
          setFundAddress(walletAddress)
          setError(
            `Insufficient MON. Embedded wallets start at 0 — send testnet MON to ${walletAddress} (price + gas), then retry.`,
          )
        } else {
          setError(e instanceof Error ? e.message : String(e))
        }
        setStatus('error')
        return null
      }
    },
    [authenticated, login, reset, walletAddress, wallets],
  )

  return { status, error, txHash, fundAddress, alreadyOwned, buy, reset }
}
