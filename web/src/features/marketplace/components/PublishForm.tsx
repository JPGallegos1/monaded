import { useState } from 'react'
import { txExplorerUrl } from '../format'
import { usePublishTemplate } from '../hooks/usePublishTemplate'

/**
 * Thin publish form: price in MON only.
 * Lineage/parent is set via /fork (DB parent_template_id); the API ignores client parent_id.
 * PR #1 PublishDialog can call the same usePublishTemplate hook.
 */
export function PublishForm({
  templateId,
  defaultPriceMon = '0.01',
  /** When set, show that this draft will publish as a fork of the given DB parent. */
  parentTemplateId,
}: {
  templateId: string
  defaultPriceMon?: string
  parentTemplateId?: string | null
}) {
  const [priceMon, setPriceMon] = useState(defaultPriceMon)
  const { status, error, result, publish } = usePublishTemplate()

  return (
    <form
      data-marketplace="publish-form"
      onSubmit={(e) => {
        e.preventDefault()
        void publish({ templateId, priceMon })
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
      {parentTemplateId ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
          Fork of template <code>{parentTemplateId}</code>. Onchain parent id is resolved from the
          database at publish time (client cannot override royalties).
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
          To set lineage, use Fork on a published template first — do not pass a parent id here.
        </p>
      )}
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
