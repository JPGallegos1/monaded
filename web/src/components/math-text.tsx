import { useEffect, useState } from 'react'
import { cn } from '#/lib/utils'

/** Renders inline LaTeX with KaTeX when possible; falls back to STIX Two Math styling. */
export function MathText({
  children,
  display = false,
  className,
}: {
  children: string
  display?: boolean
  className?: string
}) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    import('katex')
      .then((katex) => {
        if (cancelled) return
        try {
          setHtml(
            katex.default.renderToString(children, {
              throwOnError: false,
              displayMode: display,
            }),
          )
        } catch {
          setHtml(null)
        }
      })
      .catch(() => setHtml(null))
    return () => {
      cancelled = true
    }
  }, [children, display])

  if (html) {
    return (
      <span
        className={cn(display ? 'block my-2 overflow-x-auto' : 'inline', className)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <span className={cn('font-math', display && 'my-2 block', className)}>{children}</span>
  )
}

/** Split text into prose + $...$ / $$...$$ math segments. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g)
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (part.startsWith('$$') && part.endsWith('$$')) {
          return <MathText key={i} display>{part.slice(2, -2)}</MathText>
        }
        if (part.startsWith('$') && part.endsWith('$')) {
          return <MathText key={i}>{part.slice(1, -1)}</MathText>
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}
