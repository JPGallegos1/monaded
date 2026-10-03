import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getTemplates, type Template } from '#/lib/api'

export const Route = createFileRoute('/templates')({ component: Templates })

function Templates() {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTemplates().then(setTemplates).catch((e: Error) => setError(e.message))
  }, [])

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <h1 className="mb-6 text-3xl font-bold text-[var(--sea-ink)]">Published templates</h1>
      {error && <p className="text-sm text-red-600">Could not load templates: {error}</p>}
      {!error && !templates && <p className="text-sm">Loading…</p>}
      {templates && templates.length === 0 && <p className="text-sm">No published templates yet.</p>}
      {templates && templates.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <article key={t.id} className="island-shell feature-card rounded-2xl p-5">
              <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">{t.title}</h2>
              <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
                {t.price_usd != null && <>${t.price_usd} USD </>}
                {t.price_mon != null && <>· {t.price_mon} MON </>}
                {t.royalty_bps != null && <>· royalty {t.royalty_bps / 100}%</>}
              </p>
            </article>
          ))}
        </div>
      )}
    </main>
  )
}
