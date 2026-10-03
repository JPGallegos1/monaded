"""Relayer-signed publishFor against TemplateMarketplace.

Creator address always comes from the verified session wallet — never the body.
Broadcast is delegated to the `CHAIN` TypeScript Worker (viem + secp256k1),
because pure-Python EC signing exceeds Workers Free ~10 ms CPU.

Secrets on chain Worker: RELAYER_PRIVATE_KEY (never commit).
"""

from __future__ import annotations

import json
import time
from typing import Any, Awaitable, Callable, Optional

CHAIN_BASE = "https://edtech-monad-chain.internal"

# Per-user rate limit (relayer has limited MON on testnet)
PUBLISH_LIMIT = 5
PUBLISH_WINDOW_SECONDS = 3600

SendTxFn = Callable[..., Awaitable[dict]]


class PublishError(Exception):
    def __init__(self, message: str, *, code: str = "publish_failed"):
        super().__init__(message)
        self.message = message
        self.code = code


def check_rate_limit(
    history: list[int],
    *,
    now: float | None = None,
    limit: int = PUBLISH_LIMIT,
    window: int = PUBLISH_WINDOW_SECONDS,
) -> list[int]:
    """Return updated history or raise PublishError if over limit."""
    ts = int(now if now is not None else time.time())
    recent = [t for t in history if isinstance(t, int) and ts - t < window]
    if len(recent) >= limit:
        raise PublishError("publish rate limit exceeded", code="rate_limited")
    recent.append(ts)
    return recent


async def send_publish_for(
    env,
    *,
    creator: str,
    price_wei: int,
    parent_id: int,
    uri: str,
    send_tx: SendTxFn | None = None,
) -> dict:
    """Ask the CHAIN Worker to sign+broadcast publishFor.

    `creator` MUST be the session wallet (caller responsibility).
    """
    if not creator or not str(creator).startswith("0x") or len(creator) != 42:
        raise PublishError("creator required", code="bad_address")
    if not isinstance(uri, str) or not uri:
        raise PublishError("uri required", code="bad_arg")
    payload = {
        "creator": creator,
        "priceWei": str(int(price_wei)),
        "parentId": str(int(parent_id)),
        "uri": uri,
    }
    if send_tx is not None:
        return await send_tx(**payload)

    try:
        chain = env.CHAIN
    except AttributeError as e:
        raise PublishError("CHAIN binding not configured", code="config") from e
    if chain is None:
        raise PublishError("CHAIN binding not configured", code="config")

    resp = await chain.fetch(
        CHAIN_BASE + "/publishFor",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps(payload),
    )
    text = await resp.text()
    try:
        data = json.loads(text) if text else {}
    except json.JSONDecodeError:
        data = {"error": text[:500]}
    status = getattr(resp, "status", 500)
    if status >= 400:
        raise PublishError((data or {}).get("error") or f"chain worker HTTP {status}", code="chain")
    tx_hash = (data or {}).get("txHash")
    if not isinstance(tx_hash, str):
        raise PublishError("chain worker missing txHash", code="chain")
    return {"txHash": tx_hash, "relayer": (data or {}).get("relayer")}
