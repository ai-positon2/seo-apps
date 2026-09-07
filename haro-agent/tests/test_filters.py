from datetime import datetime, timezone
from pathlib import Path

from haro_agent.config import load_profiles
from haro_agent.filters import run_hard_filters
from haro_agent.identify import identify
from haro_agent.mailbox.local_fixture import load_fixture_file
from haro_agent.parser import parse_digest

ROOT = Path(__file__).resolve().parent.parent
AS_OF = datetime(2026, 8, 24, 21, 0, tzinfo=timezone.utc)


def _load_queries(filename):
    email = load_fixture_file(ROOT / "samples" / filename)
    result = identify(email)
    queries, _ = parse_digest(email.subject, result.cleaned_body, filename, as_of=AS_OF)
    return {q.query_number: q for q in queries}


def _profiles():
    profiles = load_profiles(ROOT / "config" / "profiles.example.yaml")
    return {p.id: p for p in profiles}


def test_appendix_a_worked_example_hard_filters():
    queries = _load_queries("digest_evening_normal.txt")
    profiles = _profiles()
    dental = profiles["gentle-dental-clinical"]
    behavioral = profiles["clear-behavioral-health"]

    # #1 antitrust attorney - fails for both, no roster credential matches
    assert not run_hard_filters(queries[1], dental, set()).passed
    assert not run_hard_filters(queries[1], behavioral, set()).passed

    # #9 dermatologist - fails for both
    assert not run_hard_filters(queries[9], dental, set()).passed
    assert not run_hard_filters(queries[9], behavioral, set()).passed

    # #20 iPhone/crypto - excluded by keyword for both
    result20_dental = run_hard_filters(queries[20], dental, set())
    assert not result20_dental.passed
    assert "exclusion_keyword" in result20_dental.reason

    # #11 forensic psychologist - fails dental (no psychologist on roster),
    # passes behavioral health (roster holds a licensed psychologist)
    assert not run_hard_filters(queries[11], dental, set()).passed
    assert run_hard_filters(queries[11], behavioral, set()).passed

    # #15 dental query - passes dental hard filters
    assert run_hard_filters(queries[15], dental, set()).passed


def test_duplicate_query_is_filtered():
    queries = _load_queries("digest_evening_normal.txt")
    dental = _profiles()["gentle-dental-clinical"]
    already_reported = {(dental.id, queries[15].query_id)}
    result = run_hard_filters(queries[15], dental, already_reported)
    assert not result.passed
    assert result.reason == "duplicate_already_reported"
