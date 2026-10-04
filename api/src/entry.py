"""edtech-monad-api — pure Python Cloudflare Worker.

Routes:
  GET  /health                     -> {"ok": true, "supabase": {...}, "gen": {...}, "privy": {...}}
  GET  /templates                  -> {"templates": [...published templates...]}
  GET  /templates/{id}             -> {"template": {...}} (any status; includes generated content)
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

The gen Worker (TypeScript, TanStack AI) is reached through the `GEN` service binding and never
touches Supabase: this Worker remains the only component that reads/writes the database.

Privy session state lives in the SessionDO Durable Object (userId + wallet only — never raw tokens).
On-chain publishFor is signed by edtech-monad-chain (CHAIN binding) with RELAYER_PRIVATE_KEY.
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
    recoverable_publish_state,
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
            if path == "/purchases/verify" and method == "POST":
                return await self.verify_purchase(request)
            if path == "/materials" and method == "POST":
                return await self.upload_material(request)
            m = re.fullmatch(rf"/templates/({UUID_RE})", path)
            if m and method == "GET":
                return await self.get_template(request, m.group(1))
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
            if path in ("/health", "/templates", "/users", "/materials", "/auth/session", "/auth/logout", "/purchases/verify"):
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
        except PublishError as e:
            status = 429 if e.code == "rate_limited" else 400
            if e.code in ("config", "chain"):
                status = 503 if e.code == "config" else 502
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
        return self._json(request, {"templates": rows or []})

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
        # Creator ALWAYS from session — ignore any body.creator / wallet / uri fields.
        creator = session["walletAddress"]
        price_wei = body.get("price_wei") or body.get("priceWei")
        parent_id = body.get("parent_id") or body.get("parentId") or 0
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

        # Idempotent retry: prior broadcast left recoverable state — finalize only.
        prior = recoverable_publish_state(tpl)
        if prior is not None:
            patch = build_publish_success_patch(
                tx_hash=prior.get("txHash"),
                onchain_token_id=prior.get("templateId"),
                price_wei=price_wei_int,
            )
            row = await sb.update("templates", template_uuid, patch)
            log(
                "template_publish_reconciled",
                template_id=template_uuid,
                tx=prior.get("txHash"),
                creator=creator,
            )
            return self._json(request, {"ok": True, "template": row, "tx": prior, "reconciled": True})

        await self._check_publish_rate_limits(session["userId"])

        result = await send_publish_for(
            self.env,
            creator=creator,
            price_wei=price_wei_int,
            parent_id=int(parent_id),
            uri=uri,
        )

        tx_hash = result.get("txHash")
        token_id = str(result["templateId"]) if result.get("templateId") is not None else None
        patch = build_publish_success_patch(
            tx_hash=tx_hash,
            onchain_token_id=token_id,
            price_wei=price_wei_int,
        )
        try:
            row = await sb.update("templates", template_uuid, patch)
        except Exception as e:  # noqa: BLE001
            # Chain already broadcast — persist at least the tx hash so retries reconcile.
            log("publish_finalize_failed", template_id=template_uuid, tx=tx_hash, error=repr(e))
            try:
                await sb.update(
                    "templates",
                    template_uuid,
                    build_publish_broadcast_patch(tx_hash=tx_hash, onchain_token_id=token_id),
                )
            except Exception as persist_err:  # noqa: BLE001
                log(
                    "publish_broadcast_persist_failed",
                    template_id=template_uuid,
                    tx=tx_hash,
                    error=repr(persist_err),
                )
            raise PublishError("failed to persist publish; retry to reconcile", code="persist") from e

        log("template_published", template_id=template_uuid, tx=tx_hash, creator=creator)
        return self._json(request, {"ok": True, "template": row, "tx": result})

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

    async def get_template(self, request, template_id):
        row = await Supabase(self.env).get("templates", template_id)
        if not row:
            raise HttpError(404, "template not found")
        return self._json(request, {"template": row})


# Re-export DO classes at module level for Wrangler durable_objects.class_name
__all__ = ["Default", "SessionDO", "PublishRateLimitDO"]
