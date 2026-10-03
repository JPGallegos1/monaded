# edtech-monad

Hackathon MVP skeleton for an EdTech app (learning materials + remixable, sellable templates; Privy auth / Monad wallet), on Cloudflare.

## Architecture

```
Browser ──► edtech-monad-web  (TanStack Start, Cloudflare Worker with static assets — not Pages)
               │  browser: fetch(VITE_API_URL)   ·   SSR loaders: `API` service binding
               ▼
           edtech-monad-api  (pure Python Worker) ── the ONLY component that talks to Supabase
               │  PostgREST (service role)        │  R2 `PDFS`          │  `GEN` service binding
               ▼                                  ▼                     ▼
           Supabase (users, materials,      R2 edtech-monad-pdfs   edtech-monad-gen (TypeScript Worker, internal:
           templates)                       (PDFs, page text,        no public URL; TanStack AI + Workers AI;
                                             template JSON)          reads/writes R2, never touches Supabase)
```

* **`api/`** — Worker `edtech-monad-api`, pure Python (`src/entry.py`, `src/supabase_rest.py`). The **only** component that talks to Supabase, via PostgREST with `SUPABASE_SERVICE_ROLE_KEY`.
  * `GET /health` → `{"ok", "supabase": {"configured", "reachable", "status"}, "gen": {"bound", "status", "model"}}`
  * `GET /templates` → `{"templates": [...]}` (rows with `is_published = true`)
  * `GET /templates/{id}` → `{"template": {...}}` (any status, includes generated `content` + `generation` metadata)
  * `POST /users` → upsert by `privy_user_id`
  * `POST /materials` → multipart (`file` = PDF, optional `title`); stored in R2 at `materials/<id>/<filename>`, `materials` row created. Max 50 MB; `%PDF-` magic checked. The runtime's native `FormData` is used and the JS `File` is handed straight to R2 (bytes never copied into Python).
  * `GET /materials/{id}` → material + its templates
  * `POST /materials/{id}/extract` → gen Worker converts the PDF to text (Workers AI `toMarkdown`, which emits `### Page N` markers), stores page text in R2, sets `page_count`, returns `suggested_start_page` (first "Chapter…" page that isn't the table of contents) and page previews.
  * `POST /materials/{id}/templates` → JSON `{start_page?, end_page?, learning_style?}`; inserts a `templates` row (`status=generating`), calls gen `/generate`, then saves `content` (jsonb), `description`, `generation`, `content_r2_key`, `content_hash`, `status=ready` (or `failed` + `error`).
  * CORS: only `FRONTEND_ORIGIN` + localhost dev origins. Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Bindings: `PDFS` (R2), `GEN` (service).
* **`gen/`** — Worker `edtech-monad-gen` (TypeScript). `workers_dev: false`, so it is reachable only through the API's `GEN` binding (protects the Workers AI quota).
  * `/extract`: R2 PDF → `env.AI.toMarkdown()` → `pages.txt` (UTF-8) + `pages-index.json` (byte offsets) in R2.
  * `/generate`: R2 range-read of the selected pages only → `chat({ adapter, outputSchema })` from **`@tanstack/ai`** with the official **`@tanstack/ai-cloudflare`** adapter on the `AI` binding → Zod-validated study template (`src/schema.ts`: title, summary, learning objectives, sections + key concepts, definitions, worked examples, practice questions with answers/explanations, Mermaid diagrams). Post-processing removes duplicate questions, quotes Mermaid labels and repairs LaTeX backslashes that JSON turned into control characters.
  * Model: `AI_MODEL` var (default `@cf/meta/llama-3.1-8b-instruct-fast`; plain `@cf/meta/llama-3.1-8b-instruct` is deprecated on Workers AI and `-fp8` doesn't support JSON Schema). Override with `npx wrangler deploy --var AI_MODEL:<model id>`. Optional vars for other models: `AI_REASONING_EFFORT` (`low`/`medium`/`high`, reasoning models such as `@cf/qwen/qwen3.8-27b`) and `AI_STREAM_AGGREGATE=true` (send the call streamed and fold it back into one response: long non-streaming Qwen 3.8 calls failed with `408 AiError: Request timeout`). Token usage is recorded in `templates.generation.usage`.
  * Provider: `LLM_PROVIDER` var, `cloudflare` (default, Workers AI) or `openai` (OpenAI Responses API through **`@tanstack/ai-openai`**, one non-streaming `json_schema` call). OpenAI vars: `OPENAI_MODEL` (default `gpt-6-luna`), `OPENAI_REASONING_EFFORT` (`low`…`high`/`xhigh`/`max`), `OPENAI_MAX_OUTPUT_TOKENS` (default 64000) and the secret `OPENAI_API_KEY` (`printf %s "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY`). Try it with `npx wrangler deploy --var LLM_PROVIDER:openai --var OPENAI_REASONING_EFFORT:low`. `generation` records `provider`, `usage` (prompt/cached/completion/reasoning tokens), `attempt_ms` and `cost_usd`.
  * Comparison on Hefferon pp. 11–22 (Gauss's Method), hand-checked: Llama 3.1 8B fast: 1/2 worked examples correct, 0/4 questions usable, ~18 s. Qwen 3.8 27B (low): 3/3 examples, 4/6 questions correct, 332 s (2 attempts). gpt-6-luna `low`: 3/3 examples, 6/6 questions, 19 s, $0.0021. gpt-6-luna `max`: 2/2 examples, 6/6 questions, 144 s, $0.0093 (17k output tokens, 14k of them reasoning). Worker CPU stays at 43–68 ms either way, because the Worker just waits on the network.
  * Limits per generation: `MAX_PAGES=12`, `MAX_INPUT_CHARS=24000` (~8.5k tokens of math text), `MAX_OUTPUT_TOKENS=6000`. Longer selections are truncated and flagged (`generation.truncated`). For big books (e.g. Hefferon's 525-page *Linear Algebra*) pick a section, e.g. pages 11–22 = Chapter One §I.1 "Gauss's Method".
  * Workers Free plan (10 ms CPU/request): the stock adapter streams structured output token by token (~1.9 s CPU → `exceededCpu`), so `gen` uses a tiny adapter subclass that hides `structuredOutputStream`, making TanStack AI use the adapter's non-streaming `structuredOutput` (~45 ms CPU).
  * Flow is synchronous (extract ≈ 10–16 s, generate ≈ 18–28 s for Hefferon). Queues were not used today; they would be the next step for longer jobs.
* **`web/`** — Worker `edtech-monad-web`, TanStack Start. Never talks to Supabase. Pages: `/` (health), `/templates`, `/upload` (PDF input + loading states; deliberately unstyled, the UI will be rebuilt), `/templates/<id>` (SSR-rendered template; Mermaid rendered client-side only and stubbed out of the Worker bundle).
* **`supabase/migrations/`** — SQL applied to the project (Day 2: `materials.original_filename/text_r2_key/error`, `templates.content/status/error/generation`).

## Prerequisites

Node ≥ 22 (create-cloudflare/wrangler requirement), [uv](https://docs.astral.sh/uv/), a Cloudflare API token in `CLOUDFLARE_API_TOKEN`.

## Local development

```bash
# API (http://localhost:8787)
cd api
cp .dev.vars.example .dev.vars   # fill in Supabase URL + service role key (gitignored)
uv run pywrangler dev

# Web (http://localhost:3000)
cd web
npm install
cp .env.example .env.local       # VITE_API_URL=http://localhost:8787
npm run dev
```

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...      # never commit
./scripts/deploy.sh                  # R2 bucket + gen → api → secrets (from ../supabase-credentials.env) → web → api again with FRONTEND_ORIGIN
```

Manual equivalents:

```bash
cd gen && npm ci && npx wrangler deploy      # first: the API binds to it
cd api && uv run pywrangler deploy --var FRONTEND_ORIGIN:https://edtech-monad-web.<subdomain>.workers.dev
cd api && uv run pywrangler secret put SUPABASE_URL                # prompts / reads stdin
cd api && uv run pywrangler secret put SUPABASE_SERVICE_ROLE_KEY
cd web && VITE_API_URL=https://edtech-monad-api.<subdomain>.workers.dev npm run build && npx wrangler deploy
```
