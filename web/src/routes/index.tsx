import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  Coins,
  FileUp,
  Link2,
  Sparkles,
} from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import { TemplateCard } from '#/components/template-card'
import { PrimaryLink, SecondaryLink } from '#/components/nav-links'
import { getTemplates, type Template } from '#/lib/api'

export const Route = createFileRoute('/')({
  component: Home,
  head: () => ({ meta: [{ title: 'Monaded · Study templates on Monad' }] }),
})

const HOW = [
  {
    icon: FileUp,
    title: 'Upload a PDF',
    desc: 'Course notes or a textbook chapter. Pick pages and how you like to learn.',
  },
  {
    icon: Sparkles,
    title: 'AI builds the template',
    desc: 'Sections, definitions, worked examples, practice questions and diagrams.',
  },
  {
    icon: Link2,
    title: 'Publish on Monad',
    desc: 'Set a price in MON. Your template becomes a license others can buy.',
  },
  {
    icon: Coins,
    title: 'Earn on every fork',
    desc: 'Forks pay 10% per level, up to 3 levels, instantly in the same transaction.',
  },
] as const

function Home() {
  const [templates, setTemplates] = useState<Template[] | null>(null)

  useEffect(() => {
    getTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [])

  return (
    <main className="page-wrap page-body">
      <section className="rise-in flex flex-col items-center gap-5 px-2 py-14 text-center">
        <Badge>Built on Monad · Pay with MON</Badge>
        <h1 className="display-title max-w-[880px] text-4xl font-bold sm:text-5xl lg:text-[60px]">
          Turn any PDF into a study template that pays you back.
        </h1>
        <p className="max-w-[680px] text-lg leading-relaxed text-muted-foreground">
          Monaded turns your notes into structured, AI-generated study templates. Publish them
          onchain, sell licenses, and earn royalties every time someone builds on your work.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <PrimaryLink to="/upload" icon className="px-5 py-3.5">
            Upload a PDF
          </PrimaryLink>
          <SecondaryLink to="/templates" className="px-5 py-3.5">
            Browse templates
          </SecondaryLink>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Sign in with email or Google. A wallet is created for you, no seed phrase.
        </p>
      </section>

      <section className="mt-8 flex flex-col gap-4">
        <h2 className="font-display text-2xl font-bold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW.map((step, i) => (
            <div key={step.title} className="surface-card flex flex-col gap-3 p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent text-accent-foreground">
                <step.icon className="h-5 w-5" />
              </div>
              <p className="text-base font-semibold">
                {i + 1}. {step.title}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-12 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-2xl font-bold">Trending templates</h2>
          <Link
            to="/templates"
            className="text-sm font-medium text-muted-foreground no-underline hover:text-foreground"
          >
            See all →
          </Link>
        </div>
        {templates === null && (
          <p className="text-sm text-muted-foreground">Loading templates…</p>
        )}
        {templates && templates.length === 0 && (
          <div className="surface-card p-8 text-center text-sm text-muted-foreground">
            No published templates yet. Be the first —{' '}
            <Link to="/upload" className="font-medium text-primary no-underline">
              upload a PDF
            </Link>
            .
          </div>
        )}
        {templates && templates.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {templates.slice(0, 4).map((t) => (
              <TemplateCard
                key={t.id}
                id={t.id}
                title={t.title}
                creator={t.author_id ? shortCreator(t.author_id) : undefined}
                subject={guessSubject(t.title)}
                price={t.price_mon}
                kind={t.parent_template_id ? 'Fork' : 'Original'}
                coverSeed={t.id}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function shortCreator(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}

function guessSubject(title: string) {
  const t = title.toLowerCase()
  if (t.includes('algebra') || t.includes('gauss') || t.includes('matrix')) return 'Linear Algebra'
  if (t.includes('thermo') || t.includes('physics')) return 'Physics'
  if (t.includes('bio') || t.includes('cell')) return 'Biology'
  if (t.includes('big-o') || t.includes('algorithm') || t.includes('computer')) return 'Computer Science'
  return 'Study'
}
