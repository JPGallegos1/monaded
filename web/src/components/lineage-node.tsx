import { cn } from '#/lib/utils'

export type LineageNodeData = {
  name: string
  role: string
  earn: string
  highlight?: boolean
  earnMuted?: boolean
}

export function LineageNode({ name, role, earn, highlight, earnMuted }: LineageNodeData) {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border px-3.5 py-2.5',
        highlight ? 'border-primary bg-accent' : 'border-border bg-card',
      )}
    >
      <span className="avatar-gradient h-7 w-7 shrink-0 rounded-full" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">{role}</p>
      </div>
      <span
        className={cn(
          'font-mono text-xs font-semibold',
          earnMuted ? 'text-muted-foreground' : highlight ? 'text-primary' : 'text-success',
        )}
      >
        {earn}
      </span>
    </div>
  )
}

export function LineageTree({
  nodes,
  className,
}: {
  nodes: LineageNodeData[]
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      {nodes.map((n, i) => (
        <div key={`${n.name}-${i}`}>
          <LineageNode {...n} />
          {i < nodes.length - 1 && (
            <div className="flex pl-7">
              <div className="my-0 h-5 w-0.5 bg-border" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
