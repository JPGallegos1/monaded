import { useCallback, useState } from 'react'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import { publishTemplateOnchain, type PublishApiResult } from '../api'
import { monToWei } from '../format'
import type { PublishResult } from '../types'

export type PublishStatus = 'idle' | 'publishing' | 'done' | 'error'

export type UsePublishTemplateResult = {
  status: PublishStatus
  error: string | null
  result: PublishResult | null
  publish: (args: {
    templateId: string
    /** Price in MON (decimal string). */
    priceMon: string
  }) => Promise<PublishResult | null>
  reset: () => void
}

function formatPublishError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/bad_parent|not published on-chain/i.test(msg)) {
    return (
      'Cannot publish this fork: the parent template is not published on-chain yet ' +
      '(or the parent link is missing). Fork from a published marketplace template, then retry.'
    )
  }
  if (/rate_limited/i.test(msg)) {
    return 'Publish/fork rate limit exceeded. Try again later.'
  }
  return msg
}

/**
 * Publish via POST /templates/{id}/publish (relayer publishFor).
 * Onchain parentId comes from DB parent_template_id — never from the client.
 */
export function usePublishTemplate(): UsePublishTemplateResult {
  const { authenticated, login } = usePrivySession()
  const [status, setStatus] = useState<PublishStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublishResult | null>(null)

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setResult(null)
  }, [])

  const publish = useCallback(
    async (args: { templateId: string; priceMon: string }) => {
      reset()
      if (!authenticated) {
        login()
        setError('Log in to publish')
        setStatus('error')
        return null
      }
      setStatus('publishing')
      try {
        const priceWei = monToWei(args.priceMon)
        const res: PublishApiResult = await publishTemplateOnchain(args.templateId, {
          priceWei: priceWei.toString(),
        })
        const txHash = (res.tx?.txHash ?? '') as `0x${string}`
        if (!txHash.startsWith('0x')) {
          throw new Error('Publish succeeded but no tx hash was returned')
        }
        const out: PublishResult = {
          txHash,
          onchainTemplateId:
            res.tx?.templateId != null ? String(res.tx.templateId) : undefined,
          reconciled: res.reconciled,
          template: res.template,
        }
        setResult(out)
        setStatus('done')
        return out
      } catch (e) {
        setError(formatPublishError(e))
        setStatus('error')
        return null
      }
    },
    [authenticated, login, reset],
  )

  return { status, error, result, publish, reset }
}
