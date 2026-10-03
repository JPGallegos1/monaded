import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  ChevronDown,
  CircleHelp,
  FileText,
  FileUp,
  Info,
  ListTree,
  BookOpen,
  Sigma,
  Sparkles,
  Target,
  Workflow,
  X,
} from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Card } from '#/components/ui/card'
import { StepProgress, type StepState } from '#/components/step-progress'
import { extractMaterial, generateTemplate, uploadMaterial } from '#/lib/api'
import { cn } from '#/lib/utils'

export const Route = createFileRoute('/upload')({
  component: Upload,
  head: () => ({ meta: [{ title: 'Create · Monaded' }] }),
})

const STYLES = ['Concise', 'Step-by-step', 'Visual', 'Exam prep'] as const
type LearningStyle = (typeof STYLES)[number]

const MODELS = [
  { id: 'balanced', label: 'Balanced · ~20 s' },
  { id: 'best-math', label: 'Best math · ~40 s' },
] as const

function Upload() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [startPage, setStartPage] = useState('1')
  const [endPage, setEndPage] = useState('')
  const [style, setStyle] = useState<LearningStyle>('Step-by-step')
  const [model, setModel] = useState<(typeof MODELS)[number]['id']>('balanced')
  const [phase, setPhase] = useState<'form' | 'working'>('form')
  const [stepIndex, setStepIndex] = useState(0)
  const [statusDetail, setStatusDetail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const steps = useMemo(() => {
    const defs: { title: string; detail: string }[] = [
      { title: 'Upload', detail: file ? `PDF received (${formatBytes(file.size)})` : 'Waiting for PDF' },
      { title: 'Extract text', detail: stepIndex >= 1 ? statusDetail || 'Reading pages…' : 'Queued' },
      {
        title: 'Generate template',
        detail: stepIndex >= 2 ? statusDetail || 'Writing sections, examples and questions…' : 'Queued',
      },
      { title: 'Render math and diagrams', detail: stepIndex >= 3 ? 'LaTeX and Mermaid' : 'Queued' },
    ]
    return defs.map((d, i) => ({
      ...d,
      state: (i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'todo') as StepState,
    }))
  }, [file, stepIndex, statusDetail])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setError(null)
    setPhase('working')
    setStepIndex(0)
    try {
      setStatusDetail('Uploading…')
      const { material } = await uploadMaterial(file)
      setStepIndex(1)
      setStatusDetail('Extracting text from the PDF…')
      const ex = await extractMaterial(material.id)
      const start = Number(startPage) || ex.suggested_start_page
      const end = Number(endPage) || undefined
      setStatusDetail(
        end
          ? `${end - start + 1} pages selected`
          : `From page ${start} of ${ex.page_count}`,
      )
      setStepIndex(2)
      setStatusDetail(`Generating with ${model === 'best-math' ? 'best math model' : 'balanced model'}…`)
      // learning_style is accepted by the API; model selection is UI-only until gen exposes it.
      const { template } = await generateTemplate(material.id, {
        start_page: start,
        end_page: end,
        learning_style: style,
      })
      setStepIndex(3)
      setStatusDetail('Ready')
      navigate({ to: '/templates/$templateId', params: { templateId: template.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('form')
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) {
      setFile(f)
    }
  }

  if (phase === 'working') {
    const progress = ((stepIndex + 0.45) / 4) * 100
    return (
      <main className="page-wrap page-body bg-transparent">
        <div className="mx-auto flex max-w-[640px] justify-center py-12">
          <Card className="shadow-elevated w-full p-8">
            <div className="mb-5">
              <h1 className="font-display text-2xl font-bold">Building your template</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {file?.name}
                {startPage && ` · pages ${startPage}${endPage ? ` to ${endPage}` : '+'}`}
                {` · ${style}`}
              </p>
            </div>
            <StepProgress
              steps={steps}
              progress={progress}
              stepLabel={`Step ${Math.min(stepIndex + 1, 4)} of 4`}
              eta={stepIndex < 3 ? 'This usually takes 20–40 s' : 'Almost done'}
            />
            <div className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Info className="h-4 w-4 shrink-0" />
              You can leave this page. We&apos;ll keep working and notify you when it&apos;s ready.
            </div>
          </Card>
        </div>
      </main>
    )
  }

  return (
    <main className="page-wrap page-body">
      <div className="mb-8 max-w-2xl">
        <h1 className="font-display text-4xl font-bold tracking-tight">Create a study template</h1>
        <p className="mt-2 text-base leading-relaxed text-muted-foreground">
          Upload a PDF and choose how you want to learn it. We will build sections, examples,
          practice questions and diagrams.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,760px)_1fr]">
        <form onSubmit={onSubmit} className="surface-card flex flex-col gap-5 p-7">
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'relative flex h-[220px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed bg-accent',
              dragOver ? 'border-primary' : 'border-primary/70',
            )}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/50 text-accent-foreground dark:bg-black/20">
              <FileUp className="h-7 w-7" />
            </div>
            <p className="text-lg font-semibold">Drop your PDF here</p>
            <p className="text-sm text-muted-foreground">or click to browse · up to 50 MB</p>
            <input
              type="file"
              accept="application/pdf,.pdf"
              required={!file}
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {file && (
            <div className="flex items-center gap-3 rounded-md border border-border p-3.5">
              <FileText className="h-5 w-5 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <button type="button" onClick={() => setFile(null)} aria-label="Remove file">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="From page"
              type="number"
              min={1}
              value={startPage}
              onChange={(e) => setStartPage(e.target.value)}
            />
            <Input
              label="To page"
              type="number"
              min={1}
              value={endPage}
              placeholder="Optional"
              onChange={(e) => setEndPage(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Learning style</span>
            <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
              {STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStyle(s)}
                  className={cn(
                    'rounded-sm px-3.5 py-2 text-[13px] font-medium',
                    style === s
                      ? 'bg-card font-semibold text-foreground shadow-sm'
                      : 'text-muted-foreground',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">AI model</span>
            <div className="relative">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as typeof model)}
                className="w-full appearance-none rounded-md border border-border bg-background px-3 py-2.5 pr-10 text-sm outline-none"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
            <span className="text-xs text-muted-foreground">
              Best math quality takes longer (up to ~40 s).
            </span>
          </div>

          {error && <p className="text-sm text-destructive">Error: {error}</p>}

          <div className="flex justify-end">
            <Button type="submit" disabled={!file}>
              <Sparkles className="h-4 w-4" />
              Generate template
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3.5 p-6">
            <p className="text-base font-semibold">What you&apos;ll get</p>
            {[
              [ListTree, 'Summary and sections'],
              [BookOpen, 'Key concepts and definitions'],
              [Sigma, 'Worked examples with math'],
              [CircleHelp, 'Practice questions with answers'],
              [Workflow, 'Diagrams'],
              [Target, 'Learning objectives'],
            ].map(([Icon, label]) => (
              <div key={String(label)} className="flex items-center gap-2.5 text-sm">
                <Icon className="h-4 w-4 text-primary" />
                {label as string}
              </div>
            ))}
          </Card>
          <Card className="gap-1.5 bg-muted p-5">
            <p className="text-sm font-semibold">Tip</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Smaller page ranges (10 to 30 pages) give sharper templates.
            </p>
          </Card>
        </div>
      </div>
    </main>
  )
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
