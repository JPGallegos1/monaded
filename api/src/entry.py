"""edtech-monad-api — pure Python Cloudflare Worker.

Routes:
  GET  /health                     -> {"ok": true, "supabase": {...}, "gen": {...}, "privy": {...}}
  GET  /templates                  -> {"templates": [...published templates...]} (preview content only)
  GET  /templates/{id}             -> {"template": {...}} preview for public; full content for owner
  GET  /templates/{id}/content     -> full content (session; owner or onchain hasLicense)
  POST /templates/{id}/fork        -> create draft fork with parent_template_id (session + license/owner)
  POST /users                      -> upsert a user by privy_user_id (legacy; prefer session)
  POST /auth/session               -> exchange Privy access (+ identity) token for HttpOnly session cookie
  GET  /auth/session               -> current session {userId, walletAddress} (from cookie)
  POST /auth/logout                -> clear session cookie + Durable Object
  POST /purchases/verify           -> verify TemplateMarketplace buy tx; record once (unique tx_hash)
  POST /templates/{id}/publish     -> relayer publishFor; creator = session wallet only
  POST /materials                  -> multipart (file=<PDF>, title?) -> R2 + materials row
  GET  /materials/{id}             -> {"material": {...}, "templates": [...]}
  POST /materials/{id}/extract     -> PDF text extraction via the gen Worker (Workers AI toMarkdown)
  POST /materials/{id}/templates   -> JSON {start_page?, end_page?, learning_style?}
                                      -> AI study template via the gen Worker, saved to `templates`

  GET  /me/earnings                -> creator dashboard totals + recent sales/royalties (session; native MON)

Internal (indexer / backfill only — require X-Edtech-Internal == INDEXER_INTERNAL_SECRET):
  GET  /internal/indexer/cursor    -> {cursor: {chain_id, contract, last_block}}
  POST /internal/indexer/events    -> idempotent upsert of decoded logs + advance cursor

Content gating: non-owners see preview only. Full content requires material ownership or
onchain hasLicense for the session wallet. Never call updateTemplate from this Worker.

The gen Worker (TypeScript, TanStack AI) is reached through the `GEN` service binding and never
touches Supabase: this Worker remains the only component that reads/writes the database.

Privy session state lives in the SessionDO Durable Object (userId + wallet only — never raw tokens).
On-chain publishFor is signed by edtech-monad-chain (CHAIN binding) with RELAYER_PRIVATE_KEY.
The indexer Worker posts decoded TemplateMarketplace logs via the internal routes above;
it never talks to Supabase directly.
"""

import json
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from workers import Response, WorkerEntrypoint

from privy_jwt import JwtError, JwksCache, verify_privy_jwt
from privy_users import PrivyUserError, resolve_wallet_address
from ownership import (
    OwnershipError,
    assert_can_publish,
    build_publish_uri,
    validate_publish_price,
    validate_publish_uri,
)
from publish import (
    PublishError,
    build_publish_broadcast_patch,
    build_publish_success_patch,
    claim_template_for_publish,
    fetch_publish_receipt,
    recoverable_publish_state,
    release_publish_claim,
    resolve_parent_onchain_id,
    send_publish_for,
)
from purchase import PurchaseError, verify_purchase_tx
from purchase_resolve import onchain_id_from_template, resolve_template_for_purchase
from rate_limit_do import GLOBAL_DO_NAME, PublishRateLimitDO  # noqa: F401
from session import (
    SESSION_COOKIE,
    create_session,
    delete_session,
    get_session_id_from_request,
    read_session,
    require_session,
    session_cookie_header,
)
from session_do import SessionDO  # noqa: F401 — exported for wrangler DO binding
from supabase_rest import Supabase, SupabaseError, SupabaseNotConfigured
from license_check import has_license, public_template_view
from fork import ForkError, build_fork_rows
from indexer import (
    DEFAULT_CHAIN_ID,
    DEFAULT_CONTRACT,
    IndexerError,
    assert_allowed_scope,
    get_cursor,
    ingest_events,
    parse_ingest_payload,
    require_internal,
)
from earnings import get_earnings_for_wallet

DEV_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

USER_FIELDS = ("privy_user_id", "wallet_address", "email", "display_name", "learning_style")
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UUID_RE = r"[0-9a-fA-F-]{36}"
GEN_BASE = "https://edtech-monad-gen.internal"  # host is ignored by service bindings

# Module-level JWKS cache (per isolate). Short TTL; unknown kid forces refresh.
_JWKS_CACHE = JwksCache()


class HttpError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def _js_missing(v):
    return v is None or type(v).__name__ in ("JsNull", "JsUndefined") or str(v) in ("null", "undefined")


def log(event, **fields):
    print(json.dumps({"event": event, **fields}))


def _env_str(env, name, default=""):
    try:
        v = getattr(env, name)
    except AttributeError:
        return default
    if v is None:
        return default
    return str(v).strip() or default


class Default(WorkerEntrypoint):
    # ---- CORS -------------------------------------------------------------
    def _allowed_origins(self):
        allowed = set(DEV_ORIGINS)
        try:
            frontend = str(self.env.FRONTEND_ORIGIN or "")
        except AttributeError:
            frontend = ""
        for o in frontend.split(","):
            o = o.strip().rstrip("/")
            if o:
                allowed.add(o)
        return allowed

    def _cors_headers(self, request, *, set_cookie: str | None = None):
        origin = request.headers.get("Origin")
        headers = {"Vary": "Origin"}
        if origin and origin in self._allowed_origins():
            headers.update(
                {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization,Privy-Id-Token",
                    "Access-Control-Allow-Credentials": "true",
                    "Access-Control-Max-Age": "86400",
                }
            )
        if set_cookie:
            headers["Set-Cookie"] = set_cookie
        return headers

    def _json(self, request, data, status=200, *, set_cookie: str | None = None):
        headers = {"Content-Type": "application/json"}
        headers.update(self._cors_headers(request, set_cookie=set_cookie))
        return Response(json.dumps(data), status=status, headers=headers)

    # ---- Entry ------------------------------------------------------------
    async def fetch(self, request):
        method = request.method.upper()
        path = urlparse(request.url).path.rstrip("/") or "/"

        if method == "OPTIONS":
            origin = request.headers.get("Origin")
            if origin and origin not in self._allowed_origins():
                return Response("", status=403, headers={"Vary": "Origin"})
            return Response("", status=204, headers=self._cors_headers(request))

        try:
            if path == "/health" and method == "GET":
                return await self.health(request)
            if path == "/templates" and method == "GET":
                return await self.templates(request)
            if path == "/users" and method == "POST":
                return await self.upsert_user(request)
            if path == "/auth/session" and method == "POST":
                return await self.create_auth_session(request)
            if path == "/auth/session" and method == "GET":
                return await self.get_auth_session(request)
            if path == "/auth/logout" and method == "POST":
                return await self.logout(request)
            if path == "/me/earnings" and method == "GET":
                return await self.me_earnings(request)
            if path == "/purchases/verify" and method == "POST":
                return await self.verify_purchase(request)
            if path == "/internal/indexer/cursor" and method == "GET":
                return await self.indexer_cursor(request)
            if path == "/internal/indexer/events" and method == "POST":
                return await self.indexer_events(request)
            if path == "/materials" and method == "POST":
                return await self.upload_material(request)
            m = re.fullmatch(rf"/templates/({UUID_RE})", path)
            if m and method == "GET":
                return await self.get_template(request, m.group(1))
            m = re.fullmatch(rf"/templates/({UUID_RE})/content", path)
            if m and method == "GET":
                return await self.get_template_content(request, m.group(1))
            m = re.fullmatch(rf"/templates/({UUID_RE})/fork", path)
            if m and method == "POST":
                return await self.fork_template(request, m.group(1))
            m = re.fullmatch(rf"/templates/({UUID_RE})/publish", path)
            if m and method == "POST":
                return await self.publish_template(request, m.group(1))
            m = re.fullmatch(rf"/materials/({UUID_RE})(/extract|/templates)?", path)
            if m:
                mid, sub = m.group(1), m.group(2)
                if sub is None and method == "GET":
                    return await self.get_material(request, mid)
                if sub == "/extract" and method == "POST":
                    return await self.extract_material(request, mid)
                if sub == "/templates" and method == "POST":
                    return await self.generate_template(request, mid)
                return self._json(request, {"error": "method not allowed"}, 405)
            if path in (
                "/health",
                "/templates",
                "/users",
                "/materials",
                "/auth/session",
                "/auth/logout",
                "/me/earnings",
                "/purchases/verify",
            ):
                return self._json(request, {"error": "method not allowed"}, 405)
            return self._json(request, {"error": "not found"}, 404)
        except HttpError as e:
            return self._json(request, {"error": e.message, **e.extra}, e.status)
        except JwtError as e:
            return self._json(request, {"error": e.message, "code": e.code}, 401)
        except PrivyUserError as e:
            return self._json(request, {"error": e.message, "code": e.code}, 400)
        except PurchaseError as e:
            status = 409 if e.code == "replay" else 400
            if e.code == "not_found":
                status = 404
            return self._json(request, {"error": e.message, "code": e.code}, status)
        except OwnershipError as e:
            return self._json(request, {"error": e.message, "code": e.code}, e.status)
        except ForkError as e:
            return self._json(request, {"error": e.message, "code": e.code}, e.status)
        except IndexerError as e:
            return self._json(request, {"error": e.message, "code": e.code}, e.status)
        except PublishError as e:
            if e.status is not None:
                status = e.status
            elif e.code == "rate_limited":
                status = 429
            elif e.code == "publishing_in_progress":
                status = 409
            elif e.code in ("config", "chain", "reverted", "persist"):
                status = 503 if e.code == "config" else 502
            elif e.code == "pending":
                status = 409
            else:
                status = 400
            return self._json(request, {"error": e.message, "code": e.code}, status)
        except SupabaseNotConfigured:
            return self._json(request, {"error": "supabase not configured"}, 503)
        except SupabaseError as e:
            log("supabase_error", status=e.status, path=path)
            # Unique violation on purchases.tx_hash → replay
            detail = e.detail
            if e.status == 409 or (isinstance(detail, dict) and "tx_hash" in str(detail).lower()):
                return self._json(request, {"error": "tx hash already used", "code": "replay"}, 409)
            return self._json(request, {"error": "supabase error", "status": e.status, "detail": e.detail}, 502)
        except Exception as e:  # noqa: BLE001
            log("unhandled_error", path=path, error=repr(e))
            return self._json(request, {"error": "internal error"}, 500)

    # ---- Handlers ---------------------------------------------------------
    async def health(self, request):
        sb = Supabase(self.env)
        supa = {"configured": sb.configured, "reachable": False}
        if sb.configured:
            try:
                reachable, status = await sb.ping()
                supa.update({"reachable": reachable, "status": status})
            except Exception as e:  # noqa: BLE001
                supa["error"] = type(e).__name__
        gen = {"bound": False}
        try:
            status, body = await self._gen("GET", "/health")
            gen = {"bound": True, "status": status, "model": (body or {}).get("model")}
        except Exception as e:  # noqa: BLE001
            gen["error"] = type(e).__name__
        privy_app = _env_str(self.env, "PRIVY_APP_ID")
        privy_secret = bool(_env_str(self.env, "PRIVY_APP_SECRET"))
        chain = {"bound": False}
        try:
            resp = await self.env.CHAIN.fetch("https://edtech-monad-chain.internal/health", method="GET")
            chain = {"bound": True, "status": resp.status}
        except Exception as e:  # noqa: BLE001
            chain["error"] = type(e).__name__
        return self._json(
            request,
            {
                "ok": True,
                "service": "edtech-monad-api",
                "supabase": supa,
                "gen": gen,
                "chain": chain,
                "privy": {"app_id_configured": bool(privy_app), "app_secret_configured": privy_secret},
            },
        )

    async def templates(self, request):
        rows = await Supabase(self.env).list_published_templates()
        # Catalog is public — never ship full study content in the list.
        preview_rows = [public_template_view(r, include_full_content=False) for r in (rows or [])]
        return self._json(request, {"templates": preview_rows})

    async def upsert_user(self, request):
        """Update profile fields for the authenticated session user only."""
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            return self._json(request, {"error": str(e)}, 401)
        try:
            body = json.loads(await request.text())
        except Exception:  # noqa: BLE001
            return self._json(request, {"error": "invalid JSON body"}, 400)
        if not isinstance(body, dict):
            return self._json(request, {"error": "body must be a JSON object"}, 400)
        # userId always from session — ignore any client privy_user_id
        row = {k: body[k] for k in ("email", "display_name", "learning_style") if k in body}
        row["privy_user_id"] = session["userId"]
        # Wallet only from session (never from body)
        row["wallet_address"] = session["walletAddress"]
        rows = await Supabase(self.env).upsert_user(row)
        user = rows[0] if isinstance(rows, list) and rows else rows
        return self._json(request, {"user": user})

    # ---- Auth / session ---------------------------------------------------
    async def create_auth_session(self, request):
        """Exchange a Privy access token (+ optional identity token) for a session cookie."""
        app_id = _env_str(self.env, "PRIVY_APP_ID")
        app_secret = _env_str(self.env, "PRIVY_APP_SECRET")
        if not app_id:
            raise HttpError(503, "PRIVY_APP_ID not configured")

        auth = request.headers.get("Authorization") or ""
        access_token = None
        if auth.lower().startswith("bearer "):
            access_token = auth[7:].strip()
        body = {}
        try:
            text = await request.text()
            if text:
                body = json.loads(text)
        except ValueError:
            raise HttpError(400, "invalid JSON body")
        if not access_token and isinstance(body, dict):
            access_token = body.get("access_token") or body.get("accessToken")
        if not isinstance(access_token, str) or not access_token:
            raise HttpError(401, "missing Privy access token")

        t0 = time.time()
        claims = await verify_privy_jwt(access_token, app_id, cache=_JWKS_CACHE)
        verify_ms = int((time.time() - t0) * 1000)
        log("privy_jwt_verified", ms=verify_ms, user_id=claims["sub"])

        identity_token = request.headers.get("Privy-Id-Token")
        if not identity_token and isinstance(body, dict):
            identity_token = body.get("identity_token") or body.get("identityToken")

        wallet = await resolve_wallet_address(
            user_id=claims["sub"],
            app_id=app_id,
            app_secret=app_secret,
            identity_token=identity_token if isinstance(identity_token, str) else None,
            jwks_cache=_JWKS_CACHE,
        )

        # Upsert user with server-derived wallet
        sb = Supabase(self.env)
        if sb.configured:
            await sb.upsert_user(
                {"privy_user_id": claims["sub"], "wallet_address": wallet}
            )

        session_id = await create_session(
            self.env, user_id=claims["sub"], wallet_address=wallet, exp=claims["exp"]
        )
        cookie = session_cookie_header(session_id, claims["exp"])
        return self._json(
            request,
            {
                "ok": True,
                "userId": claims["sub"],
                "walletAddress": wallet,
                "exp": claims["exp"],
                "verify_ms": verify_ms,
            },
            set_cookie=cookie,
        )

    async def get_auth_session(self, request):
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            return self._json(request, {"ok": False, "error": str(e)}, 401)
        return self._json(
            request,
            {
                "ok": True,
                "userId": session["userId"],
                "walletAddress": session["walletAddress"],
                "exp": session.get("exp"),
            },
        )

    async def logout(self, request):
        sid = get_session_id_from_request(request)
        if sid:
            await delete_session(self.env, sid)
        cookie = session_cookie_header("", 0, clear=True)
        return self._json(request, {"ok": True}, set_cookie=cookie)

    # ---- Creator earnings (session wallet only) ---------------------------
    async def me_earnings(self, request):
        """Native-MON creator totals + recent sales/royalties for the session wallet."""
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            return self._json(request, {"error": str(e)}, 401)
        wallet = session.get("walletAddress") or session.get("wallet_address")
        if not isinstance(wallet, str) or not wallet.strip():
            return self._json(request, {"error": "not authenticated"}, 401)
        # Never take wallet from query/body — session only.
        sb = Supabase(self.env)
        payload = await get_earnings_for_wallet(sb, wallet)
        return self._json(request, payload)

    # ---- Internal indexer (service binding / backfill only) ---------------
    async def indexer_cursor(self, request):
        require_internal(self.env, request)
        qs = urlparse(request.url).query
        params = {}
        if qs:
            for part in qs.split("&"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    params[k] = v
        chain_id, contract = assert_allowed_scope(
            chain_id=params.get("chain_id", DEFAULT_CHAIN_ID),
            contract=params.get("contract", DEFAULT_CONTRACT),
        )
        sb = Supabase(self.env)
        cursor = await get_cursor(sb, chain_id=chain_id, contract=contract)
        return self._json(request, {"ok": True, "cursor": cursor})

    async def indexer_events(self, request):
        require_internal(self.env, request)
        body = await self._json_body(request)
        chain_id, contract, from_block, to_block, events, advance = parse_ingest_payload(body)
        sb = Supabase(self.env)
        result = await ingest_events(
            sb,
            chain_id=chain_id,
            contract=contract,
            from_block=from_block,
            to_block=to_block,
            events=events,
            advance=advance,
        )
        log(
            "indexer_ingest",
            from_block=from_block,
            to_block=to_block,
            events=result.get("events"),
            upserted=result.get("upserted"),
        )
        return self._json(request, result)

    # ---- Purchases --------------------------------------------------------
    async def verify_purchase(self, request):

        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            raise HttpError(401, str(e))
        body = await self._json_body(request)
        tx_hash = body.get("tx_hash") or body.get("txHash")
        onchain_id = body.get("onchain_template_id") or body.get("onchainTemplateId")
        template_id = body.get("template_id") or body.get("templateId")

        sb = Supabase(self.env)
        tpl = await resolve_template_for_purchase(
            sb,
            template_id=template_id if isinstance(template_id, str) else None,
            onchain_template_id=onchain_id,
        )
        onchain_id_int = onchain_id_from_template(tpl)

        marketplace = _env_str(self.env, "MARKETPLACE_ADDRESS", "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e")
        rpc_url = _env_str(self.env, "MONAD_RPC_URL", "https://testnet-rpc.monad.xyz")

        matched = await verify_purchase_tx(
            tx_hash=str(tx_hash or ""),
            buyer_wallet=session["walletAddress"],
            onchain_template_id=onchain_id_int,
            marketplace=marketplace,
            rpc_url=rpc_url,
        )

        user_row = await sb.get_by("users", "privy_user_id", session["userId"])
        purchase_row = {
            "tx_hash": matched["txHash"],
            "onchain_template_id": str(matched["templateId"]),
            "buyer_wallet": matched["buyer"],
            "creator_wallet": matched.get("creator"),
            "buyer_user_id": user_row["id"] if user_row else None,
            # Always the DB-resolved UUID — never a client-supplied mapping.
            "template_id": tpl["id"],
        }
        try:
            row = await sb.insert_purchase(purchase_row)
        except SupabaseError as e:
            if e.status in (409, 23505) or "duplicate" in str(e.detail).lower() or "unique" in str(e.detail).lower():
                raise PurchaseError("tx hash already used", code="replay") from e
            raise
        return self._json(request, {"ok": True, "purchase": row, "event": matched}, 201)

    # ---- Publish (relayer) ------------------------------------------------
    async def _check_publish_rate_limits(self, user_id: str):
        """Per-user then global publish caps (fail closed)."""
        try:
            user_stub = self.env.PUBLISH_RATE_LIMITS.get(self.env.PUBLISH_RATE_LIMITS.idFromName(user_id))
            user_resp = await user_stub.fetch(
                "https://rate.internal/check",
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"scope": "user"}),
            )
            if getattr(user_resp, "status", 500) == 429:
                raise PublishError("publish rate limit exceeded", code="rate_limited")

            global_stub = self.env.PUBLISH_RATE_LIMITS.get(
                self.env.PUBLISH_RATE_LIMITS.idFromName(GLOBAL_DO_NAME)
            )
            global_resp = await global_stub.fetch(
                "https://rate.internal/check",
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"scope": "global"}),
            )
            if getattr(global_resp, "status", 500) == 429:
                raise PublishError("global publish rate limit exceeded", code="rate_limited")
        except PublishError:
            raise
        except Exception as e:  # noqa: BLE001
            log("rate_limit_error", error=repr(e))
            raise HttpError(503, "rate limiter unavailable")

    async def publish_template(self, request, template_uuid):
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            raise HttpError(401, str(e))

        # Validate request before charging rate limits (invalid input must not consume caps).
        body = await self._json_body(request)
        # Creator ALWAYS from session — ignore any body.creator / wallet / uri / parent_id.
        creator = session["walletAddress"]
        price_wei = body.get("price_wei") or body.get("priceWei")
        if price_wei is None:
            raise HttpError(400, "price_wei is required")
        price_wei_int = validate_publish_price(price_wei)

        sb = Supabase(self.env)
        tpl = await sb.get("templates", template_uuid)
        material = None
        if tpl and tpl.get("material_id"):
            material = await sb.get("materials", tpl["material_id"])
        user_row = await sb.get_by("users", "privy_user_id", session["userId"])
        owner_user_id = user_row["id"] if user_row else None
        assert_can_publish(template=tpl, material=material, owner_user_id=owner_user_id)

        uri = validate_publish_uri(build_publish_uri(tpl))

        # parentId is derived from DB lineage (parent_template_id → parent's onchain_token_id).
        # Never trust body.parent_id / parentId.
        parent_row = None
        if tpl.get("parent_template_id"):
            parent_row = await sb.get("templates", tpl["parent_template_id"])
        parent_id = resolve_parent_onchain_id(template=tpl, parent=parent_row)

        # Idempotent retry: prior send left a tx hash — reconcile via receipt, do not re-send.
        prior = recoverable_publish_state(tpl)
        if prior is not None and prior.get("txHash"):
            receipt = await fetch_publish_receipt(self.env, tx_hash=prior["txHash"])
            token_id = (
                str(receipt["templateId"])
                if receipt.get("templateId") is not None
                else prior.get("templateId")
            )
            patch = build_publish_success_patch(
                tx_hash=receipt.get("txHash") or prior["txHash"],
                onchain_token_id=token_id,
                price_wei=price_wei_int,
            )
            row = await sb.update("templates", template_uuid, patch)
            log(
                "template_publish_reconciled",
                template_id=template_uuid,
                tx=prior.get("txHash"),
                creator=creator,
            )
            return self._json(
                request,
                {
                    "ok": True,
                    "template": public_template_view(row, include_full_content=True),
                    "tx": receipt,
                    "reconciled": True,
                },
            )
        if prior is not None and prior.get("templateId") and not prior.get("txHash"):
            # Token known without hash (legacy) — finalize without re-broadcast.
            patch = build_publish_success_patch(
                tx_hash=None,
                onchain_token_id=prior.get("templateId"),
                price_wei=price_wei_int,
            )
            row = await sb.update("templates", template_uuid, patch)
            return self._json(
                request,
                {
                    "ok": True,
                    "template": public_template_view(row, include_full_content=True),
                    "tx": prior,
                    "reconciled": True,
                },
            )

        # Atomic claim before chain/: only the winner may send.
        await claim_template_for_publish(sb, template_uuid)

        await self._check_publish_rate_limits(session["userId"])

        try:
            sent = await send_publish_for(
                self.env,
                creator=creator,
                price_wei=price_wei_int,
                parent_id=int(parent_id),
                uri=uri,
            )
        except Exception:
            # Send never happened (or failed before returning a hash) — release claim.
            await release_publish_claim(sb, template_uuid)
            raise

        tx_hash = sent.get("txHash")
        if not isinstance(tx_hash, str) or not tx_hash.strip():
            await release_publish_claim(sb, template_uuid)
            raise PublishError("chain worker missing txHash", code="chain", status=502)

        # Persist hash ASAP — before waiting for the receipt.
        try:
            await sb.update(
                "templates",
                template_uuid,
                build_publish_broadcast_patch(tx_hash=tx_hash),
            )
        except Exception as persist_err:  # noqa: BLE001
            log(
                "publish_broadcast_persist_failed",
                template_id=template_uuid,
                tx=tx_hash,
                error=repr(persist_err),
            )
            # Do not release claim or re-send; caller must retry to reconcile by hash.
            raise PublishError(
                "failed to persist publish tx hash; retry to reconcile",
                code="persist",
                status=502,
            ) from persist_err

        try:
            receipt = await fetch_publish_receipt(self.env, tx_hash=tx_hash)
        except PublishError:
            # Hash is stored — retry will reconcile; keep claim until stale/finalize.
            raise

        token_id = str(receipt["templateId"]) if receipt.get("templateId") is not None else None
        patch = build_publish_success_patch(
            tx_hash=tx_hash,
            onchain_token_id=token_id,
            price_wei=price_wei_int,
        )
        try:
            row = await sb.update("templates", template_uuid, patch)
        except Exception as e:  # noqa: BLE001
            log("publish_finalize_failed", template_id=template_uuid, tx=tx_hash, error=repr(e))
            raise PublishError(
                "failed to persist publish; retry to reconcile",
                code="persist",
                status=502,
            ) from e

        log("template_published", template_id=template_uuid, tx=tx_hash, creator=creator)
        return self._json(
            request,
            {
                "ok": True,
                "template": public_template_view(row, include_full_content=True),
                "tx": receipt,
            },
        )

    # ---- gen Worker (service binding) --------------------------------------
    async def _gen(self, method, path, payload=None):
        kwargs = {"method": method, "headers": {"Content-Type": "application/json"}}
        if payload is not None:
            kwargs["body"] = json.dumps(payload)
        resp = await self.env.GEN.fetch(GEN_BASE + path, **kwargs)
        text = await resp.text()
        try:
            data = json.loads(text) if text else None
        except ValueError:
            data = {"error": text[:500]}
        return resp.status, data

    async def _json_body(self, request):
        text = await request.text()
        if not text:
            return {}
        try:
            body = json.loads(text)
        except ValueError:
            raise HttpError(400, "invalid JSON body")
        if not isinstance(body, dict):
            raise HttpError(400, "body must be a JSON object")
        return body

    # ---- Materials ------------------------------------------------------------
    async def upload_material(self, request):
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            raise HttpError(401, str(e))

        ctype = request.headers.get("Content-Type") or ""
        if "multipart/form-data" not in ctype:
            raise HttpError(415, "send multipart/form-data with a 'file' field (PDF)")
        # Parse with the runtime's native FormData and hand the JS File straight to R2:
        # the PDF bytes never get copied into Python memory.
        form = await request.js_object.formData()
        f = form.get("file")
        if _js_missing(f) or isinstance(f, str) or _js_missing(getattr(f, "size", None)):
            raise HttpError(400, "missing 'file' field")
        size = int(f.size)
        name = str(f.name or "document.pdf")
        if size == 0:
            raise HttpError(400, "empty file")
        if size > MAX_UPLOAD_BYTES:
            raise HttpError(413, f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
        magic = str(await f.slice(0, 5).text())
        if magic != "%PDF-":
            raise HttpError(415, "file is not a PDF")
        title_v = form.get("title")
        title = str(title_v).strip() if not _js_missing(title_v) else ""
        if not title:
            title = re.sub(r"\.pdf$", "", name, flags=re.I).replace("_", " ").replace("-", " ").strip() or "Untitled"

        sb = Supabase(self.env)
        user_row = await sb.get_by("users", "privy_user_id", session["userId"])
        if not user_row:
            # Session exists but user row missing — upsert from session.
            rows = await sb.upsert_user(
                {"privy_user_id": session["userId"], "wallet_address": session["walletAddress"]}
            )
            user_row = rows[0] if isinstance(rows, list) and rows else rows
        if not user_row or not user_row.get("id"):
            raise HttpError(500, "failed to resolve user for owner_id")

        material_id = str(uuid.uuid4())
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
        key = f"materials/{material_id}/{safe_name}"
        await self.env.PDFS.put(
            key,
            f,
            {"httpMetadata": {"contentType": "application/pdf"}, "customMetadata": {"material_id": material_id}},
        )
        row = await sb.insert(
            "materials",
            {
                "id": material_id,
                "owner_id": user_row["id"],
                "title": title[:300],
                "r2_key": key,
                "file_size_bytes": size,
                "original_filename": name[:300],
                "status": "uploaded",
            },
        )
        log("material_uploaded", material_id=material_id, size=size, owner_id=user_row["id"])
        return self._json(request, {"material": row}, 201)

    async def _material_or_404(self, sb, material_id):
        row = await sb.get("materials", material_id)
        if not row:
            raise HttpError(404, "material not found")
        return row

    async def get_material(self, request, material_id):
        sb = Supabase(self.env)
        row = await self._material_or_404(sb, material_id)
        templates = await sb.list_where(
            "templates", "material_id", material_id, select="id,title,status,created_at,error"
        )
        return self._json(request, {"material": row, "templates": templates or []})

    async def extract_material(self, request, material_id):
        sb = Supabase(self.env)
        mat = await self._material_or_404(sb, material_id)
        await sb.update("materials", material_id, {"status": "processing", "error": None})
        t0 = time.time()
        status, data = await self._gen(
            "POST",
            "/extract",
            {"material_id": material_id, "r2_key": mat["r2_key"], "filename": mat.get("original_filename")},
        )
        if status >= 400:
            err = (data or {}).get("error") or f"gen worker HTTP {status}"
            await sb.update("materials", material_id, {"status": "failed", "error": err[:1000]})
            raise HttpError(502, f"extraction failed: {err}")
        mat = await sb.update(
            "materials",
            material_id,
            {"status": "ready", "page_count": data["page_count"], "text_r2_key": data["text_r2_key"], "error": None},
        )
        log("material_extracted", material_id=material_id, pages=data["page_count"], ms=int((time.time() - t0) * 1000))
        return self._json(
            request,
            {
                "material": mat,
                "page_count": data["page_count"],
                "suggested_start_page": data["suggested_start_page"],
                "extract_ms": data.get("extract_ms"),
                "pages": data.get("pages", []),
            },
        )

    async def generate_template(self, request, material_id):
        body = await self._json_body(request)
        sb = Supabase(self.env)
        mat = await self._material_or_404(sb, material_id)
        if not mat.get("text_r2_key"):
            raise HttpError(409, "material text not extracted yet; POST /materials/{id}/extract first")
        style = body.get("learning_style") if isinstance(body.get("learning_style"), str) else None
        tpl = await sb.insert(
            "templates",
            {
                "material_id": material_id,
                "title": f"{mat['title']} (generating)"[:300],
                "status": "generating",
                "learning_style": style,
            },
        )
        payload = {
            "material_id": material_id,
            "text_r2_key": mat["text_r2_key"],
            "start_page": body.get("start_page"),
            "end_page": body.get("end_page"),
            "learning_style": style,
        }
        t0 = time.time()
        try:
            status, data = await self._gen("POST", "/generate", payload)
        except Exception as e:  # noqa: BLE001
            status, data = 502, {"error": f"gen worker unreachable: {type(e).__name__}"}
        if status >= 400:
            err = (data or {}).get("error") or f"gen worker HTTP {status}"
            await sb.update("templates", tpl["id"], {"status": "failed", "error": err[:2000]})
            raise HttpError(502, f"generation failed: {err}", template_id=tpl["id"])
        content = data["template"]
        generation = dict(data.get("generation") or {})
        generation["api_total_ms"] = int((time.time() - t0) * 1000)
        row = await sb.update(
            "templates",
            tpl["id"],
            {
                "title": (content.get("title") or mat["title"])[:300],
                "description": (content.get("summary") or "")[:2000],
                "content": content,
                "generation": generation,
                "content_r2_key": data.get("content_r2_key"),
                "content_hash": data.get("content_hash"),
                "status": "ready",
                "error": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        log("template_generated", template_id=tpl["id"], material_id=material_id, ms=generation["api_total_ms"])
        return self._json(request, {"template": row}, 201)

    async def _optional_session(self, request):
        try:
            return await require_session(self.env, request)
        except ValueError:
            return None

    async def _is_template_owner(self, sb: Supabase, template: dict, session: dict | None) -> bool:
        if not session or not template:
            return False
        material = None
        if template.get("material_id"):
            material = await sb.get("materials", template["material_id"])
        user_row = await sb.get_by("users", "privy_user_id", session["userId"])
        owner_user_id = user_row["id"] if user_row else None
        material_owner = material.get("owner_id") if material else None
        return bool(owner_user_id and material_owner and str(material_owner) == str(owner_user_id))

    async def _session_has_license(self, template: dict, session: dict | None) -> bool:
        if not session:
            return False
        raw = template.get("onchain_token_id")
        if raw is None or str(raw).strip() == "":
            return False
        try:
            onchain_id = int(str(raw).strip())
        except (TypeError, ValueError):
            return False
        marketplace = _env_str(self.env, "MARKETPLACE_ADDRESS", "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e")
        rpc_url = _env_str(self.env, "MONAD_RPC_URL", "https://testnet-rpc.monad.xyz")
        try:
            return await has_license(
                account=session["walletAddress"],
                template_id=onchain_id,
                marketplace=marketplace,
                rpc_url=rpc_url,
            )
        except Exception as e:  # noqa: BLE001
            log("has_license_error", error=repr(e), template_id=template.get("id"))
            return False

    async def get_template(self, request, template_id):
        sb = Supabase(self.env)
        row = await sb.get("templates", template_id)
        if not row:
            raise HttpError(404, "template not found")
        session = await self._optional_session(request)
        is_owner = await self._is_template_owner(sb, row, session)
        # Unpublished drafts: owner only (full content). Everyone else: 404.
        if row.get("is_published") is not True and not is_owner:
            raise HttpError(404, "template not found")
        if is_owner:
            return self._json(request, {"template": public_template_view(row, include_full_content=True)})
        # Published non-owners get preview here; full content via /content after license check.
        return self._json(request, {"template": public_template_view(row, include_full_content=False)})

    async def get_template_content(self, request, template_id):
        """Full content for creator (material owner) or wallet holding an onchain license."""
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            raise HttpError(401, str(e))
        sb = Supabase(self.env)
        row = await sb.get("templates", template_id)
        if not row:
            raise HttpError(404, "template not found")
        is_owner = await self._is_template_owner(sb, row, session)
        if is_owner:
            return self._json(
                request,
                {"template": public_template_view(row, include_full_content=True), "access": "owner"},
            )
        licensed = await self._session_has_license(row, session)
        if licensed:
            # Buyers get full study content, but only the public generation slice
            # (full generation may echo source material).
            return self._json(
                request,
                {
                    "template": public_template_view(
                        row,
                        include_full_content=True,
                        include_full_generation=False,
                    ),
                    "access": "license",
                },
            )
        raise HttpError(403, "license or ownership required", code="forbidden")

    async def fork_template(self, request, template_id):
        """Create a draft fork with parent_template_id for later publish.

        Uses the same per-user + global publish rate limits (each fork inserts a
        material + template row).
        """
        try:
            session = await require_session(self.env, request)
        except ValueError as e:
            raise HttpError(401, str(e))
        body = await self._json_body(request)
        title = body.get("title") if isinstance(body.get("title"), str) else None

        sb = Supabase(self.env)
        parent = await sb.get("templates", template_id)
        if not parent:
            raise ForkError("parent template not found", code="not_found", status=404)

        is_owner = await self._is_template_owner(sb, parent, session)
        licensed = await self._session_has_license(parent, session)
        if not is_owner and not licensed:
            raise ForkError("license or ownership required to fork", code="forbidden", status=403)

        user_row = await sb.get_by("users", "privy_user_id", session["userId"])
        if not user_row:
            user_row = await sb.upsert_user(
                {"privy_user_id": session["userId"], "wallet_address": session["walletAddress"]}
            )
            if isinstance(user_row, list):
                user_row = user_row[0] if user_row else None
        owner_user_id = user_row["id"] if user_row else None

        # Same caps as publish — forks create durable rows and feed publishFor.
        await self._check_publish_rate_limits(session["userId"])

        material_row, template_row = build_fork_rows(
            parent=parent, owner_user_id=owner_user_id, title=title
        )
        await sb.insert("materials", material_row)
        row = await sb.insert("templates", template_row)
        log("template_forked", template_id=row["id"], parent_id=template_id, user=session["userId"])
        return self._json(
            request,
            {"template": public_template_view(row, include_full_content=True)},
            201,
        )


# Re-export DO classes at module level for Wrangler durable_objects.class_name
__all__ = ["Default", "SessionDO", "PublishRateLimitDO"]
