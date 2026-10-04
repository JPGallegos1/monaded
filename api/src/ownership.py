"""Template publish ownership checks (pure helpers for unit tests).

Ownership path: template -> material -> materials.owner_id (== users.id).
Session carries Privy DID; resolve to users.id before comparing.
"""

from __future__ import annotations


class OwnershipError(Exception):
    def __init__(self, message: str, *, code: str = "forbidden", status: int = 403):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def build_publish_uri(template: dict) -> str:
    """Server-built metadata URI — never taken from the client body."""
    tid = template.get("id") or "unknown"
    content_hash = template.get("content_hash")
    if isinstance(content_hash, str) and content_hash.strip():
        return f"ipfs://edtech-monad/{content_hash.strip()}"
    return f"ipfs://edtech-monad/{tid}"


def assert_can_publish(*, template: dict | None, material: dict | None, owner_user_id: str | None) -> dict:
    """Validate template exists, is unpublished, and material.owner_id == owner_user_id.

    `owner_user_id` is `users.id` (uuid), not the Privy DID.
    Returns the template dict on success.
    """
    if not template:
        raise OwnershipError("template not found", code="not_found", status=404)
    if template.get("is_published") is True:
        raise OwnershipError("template already published", code="already_published", status=409)
    if not material:
        raise OwnershipError("material not found", code="not_found", status=404)
    material_owner = material.get("owner_id")
    if not owner_user_id or not material_owner or str(material_owner) != str(owner_user_id):
        raise OwnershipError("not the template owner", code="forbidden", status=403)
    return template


def resolve_publish_price_floor(*, parent: dict | None = None, min_price_wei: int | None = None) -> int | None:
    """Minimum price_wei for publish, or None if unconstrained.

    Product decision (hackathon): forks may be priced freely (no parent floor).
    Keep this helper as the single place to add e.g. "fork >= parent price" later
    by reading `parent.price_mon` / onchain price into a wei floor.
    """
    if min_price_wei is not None:
        try:
            floor = int(min_price_wei)
        except (TypeError, ValueError) as e:
            raise OwnershipError("min_price_wei must be an integer", code="bad_price", status=400) from e
        if floor < 0:
            raise OwnershipError("min_price_wei must be non-negative", code="bad_price", status=400)
        return floor
    # Intentionally ignore parent for now — free-priced forks.
    _ = parent
    return None


def validate_publish_price(price_wei: int | str, *, min_price_wei: int | None = None) -> int:
    """Reject non-positive or absurd prices (relayer has limited MON).

    Optional `min_price_wei` is the single extension point for a parent-price floor.
    """
    try:
        value = int(price_wei)
    except (TypeError, ValueError) as e:
        raise OwnershipError("price_wei must be an integer", code="bad_price", status=400) from e
    if value <= 0:
        raise OwnershipError("price_wei must be positive", code="bad_price", status=400)
    if min_price_wei is not None and value < int(min_price_wei):
        raise OwnershipError("price_wei below minimum", code="bad_price", status=400)
    # Hard cap: 100 MON (testnet relayer safety)
    max_wei = 100 * 10**18
    if value > max_wei:
        raise OwnershipError("price_wei exceeds maximum", code="bad_price", status=400)
    return value


def validate_publish_uri(uri: str, *, max_len: int = 2048) -> str:
    if not isinstance(uri, str) or not uri.strip():
        raise OwnershipError("uri required", code="bad_uri", status=400)
    uri = uri.strip()
    if len(uri) > max_len:
        raise OwnershipError("uri too long", code="bad_uri", status=400)
    if any(ord(c) < 32 for c in uri):
        raise OwnershipError("uri contains control characters", code="bad_uri", status=400)
    return uri
