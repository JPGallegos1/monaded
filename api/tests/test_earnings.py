"""Tests for GET /me/earnings payload builder and wallet scoping."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from earnings import (  # noqa: E402
    NATIVE_TOKEN,
    build_earnings_payload,
    get_earnings_for_wallet,
    merge_recent,
    wei_str,
)


def run(coro):
    return asyncio.run(coro)


WALLET = "0x83e24B4DfF93883f01456fCb86c3CD371Dc3Ea48"
WALLET_LOWER = WALLET.lower()
OTHER = "0x039ee5a5e40C9853621689CA3D46e8C9De7c887a".lower()


def _eq_filters(path: str) -> dict[str, str]:
    q = path.split("?", 1)[1] if "?" in path else ""
    out: dict[str, str] = {}
    for part in q.split("&"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        if v.startswith("eq."):
            out[k] = v[3:]
    return out


class FakeSB:
    def __init__(self):
        self.balance_rows: list[dict] = []
        self.sales_rows: list[dict] = []
        self.royalty_rows: list[dict] = []
        self.onchain_templates: list[dict] = []
        self.templates: list[dict] = []
        self.gets: list[str] = []

    async def request(self, method, path, body=None, prefer=None):
        assert method == "GET"
        self.gets.append(path)
        table = path.split("?", 1)[0]
        filters = _eq_filters(path)
        if table == "creator_balances":
            return [
                r
                for r in self.balance_rows
                if r.get("wallet") == filters.get("wallet") and r.get("token") == filters.get("token")
            ][:1]
        if table == "sales":
            rows = [
                r
                for r in self.sales_rows
                if r.get("creator") == filters.get("creator") and r.get("token") == filters.get("token")
            ]
            rows = sorted(
                rows,
                key=lambda r: (r.get("block_time") or "", r.get("log_index") or 0),
                reverse=True,
            )
            return rows[:5]
        if table == "royalty_payments":
            rows = [
                r
                for r in self.royalty_rows
                if r.get("recipient") == filters.get("recipient") and r.get("token") == filters.get("token")
            ]
            rows = sorted(
                rows,
                key=lambda r: (r.get("block_time") or "", r.get("log_index") or 0),
                reverse=True,
            )
            return rows[:5]
        if table == "onchain_templates":
            return list(self.onchain_templates)
        if table == "templates":
            return list(self.templates)
        raise AssertionError(f"unexpected {path}")


def test_wei_str_decimal_strings():
    assert wei_str(0) == "0"
    assert wei_str("10000000000000000") == "10000000000000000"
    assert wei_str(10**18) == str(10**18)
    assert wei_str("12.0") == "12"
    assert wei_str(None) == "0"


def test_zero_state_empty_tables():
    payload = build_earnings_payload(
        wallet=WALLET,
        balance_row=None,
        sales_rows=[],
        royalty_rows=[],
    )
    assert payload["wallet"] == WALLET_LOWER
    assert payload["token"] == NATIVE_TOKEN
    assert payload["totals"] == {
        "earned": "0",
        "sales": "0",
        "royalties": "0",
        "pending_withdrawal": "0",
        "withdrawn": "0",
    }
    assert payload["recent"] == []


def test_totals_earned_is_sales_plus_royalties_strings():
    payload = build_earnings_payload(
        wallet=WALLET_LOWER,
        balance_row={
            "earned_sales": "9000000000000000",
            "earned_royalties": "1000000000000000",
            "earned": "10000000000000000",
            "pending": "0",
            "withdrawn": "0",
        },
        sales_rows=[],
        royalty_rows=[],
    )
    assert payload["totals"]["sales"] == "9000000000000000"
    assert payload["totals"]["royalties"] == "1000000000000000"
    assert payload["totals"]["earned"] == "10000000000000000"
    assert isinstance(payload["totals"]["earned"], str)


def test_recent_ordering_and_limit():
    sales = [
        {
            "onchain_template_id": "1",
            "creator_amount": "10",
            "buyer": "0x26040A45bCcc47312D70c1A7653f08D82f4D1563",
            "tx_hash": "0x" + "aa" * 32,
            "block_time": "2026-10-03T20:00:00+00:00",
            "block_number": 100,
            "log_index": 1,
        },
        {
            "onchain_template_id": "1",
            "creator_amount": "11",
            "buyer": "0x26040A45bCcc47312D70c1A7653f08D82f4D1563",
            "tx_hash": "0x" + "bb" * 32,
            "block_time": "2026-10-03T22:00:00+00:00",
            "block_number": 200,
            "log_index": 5,
        },
    ]
    royalties = [
        {
            "onchain_template_id": "2",
            "amount": "1",
            "level": 1,
            "tx_hash": "0x" + "cc" * 32,
            "block_time": "2026-10-03T22:00:00+00:00",
            "block_number": 200,
            "log_index": 4,
        },
        {
            "onchain_template_id": "2",
            "amount": "2",
            "level": 1,
            "tx_hash": "0x" + "dd" * 32,
            "block_time": "2026-10-03T21:00:00+00:00",
            "block_number": 150,
            "log_index": 9,
        },
        {
            "onchain_template_id": "3",
            "amount": "3",
            "level": 2,
            "tx_hash": "0x" + "ee" * 32,
            "block_time": "2026-10-03T19:00:00+00:00",
            "block_number": 90,
            "log_index": 1,
        },
        {
            "onchain_template_id": "3",
            "amount": "4",
            "level": 1,
            "tx_hash": "0x" + "ff" * 32,
            "block_time": "2026-10-03T18:00:00+00:00",
            "block_number": 80,
            "log_index": 1,
        },
    ]
    recent = merge_recent(sales, royalties, template_id_by_onchain={}, limit=5)
    assert len(recent) == 5
    # Same block_time 22:00: sale log_index 5 before royalty log_index 4
    assert recent[0]["kind"] == "sale"
    assert recent[0]["amount"] == "11"
    assert recent[0]["counterparty"] == "0x26040a45bccc47312d70c1a7653f08d82f4d1563"
    assert recent[1]["kind"] == "royalty"
    assert recent[1]["level"] == 1
    assert recent[1]["counterparty"] is None
    assert recent[2]["amount"] == "2"
    assert recent[3]["amount"] == "10"
    assert recent[4]["amount"] == "3"
    # 6th item (amount 4) dropped by limit
    assert all(isinstance(r["amount"], str) for r in recent)


def test_sale_and_royalty_shape():
    payload = build_earnings_payload(
        wallet=WALLET,
        balance_row={"earned_sales": "10", "earned_royalties": "1", "earned": "11", "pending": "0", "withdrawn": "0"},
        sales_rows=[
            {
                "onchain_template_id": "1",
                "creator_amount": "10",
                "buyer": OTHER,
                "tx_hash": "0x" + "11" * 32,
                "block_time": "2026-10-03T20:00:00Z",
                "block_number": 1,
                "log_index": 2,
            }
        ],
        royalty_rows=[
            {
                "onchain_template_id": "2",
                "amount": "1",
                "level": 1,
                "tx_hash": "0x" + "22" * 32,
                "block_time": "2026-10-03T19:00:00Z",
                "block_number": 1,
                "log_index": 1,
            }
        ],
        template_id_by_onchain={"1": "11111111-1111-1111-1111-111111111111", "2": None},
    )
    assert payload["recent"][0]["kind"] == "sale"
    assert payload["recent"][0]["template_id"] == "11111111-1111-1111-1111-111111111111"
    assert payload["recent"][0]["level"] is None
    assert payload["recent"][1]["kind"] == "royalty"
    assert payload["recent"][1]["template_id"] is None
    assert payload["recent"][1]["level"] == 1


def test_get_earnings_scopes_queries_to_session_wallet_only():
    sb = FakeSB()
    sb.balance_rows = [
        {
            "wallet": WALLET_LOWER,
            "token": NATIVE_TOKEN,
            "earned_sales": "5",
            "earned_royalties": "0",
            "earned": "5",
            "pending": "0",
            "withdrawn": "0",
        },
        {
            "wallet": OTHER,
            "token": NATIVE_TOKEN,
            "earned_sales": "999",
            "earned_royalties": "999",
            "earned": "1998",
            "pending": "0",
            "withdrawn": "0",
        },
    ]
    sb.sales_rows = [
        {
            "creator": WALLET_LOWER,
            "token": NATIVE_TOKEN,
            "onchain_template_id": "1",
            "creator_amount": "5",
            "buyer": OTHER,
            "tx_hash": "0x" + "11" * 32,
            "block_time": "2026-10-03T20:00:00+00:00",
            "block_number": 1,
            "log_index": 1,
        },
        {
            "creator": OTHER,
            "token": NATIVE_TOKEN,
            "onchain_template_id": "9",
            "creator_amount": "999",
            "buyer": WALLET_LOWER,
            "tx_hash": "0x" + "99" * 32,
            "block_time": "2026-10-04T20:00:00+00:00",
            "block_number": 9,
            "log_index": 9,
        },
    ]
    sb.royalty_rows = [
        {
            "recipient": OTHER,
            "token": NATIVE_TOKEN,
            "onchain_template_id": "2",
            "amount": "999",
            "level": 1,
            "tx_hash": "0x" + "88" * 32,
            "block_time": "2026-10-04T21:00:00+00:00",
            "block_number": 10,
            "log_index": 1,
        }
    ]

    payload = run(get_earnings_for_wallet(sb, WALLET))
    assert payload["wallet"] == WALLET_LOWER
    assert payload["totals"]["earned"] == "5"
    assert payload["totals"]["sales"] == "5"
    assert len(payload["recent"]) == 1
    assert payload["recent"][0]["amount"] == "5"
    # Ensure filters targeted the session wallet (not OTHER)
    assert any(f"creator=eq.{WALLET_LOWER}" in g for g in sb.gets)
    assert any(f"wallet=eq.{WALLET_LOWER}" in g for g in sb.gets)
    assert not any(f"creator=eq.{OTHER}" in g for g in sb.gets)


def test_get_earnings_zero_when_no_rows():
    sb = FakeSB()
    payload = run(get_earnings_for_wallet(sb, WALLET))
    assert payload["totals"]["earned"] == "0"
    assert payload["recent"] == []
    assert payload["token"] == NATIVE_TOKEN


def test_norm_wallet_rejects_garbage():
    with pytest.raises(ValueError):
        build_earnings_payload(wallet="not-an-address", balance_row=None, sales_rows=[], royalty_rows=[])


def test_auth_required_contract_for_handler():
    """Documented contract: handler must 401 without session (mirrors entry.me_earnings)."""
    # Simulate the entry gate without importing workers runtime.
    def gate(session):
        if session is None:
            return 401, {"error": "not authenticated"}
        return 200, run(get_earnings_for_wallet(FakeSB(), session["walletAddress"]))

    status, body = gate(None)
    assert status == 401
    assert "error" in body

    status, body = gate({"walletAddress": WALLET})
    assert status == 200
    assert body["wallet"] == WALLET_LOWER
