"""Onchain hasLicense check via eth_call (for content gating).

Never call updateTemplate from the backend (audit M2).
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Optional

MONAD_RPC_DEFAULT = "https://testnet-rpc.monad.xyz"
MARKETPLACE_DEFAULT = "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e"

# keccak256("hasLicense(address,uint256)")[:4]
HAS_LICENSE_SELECTOR = "e3b461d9"

FetchFn = Callable[..., Awaitable[Any]]


def _pad_address(addr: str) -> str:
    a = addr.lower()
    if a.startswith("0x"):
        a = a[2:]
    return a.rjust(64, "0")


def _pad_uint(n: int) -> str:
    return hex(int(n))[2:].rjust(64, "0")


def encode_has_license_call(account: str, template_id: int) -> str:
    if not isinstance(account, str) or not account.startswith("0x") or len(account) != 42:
        raise ValueError("invalid account address")
    return "0x" + HAS_LICENSE_SELECTOR + _pad_address(account) + _pad_uint(template_id)


def decode_bool_result(hex_data: str | None) -> bool:
    if not hex_data or hex_data in ("0x", "0x0"):
        return False
    h = hex_data.lower()
    if h.startswith("0x"):
        h = h[2:]
    if not h:
        return False
    return int(h, 16) != 0


async def eth_call(
    *,
    to: str,
    data: str,
    rpc_url: str = MONAD_RPC_DEFAULT,
    fetch_fn: FetchFn | None = None,
) -> str:
    if fetch_fn is None:
        from workers import fetch as fetch_fn  # type: ignore
    resp = await fetch_fn(
        rpc_url,
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "eth_call",
                "params": [{"to": to, "data": data}, "latest"],
            }
        ),
    )
    text = await resp.text()
    body = json.loads(text)
    if not isinstance(body, dict):
        raise RuntimeError("invalid RPC response")
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    result = body.get("result")
    if not isinstance(result, str):
        raise RuntimeError("invalid eth_call result")
    return result


async def has_license(
    *,
    account: str,
    template_id: int,
    marketplace: str = MARKETPLACE_DEFAULT,
    rpc_url: str = MONAD_RPC_DEFAULT,
    fetch_fn: FetchFn | None = None,
) -> bool:
    data = encode_has_license_call(account, template_id)
    raw = await eth_call(to=marketplace, data=data, rpc_url=rpc_url, fetch_fn=fetch_fn)
    return decode_bool_result(raw)


def build_preview_content(content: Optional[dict]) -> Optional[dict]:
    """Strip full study content down to a public preview."""
    if not isinstance(content, dict):
        return None
    return {
        "title": content.get("title"),
        "summary": content.get("summary"),
        "learning_objectives": content.get("learning_objectives") or [],
        "sections": [],
        "definitions": [],
        "worked_examples": [],
        "practice_questions": [],
        "diagrams": [],
    }


def public_template_view(row: dict, *, include_full_content: bool) -> dict:
    """Return a template row safe for the caller (preview vs full content)."""
    out = dict(row)
    if include_full_content:
        return out
    out["content"] = build_preview_content(row.get("content") if isinstance(row.get("content"), dict) else None)
    # Hide generation internals that may echo source material
    if "generation" in out:
        gen = out.get("generation")
        if isinstance(gen, dict):
            out["generation"] = {
                k: gen.get(k)
                for k in ("model", "source_pages", "truncated", "generate_ms")
                if k in gen
            }
    return out
