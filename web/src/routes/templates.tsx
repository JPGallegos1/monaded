import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { Chip } from '#/components/chip'
import { TemplateCard } from '#/components/template-card'
import { useMarketplaceCatalog } from '#/features/marketplace'

export const Route = createFileRoute('/templates')({
  component: Templates,
  head: () => ({ meta: [{ title: 'Explore · Monaded' }] }),
})

const SUBJECTS = [
  'All',
  'Mathematics',
  'Physics',
  'Computer Science',
  'Biology',
  'Chemistry',
  'Economics',
] as const

/**
 * Marketplace browse — PR #1 design system on top of useMarketplaceCatalog (#4).
 */
function Templates() {
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState<(typeof SUBJECTS)[number]>('All')
  const [forkedOnly, setForkedOnly] = useState(false)
  const { loading, error, templates } = useMarketplaceCatalog({
    q: query,
    forkedOnly,
  })

  const filtered = templates.filter((t) => {
    if (subject === 'All') return true
    return matchesSubject(t.title, subject)
  })

  return (
    <main className="page-wrap page-body" data-marketplace="catalog">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight">Explore templates</h1>
          <p className="mt-2 max-w-xl text-base text-muted-foreground">
            Study templates made by students and teachers. Buy a license with MON or fork one to
            make it yours.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex w-full max-w-[360px] items-center gap-2 rounded-md border border-border px-3 py-2.5 sm:w-[360px]">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates, topics, creators"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Search templates"
            />
          </label>
          <button
            type="button"
            onClick={() => setForkedOnly((v) => !v)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm font-medium"
            aria-pressed={forkedOnly}
          >
            {forkedOnly ? 'Forks only' : 'All types'}
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {SUBJECTS.map((s) => (
          <Chip key={s} active={subject === s} onClick={() => setSubject(s)}>
            {s}
          </Chip>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">Could not load templates: {error}</p>}
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && filtered.length === 0 && (
        <div className="surface-card p-10 text-center text-sm text-muted-foreground">
          No published templates match your filters.
        </div>
      )}
      {filtered.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((t) => (
            <TemplateCard
              key={t.id}
              id={t.id}
              title={t.title}
              creator={t.author_id ? short(t.author_id) : undefined}
              subject={guessSubject(t.title)}
              price={t.price_mon}
              kind={t.parent_template_id ? 'Fork' : 'Original'}
              coverSeed={t.id}
            />
          ))}
        </div>
      )}
    </main>
  )
}

function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

function guessSubject(title: string) {
  const t = title.toLowerCase()
  if (/algebra|gauss|matrix|eigen|vector/.test(t)) return 'Linear Algebra'
  if (/calculus|limit|continuity|derivative/.test(t)) return 'Calculus'
  if (/thermo|physics|force/.test(t)) return 'Physics'
  if (/bio|cell|respiration/.test(t)) return 'Biology'
  if (/chem|organic|reaction/.test(t)) return 'Chemistry'
  if (/big-o|algorithm|computer|code/.test(t)) return 'Computer Science'
  if (/supply|demand|econ/.test(t)) return 'Economics'
  return 'Study'
}

function matchesSubject(title: string, subject: (typeof SUBJECTS)[number]) {
  const hay = title.toLowerCase()
  switch (subject) {
    case 'Mathematics':
      return /algebra|calculus|math|gauss|matrix|eigen|limit|vector|derivative/.test(hay)
    case 'Physics':
      return /thermo|physics|force|energy/.test(hay)
    case 'Computer Science':
      return /big-o|algorithm|computer|code|complexity/.test(hay)
    case 'Biology':
      return /bio|cell|respiration/.test(hay)
    case 'Chemistry':
      return /chem|organic|reaction/.test(hay)
    case 'Economics':
      return /supply|demand|econ/.test(hay)
    default:
      return true
  }
}
