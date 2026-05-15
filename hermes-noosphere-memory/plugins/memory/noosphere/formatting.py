"""Formatting helpers for Noosphere context returned to Hermes."""

from __future__ import annotations

import re

_FENCE_TAG_RE = re.compile(r"</?\s*(?:memory-context|noosphere-context)\s*>", re.IGNORECASE)
_SYSTEM_NOTE_RE = re.compile(
    r"\[System note:\s*The following is recalled memory context,\s*"
    r"NOT new user input\.[^\]]*\]\s*",
    re.IGNORECASE,
)


def strip_context_fences(text: str) -> str:
    """Remove context wrapper markup while preserving recalled memory content."""

    if not text:
        return ""
    clean = _SYSTEM_NOTE_RE.sub("", text)
    clean = _FENCE_TAG_RE.sub("", clean)
    return clean.strip()
