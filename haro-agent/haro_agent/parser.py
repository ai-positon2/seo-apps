"""Spec §4: split a HARO digest body into structured Query records."""
from __future__ import annotations

import hashlib
import re
from typing import List, Optional, Tuple

from .deadline import MONTHS, DeadlineParseError, hours_remaining, parse_deadline_raw
from .models import ParseFailure, Query

DELIMITER_PATTERN = re.compile(r"\n-{10,}\s*\n")

DIGEST_HEADER_PATTERN = re.compile(
    r"HARO Queries for ([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*[-–]\s*"
    r"(Morning|Afternoon|Evening) Edition",
    re.IGNORECASE,
)

QUERY_NUMBER_SUMMARY_PATTERN = re.compile(
    r"(\d+)\)\s*Summary:\s*(.+?)(?:\n|$)", re.IGNORECASE
)

FIELD_PATTERNS = {
    "category": re.compile(r"^\s*Category:\s*(.+)$", re.IGNORECASE | re.MULTILINE),
    "journalist_name": re.compile(
        r"^\s*(?:Journalist|Name):\s*(.+)$", re.IGNORECASE | re.MULTILINE
    ),
    "journalist_profile_url": re.compile(
        r"^\s*(?:Journalist Profile|Profile)\s*:\s*(\S+)$", re.IGNORECASE | re.MULTILINE
    ),
    "media_outlet": re.compile(
        r"^\s*(?:Media Outlet|Outlet):\s*(.+)$", re.IGNORECASE | re.MULTILINE
    ),
    "media_outlet_url": re.compile(
        r"^\s*(?:Outlet URL|Website)\s*:\s*(\S+)$", re.IGNORECASE | re.MULTILINE
    ),
    "deadline_raw": re.compile(r"^\s*Deadline:\s*(.+)$", re.IGNORECASE | re.MULTILINE),
}

REPLY_EMAIL_PATTERN = re.compile(r"reply\+[\w-]+@helpareporter\.com", re.IGNORECASE)
NO_AI_PITCHES_PATTERN = re.compile(r"No AI Pitches Considered", re.IGNORECASE)

GEO_MARKERS = [
    "U.S.-based", "US-based", "United States only", "North America only",
    "UK-based", "UK Based", "United Kingdom only", "Canada only",
    "must be based in the U.S.", "must be located in the United States",
]

QUESTION_LINE_PATTERN = re.compile(r"^\s*(?:\d+[\.\)]|[-*])\s+(.+)$", re.MULTILINE)

KNOWN_CREDENTIAL_TERMS = [
    "MD", "M.D.", "licensed attorney", "licensed psychologist", "dermatologist",
    "psychologist", "psychiatrist", "attorney", "lawyer", "CPA", "registered dietitian",
    "RD", "physician", "veterinarian", "financial advisor", "CFP",
]


def parse_digest_header(subject: str, body: str) -> Tuple[str, str]:
    """Return (digest_date 'YYYY-MM-DD', digest_edition) from subject (or body fallback)."""
    match = DIGEST_HEADER_PATTERN.search(subject or "") or DIGEST_HEADER_PATTERN.search(body or "")
    if not match:
        raise ValueError("Could not locate digest date/edition header in subject or body")
    month_name, day, year, edition = match.groups()
    month = MONTHS.get(month_name.lower())
    if month is None:
        raise ValueError(f"Unrecognized month name in digest header: {month_name!r}")
    digest_date = f"{int(year):04d}-{month:02d}-{int(day):02d}"
    return digest_date, edition.capitalize()


def _extract_field(pattern: re.Pattern, block: str) -> Optional[str]:
    match = pattern.search(block)
    return match.group(1).strip() if match else None


def _extract_geo_requirement(block: str) -> Optional[str]:
    for marker in GEO_MARKERS:
        if marker.lower() in block.lower():
            return marker
    return None


# Only fires on our known credential vocabulary (or "licensed X") near a trigger
# word — a generic short-word catch-all here would spuriously match substrings of
# unrelated words (e.g. "mobile" contains "bile") and wrongly hard-fail queries.
_CREDENTIAL_TERM_ALTERNATION = "|".join(
    re.escape(term) for term in sorted(KNOWN_CREDENTIAL_TERMS, key=len, reverse=True)
)
REQUIREMENT_PHRASE_PATTERN = re.compile(
    rf"\b(?:must be an?|required|only)\b[^.\n]{{0,40}}?"
    rf"\b(licensed\s+[a-z]+|{_CREDENTIAL_TERM_ALTERNATION})\b",
    re.IGNORECASE,
)


def _extract_source_type_requested(summary: str, requirements_body: str) -> List[str]:
    """Professions are conventionally named in the summary line; explicit 'X required'
    phrasing in the body is also treated as a demanded credential. This intentionally
    does not scan the whole block for incidental mentions, to avoid false hard-fails."""
    found: List[str] = []
    summary_lower = (summary or "").lower()
    for term in KNOWN_CREDENTIAL_TERMS:
        if term.lower() in summary_lower and term not in found:
            found.append(term)
    for match in REQUIREMENT_PHRASE_PATTERN.finditer(requirements_body or ""):
        phrase = match.group(1).strip()
        if phrase and phrase not in found:
            found.append(phrase)
    return found


def _extract_questions(requirements_body: str) -> List[str]:
    questions = QUESTION_LINE_PATTERN.findall(requirements_body)
    return [q.strip() for q in questions if q.strip()]


def _make_query_id(media_outlet: str, summary: str, deadline_raw: str) -> str:
    basis = f"{media_outlet or ''}|{summary or ''}|{deadline_raw or ''}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:12]


def _split_blocks(body: str) -> List[str]:
    parts = DELIMITER_PATTERN.split(body)
    return [p for p in parts if QUERY_NUMBER_SUMMARY_PATTERN.search(p)]


def parse_block(
    block: str,
    digest_date: str,
    digest_edition: str,
    digest_reference: str,
    as_of=None,
) -> Tuple[Optional[Query], Optional[ParseFailure]]:
    header_match = QUERY_NUMBER_SUMMARY_PATTERN.search(block)
    if not header_match:
        return None, ParseFailure(digest_reference, "No 'N) Summary:' header found", block)

    query_number = int(header_match.group(1))
    summary = header_match.group(2).strip()

    reply_match = REPLY_EMAIL_PATTERN.search(block)
    reply_email = reply_match.group(0) if reply_match else None

    deadline_raw = _extract_field(FIELD_PATTERNS["deadline_raw"], block)

    missing_required = []
    if not summary:
        missing_required.append("summary")
    if not reply_email:
        missing_required.append("reply_email")
    if not deadline_raw:
        missing_required.append("deadline_raw")
    if missing_required:
        return None, ParseFailure(
            digest_reference,
            f"Missing required field(s): {missing_required}",
            block,
        )

    media_outlet = _extract_field(FIELD_PATTERNS["media_outlet"], block)

    try:
        deadline_utc = parse_deadline_raw(deadline_raw, digest_date)
        hrs_remaining = hours_remaining(deadline_utc, as_of)
    except DeadlineParseError as exc:
        return None, ParseFailure(digest_reference, f"Deadline parse failed: {exc}", block)

    requirements_start = header_match.end()
    requirements_body = block[requirements_start:].strip()

    query = Query(
        query_id=_make_query_id(media_outlet, summary, deadline_raw),
        digest_date=digest_date,
        digest_edition=digest_edition,
        query_number=query_number,
        summary=summary,
        category=_extract_field(FIELD_PATTERNS["category"], block),
        journalist_name=_extract_field(FIELD_PATTERNS["journalist_name"], block),
        journalist_profile_url=_extract_field(FIELD_PATTERNS["journalist_profile_url"], block),
        reply_email=reply_email,
        media_outlet=media_outlet,
        media_outlet_url=_extract_field(FIELD_PATTERNS["media_outlet_url"], block),
        deadline_raw=deadline_raw,
        deadline_utc=deadline_utc,
        hours_remaining=hrs_remaining,
        no_ai_pitches=bool(NO_AI_PITCHES_PATTERN.search(block)),
        requirements_body=requirements_body,
        questions_asked=_extract_questions(requirements_body),
        geo_requirement=_extract_geo_requirement(block),
        source_type_requested=_extract_source_type_requested(summary, requirements_body),
    )
    return query, None


def parse_digest(
    subject: str,
    body: str,
    digest_reference: str,
    as_of=None,
) -> Tuple[List[Query], List[ParseFailure]]:
    digest_date, digest_edition = parse_digest_header(subject, body)
    blocks = _split_blocks(body)

    queries: List[Query] = []
    failures: List[ParseFailure] = []
    for block in blocks:
        query, failure = parse_block(block, digest_date, digest_edition, digest_reference, as_of)
        if query:
            queries.append(query)
        if failure:
            failures.append(failure)
    return queries, failures
