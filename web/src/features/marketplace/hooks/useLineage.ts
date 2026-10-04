import { useEffect, useState } from 'react'
import { readLineage } from '../client'
import type { TemplateLineage } from '../types'

/** Up to 3 ancestor levels + trust flags (relayer-published only). */
export function useLineage(onchainId: number | string | bigint | null | undefined) {
  const id =
    onchainId === null || onchainId === undefined || onchainId === ''
      ? null
      : BigInt(onchainId)
  const [loading, setLoading] = useState(Boolean(id))
  const [error, setError] = useState<string | null>(null)
  const [lineage, setLineage] = useState<TemplateLineage | null>(null)

  useEffect(() => {
    if (id === null) {
      setLineage(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    readLineage(id)
      .then((v) => {
        if (!cancelled) setLineage(v)
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
  }, [id])

  return { loading, error, lineage }
}
