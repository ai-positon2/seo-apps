"""Dataclasses shared across the pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class RawEmail:
    """An email as handed back by a mailbox adapter, before HARO identification."""

    message_id: str
    sender: str
    sender_name: str
    subject: str
    received_at: datetime
    body: str


@dataclass
class Query:
    query_id: str
    digest_date: str
    digest_edition: str
    query_number: int
    summary: str
    category: Optional[str]
    journalist_name: Optional[str]
    journalist_profile_url: Optional[str]
    reply_email: Optional[str]
    media_outlet: Optional[str]
    media_outlet_url: Optional[str]
    deadline_raw: Optional[str]
    deadline_utc: Optional[datetime]
    hours_remaining: Optional[float]
    no_ai_pitches: bool
    requirements_body: str
    questions_asked: list = field(default_factory=list)
    geo_requirement: Optional[str] = None
    source_type_requested: list = field(default_factory=list)
    source_message_id: Optional[str] = None


@dataclass
class ParseFailure:
    digest_reference: str
    error: str
    raw_block: str


@dataclass
class Profile:
    id: str
    display_name: str
    client: str
    active: bool
    priority: str
    expertise_primary: list
    expertise_secondary: list
    spokespeople: list
    geography: dict
    keywords_include: list
    keywords_exclude: list
    categories_watch: list
    min_hours_to_deadline: float
    require_named_outlet: bool
    outlet_blocklist: list
    outlet_priority_list: list
    match_threshold: int
    raw: dict = field(default_factory=dict)


@dataclass
class HardFilterResult:
    passed: bool
    reason: Optional[str] = None


@dataclass
class ScoreBreakdown:
    topical_fit: int
    source_type_fit: int
    answerability: int
    outlet_value: int
    deadline_feasibility: int
    matched_signal: Optional[str]
    rationale: str

    @property
    def total(self) -> int:
        return (
            self.topical_fit
            + self.source_type_fit
            + self.answerability
            + self.outlet_value
            + self.deadline_feasibility
        )


@dataclass
class MatchResult:
    query: Query
    profile: Profile
    score: ScoreBreakdown
    tier: str  # "priority" | "qualified" | "borderline" | "discard"
    pitch_text: Optional[str] = None
    briefing_note: Optional[str] = None
