import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { API_URL, getHealth, type Health } from '#/lib/api'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getHealth().then(setHealth).catch((e: Error) => setError(e.message))
  }, [])

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rounded-[2rem] px-6 py-10 sm:px-10">
        <p className="island-kicker mb-3">EdTech · Monad</p>
        <h1 className="display-title mb-5 text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
          edtech-monad
        </h1>
        <p className="mb-6 text-[var(--sea-ink-soft)]">
          Learning materials and remixable templates. This is the MVP skeleton.
        </p>
        <Link to="/templates" className="nav-link">
          Browse marketplace →
        </Link>
        {' · '}
        <Link to="/library" className="nav-link">
          Library →
        </Link>
      </section>

      <section className="island-shell mt-8 rounded-2xl p-6">
        <p className="island-kicker mb-2">API status</p>
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
          API: <code>{API_URL}</code>
        </p>
        {error && <p className="text-sm text-red-600">API unreachable: {error}</p>}
        {!error && !health && <p className="text-sm">Checking…</p>}
        {health && (
          <ul className="m-0 list-disc pl-5 text-sm">
            <li>API: {health.ok ? '✅ ok' : '❌ not ok'}</li>
            <li>
              Supabase:{' '}
              {!health.supabase.configured
                ? '⚠️ not configured'
                : health.supabase.reachable
                  ? '✅ reachable'
                  : `❌ unreachable${health.supabase.error ? ` (${health.supabase.error})` : ''}`}
            </li>
          </ul>
        )}
      </section>
    </main>
  )
}
