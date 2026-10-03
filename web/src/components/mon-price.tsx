import { cn } from '#/lib/utils'

export function MonPrice({
  amount,
  size = 'md',
  className,
}: {
  amount: string | number | null | undefined
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const text =
    amount == null || amount === ''
      ? '—'
      : typeof amount === 'number'
        ? `${amount} MON`
        : String(amount).includes('MON')
          ? String(amount)
          : `${amount} MON`

  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono font-semibold', className)}>
      <span
        className={cn(
          'mon-glyph inline-block shrink-0 rounded-full',
          size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5',
        )}
        aria-hidden
      />
      <span className={cn(size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-sm')}>
        {text}
      </span>
    </span>
  )
}
