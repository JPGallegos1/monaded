"""In-memory / Durable Object helpers for per-user publish rate limits."""

from __future__ import annotations

import json

from publish import PUBLISH_LIMIT, PUBLISH_WINDOW_SECONDS, PublishError, check_rate_limit
from workers import DurableObject, Response


class PublishRateLimitDO(DurableObject):
    """One instance per Privy userId (idFromName(userId))."""

    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env

    async def fetch(self, request):
        method = request.method.upper()
        if method != "POST":
            return Response(json.dumps({"error": "method not allowed"}), status=405)

        history = await self.ctx.storage.get("history")
        if history is None:
            history = []
        elif not isinstance(history, list):
            # JS array proxy
            try:
                history = list(history)
            except Exception:  # noqa: BLE001
                history = []
        history = [int(t) for t in history if str(t).isdigit() or isinstance(t, (int, float))]

        try:
            updated = check_rate_limit(history)
        except PublishError as e:
            return Response(json.dumps({"ok": False, "error": e.message, "code": e.code}), status=429)

        await self.ctx.storage.put("history", updated)
        return Response(
            json.dumps({"ok": True, "remaining": PUBLISH_LIMIT - len(updated), "window": PUBLISH_WINDOW_SECONDS}),
            status=200,
            headers={"Content-Type": "application/json"},
        )
