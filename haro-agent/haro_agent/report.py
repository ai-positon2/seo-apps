"""Spec §7: render the Markdown match report for one run."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

from .deadline import to_et
from .models import MatchResult

TIER_EMOJI = {"priority": "\U0001F534", "qualified": "\U0001F7E1"}
TIER_TITLE = {"priority": "Priority — Act Today", "qualified": "Qualified"}


@dataclass
class RunSummary:
    digest_date: str
    digest_edition: str
    run_time_ist: datetime
    digests_processed: int
    queries_parsed: int
    discarded_count: int
    parse_failure_count: int
    skipped_already_processed: int
    matches: List[MatchResult] = field(default_factory=list)


def _format_deadline(query) -> str:
    if query.deadline_utc is None:
        return query.deadline_raw or "unknown"
    et = to_et(query.deadline_utc)
    return et.strftime("%B %d, %Y, %I:%M %p ET").replace(" 0", " ")


def _hours_label(hours: Optional[float]) -> str:
    if hours is None:
        return "unknown time remaining"
    return f"{hours:.0f} hours remaining" if hours >= 0 else "deadline passed"


def _render_full_match(index: int, match: MatchResult) -> str:
    q = match.query
    lines = [f"### {index}. {q.summary}"]
    lines.append(f"- **Outlet:** {q.media_outlet or 'unknown'}")
    lines.append(f"- **Journalist:** {q.journalist_name or 'unknown'}")
    lines.append(f"- **Deadline:** {_format_deadline(q)} · **{_hours_label(q.hours_remaining)}**")
    lines.append(f"- **Reply to:** {q.reply_email or 'unknown'}")
    lines.append(f"- **Match score:** {match.score.total} — {match.tier.capitalize()}")
    lines.append(f"- **Profile matched:** {match.profile.display_name}")
    if q.no_ai_pitches:
        lines.append("- ⚠️ **No AI pitches considered**")
    lines.append("")
    lines.append(f"**Why this matches:** {match.score.rationale}")
    lines.append("")
    if q.questions_asked:
        lines.append("**What the journalist needs:**")
        for i, question in enumerate(q.questions_asked, start=1):
            lines.append(f"{i}. {question}")
        lines.append("")
    if q.no_ai_pitches:
        lines.append("**Briefing note (human writes the pitch):**")
        lines.append("")
        lines.append(match.briefing_note or "_(briefing note unavailable)_")
    elif match.pitch_text:
        lines.append("**Draft pitch:**")
        lines.append("")
        lines.append(match.pitch_text)
    lines.append("")
    return "\n".join(lines)


def _render_borderline_line(match: MatchResult) -> str:
    q = match.query
    return (
        f"- **#{q.query_number} {q.summary}** ({q.media_outlet or 'unknown outlet'}, "
        f"{_format_deadline(q)}) — score {match.score.total}. {match.score.rationale}"
    )


def render_report(summary: RunSummary) -> str:
    matches_by_tier = {"priority": [], "qualified": [], "borderline": []}
    for m in summary.matches:
        if m.tier in matches_by_tier:
            matches_by_tier[m.tier].append(m)
    for tier_matches in matches_by_tier.values():
        tier_matches.sort(key=lambda m: (m.query.hours_remaining if m.query.hours_remaining is not None else float("inf")))

    total_surfaced = sum(len(v) for v in matches_by_tier.values())
    header_date = f"{summary.digest_date} ({summary.digest_edition} Edition)"
    run_time_str = summary.run_time_ist.strftime("%I:%M %p IST").lstrip("0")

    if total_surfaced == 0:
        return (
            f"# HARO Match Report — {header_date}\n\n"
            f"**Digests processed:** {summary.digests_processed} · "
            f"**Queries parsed:** {summary.queries_parsed} · **Matches:** 0\n"
            f"**Run time:** {run_time_str}\n\n"
            f"No relevant opportunities found this run. "
            f"({summary.discarded_count} discarded below threshold, "
            f"{summary.parse_failure_count} parse failures, "
            f"{summary.skipped_already_processed} already processed.)\n"
        )

    lines = [
        f"# HARO Match Report — {header_date}",
        "",
        f"**Digests processed:** {summary.digests_processed} · "
        f"**Queries parsed:** {summary.queries_parsed} · "
        f"**Matches:** {len(matches_by_tier['priority']) + len(matches_by_tier['qualified'])} · "
        f"**Borderline:** {len(matches_by_tier['borderline'])}",
        f"**Run time:** {run_time_str}",
        "",
        "---",
        "",
    ]

    for tier in ("priority", "qualified"):
        tier_matches = matches_by_tier[tier]
        if not tier_matches:
            continue
        lines.append(f"## {TIER_EMOJI[tier]} {TIER_TITLE[tier]}")
        lines.append("")
        for i, match in enumerate(tier_matches, start=1):
            lines.append(_render_full_match(i, match))
        lines.append("---")
        lines.append("")

    if matches_by_tier["borderline"]:
        lines.append("## ⚪ Borderline — Your Call")
        lines.append("")
        for match in matches_by_tier["borderline"]:
            lines.append(_render_borderline_line(match))
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.append("## Run Log")
    lines.append(f"- Queries discarded: {summary.discarded_count} (below threshold)")
    lines.append(f"- Parse failures: {summary.parse_failure_count}")
    lines.append(f"- Skipped as already processed: {summary.skipped_already_processed}")
    lines.append("")

    return "\n".join(lines)
