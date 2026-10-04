"""Minimal Supabase PostgREST client built on the Workers fetch API.

Only the API Worker talks to Supabase. The service role key is read from Worker
secrets and is never returned to clients or logged.
"""

import json
from urllib.parse import quote

from workers import fetch


class SupabaseNotConfigured(Exception):
    pass


class SupabaseError(Exception):
    def __init__(self, status, detail):
        super().__init__(f"Supabase error {status}")
        self.status = status
        self.detail = detail


def _env(env, name):
    try:
        value = getattr(env, name)
    except AttributeError:
        return None
    if value is None:
        return None
    value = str(value).strip()
    return value or None


class Supabase:
    def __init__(self, env):
        self.url = (_env(env, "SUPABASE_URL") or "").rstrip("/") or None
        self.key = _env(env, "SUPABASE_SERVICE_ROLE_KEY")

    @property
    def configured(self):
        return bool(self.url and self.key)

    def _headers(self, extra=None):
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers

    async def ping(self):
        """Return (reachable, http_status). Hits the PostgREST root."""
        if not self.configured:
            raise SupabaseNotConfigured()
        resp = await fetch(f"{self.url}/rest/v1/", method="GET", headers=self._headers())
        return 200 <= resp.status < 300, resp.status

    async def request(self, method, path, body=None, prefer=None):
        if not self.configured:
            raise SupabaseNotConfigured()
        extra = {}
        if body is not None:
            extra["Content-Type"] = "application/json"
        if prefer:
            extra["Prefer"] = prefer
        kwargs = {"method": method, "headers": self._headers(extra)}
        if body is not None:
            kwargs["body"] = json.dumps(body)
        resp = await fetch(f"{self.url}/rest/v1/{path}", **kwargs)
        text = await resp.text()
        data = json.loads(text) if text else None
        if resp.status >= 400:
            raise SupabaseError(resp.status, data)
        return data

    async def list_published_templates(self, limit=50):
        q = f"templates?select=*&is_published=eq.true&limit={int(limit)}"
        return await self.request("GET", q)

    async def upsert_user(self, row):
        return await self.request(
            "POST",
            "users?on_conflict=" + quote("privy_user_id"),
            body=[row],
            prefer="resolution=merge-duplicates,return=representation",
        )

    # ---- generic row helpers (service role; RLS bypassed) -------------------
    async def insert(self, table, row):
        rows = await self.request("POST", table, body=[row], prefer="return=representation")
        return rows[0] if rows else None

    async def update(self, table, row_id, patch):
        rows = await self.request(
            "PATCH", f"{table}?id=eq.{quote(str(row_id))}", body=patch, prefer="return=representation"
        )
        return rows[0] if rows else None

    async def update_where(self, table, query, patch):
        """Conditional PATCH. `query` is the PostgREST filter string after `table?`.

        Returns the first matching row, or None when zero rows matched (claim lost).
        """
        if not isinstance(query, str) or not query.strip():
            raise ValueError("update_where requires a non-empty query")
        q = query.strip().lstrip("?")
        rows = await self.request(
            "PATCH", f"{table}?{q}", body=patch, prefer="return=representation"
        )
        if not rows:
            return None
        return rows[0] if isinstance(rows, list) else rows

    async def get(self, table, row_id, select="*"):
        rows = await self.request("GET", f"{table}?select={select}&id=eq.{quote(str(row_id))}&limit=1")
        return rows[0] if rows else None

    async def list_where(self, table, column, value, select="*", order="created_at.desc", limit=50):
        q = f"{table}?select={select}&{column}=eq.{quote(str(value))}&order={order}&limit={int(limit)}"
        return await self.request("GET", q)

    async def get_by(self, table, column, value, select="*"):
        rows = await self.request(
            "GET", f"{table}?select={select}&{column}=eq.{quote(str(value))}&limit=1"
        )
        return rows[0] if rows else None

    async def insert_purchase(self, row):
        """Insert a verified purchase. Unique tx_hash → 409-style SupabaseError on replay."""
        return await self.insert("purchases", row)
