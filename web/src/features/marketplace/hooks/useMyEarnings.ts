import { useCallback, useEffect, useState } from 'react'
import { getMyEarnings, getTemplate, type MeEarningsResponse } from '../api'
import { usePrivySession } from '#/lib/privy/usePrivySession'

export type EarningsAvailability =
  | 'loading'
  | 'ready'
  /** 401 or 404 — show empty card (endpoint missing / no session data). */
  | 'unavailable'
  | 'unauthenticated'
  /** Network or 5xx — show error + Retry; do not use the empty card. */
  | 'error'

export type UseMyEarningsResult = {
  status: EarningsAvailability
  error: string | null
  data: MeEarningsResponse | null
  /** Resolved titles for recent.template_id (null when unknown / missing). */
  templateTitles: Record<string, string>
  refresh: () => void
}

/**
 * GET /me/earnings via the Python API (session cookie).
 * Only 401/404 → "unavailable". Network and 5xx → "error" (Retry).
 */
export function useMyEarnings(): UseMyEarningsResult {
  const { ready, authenticated } = usePrivySession()
  const [tick, setTick] = useState(0)
  const [status, setStatus] = useState<EarningsAvailability>('loading')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<MeEarningsResponse | null>(null)
  const [templateTitles, setTemplateTitles] = useState<Record<string, string>>({})

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!ready) {
      setStatus('loading')
      return
    }
    if (!authenticated) {
      setData(null)
      setTemplateTitles({})
      setStatus('unauthenticated')
      setError(null)
      return
    }

    let cancelled = false
    setStatus('loading')
    setError(null)
    getMyEarnings()
      .then(async (res) => {
        if (cancelled) return
        if (res == null) {
          setData(null)
          setTemplateTitles({})
          setStatus('unavailable')
          return
        }
        setData(res)
        setStatus('ready')

        const ids = [
          ...new Set(
            res.recent
              .map((r) => r.template_id)
              .filter((id): id is string => typeof id === 'string' && id.length > 0),
          ),
        ]
        if (ids.length === 0) {
          setTemplateTitles({})
          return
        }
        const entries = await Promise.all(
          ids.map(async (id) => {
            try {
              const t = await getTemplate(id)
              return [id, t.title] as const
            } catch {
              return [id, ''] as const
            }
          }),
        )
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const [id, title] of entries) {
          if (title) map[id] = title
        }
        setTemplateTitles(map)
      })
      .catch((e) => {
        if (cancelled) return
        setData(null)
        setTemplateTitles({})
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [ready, authenticated, tick])

  return { status, error, data, templateTitles, refresh }
}
