"""Resolve purchase template UUID <-> onchain_template_id from the database.

Never trust a client-supplied mapping between the two.
"""

from __future__ import annotations

from purchase import PurchaseError


async def resolve_template_for_purchase(sb, *, template_id=None, onchain_template_id=None) -> dict:
    """Load the template row using DB as source of truth for the UUID/onchain mapping.

    Accepts either `template_id` (uuid) or `onchain_template_id` (int/str).
    If both are provided, they must agree with the DB row.
    """
    tpl = None
    if isinstance(template_id, str) and template_id.strip():
        tpl = await sb.get("templates", template_id.strip())
        if not tpl:
            raise PurchaseError("template not found", code="not_found")
        db_onchain = tpl.get("onchain_token_id")
        if db_onchain is None or str(db_onchain).strip() == "":
            raise PurchaseError("template has no onchain_token_id", code="not_onchain")
        if onchain_template_id is not None and str(int(onchain_template_id)) != str(db_onchain).strip():
            raise PurchaseError("template_id / onchain_template_id mismatch", code="id_mismatch")
        return tpl

    if onchain_template_id is not None:
        try:
            onchain_str = str(int(onchain_template_id))
        except (TypeError, ValueError) as e:
            raise PurchaseError("onchain_template_id must be an integer", code="bad_onchain_id") from e
        tpl = await sb.get_by("templates", "onchain_token_id", onchain_str)
        if not tpl:
            raise PurchaseError("template not found for onchain_template_id", code="not_found")
        return tpl

    raise PurchaseError("template_id or onchain_template_id is required", code="missing_id")


def onchain_id_from_template(template: dict) -> int:
    raw = template.get("onchain_token_id")
    try:
        return int(raw)
    except (TypeError, ValueError) as e:
        raise PurchaseError("template has invalid onchain_token_id", code="not_onchain") from e
