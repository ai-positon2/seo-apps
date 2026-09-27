from datetime import datetime, timezone
from pathlib import Path

import pytest

from haro_agent.identify import identify
from haro_agent.mailbox.local_fixture import load_fixture_file
from haro_agent.parser import parse_digest, parse_digest_header

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"
AS_OF = datetime(2026, 8, 24, 21, 0, tzinfo=timezone.utc)


def _parse_fixture(filename):
    email = load_fixture_file(SAMPLES_DIR / filename)
    result = identify(email)
    assert result.is_digest, f"{filename} was not identified as a digest ({result.reason})"
    return parse_digest(email.subject, result.cleaned_body, digest_reference=filename, as_of=AS_OF)


def test_normal_digest_parses_all_six_queries_with_no_failures():
    queries, failures = _parse_fixture("digest_evening_normal.txt")
    assert failures == []
    assert sorted(q.query_number for q in queries) == [1, 8, 9, 11, 15, 20]


def test_dermatologist_query_fields_match_schema():
    queries, _ = _parse_fixture("digest_evening_normal.txt")
    q9 = next(q for q in queries if q.query_number == 9)
    assert q9.digest_date == "2026-08-24"
    assert q9.digest_edition == "Evening"
    assert q9.journalist_name == "Kayla Becker"
    assert q9.media_outlet == "Travel + Leisure"
    assert q9.reply_email == "reply+ccc33333cccc@helpareporter.com"
    assert q9.no_ai_pitches is False
    assert q9.geo_requirement == "U.S.-based"
    assert "dermatologist" in q9.source_type_requested
    assert q9.hours_remaining is not None and q9.hours_remaining > 0
    assert len(q9.questions_asked) >= 3


def test_no_ai_pitches_flag_captured():
    queries, _ = _parse_fixture("digest_evening_normal.txt")
    q8 = next(q for q in queries if q.query_number == 8)
    assert q8.no_ai_pitches is True


def test_query_id_is_stable_hash():
    queries, _ = _parse_fixture("digest_evening_normal.txt")
    q9 = next(q for q in queries if q.query_number == 9)
    assert len(q9.query_id) == 12
    queries_again, _ = _parse_fixture("digest_evening_normal.txt")
    q9_again = next(q for q in queries_again if q.query_number == 9)
    assert q9.query_id == q9_again.query_id


def test_no_ai_pitch_digest_parses_three_queries():
    queries, failures = _parse_fixture("digest_no_ai_pitch.txt")
    assert failures == []
    assert len(queries) == 3
    dental_query = next(q for q in queries if q.query_number == 1)
    assert dental_query.no_ai_pitches is True


def test_forwarded_digest_strips_wrapper_and_logs_one_parse_failure():
    queries, failures = _parse_fixture("digest_forwarded_malformed.txt")
    assert sorted(q.query_number for q in queries) == [1, 2, 4]
    assert len(failures) == 1
    assert failures[0].raw_block.strip().startswith("3)") or "3)" in failures[0].raw_block
    # forwarding wrapper artifacts should not leak into parsed fields
    q1 = next(q for q in queries if q.query_number == 1)
    assert not q1.summary.startswith(">")
    assert q1.journalist_name == "Ben Ostrow"


def test_digest_header_raises_when_no_pattern_and_no_received_at():
    with pytest.raises(ValueError):
        parse_digest_header("no header here", "no header here either")


def test_digest_header_falls_back_to_received_at():
    """Regression: a genuine Gmail auto-forward (via a filter's 'Forward it'
    action) doesn't preserve 'HARO Queries for <date> - <edition> Edition' in
    either the subject or body the way a manual 'Fwd:' compose does. Confirmed
    in production - two real auto-forwarded digests both parsed zero queries
    because this raised ValueError, aborting the whole digest."""
    received_at = datetime(2026, 9, 25, 20, 8, tzinfo=timezone.utc)  # 4:08 PM ET
    digest_date, edition = parse_digest_header("", "", received_at=received_at)
    assert digest_date == "2026-09-25"
    assert edition == "Evening"


def test_full_digest_parses_via_received_at_fallback_when_header_is_missing():
    body = (
        "********* INDEX ***********\n\n"
        "1) Summary: test query with no header text anywhere\n"
        "Category: Health and Pharma\n"
        "Name: Test Journalist\n"
        "Media Outlet: Verywell Health\n"
        "Deadline: 1:30 PM ET - 27 September\n\n"
        "Requirements: U.S.-based only.\n"
        "Reply to: reply+regressiontest@helpareporter.com\n"
    )
    queries, failures = parse_digest(
        subject="",
        body=body,
        digest_reference="test",
        as_of=AS_OF,
        received_at=datetime(2026, 9, 25, 14, 0, tzinfo=timezone.utc),
    )
    assert failures == []
    assert len(queries) == 1
    assert queries[0].digest_date == "2026-09-25"
