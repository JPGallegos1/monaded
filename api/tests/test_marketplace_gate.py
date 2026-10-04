"""Unit tests for content gating, allowlists, fork builders, and fork rate-limit caps."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from fork import ForkError, build_fork_rows  # noqa: E402
from license_check import (  # noqa: E402
    OWNER_TEMPLATE_FIELDS,
    PUBLIC_TEMPLATE_FIELDS,
    build_preview_content,
    decode_bool_result,
    encode_has_license_call,
    public_template_view,
)
from publish import (  # noqa: E402
    GLOBAL_PUBLISH_LIMIT,
    PUBLISH_LIMIT,
    PublishError,
    check_rate_limit,
)


def test_encode_has_license_selector_and_padding():
    data = encode_has_license_call("0x1111111111111111111111111111111111111111", 1)
    assert data.startswith("0xe3b461d9")
    assert len(data) == 2 + 8 + 64 + 64


def test_decode_bool_result():
    assert decode_bool_result("0x" + "0" * 63 + "1") is True
    assert decode_bool_result("0x" + "0" * 64) is False
    assert decode_bool_result("0x0") is False


def test_preview_strips_full_content():
    content = {
        "title": "T",
        "summary": "S",
        "learning_objectives": ["a"],
        "sections": [{"heading": "H", "explanation": "secret", "key_concepts": []}],
        "definitions": [{"term": "x", "definition": "y"}],
        "worked_examples": [{"title": "e", "problem": "p", "steps": [], "answer": "42"}],
        "practice_questions": [
            {
                "question": "q",
                "type": "short_answer",
                "choices": [],
                "answer": "a",
                "explanation": "e",
            }
        ],
        "diagrams": [],
    }
    preview = build_preview_content(content)
    assert preview["summary"] == "S"
    assert preview["sections"] == []
    assert preview["practice_questions"] == []
    assert preview["worked_examples"] == []


def test_public_template_view_allowlists_and_strips_private_fields():
    row = {
        "id": "t1",
        "title": "T",
        "description": "d",
        "price_mon": 0.01,
        "is_published": True,
        "onchain_token_id": "3",
        "parent_template_id": "parent",
        "publish_tx_hash": "0xabc",
        "publish_claimed_at": "2026-10-04T00:00:00Z",
        "content_r2_key": "secret/key",
        "error": "generation blew up",
        "content": {
            "title": "T",
            "summary": "S",
            "learning_objectives": [],
            "sections": [{"heading": "H", "explanation": "x", "key_concepts": []}],
            "definitions": [],
            "worked_examples": [],
            "practice_questions": [],
            "diagrams": [],
        },
        "generation": {"model": "m", "usage": {"secret": 1}, "generate_ms": 10},
    }
    gated = public_template_view(row, include_full_content=False)
    assert set(gated.keys()) <= set(PUBLIC_TEMPLATE_FIELDS) | {"content", "generation"}
    assert "publish_claimed_at" not in gated
    assert "content_r2_key" not in gated
    assert "error" not in gated
    assert gated["content"]["sections"] == []
    assert "usage" not in gated["generation"]

    full = public_template_view(row, include_full_content=True)
    assert "publish_claimed_at" not in full
    assert "content_r2_key" not in full
    assert full["content"]["sections"]
    assert "error" in full  # owner may see generation error
    assert set(full.keys()) <= set(OWNER_TEMPLATE_FIELDS) | {"content", "generation"}


def test_build_fork_rows_sets_parent():
    parent = {
        "id": "parent-uuid",
        "title": "Original",
        "description": "desc",
        "is_published": True,
        "onchain_token_id": "1",
        "content": {"title": "Original", "summary": "S"},
        "content_hash": "abc",
    }
    material, template = build_fork_rows(parent=parent, owner_user_id="user-1", title="My fork")
    assert material["owner_id"] == "user-1"
    assert template["parent_template_id"] == "parent-uuid"
    assert template["is_published"] is False
    assert template["title"] == "My fork"
    assert template["content"]["title"] == "My fork"


def test_build_fork_rejects_unpublished():
    with pytest.raises(ForkError) as ei:
        build_fork_rows(
            parent={"id": "p", "is_published": False, "onchain_token_id": "1"},
            owner_user_id="u1",
        )
    assert ei.value.code == "not_published"


def test_fork_rate_limit_uses_same_publish_caps():
    """Fork shares publish per-user + global caps (entry.fork_template calls the same DO check)."""
    hist: list[int] = []
    now = 1_700_000_000
    for _ in range(PUBLISH_LIMIT):
        hist = check_rate_limit(hist, now=now, limit=PUBLISH_LIMIT, window=3600)
        now += 1
    with pytest.raises(PublishError) as ei:
        check_rate_limit(hist, now=now, limit=PUBLISH_LIMIT, window=3600)
    assert ei.value.code == "rate_limited"

    ghist: list[int] = []
    now = 1_700_000_000
    for _ in range(GLOBAL_PUBLISH_LIMIT):
        ghist = check_rate_limit(ghist, now=now, limit=GLOBAL_PUBLISH_LIMIT, window=3600)
        now += 1
    with pytest.raises(PublishError) as ei:
        check_rate_limit(ghist, now=now, limit=GLOBAL_PUBLISH_LIMIT, window=3600)
    assert ei.value.code == "rate_limited"


def test_entry_fork_invokes_publish_rate_limits():
    """Source guard: fork_template must call _check_publish_rate_limits before inserts."""
    src = (Path(__file__).resolve().parents[1] / "src" / "entry.py").read_text(encoding="utf-8")
    start = src.index("async def fork_template")
    marker = "\n# Re-export DO classes"
    fork_src = src[start : src.index(marker, start)] if marker in src[start:] else src[start : start + 2500]
    assert "_check_publish_rate_limits" in fork_src
    assert fork_src.index("_check_publish_rate_limits") < fork_src.index('insert("materials"')
