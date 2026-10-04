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
}

function isPreviewPayload(content: StudyTemplateContent | null | undefined): boolean {
  if (!content) return true
  const sections = content.sections?.length ?? 0
  const practice = content.practice_questions?.length ?? 0
  const examples = content.worked_examples?.length ?? 0
  return sections === 0 && practice === 0 && examples === 0
}

/**
 * Shows preview for everyone; loads full content via GET /templates/{id}/content
 * when the session wallet is the creator or holds a license.
 */
export function useGatedContent(template: GeneratedTemplate | null | undefined) {
  const { authenticated, walletAddress } = usePrivySession()
  const [full, setFull] = useState<StudyTemplateContent | null>(null)
  const [generation, setGeneration] = useState<GeneratedTemplate['generation']>(
    template?.generation ?? null,
  )
  const [access, setAccess] = useState<'owner' | 'license' | 'preview'>('preview')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inline = template?.content ?? null
  const hasFullInline = Boolean(inline && !isPreviewPayload(inline))
  const preview: TemplatePreview = {
    title: template?.title,
    description: template?.description,
    summary: inline?.summary ?? (typeof template?.description === 'string' ? template.description : null),
    learning_objectives: inline?.learning_objectives ?? [],
  }

  useEffect(() => {
    if (!template?.id) return

    if (hasFullInline && template.content) {
      setFull(template.content)
      setGeneration(template.generation ?? null)
      setAccess('owner')
      return
    }

    if (!authenticated || !walletAddress) {
      setFull(null)
      setGeneration(template.generation ?? null)
      setAccess('preview')
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    getGatedTemplateContent(template.id)
      .then((res) => {
        if (cancelled) return
        setFull(res.template.content ?? null)
        // License holders receive the public generation slice; owners may get full.
        setGeneration(res.template.generation ?? template.generation ?? null)
        setAccess(res.access)
      })
      .catch((e) => {
        if (cancelled) return
        setFull(null)
        setGeneration(template.generation ?? null)
        setAccess('preview')
        const msg = e instanceof Error ? e.message : String(e)
        // Ignore expected forbidden for non-owners
        if (!/forbidden|not authorized|401|403/i.test(msg)) setError(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // template.content intentionally omitted — hasFullInline captures gated vs full.
  }, [template?.id, template?.content, template?.generation, authenticated, walletAddress, hasFullInline])

  const content = full
  const isPreviewOnly = access === 'preview' || !content || isPreviewPayload(content)

  return {
    preview,
    content: isPreviewOnly ? null : content,
    generation: generation ?? template?.generation ?? null,
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
