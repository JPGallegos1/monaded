import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { extractMaterial, generateTemplate, uploadMaterial, upsertUser } from '#/lib/api'
import { isPrivyConfigured } from '#/lib/privy/config'
import { usePrivySession } from '#/lib/privy/usePrivySession'
import AuthButton from '#/components/AuthButton'

export const Route = createFileRoute('/upload')({ component: Upload })

// Intentionally minimal: the real UI will be rebuilt later (shadcn/ui + Tailwind).
function Upload() {
  if (!isPrivyConfigured()) {
    return (
      <main className="page-wrap px-4 pb-8 pt-14">
        <h1 className="mb-2 text-2xl font-bold">Upload a PDF</h1>
        <p className="text-sm">Set VITE_PRIVY_APP_ID to enable login before uploading.</p>
      </main>
    )
  }
  return <UploadAuthed />
}

function UploadAuthed() {
  const navigate = useNavigate()
  const { ready, authenticated, login, syncSession, session } = usePrivySession()
  const [file, setFile] = useState<File | null>(null)
  const [startPage, setStartPage] = useState('')
  const [endPage, setEndPage] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const busy = status !== null && !error && !templateId

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    if (!authenticated) {
      login()
      return
    }
    setError(null)
    setTemplateId(null)
    try {
      // Ensure HttpOnly session + users row before upload (owner_id comes from session).
      setStatus('Syncing session…')
      await syncSession()
      await upsertUser({})
      setStatus('Uploading PDF…')
      const { material } = await uploadMaterial(file)
      setStatus('Extracting text from the PDF (can take 15–90 s for large books)…')
      const ex = await extractMaterial(material.id)
      const start = Number(startPage) || ex.suggested_start_page
      setStatus(`Generating the study template from pages ${start}+ with Llama 3.1 8B (about 20–40 s)…`)
      const { template } = await generateTemplate(material.id, {
        start_page: start,
        end_page: Number(endPage) || undefined,
      })
      setTemplateId(template.id)
      setStatus('Done.')
      navigate({ to: '/templates/$templateId', params: { templateId: template.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <h1 className="mb-2 text-2xl font-bold">Upload a PDF</h1>
      <p className="mb-6 text-sm">
        We extract the text and generate a study template (summary, sections, definitions, worked examples,
        practice questions, diagrams). Long books are processed in chunks of up to 12 pages.
      </p>
      {!ready ? (
        <p className="text-sm">Loading auth…</p>
      ) : !authenticated ? (
        <div className="mb-4 flex flex-col gap-2 text-sm">
          <p>Log in to upload (session required so the material is owned by your account).</p>
          <AuthButton />
        </div>
      ) : (
        <p className="mb-4 text-sm" data-session-user={session?.userId ?? ''}>
          Signed in{session?.walletAddress ? ` · ${session.walletAddress.slice(0, 6)}…` : ''}.
        </p>
      )}
      <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-3">
        <input
          type="file"
          accept="application/pdf,.pdf"
          required
          disabled={busy || !authenticated}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div className="flex gap-3 text-sm">
          <label className="flex flex-col">
            Start page (optional)
            <input type="number" min={1} value={startPage} disabled={busy || !authenticated} onChange={(e) => setStartPage(e.target.value)} className="rounded border px-2 py-1" />
          </label>
          <label className="flex flex-col">
            End page (optional)
            <input type="number" min={1} value={endPage} disabled={busy || !authenticated} onChange={(e) => setEndPage(e.target.value)} className="rounded border px-2 py-1" />
          </label>
        </div>
        <button type="submit" disabled={!file || busy || !authenticated} className="rounded border px-4 py-2 font-semibold disabled:opacity-50">
          {busy ? 'Processing…' : 'Generate study template'}
        </button>
      </form>
      {status && !error && (
        <p className="mt-4 text-sm" role="status">
          {busy && <span className="mr-2 inline-block animate-spin">⏳</span>}
          {status}
        </p>
      )}
      {error && <p className="mt-4 text-sm text-red-600">Error: {error}</p>}
      {templateId && (
        <p className="mt-2 text-sm">
          <Link to="/templates/$templateId" params={{ templateId }}>
            Open the generated template →
          </Link>
        </p>
      )}
    </main>
  )
}
