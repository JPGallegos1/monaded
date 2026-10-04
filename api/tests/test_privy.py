"""JWT / session / purchase unit tests (run with pytest outside the Worker)."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any

import pytest

# Allow importing sibling modules from api/src
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from privy_jwt import (  # noqa: E402
    JwtError,
    JwksCache,
    b64url_encode,
    parse_jwt_parts,
    validate_claims,
    verify_privy_jwt,
)
from purchase import PurchaseError, parse_purchased_logs, verify_purchase_tx  # noqa: E402
from publish import check_rate_limit, PublishError  # noqa: E402
from session import (  # noqa: E402
    get_session_id_from_request,
    parse_cookie_header,
    session_cookie_header,
)


APP_ID = "test-privy-app-id"
KID = "test-key-1"


def _b64url_json(obj: dict) -> str:
    return b64url_encode(json.dumps(obj, separators=(",", ":")).encode())


def make_token(
    *,
    payload: dict,
    header: dict | None = None,
    signature: bytes | None = None,
) -> str:
    hdr = {"alg": "ES256", "typ": "JWT", "kid": KID}
    if header:
        hdr.update(header)
    sig = signature if signature is not None else b"\x11" * 64
    return f"{_b64url_json(hdr)}.{_b64url_json(payload)}.{b64url_encode(sig)}"


def valid_payload(**overrides) -> dict:
    now = int(time.time())
    p = {
        "iss": "privy.io",
        "aud": APP_ID,
        "sub": "did:privy:user123",
        "exp": now + 3600,
        "iat": now,
        "sid": "sess-1",
    }
    p.update(overrides)
    return p


class FakeResp:
    def __init__(self, body: Any, status: int = 200):
        self.status = status
        self._body = body

    async def text(self):
        if isinstance(self._body, str):
            return self._body
        return json.dumps(self._body)


@pytest.fixture
def jwk() -> dict:
    # Deterministic fake JWK (signature checks mocked)
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
        "kid": KID,
        "alg": "ES256",
        "use": "sig",
    }


def run(coro):
    return asyncio.run(coro)


# ---- JWT -----------------------------------------------------------------


def test_parse_jwt_parts_ok():
    token = make_token(payload=valid_payload())
    header, payload, signing_input, sig = parse_jwt_parts(token)
    assert header["alg"] == "ES256"
    assert payload["sub"].startswith("did:privy:")
    assert len(sig) == 64
    assert b"." in signing_input


def test_validate_claims_wrong_aud():
    with pytest.raises(JwtError) as ei:
        validate_claims(valid_payload(aud="other-app"), APP_ID)
    assert ei.value.code == "bad_aud"


def test_validate_claims_wrong_iss():
    with pytest.raises(JwtError) as ei:
        validate_claims(valid_payload(iss="evil.io"), APP_ID)
    assert ei.value.code == "bad_iss"


def test_validate_claims_expired():
    with pytest.raises(JwtError) as ei:
        validate_claims(valid_payload(exp=int(time.time()) - 10), APP_ID)
    assert ei.value.code == "expired"


def test_verify_rejects_wrong_alg(jwk):
    token = make_token(payload=valid_payload(), header={"alg": "HS256", "kid": KID})

    async def ok_sig(*_a, **_k):
        return True

    async def fetch_fn(*_a, **_k):
        return FakeResp({"keys": [jwk]})

    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, fetch_fn=fetch_fn, verify_sig=ok_sig))
    assert ei.value.code == "bad_alg"


def test_verify_valid_token(jwk):
    token = make_token(payload=valid_payload())

    async def ok_sig(*_a, **_k):
        return True

    async def fetch_fn(*_a, **_k):
        return FakeResp({"keys": [jwk]})

    claims = run(verify_privy_jwt(token, APP_ID, fetch_fn=fetch_fn, verify_sig=ok_sig))
    assert claims["sub"] == "did:privy:user123"
    assert claims["aud"] == APP_ID


def test_verify_wrong_aud(jwk):
    token = make_token(payload=valid_payload(aud="nope"))

    async def ok_sig(*_a, **_k):
        return True

    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, jwk_override=jwk, verify_sig=ok_sig))
    assert ei.value.code == "bad_aud"


def test_verify_wrong_iss(jwk):
    token = make_token(payload=valid_payload(iss="attacker"))

    async def ok_sig(*_a, **_k):
        return True

    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, jwk_override=jwk, verify_sig=ok_sig))
    assert ei.value.code == "bad_iss"


def test_verify_expired(jwk):
    token = make_token(payload=valid_payload(exp=int(time.time()) - 1))

    async def ok_sig(*_a, **_k):
        return True

    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, jwk_override=jwk, verify_sig=ok_sig))
    assert ei.value.code == "expired"


def test_verify_unknown_kid(jwk):
    other = dict(jwk, kid="other-kid")
    token = make_token(payload=valid_payload(), header={"kid": "missing-kid"})

    async def ok_sig(*_a, **_k):
        return True

    calls = {"n": 0}

    async def fetch_fn(*_a, **_k):
        calls["n"] += 1
        return FakeResp({"keys": [other]})

    cache = JwksCache()
    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, cache=cache, fetch_fn=fetch_fn, verify_sig=ok_sig))
    assert ei.value.code == "unknown_kid"
    assert calls["n"] >= 1


def test_verify_invalid_signature(jwk):
    token = make_token(payload=valid_payload())

    async def bad_sig(*_a, **_k):
        return False

    with pytest.raises(JwtError) as ei:
        run(verify_privy_jwt(token, APP_ID, jwk_override=jwk, verify_sig=bad_sig))
    assert ei.value.code == "bad_signature"


# ---- Session cookies -----------------------------------------------------


class FakeHeaders(dict):
    def get(self, k, default=None):
        return super().get(k, default)


class FakeRequest:
    def __init__(self, cookie: str | None):
        self.headers = FakeHeaders()
        if cookie:
            self.headers["Cookie"] = cookie


def test_session_cookie_flags():
    h = session_cookie_header("abcXYZ0123456789_-", int(time.time()) + 100)
    assert "HttpOnly" in h
    assert "Secure" in h
    assert "SameSite=Lax" in h
    assert "edtech_session=" in h


def test_session_cookie_clear():
    h = session_cookie_header("", 0, clear=True)
    assert "Max-Age=0" in h


def test_parse_cookie_and_get_session_id():
    sid = "abcXYZ0123456789_-"
    req = FakeRequest(f"foo=1; edtech_session={sid}; bar=2")
    assert parse_cookie_header(req.headers["Cookie"])["edtech_session"] == sid
    assert get_session_id_from_request(req) == sid


def test_reject_malformed_session_id():
    req = FakeRequest("edtech_session=../etc/passwd")
    assert get_session_id_from_request(req) is None


# ---- Purchase verification -----------------------------------------------

MARKET = "0xC8c9Cd5A19b4FC27B209AdF75eDA442C798Ab59e"
BUYER = "0x1111111111111111111111111111111111111111"
CREATOR = "0x2222222222222222222222222222222222222222"
TOPIC0 = "0x56cc1e0da1e03045444aa9e0b296611b2f33c62704d401968e22e73e93c59159"


def _topic_addr(addr: str) -> str:
    return "0x" + addr.lower().removeprefix("0x").rjust(64, "0")


def _topic_uint(n: int) -> str:
    return "0x" + f"{n:064x}"


def make_receipt(*, status="0x1", address=MARKET, buyer=BUYER, template_id=1, topic0=TOPIC0):
    return {
        "status": status,
        "transactionHash": "0x" + "ab" * 32,
        "logs": [
            {
                "address": address,
                "topics": [
                    topic0,
                    _topic_uint(template_id),
                    _topic_addr(buyer),
                    _topic_addr(CREATOR),
                ],
                "transactionHash": "0x" + "ab" * 32,
            }
        ],
    }


def test_purchase_ok():
    receipt = make_receipt()
    m = parse_purchased_logs(receipt, marketplace=MARKET, buyer=BUYER, template_id=1)
    assert m["buyer"] == BUYER.lower()
    assert m["templateId"] == 1


def test_purchase_bad_status():
    with pytest.raises(PurchaseError) as ei:
        parse_purchased_logs(make_receipt(status="0x0"), marketplace=MARKET, buyer=BUYER, template_id=1)
    assert ei.value.code == "bad_status"


def test_purchase_wrong_contract():
    other = "0x9999999999999999999999999999999999999999"
    with pytest.raises(PurchaseError) as ei:
        parse_purchased_logs(make_receipt(address=other), marketplace=MARKET, buyer=BUYER, template_id=1)
    assert ei.value.code == "wrong_contract"


def test_purchase_wrong_buyer():
    with pytest.raises(PurchaseError) as ei:
        parse_purchased_logs(
            make_receipt(buyer="0x3333333333333333333333333333333333333333"),
            marketplace=MARKET,
            buyer=BUYER,
            template_id=1,
        )
    assert ei.value.code == "wrong_buyer"


def test_purchase_wrong_template():
    with pytest.raises(PurchaseError) as ei:
        parse_purchased_logs(make_receipt(template_id=99), marketplace=MARKET, buyer=BUYER, template_id=1)
    assert ei.value.code == "wrong_template"


def test_purchase_replay_unique_constraint_semantics():
    """Documented behavior: callers treat duplicate tx_hash insert as replay.

    Unit-level: verifying the same receipt twice still parses; uniqueness is DB-side.
    """
    receipt = make_receipt()
    a = run(
        verify_purchase_tx(
            tx_hash="0x" + "ab" * 32,
            buyer_wallet=BUYER,
            onchain_template_id=1,
            marketplace=MARKET,
            receipt=receipt,
        )
    )
    b = run(
        verify_purchase_tx(
            tx_hash="0x" + "ab" * 32,
            buyer_wallet=BUYER,
            onchain_template_id=1,
            marketplace=MARKET,
            receipt=receipt,
        )
    )
    assert a["txHash"] == b["txHash"]


def test_replay_tracker():
    """Simple in-test replay set mirrors the unique constraint behavior."""
    seen: set[str] = set()
    tx = "0x" + "cd" * 32
    receipt = make_receipt()
    receipt["transactionHash"] = tx
    receipt["logs"][0]["transactionHash"] = tx

    async def once():
        matched = await verify_purchase_tx(
            tx_hash=tx,
            buyer_wallet=BUYER,
            onchain_template_id=1,
            marketplace=MARKET,
            receipt=receipt,
        )
        if matched["txHash"] in seen:
            raise PurchaseError("tx hash already used", code="replay")
        seen.add(matched["txHash"])
        return matched

    run(once())
    with pytest.raises(PurchaseError) as ei:
        run(once())
    assert ei.value.code == "replay"


# ---- Publish rate limit --------------------------------------------------


def test_publish_rate_limit():
    hist: list[int] = []
    now = 1_700_000_000
    for _ in range(5):
        hist = check_rate_limit(hist, now=now, limit=5, window=3600)
        now += 1
    with pytest.raises(PublishError) as ei:
        check_rate_limit(hist, now=now, limit=5, window=3600)
    assert ei.value.code == "rate_limited"
