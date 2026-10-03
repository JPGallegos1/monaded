# edtech-monad

Hackathon MVP skeleton for an EdTech app (learning materials + remixable, sellable templates; Privy auth / Monad wallet), on Cloudflare.

## Architecture

```
Browser ──► edtech-monad-web  (TanStack Start + TanStack Router, Cloudflare Worker w/ static assets)
               │  fetch(VITE_API_URL)
               ▼
           edtech-monad-api  (Cloudflare Worker, pure Python / Python Workers)
               │  fetch PostgREST  (service role key from Worker secrets)
               ▼
           Supabase (Postgres: users, materials, templates)
```

* **`api/`** — Worker `edtech-monad-api`, pure Python (`src/entry.py`, `src/supabase_rest.py`). The **only** component that talks to Supabase, via the PostgREST REST API (`/rest/v1/...`) with `SUPABASE_SERVICE_ROLE_KEY`. No Python packages, no Node code in the Worker.
  * `GET /health` → `{"ok": true, "supabase": {"configured": bool, "reachable": bool, "status": int}}`
  * `GET /templates` → `{"templates": [...]}` (rows with `is_published = true`)
  * `POST /users` → upsert by `privy_user_id` (fields: `privy_user_id`, `wallet_address`, `email`, `display_name`, `learning_style`). Requires a UNIQUE constraint on `users.privy_user_id`.
  * CORS: only `FRONTEND_ORIGIN` (comma-separated allowed) + `http://localhost:3000|5173`.
  * Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Var: `FRONTEND_ORIGIN`.
* **`web/`** — Worker `edtech-monad-web`, TanStack Start. Never talks to Supabase; calls the API at `VITE_API_URL` (inlined at build time). Pages: `/` (API + Supabase health) and `/templates`.
  * Note: the user asked for Pages, but current official Cloudflare guidance for TanStack Start is **Workers with static assets** (`@cloudflare/vite-plugin`, `wrangler deploy`), so that is what's used.

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
./scripts/deploy.sh                  # api → secrets (from ../supabase-credentials.env if complete) → web → api again with FRONTEND_ORIGIN
```

Manual equivalents:

```bash
cd api && uv run pywrangler deploy --var FRONTEND_ORIGIN:https://edtech-monad-web.<subdomain>.workers.dev
cd api && uv run pywrangler secret put SUPABASE_URL                # prompts / reads stdin
cd api && uv run pywrangler secret put SUPABASE_SERVICE_ROLE_KEY
cd web && VITE_API_URL=https://edtech-monad-api.<subdomain>.workers.dev npm run build && npx wrangler deploy
```
