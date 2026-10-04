"""Relayer-signed publishFor against TemplateMarketplace.

Creator address always comes from the verified session wallet — never the body.
Broadcast is delegated to the `CHAIN` TypeScript Worker (viem + secp256k1),
because pure-Python EC signing exceeds Workers Free ~10 ms CPU.

Publish flow (API):
  1. Atomically claim the template (`publish_claimed_at`) so only one request
     may call chain/ for a given row.
  2. Send the tx (`/publishFor/send`), persist `publish_tx_hash` immediately.
  3. Wait for the receipt (`/publishFor/receipt`) and finalize `is_published`.
  Retries with a stored hash reconcile via receipt — they must not re-send.

Secrets on chain Worker: RELAYER_PRIVATE_KEY (never commit).
"""

from __future__ import annotations

import json
import time
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

CHAIN_BASE = "https://edtech-monad-chain.internal"

# Per-user rate limit (relayer has limited MON on testnet)
PUBLISH_LIMIT = 5
PUBLISH_WINDOW_SECONDS = 3600
# Global cap across all users (same DO class, fixed name "__global__")
GLOBAL_PUBLISH_LIMIT = 30
GLOBAL_PUBLISH_WINDOW_SECONDS = 3600

# How long a publish claim is exclusive before another request may reclaim it.
PUBLISH_CLAIM_TTL_SECONDS = 180

SendTxFn = Callable[..., Awaitable[dict]]
FetchReceiptFn = Callable[..., Awaitable[dict]]


class PublishError(Exception):
    def __init__(self, message: str, *, code: str = "publish_failed", status: int | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


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
        raise PublishError("publish rate limit exceeded", code="rate_limited", status=429)
    recent.append(ts)
    return recent


def resolve_rate_limit_params(body: dict | None) -> tuple[str, int, int]:
    """Scope may come from the trusted API; limit/window are always hardcoded.

    Request-body `limit` / `window` are intentionally ignored.
    """
    b = body if isinstance(body, dict) else {}
    scope = b.get("scope") or "user"
    if scope == "global":
        return "global", GLOBAL_PUBLISH_LIMIT, GLOBAL_PUBLISH_WINDOW_SECONDS
    return "user", PUBLISH_LIMIT, PUBLISH_WINDOW_SECONDS


def _utcnow_iso(now: float | None = None) -> str:
    ts = now if now is not None else time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def claim_stale_before_iso(*, now: float | None = None, ttl_seconds: int = PUBLISH_CLAIM_TTL_SECONDS) -> str:
    """ISO timestamp: claims older than this may be reclaimed."""
    ts = (now if now is not None else time.time()) - int(ttl_seconds)
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def build_publish_claim_patch(*, now: float | None = None) -> dict:
    """Patch that marks the row as currently publishing."""
    return {
        "publish_claimed_at": _utcnow_iso(now),
        "updated_at": _utcnow_iso(now),
    }


def build_publish_claim_release_patch(*, now: float | None = None) -> dict:
    """Clear a publish claim (safe release / expire after failure before send)."""
    return {
        "publish_claimed_at": None,
        "updated_at": _utcnow_iso(now),
    }


def publish_claim_filter(template_id: str, *, now: float | None = None, ttl_seconds: int = PUBLISH_CLAIM_TTL_SECONDS) -> str:
    """PostgREST filter: unpublished and not currently claimed (or claim is stale)."""
    stale = claim_stale_before_iso(now=now, ttl_seconds=ttl_seconds)
    tid = quote(str(template_id), safe="")
    # or=(publish_claimed_at.is.null,publish_claimed_at.lt.<stale>)
    return (
        f"id=eq.{tid}"
        f"&is_published=eq.false"
        f"&or=(publish_claimed_at.is.null,publish_claimed_at.lt.{stale})"
    )


def _parse_iso_ts(raw: str) -> float | None:
    """Parse an ISO-8601 UTC timestamp (…Z or +00:00) to epoch seconds."""
    import calendar
    from datetime import datetime

    s = raw.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            return float(calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")))
        # Postgres may return "+00:00" offsets.
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.timestamp()
    except Exception:  # noqa: BLE001
        return None


def is_claim_active(
    template: dict | None,
    *,
    now: float | None = None,
    ttl_seconds: int = PUBLISH_CLAIM_TTL_SECONDS,
) -> bool:
    """True when another request holds a non-stale publish claim."""
    if not template:
        return False
    raw = template.get("publish_claimed_at")
    if not isinstance(raw, str) or not raw.strip():
        return False
    claimed_ts = _parse_iso_ts(raw)
    if claimed_ts is None:
        return True  # fail closed: unknown format → treat as active
    now_ts = now if now is not None else time.time()
    return (now_ts - claimed_ts) < int(ttl_seconds)


def recoverable_publish_state(template: dict | None) -> dict | None:
    """Return prior broadcast state that must not be re-sent on retry.

    If publishFor was sent (`publish_tx_hash` set) but `is_published` was never
    finalized (e.g. receipt wait failed), retries must reconcile from this hash
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
    now: float | None = None,
) -> dict:
    """DB patch that marks a template published and clears the publish claim."""
    patch: dict[str, Any] = {
        "is_published": True,
        "publish_claimed_at": None,
        "updated_at": _utcnow_iso(now),
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


def build_publish_broadcast_patch(*, tx_hash: str, onchain_token_id: str | None = None, now: float | None = None) -> dict:
    """Minimal patch persisted immediately after the tx is sent (before receipt).

    Written as soon as chain returns a hash so a later receipt failure still
    leaves enough state for an idempotent reconcile retry.
    """
    if not isinstance(tx_hash, str) or not tx_hash.strip():
        raise PublishError("txHash required to persist publish", code="chain", status=502)
    patch: dict[str, Any] = {
        "publish_tx_hash": tx_hash.strip(),
        "updated_at": _utcnow_iso(now),
    }
    if onchain_token_id is not None and str(onchain_token_id).strip() != "":
        patch["onchain_token_id"] = str(onchain_token_id).strip()
    return patch


def resolve_parent_onchain_id(*, template: dict, parent: dict | None) -> int:
    """Derive on-chain parentId from DB lineage — never from the request body.

    - No `parent_template_id` → 0 (root publish).
    - Parent missing → reject.
    - Parent not yet published on-chain → reject (cannot invent lineages).
    """
    parent_uuid = template.get("parent_template_id")
    if parent_uuid is None or str(parent_uuid).strip() == "":
        return 0
    if not parent:
        raise PublishError("parent template not found", code="bad_parent", status=400)
    token = parent.get("onchain_token_id")
    if token is None or str(token).strip() == "":
        raise PublishError("parent template is not published on-chain", code="bad_parent", status=400)
    try:
        value = int(str(token).strip())
    except (TypeError, ValueError) as e:
        raise PublishError("parent onchain_token_id invalid", code="bad_parent", status=400) from e
    if value < 0:
        raise PublishError("parent onchain_token_id invalid", code="bad_parent", status=400)
    return value


async def claim_template_for_publish(sb, template_id: str, *, now: float | None = None) -> dict:
    """Atomically claim a template for publishing. Raises if another claim wins."""
    patch = build_publish_claim_patch(now=now)
    filt = publish_claim_filter(template_id, now=now)
    row = await sb.update_where("templates", filt, patch)
    if row is None:
        raise PublishError(
            "publish already in progress for this template",
            code="publishing_in_progress",
            status=409,
        )
    return row


async def release_publish_claim(sb, template_id: str, *, now: float | None = None) -> None:
    """Best-effort release of a publish claim (only if still unpublished)."""
    try:
        await sb.update_where(
            "templates",
            f"id=eq.{quote(str(template_id))}&is_published=eq.false",
            build_publish_claim_release_patch(now=now),
        )
    except Exception:  # noqa: BLE001
        pass


async def send_publish_for(
    env,
    *,
    creator: str,
    price_wei: int,
    parent_id: int,
    uri: str,
    send_tx: SendTxFn | None = None,
) -> dict:
    """Ask the CHAIN Worker to sign+broadcast publishFor (send only — no receipt wait).

    `creator` MUST be the session wallet (caller responsibility).
    Returns at least `{txHash, relayer?}`. Does not wait for the receipt.
    """
    if not creator or not str(creator).startswith("0x") or len(creator) != 42:
        raise PublishError("creator required", code="bad_address", status=400)
    if not isinstance(uri, str) or not uri:
        raise PublishError("uri required", code="bad_arg", status=400)
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
        raise PublishError("CHAIN binding not configured", code="config", status=503) from e
    if chain is None:
        raise PublishError("CHAIN binding not configured", code="config", status=503)

    resp = await chain.fetch(
        CHAIN_BASE + "/publishFor/send",
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
        print(json.dumps({"event": "chain_publish_send_error", "status": status, "detail": (data or {}).get("error")}))
        raise PublishError("publish transaction failed", code="chain", status=502)
    tx_hash = (data or {}).get("txHash")
    if not isinstance(tx_hash, str) or not tx_hash.strip():
        raise PublishError("chain worker missing txHash", code="chain", status=502)
    out = {"txHash": tx_hash.strip(), "relayer": (data or {}).get("relayer")}
    return out


async def fetch_publish_receipt(
    env,
    *,
    tx_hash: str,
    fetch_receipt: FetchReceiptFn | None = None,
) -> dict:
    """Ask chain/ for the receipt + TemplatePublished event of a previously sent tx.

    Retries use this instead of calling send again.
    """
    if not isinstance(tx_hash, str) or not tx_hash.strip():
        raise PublishError("txHash required", code="chain", status=502)
    payload = {"txHash": tx_hash.strip()}
    if fetch_receipt is not None:
        return await fetch_receipt(**payload)

    try:
        chain = env.CHAIN
    except AttributeError as e:
        raise PublishError("CHAIN binding not configured", code="config", status=503) from e
    if chain is None:
        raise PublishError("CHAIN binding not configured", code="config", status=503)

    resp = await chain.fetch(
        CHAIN_BASE + "/publishFor/receipt",
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
        print(
            json.dumps(
                {
                    "event": "chain_publish_receipt_error",
                    "status": status,
                    "tx": tx_hash.strip(),
                    "detail": (data or {}).get("error"),
                }
            )
        )
        code = "chain"
        # 404-ish / not mined yet
        if status == 404 or (isinstance(data, dict) and data.get("code") == "pending"):
            raise PublishError("publish transaction pending", code="pending", status=409)
        if status == 502 and isinstance(data, dict) and data.get("code") == "reverted":
            raise PublishError("publish transaction reverted", code="reverted", status=502)
        raise PublishError("publish receipt failed", code=code, status=502)

    out_hash = (data or {}).get("txHash") or tx_hash.strip()
    out: dict[str, Any] = {"txHash": out_hash, "relayer": (data or {}).get("relayer")}
    if (data or {}).get("templateId") is not None:
        out["templateId"] = str(data["templateId"])
    return out
