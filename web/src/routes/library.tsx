import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Library as LibraryIcon } from 'lucide-react'
import { Chip } from '#/components/chip'
import { EmptyState } from '#/components/empty-state'
import { Button } from '#/components/ui/button'
import { Badge } from '#/components/ui/badge'
import { useLibraryLicenses } from '#/features/marketplace'
import { getTemplates, type Template } from '#/lib/api'
import { isPrivyConfigured } from '#/lib/privy/config'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import { coverGradientClass } from '#/lib/utils'

export const Route = createFileRoute('/library')({
  component: LibraryPage,
  head: () => ({ meta: [{ title: 'Library · Monaded' }] }),
})

type Tab = 'owned' | 'created'

/**
 * Screen 10 v0.2 — Owned / Created. No progress bar; purchase date only if the API provides it.
 */
function LibraryPage() {
  if (!isPrivyConfigured()) {
    return (
      <main className="page-wrap page-body">
        <EmptyState
          icon={LibraryIcon}
          title="Sign in unavailable"
          description="Set VITE_PRIVY_APP_ID to enable your library."
        />
      </main>
    )
  }
  return <LibraryAuthed />
}

function LibraryAuthed() {
  const navigate = useNavigate()
  const { ready, authenticated, login, walletAddress, session } = usePrivySession()
  const { loading, error, owned } = useLibraryLicenses(authenticated ? walletAddress : null)
  const [tab, setTab] = useState<Tab>('owned')
  const [created, setCreated] = useState<Template[] | null>(null)

  useEffect(() => {
    if (!authenticated || !session?.userId) {
      setCreated([])
      return
    }
    let cancelled = false
    getTemplates()
      .then((rows) => {
        if (cancelled) return
        setCreated(rows.filter((t) => t.author_id === session.userId))
      })
      .catch(() => {
        if (!cancelled) setCreated([])
      })
    return () => {
      cancelled = true
    }
  }, [authenticated, session?.userId])

  return (
    <main className="page-wrap page-body" data-marketplace="library">
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight">Your library</h1>
          <p className="mt-2 max-w-xl text-base text-muted-foreground">
            Templates you own a license for. Your access lives in your wallet, so it&apos;s always
            yours.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip active={tab === 'owned'} onClick={() => setTab('owned')}>
            Owned
          </Chip>
          <Chip active={tab === 'created'} onClick={() => setTab('created')}>
            Created
          </Chip>
        </div>
      </div>

      {!ready ? (
        <p className="text-sm text-muted-foreground">Loading auth…</p>
      ) : !authenticated ? (
        <EmptyState
          icon={LibraryIcon}
          title="Sign in to see your library"
          description="Log in to check licenses held by your Monaded wallet."
          actionLabel="Sign in"
          onAction={() => login()}
        />
      ) : (
        <>
          {tab === 'owned' && (
            <>
              {loading && (
                <p className="text-sm text-muted-foreground">Checking onchain licenses…</p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              {!loading && owned.length === 0 && (
                <EmptyState
                  icon={LibraryIcon}
                  title="No licenses yet"
                  description="Buy a template from the marketplace to add it to your library."
                  actionLabel="Browse templates"
                  onAction={() => {
                    void navigate({ to: '/templates' })
                  }}
                />
              )}
              {owned.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {owned.map((t) => (
                    <LibraryCard key={t.id} template={t} owned />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'created' && (
            <>
              {created === null && <p className="text-sm text-muted-foreground">Loading…</p>}
              {created && created.length === 0 && (
                <EmptyState
                  title="Nothing created yet"
                  description="Upload a PDF to generate and publish a template."
                  actionLabel="Create"
                  onAction={() => {
                    void navigate({ to: '/upload' })
                  }}
                />
              )}
              {created && created.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {created.map((t) => (
                    <LibraryCard key={t.id} template={t} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  )
}

function LibraryCard({
  template: t,
  owned,
}: {
  template: Template
  owned?: boolean
}) {
  const creator = t.author_id ? shortId(t.author_id) : null
  const purchaseDate = purchaseDateLabel(t)

  return (
    <article className="surface-card overflow-hidden">
      <div className={`h-[100px] w-full ${coverGradientClass(t.id)}`} />
      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap gap-1.5">
          <Badge>Study</Badge>
          {owned && <Badge variant="outline">Owned</Badge>}
        </div>
        <h3 className="text-base font-semibold">{t.title}</h3>
        {creator && <p className="text-[13px] text-muted-foreground">by {creator}</p>}
        {purchaseDate && (
          <p className="text-xs text-muted-foreground">Purchased {purchaseDate}</p>
        )}
        <Link to="/templates/$templateId" params={{ templateId: t.id }} className="no-underline">
          <Button variant="secondary" className="w-full">
            Open template
          </Button>
        </Link>
      </div>
    </article>
  )
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

/** Show purchase date only when the API actually returns one (never invent). */
function purchaseDateLabel(t: Template): string | null {
  const raw =
    (typeof t.purchased_at === 'string' && t.purchased_at) ||
    (typeof t.verified_at === 'string' && t.verified_at) ||
    (typeof t.purchase_date === 'string' && t.purchase_date) ||
    null
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
