"""edtech-monad-api — pure Python Cloudflare Worker.

Routes:
  GET  /health     -> {"ok": true, "supabase": {"configured", "reachable", ...}}
  GET  /templates  -> {"templates": [...published templates...]}
  POST /users      -> upsert a user by privy_user_id
"""

import json
from urllib.parse import urlparse

from workers import Response, WorkerEntrypoint

from supabase_rest import Supabase, SupabaseError, SupabaseNotConfigured

DEV_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

USER_FIELDS = ("privy_user_id", "wallet_address", "email", "display_name", "learning_style")


def log(event, **fields):
    print(json.dumps({"event": event, **fields}))


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

    def _cors_headers(self, request):
        origin = request.headers.get("Origin")
        headers = {"Vary": "Origin"}
        if origin and origin in self._allowed_origins():
            headers.update(
                {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Max-Age": "86400",
                }
            )
        return headers

    def _json(self, request, data, status=200):
        headers = {"Content-Type": "application/json"}
        headers.update(self._cors_headers(request))
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
            if path in ("/health", "/templates", "/users"):
                return self._json(request, {"error": "method not allowed"}, 405)
            return self._json(request, {"error": "not found"}, 404)
        except SupabaseNotConfigured:
            return self._json(request, {"error": "supabase not configured"}, 503)
        except SupabaseError as e:
            log("supabase_error", status=e.status, path=path)
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
        return self._json(request, {"ok": True, "service": "edtech-monad-api", "supabase": supa})

    async def templates(self, request):
        rows = await Supabase(self.env).list_published_templates()
        return self._json(request, {"templates": rows or []})

    async def upsert_user(self, request):
        try:
            body = json.loads(await request.text())
        except Exception:  # noqa: BLE001
            return self._json(request, {"error": "invalid JSON body"}, 400)
        if not isinstance(body, dict):
            return self._json(request, {"error": "body must be a JSON object"}, 400)
        privy_id = body.get("privy_user_id")
        if not isinstance(privy_id, str) or not privy_id.strip():
            return self._json(request, {"error": "privy_user_id is required"}, 400)
        row = {k: body[k] for k in USER_FIELDS if k in body}
        row["privy_user_id"] = privy_id.strip()
        rows = await Supabase(self.env).upsert_user(row)
        user = rows[0] if isinstance(rows, list) and rows else rows
        return self._json(request, {"user": user})
