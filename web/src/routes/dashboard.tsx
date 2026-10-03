import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  Coins,
  Files,
  GitFork,
  LayoutDashboard,
  Library,
  Plus,
  Settings,
  Ticket,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { EmptyState } from '#/components/empty-state'
import { StatCard } from '#/components/stat-card'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { getTemplates, type Template } from '#/lib/api'
import { cn, formatMon } from '#/lib/utils'

export const Route = createFileRoute('/dashboard')({
  component: Dashboard,
  head: () => ({ meta: [{ title: 'Dashboard · Monaded' }] }),
})

const SIDE = [
  { label: 'Overview', icon: LayoutDashboard, active: true },
  { label: 'My templates', icon: Files, active: false },
  { label: 'Library', icon: Library, active: false, to: '/library' },
  { label: 'Earnings', icon: Coins, active: false },
  { label: 'Settings', icon: Settings, active: false },
] as const

function Dashboard() {
  const [templates, setTemplates] = useState<Template[] | null>(null)

  useEffect(() => {
    // Best-effort: show published templates as a stand-in until "my templates" exists.
    getTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])

  return (
    <main className="flex min-h-[70vh]">
      <aside className="hidden w-60 shrink-0 border-r border-border py-8 md:block">
        <nav className="flex flex-col gap-1 px-4">
          {SIDE.map((item) => {
            const className = cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm',
              item.active
                ? 'bg-accent font-semibold text-accent-foreground'
                : 'font-medium text-muted-foreground hover:bg-muted',
            )
            if ('to' in item && item.to) {
              return (
                <Link key={item.label} to={item.to} className={cn(className, 'no-underline')}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              )
            }
            return (
              <span key={item.label} className={className}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </span>
            )
          })}
        </nav>
      </aside>

      <div className="page-body flex-1 px-6 lg:px-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Creator dashboard</h1>
            <p className="mt-1.5 text-base text-muted-foreground">
              Track templates, sales and royalties once wallet auth is connected.
            </p>
          </div>
          <Link to="/upload" className="no-underline">
            <Button>
              <Plus className="h-4 w-4" />
              New template
            </Button>
          </Link>
        </div>

        <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Wallet balance"
            value="—"
            delta="Connect wallet to see balance"
            icon={Wallet}
            deltaMuted
          />
          <StatCard
            label="Sales revenue"
            value="—"
            delta="TODO: sales from API / chain"
            icon={TrendingUp}
            deltaMuted
          />
          <StatCard
            label="Royalties from forks"
            value="—"
            delta="TODO: royalty events"
            icon={GitFork}
            deltaMuted
          />
          <StatCard
            label="Licenses sold"
            value="—"
            delta="TODO: license counts"
            icon={Ticket}
            deltaMuted
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div>
            <h2 className="mb-3 text-lg font-semibold">My templates</h2>
            {templates === null && <p className="text-sm text-muted-foreground">Loading…</p>}
            {templates && templates.length === 0 && (
              <EmptyState
                icon={Files}
                title="No templates yet"
                description="Upload a PDF to create your first study template."
                actionLabel="Upload PDF"
                onAction={() => {
                  window.location.href = '/upload'
                }}
                todo="filter templates by the signed-in creator once Privy + POST /users is wired"
              />
            )}
            {templates && templates.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-left text-xs font-semibold text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">TEMPLATE</th>
                      <th className="px-4 py-3">PRICE</th>
                      <th className="px-4 py-3">SALES</th>
                      <th className="px-4 py-3">FORKS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.slice(0, 8).map((t) => (
                      <tr key={t.id} className="border-t border-border">
                        <td className="px-4 py-3 font-medium">
                          <Link
                            to="/templates/$templateId"
                            params={{ templateId: t.id }}
                            className="no-underline hover:text-primary"
                          >
                            {t.title}
                          </Link>
                        </td>
                        <td className="px-4 py-3 font-mono">{formatMon(t.price_mon)}</td>
                        <td className="px-4 py-3 text-muted-foreground">—</td>
                        <td className="px-4 py-3 text-muted-foreground">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-border bg-muted/50 px-4 py-2 font-mono text-xs text-muted-foreground">
                  TODO: sales / forks / earned columns need API + onchain indexing (no fake numbers)
                </p>
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-lg font-semibold">Recent activity</h2>
            <Card className="p-5">
              <EmptyState
                className="border-0 p-4 shadow-none"
                title="No activity yet"
                description="Sales, forks and royalty payouts will show up here."
                todo="subscribe to TemplateMarketplace events after Privy wallet is connected"
              />
            </Card>
          </div>
        </div>
      </div>
    </main>
  )
}
