"""edtech-monad-api — pure Python Cloudflare Worker.

Routes:
  GET  /health                     -> {"ok": true, "supabase": {...}, "gen": {...}}
  GET  /templates                  -> {"templates": [...published templates...]}
  GET  /templates/{id}             -> {"template": {...}} (any status; includes generated content)
  POST /users                      -> upsert a user by privy_user_id
  POST /materials                  -> multipart (file=<PDF>, title?) -> R2 + materials row
  GET  /materials/{id}             -> {"material": {...}, "templates": [...]}
  POST /materials/{id}/extract     -> PDF text extraction via the gen Worker (Workers AI toMarkdown)
  POST /materials/{id}/templates   -> JSON {start_page?, end_page?, learning_style?}
                                      -> AI study template via the gen Worker, saved to `templates`

The gen Worker (TypeScript, TanStack AI) is reached through the `GEN` service binding and never
touches Supabase: this Worker remains the only component that reads/writes the database.
"""

import json
import re
import time
import uuid
from datetime import datetime, timezone
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
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UUID_RE = r"[0-9a-fA-F-]{36}"
GEN_BASE = "https://edtech-monad-gen.internal"  # host is ignored by service bindings


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
            if path == "/materials" and method == "POST":
                return await self.upload_material(request)
            m = re.fullmatch(rf"/templates/({UUID_RE})", path)
            if m and method == "GET":
                return await self.get_template(request, m.group(1))
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
            if path in ("/health", "/templates", "/users", "/materials"):
                return self._json(request, {"error": "method not allowed"}, 405)
            return self._json(request, {"error": "not found"}, 404)
        except HttpError as e:
            return self._json(request, {"error": e.message, **e.extra}, e.status)
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
        gen = {"bound": False}
        try:
            status, body = await self._gen("GET", "/health")
            gen = {"bound": True, "status": status, "model": (body or {}).get("model")}
        except Exception as e:  # noqa: BLE001
            gen["error"] = type(e).__name__
        return self._json(request, {"ok": True, "service": "edtech-monad-api", "supabase": supa, "gen": gen})

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

        material_id = str(uuid.uuid4())
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
        key = f"materials/{material_id}/{safe_name}"
        await self.env.PDFS.put(
            key,
            f,
            {"httpMetadata": {"contentType": "application/pdf"}, "customMetadata": {"material_id": material_id}},
        )
        row = await Supabase(self.env).insert(
            "materials",
            {
                "id": material_id,
                "title": title[:300],
                "r2_key": key,
                "file_size_bytes": size,
                "original_filename": name[:300],
                "status": "uploaded",
            },
        )
        log("material_uploaded", material_id=material_id, size=size)
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
