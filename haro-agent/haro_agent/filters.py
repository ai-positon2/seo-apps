"""Spec §6 Stage 1: cheap pass/fail hard filters, run before any scoring."""
from __future__ import annotations

from typing import List

from .models import HardFilterResult, Profile, Query

# Maps a profession/credential term that might appear in a query's
# source_type_requested to the synonym strings we'd expect to find in a
# profile's spokespeople credentials/titles or expertise lists.
CREDENTIAL_SYNONYMS = {
    "md": ["md", "m.d.", "physician", "doctor of medicine"],
    "m.d.": ["md", "m.d.", "physician"],
    "physician": ["md", "m.d.", "physician", "do"],
    "dermatologist": ["dermatolog"],
    "psychologist": ["psychologist", "phd", "psyd"],
    "psychiatrist": ["psychiatrist", "md"],
    "attorney": ["attorney", "esq", "jd", "lawyer"],
    "lawyer": ["attorney", "esq", "jd", "lawyer"],
    "cpa": ["cpa", "accountant"],
    "registered dietitian": ["rd", "registered dietitian", "dietitian"],
    "rd": ["rd", "registered dietitian", "dietitian"],
    "veterinarian": ["dvm", "veterinarian"],
    "financial advisor": ["cfp", "financial advisor"],
    "cfp": ["cfp", "financial advisor"],
}

GEO_MARKER_TO_COUNTRY = {
    "u.s.-based": "US", "us-based": "US", "united states only": "US",
    "north america only": "US",
    "uk-based": "UK", "uk based": "UK", "united kingdom only": "UK",
    "canada only": "CA",
}


def _profile_credential_text(profile: Profile) -> str:
    parts = []
    for person in profile.spokespeople:
        parts.append(str(person.get("credentials", "")))
        parts.append(str(person.get("title", "")))
    parts.extend(profile.expertise_primary)
    parts.extend(profile.expertise_secondary)
    return " | ".join(parts).lower()


def check_deadline(query: Query, profile: Profile) -> HardFilterResult:
    if query.hours_remaining is None:
        return HardFilterResult(False, "deadline_unparseable")
    if query.hours_remaining < 0:
        return HardFilterResult(False, "deadline_already_passed")
    if query.hours_remaining < profile.min_hours_to_deadline:
        return HardFilterResult(
            False,
            f"insufficient_time({query.hours_remaining}h < {profile.min_hours_to_deadline}h)",
        )
    return HardFilterResult(True)


def check_geography(query: Query, profile: Profile) -> HardFilterResult:
    if not query.geo_requirement:
        return HardFilterResult(True)
    required_country = GEO_MARKER_TO_COUNTRY.get(query.geo_requirement.lower())
    if required_country is None:
        return HardFilterResult(True)
    profile_country = (profile.geography or {}).get("country")
    if profile_country and profile_country.upper() == required_country:
        return HardFilterResult(True)
    return HardFilterResult(
        False, f"geo_mismatch(requires {required_country}, profile is {profile_country})"
    )


def check_source_type(query: Query, profile: Profile) -> HardFilterResult:
    if not query.source_type_requested:
        return HardFilterResult(True)
    profile_text = _profile_credential_text(profile)
    for term in query.source_type_requested:
        synonyms = CREDENTIAL_SYNONYMS.get(term.lower(), [term.lower()])
        if any(syn in profile_text for syn in synonyms):
            return HardFilterResult(True)
    return HardFilterResult(
        False, f"credential_mismatch(requires one of {query.source_type_requested})"
    )


def check_exclusion_keywords(query: Query, profile: Profile) -> HardFilterResult:
    haystack = f"{query.summary} {query.requirements_body}".lower()
    for term in profile.keywords_exclude:
        if term.lower() in haystack:
            return HardFilterResult(False, f"exclusion_keyword({term})")
    return HardFilterResult(True)


def check_outlet_blocklist(query: Query, profile: Profile) -> HardFilterResult:
    if not query.media_outlet:
        return HardFilterResult(True)
    outlet_lower = query.media_outlet.lower()
    for blocked in profile.outlet_blocklist:
        if blocked.lower() == outlet_lower:
            return HardFilterResult(False, f"outlet_blocklisted({blocked})")
    return HardFilterResult(True)


def check_duplicate(query: Query, profile: Profile, already_reported_ids: set) -> HardFilterResult:
    if (profile.id, query.query_id) in already_reported_ids:
        return HardFilterResult(False, "duplicate_already_reported")
    return HardFilterResult(True)


HARD_FILTERS = [
    check_deadline,
    check_geography,
    check_source_type,
    check_exclusion_keywords,
    check_outlet_blocklist,
]


def run_hard_filters(
    query: Query, profile: Profile, already_reported_ids: set
) -> HardFilterResult:
    for filter_fn in HARD_FILTERS:
        result = filter_fn(query, profile)
        if not result.passed:
            return result
    return check_duplicate(query, profile, already_reported_ids)
