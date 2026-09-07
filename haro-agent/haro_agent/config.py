"""Loads expert profiles (YAML, spec §5) and run settings."""
from __future__ import annotations

from pathlib import Path
from typing import List

import yaml

from .models import Profile

REQUIRED_PROFILE_FIELDS = [
    "id",
    "display_name",
    "expertise",
    "geography",
    "keywords_include",
    "hard_rules",
    "match_threshold",
]


class ProfileConfigError(ValueError):
    pass


def _validate_raw_profile(raw: dict) -> None:
    missing = [f for f in REQUIRED_PROFILE_FIELDS if f not in raw]
    if missing:
        raise ProfileConfigError(
            f"Profile '{raw.get('id', '<unknown>')}' is missing required field(s): {missing}"
        )
    if "min_hours_to_deadline" not in raw.get("hard_rules", {}):
        raise ProfileConfigError(
            f"Profile '{raw['id']}' hard_rules must define min_hours_to_deadline"
        )


def _to_profile(raw: dict) -> Profile:
    _validate_raw_profile(raw)
    expertise = raw.get("expertise", {})
    hard_rules = raw.get("hard_rules", {})
    return Profile(
        id=raw["id"],
        display_name=raw["display_name"],
        client=raw.get("client", raw["display_name"]),
        active=raw.get("active", True),
        priority=raw.get("priority", "normal"),
        expertise_primary=expertise.get("primary", []),
        expertise_secondary=expertise.get("secondary", []),
        spokespeople=raw.get("spokespeople", []),
        geography=raw.get("geography", {}),
        keywords_include=raw.get("keywords_include", []),
        keywords_exclude=raw.get("keywords_exclude", []),
        categories_watch=raw.get("categories_watch", []),
        min_hours_to_deadline=hard_rules.get("min_hours_to_deadline", 0),
        require_named_outlet=hard_rules.get("require_named_outlet", False),
        outlet_blocklist=hard_rules.get("outlet_blocklist", []),
        outlet_priority_list=hard_rules.get("outlet_priority_list", []),
        match_threshold=raw["match_threshold"],
        raw=raw,
    )


def load_profiles(path: str | Path, active_only: bool = True) -> List[Profile]:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Profile config not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    raw_profiles = data.get("profiles", [])
    if not raw_profiles:
        raise ProfileConfigError(f"No profiles defined in {path}")
    profiles = [_to_profile(p) for p in raw_profiles]
    if active_only:
        profiles = [p for p in profiles if p.active]
    if not profiles:
        raise ProfileConfigError(f"No active profiles in {path}")
    return profiles


def load_settings(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}
