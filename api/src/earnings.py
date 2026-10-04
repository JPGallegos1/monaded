"""Creator dashboard earnings — session wallet only, native MON (address(0)).

Reads indexer tables/views via the api Supabase client (service role). Never
accepts a client-supplied wallet; the caller must pass the session wallet.
"""

from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import quote

NATIVE_TOKEN = "0x0000000000000000000000000000000000000000"
RECENT_LIMIT = 5
# Fetch a few more from each table so the merged top-N is correct.
_PER_KIND_FETCH = RECENT_LIMIT


class _Supabase(Protocol):
    async def request(self, method, path, body=None, prefer=None): ...


def norm_wallet(wallet: str) -> str:
    if not isinstance(wallet, str) or not wallet.startswith("0x") or len(wallet) != 42:
        raise ValueError("invalid wallet")
    return wallet.lower()


def wei_str(value: Any) -> str:
    """Normalize a numeric/wei value to a non-negative decimal string."""
    if value is None:
        return "0"
    if isinstance(value, bool):
        return "0"
    if isinstance(value, int):
        return str(max(0, value))
    s = str(value).strip()
    if not s:
        return "0"
    # PostgREST may return numerics as strings; strip fractional dust if any.
    if "e" in s.lower():
        return str(int(float(s)))
    if "." in s:
        s = s.split(".", 1)[0]
    try:
        n = int(s)
    except ValueError:
        return "0"
    return str(max(0, n))


def _zero_totals() -> dict[str, str]:
    return {
        "earned": "0",
        "sales": "0",
        "royalties": "0",
        "pending_withdrawal": "0",
        "withdrawn": "0",
    }


def totals_from_balance_row(row: dict | None) -> dict[str, str]:
    if not row:
        return _zero_totals()
    sales = wei_str(row.get("earned_sales"))
    royalties = wei_str(row.get("earned_royalties"))
    # Prefer view's earned when present; else sales + royalties.
    earned_raw = row.get("earned")
    if earned_raw is None:
        earned = str(int(sales) + int(royalties))
    else:
        earned = wei_str(earned_raw)
    return {
        "earned": earned,
        "sales": sales,
        "royalties": royalties,
        "pending_withdrawal": wei_str(row.get("pending")),
        "withdrawn": wei_str(row.get("withdrawn")),
    }


def _block_time_iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    s = str(value).strip()
    return s or None


def sale_to_recent(row: dict, *, template_id_by_onchain: dict[str, str | None]) -> dict:
    oid = str(row.get("onchain_template_id") or "")
    return {
        "kind": "sale",
        "onchain_template_id": oid,
        "template_id": template_id_by_onchain.get(oid),
        "amount": wei_str(row.get("creator_amount")),
        "level": None,
        "counterparty": (str(row.get("buyer") or "").lower() or None),
        "tx_hash": str(row.get("tx_hash") or "").lower(),
        "block_time": _block_time_iso(row.get("block_time")),
        # Internal sort keys (stripped before response)
        "_log_index": int(row.get("log_index") or 0),
        "_block_number": int(row.get("block_number") or 0),
    }


def royalty_to_recent(row: dict, *, template_id_by_onchain: dict[str, str | None]) -> dict:
    oid = str(row.get("onchain_template_id") or "")
    level_raw = row.get("level")
    try:
        level = int(level_raw) if level_raw is not None else None
    except (TypeError, ValueError):
        level = None
    return {
        "kind": "royalty",
        "onchain_template_id": oid,
        "template_id": template_id_by_onchain.get(oid),
        "amount": wei_str(row.get("amount")),
        "level": level,
        "counterparty": None,
        "tx_hash": str(row.get("tx_hash") or "").lower(),
        "block_time": _block_time_iso(row.get("block_time")),
        "_log_index": int(row.get("log_index") or 0),
        "_block_number": int(row.get("block_number") or 0),
    }


def merge_recent(
    sales_rows: list[dict],
    royalty_rows: list[dict],
    *,
    template_id_by_onchain: dict[str, str | None],
    limit: int = RECENT_LIMIT,
) -> list[dict]:
    items = [sale_to_recent(r, template_id_by_onchain=template_id_by_onchain) for r in sales_rows]
    items.extend(
        royalty_to_recent(r, template_id_by_onchain=template_id_by_onchain) for r in royalty_rows
    )
    # block_time desc, then log_index desc (null block_time sorts last)
    items.sort(
        key=lambda x: (
            x["block_time"] is not None,
            x["block_time"] or "",
            x["_block_number"],
            x["_log_index"],
        ),
        reverse=True,
    )
    out = []
    for item in items[:limit]:
        out.append({k: v for k, v in item.items() if not k.startswith("_")})
    return out


def build_earnings_payload(
    *,
    wallet: str,
    balance_row: dict | None,
    sales_rows: list[dict],
    royalty_rows: list[dict],
    template_id_by_onchain: dict[str, str | None] | None = None,
) -> dict:
    """Pure builder: always scoped to `wallet` + native MON."""
    w = norm_wallet(wallet)
    mapping = template_id_by_onchain or {}
    return {
        "wallet": w,
        "token": NATIVE_TOKEN,
        "totals": totals_from_balance_row(balance_row),
        "recent": merge_recent(
            sales_rows or [],
            royalty_rows or [],
            template_id_by_onchain=mapping,
        ),
    }


async def _load_template_ids(sb: _Supabase, onchain_ids: set[str]) -> dict[str, str | None]:
    mapping: dict[str, str | None] = {oid: None for oid in onchain_ids}
    if not onchain_ids:
        return mapping
    # PostgREST `in` list
    ids = ",".join(quote(oid, safe="") for oid in sorted(onchain_ids))
    rows = await sb.request(
        "GET",
        f"onchain_templates?select=onchain_id,template_id&onchain_id=in.({ids})",
    )
    for row in rows or []:
        oid = str(row.get("onchain_id") or "")
        tid = row.get("template_id")
        if oid:
            mapping[oid] = str(tid) if tid else None
    # Fallback: templates.onchain_token_id for rows not linked yet on onchain_templates
    missing = [oid for oid, tid in mapping.items() if tid is None]
    if missing:
        ids2 = ",".join(quote(oid, safe="") for oid in sorted(missing))
        trows = await sb.request(
            "GET",
            f"templates?select=id,onchain_token_id&onchain_token_id=in.({ids2})",
        )
        for row in trows or []:
            oid = str(row.get("onchain_token_id") or "")
            if oid and row.get("id"):
                mapping[oid] = str(row["id"])
    return mapping


async def get_earnings_for_wallet(sb: _Supabase, wallet: str) -> dict:
    """Load creator_balances + recent sales/royalties for the session wallet (native MON)."""
    w = norm_wallet(wallet)
    token = NATIVE_TOKEN

    bal_rows = await sb.request(
        "GET",
        (
            f"creator_balances?select=wallet,token,earned,earned_sales,earned_royalties,"
            f"deferred,withdrawn,pending"
            f"&wallet=eq.{quote(w)}&token=eq.{quote(token)}&limit=1"
        ),
    )
    balance_row = bal_rows[0] if isinstance(bal_rows, list) and bal_rows else None

    sales_rows = await sb.request(
        "GET",
        (
            f"sales?select=onchain_template_id,creator_amount,buyer,tx_hash,block_time,"
            f"block_number,log_index"
            f"&creator=eq.{quote(w)}&token=eq.{quote(token)}"
            f"&order=block_time.desc.nullslast,log_index.desc&limit={_PER_KIND_FETCH}"
        ),
    )
    royalty_rows = await sb.request(
        "GET",
        (
            f"royalty_payments?select=onchain_template_id,amount,level,tx_hash,block_time,"
            f"block_number,log_index"
            f"&recipient=eq.{quote(w)}&token=eq.{quote(token)}"
            f"&order=block_time.desc.nullslast,log_index.desc&limit={_PER_KIND_FETCH}"
        ),
    )
    sales_rows = sales_rows if isinstance(sales_rows, list) else []
    royalty_rows = royalty_rows if isinstance(royalty_rows, list) else []

    onchain_ids: set[str] = set()
    for r in sales_rows:
        if r.get("onchain_template_id") is not None:
            onchain_ids.add(str(r["onchain_template_id"]))
    for r in royalty_rows:
        if r.get("onchain_template_id") is not None:
            onchain_ids.add(str(r["onchain_template_id"]))

    mapping = await _load_template_ids(sb, onchain_ids)
    return build_earnings_payload(
        wallet=w,
        balance_row=balance_row,
        sales_rows=sales_rows,
        royalty_rows=royalty_rows,
        template_id_by_onchain=mapping,
    )
