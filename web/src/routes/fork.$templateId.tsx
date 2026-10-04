import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { getTemplate, type GeneratedTemplate } from '#/lib/api'
import {
  LineageView,
  txExplorerUrl,
  useForkTemplate,
  useOnchainTemplate,
} from '#/features/marketplace'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import AuthButton from '#/components/AuthButton'

export const Route = createFileRoute('/fork/$templateId')({
  loader: ({ params }) => getTemplate(params.templateId),
  head: ({ loaderData }) => ({
    meta: [{ title: `Fork · ${loaderData?.title ?? 'Template'} · edtech-monad` }],
  }),
  component: ForkPage,
  errorComponent: ({ error }) => (
    <main className="page-wrap px-4 pt-14">
      <p className="text-red-600">
        Could not load template to fork:{' '}
        {error instanceof Error ? error.message : String(error)}
      </p>
    </main>
  ),
})

/**
 * Fork flow: create DB copy with parent_template_id, then publish with price.
 * Lineage shows who earns 10% per ancestor level (up to 3).
 */
function ForkPage() {
  const parent = Route.useLoaderData() as GeneratedTemplate
  const navigate = useNavigate()
  const { authenticated, login } = usePrivySession()
  const onchainId =
    parent.onchain_token_id != null ? String(parent.onchain_token_id) : null
  const onchain = useOnchainTemplate(onchainId)
  const { status, error, forked, publishResult, createAndPublish } = useForkTemplate()

  const [title, setTitle] = useState(
    parent.content?.title ? `${parent.content.title} (fork)` : `${parent.title} (fork)`,
  )
  const [priceMon, setPriceMon] = useState(
    parent.price_mon != null ? String(parent.price_mon) : '0.01',
  )

  return (
    <main className="page-wrap px-4 pb-8 pt-10" data-marketplace="fork">
      <p className="mb-4 text-sm">
        Forking “{parent.title}”. You need a license (or ownership). After publish, ancestors earn
        10% each (up to 3 levels).
      </p>

      {!authenticated && (
        <div className="mb-4 flex flex-col gap-2 text-sm">
          <p>Log in to create and publish a fork.</p>
          <AuthButton />
        </div>
      )}

      <div style={{ display: 'grid', gap: 32, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>License price (MON)</span>
            <input
              type="number"
              min="0"
              step="0.001"
              value={priceMon}
              onChange={(e) => setPriceMon(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!authenticated || status === 'creating' || status === 'publishing'}
            onClick={() => {
              if (!authenticated) {
                login()
                return
              }
              void createAndPublish({
                parentTemplateId: parent.id,
                title,
                priceMon,
              }).then((res) => {
                if (res?.template) {
                  navigate({
                    to: '/templates/$templateId',
                    params: { templateId: res.template.id },
                  })
                }
              })
            }}
          >
            {status === 'creating'
              ? 'Creating fork…'
              : status === 'publishing'
                ? 'Publishing…'
                : 'Create fork & publish'}
          </button>
          {error && <p style={{ color: 'crimson' }}>{error}</p>}
          {forked && (
            <p className="text-sm">
              Draft fork created:{' '}
              <Link to="/templates/$templateId" params={{ templateId: forked.id }}>
                {forked.title}
              </Link>
            </p>
          )}
          {publishResult && (
            <p className="text-sm">
              Published.{' '}
              <a href={txExplorerUrl(publishResult.txHash)} target="_blank" rel="noreferrer">
                View tx on MonadVision
              </a>
            </p>
          )}
        </div>

        <div>
          <h3 style={{ marginTop: 0 }}>Who earns after you publish</h3>
          <p style={{ fontSize: 13, opacity: 0.8 }}>
            Parent onchain id: {onchainId ?? '—'}
            {onchain.template && <> · creator {onchain.template.creator}</>}
          </p>
          <LineageView onchainTemplateId={onchainId} />
        </div>
      </div>
    </main>
  )
}
