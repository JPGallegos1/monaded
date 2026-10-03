import { z } from 'zod'

// Structured study template produced by the model. Kept flat and small on purpose:
// the default model (Llama 3.1 8B) follows simple schemas much more reliably.
export const StudyTemplateSchema = z.object({
  title: z.string().meta({ description: 'Short title of the study guide' }),
  summary: z.string().meta({ description: '3-5 sentence overview of the material' }),
  learning_objectives: z.array(z.string()).max(6).meta({ description: '3-6 things the student will be able to do' }),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        explanation: z.string().meta({ description: 'Clear explanation in plain language, 2-5 sentences' }),
        key_concepts: z.array(z.string()).max(6),
      }),
    )
    .max(6)
    .meta({ description: '3-6 sections following the order of the source' }),
  definitions: z.array(z.object({ term: z.string(), definition: z.string() })).max(8),
  worked_examples: z
    .array(
      z.object({
        title: z.string(),
        problem: z.string(),
        steps: z.array(z.string()).max(8),
        answer: z.string(),
      }),
    )
    .max(3)
    .meta({ description: '1-3 fully worked examples taken from or modelled on the source' }),
  practice_questions: z
    .array(
      z.object({
        question: z.string(),
        type: z.enum(['multiple_choice', 'short_answer', 'computation']),
        choices: z.array(z.string()).max(4).meta({ description: 'Options for multiple_choice, otherwise empty' }),
        answer: z.string(),
        explanation: z.string(),
      }),
    )
    .max(8)
    .meta({ description: '4-8 practice questions with answers' }),
  diagrams: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        mermaid: z.string().meta({ description: 'Valid Mermaid flowchart source, e.g. "flowchart TD\\n A[Start] --> B[Step]"' }),
      }),
    )
    .max(2)
    .meta({ description: '0-2 Mermaid diagrams, only when a process or relationship benefits from one' }),
})

export type StudyTemplate = z.infer<typeof StudyTemplateSchema>
