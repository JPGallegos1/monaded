import { txExplorerUrl, weiToMon } from '../format'
import { useBuyTemplate } from '../hooks/useBuyTemplate'
import { useOnchainTemplate } from '../hooks/useOnchainTemplate'
import { usePrivySession } from '#/lib/privy/usePrivySession'

/**
 * Buy panel: hasLicense gate, exact-price buy, verify, insufficient MON messaging.
 * Wire into PR #1 BuyLicenseCard via onBuy={() => buy(...)}.
 */
export function BuyPanel({
  templateUuid,
  onchainTemplateId,
}: {
  templateUuid: string
  onchainTemplateId: number | string | null | undefined
}) {
  const { walletAddress } = usePrivySession()
  const onchain = useOnchainTemplate(onchainTemplateId, walletAddress)
  const { status, error, txHash, fundAddress, alreadyOwned, buy } = useBuyTemplate()

  if (!onchainTemplateId) {
    return <p data-marketplace="buy-unpublished">Not published onchain yet.</p>
  }
  if (onchain.loading) return <p>Loading onchain price…</p>
  if (onchain.error) return <p style={{ color: 'crimson' }}>{onchain.error}</p>
  if (!onchain.exists || !onchain.template) return <p>Onchain template not found.</p>

  const priceWei = onchain.template.price
  const owned = onchain.hasLicense === true || alreadyOwned

  return (
    <div data-marketplace="buy-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, fontFamily: 'monospace' }}>{weiToMon(priceWei)} MON</p>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>One-time license · transferable ERC-1155</p>
      {owned ? (
        <button type="button" disabled>
          You own this license
        </button>
      ) : (
        <button
          type="button"
          disabled={status === 'checking' || status === 'signing' || status === 'confirming' || status === 'verifying'}
          onClick={() =>
            void buy({
              onchainTemplateId,
              priceWei,
              templateUuid,
            }).then((r) => {
              if (r) onchain.refresh()
            })
          }
        >
          {status === 'idle' || status === 'error' || status === 'done'
            ? 'Buy license'
            : `${status}…`}
        </button>
      )}
      {error && (
        <p data-marketplace="buy-error" style={{ color: 'crimson', margin: 0 }}>
          {error}
        </p>
      )}
      {fundAddress && (
        <p data-marketplace="fund-wallet" style={{ margin: 0, fontSize: 13 }}>
          Fund this address on Monad testnet:{' '}
          <code style={{ wordBreak: 'break-all' }}>{fundAddress}</code>
        </p>
      )}
      {txHash && (
        <p style={{ margin: 0 }}>
          <a href={txExplorerUrl(txHash)} target="_blank" rel="noreferrer">
            View buy tx
          </a>
        </p>
      )}
    </div>
  )
}
