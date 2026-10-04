"""Unit tests for content gating, hasLicense encoding, and fork row builders."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from fork import ForkError, build_fork_rows  # noqa: E402
from license_check import (  # noqa: E402
    build_preview_content,
    decode_bool_result,
    encode_has_license_call,
    public_template_view,
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


def test_public_template_view_gates_content():
    row = {
        "id": "t1",
        "title": "T",
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
    assert gated["content"]["sections"] == []
    assert "usage" not in gated["generation"]
    full = public_template_view(row, include_full_content=True)
    assert full["content"]["sections"]


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
