import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import {
  readExists,
  readGetTemplate,
  readHasLicense,
  readPreviewSplit,
  readUri,
} from '../client'
import type { OnchainTemplate, SplitRow } from '../types'

export type OnchainTemplateState = {
  loading: boolean
  error: string | null
  exists: boolean
  template: OnchainTemplate | null
  uri: string | null
  split: SplitRow[]
  hasLicense: boolean | null
  refresh: () => void
}

/**
 * Read getTemplate / exists / uri / previewSplit / hasLicense for one onchain id.
 */
export function useOnchainTemplate(
  onchainId: number | string | bigint | null | undefined,
  account?: Address | string | null,
): OnchainTemplateState {
  const id =
    onchainId === null || onchainId === undefined || onchainId === ''
      ? null
      : BigInt(onchainId)
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(Boolean(id))
  const [error, setError] = useState<string | null>(null)
  const [exists, setExists] = useState(false)
  const [template, setTemplate] = useState<OnchainTemplate | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [split, setSplit] = useState<SplitRow[]>([])
  const [hasLicense, setHasLicense] = useState<boolean | null>(null)

  useEffect(() => {
    if (id === null) {
      setLoading(false)
      setExists(false)
      setTemplate(null)
      setUri(null)
      setSplit([])
      setHasLicense(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const ex = await readExists(id)
        if (cancelled) return
        setExists(ex)
        if (!ex) {
          setTemplate(null)
          setUri(null)
          setSplit([])
          setHasLicense(null)
          return
        }
        const [tpl, metadataUri, splitRows] = await Promise.all([
          readGetTemplate(id),
          readUri(id),
          readPreviewSplit(id),
        ])
        if (cancelled) return
        setTemplate(tpl)
        setUri(metadataUri)
        setSplit(splitRows)
        if (account) {
          const licensed = await readHasLicense(account as Address, id)
          if (!cancelled) setHasLicense(licensed)
        } else {
          setHasLicense(null)
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
  }, [id, account, tick])

  return {
    loading,
    error,
    exists,
    template,
    uri,
    split,
    hasLicense,
    refresh: () => setTick((t) => t + 1),
  }
}
