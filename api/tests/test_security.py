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
from publish import (  # noqa: E402
    GLOBAL_PUBLISH_LIMIT,
    GLOBAL_PUBLISH_WINDOW_SECONDS,
    PUBLISH_CLAIM_TTL_SECONDS,
    PUBLISH_LIMIT,
    PUBLISH_WINDOW_SECONDS,
    build_publish_broadcast_patch,
    build_publish_claim_patch,
    build_publish_claim_release_patch,
    build_publish_success_patch,
    check_rate_limit,
    claim_stale_before_iso,
    is_claim_active,
    publish_claim_filter,
    PublishError,
    recoverable_publish_state,
    resolve_parent_onchain_id,
    resolve_rate_limit_params,
)
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


# ---- Publish persistence / idempotency -----------------------------------


def test_recoverable_publish_state_none_when_clean():
    assert recoverable_publish_state(None) is None
    assert recoverable_publish_state({"is_published": False}) is None
    assert recoverable_publish_state({"is_published": True, "publish_tx_hash": "0xabc"}) is None


def test_recoverable_publish_state_from_tx_hash():
    prior = recoverable_publish_state(
        {"is_published": False, "publish_tx_hash": "0xdead", "onchain_token_id": "9"}
    )
    assert prior == {"txHash": "0xdead", "templateId": "9"}


def test_recoverable_publish_state_from_token_only():
    prior = recoverable_publish_state({"is_published": False, "onchain_token_id": "42"})
    assert prior == {"templateId": "42"}


def test_build_publish_broadcast_patch_requires_tx():
    with pytest.raises(PublishError) as ei:
        build_publish_broadcast_patch(tx_hash="", onchain_token_id="1")
    assert ei.value.code == "chain"
    patch = build_publish_broadcast_patch(tx_hash="0xabc", onchain_token_id="7")
    assert patch["publish_tx_hash"] == "0xabc"
    assert patch["onchain_token_id"] == "7"
    assert "is_published" not in patch


def test_build_publish_success_patch_sets_published():
    patch = build_publish_success_patch(tx_hash="0xabc", onchain_token_id="3", price_wei=10**18)
    assert patch["is_published"] is True
    assert patch["publish_tx_hash"] == "0xabc"
    assert patch["onchain_token_id"] == "3"
    assert patch["price_mon"] == 1.0
    assert patch["publish_claimed_at"] is None


# ---- Atomic publish claim -------------------------------------------------


def test_publish_claim_filter_requires_unpublished_and_free_or_stale():
    filt = publish_claim_filter("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", now=1_700_000_180, ttl_seconds=180)
    assert "id=eq.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" in filt
    assert "is_published=eq.false" in filt
    assert "publish_claimed_at.is.null" in filt
    stale = claim_stale_before_iso(now=1_700_000_180, ttl_seconds=180)
    assert stale in filt
    assert "or=(" in filt


def test_claim_patch_and_release():
    claim = build_publish_claim_patch(now=1_700_000_000)
    assert claim["publish_claimed_at"] == "2023-11-14T22:13:20Z"
    release = build_publish_claim_release_patch(now=1_700_000_100)
    assert release["publish_claimed_at"] is None


def test_is_claim_active_and_stale_reclaim():
    now = 1_700_000_180
    # 60s ago < 180s TTL → still active
    assert (
        is_claim_active(
            {"publish_claimed_at": claim_stale_before_iso(now=now, ttl_seconds=60)},
            now=now,
            ttl_seconds=PUBLISH_CLAIM_TTL_SECONDS,
        )
        is True
    )
    # age == TTL → not active (reclaimable)
    assert (
        is_claim_active(
            {
                "publish_claimed_at": claim_stale_before_iso(
                    now=now, ttl_seconds=PUBLISH_CLAIM_TTL_SECONDS
                )
            },
            now=now,
            ttl_seconds=PUBLISH_CLAIM_TTL_SECONDS,
        )
        is False
    )
    assert is_claim_active({"publish_claimed_at": None}, now=now) is False
    assert is_claim_active({}, now=now) is False


class FakeClaimSB:
    """Minimal Supabase stand-in for atomic claim tests."""

    def __init__(self, row):
        self.row = dict(row)
        self.updates = []

    async def update_where(self, table, query, patch):
        assert table == "templates"
        self.updates.append((query, dict(patch)))
        # Simulate PostgREST: only apply if filters would match current row.
        if self.row.get("is_published") is True:
            return None
        claimed = self.row.get("publish_claimed_at")
        # Parse whether filter allows claim: null or stale.
        if claimed and "publish_claimed_at.is.null" in query:
            # Extract stale threshold from query ...publish_claimed_at.lt.STALE
            import re

            m = re.search(r"publish_claimed_at\.lt\.([^)&]+)", query)
            stale = m.group(1) if m else ""
            if claimed >= stale:  # lexicographic ISO compare works for Z timestamps
                return None
        self.row.update(patch)
        return dict(self.row)


def test_claim_template_winner_and_loser():
    from publish import claim_template_for_publish

    sb = FakeClaimSB({"id": "t1", "is_published": False, "publish_claimed_at": None})
    won = run(claim_template_for_publish(sb, "t1", now=1_700_000_000))
    assert won["publish_claimed_at"] == "2023-11-14T22:13:20Z"

    with pytest.raises(PublishError) as ei:
        run(claim_template_for_publish(sb, "t1", now=1_700_000_010))
    assert ei.value.code == "publishing_in_progress"
    assert ei.value.status == 409


def test_stale_claim_can_be_reclaimed():
    from publish import claim_template_for_publish

    # Claim set far in the past relative to now.
    sb = FakeClaimSB(
        {
            "id": "t1",
            "is_published": False,
            "publish_claimed_at": "2023-11-14T22:00:00Z",
        }
    )
    won = run(claim_template_for_publish(sb, "t1", now=1_700_000_000))  # 22:13:20Z
    assert won["publish_claimed_at"] == "2023-11-14T22:13:20Z"


# ---- parent_id from DB ---------------------------------------------------


def test_resolve_parent_id_root_when_no_parent():
    assert resolve_parent_onchain_id(template={"id": "t1"}, parent=None) == 0
    assert resolve_parent_onchain_id(template={"id": "t1", "parent_template_id": None}, parent=None) == 0


def test_resolve_parent_id_from_parent_onchain_token():
    tpl = {"id": "fork", "parent_template_id": "parent-uuid"}
    parent = {"id": "parent-uuid", "onchain_token_id": "42", "is_published": True}
    assert resolve_parent_onchain_id(template=tpl, parent=parent) == 42


def test_resolve_parent_id_rejects_missing_parent_row():
    with pytest.raises(PublishError) as ei:
        resolve_parent_onchain_id(template={"parent_template_id": "missing"}, parent=None)
    assert ei.value.code == "bad_parent"


def test_resolve_parent_id_rejects_unpublished_parent():
    with pytest.raises(PublishError) as ei:
        resolve_parent_onchain_id(
            template={"parent_template_id": "p"},
            parent={"id": "p", "onchain_token_id": None},
        )
    assert ei.value.code == "bad_parent"


def test_resolve_parent_id_ignores_invented_body_lineage():
    """Body parent_id is never an input to resolve_parent_onchain_id — DB wins."""
    tpl = {"id": "fork", "parent_template_id": "parent-uuid"}
    parent = {"id": "parent-uuid", "onchain_token_id": "7"}
    # Even if a client wanted parent 999, derivation yields 7.
    assert resolve_parent_onchain_id(template=tpl, parent=parent) == 7
    assert resolve_parent_onchain_id(template=tpl, parent=parent) != 999


# ---- Rate-limit DO hardcodes limit/window --------------------------------


def test_rate_limit_do_ignores_body_limit_and_window():
    scope, limit, window = resolve_rate_limit_params(
        {"scope": "user", "limit": 1_000_000, "window": 1}
    )
    assert scope == "user"
    assert limit == PUBLISH_LIMIT
    assert window == PUBLISH_WINDOW_SECONDS

    scope, limit, window = resolve_rate_limit_params(
        {"scope": "global", "limit": 1, "window": 1}
    )
    assert scope == "global"
    assert limit == GLOBAL_PUBLISH_LIMIT
    assert window == GLOBAL_PUBLISH_WINDOW_SECONDS


def test_rate_limit_do_defaults_scope_user():
    scope, limit, window = resolve_rate_limit_params({})
    assert scope == "user"
    assert limit == PUBLISH_LIMIT


# ---- Early tx-hash persist / reconcile -----------------------------------


def test_broadcast_patch_persists_hash_without_published_flag():
    patch = build_publish_broadcast_patch(tx_hash="0xsent")
    assert patch["publish_tx_hash"] == "0xsent"
    assert "is_published" not in patch
    assert "onchain_token_id" not in patch


def test_recoverable_state_prefers_tx_hash_for_receipt_reconcile():
    prior = recoverable_publish_state(
        {"is_published": False, "publish_tx_hash": "0xabc", "onchain_token_id": None}
    )
    assert prior == {"txHash": "0xabc"}
    # Presence of hash means retry must NOT call send again.


def test_send_then_receipt_helpers_do_not_rebroadcast_on_reconcile():
    """Simulate: hash persisted after send; retry uses fetch_receipt only."""
    from publish import fetch_publish_receipt, send_publish_for

    sent_calls: list[dict] = []
    receipt_calls: list[dict] = []

    async def fake_send(**kwargs):
        sent_calls.append(kwargs)
        return {"txHash": "0xdeadbeef"}

    async def fake_receipt(**kwargs):
        receipt_calls.append(kwargs)
        return {"txHash": kwargs["txHash"], "templateId": "99"}

    sent = run(
        send_publish_for(
            None,
            creator="0x1111111111111111111111111111111111111111",
            price_wei=10**18,
            parent_id=0,
            uri="ipfs://edtech-monad/x",
            send_tx=fake_send,
        )
    )
    assert sent["txHash"] == "0xdeadbeef"
    assert len(sent_calls) == 1

    # Persist would happen here in entry.py via build_publish_broadcast_patch.
    patch = build_publish_broadcast_patch(tx_hash=sent["txHash"])
    prior = recoverable_publish_state({"is_published": False, **patch})
    assert prior["txHash"] == "0xdeadbeef"

    # Retry path: receipt only — no second send.
    receipt = run(fetch_publish_receipt(None, tx_hash=prior["txHash"], fetch_receipt=fake_receipt))
    assert receipt["templateId"] == "99"
    assert len(sent_calls) == 1
    assert len(receipt_calls) == 1


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
