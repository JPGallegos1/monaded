import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { GitFork, Pencil, Rocket } from 'lucide-react'
import { Callout } from '#/components/callout'
import { LineageTree } from '#/components/lineage-node'
import { PublishDialog } from '#/components/publish-dialog'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { getTemplate, type GeneratedTemplate } from '#/lib/api'

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
 * Screen 08 — Fork & republish (UI shell).
 * Editing/persisting a fork + onchain republish are not wired; callbacks are presentational.
 */
function ForkPage() {
  const parent = Route.useLoaderData() as GeneratedTemplate
  const c = parent.content
  const [title, setTitle] = useState(c?.title ? `${c.title} (fork)` : `${parent.title} (fork)`)
  const [price, setPrice] = useState(parent.price_mon != null ? String(parent.price_mon) : '1.5')
  const [publishOpen, setPublishOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <main>
      <div className="flex items-center gap-2.5 bg-accent px-6 py-3 text-sm font-medium text-accent-foreground lg:px-10">
        <GitFork className="h-4 w-4 shrink-0" />
        You&apos;re forking “{c?.title ?? parent.title}”. Edit anything, then republish.
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

            {c?.summary && (
              <Card className="border-primary p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-semibold text-primary">01</span>
                    <h2 className="font-display text-[22px] font-bold">Summary</h2>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                    <Pencil className="h-3.5 w-3.5" />
                    Editable
                  </span>
                </div>
                <p className="text-[15px] leading-relaxed">{c.summary}</p>
              </Card>
            )}

            {c?.definitions?.[0] && (
              <Card className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[13px] font-semibold text-primary">02</span>
                    <h2 className="font-display text-[22px] font-bold">Key concepts</h2>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">From original</span>
                </div>
                <Callout term={c.definitions[0].term} body={c.definitions[0].definition} />
              </Card>
            )}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  setNotice('TODO: add section editor — fork persistence not implemented yet')
                }
              >
                + Add section
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setNotice('TODO: regenerate with AI against parent material_id')
                }
              >
                Regenerate with AI
              </Button>
            </div>
            {notice && (
              <p className="font-mono text-xs text-muted-foreground">{notice}</p>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-3.5 p-5">
              <h3 className="text-base font-semibold">Who earns after you publish</h3>
              <LineageTree
                nodes={[
                  {
                    name: 'Upstream creator(s)',
                    role: 'Original / prior forks · 10% each',
                    earn: '10%',
                    earnMuted: true,
                  },
                  {
                    name: 'You',
                    role: 'Fork (new)',
                    earn: '80%+',
                    highlight: true,
                  },
                ]}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Upstream creators are paid automatically on every sale of your fork. Exact split
                depends on lineage depth (max 3 levels).
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                TODO: resolve real parent chain from parent_template_id={parent.id}
              </p>
            </Card>

            <Card className="flex flex-col gap-3.5 p-5">
              <Input
                label="License price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                hint="Buyers pay in native MON only"
              />
              <Button onClick={() => setPublishOpen(true)}>
                <Rocket className="h-4 w-4" />
                Republish on Monad
              </Button>
              {/* TODO(privy): PublishDialog.onPublish with parentTemplateId → contract */}
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
        parentOptions={[{ id: parent.id, label: c?.title ?? parent.title }]}
        onClose={() => setPublishOpen(false)}
        onPublish={() => {
          setPublishOpen(false)
          setNotice(
            'TODO(privy): republish fork onchain with parentTemplateId — no contract call in this PR',
          )
        }}
      />
    </main>
  )
}
