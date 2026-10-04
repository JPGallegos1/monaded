import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { getTemplates, type Template } from '../api'
import { readHasLicense } from '../client'

export type LicensedTemplate = Template & {
  onchain_token_id: string | number
  hasLicense: true
}

/**
 * Library: templates the session wallet holds a license for.
 * Onchain hasLicense/balance is the source of truth (licenses are transferable ERC-1155 — audit M1).
 */
export function useLibraryLicenses(walletAddress?: string | null) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [owned, setOwned] = useState<LicensedTemplate[]>([])

  useEffect(() => {
    if (!walletAddress) {
      setOwned([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const templates = await getTemplates()
        const withIds = templates.filter(
          (t) => t.onchain_token_id != null && String(t.onchain_token_id).trim() !== '',
        )
        const checks = await Promise.all(
          withIds.map(async (t) => {
            const id = BigInt(String(t.onchain_token_id))
            const ok = await readHasLicense(walletAddress as Address, id)
            return ok ? ({ ...t, onchain_token_id: t.onchain_token_id as string | number, hasLicense: true as const }) : null
          }),
        )
        if (!cancelled) {
          setOwned(checks.filter((x): x is LicensedTemplate => x != null))
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  return { loading, error, owned }
}
