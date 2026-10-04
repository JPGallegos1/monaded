"""Derive wallet address from Privy (identity token or server API).

The wallet address must NEVER come from the client request body.
Prefer a verified identity token; fall back to Privy's users API with App Secret.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Awaitable, Callable, Optional

from privy_jwt import (
    JwtError,
    JwksCache,
    extract_wallet_from_identity_claims,
    verify_privy_jwt,
)

FetchFn = Callable[..., Awaitable[Any]]


class PrivyUserError(Exception):
    def __init__(self, message: str, *, code: str = "privy_user"):
        super().__init__(message)
        self.message = message
        self.code = code


def _basic_auth(app_id: str, app_secret: str) -> str:
    token = base64.b64encode(f"{app_id}:{app_secret}".encode()).decode("ascii")
    return f"Basic {token}"


async def fetch_user_by_did(
    did: str,
    app_id: str,
    app_secret: str,
    *,
    fetch_fn: FetchFn | None = None,
) -> dict:
    if not app_secret:
        raise PrivyUserError("PRIVY_APP_SECRET not configured", code="config")
    if fetch_fn is None:
        from workers import fetch as fetch_fn  # type: ignore
    do_fetch = fetch_fn
    url = f"https://auth.privy.io/api/v1/users/{did}"
    resp = await do_fetch(
        url,
        method="GET",
        headers={
            "Authorization": _basic_auth(app_id, app_secret),
            "privy-app-id": app_id,
            "Accept": "application/json",
        },
    )
    status = getattr(resp, "status", None)
    text = await resp.text()
    if status is not None and status >= 400:
        raise PrivyUserError(f"Privy user fetch failed ({status})", code="privy_api")
    try:
        body = json.loads(text) if text else {}
    except json.JSONDecodeError as e:
        raise PrivyUserError("invalid Privy user JSON", code="privy_api") from e
    if not isinstance(body, dict):
        raise PrivyUserError("invalid Privy user payload", code="privy_api")
    return body


def wallet_from_privy_user(user: dict) -> str | None:
    linked = user.get("linked_accounts") or user.get("linkedAccounts") or []
    if not isinstance(linked, list):
        return None
    # Prefer embedded ethereum wallet.
    embedded = None
    external = None
    for acct in linked:
        if not isinstance(acct, dict):
            continue
        typ = (acct.get("type") or "").lower()
        addr = acct.get("address")
        if not isinstance(addr, str) or not addr.startswith("0x"):
            continue
        chain = (acct.get("chain_type") or acct.get("chainType") or "ethereum").lower()
        if chain not in ("ethereum", "evm"):
            continue
        client = (acct.get("wallet_client") or acct.get("walletClientType") or acct.get("wallet_client_type") or "").lower()
        if typ in ("wallet", "smart_wallet"):
            if client == "privy":
                embedded = addr
            elif external is None:
                external = addr
    return embedded or external


async def resolve_wallet_address(
    *,
    user_id: str,
    app_id: str,
    app_secret: str,
    identity_token: str | None = None,
    jwks_cache: JwksCache | None = None,
    fetch_fn: FetchFn | None = None,
    verify_sig=None,
    now: float | None = None,
) -> str:
    """Return checksummed-ish lowercased 0x wallet. Raises if none found."""
    if identity_token:
        try:
            claims = await verify_privy_jwt(
                identity_token,
                app_id,
                cache=jwks_cache,
                fetch_fn=fetch_fn,
                verify_sig=verify_sig,
                now=now,
            )
            if claims["sub"] != user_id:
                raise PrivyUserError("identity token sub mismatch", code="sub_mismatch")
            addr = extract_wallet_from_identity_claims(claims)
            if addr:
                return addr
        except JwtError as e:
            raise PrivyUserError(e.message, code=e.code) from e

    user = await fetch_user_by_did(user_id, app_id, app_secret, fetch_fn=fetch_fn)
    addr = wallet_from_privy_user(user)
    if not addr:
        raise PrivyUserError("no ethereum wallet linked to Privy user", code="no_wallet")
    return addr
