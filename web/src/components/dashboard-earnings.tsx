import { useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { EarningsCard, type EarningsRecentRow } from '#/components/earnings-card'
import { showToast } from '#/components/toast'
import {
  txExplorerUrl,
  useMyEarnings,
  usePendingWithdrawal,
  useWithdrawEarnings,
  weiToMonDisplay,
} from '#/features/marketplace'

/**
 * Dashboard earnings: /me/earnings for totals/history + live pendingWithdrawals + withdraw().
 * Until PR #6 deploys, the API hook reports "unavailable" and the card stays empty
 * (unless there is on-chain pending to withdraw).
 */
export function DashboardEarnings() {
  const navigate = useNavigate()
  const earnings = useMyEarnings()
  const pending = usePendingWithdrawal()
  const { withdraw, withdrawing, reset } = useWithdrawEarnings()

  const totals = earnings.data?.totals
  const totalEarnedMon = totals ? weiToMonDisplay(totals.earned) : '0'
  const salesMon = totals ? weiToMonDisplay(totals.sales) : '0'
  const forkRoyaltiesMon = totals ? weiToMonDisplay(totals.royalties) : '0'
  const pendingMon = weiToMonDisplay(pending.pendingWei)

  const recent: EarningsRecentRow[] = useMemo(() => {
    const rows = earnings.data?.recent ?? []
    return rows.map((r, i) => {
      const onchainId = String(r.onchain_template_id)
      const templateId = r.template_id
      return {
        id: `${r.tx_hash}-${r.kind}-${onchainId}-${i}`,
        kind: r.kind,
        onchainTemplateId: onchainId,
        templateId,
        templateTitle: templateId ? earnings.templateTitles[templateId] ?? null : null,
        amountMon: weiToMonDisplay(r.amount),
        royaltyLevel: r.level,
        at: r.block_time,
      }
    })
  }, [earnings.data?.recent, earnings.templateTitles])

  return (
    <EarningsCard
      totalEarnedMon={totalEarnedMon}
      salesMon={salesMon}
      forkRoyaltiesMon={forkRoyaltiesMon}
      pendingMon={pendingMon}
      pendingWei={pending.pendingWei}
      recent={recent}
      loading={earnings.status === 'loading'}
      withdrawing={withdrawing}
      onPublish={() => {
        void navigate({ to: '/upload' })
      }}
      onWithdraw={() => {
        const amountLabel = pendingMon
        void withdraw().then((res) => {
          if (!res) return
          pending.refresh()
          earnings.refresh()
          showToast(
            <span>
              Withdrawn {amountLabel} MON.{' '}
              <a
                href={txExplorerUrl(res.txHash)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                View transaction
              </a>
            </span>,
          )
          reset()
        })
      }}
    />
  )
}
