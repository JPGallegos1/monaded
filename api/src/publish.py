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
# Global cap across all users (same DO class, fixed name "__global__")
GLOBAL_PUBLISH_LIMIT = 30
GLOBAL_PUBLISH_WINDOW_SECONDS = 3600

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


def recoverable_publish_state(template: dict | None) -> dict | None:
    """Return prior broadcast state that must not be re-sent on retry.

    If publishFor already succeeded but `is_published` was never set (e.g. the
    subsequent Supabase update failed), retries must finalize from this state
    instead of broadcasting a second on-chain publish.
    """
    if not template or template.get("is_published") is True:
        return None
    tx_hash = template.get("publish_tx_hash")
    token_id = template.get("onchain_token_id")
    has_tx = isinstance(tx_hash, str) and bool(tx_hash.strip())
    has_token = token_id is not None and str(token_id).strip() != ""
    if not has_tx and not has_token:
        return None
    out: dict[str, Any] = {}
    if has_tx:
        out["txHash"] = str(tx_hash).strip()
    if has_token:
        out["templateId"] = str(token_id).strip()
    return out


def build_publish_success_patch(
    *,
    tx_hash: str | None,
    onchain_token_id: str | None,
    price_wei: int | None = None,
) -> dict:
    """DB patch that marks a template published and records recoverable chain state."""
    patch: dict[str, Any] = {
        "is_published": True,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if isinstance(tx_hash, str) and tx_hash.strip():
        patch["publish_tx_hash"] = tx_hash.strip()
    if onchain_token_id is not None and str(onchain_token_id).strip() != "":
        patch["onchain_token_id"] = str(onchain_token_id).strip()
    if price_wei is not None:
        try:
            patch["price_mon"] = int(price_wei) / 10**18
        except Exception:  # noqa: BLE001
            pass
    return patch


def build_publish_broadcast_patch(*, tx_hash: str, onchain_token_id: str | None) -> dict:
    """Minimal patch persisted immediately after a successful chain broadcast.

    Written before (or as part of) setting is_published so a later failure still
    leaves enough state for an idempotent retry.
    """
    if not isinstance(tx_hash, str) or not tx_hash.strip():
        raise PublishError("txHash required to persist publish", code="chain")
    patch: dict[str, Any] = {
        "publish_tx_hash": tx_hash.strip(),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if onchain_token_id is not None and str(onchain_token_id).strip() != "":
        patch["onchain_token_id"] = str(onchain_token_id).strip()
    return patch


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
        # Log detail server-side; never forward raw chain/viem errors to clients.
        print(json.dumps({"event": "chain_publish_error", "status": status, "detail": (data or {}).get("error")}))
        raise PublishError("publish transaction failed", code="chain")
    tx_hash = (data or {}).get("txHash")
    if not isinstance(tx_hash, str):
        raise PublishError("chain worker missing txHash", code="chain")
    out = {"txHash": tx_hash, "relayer": (data or {}).get("relayer")}
    if (data or {}).get("templateId") is not None:
        out["templateId"] = str(data["templateId"])
    return out
