"""Security-focused unit tests for ownership, purchase mapping, rate limits, wallets."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from ownership import (  # noqa: E402
    OwnershipError,
    assert_can_publish,
    build_publish_uri,
    validate_publish_price,
    validate_publish_uri,
)
from privy_jwt import extract_wallet_from_identity_claims  # noqa: E402
from publish import GLOBAL_PUBLISH_LIMIT, check_rate_limit, PublishError  # noqa: E402
from purchase import PurchaseError  # noqa: E402
from purchase_resolve import onchain_id_from_template, resolve_template_for_purchase  # noqa: E402


def run(coro):
    return asyncio.run(coro)


# ---- Ownership / publish -------------------------------------------------


def test_publish_rejects_missing_template():
    with pytest.raises(OwnershipError) as ei:
        assert_can_publish(template=None, material={"owner_id": "u1"}, owner_user_id="u1")
    assert ei.value.code == "not_found"
    assert ei.value.status == 404


def test_publish_rejects_wrong_owner():
    with pytest.raises(OwnershipError) as ei:
        assert_can_publish(
            template={"id": "t1", "is_published": False, "material_id": "m1"},
            material={"id": "m1", "owner_id": "other-user"},
            owner_user_id="u1",
        )
    assert ei.value.code == "forbidden"


def test_publish_rejects_already_published():
    with pytest.raises(OwnershipError) as ei:
        assert_can_publish(
            template={"id": "t1", "is_published": True, "material_id": "m1"},
            material={"id": "m1", "owner_id": "u1"},
            owner_user_id="u1",
        )
    assert ei.value.code == "already_published"


def test_publish_ok_for_owner():
    tpl = assert_can_publish(
        template={"id": "t1", "is_published": False, "material_id": "m1", "content_hash": "abc"},
        material={"id": "m1", "owner_id": "u1"},
        owner_user_id="u1",
    )
    assert tpl["id"] == "t1"
    assert build_publish_uri(tpl) == "ipfs://edtech-monad/abc"


def test_publish_uri_never_from_client_body_pattern():
    """Server always builds uri from template fields."""
    uri = build_publish_uri({"id": "tid", "content_hash": None})
    assert uri == "ipfs://edtech-monad/tid"
    assert validate_publish_uri(uri).startswith("ipfs://")


def test_validate_price_range():
    assert validate_publish_price(1) == 1
    with pytest.raises(OwnershipError) as ei:
        validate_publish_price(0)
    assert ei.value.code == "bad_price"
    with pytest.raises(OwnershipError):
        validate_publish_price(101 * 10**18)


def test_validate_uri_length():
    with pytest.raises(OwnershipError) as ei:
        validate_publish_uri("x" * 3000)
    assert ei.value.code == "bad_uri"


# ---- Purchase ID mapping -------------------------------------------------


class FakeSB:
    def __init__(self, by_id=None, by_onchain=None):
        self.by_id = by_id or {}
        self.by_onchain = by_onchain or {}

    async def get(self, table, row_id, select="*"):
        assert table == "templates"
        return self.by_id.get(row_id)

    async def get_by(self, table, column, value, select="*"):
        assert table == "templates" and column == "onchain_token_id"
        return self.by_onchain.get(str(value))


def test_resolve_purchase_by_uuid_uses_db_onchain():
    tpl = {"id": "uuid-1", "onchain_token_id": "7"}
    sb = FakeSB(by_id={"uuid-1": tpl})
    got = run(resolve_template_for_purchase(sb, template_id="uuid-1", onchain_template_id=None))
    assert got["id"] == "uuid-1"
    assert onchain_id_from_template(got) == 7


def test_resolve_purchase_rejects_client_mismatch():
    tpl = {"id": "uuid-1", "onchain_token_id": "7"}
    sb = FakeSB(by_id={"uuid-1": tpl})
    with pytest.raises(PurchaseError) as ei:
        run(resolve_template_for_purchase(sb, template_id="uuid-1", onchain_template_id=99))
    assert ei.value.code == "id_mismatch"


def test_resolve_purchase_by_onchain_id():
    tpl = {"id": "uuid-2", "onchain_token_id": "42"}
    sb = FakeSB(by_onchain={"42": tpl})
    got = run(resolve_template_for_purchase(sb, onchain_template_id=42))
    assert got["id"] == "uuid-2"


def test_resolve_purchase_ignores_spoofed_uuid_when_looking_up_onchain():
    """Looking up by onchain id returns DB row; a different client uuid is not used."""
    tpl = {"id": "real-uuid", "onchain_token_id": "3"}
    sb = FakeSB(by_onchain={"3": tpl}, by_id={"spoofed": {"id": "spoofed", "onchain_token_id": "999"}})
    got = run(resolve_template_for_purchase(sb, onchain_template_id=3))
    assert got["id"] == "real-uuid"


# ---- Global rate limit ---------------------------------------------------


def test_global_rate_limit_cap():
    hist: list[int] = []
    now = 1_700_000_000
    for _ in range(GLOBAL_PUBLISH_LIMIT):
        hist = check_rate_limit(hist, now=now, limit=GLOBAL_PUBLISH_LIMIT, window=3600)
        now += 1
    with pytest.raises(PublishError) as ei:
        check_rate_limit(hist, now=now, limit=GLOBAL_PUBLISH_LIMIT, window=3600)
    assert ei.value.code == "rate_limited"


# ---- Embedded wallet preference ------------------------------------------


def test_extract_wallet_prefers_embedded():
    claims = {
        "linked_accounts": [
            {"type": "wallet", "address": "0x1111111111111111111111111111111111111111", "chain_type": "ethereum", "wallet_client": "metamask"},
            {"type": "wallet", "address": "0x2222222222222222222222222222222222222222", "chain_type": "ethereum", "walletClientType": "privy"},
        ]
    }
    assert extract_wallet_from_identity_claims(claims) == "0x2222222222222222222222222222222222222222"


def test_extract_wallet_falls_back_to_external():
    claims = {
        "linked_accounts": [
            {"type": "wallet", "address": "0x1111111111111111111111111111111111111111", "chain_type": "ethereum", "wallet_client": "metamask"},
        ]
    }
    assert extract_wallet_from_identity_claims(claims) == "0x1111111111111111111111111111111111111111"
