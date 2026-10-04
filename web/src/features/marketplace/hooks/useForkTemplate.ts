import { useCallback, useState } from 'react'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import {
  forkTemplate,
  publishTemplateOnchain,
  type GeneratedTemplate,
  type PublishApiResult,
} from '../api'
import { monToWei } from '../format'
import type { PublishResult } from '../types'

export type ForkStatus = 'idle' | 'creating' | 'publishing' | 'done' | 'error'

/**
 * Fork = create DB copy with parent_template_id, then publish (relayer sets onchain parent).
 * Aligns with PR #3 deriving parentId from DB lineage.
 */
export function useForkTemplate() {
  const { authenticated, login } = usePrivySession()
  const [status, setStatus] = useState<ForkStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [forked, setForked] = useState<GeneratedTemplate | null>(null)
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setForked(null)
    setPublishResult(null)
  }, [])

  const createFork = useCallback(
    async (parentTemplateId: string, opts: { title?: string } = {}) => {
      if (!authenticated) {
        login()
        setError('Log in to fork')
        setStatus('error')
        return null
      }
      setStatus('creating')
      setError(null)
      try {
        const { template } = await forkTemplate(parentTemplateId, opts)
        setForked(template)
        setStatus('idle')
        return template
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return null
      }
    },
    [authenticated, login],
  )

  const createAndPublish = useCallback(
    async (args: {
      parentTemplateId: string
      title?: string
      priceMon: string
      /** Onchain parent id — required on main today; PR #3 will derive it from DB instead. */
      parentOnchainId?: number | string
    }) => {
      reset()
      if (!authenticated) {
        login()
        setError('Log in to fork')
        setStatus('error')
        return null
      }
      setStatus('creating')
      try {
        const { template } = await forkTemplate(args.parentTemplateId, { title: args.title })
        setForked(template)
        setStatus('publishing')
        const priceWei = monToWei(args.priceMon)
        const parentId =
          args.parentOnchainId != null && String(args.parentOnchainId).trim() !== ''
            ? Number(args.parentOnchainId)
            : 0
        // Also sets parent_template_id in DB via fork; PR #3 will prefer DB over body.
        const res: PublishApiResult = await publishTemplateOnchain(template.id, {
          priceWei: priceWei.toString(),
          parentId,
        })
        const txHash = (res.tx?.txHash ?? '') as `0x${string}`
        if (!txHash.startsWith('0x')) {
          throw new Error('Publish succeeded but no tx hash was returned')
        }
        const published: PublishResult = {
          txHash,
          onchainTemplateId:
            res.tx?.templateId != null ? String(res.tx.templateId) : undefined,
          reconciled: res.reconciled,
          template: res.template,
        }
        setPublishResult(published)
        setStatus('done')
        return { template, publish: published }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return null
      }
    },
    [authenticated, login, reset],
  )

  return {
    status,
    error,
    forked,
    publishResult,
    createFork,
    createAndPublish,
    reset,
  }
}
