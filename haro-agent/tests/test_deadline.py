from datetime import datetime, timezone

from haro_agent.deadline import hours_remaining, parse_deadline_raw


def test_parses_deadline_in_same_year_edt():
    dt = parse_deadline_raw("1:30 PM ET - 27 August", "2026-08-24")
    assert dt == datetime(2026, 8, 27, 17, 30, tzinfo=timezone.utc)


def test_rolls_year_forward_when_deadline_month_precedes_digest_month():
    dt = parse_deadline_raw("10:00 AM ET - 4 January", "2026-12-28")
    assert dt.year == 2027
    assert dt.month == 1
    assert dt.day == 4


def test_hours_remaining_with_explicit_as_of():
    deadline = datetime(2026, 8, 27, 17, 30, tzinfo=timezone.utc)
    as_of = datetime(2026, 8, 24, 17, 30, tzinfo=timezone.utc)
    assert hours_remaining(deadline, as_of) == 72.0


def test_hours_remaining_negative_when_passed():
    deadline = datetime(2026, 8, 20, 0, 0, tzinfo=timezone.utc)
    as_of = datetime(2026, 8, 24, 0, 0, tzinfo=timezone.utc)
    assert hours_remaining(deadline, as_of) < 0
