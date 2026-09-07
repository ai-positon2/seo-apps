"""Spec §8: draft a pitch for matches >=70, or a briefing note when the journalist
has set 'No AI Pitches Considered'. Never auto-sends anything."""
from __future__ import annotations

from .models import Profile, Query

PITCH_SCHEMA = {
    "type": "object",
    "properties": {
        "pitch_text": {
            "type": "string",
            "description": (
                "The full pitch, under 250 words unless the query demands more. Opens "
                "with the specific query, answers each question in the order asked and "
                "in the format asked, includes spokesperson name/credentials/title/"
                "company/location, contains no fabricated statistics/anecdotes/quotes, "
                "and ends with one or more [NEEDS SPOKESPERSON INPUT: ...] placeholders "
                "for anything only a human can supply."
            ),
        },
    },
    "required": ["pitch_text"],
}

BRIEFING_SCHEMA = {
    "type": "object",
    "properties": {
        "briefing_note": {
            "type": "string",
            "description": (
                "A human briefing note (not a send-ready pitch): the questions asked, "
                "the angle, suggested talking points, and a word-count target. Material "
                "for a human to write the actual pitch from."
            ),
        },
    },
    "required": ["briefing_note"],
}

PITCH_SYSTEM_PROMPT = """You draft HARO pitch responses for a digital PR team. You \
never send anything yourself - your output is always a draft for human review. Never \
fabricate statistics, client examples, credentials, or quotes the spokesperson has \
not actually given you. Anything only a human can supply must be flagged with \
[NEEDS SPOKESPERSON INPUT: specific description]."""

BRIEFING_SYSTEM_PROMPT = """You write internal briefing notes for a digital PR team \
member who will personally write a HARO pitch by hand (the journalist has requested \
no AI-written pitches). Give them the questions, the angle, suggested talking points, \
and a word-count target - not a finished pitch."""


def _spokesperson_block(profile: Profile) -> str:
    return "; ".join(
        f"{p.get('name', '?')}, {p.get('credentials', '?')}, {p.get('title', '?')}, "
        f"{profile.client}, {', '.join(p.get('locations', []))}"
        for p in profile.spokespeople
    ) or "(no spokesperson on file)"


def _query_block(query: Query) -> str:
    questions = "\n".join(f"{i+1}. {q}" for i, q in enumerate(query.questions_asked)) or (
        "(no numbered questions extracted - see full requirements text)"
    )
    return f"""QUERY SUMMARY: {query.summary}
JOURNALIST: {query.journalist_name or 'unknown'}
MEDIA OUTLET: {query.media_outlet or 'unknown'}
QUESTIONS ASKED (answer in this order and format):
{questions}

FULL REQUIREMENTS TEXT:
{query.requirements_body}"""


def draft_pitch(query: Query, profile: Profile, llm_client) -> str:
    prompt = f"""{_query_block(query)}

SPOKESPERSON TO ATTRIBUTE: {_spokesperson_block(profile)}

Draft the pitch now."""
    result = llm_client.structured_call(
        system=PITCH_SYSTEM_PROMPT,
        user_prompt=prompt,
        tool_name="submit_pitch",
        tool_description="Submit the drafted pitch.",
        input_schema=PITCH_SCHEMA,
        max_tokens=1024,
    )
    return result["pitch_text"].strip()


def draft_briefing_note(query: Query, profile: Profile, llm_client) -> str:
    prompt = f"""{_query_block(query)}

SPOKESPERSON AVAILABLE: {_spokesperson_block(profile)}

This journalist has 'No AI Pitches Considered' set. Write the briefing note now."""
    result = llm_client.structured_call(
        system=BRIEFING_SYSTEM_PROMPT,
        user_prompt=prompt,
        tool_name="submit_briefing",
        tool_description="Submit the human briefing note.",
        input_schema=BRIEFING_SCHEMA,
        max_tokens=768,
    )
    return result["briefing_note"].strip()
