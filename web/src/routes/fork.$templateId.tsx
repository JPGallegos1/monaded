import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { GitFork, Rocket } from 'lucide-react'
import { Callout } from '#/components/callout'
import { LineageTree } from '#/components/lineage-node'
import { PublishDialog, PublishedSuccess } from '#/components/publish-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import {
  lineageToNodeData,
  shortAddress,
  txExplorerUrl,
  useForkTemplate,
  useLineage,
  useOnchainTemplate,
} from '#/features/marketplace'
import { getTemplate, type GeneratedTemplate } from '#/lib/api'
import { usePrivySession } from '#/lib/privy/usePrivySession'

export const Route = createFileRoute('/fork/$templateId')({
  loader: ({ params }) => getTemplate(params.templateId),
  head: ({ loaderData }) => ({
    meta: [{ title: `Fork · ${loaderData?.title ?? 'Template'} · Monaded` }],
  }),
  component: ForkPage,
  errorComponent: ({ error }) => (
    <main className="page-wrap page-body">
      <p className="text-destructive">
        Could not load template to fork: {error instanceof Error ? error.message : String(error)}
      </p>
    </main>
  ),
})

/**
 * Screen 08 v0.2 — light fork: editable title/summary, inherited body, publish rail.
 */
function ForkPage() {
  const parent = Route.useLoaderData() as GeneratedTemplate
  const navigate = useNavigate()
  const { authenticated, login } = usePrivySession()
  const c = parent.content
  const [title, setTitle] = useState(c?.title ? `${c.title} (fork)` : `${parent.title} (fork)`)
  const [summary, setSummary] = useState(c?.summary ?? parent.description ?? '')
  const [price, setPrice] = useState(parent.price_mon != null ? String(parent.price_mon) : '0.01')
  const [publishOpen, setPublishOpen] = useState(false)
  const [successOpen, setSuccessOpen] = useState(false)

  const onchainId =
    parent.onchain_token_id != null ? String(parent.onchain_token_id) : null
  const onchain = useOnchainTemplate(onchainId)
  const { lineage } = useLineage(onchainId)
  const { status, error, forked, publishResult, createAndPublish } = useForkTemplate()

  const creatorLabel =
    onchain.template?.creator
      ? shortAddress(onchain.template.creator)
      : parent.author_id
        ? shortId(parent.author_id)
        : 'unknown creator'

  const lineageNodes = lineage
    ? lineageToNodeData(lineage)
    : [
        {
          name: creatorLabel,
          role: 'Original · Level 0',
          earn: '10%',
          earnMuted: true,
        },
        {
          name: 'You',
          role: 'Fork · Level 1 (new)',
          earn: 'remainder',
          highlight: true,
        },
      ]

  const busy = status === 'creating' || status === 'publishing'
  const parentTitle = c?.title ?? parent.title

  return (
    <main data-marketplace="fork">
      <div className="flex items-center gap-2.5 bg-accent px-6 py-3 text-sm font-medium text-accent-foreground lg:px-10">
        <GitFork className="h-4 w-4 shrink-0" />
        You&apos;re forking “{parentTitle}” by {creatorLabel}.
      </div>

      <div className="page-wrap page-body">
        <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
          <div className="flex flex-col gap-5">
            <div>
              <label className="text-[13px] font-medium text-muted-foreground">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1.5 w-full bg-transparent font-display text-3xl font-bold tracking-tight outline-none"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium">Summary</label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={4}
                className="w-full rounded-md border-[1.5px] border-primary bg-transparent px-3 py-3 text-sm leading-relaxed outline-none"
              />
            </div>

            {c?.definitions?.[0] && (
              <Card className="p-5 opacity-[0.85]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-semibold text-primary">02</span>
                    <h2 className="font-display text-[22px] font-bold">Key concepts</h2>
                  </div>
                  <Badge variant="outline">Inherited from the original</Badge>
                </div>
                <Callout term={c.definitions[0].term} body={c.definitions[0].definition} />
              </Card>
            )}

            {c?.worked_examples?.[0] && (
              <Card className="flex flex-col gap-3 p-5 opacity-[0.85]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-semibold text-primary">03</span>
                    <h2 className="font-display text-[22px] font-bold">Worked examples</h2>
                  </div>
                  <Badge variant="outline">Inherited from the original</Badge>
                </div>
                <p className="text-sm font-medium">{c.worked_examples[0].title}</p>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {c.worked_examples[0].problem}
                </p>
              </Card>
            )}

            {c?.sections?.[0] && !c.definitions?.[0] && !c.worked_examples?.[0] && (
              <Card className="p-5 opacity-[0.85]">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-semibold text-primary">02</span>
                    <h2 className="font-display text-[22px] font-bold">{c.sections[0].heading}</h2>
                  </div>
                  <Badge variant="outline">Inherited from the original</Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {c.sections[0].explanation}
                </p>
              </Card>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {forked && !publishResult && (
              <p className="text-sm">
                Draft fork created:{' '}
                <Link to="/templates/$templateId" params={{ templateId: forked.id }}>
                  {forked.title}
                </Link>
              </p>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-3.5 p-5">
              <h3 className="text-base font-semibold">Who earns</h3>
              <LineageTree nodes={lineageNodes} />
            </Card>

            <Card className="flex flex-col gap-3.5 p-5">
              <Input
                label="License price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                hint="Buyers pay in native MON only"
              />
              {!authenticated ? (
                <Button onClick={() => login()}>Sign in to fork</Button>
              ) : (
                <Button className="w-full" onClick={() => setPublishOpen(true)} disabled={busy}>
                  <Rocket className="h-4 w-4" />
                  {busy
                    ? status === 'creating'
                      ? 'Creating fork…'
                      : 'Publishing…'
                    : 'Publish fork'}
                </Button>
              )}
              {publishResult && (
                <a
                  href={txExplorerUrl(publishResult.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-center text-sm text-primary no-underline"
                >
                  View publish tx →
                </a>
              )}
              <Link
                to="/templates/$templateId"
                params={{ templateId: parent.id }}
                className="text-center text-sm text-muted-foreground no-underline hover:text-foreground"
              >
                Cancel · back to original
              </Link>
            </Card>
          </div>
        </div>
      </div>

      <PublishDialog
        open={publishOpen}
        title={title}
        defaultPrice={price}
        parentOptions={[{ id: parent.id, label: parentTitle }]}
        isLoading={busy}
        onClose={() => setPublishOpen(false)}
        onPublish={({ priceMon }) => {
          setPrice(priceMon)
          void createAndPublish({
            parentTemplateId: parent.id,
            title,
            priceMon,
            parentOnchainId: onchainId ?? undefined,
          }).then((res) => {
            if (res?.template) {
              setPublishOpen(false)
              setSuccessOpen(true)
              void navigate({
                to: '/templates/$templateId',
                params: { templateId: res.template.id },
              })
            }
          })
        }}
      />
      <PublishedSuccess
        open={successOpen}
        price={price}
        txHash={publishResult?.txHash}
        tokenId={publishResult?.onchainTemplateId}
        onClose={() => setSuccessOpen(false)}
        listingHref={forked ? `/templates/${forked.id}` : undefined}
      />
    </main>
  )
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
}
