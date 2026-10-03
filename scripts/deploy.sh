#!/usr/bin/env bash
# Deploy edtech-monad-api (Python Worker) then edtech-monad-web (TanStack Start Worker).
# Requires: CLOUDFLARE_API_TOKEN in env, Node >= 22, uv.
# Optional: CREDS=/path/to/supabase-credentials.env (default ../supabase-credentials.env)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CREDS="${CREDS:-$ROOT/../supabase-credentials.env}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"

# Account ID (only if not already set)
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(cd "$ROOT/web" && npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  export CLOUDFLARE_ACCOUNT_ID
fi
echo "Account: ${CLOUDFLARE_ACCOUNT_ID:-<auto>}"

# 1) Deploy API (first pass: FRONTEND_ORIGIN unknown yet if web not deployed)
cd "$ROOT/api"
WEB_ORIGIN="${WEB_ORIGIN:-}"
API_OUT="$(uv run pywrangler deploy ${WEB_ORIGIN:+--var FRONTEND_ORIGIN:$WEB_ORIGIN} 2>&1 | tee /dev/stderr)"
API_URL="$(echo "$API_OUT" | grep -oE 'https://edtech-monad-api\.[a-z0-9-]+\.workers\.dev' | head -1)"
: "${API_URL:?could not determine API URL}"
echo "API_URL=$API_URL"

# 2) Supabase secrets (values piped via stdin, never printed)
if [ -f "$CREDS" ]; then
  get() { grep -E "^$1=" "$CREDS" | head -1 | cut -d= -f2- | tr -d '\r' ; }
  SU="$(get SUPABASE_URL)"; SK="$(get SUPABASE_SERVICE_ROLE_KEY)"
  if [ -n "$SU" ]; then
    printf '%s' "$SU" | uv run pywrangler secret put SUPABASE_URL >/dev/null && echo "SUPABASE_URL secret set."
  else
    echo "SUPABASE_URL missing in $CREDS — skipping."
  fi
  if [ -n "$SK" ]; then
    printf '%s' "$SK" | uv run pywrangler secret put SUPABASE_SERVICE_ROLE_KEY >/dev/null && echo "SUPABASE_SERVICE_ROLE_KEY secret set."
  else
    echo "SUPABASE_SERVICE_ROLE_KEY missing in $CREDS — skipping (health will report Supabase not configured)."
  fi
  unset SU SK
fi

# 3) Build + deploy web with the API URL baked in
cd "$ROOT/web"
VITE_API_URL="$API_URL" npm run build
WEB_OUT="$(npx wrangler deploy 2>&1 | tee /dev/stderr)"
WEB_URL="$(echo "$WEB_OUT" | grep -oE 'https://edtech-monad-web\.[a-z0-9-]+\.workers\.dev' | head -1)"
echo "WEB_URL=$WEB_URL"

# 4) Redeploy API with the real FRONTEND_ORIGIN (CORS)
if [ -n "$WEB_URL" ] && [ "$WEB_URL" != "$WEB_ORIGIN" ]; then
  cd "$ROOT/api" && uv run pywrangler deploy --var "FRONTEND_ORIGIN:$WEB_URL"
fi
echo; echo "Health:"; curl -s "$API_URL/health"; echo
