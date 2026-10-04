"""Create a draft fork of a published template (DB lineage for publish parentId)."""

from __future__ import annotations

import copy
import time
import uuid


class ForkError(Exception):
    def __init__(self, message: str, *, code: str = "fork_failed", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def build_fork_rows(
    *,
    parent: dict,
    owner_user_id: str,
    title: str | None = None,
) -> tuple[dict, dict]:
    """Return (material_row, template_row) for inserting a fork draft.

    The forker must already be allowed to fork (license or owner) — checked by the handler.
    parent_template_id is set so publish (PR #3) can derive onchain parentId from the DB.
    """
    if not parent:
        raise ForkError("parent template not found", code="not_found", status=404)
    if parent.get("is_published") is not True:
        raise ForkError("can only fork published templates", code="not_published", status=400)
    if parent.get("onchain_token_id") is None or str(parent.get("onchain_token_id")).strip() == "":
        raise ForkError("parent has no onchain_token_id", code="not_onchain", status=400)
    if not owner_user_id:
        raise ForkError("owner required", code="forbidden", status=403)

    material_id = str(uuid.uuid4())
    template_id = str(uuid.uuid4())
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    parent_title = parent.get("title") or "Template"
    fork_title = (title or f"{parent_title} (fork)")[:300]

    content = parent.get("content")
    content_copy = copy.deepcopy(content) if isinstance(content, dict) else None
    if isinstance(content_copy, dict) and content_copy.get("title"):
        content_copy["title"] = fork_title

    material = {
        "id": material_id,
        "title": fork_title[:300],
        "owner_id": owner_user_id,
        "r2_key": f"forks/{material_id}/placeholder",
        "original_filename": "fork.json",
        "status": "ready",
    }

    template = {
        "id": template_id,
        "title": fork_title,
        "description": parent.get("description"),
        "material_id": material_id,
        "parent_template_id": parent["id"],
        "content": content_copy,
        "content_hash": parent.get("content_hash"),
        "status": "ready",
        "is_published": False,
        "updated_at": now,
    }
    return material, template
