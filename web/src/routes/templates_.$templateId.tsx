import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
  AlignLeft,
  BookOpen,
  CircleCheck,
  CircleHelp,
  ListTree,
  Lock,
  Rocket,
  Sigma,
  Target,
  Workflow,
  Zap,
} from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { Callout } from '#/components/callout'
import { BuyLicenseCard } from '#/components/buy-license-card'
import { LineageTree } from '#/components/lineage-node'
import { MonPrice } from '#/components/mon-price'
import { PublishDialog, PublishedSuccess } from '#/components/publish-dialog'
import { RichText } from '#/components/math-text'
import {
  lineageToNodeData,
  useBuyTemplate,
  useGatedContent,
  useLineage,
  useOnchainTemplate,
  usePublishTemplate,
  weiToMon,
} from '#/features/marketplace'
import { getTemplate, type GeneratedTemplate, type StudyTemplateContent } from '#/lib/api'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/templates_/$templateId')({
  loader: ({ params }) => getTemplate(params.templateId),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.title ?? 'Template'} · Monaded` }],
  }),
  component: TemplateView,
  errorComponent: ({ error }) => (
    <main className="page-wrap page-body">
      <p className="text-destructive">
        Could not load template: {error instanceof Error ? error.message : String(error)}
      </p>
    </main>
  ),
})

function TemplateView() {
  const t = Route.useLoaderData() as GeneratedTemplate
  const navigate = useNavigate()
  const router = useRouter()
  const { walletAddress } = usePrivySession()
  const onchainId =
    t.onchain_token_id != null && String(t.onchain_token_id).trim() !== ''
      ? String(t.onchain_token_id)
      : null
  const onchain = useOnchainTemplate(onchainId, walletAddress)
  const gated = useGatedContent(t)
  const { lineage } = useLineage(onchainId)
  const {
    status: buyStatus,
    error: buyError,
    fundAddress,
    alreadyOwned,
    buy,
    txHash: buyTxHash,
  } = useBuyTemplate()
  const {
    status: publishStatus,
    error: publishError,
    result: publishResult,
    publish,
  } = usePublishTemplate()

  const c = gated.content
  const preview = gated.preview
  const g = t.generation
  const published = Boolean(t.is_published) || Boolean(onchainId)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishedOpen, setPublishedOpen] = useState(false)
  const [pendingPrice, setPendingPrice] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (publishStatus === 'done' && publishResult) {
      setPublishOpen(false)
      setPublishedOpen(true)
      void router.invalidate()
    }
  }, [publishStatus, publishResult, router])

  const priceMon =
    onchain.template != null
      ? weiToMon(onchain.template.price)
      : t.price_mon != null
        ? String(t.price_mon)
        : null

  const owned = onchain.hasLicense === true || alreadyOwned
  const buying = ['checking', 'signing', 'confirming', 'verifying'].includes(buyStatus)

  const toc = [
    { id: 'summary', label: 'Summary', icon: AlignLeft },
    { id: 'objectives', label: 'Learning objectives', icon: Target },
    { id: 'concepts', label: 'Key concepts', icon: BookOpen },
    ...((c?.sections ?? []).map((s, i) => ({
      id: `section-${i}`,
      label: `${i + 1}. ${s.heading}`,
      icon: ListTree,
    })) ?? []),
    { id: 'examples', label: 'Worked examples', icon: Sigma },
    { id: 'practice', label: 'Practice', icon: CircleHelp },
    { id: 'diagrams', label: 'Diagram', icon: Workflow },
  ]

  return (
    <main className="min-h-[70vh]" data-marketplace="template-detail">
      <div className="page-wrap flex flex-col gap-0 lg:flex-row">
        <aside className="hidden w-60 shrink-0 border-r border-border py-8 pr-2 lg:block">
          <p className="mb-3 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground">
            ON THIS PAGE
          </p>
          <nav className="flex flex-col gap-1">
            {toc.map((item, i) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm no-underline',
                  i === 0
                    ? 'bg-accent font-semibold text-accent-foreground'
                    : 'font-medium text-muted-foreground hover:bg-muted',
                )}
              >
                <item.icon className="h-4 w-4" />
                <span className="truncate">{item.label}</span>
              </a>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 flex-1 px-0 py-10 lg:px-12">
          <div className="mb-8 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge>Study template</Badge>
              <Badge variant="outline">
                {g?.model ? `AI-generated · ${shortModel(g.model)}` : 'AI-generated'}
              </Badge>
              {t.parent_template_id && <Badge variant="outline">Fork</Badge>}
              {published && onchainId && (
                <Badge variant="outline">Onchain #{onchainId}</Badge>
              )}
            </div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {preview.title ?? c?.title ?? t.title}
            </h1>
            {(c?.summary || preview.summary) && (
              <p id="summary" className="max-w-2xl text-base leading-relaxed text-muted-foreground">
                <RichText text={c?.summary ?? preview.summary ?? ''} />
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Status: {t.status}
              {g?.source_pages && (
                <>
                  {' '}
                  · Pages {g.source_pages.start}–{g.source_pages.end} of {g.source_pages.total}
                </>
              )}
              {g?.generate_ms != null && <> · {(g.generate_ms / 1000).toFixed(1)} s</>}
            </p>
            {gated.isPreviewOnly && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                Preview only. Buy a license (or sign in as the creator) to unlock the full study
                template.
              </p>
            )}
            {gated.loading && (
              <p className="text-sm text-muted-foreground">Checking license for full content…</p>
            )}
          </div>

          {t.status === 'failed' && (
            <p className="mb-6 text-destructive">Generation failed: {t.error}</p>
          )}

          {gated.isPreviewOnly ? (
            <PreviewBody preview={preview} />
          ) : c ? (
            <FullBody
              content={c}
              revealed={revealed}
              setRevealed={setRevealed}
              lineageNodes={
                lineage
                  ? lineageToNodeData(lineage)
                  : published && t.parent_template_id
                    ? null
                    : undefined
              }
              showLineagePlaceholder={Boolean(published && t.parent_template_id && !lineage)}
            />
          ) : (
            !gated.loading && <p>No content yet.</p>
          )}
        </article>

        <aside className="w-full shrink-0 py-10 lg:w-80" data-marketplace="rail">
          <div className="flex flex-col gap-4 lg:sticky lg:top-24">
            {!published ? (
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between">
                  <MonPrice amount="Not published" />
                  <Badge variant="outline">Draft</Badge>
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Publish this template on Monad to sell licenses and earn royalties from forks.
                </p>
                <Button onClick={() => setPublishOpen(true)}>
                  <Rocket className="h-4 w-4" />
                  Publish onchain
                </Button>
                {publishError && <p className="text-sm text-destructive">{publishError}</p>}
              </Card>
            ) : (
              <>
                <BuyLicenseCard
                  price={priceMon}
                  owned={owned}
                  isLoading={buying || onchain.loading}
                  onBuy={() => {
                    if (!onchainId || !onchain.template) return
                    void buy({
                      onchainTemplateId: onchainId,
                      priceWei: onchain.template.price,
                      templateUuid: t.id,
                    }).then((r) => {
                      if (r) void onchain.refresh()
                    })
                  }}
                  onFork={() => {
                    void navigate({
                      to: '/fork/$templateId',
                      params: { templateId: t.id },
                    })
                  }}
                  meta={[
                    { label: 'Sections', value: String(c?.sections.length ?? '—') },
                    { label: 'Questions', value: String(c?.practice_questions.length ?? '—') },
                    {
                      label: 'Published',
                      value: t.created_at
                        ? new Date(t.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : '—',
                    },
                  ]}
                />
                {buyError && <p className="text-sm text-destructive">{buyError}</p>}
                {fundAddress && (
                  <p className="break-all text-xs text-muted-foreground">
                    Fund wallet: {fundAddress}
                  </p>
                )}
                {buyTxHash && (
                  <a
                    href={`https://testnet.monadvision.com/tx/${buyTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-primary no-underline"
                  >
                    View buy tx →
                  </a>
                )}
              </>
            )}

            <Card className="flex flex-col gap-2.5 p-5">
              <p className="text-sm font-semibold">Template info</p>
              {[
                ['Status', t.status ?? '—'],
                [
                  'Pages',
                  g?.source_pages
                    ? `${g.source_pages.start} to ${g.source_pages.end}`
                    : '—',
                ],
                ['Sections', String(c?.sections.length ?? '—')],
                ['Questions', String(c?.practice_questions.length ?? '—')],
                ['Model', g?.model ? shortModel(g.model) : '—'],
              ].map(([a, b]) => (
                <div key={a} className="flex justify-between text-[13px]">
                  <span className="text-muted-foreground">{a}</span>
                  <span className="font-medium">{b}</span>
                </div>
              ))}
            </Card>

            {published && gated.isPreviewOnly && (
              <div className="surface-card relative overflow-hidden p-6 opacity-60">
                <Lock className="mx-auto mb-2 h-5 w-5" />
                <p className="text-center text-sm font-medium">
                  Buy a license to unlock the full template
                </p>
              </div>
            )}

            <Link
              to="/templates"
              className="text-center text-sm text-muted-foreground no-underline hover:text-foreground"
            >
              ← Back to marketplace
            </Link>
          </div>
        </aside>
      </div>

      <PublishDialog
        open={publishOpen}
        title={preview.title ?? c?.title ?? t.title}
        defaultPrice="0.01"
        onClose={() => setPublishOpen(false)}
        isLoading={publishStatus === 'publishing'}
        onPublish={({ priceMon: price }) => {
          setPendingPrice(price)
          void publish({ templateId: t.id, priceMon: price })
        }}
      />
      <PublishedSuccess
        open={publishedOpen}
        price={pendingPrice ?? undefined}
        txHash={publishResult?.txHash}
        tokenId={publishResult?.onchainTemplateId}
        onClose={() => setPublishedOpen(false)}
        listingHref={`/templates/${t.id}`}
      />
    </main>
  )
}

function PreviewBody({
  preview,
}: {
  preview: { title?: string | null; summary?: string | null; learning_objectives?: string[] }
}) {
  return (
    <div className="flex flex-col gap-10" data-marketplace="preview">
      {preview.learning_objectives && preview.learning_objectives.length > 0 && (
        <section id="objectives" className="flex flex-col gap-3">
          <SectionHeading n="01" title="Learning objectives" />
          {preview.learning_objectives.map((o, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[15px]">
              <CircleCheck className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" />
              <RichText text={o} />
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function FullBody({
  content: c,
  revealed,
  setRevealed,
  lineageNodes,
  showLineagePlaceholder,
}: {
  content: StudyTemplateContent
  revealed: Record<number, boolean>
  setRevealed: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  lineageNodes?: ReturnType<typeof lineageToNodeData> | null
  showLineagePlaceholder?: boolean
}) {
  return (
    <div className="flex flex-col gap-10" data-marketplace="full-content">
      {c.learning_objectives.length > 0 && (
        <section id="objectives" className="flex flex-col gap-3">
          <SectionHeading n="01" title="Learning objectives" />
          {c.learning_objectives.map((o, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[15px]">
              <CircleCheck className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" />
              <RichText text={o} />
            </div>
          ))}
        </section>
      )}

      {c.definitions.length > 0 && (
        <section id="concepts" className="flex flex-col gap-3">
          <SectionHeading n="02" title="Key concepts" />
          {c.definitions.map((d, i) => (
            <Callout key={i} term={d.term} body={d.definition} />
          ))}
        </section>
      )}

      {c.sections.map((s, i) => (
        <section key={i} id={`section-${i}`} className="flex flex-col gap-3">
          <SectionHeading n={String(i + 1).padStart(2, '0')} title={s.heading} />
          <p className="leading-relaxed text-foreground">
            <RichText text={s.explanation} />
          </p>
          {s.key_concepts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Key concepts: {s.key_concepts.join(' · ')}
            </p>
          )}
        </section>
      ))}

      {c.worked_examples.length > 0 && (
        <section id="examples" className="flex flex-col gap-4">
          <SectionHeading n="03" title="Worked examples" />
          {c.worked_examples.map((w, i) => (
            <Card key={i} className="flex flex-col gap-2.5 p-5">
              <h3 className="text-[15px] font-semibold">{w.title}</h3>
              <div className="rounded-md bg-muted px-4 py-3 font-math text-[15px] whitespace-pre-wrap">
                <RichText text={w.problem} />
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                {w.steps.map((step, j) => (
                  <li key={j}>
                    <RichText text={step} />
                  </li>
                ))}
              </ol>
              <p className="text-sm">
                <strong>Answer:</strong> <RichText text={w.answer} />
              </p>
            </Card>
          ))}
        </section>
      )}

      {c.practice_questions.length > 0 && (
        <section id="practice" className="flex flex-col gap-4">
          <SectionHeading n="04" title="Practice" />
          {c.practice_questions.map((q, i) => (
            <Card key={i} className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap gap-2">
                <Badge>
                  Question {i + 1} of {c.practice_questions.length}
                </Badge>
                <Badge variant="outline">{q.type.replace('_', ' ')}</Badge>
              </div>
              <p className="text-[15px] font-medium whitespace-pre-wrap">
                <RichText text={q.question} />
              </p>
              {q.choices.length > 0 && (
                <ul className="list-[lower-alpha] space-y-1 pl-6 text-sm">
                  {q.choices.map((ch, j) => (
                    <li key={j}>
                      <RichText text={ch} />
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRevealed((r) => ({ ...r, [i]: true }))}
                >
                  Reveal answer
                </Button>
              </div>
              {revealed[i] && (
                <div className="rounded-md bg-success-soft p-3.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-success">
                    <CircleCheck className="h-4 w-4" />
                    Answer
                  </div>
                  <p className="font-math text-[15px]">
                    <RichText text={q.answer} />
                  </p>
                  {q.explanation && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      <RichText text={q.explanation} />
                    </p>
                  )}
                </div>
              )}
            </Card>
          ))}
        </section>
      )}

      {c.diagrams.length > 0 && (
        <section id="diagrams" className="flex flex-col gap-4">
          <SectionHeading n="05" title="Diagram" />
          {c.diagrams.map((d, i) => (
            <Card key={i} className="p-5">
              <p className="mb-2 text-sm font-semibold">Diagram · {d.title}</p>
              <p className="mb-4 text-sm text-muted-foreground">{d.description}</p>
              <div className="rounded-md bg-muted p-6">
                <Mermaid id={`d${i}`} source={d.mermaid} />
              </div>
            </Card>
          ))}
        </section>
      )}

      {lineageNodes && lineageNodes.length > 0 && (
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Royalty lineage</h3>
            <Badge variant="outline">Onchain</Badge>
          </div>
          <LineageTree nodes={lineageNodes} />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="h-3.5 w-3.5" />
            All payouts happen in the same transaction on Monad.
          </div>
        </Card>
      )}

      {showLineagePlaceholder && (
        <Card className="flex flex-col gap-4 p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Royalty lineage</h3>
            <Badge variant="outline">Fork</Badge>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Lineage will appear once this template is published onchain.
          </p>
        </Card>
      )}
    </div>
  )
}

function SectionHeading({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-[13px] font-semibold text-primary">{n}</span>
      <h2 className="font-display text-[22px] font-bold tracking-tight">{title}</h2>
    </div>
  )
}

function shortModel(m: string) {
  const parts = m.split('/')
  return parts[parts.length - 1] ?? m
}

function Mermaid({ id, source }: { id: string; source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
        const { svg } = await mermaid.render(`mermaid-${id}`, source)
        if (!cancelled && ref.current) ref.current.innerHTML = svg
      })
      .catch((e: Error) => !cancelled && setFailed(e.message))
    return () => {
      cancelled = true
    }
  }, [id, source])
  return (
    <div>
      <div ref={ref} className="mermaid-diagram overflow-x-auto" />
      {failed && (
        <p className="text-xs text-destructive">Diagram could not be rendered ({failed}). Source:</p>
      )}
      {failed && <pre className="overflow-x-auto text-xs">{source}</pre>}
    </div>
  )
}
