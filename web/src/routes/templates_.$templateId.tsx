import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { getTemplate, type GeneratedTemplate, type StudyTemplateContent } from '#/lib/api'
import {
  BuyPanel,
  GatedContentBanner,
  LineageView,
  PublishForm,
  SplitPreview,
  useGatedContent,
  useOnchainTemplate,
  weiToMon,
} from '#/features/marketplace'
import { usePrivySession } from '#/lib/privy/usePrivySession'

export const Route = createFileRoute('/templates_/$templateId')({
  loader: ({ params }) => getTemplate(params.templateId),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.title ?? 'Template'} · edtech-monad` }],
  }),
  component: TemplateView,
  errorComponent: ({ error }) => (
    <main className="page-wrap px-4 pt-14">
      <p className="text-red-600">
        Could not load template: {error instanceof Error ? error.message : String(error)}
      </p>
    </main>
  ),
})

function TemplateView() {
  const t = Route.useLoaderData() as GeneratedTemplate
  const { walletAddress } = usePrivySession()
  const onchainId =
    t.onchain_token_id != null && String(t.onchain_token_id).trim() !== ''
      ? String(t.onchain_token_id)
      : null
  const onchain = useOnchainTemplate(onchainId, walletAddress)
  const gated = useGatedContent(t)
  const c = gated.content
  // Prefer gated generation (license → public slice; owner → full) over loader preview.
  const g = gated.generation ?? t.generation
  const published = Boolean(t.is_published) || Boolean(onchainId)

  return (
    <main className="page-wrap px-4 pb-8 pt-10" data-marketplace="template-detail">
      <div style={{ display: 'grid', gap: 32, gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div>
          <h1 className="mb-1 text-3xl font-bold">{gated.preview.title ?? t.title}</h1>
          <p className="mb-4 text-xs opacity-70">
            Status: {t.status}
            {published && onchainId && <> · onchain #{onchainId}</>}
            {g?.model && <> · Model: {g.model}</>}
          </p>

          <GatedContentBanner isPreviewOnly={gated.isPreviewOnly} />
          {gated.loading && <p className="text-sm">Checking license for full content…</p>}

          {gated.isPreviewOnly ? (
            <PreviewBody preview={gated.preview} />
          ) : c ? (
            <FullBody content={c} />
          ) : (
            <p>No content yet.</p>
          )}
        </div>

        <aside
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            maxWidth: 420,
          }}
          data-marketplace="rail"
        >
          {published && onchainId ? (
            <>
              <BuyPanel templateUuid={t.id} onchainTemplateId={onchainId} />
              {onchain.split.length > 0 && (
                <section>
                  <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Payment split</h3>
                  <SplitPreview rows={onchain.split} />
                  {onchain.template && (
                    <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                      Onchain price {weiToMon(onchain.template.price)} MON
                    </p>
                  )}
                </section>
              )}
              <LineageView onchainTemplateId={onchainId} />
              <p style={{ margin: 0, fontSize: 14 }}>
                <Link to="/fork/$templateId" params={{ templateId: t.id }}>
                  Fork this template →
                </Link>
              </p>
            </>
          ) : (
            <section data-marketplace="publish-rail">
              <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Publish with price</h3>
              <p style={{ fontSize: 13, opacity: 0.8, marginTop: 0 }}>
                Relayer mints your license NFT via publishFor. Creator = your session wallet.
              </p>
              <PublishForm templateId={t.id} defaultPriceMon="0.01" />
            </section>
          )}
        </aside>
      </div>
    </main>
  )
}

function PreviewBody({
  preview,
}: {
  preview: { title?: string | null; summary?: string | null; learning_objectives?: string[] }
}) {
  return (
    <article className="flex flex-col gap-6" data-marketplace="preview">
      {preview.summary && (
        <section>
          <h2 className="mb-2 text-xl font-semibold">Summary</h2>
          <p>{preview.summary}</p>
        </section>
      )}
      {preview.learning_objectives && preview.learning_objectives.length > 0 && (
        <section>
          <h3 className="font-semibold">Learning objectives</h3>
          <ul className="list-disc pl-6">
            {preview.learning_objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  )
}

function FullBody({ content: c }: { content: StudyTemplateContent }) {
  return (
    <article className="flex flex-col gap-8" data-marketplace="full-content">
      <section>
        <h2 className="mb-2 text-xl font-semibold">Summary</h2>
        <p>{c.summary}</p>
        {c.learning_objectives.length > 0 && (
          <>
            <h3 className="mt-4 font-semibold">Learning objectives</h3>
            <ul className="list-disc pl-6">
              {c.learning_objectives.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xl font-semibold">Sections ({c.sections.length})</h2>
        {c.sections.map((s, i) => (
          <div key={i} className="mb-4">
            <h3 className="font-semibold">
              {i + 1}. {s.heading}
            </h3>
            <p>{s.explanation}</p>
            {s.key_concepts.length > 0 && (
              <p className="text-sm">Key concepts: {s.key_concepts.join(' · ')}</p>
            )}
          </div>
        ))}
      </section>

      {c.definitions.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold">Definitions</h2>
          <dl>
            {c.definitions.map((d, i) => (
              <div key={i} className="mb-2">
                <dt className="font-semibold">{d.term}</dt>
                <dd className="ml-4">{d.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {c.worked_examples.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold">Worked examples</h2>
          {c.worked_examples.map((w, i) => (
            <div key={i} className="mb-4">
              <h3 className="font-semibold">{w.title}</h3>
              <p className="whitespace-pre-wrap">{w.problem}</p>
              <ol className="list-decimal pl-6">
                {w.steps.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
              <p>
                <strong>Answer:</strong> {w.answer}
              </p>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xl font-semibold">
          Practice questions ({c.practice_questions.length})
        </h2>
        <ol className="list-decimal pl-6">
          {c.practice_questions.map((q, i) => (
            <li key={i} className="mb-3">
              <p className="whitespace-pre-wrap">{q.question}</p>
              {q.choices.length > 0 && (
                <ul className="list-[lower-alpha] pl-6">
                  {q.choices.map((ch, j) => (
                    <li key={j}>{ch}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary className="cursor-pointer text-sm">Show answer</summary>
                <p>
                  <strong>{q.answer}</strong>
                </p>
                <p className="text-sm">{q.explanation}</p>
              </details>
            </li>
          ))}
        </ol>
      </section>

      {c.diagrams.length > 0 && (
        <section>
          <h2 className="mb-2 text-xl font-semibold">Diagrams</h2>
          {c.diagrams.map((d, i) => (
            <figure key={i} className="mb-6">
              <figcaption className="font-semibold">{d.title}</figcaption>
              <p className="text-sm">{d.description}</p>
              <Mermaid id={`d${i}`} source={d.mermaid} />
            </figure>
          ))}
        </section>
      )}
    </article>
  )
}

/** Client-only Mermaid render; falls back to the raw source if the model produced invalid syntax. */
function Mermaid({ id, source }: { id: string; source: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
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
        <p className="text-xs text-red-600">Diagram could not be rendered ({failed}). Source:</p>
      )}
      {failed && <pre className="overflow-x-auto text-xs">{source}</pre>}
    </div>
  )
}
