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
 * Fork = create DB copy with parent_template_id, then publish.
 * Onchain parentId is derived server-side from that DB link (client cannot bypass royalties).
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
    async (args: { parentTemplateId: string; title?: string; priceMon: string }) => {
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
        // No parentId in the body — API resolves from template.parent_template_id.
        const res: PublishApiResult = await publishTemplateOnchain(template.id, {
          priceWei: priceWei.toString(),
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
