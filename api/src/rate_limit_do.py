"""Publish rate-limit Durable Object — per-user or global (fixed name).

Instances:
  - idFromName(privy DID) → per-user limit
  - idFromName("__global__") → global cap across all users
"""

from __future__ import annotations

import json

from publish import (
    GLOBAL_PUBLISH_LIMIT,
    GLOBAL_PUBLISH_WINDOW_SECONDS,
    PUBLISH_LIMIT,
    PUBLISH_WINDOW_SECONDS,
    PublishError,
    check_rate_limit,
)
from workers import DurableObject, Response

GLOBAL_DO_NAME = "__global__"


class PublishRateLimitDO(DurableObject):
    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env

    async def fetch(self, request):
        method = request.method.upper()
        if method != "POST":
            return Response(json.dumps({"error": "method not allowed"}), status=405)

        try:
            body = json.loads(await request.text() or "{}")
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            body = {}

        # API chooses limits; DO never trusts external callers (not publicly reachable).
        scope = body.get("scope") or "user"
        if scope == "global":
            limit = int(body.get("limit") or GLOBAL_PUBLISH_LIMIT)
            window = int(body.get("window") or GLOBAL_PUBLISH_WINDOW_SECONDS)
        else:
            limit = int(body.get("limit") or PUBLISH_LIMIT)
            window = int(body.get("window") or PUBLISH_WINDOW_SECONDS)

        history = await self.ctx.storage.get("history")
        if history is None:
            history = []
        elif not isinstance(history, list):
            try:
                history = list(history)
            except Exception:  # noqa: BLE001
                history = []
        history = [int(t) for t in history if str(t).isdigit() or isinstance(t, (int, float))]

        try:
            updated = check_rate_limit(history, limit=limit, window=window)
        except PublishError as e:
            return Response(
                json.dumps({"ok": False, "error": e.message, "code": e.code, "scope": scope}),
                status=429,
                headers={"Content-Type": "application/json"},
            )

        await self.ctx.storage.put("history", updated)
        return Response(
            json.dumps(
                {
                    "ok": True,
                    "remaining": max(0, limit - len(updated)),
                    "window": window,
                    "scope": scope,
                }
            ),
            status=200,
            headers={"Content-Type": "application/json"},
        )
