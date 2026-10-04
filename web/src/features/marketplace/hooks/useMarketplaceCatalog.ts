import { useEffect, useMemo, useState } from 'react'
import { getTemplates, type Template } from '../api'
import type { MarketplaceListFilters } from '../types'

/**
 * Browse published templates from GET /templates with client-side filters.
 * Onchain enrichment (price/lineage) is done per-card via useOnchainTemplate.
 */
export function useMarketplaceCatalog(filters: MarketplaceListFilters = {}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getTemplates()
      .then((rows) => {
        if (!cancelled) setTemplates(rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = filters.q?.trim().toLowerCase()
    return templates.filter((t) => {
      if (q) {
        const hay = `${t.title ?? ''} ${t.description ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      const price = typeof t.price_mon === 'number' ? t.price_mon : Number(t.price_mon)
      if (filters.minPriceMon != null && !Number.isNaN(price) && price < filters.minPriceMon) {
        return false
      }
      if (filters.maxPriceMon != null && !Number.isNaN(price) && price > filters.maxPriceMon) {
        return false
      }
      if (filters.forkedOnly) {
        const parent = t.parent_template_id
        if (parent == null || parent === '') return false
      }
      return true
    })
  }, [templates, filters.q, filters.minPriceMon, filters.maxPriceMon, filters.forkedOnly])

  return { loading, error, templates: filtered, all: templates }
}
