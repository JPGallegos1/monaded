import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import {
  Coins,
  Files,
  LayoutDashboard,
  Library,
  Plus,
  Settings,
  Wallet,
} from 'lucide-react'
import { DashboardEarnings } from '#/components/dashboard-earnings'
import { EmptyState } from '#/components/empty-state'
import { StatCard } from '#/components/stat-card'
import { Button } from '#/components/ui/button'
import { getMarketplacePublicClient, weiToMon } from '#/features/marketplace'
import { getTemplates, type Template } from '#/lib/api'
import { isPrivyConfigured } from '#/lib/privy/config'
import { usePrivySession } from '#/lib/privy/usePrivySession'
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
  if (!isPrivyConfigured()) {
    return (
      <main className="page-wrap page-body">
        <EmptyState
          title="Sign in unavailable"
          description="Set VITE_PRIVY_APP_ID to enable the creator dashboard."
        />
      </main>
    )
  }
  return <DashboardAuthed />
}

function DashboardAuthed() {
  const navigate = useNavigate()
  const { ready, authenticated, login, walletAddress, session } = usePrivySession()
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [balanceMon, setBalanceMon] = useState<string | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  useEffect(() => {
    if (!authenticated || !session?.userId) {
      setTemplates([])
      return
    }
    let cancelled = false
    getTemplates()
      .then((rows) => {
        if (!cancelled) setTemplates(rows.filter((t) => t.author_id === session.userId))
      })
      .catch(() => {
        if (!cancelled) setTemplates([])
      })
    return () => {
      cancelled = true
    }
  }, [authenticated, session?.userId])

  useEffect(() => {
    if (!walletAddress) {
      setBalanceMon(null)
      return
    }
    let cancelled = false
    setBalanceError(null)
    getMarketplacePublicClient()
      .getBalance({ address: walletAddress as Address })
      .then((wei) => {
        if (!cancelled) setBalanceMon(weiToMon(wei))
      })
      .catch((e) => {
        if (!cancelled) {
          setBalanceMon(null)
          setBalanceError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const publishedCount = useMemo(() => {
    if (!templates) return null
    return templates.filter(isPublished).length
  }, [templates])

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
            <h1 className="font-display text-3xl font-bold tracking-tight">Welcome back</h1>
            <p className="mt-1.5 text-base text-muted-foreground">
              Your templates and your wallet.
            </p>
          </div>
          <Link to="/upload" className="no-underline">
            <Button>
              <Plus className="h-4 w-4" />
              New template
            </Button>
          </Link>
        </div>

        {!ready ? (
          <p className="text-sm text-muted-foreground">Loading auth…</p>
        ) : !authenticated ? (
          <EmptyState
            title="Sign in to see your dashboard"
            description="Log in to read your wallet balance and templates you created."
            actionLabel="Sign in"
            onAction={() => login()}
          />
        ) : (
          <>
            <div className="mb-8 grid gap-4 lg:grid-cols-3">
              <StatCard
                label="Wallet balance"
                value={balanceMon != null ? `${balanceMon} MON` : '— MON'}
                delta={
                  balanceError
                    ? 'Could not read chain balance'
                    : walletAddress
                      ? 'Read from chain · your Privy wallet'
                      : 'Waiting for wallet'
                }
                icon={Wallet}
                deltaMuted
              />
              <StatCard
                label="Published templates"
                value={publishedCount != null ? String(publishedCount) : '—'}
                delta="From My templates"
                icon={Files}
                deltaMuted
              />
              <DashboardEarnings />
            </div>

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
                    void navigate({ to: '/upload' })
                  }}
                />
              )}
              {templates && templates.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-left text-xs font-semibold text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3">TEMPLATE</th>
                        <th className="px-4 py-3">PRICE</th>
                        <th className="px-4 py-3">STATUS</th>
                        <th className="px-4 py-3">FORKS</th>
                        <th className="px-4 py-3">TOKEN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {templates.map((t) => (
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
                          <td className="px-4 py-3 font-mono">
                            {t.price_mon != null ? formatMon(t.price_mon) : '—'}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {isPublished(t) ? 'Published' : 'Draft'}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">—</td>
                          <td className="px-4 py-3 font-mono text-muted-foreground">
                            {t.onchain_token_id != null ? `#${String(t.onchain_token_id)}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function isPublished(t: Template) {
  return Boolean(t.is_published) || (t.onchain_token_id != null && String(t.onchain_token_id) !== '')
}
