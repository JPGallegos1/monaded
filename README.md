# edtech-monad

Hackathon MVP skeleton for an EdTech app (learning materials + remixable, sellable templates; Privy auth / Monad wallet), on Cloudflare.

## Architecture

```
Browser ──► edtech-monad-web  (TanStack Start, Cloudflare Worker with static assets — not Pages)
               │  browser: fetch(VITE_API_URL) + Privy SDK   ·   SSR loaders: `API` service binding
               ▼
           edtech-monad-api  (pure Python Worker) ── the ONLY component that talks to Supabase
               │  PostgREST     │  R2 `PDFS`   │  `GEN`     │  `CHAIN`    │  Durable Objects
               ▼                ▼              ▼            ▼             ▼
           Supabase         R2 pdfs      edtech-monad-gen  edtech-monad-chain  SessionDO
           (+ purchases)                  (AI, internal)   (relayer publishFor,  (userId+wallet)
                                                            internal; viem)
```

* **`api/`** — Worker `edtech-monad-api`, pure Python (`src/entry.py`, `src/supabase_rest.py`). The **only** component that talks to Supabase, via PostgREST with `SUPABASE_SERVICE_ROLE_KEY`.
  * `GET /health` → `{"ok", "supabase": {...}, "gen": {...}, "chain": {...}, "privy": {...}}`
  * `GET /templates` → `{"templates": [...]}` (rows with `is_published = true`)
  * `GET /templates/{id}` → `{"template": {...}}` (any status, includes generated `content` + `generation` metadata)
  * `POST /users` → upsert by `privy_user_id` (wallet_address from the client is ignored)
  * `POST /auth/session` → exchange Privy access token (+ optional identity token) for an HttpOnly session cookie backed by `SessionDO`
  * `GET /auth/session` → `{userId, walletAddress}` from the cookie (no raw token stored)
  * `POST /auth/logout` → clear cookie + Durable Object
  * `POST /purchases/verify` → verify `TemplateMarketplace` buy tx on Monad testnet; record once (`purchases.tx_hash` unique)
  * `POST /templates/{id}/publish` → session required; creator = session wallet; rate-limited; `CHAIN` Worker signs `publishFor`
  * `POST /materials` → multipart (`file` = PDF, optional `title`); stored in R2 at `materials/<id>/<filename>`, `materials` row created. Max 50 MB; `%PDF-` magic checked. The runtime's native `FormData` is used and the JS `File` is handed straight to R2 (bytes never copied into Python).
  * `GET /materials/{id}` → material + its templates
  * `POST /materials/{id}/extract` → gen Worker converts the PDF to text (Workers AI `toMarkdown`, which emits `### Page N` markers), stores page text in R2, sets `page_count`, returns `suggested_start_page` (first "Chapter…" page that isn't the table of contents) and page previews.
  * `POST /materials/{id}/templates` → JSON `{start_page?, end_page?, learning_style?}`; inserts a `templates` row (`status=generating`), calls gen `/generate`, then saves `content` (jsonb), `description`, `generation`, `content_r2_key`, `content_hash`, `status=ready` (or `failed` + `error`).
  * CORS: only `FRONTEND_ORIGIN` + localhost dev origins (`Access-Control-Allow-Credentials` for session cookies). Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PRIVY_APP_SECRET`. Vars: `PRIVY_APP_ID`, `MARKETPLACE_ADDRESS`, `MONAD_RPC_URL`. Bindings: `PDFS` (R2), `GEN`, `CHAIN`, `SESSIONS`, `PUBLISH_RATE_LIMITS`.
* **`chain/`** — Worker `edtech-monad-chain` (TypeScript, viem). `workers_dev: false`; reachable only via the API's `CHAIN` binding. Signs `TemplateMarketplace.publishFor` with `RELAYER_PRIVATE_KEY` (secret). Exists because secp256k1 signing in pure Python exceeds Workers Free (~10 ms CPU).
* **`gen/`** — Worker `edtech-monad-gen` (TypeScript). `workers_dev: false`, so it is reachable only through the API's `GEN` binding (protects the Workers AI quota).
  * `/extract`: R2 PDF → `env.AI.toMarkdown()` → `pages.txt` (UTF-8) + `pages-index.json` (byte offsets) in R2.
  * `/generate`: R2 range-read of the selected pages only → `chat({ adapter, outputSchema })` from **`@tanstack/ai`** with the official **`@tanstack/ai-cloudflare`** adapter on the `AI` binding → Zod-validated study template (`src/schema.ts`: title, summary, learning objectives, sections + key concepts, definitions, worked examples, practice questions with answers/explanations, Mermaid diagrams). Post-processing removes duplicate questions, quotes Mermaid labels and repairs LaTeX backslashes that JSON turned into control characters.
  * Model: `AI_MODEL` var (default `@cf/meta/llama-3.1-8b-instruct-fast`; plain `@cf/meta/llama-3.1-8b-instruct` is deprecated on Workers AI and `-fp8` doesn't support JSON Schema). Override with `npx wrangler deploy --var AI_MODEL:<model id>`. Optional vars for other models: `AI_REASONING_EFFORT` (`low`/`medium`/`high`, reasoning models such as `@cf/qwen/qwen3.8-27b`) and `AI_STREAM_AGGREGATE=true` (send the call streamed and fold it back into one response: long non-streaming Qwen 3.8 calls failed with `408 AiError: Request timeout`). Token usage is recorded in `templates.generation.usage`.
  * Provider: `LLM_PROVIDER` var, `cloudflare` (default, Workers AI) or `openai` (OpenAI Responses API through **`@tanstack/ai-openai`**, one non-streaming `json_schema` call). OpenAI vars: `OPENAI_MODEL` (default `gpt-6-luna`), `OPENAI_REASONING_EFFORT` (`low`…`high`/`xhigh`/`max`), `OPENAI_MAX_OUTPUT_TOKENS` (default 64000) and the secret `OPENAI_API_KEY` (`printf %s "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY`). Try it with `npx wrangler deploy --var LLM_PROVIDER:openai --var OPENAI_REASONING_EFFORT:low`. `generation` records `provider`, `usage` (prompt/cached/completion/reasoning tokens), `attempt_ms` and `cost_usd`.
  * Comparison on Hefferon pp. 11–22 (Gauss's Method), hand-checked: Llama 3.1 8B fast: 1/2 worked examples correct, 0/4 questions usable, ~18 s. Qwen 3.8 27B (low): 3/3 examples, 4/6 questions correct, 332 s (2 attempts). gpt-6-luna `low`: 3/3 examples, 6/6 questions, 19 s, $0.0021. gpt-6-luna `max`: 2/2 examples, 6/6 questions, 144 s, $0.0093 (17k output tokens, 14k of them reasoning). Worker CPU stays at 43–68 ms either way, because the Worker just waits on the network.
  * Limits per generation: `MAX_PAGES=12`, `MAX_INPUT_CHARS=24000` (~8.5k tokens of math text), `MAX_OUTPUT_TOKENS=6000`. Longer selections are truncated and flagged (`generation.truncated`). For big books (e.g. Hefferon's 525-page *Linear Algebra*) pick a section, e.g. pages 11–22 = Chapter One §I.1 "Gauss's Method".
  * Workers Free plan (10 ms CPU/request): the stock adapter streams structured output token by token (~1.9 s CPU → `exceededCpu`), so `gen` uses a tiny adapter subclass that hides `structuredOutputStream`, making TanStack AI use the adapter's non-streaming `structuredOutput` (~45 ms CPU).
  * Flow is synchronous (extract ≈ 10–16 s, generate ≈ 18–28 s for Hefferon). Queues were not used today; they would be the next step for longer jobs.
* **`web/`** — Worker `edtech-monad-web`, TanStack Start. Never talks to Supabase. Privy lives under `src/lib/privy/` (+ minimal `AuthButton`) so UI rebuilds merge cleanly. Pages: `/` (health), `/templates`, `/upload` (PDF input + loading states; deliberately unstyled, the UI will be rebuilt), `/templates/<id>` (SSR-rendered template; Mermaid rendered client-side only and stubbed out of the Worker bundle).
* **`supabase/migrations/`** — SQL applied to the project (Day 2: `materials.original_filename/text_r2_key/error`, `templates.content/status/error/generation`; Privy day: `purchases` with unique `tx_hash`).

## Privy setup (manual — Juan)

There is **no Privy App ID in the repo yet**. Create one, then wire env vars.

1. Create an app at [dashboard.privy.io](https://dashboard.privy.io).
2. Enable **email** login and **embedded wallets** (create on login for users without a wallet).
3. Enable **identity tokens** (recommended) so the API can read the wallet without an extra Privy REST call.
4. Add allowed origins: `http://localhost:3000`, the deployed `edtech-monad-web.*.workers.dev` URL, and any custom domain.
5. Copy the **App ID** (public) and **App Secret** (server-only).

### Env vars / secrets

| Name | Where | Public? | Notes |
|------|--------|---------|--------|
| `VITE_PRIVY_APP_ID` | `web/.env.local` (build-time) | yes | Only Privy value allowed in the web bundle |
| `PRIVY_APP_ID` | `api` wrangler var / `.dev.vars` | yes | Same value as above; used for JWT `aud` |
| `PRIVY_APP_SECRET` | `api` Worker secret / `.dev.vars` | **no** | Privy users API fallback for wallet lookup |
| `RELAYER_PRIVATE_KEY` | `chain` Worker secret / `.dev.vars` | **no** | EOA that holds `RELAYER_ROLE` on TemplateMarketplace; never commit |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `api` secrets | **no** | unchanged |
| `VITE_API_URL` | `web` | yes | API base URL |
| `MARKETPLACE_ADDRESS` / `MONAD_RPC_URL` | `api` / `chain` vars | yes | defaults to Monad testnet deployment |

Example (no real secrets):

```bash
# web/.env.local
VITE_API_URL=http://localhost:8787
VITE_PRIVY_APP_ID=your-privy-app-id

# api/.dev.vars
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret

# chain/.dev.vars
RELAYER_PRIVATE_KEY=0xYOUR_RELAYER_PRIVATE_KEY_HEX
```

### JWT verification + CPU

Privy access/identity tokens are ES256 JWTs. The API verifies them with:

* algorithm **pinned to ES256** (header `alg` is not trusted for crypto; non-ES256 is rejected)
* `iss == privy.io`, `aud == PRIVY_APP_ID`, `exp` checked; `sub` (Privy DID) is the userId
* JWKS from `https://auth.privy.io/api/v1/apps/{PRIVY_APP_ID}/jwks.json`, cached ~300s, refetched on unknown `kid`
* Signature check via **WebCrypto** `crypto.subtle.verify` (ECDSA P-256 / SHA-256) through the Python Workers JS FFI — not pure-Python EC math

Measure locally: `node api/tests/measure_webcrypto_es256.mjs` (see `api/tests/README_CPU.md`). Expect well under the Workers Free **10 ms CPU** budget per verify; pure-Python EC would not fit.

Wallet address is derived from a verified identity token or Privy's server API with the App Secret — **never** from the client body.

### Follow-ups

* Split the marketplace **relayer** role from **admin** (today the same EOA holds both on testnet).
* Move session cookie to `SameSite=Strict` once web and API share a parent domain.
* Index `Purchased` / `TemplatePublished` events into Supabase for the library dashboard.
* Optional: dedicated JWT verifier TS Worker if WebCrypto FFI CPU regresses under load.

## Prerequisites

Node ≥ 22 (create-cloudflare/wrangler requirement), [uv](https://docs.astral.sh/uv/), a Cloudflare API token in `CLOUDFLARE_API_TOKEN`.

## Local development

```bash
# Chain relayer (needed when testing publishFor)
cd chain && npm install && cp .dev.vars.example .dev.vars && npx wrangler dev --port 8788

# API (http://localhost:8787)
cd api
cp .dev.vars.example .dev.vars   # fill in Supabase + Privy (gitignored)
uv run pywrangler dev

# Web (http://localhost:3000)
cd web
npm install
cp .env.example .env.local       # VITE_API_URL + VITE_PRIVY_APP_ID
npm run dev

# API unit tests
cd api && uv run pytest -q

# WebCrypto CPU micro-benchmark
node api/tests/measure_webcrypto_es256.mjs
```

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...      # never commit
./scripts/deploy.sh                  # R2 + gen → chain → api → secrets → web → api (FRONTEND_ORIGIN)
```

Manual equivalents:

```bash
cd gen && npm ci && npx wrangler deploy
cd chain && npm ci && npx wrangler deploy
cd chain && printf '%s' "$RELAYER_PRIVATE_KEY" | npx wrangler secret put RELAYER_PRIVATE_KEY
cd api && uv run pywrangler deploy --var FRONTEND_ORIGIN:https://edtech-monad-web.<subdomain>.workers.dev --var PRIVY_APP_ID:your-privy-app-id
cd api && uv run pywrangler secret put SUPABASE_URL
cd api && uv run pywrangler secret put SUPABASE_SERVICE_ROLE_KEY
cd api && uv run pywrangler secret put PRIVY_APP_SECRET
cd web && VITE_API_URL=https://edtech-monad-api.<subdomain>.workers.dev VITE_PRIVY_APP_ID=your-privy-app-id npm run build && npx wrangler deploy
```
