"""Spec §3: decide whether a raw email is a HARO digest, and strip forwarding wrappers."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List

from .models import RawEmail

SUBJECT_PATTERN = re.compile(
    r"HARO Queries for .+?,\s*\d{4}\s*[-–]\s*(Morning|Afternoon|Evening) Edition",
    re.IGNORECASE,
)
INDEX_MARKER_PATTERN = re.compile(r"\*{5,}\s*INDEX\s*\*{5,}", re.IGNORECASE)
SUMMARY_BLOCK_PATTERN = re.compile(r"^\s*\d+\)\s*Summary\s*:", re.IGNORECASE | re.MULTILINE)

DEFAULT_KNOWN_HARO_SUBSCRIPTION_ADDRESSES = [
    "nikhil.ashok@position2.com",
]

FORWARDED_HEADER_LINE = re.compile(
    r"^-{4,}\s*Forwarded message\s*-{4,}\s*$", re.IGNORECASE | re.MULTILINE
)
OUTLOOK_FORWARD_BLOCK = re.compile(
    r"^From:.*$\n^Sent:.*$\n^To:.*$\n(?:^Cc:.*$\n)?^Subject:.*$",
    re.IGNORECASE | re.MULTILINE,
)
QUOTE_PREFIX = re.compile(r"^>+\s?", re.MULTILINE)


@dataclass
class IdentificationResult:
    is_digest: bool
    reason: str
    cleaned_body: str = ""


def strip_forwarding_wrappers(body: str) -> str:
    """Remove '---------- Forwarded message ---------', Outlook From/Sent/To/Subject
    blocks, and quoted '>' prefixes so the parser sees the underlying HARO body."""
    cleaned = FORWARDED_HEADER_LINE.sub("", body)
    cleaned = OUTLOOK_FORWARD_BLOCK.sub("", cleaned)
    cleaned = QUOTE_PREFIX.sub("", cleaned)
    return cleaned


def _sender_check(email: RawEmail, raw_body: str, known_subscription_addresses: List[str]) -> bool:
    """Sender check per spec §3: envelope From contains helpareporter.com, display
    name is HARO, or a known HARO subscription address shows up in a forwarded-from
    header. Manual forwards embed the original headers/addresses in the body, so we
    scan the raw (pre-cleaning) body for both signals too."""
    sender = (email.sender or "").lower()
    sender_name = (email.sender_name or "").strip().lower()
    if "helpareporter.com" in sender:
        return True
    if sender_name == "haro":
        return True
    body_lower = raw_body.lower()
    if "helpareporter.com" in body_lower:
        return True
    return any(addr.lower() in body_lower for addr in known_subscription_addresses)


def _structural_check(subject: str, cleaned_body: str) -> List[str]:
    hits = []
    if SUBJECT_PATTERN.search(subject or "") or SUBJECT_PATTERN.search(cleaned_body):
        hits.append("subject_pattern")
    if INDEX_MARKER_PATTERN.search(cleaned_body):
        hits.append("index_marker")
    summary_blocks = SUMMARY_BLOCK_PATTERN.findall(cleaned_body)
    if len(summary_blocks) >= 3:
        hits.append(f"summary_blocks({len(summary_blocks)})")
    return hits


def identify(
    email: RawEmail,
    known_subscription_addresses: List[str] | None = None,
) -> IdentificationResult:
    known_subscription_addresses = (
        known_subscription_addresses
        if known_subscription_addresses is not None
        else DEFAULT_KNOWN_HARO_SUBSCRIPTION_ADDRESSES
    )

    cleaned_body = strip_forwarding_wrappers(email.body)

    if not _sender_check(email, email.body, known_subscription_addresses):
        return IdentificationResult(False, "sender_check_failed", cleaned_body)

    struct_hits = _structural_check(email.subject, cleaned_body)
    if not struct_hits:
        return IdentificationResult(False, "skipped_non_digest", cleaned_body)

    return IdentificationResult(True, "matched:" + ",".join(struct_hits), cleaned_body)
