import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useMarketplaceCatalog } from '#/features/marketplace'

export const Route = createFileRoute('/templates')({
  component: Templates,
  head: () => ({ meta: [{ title: 'Marketplace · edtech-monad' }] }),
})

/**
 * Browse/filter published templates.
 * Thin shell — PR #1 can restyle; logic lives in features/marketplace.
 */
function Templates() {
  const [q, setQ] = useState('')
  const [forkedOnly, setForkedOnly] = useState(false)
  const [maxPrice, setMaxPrice] = useState('')
  const { loading, error, templates } = useMarketplaceCatalog({
    q,
    forkedOnly,
    maxPriceMon: maxPrice.trim() ? Number(maxPrice) : undefined,
  })

  return (
    <main className="page-wrap px-4 pb-8 pt-14" data-marketplace="catalog">
      <h1 className="mb-2 text-3xl font-bold text-[var(--sea-ink)]">Marketplace</h1>
      <p className="mb-6 text-sm text-[var(--sea-ink-soft)]">
        Published study templates on Monad testnet. Prices in native MON.
      </p>

      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}
        data-marketplace="filters"
      >
        <input
          type="search"
          placeholder="Search titles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search templates"
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={forkedOnly}
            onChange={(e) => setForkedOnly(e.target.checked)}
          />
          Forks only
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
          Max price (MON)
          <input
            type="number"
            min="0"
            step="0.01"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            style={{ width: 96 }}
          />
        </label>
      </div>

      {error && <p className="text-sm text-red-600">Could not load templates: {error}</p>}
      {loading && <p className="text-sm">Loading…</p>}
      {!loading && templates.length === 0 && (
        <p className="text-sm">No published templates match these filters.</p>
      )}
      {templates.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <article key={t.id} className="island-shell feature-card rounded-2xl p-5">
              <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">
                <Link
                  to="/templates/$templateId"
                  params={{ templateId: t.id }}
                  className="no-underline text-inherit"
                >
                  {t.title}
                </Link>
              </h2>
              <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
                {t.price_mon != null && <>{t.price_mon} MON</>}
                {t.parent_template_id && <> · fork</>}
                {t.onchain_token_id != null && <> · #{String(t.onchain_token_id)}</>}
              </p>
              {typeof t.description === 'string' && t.description && (
                <p className="mt-2 text-sm line-clamp-3">{t.description}</p>
              )}
              <p className="mt-3 text-sm">
                <Link to="/templates/$templateId" params={{ templateId: t.id }}>
                  View details →
                </Link>
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  )
}
