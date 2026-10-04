import { GitFork, Rocket, X } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * Presentational publish dialog (design 05a).
 * `onPublish` is a callback only — contract/tx logic lives in marketplace hooks.
 */
export type PublishDialogProps = {
  open: boolean
  title?: string
  defaultPrice?: string
  onClose?: () => void
  onPublish?: (args: { priceMon: string; parentTemplateId?: string | null }) => void
  isLoading?: boolean
  parentOptions?: { id: string; label: string }[]
}

export function PublishDialog({
  open,
  title = 'Untitled template',
  defaultPrice = '2.5',
  onClose,
  onPublish,
  isLoading,
  parentOptions = [],
}: PublishDialogProps) {
  const [price, setPrice] = useState(defaultPrice)
  const [parentId, setParentId] = useState('')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[color:var(--overlay)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-dialog-title"
        className="surface-card shadow-elevated w-full max-w-[520px] p-7"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="publish-dialog-title" className="font-display text-[22px] font-bold">
              Publish on Monad
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{title}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">License price</span>
            <div className="flex items-center justify-between rounded-md border-2 border-primary px-3.5 py-3">
              <input
                type="number"
                min="0"
                step="0.1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full bg-transparent font-mono text-[22px] font-semibold outline-none"
                disabled={isLoading}
              />
              <Badge>MON</Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              Buyers pay in MON. Payment and royalties settle in one transaction.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Fork of (optional)</span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={isLoading}
              className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none"
            >
              <option value="">None, this is an original</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded-md bg-accent p-3.5">
            <p className="mb-2 text-[13px] font-semibold text-accent-foreground">
              If someone forks this template
            </p>
            <div className="flex gap-2.5">
              <GitFork className="mt-0.5 h-4 w-4 shrink-0 text-accent-foreground" />
              <p className="text-[13px] leading-relaxed text-accent-foreground">
                You earn 10% of every sale of a direct fork, and keep earning down to 3 levels of forks.
              </p>
            </div>
          </div>

          <dl className="flex flex-col gap-2 text-[13px]">
            {[
              ['Network', 'Monad testnet'],
              ['Token standard', 'ERC-1155 license'],
              ['Estimated network fee', '< 0.001 MON'],
            ].map(([a, b]) => (
              <div key={a} className="flex justify-between">
                <dt className="text-muted-foreground">{a}</dt>
                <dd className={cn('font-medium', b.includes('MON') && 'font-mono')}>{b}</dd>
              </div>
            ))}
          </dl>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              disabled={isLoading || !price}
              onClick={() =>
                onPublish?.({
                  priceMon: price,
                  parentTemplateId: parentId || null,
                })
              }
            >
              <Rocket className="h-4 w-4" />
              {isLoading ? 'Publishing…' : 'Publish to Monad'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PublishedSuccess({
  open,
  price,
  txHash,
  tokenId,
  contract = '0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e',
  listingHref,
  onClose,
}: {
  open: boolean
  price?: string
  txHash?: string | null
  tokenId?: string | null
  contract?: string
  listingHref?: string
  onClose?: () => void
}) {
  if (!open) return null
  const scanBase = 'https://testnet.monadscan.com'
  const short = (v?: string | null) => (v && v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v ?? '—')

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[color:var(--overlay)] p-4">
      <div className="surface-card shadow-elevated w-full max-w-[460px] p-8 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success text-primary-foreground">
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="font-display text-2xl font-bold">Your template is live</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Anyone can now buy a license{price ? ` for ${price} MON` : ''}.
        </p>
        <dl className="mt-5 rounded-md bg-muted p-4 text-left text-[13px]">
          {[
            ['Transaction', txHash ? `${short(txHash)} ↗` : 'Pending', txHash ? `${scanBase}/tx/${txHash}` : undefined],
            ['Token ID', tokenId ? `#${tokenId}` : '—'],
            ['Contract', `${short(contract)} ↗`, `${scanBase}/address/${contract}`],
            ['Price', price ? `${price} MON` : '—'],
          ].map(([a, b, href]) => (
            <div key={String(a)} className="mb-2.5 flex justify-between last:mb-0">
              <dt className="text-muted-foreground">{a}</dt>
              <dd className="font-mono font-medium">
                {href ? (
                  <a href={String(href)} target="_blank" rel="noreferrer" className="text-primary no-underline">
                    {b}
                  </a>
                ) : (
                  b
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex gap-2">
          <a
            href={`${scanBase}/address/${contract}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex flex-1 items-center justify-center rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium no-underline hover:bg-muted"
          >
            View on Monadscan
          </a>
          {listingHref ? (
            <a
              href={listingHref}
              className="inline-flex flex-1 items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground no-underline hover:opacity-90"
              onClick={onClose}
            >
              Go to listing
            </a>
          ) : (
            <Button className="flex-1" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
