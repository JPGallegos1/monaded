/** GET /me/earnings — Creator Economy API (ships with PR #6). Amounts are wei strings. */

export type MeEarningsTotals = {
  earned: string
  sales: string
  royalties: string
  pending_withdrawal: string
  withdrawn: string
}

export type MeEarningsRecentItem = {
  kind: 'sale' | 'royalty'
  onchain_template_id: number | string
  template_id: string | null
  amount: string
  level: number | null
  counterparty: string | null
  tx_hash: string
  block_time: string
}

export type MeEarningsResponse = {
  wallet: string
  token: string
  totals: MeEarningsTotals
  recent: MeEarningsRecentItem[]
}
