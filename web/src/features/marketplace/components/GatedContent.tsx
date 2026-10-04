import { useEffect, useState } from 'react'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import {
  getGatedTemplateContent,
  type GeneratedTemplate,
  type StudyTemplateContent,
} from '../api'

export type TemplatePreview = {
  title?: string | null
  description?: string | null
  summary?: string | null
  learning_objectives?: string[]
  /** Section titles only when the public preview payload includes them (usually empty). */
  sectionTitles?: string[]
}

/** Public generation keys allowed for non-owners / license holders (matches api `_public_generation`). */
const PUBLIC_GENERATION_KEYS = ['model', 'source_pages', 'truncated', 'generate_ms'] as const

function isPreviewPayload(content: StudyTemplateContent | null | undefined): boolean {
  if (!content) return true
  const sections = content.sections?.length ?? 0
  const practice = content.practice_questions?.length ?? 0
  const examples = content.worked_examples?.length ?? 0
  return sections === 0 && practice === 0 && examples === 0
}

function toPublicGeneration(
  gen: GeneratedTemplate['generation'] | null | undefined,
): GeneratedTemplate['generation'] | null {
  if (!gen || typeof gen !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const k of PUBLIC_GENERATION_KEYS) {
    if (k in gen) out[k] = (gen as Record<string, unknown>)[k]
  }
  return Object.keys(out).length ? (out as GeneratedTemplate['generation']) : null
}

/**
 * Preview from GET /templates/{id}; full study body only via GET /templates/{id}/content
 * after owner/license check. Never keep gated body in preview state.
 */
export function useGatedContent(template: GeneratedTemplate | null | undefined) {
  const { authenticated, walletAddress } = usePrivySession()
  const [full, setFull] = useState<StudyTemplateContent | null>(null)
  const [generation, setGeneration] = useState<GeneratedTemplate['generation']>(null)
  const [access, setAccess] = useState<'owner' | 'license' | 'preview'>('preview')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inline = template?.content ?? null
  // Owner path: GET /templates/{id} returns full content. Preview path strips sections.
  const hasFullInline = Boolean(inline && !isPreviewPayload(inline))

  const preview: TemplatePreview = {
    title: template?.title ?? inline?.title,
    description: template?.description,
    summary:
      (typeof inline?.summary === 'string' && inline.summary) ||
      (typeof template?.description === 'string' ? template.description : null),
    learning_objectives: Array.isArray(inline?.learning_objectives)
      ? inline.learning_objectives
      : [],
    // Public API currently returns sections: [] — titles only if that ever changes.
    sectionTitles: Array.isArray(inline?.sections)
      ? inline.sections
          .map((s) => (typeof s?.heading === 'string' ? s.heading : ''))
          .filter(Boolean)
      : [],
  }

  useEffect(() => {
    if (!template?.id) return

    if (hasFullInline && template.content) {
      setFull(template.content)
      setGeneration(template.generation ?? null)
      setAccess('owner')
      setLoading(false)
      return
    }

    // Preview path: clear any previously unlocked body (e.g. after logout).
    setFull(null)
    setGeneration(toPublicGeneration(template.generation))
    setAccess('preview')

    if (!authenticated || !walletAddress) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    getGatedTemplateContent(template.id)
      .then((res) => {
        if (cancelled) return
        setFull(res.template.content ?? null)
        // Owners may receive full generation; license holders get the public slice.
        setGeneration(
          res.access === 'owner'
            ? res.template.generation ?? null
            : toPublicGeneration(res.template.generation ?? template.generation),
        )
        setAccess(res.access)
      })
      .catch((e) => {
        if (cancelled) return
        setFull(null)
        setGeneration(toPublicGeneration(template.generation))
        setAccess('preview')
        const msg = e instanceof Error ? e.message : String(e)
        if (!/forbidden|not authorized|401|403/i.test(msg)) setError(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [template?.id, template?.content, template?.generation, authenticated, walletAddress, hasFullInline])

  const unlocked = access === 'owner' || access === 'license'
  const content = unlocked && full && !isPreviewPayload(full) ? full : null
  const isPreviewOnly = !content

  return {
    preview,
    content,
    generation: unlocked
      ? generation ?? (access === 'owner' ? template?.generation ?? null : toPublicGeneration(template?.generation))
      : toPublicGeneration(generation ?? template?.generation),
    access,
    loading,
    error,
    isPreviewOnly,
  }
}

export function GatedContentBanner({ isPreviewOnly }: { isPreviewOnly: boolean }) {
  if (!isPreviewOnly) return null
  return (
    <p data-marketplace="content-gated" style={{ fontSize: 14, opacity: 0.85 }}>
      Preview only. Buy a license (or sign in as the creator) to unlock the full study template.
    </p>
  )
}
