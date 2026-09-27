"""Formatting helpers for Noosphere context returned to Hermes."""

from __future__ import annotations

import re

_FENCE_TAG_RE = re.compile(r"</?\s*(?:memory-context|noosphere-context)\b[^>]*>", re.IGNORECASE)
_SYSTEM_NOTE_RE = re.compile(
    r"\[System note:\s*The following is recalled memory context,\s*"
    r"NOT new user input\.[^\]]*\]\s*",
    re.IGNORECASE,
)

def clean_capture_text(text: str) -> str:
    """Discard fields containing injected context rather than saving recalled text."""
    return "" if _FENCE_TAG_RE.search(text) else strip_context_fences(text)


def strip_context_fences(text: str) -> str:
    """Remove context wrapper markup while preserving recalled memory content."""

    if not text:
        return ""
    clean = _SYSTEM_NOTE_RE.sub("", text)
    clean = _FENCE_TAG_RE.sub("", clean)
    return clean.strip()
