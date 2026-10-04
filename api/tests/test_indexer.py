"""Unit tests for Creator Economy indexer ingest (auth, validation, upserts)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from indexer import (  # noqa: E402
    ALLOWED_CHAIN_ID,
    ALLOWED_CONTRACT,
    IndexerError,
    assert_allowed_scope,
    build_chain_event_row,
    build_typed_rows,
    ingest_events,
    norm_addr,
    parse_ingest_payload,
    prepare_ingest_rows,
    require_internal,
)

MARKET = "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e"
MARKET_LOWER = ALLOWED_CONTRACT


def run(coro):
    return asyncio.run(coro)


class FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


class FakeEnv:
    def __init__(self, secret=None, *, missing=False):
        if missing:
            return
        if secret is not None:
            self.INDEXER_INTERNAL_SECRET = secret


class FakeSB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.upserts: list[tuple] = []
        self.patches: list[tuple] = []
        self.rpc_calls: list[str] = []
        self.templates_by_onchain: dict[str, dict] = {}

    async def upsert(self, table, rows, *, on_conflict, ignore_duplicates=False):
        self.upserts.append((table, rows, on_conflict, ignore_duplicates))
        store = self.tables.setdefault(table, [])
        key_cols = [c.strip() for c in on_conflict.split(",")]
        for row in rows:
            key = tuple(row.get(c) for c in key_cols)
            exists = any(tuple(r.get(c) for c in key_cols) == key for r in store)
            if exists and ignore_duplicates:
                continue
            if exists and not ignore_duplicates:
                for i, r in enumerate(store):
                    if tuple(r.get(c) for c in key_cols) == key:
                        store[i] = {**r, **row}
                        break
            else:
                store.append(dict(row))
        return rows

    async def request(self, method, path, body=None, prefer=None):
        if method == "GET" and path.startswith("indexer_cursor"):
            rows = self.tables.get("indexer_cursor") or []
            return rows[:1]
        if method == "GET" and path.startswith("onchain_templates"):
            rows = [r for r in self.tables.get("onchain_templates", []) if r.get("template_id") is None]
            return [{"onchain_id": r["onchain_id"]} for r in rows[:100]]
        if method == "PATCH":
            self.patches.append((path, body))
            return []
        raise AssertionError(f"unexpected request {method} {path}")

    async def get_by(self, table, column, value, select="*"):
        if table == "templates" and column == "onchain_token_id":
            return self.templates_by_onchain.get(str(value))
        return None

    async def rpc(self, fn_name, payload=None):
        self.rpc_calls.append(fn_name)
        raise RuntimeError("rpc not available in FakeSB")


def _valid_published_event(**overrides):
    ev = {
        "event_name": "TemplatePublished",
        "block_number": 67913303,
        "tx_hash": "0x" + "11" * 32,
        "log_index": 1,
        "args": {
            "templateId": "99",
            "creator": "0x83e24B4DfF93883f01456fCb86c3CD371Dc3Ea48",
            "parentId": "0",
            "price": "1",
            "paymentToken": "0x0000000000000000000000000000000000000000",
            "metadataURI": "ipfs://t",
            "publisher": "0x11de6e9D9Df8ed95f54CA35448a359a4f4a22e40",
        },
    }
    ev.update(overrides)
    return ev


def _seeded_sb():
    sb = FakeSB()
    sb.tables["indexer_cursor"] = [
        {"chain_id": 10143, "contract": MARKET_LOWER, "last_block": 67913227}
    ]
    return sb


# ---- Auth -----------------------------------------------------------------


def test_norm_addr_lowercase():
    assert norm_addr(MARKET) == MARKET_LOWER


def test_require_internal_unset_secret_is_404():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(missing=True), FakeRequest({"X-Edtech-Internal": "anything"}))
    assert ei.value.status == 404
    assert ei.value.message == "not found"
    assert ei.value.code == "not_found"


def test_require_internal_empty_secret_is_404():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret=""), FakeRequest({"X-Edtech-Internal": "x"}))
    assert ei.value.status == 404
    assert ei.value.message == "not found"


def test_require_internal_whitespace_secret_is_404():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret="   "), FakeRequest({"X-Edtech-Internal": "   "}))
    assert ei.value.status == 404
    assert ei.value.message == "not found"


def test_require_internal_wrong_secret_is_404_no_leak():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret="s3cret"), FakeRequest({"X-Edtech-Internal": "wrong"}))
    assert ei.value.status == 404
    assert ei.value.message == "not found"
    assert "secret" not in ei.value.message.lower()
    assert "s3cret" not in ei.value.message


def test_require_internal_missing_header_is_404():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret="s3cret"), FakeRequest({}))
    assert ei.value.status == 404
    assert ei.value.message == "not found"


def test_require_internal_accepts_matching_secret():
    require_internal(FakeEnv(secret="s3cret"), FakeRequest({"X-Edtech-Internal": "s3cret"}))


# ---- Scope / payload validation -------------------------------------------


def test_assert_allowed_scope_accepts_checksum_contract():
    cid, c = assert_allowed_scope(chain_id=10143, contract=MARKET)
    assert cid == ALLOWED_CHAIN_ID
    assert c == MARKET_LOWER


def test_assert_allowed_scope_rejects_wrong_chain():
    with pytest.raises(IndexerError) as ei:
        assert_allowed_scope(chain_id=1, contract=MARKET)
    assert ei.value.status == 400
    assert ei.value.code == "bad_chain"


def test_assert_allowed_scope_rejects_wrong_contract():
    with pytest.raises(IndexerError) as ei:
        assert_allowed_scope(chain_id=10143, contract="0x0000000000000000000000000000000000000001")
    assert ei.value.status == 400
    assert ei.value.code == "bad_contract"


def test_parse_ingest_rejects_wrong_chain_id():
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 8453,
                "contract": MARKET,
                "from_block": 1,
                "to_block": 2,
                "events": [],
            }
        )
    assert ei.value.code == "bad_chain"


def test_parse_ingest_rejects_wrong_contract():
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 10143,
                "contract": "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
                "from_block": 1,
                "to_block": 2,
                "events": [],
            }
        )
    assert ei.value.code == "bad_contract"


def test_parse_ingest_rejects_per_event_wrong_contract():
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 10143,
                "contract": MARKET,
                "from_block": 1,
                "to_block": 2,
                "events": [
                    _valid_published_event(contract="0x0000000000000000000000000000000000000001")
                ],
            }
        )
    assert ei.value.code == "bad_contract"


def test_parse_ingest_rejects_per_event_wrong_chain():
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 10143,
                "contract": MARKET,
                "from_block": 1,
                "to_block": 2,
                "events": [_valid_published_event(chain_id=999)],
            }
        )
    assert ei.value.code == "bad_chain"


def test_parse_ingest_rejects_malformed_tx_hash():
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 10143,
                "contract": MARKET,
                "from_block": 1,
                "to_block": 2,
                "events": [_valid_published_event(tx_hash="not-a-hash")],
            }
        )
    assert ei.value.code == "bad_event"
    assert ei.value.status == 400


def test_parse_ingest_rejects_missing_block_number():
    ev = _valid_published_event()
    del ev["block_number"]
    with pytest.raises(IndexerError) as ei:
        parse_ingest_payload(
            {
                "chain_id": 10143,
                "contract": MARKET,
                "from_block": 1,
                "to_block": 2,
                "events": [ev],
            }
        )
    assert ei.value.code == "bad_event"


def test_rejected_batch_has_no_partial_writes_wrong_contract():
    sb = _seeded_sb()
    good = _valid_published_event()
    bad = _valid_published_event(
        tx_hash="0x" + "22" * 32,
        log_index=2,
        contract="0x00000000000000000000000000000000000000aa",
    )
    with pytest.raises(IndexerError) as ei:
        run(
            ingest_events(
                sb,
                chain_id=10143,
                contract=MARKET,
                from_block=67913228,
                to_block=67913327,
                events=[good, bad],
                advance=True,
            )
        )
    assert ei.value.code == "bad_contract"
    assert sb.upserts == []
    assert "chain_events" not in sb.tables or sb.tables.get("chain_events") == []
    assert sb.tables["indexer_cursor"][0]["last_block"] == 67913227


def test_rejected_batch_has_no_partial_writes_malformed_middle_event():
    sb = _seeded_sb()
    good = _valid_published_event()
    bad = _valid_published_event(tx_hash="0x" + "33" * 32, log_index=2)
    bad["args"] = "not-an-object"
    with pytest.raises(IndexerError) as ei:
        run(
            ingest_events(
                sb,
                chain_id=10143,
                contract=MARKET,
                from_block=67913228,
                to_block=67913327,
                events=[good, bad],
                advance=True,
            )
        )
    assert ei.value.code == "bad_event"
    assert sb.upserts == []
    assert sb.tables["indexer_cursor"][0]["last_block"] == 67913227


def test_prepare_ingest_rows_rejects_wrong_chain_before_any_shape():
    with pytest.raises(IndexerError) as ei:
        prepare_ingest_rows(
            chain_id=5,
            contract=MARKET,
            from_block=1,
            to_block=2,
            events=[],
        )
    assert ei.value.code == "bad_chain"


# ---- Row builders / idempotent upsert -------------------------------------


def test_build_purchased_row():
    ev = {
        "event_name": "Purchased",
        "block_number": 67920615,
        "block_time": 1728000000,
        "tx_hash": "0x361a57166f3f2dbe8f9faf341ff62e1317b1cbb9aa58f426dbbcad4634f80aa2",
        "log_index": 106,
        "args": {
            "templateId": "1",
            "buyer": "0x26040A45bCcc47312D70c1A7653f08D82f4D1563",
            "creator": "0x83e24B4DfF93883f01456fCb86c3CD371Dc3Ea48",
            "paymentToken": "0x0000000000000000000000000000000000000000",
            "price": "10000000000000000",
            "creatorAmount": "10000000000000000",
            "platformFee": "0",
        },
    }
    typed = build_typed_rows(ev, chain_id=10143, contract=MARKET_LOWER)
    assert "sales" in typed
    row = typed["sales"][0]
    assert row["buyer"] == "0x26040a45bccc47312d70c1a7653f08d82f4d1563"
    assert row["creator_amount"] == "10000000000000000"
    assert row["onchain_template_id"] == "1"
    chain = build_chain_event_row(ev, chain_id=10143, contract=MARKET_LOWER)
    assert chain["event_name"] == "Purchased"
    assert chain["block_time"].startswith("20")


def test_build_template_published_parent():
    ev = {
        "event_name": "TemplatePublished",
        "block_number": 1,
        "tx_hash": "0x" + "ab" * 32,
        "log_index": 0,
        "args": {
            "templateId": 2,
            "creator": "0x039ee5a5e40C9853621689CA3D46e8C9De7c887a",
            "parentId": 1,
            "price": 10,
            "paymentToken": "0x0000000000000000000000000000000000000000",
            "metadataURI": "ipfs://x",
            "publisher": "0x11de6e9D9Df8ed95f54CA35448a359a4f4a22e40",
        },
    }
    rows = build_typed_rows(ev, chain_id=10143, contract=MARKET_LOWER)["onchain_templates"]
    assert rows[0]["onchain_id"] == "2"
    assert rows[0]["parent_id"] == "1"


def test_ingest_idempotent_and_advances_cursor():
    sb = _seeded_sb()
    sb.templates_by_onchain["99"] = {"id": "11111111-1111-1111-1111-111111111111"}
    ev = _valid_published_event()

    result1 = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract=MARKET,
            from_block=67913228,
            to_block=67913327,
            events=[ev],
            advance=True,
        )
    )
    assert result1["ok"] is True
    assert result1["cursor"]["last_block"] == 67913327
    assert len(sb.tables["chain_events"]) == 1
    assert len(sb.tables["onchain_templates"]) == 1
    assert sb.tables["onchain_templates"][0]["template_id"] == "11111111-1111-1111-1111-111111111111"

    n_events_before = len(sb.tables["chain_events"])
    n_tpl_before = len(sb.tables["onchain_templates"])
    result2 = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract=MARKET_LOWER,
            from_block=67913228,
            to_block=67913327,
            events=[ev],
            advance=True,
        )
    )
    assert result2["ok"] is True
    assert len(sb.tables["chain_events"]) == n_events_before
    assert len(sb.tables["onchain_templates"]) == n_tpl_before
    assert any(u[0] == "chain_events" and u[3] is True for u in sb.upserts)


def test_ingest_empty_batch_still_advances():
    sb = FakeSB()
    sb.tables["indexer_cursor"] = [
        {"chain_id": 10143, "contract": MARKET_LOWER, "last_block": 100}
    ]
    result = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract=MARKET_LOWER,
            from_block=101,
            to_block=200,
            events=[],
            advance=True,
        )
    )
    assert result["cursor"]["last_block"] == 200


def test_parse_ingest_payload_happy_path():
    chain_id, contract, frm, to, events, advance = parse_ingest_payload(
        {
            "chain_id": "10143",
            "contract": MARKET,
            "from_block": 10,
            "to_block": 20,
            "events": [_valid_published_event()],
            "advance_cursor": True,
        }
    )
    assert chain_id == 10143
    assert contract == MARKET_LOWER
    assert frm == 10 and to == 20
    assert len(events) == 1
    assert advance is True
