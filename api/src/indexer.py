"""Creator Economy indexer ingest — internal-only upserts into Supabase.

Called by edtech-monad-indexer (service binding) or the local backfill script.
All addresses are stored lowercase; amounts are wei strings → numeric(78,0).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

NATIVE = "0x0000000000000000000000000000000000000000"


class _Supabase(Protocol):
    async def upsert(self, table, rows, *, on_conflict: str, ignore_duplicates: bool = False): ...
    async def request(self, method, path, body=None, prefer=None): ...
    async def get_by(self, table, column, value, select="*"): ...
    async def rpc(self, fn_name: str, payload=None): ...
DEFAULT_CHAIN_ID = 10143
DEFAULT_CONTRACT = "0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e"

# Events that get typed table rows (plus always chain_events).
TYPED_EVENTS = frozenset(
    {
        "TemplatePublished",
        "TemplateUpdated",
        "Purchased",
        "RoyaltyPaid",
        "PaymentDeferred",
        "Withdrawn",
        "TransferSingle",
        "TransferBatch",
    }
)


class IndexerError(Exception):
    def __init__(self, message: str, *, code: str = "indexer", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def norm_addr(addr: Any) -> str:
    if addr is None:
        return NATIVE
    s = str(addr).strip().lower()
    if not s.startswith("0x"):
        s = "0x" + s
    if len(s) != 42:
        raise IndexerError(f"invalid address: {addr}", code="bad_address")
    return s


def norm_tx(tx: Any) -> str:
    s = str(tx or "").strip().lower()
    if not s.startswith("0x") or len(s) != 66:
        raise IndexerError(f"invalid tx hash: {tx}", code="bad_tx")
    return s


def norm_uint_str(value: Any) -> str:
    """Decimal string for numeric(78,0) / onchain ids."""
    if value is None:
        raise IndexerError("missing uint", code="bad_uint")
    if isinstance(value, bool):
        raise IndexerError("invalid uint", code="bad_uint")
    if isinstance(value, int):
        if value < 0:
            raise IndexerError("negative uint", code="bad_uint")
        return str(value)
    s = str(value).strip()
    if s.startswith("0x"):
        return str(int(s, 16))
    # already decimal
    int(s)  # validate
    if s.startswith("-"):
        raise IndexerError("negative uint", code="bad_uint")
    return str(int(s))


def norm_contract(addr: Any) -> str:
    return norm_addr(addr)


def parse_block_time(value: Any) -> str | None:
    """Accept unix seconds (int/str) or ISO string → ISO timestamptz."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()
    s = str(value).strip()
    if s.isdigit():
        return datetime.fromtimestamp(int(s), tz=timezone.utc).isoformat()
    # assume ISO
    return s


def require_internal(env, request) -> None:
    """Reject public callers: shared secret required (service binding + backfill)."""
    expected = ""
    try:
        expected = str(getattr(env, "INDEXER_INTERNAL_SECRET") or "").strip()
    except AttributeError:
        expected = ""
    if not expected:
        raise IndexerError("INDEXER_INTERNAL_SECRET not configured", code="config", status=503)
    got = (request.headers.get("X-Edtech-Internal") or "").strip()
    if not got or got != expected:
        # 404 so the route is not advertised publicly
        raise IndexerError("not found", code="not_found", status=404)


def _event_base(ev: dict, *, chain_id: int, contract: str) -> dict:
    return {
        "chain_id": chain_id,
        "contract": contract,
        "block_number": int(ev["block_number"]),
        "block_time": parse_block_time(ev.get("block_time")),
        "tx_hash": norm_tx(ev.get("tx_hash") or ev.get("transactionHash")),
        "log_index": int(ev["log_index"] if "log_index" in ev else ev["logIndex"]),
    }


def build_chain_event_row(ev: dict, *, chain_id: int, contract: str) -> dict:
    base = _event_base(ev, chain_id=chain_id, contract=contract)
    name = str(ev.get("event_name") or ev.get("eventName") or "")
    if not name:
        raise IndexerError("event_name required", code="bad_event")
    args = ev.get("args")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise IndexerError("args must be object", code="bad_event")
    return {
        **base,
        "event_name": name,
        "args": args,
    }


def build_typed_rows(ev: dict, *, chain_id: int, contract: str) -> dict[str, list[dict]]:
    """Return {table: [rows]} for one decoded event. Empty if not a typed event."""
    name = str(ev.get("event_name") or ev.get("eventName") or "")
    if name not in TYPED_EVENTS:
        return {}
    args = ev.get("args") or {}
    if not isinstance(args, dict):
        raise IndexerError("args must be object", code="bad_event")
    base = _event_base(ev, chain_id=chain_id, contract=contract)

    if name == "TemplatePublished":
        return {
            "onchain_templates": [
                {
                    **base,
                    "onchain_id": norm_uint_str(args.get("templateId")),
                    "creator": norm_addr(args.get("creator")),
                    "parent_id": norm_uint_str(args.get("parentId")),
                    "price": norm_uint_str(args.get("price")),
                    "payment_token": norm_addr(args.get("paymentToken")),
                    "metadata_uri": args.get("metadataURI"),
                    "publisher": norm_addr(args.get("publisher")),
                }
            ]
        }

    if name == "TemplateUpdated":
        # Stored in chain_events; typed update applied in apply_template_updated.
        return {}

    if name == "Purchased":
        return {
            "sales": [
                {
                    **base,
                    "onchain_template_id": norm_uint_str(args.get("templateId")),
                    "buyer": norm_addr(args.get("buyer")),
                    "creator": norm_addr(args.get("creator")),
                    "token": norm_addr(args.get("paymentToken")),
                    "price": norm_uint_str(args.get("price")),
                    "creator_amount": norm_uint_str(args.get("creatorAmount")),
                    "platform_fee": norm_uint_str(args.get("platformFee")),
                }
            ]
        }

    if name == "RoyaltyPaid":
        return {
            "royalty_payments": [
                {
                    **base,
                    "onchain_template_id": norm_uint_str(args.get("templateId")),
                    "ancestor_id": norm_uint_str(args.get("ancestorId")),
                    "recipient": norm_addr(args.get("recipient")),
                    "level": int(norm_uint_str(args.get("level"))),
                    "token": norm_addr(args.get("paymentToken")),
                    "amount": norm_uint_str(args.get("amount")),
                }
            ]
        }

    if name == "PaymentDeferred":
        return {
            "deferred_payments": [
                {
                    **base,
                    "recipient": norm_addr(args.get("recipient")),
                    "token": norm_addr(args.get("token")),
                    "amount": norm_uint_str(args.get("amount")),
                }
            ]
        }

    if name == "Withdrawn":
        return {
            "withdrawals": [
                {
                    **base,
                    "account": norm_addr(args.get("account")),
                    "token": norm_addr(args.get("token")),
                    "amount": norm_uint_str(args.get("amount")),
                }
            ]
        }

    if name == "TransferSingle":
        return {
            "license_transfers": [
                {
                    **base,
                    "operator": norm_addr(args.get("operator")),
                    "from_addr": norm_addr(args.get("from")),
                    "to_addr": norm_addr(args.get("to")),
                    "onchain_template_id": norm_uint_str(args.get("id")),
                    "value": norm_uint_str(args.get("value")),
                    "batch": False,
                    "batch_index": 0,
                }
            ]
        }

    if name == "TransferBatch":
        ids = args.get("ids") or []
        values = args.get("values") or []
        if not isinstance(ids, list) or not isinstance(values, list) or len(ids) != len(values):
            raise IndexerError("TransferBatch ids/values mismatch", code="bad_event")
        rows = []
        for i, (tid, val) in enumerate(zip(ids, values)):
            rows.append(
                {
                    **base,
                    "operator": norm_addr(args.get("operator")),
                    "from_addr": norm_addr(args.get("from")),
                    "to_addr": norm_addr(args.get("to")),
                    "onchain_template_id": norm_uint_str(tid),
                    "value": norm_uint_str(val),
                    "batch": True,
                    "batch_index": i,
                }
            )
        return {"license_transfers": rows}

    return {}


async def get_cursor(sb: _Supabase, *, chain_id: int, contract: str) -> dict:
    contract = norm_contract(contract)
    row = await sb.request(
        "GET",
        f"indexer_cursor?select=*&chain_id=eq.{int(chain_id)}&contract=eq.{contract}&limit=1",
    )
    if isinstance(row, list) and row:
        return row[0]
    # Auto-seed if missing (migration should have inserted; keep resilient).
    seeded = {
        "chain_id": int(chain_id),
        "contract": contract,
        "last_block": 67913227,
    }
    await sb.upsert(
        "indexer_cursor",
        [seeded],
        on_conflict="chain_id,contract",
        ignore_duplicates=False,
    )
    return seeded


async def advance_cursor(
    sb: _Supabase, *, chain_id: int, contract: str, last_block: int
) -> dict:
    contract = norm_contract(contract)
    row = {
        "chain_id": int(chain_id),
        "contract": contract,
        "last_block": int(last_block),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    rows = await sb.upsert(
        "indexer_cursor",
        [row],
        on_conflict="chain_id,contract",
        ignore_duplicates=False,
    )
    if isinstance(rows, list) and rows:
        return rows[0]
    return row


async def _link_template_id(sb: _Supabase, onchain_id: str) -> str | None:
    tpl = await sb.get_by("templates", "onchain_token_id", str(onchain_id), select="id")
    if tpl and tpl.get("id"):
        return str(tpl["id"])
    return None


async def _apply_template_updated(
    sb: _Supabase, ev: dict, *, chain_id: int, contract: str
) -> None:
    args = ev.get("args") or {}
    onchain_id = norm_uint_str(args.get("templateId"))
    patch = {
        "price": norm_uint_str(args.get("price")),
        "metadata_uri": args.get("metadataURI"),
        "updated_block_number": int(ev["block_number"]),
        "updated_tx_hash": norm_tx(ev.get("tx_hash") or ev.get("transactionHash")),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Only update if the publish row exists (ignore-duplicates style).
    await sb.request(
        "PATCH",
        (
            f"onchain_templates?chain_id=eq.{int(chain_id)}"
            f"&contract=eq.{contract}"
            f"&onchain_id=eq.{onchain_id}"
        ),
        body=patch,
        prefer="return=minimal",
    )


async def ingest_events(
    sb: _Supabase,
    *,
    chain_id: int,
    contract: str,
    from_block: int,
    to_block: int,
    events: list[dict],
    advance: bool = True,
) -> dict:
    """Idempotent upsert of a decoded event batch; advance cursor after success."""
    if to_block < from_block:
        raise IndexerError("to_block < from_block", code="bad_range")
    contract = norm_contract(contract)
    chain_id = int(chain_id)

    if not isinstance(events, list):
        raise IndexerError("events must be a list", code="bad_event")

    chain_rows: list[dict] = []
    by_table: dict[str, list[dict]] = {}
    template_published: list[dict] = []
    template_updated: list[dict] = []

    for ev in events:
        if not isinstance(ev, dict):
            raise IndexerError("each event must be an object", code="bad_event")
        # Normalize block fields for builders
        if "block_number" not in ev and "blockNumber" in ev:
            ev = {**ev, "block_number": ev["blockNumber"]}
        if "log_index" not in ev and "logIndex" in ev:
            ev = {**ev, "log_index": ev["logIndex"]}
        if "tx_hash" not in ev and "transactionHash" in ev:
            ev = {**ev, "tx_hash": ev["transactionHash"]}
        if "event_name" not in ev and "eventName" in ev:
            ev = {**ev, "event_name": ev["eventName"]}

        chain_rows.append(build_chain_event_row(ev, chain_id=chain_id, contract=contract))
        name = str(ev.get("event_name") or "")
        if name == "TemplateUpdated":
            template_updated.append(ev)
        typed = build_typed_rows(ev, chain_id=chain_id, contract=contract)
        for table, rows in typed.items():
            by_table.setdefault(table, []).extend(rows)
            if table == "onchain_templates":
                template_published.extend(rows)

    # Resolve template_id for newly published onchain templates
    for row in template_published:
        linked = await _link_template_id(sb, row["onchain_id"])
        if linked:
            row["template_id"] = linked

    # Writes: chain_events first, then typed tables (ignore duplicates)
    if chain_rows:
        await sb.upsert(
            "chain_events",
            chain_rows,
            on_conflict="tx_hash,log_index",
            ignore_duplicates=True,
        )

    conflict_map = {
        "onchain_templates": "tx_hash,log_index",
        "sales": "tx_hash,log_index",
        "royalty_payments": "tx_hash,log_index",
        "deferred_payments": "tx_hash,log_index",
        "withdrawals": "tx_hash,log_index",
        "license_transfers": "tx_hash,log_index,batch_index",
    }
    inserted = {"chain_events": len(chain_rows)}
    for table, rows in by_table.items():
        if not rows:
            continue
        on_conflict = conflict_map[table]
        await sb.upsert(
            table,
            rows,
            on_conflict=on_conflict,
            ignore_duplicates=True,
        )
        inserted[table] = len(rows)

    for ev in template_updated:
        await _apply_template_updated(sb, ev, chain_id=chain_id, contract=contract)

    # Backfill-safe link for later-arriving templates.onchain_token_id rows
    linked_n = 0
    rpc_ok = False
    try:
        # Prefer RPC if migration applied; fall back to Python scan.
        result = await sb.rpc("link_onchain_templates_to_templates")
        rpc_ok = True
        if isinstance(result, int):
            linked_n = result
        elif isinstance(result, list) and result and isinstance(result[0], int):
            linked_n = result[0]
    except Exception:  # noqa: BLE001 — PostgREST/RPC may be unavailable in tests
        rpc_ok = False
    if not rpc_ok:
        nulls = await sb.request(
            "GET",
            (
                f"onchain_templates?select=onchain_id"
                f"&chain_id=eq.{chain_id}&contract=eq.{contract}"
                f"&template_id=is.null&limit=100"
            ),
        )
        for row in nulls or []:
            oid = row.get("onchain_id")
            if not oid:
                continue
            tid = await _link_template_id(sb, oid)
            if not tid:
                continue
            await sb.request(
                "PATCH",
                (
                    f"onchain_templates?chain_id=eq.{chain_id}"
                    f"&contract=eq.{contract}"
                    f"&onchain_id=eq.{oid}"
                    f"&template_id=is.null"
                ),
                body={"template_id": tid, "updated_at": datetime.now(timezone.utc).isoformat()},
                prefer="return=minimal",
            )
            linked_n += 1

    cursor_row = None
    if advance:
        # Only move forward
        current = await get_cursor(sb, chain_id=chain_id, contract=contract)
        last = int(current.get("last_block") or -1)
        if int(to_block) > last:
            cursor_row = await advance_cursor(
                sb, chain_id=chain_id, contract=contract, last_block=int(to_block)
            )
        else:
            cursor_row = current

    return {
        "ok": True,
        "from_block": int(from_block),
        "to_block": int(to_block),
        "events": len(events),
        "upserted": inserted,
        "linked_templates": linked_n,
        "cursor": cursor_row,
    }
