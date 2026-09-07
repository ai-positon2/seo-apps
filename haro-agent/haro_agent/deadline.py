"""Deadline parsing/conversion: ET -> UTC -> IST, with year inference (spec §4)."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
IST = ZoneInfo("Asia/Kolkata")

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

DEADLINE_PATTERN = re.compile(
    r"(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*ET\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)"
)


class DeadlineParseError(ValueError):
    pass


def parse_deadline_raw(deadline_raw: str, digest_date: str) -> datetime:
    """Parse e.g. '1:30 PM ET - 31 July' with year inferred from digest_date
    ('YYYY-MM-DD'), returning a UTC-aware datetime."""
    match = DEADLINE_PATTERN.search(deadline_raw or "")
    if not match:
        raise DeadlineParseError(f"Could not parse deadline: {deadline_raw!r}")

    hour, minute, ampm, day, month_name = match.groups()
    hour = int(hour)
    minute = int(minute)
    day = int(day)
    month = MONTHS.get(month_name.lower())
    if month is None:
        raise DeadlineParseError(f"Unrecognized month name in deadline: {month_name!r}")

    if ampm.lower() == "pm" and hour != 12:
        hour += 12
    if ampm.lower() == "am" and hour == 12:
        hour = 0

    digest_dt = datetime.strptime(digest_date, "%Y-%m-%d")
    year = digest_dt.year
    if month < digest_dt.month:
        year += 1

    local_naive = datetime(year, month, day, hour, minute)
    local_aware = local_naive.replace(tzinfo=EASTERN)
    return local_aware.astimezone(timezone.utc)


def hours_remaining(deadline_utc: datetime, as_of: Optional[datetime] = None) -> float:
    as_of = as_of or datetime.now(timezone.utc)
    if as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=timezone.utc)
    delta = deadline_utc - as_of
    return round(delta.total_seconds() / 3600, 1)


def to_ist(dt_utc: datetime) -> datetime:
    return dt_utc.astimezone(IST)


def to_et(dt_utc: datetime) -> datetime:
    return dt_utc.astimezone(EASTERN)
