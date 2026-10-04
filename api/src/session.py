"""Opaque session cookies backed by SessionDO.

Cookie: HttpOnly, Secure, SameSite=Lax; expiry aligned with the Privy token exp.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from typing import Any, Optional

SESSION_COOKIE = "edtech_session"
SESSION_PATH = "/"


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def parse_cookie_header(header: str | None) -> dict[str, str]:
    if not header:
        return {}
    out: dict[str, str] = {}
    for part in header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def get_session_id_from_request(request) -> str | None:
    cookies = parse_cookie_header(request.headers.get("Cookie"))
    sid = cookies.get(SESSION_COOKIE)
    if not sid or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", sid):
        return None
    return sid


def session_cookie_header(session_id: str, exp: int, *, clear: bool = False) -> str:
    if clear:
        return (
            f"{SESSION_COOKIE}=; Path={SESSION_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        )
    now = int(time.time())
    max_age = max(0, int(exp) - now)
    return (
        f"{SESSION_COOKIE}={session_id}; Path={SESSION_PATH}; HttpOnly; Secure; "
        f"SameSite=Lax; Max-Age={max_age}"
    )


async def session_do_fetch(env, session_id: str, method: str, body: dict | None = None):
    stub = env.SESSIONS.get(env.SESSIONS.idFromName(session_id))
    url = f"https://session.internal/{session_id}"
    kwargs: dict[str, Any] = {"method": method, "headers": {"Content-Type": "application/json"}}
    if body is not None:
        kwargs["body"] = json.dumps(body)
    return await stub.fetch(url, **kwargs)


async def create_session(env, *, user_id: str, wallet_address: str, exp: int) -> str:
    session_id = new_session_id()
    resp = await session_do_fetch(
        env,
        session_id,
        "PUT",
        {"userId": user_id, "walletAddress": wallet_address, "exp": exp},
    )
    if getattr(resp, "status", 500) >= 400:
        raise RuntimeError("failed to persist session")
    return session_id


async def read_session(env, session_id: str) -> dict | None:
    resp = await session_do_fetch(env, session_id, "GET")
    status = getattr(resp, "status", 500)
    text = await resp.text()
    if status == 404:
        return None
    if status >= 400:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not data.get("ok"):
        return None
    exp = data.get("exp")
    if isinstance(exp, (int, float)) and int(time.time()) >= int(exp):
        await delete_session(env, session_id)
        return None
    return {
        "userId": data["userId"],
        "walletAddress": data["walletAddress"],
        "exp": exp,
        "sessionId": session_id,
    }


async def delete_session(env, session_id: str) -> None:
    await session_do_fetch(env, session_id, "DELETE")


async def require_session(env, request) -> dict:
    """Return session dict or raise ValueError with message."""
    sid = get_session_id_from_request(request)
    if not sid:
        raise ValueError("not authenticated")
    session = await read_session(env, sid)
    if not session:
        raise ValueError("session expired or not found")
    return session
