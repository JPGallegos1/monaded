import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Library as LibraryIcon } from 'lucide-react'
import { Chip } from '#/components/chip'
import { EmptyState } from '#/components/empty-state'
import { Button } from '#/components/ui/button'
import { Badge } from '#/components/ui/badge'
import { coverGradientClass } from '#/lib/utils'
import { getTemplates, type Template } from '#/lib/api'

export const Route = createFileRoute('/library')({
  component: LibraryPage,
  head: () => ({ meta: [{ title: 'Library · Monaded' }] }),
})

type Tab = 'owned' | 'created' | 'forked'

/**
 * Screen 10 — Library.
 * License ownership lives onchain; until Privy + buy() land, we show an empty state
 * (and optionally published templates as browse-only, not as owned).
 */
function LibraryPage() {
  const [tab, setTab] = useState<Tab>('owned')
  const [templates, setTemplates] = useState<Template[] | null>(null)

  useEffect(() => {
    getTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])

  return (
    <main className="page-wrap page-body">
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
          <Chip active={tab === 'forked'} onClick={() => setTab('forked')}>
            Forked
          </Chip>
        </div>
      </div>

      {tab === 'owned' && (
        <EmptyState
          icon={LibraryIcon}
          title="No licenses yet"
          description="Buy a template from the marketplace to add it to your library."
          actionLabel="Browse templates"
          onAction={() => {
            window.location.href = '/templates'
          }}
          todo="list ERC-1155 balances for the Privy embedded wallet; progress tracking not in API yet"
        />
      )}

      {tab === 'created' && (
        <>
          {templates === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {templates && templates.length === 0 && (
            <EmptyState
              title="Nothing created yet"
              description="Upload a PDF to generate and publish a template."
              actionLabel="Create"
              onAction={() => {
                window.location.href = '/upload'
              }}
            />
          )}
          {templates && templates.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {templates.map((t) => (
                <LibraryCard key={t.id} template={t} />
              ))}
            </div>
          )}
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            TODO: filter to templates authored by the signed-in user (showing published catalog as a stand-in)
          </p>
        </>
      )}

      {tab === 'forked' && (
        <EmptyState
          title="No forks yet"
          description="Fork a marketplace template to remix it and republish with royalties."
          todo="list templates where parent_template_id is set and author is the current user"
        />
      )}
    </main>
  )
}

function LibraryCard({ template: t }: { template: Template }) {
  return (
    <article className="surface-card overflow-hidden">
      <div className={cnCover(t.id)} />
      <div className="flex flex-col gap-2.5 p-4">
        <Badge>Study</Badge>
        <h3 className="text-base font-semibold">{t.title}</h3>
        <p className="text-[13px] text-muted-foreground">
          {t.price_mon != null ? `${t.price_mon} MON` : 'Draft / unpublished'}
        </p>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs font-medium text-muted-foreground">
            <span>Progress</span>
            <span>—</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-0 rounded-full bg-primary" />
          </div>
        </div>
        <Link to="/templates/$templateId" params={{ templateId: t.id }} className="no-underline">
          <Button variant="secondary" className="w-full">
            Open template
          </Button>
        </Link>
      </div>
    </article>
  )
}

function cnCover(seed: string) {
  return `h-[100px] w-full ${coverGradientClass(seed)}`
}
