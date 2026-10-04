#!/usr/bin/env bash
# Deploy order: gen → chain → api → indexer → web.
# Apply Supabase migrations (including creator-economy indexer) BEFORE api/indexer.
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

# 0) R2 bucket (idempotent) + gen Worker (must exist before the API's GEN service binding)
(cd "$ROOT/gen" && { npx wrangler r2 bucket list 2>/dev/null | grep -q 'edtech-monad-pdfs' || npx wrangler r2 bucket create edtech-monad-pdfs; } \
  && npm ci --silent && npx wrangler deploy)

# 0b) Chain / relayer Worker (must exist before the API's CHAIN service binding)
(cd "$ROOT/chain" && npm ci --silent && npx wrangler deploy)
if [ -f "$CREDS" ]; then
  get() { grep -E "^$1=" "$CREDS" | head -1 | cut -d= -f2- | tr -d '\r' ; }
  RK="$(get RELAYER_PRIVATE_KEY)"
  if [ -n "${RK:-}" ]; then
    (cd "$ROOT/chain" && printf '%s' "$RK" | npx wrangler secret put RELAYER_PRIVATE_KEY >/dev/null && echo "RELAYER_PRIVATE_KEY secret set on chain.")
  else
    echo "RELAYER_PRIVATE_KEY missing in $CREDS — set later: cd chain && npx wrangler secret put RELAYER_PRIVATE_KEY"
  fi
  unset RK
fi

# 1) Deploy API (first pass: FRONTEND_ORIGIN unknown yet if web not deployed)
cd "$ROOT/api"
WEB_ORIGIN="${WEB_ORIGIN:-}"
API_OUT="$(uv run pywrangler deploy ${WEB_ORIGIN:+--var FRONTEND_ORIGIN:$WEB_ORIGIN} 2>&1 | tee /dev/stderr)"
API_URL="$(echo "$API_OUT" | grep -oE 'https://edtech-monad-api\.[a-z0-9-]+\.workers\.dev' | head -1)"
: "${API_URL:?could not determine API URL}"
echo "API_URL=$API_URL"

# 2) Supabase + Privy + indexer secrets (values piped via stdin, never printed)
if [ -f "$CREDS" ]; then
  get() { grep -E "^$1=" "$CREDS" | head -1 | cut -d= -f2- | tr -d '\r' ; }
  SU="$(get SUPABASE_URL)"; SK="$(get SUPABASE_SERVICE_ROLE_KEY)"
  PA="$(get PRIVY_APP_ID)"; PS="$(get PRIVY_APP_SECRET)"
  IIS="$(get INDEXER_INTERNAL_SECRET)"
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
  if [ -n "${PS:-}" ]; then
    printf '%s' "$PS" | uv run pywrangler secret put PRIVY_APP_SECRET >/dev/null && echo "PRIVY_APP_SECRET secret set."
  else
    echo "PRIVY_APP_SECRET missing in $CREDS — set after creating the Privy app."
  fi
  if [ -n "${IIS:-}" ]; then
    printf '%s' "$IIS" | uv run pywrangler secret put INDEXER_INTERNAL_SECRET >/dev/null && echo "INDEXER_INTERNAL_SECRET secret set on api."
  else
    echo "INDEXER_INTERNAL_SECRET missing in $CREDS — generate one and set on api + indexer before enabling cron ingest."
  fi
  if [ -n "${PA:-}" ]; then
    # App ID is a public var (also baked into the web bundle as VITE_PRIVY_APP_ID)
    uv run pywrangler deploy ${WEB_ORIGIN:+--var FRONTEND_ORIGIN:$WEB_ORIGIN} --var "PRIVY_APP_ID:$PA" >/dev/null \
      && echo "PRIVY_APP_ID var set."
  fi
  unset SU SK PA PS IIS
fi

# 2b) Indexer Worker (Cron → API service binding). Deploy AFTER api exists.
(cd "$ROOT/indexer" && npm ci --silent && npx wrangler deploy)
if [ -f "$CREDS" ]; then
  get() { grep -E "^$1=" "$CREDS" | head -1 | cut -d= -f2- | tr -d '\r' ; }
  IIS="$(get INDEXER_INTERNAL_SECRET)"
  if [ -n "${IIS:-}" ]; then
    (cd "$ROOT/indexer" && printf '%s' "$IIS" | npx wrangler secret put INDEXER_INTERNAL_SECRET >/dev/null \
      && echo "INDEXER_INTERNAL_SECRET secret set on indexer.")
  fi
  unset IIS
fi

# 3) Build + deploy web with the API URL baked in
cd "$ROOT/web"
VITE_API_URL="$API_URL" \
  VITE_PRIVY_APP_ID="${VITE_PRIVY_APP_ID:-}" \
  npm run build
WEB_OUT="$(npx wrangler deploy 2>&1 | tee /dev/stderr)"
WEB_URL="$(echo "$WEB_OUT" | grep -oE 'https://edtech-monad-web\.[a-z0-9-]+\.workers\.dev' | head -1)"
echo "WEB_URL=$WEB_URL"

# 4) Redeploy API with the real FRONTEND_ORIGIN (CORS)
if [ -n "$WEB_URL" ] && [ "$WEB_URL" != "$WEB_ORIGIN" ]; then
  cd "$ROOT/api" && uv run pywrangler deploy --var "FRONTEND_ORIGIN:$WEB_URL"
fi
echo; echo "Health:"; curl -s "$API_URL/health"; echo
