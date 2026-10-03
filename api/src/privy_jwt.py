"""Privy JWT verification for Cloudflare Python Workers.

Verifies access/identity tokens as ES256 (P-256/SHA-256) via WebCrypto
(`crypto.subtle.verify`) through the Python Workers JS FFI. Pure-Python EC
math is avoided because Workers Free is limited to ~10 ms CPU per request.

JWKS: https://auth.privy.io/api/v1/apps/{app_id}/jwks.json
Claims checked: iss=privy.io, aud=app_id, exp, sub (Privy DID = userId).
Algorithm is pinned to ES256; the JWT header `alg` is ignored for crypto.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any, Awaitable, Callable, Optional

PRIVY_ISSUER = "privy.io"
PINNED_ALG = "ES256"
JWKS_TTL_SECONDS = 300  # short TTL; refetch on unknown kid regardless
DEFAULT_JWKS_URL = "https://auth.privy.io/api/v1/apps/{app_id}/jwks.json"

FetchFn = Callable[..., Awaitable[Any]]


class JwtError(Exception):
    """Raised when a Privy JWT fails verification or claim checks."""

    def __init__(self, message: str, *, code: str = "invalid_token"):
        super().__init__(message)
        self.message = message
        self.code = code


def b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def parse_jwt_parts(token: str) -> tuple[dict, dict, bytes, bytes]:
    """Split a JWT into header, payload, signing_input, and raw r||s signature."""
    if not isinstance(token, str) or token.count(".") != 2:
        raise JwtError("malformed JWT", code="malformed")
    header_b64, payload_b64, sig_b64 = token.split(".")
    try:
        header = json.loads(b64url_decode(header_b64))
        payload = json.loads(b64url_decode(payload_b64))
        signature = b64url_decode(sig_b64)
    except (ValueError, json.JSONDecodeError) as e:
        raise JwtError(f"malformed JWT: {e}", code="malformed") from e
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise JwtError("malformed JWT claims", code="malformed")
    # WebCrypto ECDSA expects raw r||s (64 bytes for P-256). jose/JWT is already that.
    if len(signature) != 64:
        raise JwtError("unexpected ES256 signature length", code="bad_signature")
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    return header, payload, signing_input, signature


class JwksCache:
    """In-isolate JWKS cache with short TTL and unknown-kid refresh."""

    def __init__(self, ttl_seconds: int = JWKS_TTL_SECONDS):
        self.ttl_seconds = ttl_seconds
        self._keys: dict[str, dict] = {}
        self._fetched_at: float = 0.0
        self._app_id: str | None = None

    def get_cached(self, kid: str) -> dict | None:
        if not self._keys:
            return None
        if time.time() - self._fetched_at > self.ttl_seconds:
            return None
        return self._keys.get(kid)

    def put_keys(self, app_id: str, keys: list[dict], *, fetched_at: float | None = None) -> None:
        self._app_id = app_id
        self._fetched_at = fetched_at if fetched_at is not None else time.time()
        self._keys = {k["kid"]: k for k in keys if isinstance(k, dict) and k.get("kid")}

    def clear(self) -> None:
        self._keys.clear()
        self._fetched_at = 0.0


async def fetch_jwks(app_id: str, fetch_fn: FetchFn | None = None) -> list[dict]:
    url = DEFAULT_JWKS_URL.format(app_id=app_id)
    if fetch_fn is None:
        from workers import fetch as fetch_fn  # type: ignore
    resp = await fetch_fn(url, method="GET", headers={"Accept": "application/json"})
    status = getattr(resp, "status", None)
    text = await resp.text()
    if status is not None and status >= 400:
        raise JwtError(f"JWKS fetch failed ({status})", code="jwks_fetch")
    try:
        body = json.loads(text) if text else {}
    except json.JSONDecodeError as e:
        raise JwtError("invalid JWKS JSON", code="jwks_fetch") from e
    keys = body.get("keys") if isinstance(body, dict) else None
    if not isinstance(keys, list):
        raise JwtError("JWKS missing keys", code="jwks_fetch")
    return keys


async def resolve_jwk(
    kid: str,
    app_id: str,
    cache: JwksCache,
    *,
    fetch_fn: FetchFn | None = None,
    force_refresh: bool = False,
) -> dict:
    if not force_refresh:
        cached = cache.get_cached(kid)
        if cached is not None:
            return cached
    keys = await fetch_jwks(app_id, fetch_fn=fetch_fn)
    cache.put_keys(app_id, keys)
    jwk = cache._keys.get(kid)
    if jwk is None:
        raise JwtError("unknown kid", code="unknown_kid")
    return jwk


def validate_claims(payload: dict, app_id: str, *, now: float | None = None) -> dict:
    """Validate iss/aud/exp/sub. Returns normalized claims."""
    now_ts = int(now if now is not None else time.time())
    iss = payload.get("iss")
    if iss != PRIVY_ISSUER:
        raise JwtError("invalid issuer", code="bad_iss")
    aud = payload.get("aud")
    if isinstance(aud, list):
        if app_id not in aud:
            raise JwtError("invalid audience", code="bad_aud")
    elif aud != app_id:
        raise JwtError("invalid audience", code="bad_aud")
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        raise JwtError("missing exp", code="bad_exp")
    if now_ts >= int(exp):
        raise JwtError("token expired", code="expired")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise JwtError("missing sub", code="bad_sub")
    return {
        "sub": sub.strip(),
        "aud": app_id,
        "iss": PRIVY_ISSUER,
        "exp": int(exp),
        "iat": int(payload["iat"]) if isinstance(payload.get("iat"), (int, float)) else None,
        "sid": payload.get("sid"),
        "linked_accounts": payload.get("linked_accounts"),
        "raw": payload,
    }


async def verify_es256_webcrypto(signing_input: bytes, signature: bytes, jwk: dict) -> bool:
    """Verify ES256 with WebCrypto via the Python Workers JS bridge.

    Falls back to raising JwtError if the JS bridge is unavailable (e.g. unit tests
    should inject `verify_sig` instead of calling this).
    """
    try:
        from js import crypto  # type: ignore
        from pyodide.ffi import to_js  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise JwtError(
            "WebCrypto bridge unavailable; inject verify_sig in tests",
            code="no_webcrypto",
        ) from e

    # Strip non-JWK fields WebCrypto may reject; keep EC public key params.
    key_data = {k: jwk[k] for k in ("kty", "crv", "x", "y") if k in jwk}
    key_data["kty"] = key_data.get("kty") or "EC"
    key_data["crv"] = key_data.get("crv") or "P-256"

    try:
        jwk_js = to_js(key_data)
        key = await crypto.subtle.importKey(
            "jwk", jwk_js, {"name": "ECDSA", "namedCurve": "P-256"}, False, ["verify"]
        )
        ok = await crypto.subtle.verify(
            {"name": "ECDSA", "hash": "SHA-256"},
            key,
            signature,
            signing_input,
        )
        return bool(ok)
    except Exception as e:  # noqa: BLE001
        raise JwtError(f"WebCrypto verify failed: {e}", code="bad_signature") from e


async def verify_privy_jwt(
    token: str,
    app_id: str,
    *,
    cache: JwksCache | None = None,
    fetch_fn: FetchFn | None = None,
    now: float | None = None,
    verify_sig: Callable[[bytes, bytes, dict], Awaitable[bool] | bool] | None = None,
    jwk_override: dict | None = None,
) -> dict:
    """Verify a Privy access or identity token. Returns normalized claims.

    `verify_sig(signing_input, signature, jwk) -> bool` is injectable for tests.
    When omitted, uses WebCrypto via the JS FFI.
    """
    if not app_id or not isinstance(app_id, str):
        raise JwtError("PRIVY_APP_ID not configured", code="config")
    header, payload, signing_input, signature = parse_jwt_parts(token)
    # Pin algorithm to ES256 — do not trust header.alg for the crypto operation.
    # Still reject clearly-unsafe advertised algs early for clearer errors in tests.
    advertised = header.get("alg")
    if advertised is not None and advertised != PINNED_ALG:
        raise JwtError("unsupported alg", code="bad_alg")

    claims = validate_claims(payload, app_id, now=now)

    if jwk_override is not None:
        jwk = jwk_override
    else:
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise JwtError("missing kid", code="unknown_kid")
        jwks_cache = cache or JwksCache()
        try:
            jwk = await resolve_jwk(kid, app_id, jwks_cache, fetch_fn=fetch_fn)
        except JwtError as e:
            if e.code == "unknown_kid":
                # Refetch once on unknown kid (resolve_jwk already refreshes when cold).
                jwk = await resolve_jwk(kid, app_id, jwks_cache, fetch_fn=fetch_fn, force_refresh=True)
            else:
                raise

    if verify_sig is not None:
        result = verify_sig(signing_input, signature, jwk)
        ok = await result if hasattr(result, "__await__") else result
    else:
        ok = await verify_es256_webcrypto(signing_input, signature, jwk)
    if not ok:
        raise JwtError("invalid signature", code="bad_signature")
    return claims


def extract_wallet_from_identity_claims(claims: dict) -> str | None:
    """Pull an ethereum wallet from a verified identity-token payload.

    Prefers the Privy embedded wallet (wallet_client / walletClientType == 'privy'),
    matching the Privy users API fallback behavior.
    """
    linked = claims.get("linked_accounts")
    raw = claims.get("raw") if isinstance(claims.get("raw"), dict) else {}
    if linked is None:
        linked = raw.get("linked_accounts")
    # Privy sometimes stringifies linked_accounts inside the JWT.
    if isinstance(linked, str):
        try:
            linked = json.loads(linked)
        except json.JSONDecodeError:
            return None
    if not isinstance(linked, list):
        return None
    embedded = None
    external = None
    for acct in linked:
        if not isinstance(acct, dict):
            continue
        typ = (acct.get("type") or "").lower()
        addr = acct.get("address")
        if not isinstance(addr, str) or not addr.startswith("0x"):
            continue
        chain = (acct.get("chain_type") or acct.get("chainType") or "ethereum").lower()
        if chain not in ("", "ethereum", "evm"):
            continue
        client = (
            acct.get("wallet_client")
            or acct.get("walletClientType")
            or acct.get("wallet_client_type")
            or ""
        ).lower()
        if typ in ("wallet", "smart_wallet"):
            if client == "privy":
                embedded = addr
            elif external is None:
                external = addr
    return embedded or external
