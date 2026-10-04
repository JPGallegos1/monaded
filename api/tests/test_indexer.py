"""Unit tests for Creator Economy indexer ingest (row builders + idempotent upsert)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from indexer import (  # noqa: E402
    IndexerError,
    build_chain_event_row,
    build_typed_rows,
    ingest_events,
    norm_addr,
    require_internal,
)


def run(coro):
    return asyncio.run(coro)


class FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


class FakeEnv:
    def __init__(self, secret=None):
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
        # Simulate ON CONFLICT DO NOTHING on (tx_hash, log_index) or PK
        key_cols = [c.strip() for c in on_conflict.split(",")]
        for row in rows:
            key = tuple(row.get(c) for c in key_cols)
            exists = any(tuple(r.get(c) for c in key_cols) == key for r in store)
            if exists and ignore_duplicates:
                continue
            if exists and not ignore_duplicates:
                # merge
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


def test_norm_addr_lowercase():
    assert norm_addr("0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e") == (
        "0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e"
    )


def test_require_internal_rejects_missing_secret():
    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret=None), FakeRequest())
    assert ei.value.status == 503

    with pytest.raises(IndexerError) as ei:
        require_internal(FakeEnv(secret="s3cret"), FakeRequest({"X-Edtech-Internal": "wrong"}))
    assert ei.value.status == 404

    require_internal(FakeEnv(secret="s3cret"), FakeRequest({"X-Edtech-Internal": "s3cret"}))


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
    typed = build_typed_rows(
        ev, chain_id=10143, contract="0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e"
    )
    assert "sales" in typed
    row = typed["sales"][0]
    assert row["buyer"] == "0x26040a45bccc47312d70c1a7653f08d82f4d1563"
    assert row["creator_amount"] == "10000000000000000"
    assert row["onchain_template_id"] == "1"
    chain = build_chain_event_row(
        ev, chain_id=10143, contract="0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e"
    )
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
    rows = build_typed_rows(
        ev, chain_id=10143, contract="0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e"
    )["onchain_templates"]
    assert rows[0]["onchain_id"] == "2"
    assert rows[0]["parent_id"] == "1"


def test_ingest_idempotent_and_advances_cursor():
    sb = FakeSB()
    sb.tables["indexer_cursor"] = [
        {
            "chain_id": 10143,
            "contract": "0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e",
            "last_block": 67913227,
        }
    ]
    # Later-arriving Supabase template for onchain id 99 — link on publish of 99
    sb.templates_by_onchain["99"] = {"id": "11111111-1111-1111-1111-111111111111"}

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

    result1 = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract="0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e",
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

    # Replay same batch — ignore duplicates, cursor may stay
    n_events_before = len(sb.tables["chain_events"])
    n_tpl_before = len(sb.tables["onchain_templates"])
    result2 = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract="0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e",
            from_block=67913228,
            to_block=67913327,
            events=[ev],
            advance=True,
        )
    )
    assert result2["ok"] is True
    assert len(sb.tables["chain_events"]) == n_events_before
    assert len(sb.tables["onchain_templates"]) == n_tpl_before
    # All typed upserts used ignore_duplicates
    assert any(u[0] == "chain_events" and u[3] is True for u in sb.upserts)


def test_ingest_empty_batch_still_advances():
    sb = FakeSB()
    sb.tables["indexer_cursor"] = [
        {
            "chain_id": 10143,
            "contract": "0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e",
            "last_block": 100,
        }
    ]
    result = run(
        ingest_events(
            sb,
            chain_id=10143,
            contract="0xc8c9cd5a19b4fc27b209adf75eda442c798ab59e",
            from_block=101,
            to_block=200,
            events=[],
            advance=True,
        )
    )
    assert result["cursor"]["last_block"] == 200
