import { useState } from 'react'
import { txExplorerUrl } from '../format'
import { usePublishTemplate } from '../hooks/usePublishTemplate'

/**
 * Thin publish form: price in MON + optional onchain parent id.
 * PR #1 PublishDialog can call the same usePublishTemplate hook.
 */
export function PublishForm({
  templateId,
  defaultPriceMon = '0.01',
  defaultParentId = 0,
}: {
  templateId: string
  defaultPriceMon?: string
  defaultParentId?: number
}) {
  const [priceMon, setPriceMon] = useState(defaultPriceMon)
  const [parentId, setParentId] = useState(String(defaultParentId || ''))
  const { status, error, result, publish } = usePublishTemplate()

  return (
    <form
      data-marketplace="publish-form"
      onSubmit={(e) => {
        e.preventDefault()
        void publish({
          templateId,
          priceMon,
          parentId: parentId.trim() ? Number(parentId) : 0,
        })
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>License price (MON)</span>
        <input
          type="number"
          min="0"
          step="0.001"
          value={priceMon}
          onChange={(e) => setPriceMon(e.target.value)}
          disabled={status === 'publishing'}
          required
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>Fork of (onchain parent id, optional)</span>
        <input
          type="number"
          min="0"
          step="1"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          disabled={status === 'publishing'}
          placeholder="0 = original"
        />
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          Prefer creating a fork via /fork so parent_template_id is set in the DB (PR #3).
        </span>
      </label>
      <button type="submit" disabled={status === 'publishing'}>
        {status === 'publishing' ? 'Publishing…' : 'Publish on Monad'}
      </button>
      {error && (
        <p data-marketplace="publish-error" style={{ color: 'crimson', margin: 0 }}>
          {error}
        </p>
      )}
      {result && (
        <p data-marketplace="publish-success" style={{ margin: 0 }}>
          Published.{' '}
          <a href={txExplorerUrl(result.txHash)} target="_blank" rel="noreferrer">
            View tx on MonadVision
          </a>
          {result.onchainTemplateId != null && (
            <> · onchain id {result.onchainTemplateId}</>
          )}
          {result.reconciled && <> · reconciled prior broadcast</>}
        </p>
      )}
    </form>
  )
}
