"""Spec §6 Stage 2: weighted relevance scoring. Topical fit, source-type fit,
answerability and outlet value are judgment calls delegated to Claude; deadline
feasibility is computed deterministically from hours_remaining."""
from __future__ import annotations

from .models import Profile, Query, ScoreBreakdown

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "topical_fit": {
            "type": "integer",
            "description": "0-40. 40=squarely in expertise.primary, 25=adjacent/secondary, 10=tangential, 0=unrelated.",
        },
        "source_type_fit": {
            "type": "integer",
            "description": "0-20. 20=exact professional type requested is on the roster, 12=defensible adjacent credential, 0=mismatch.",
        },
        "answerability": {
            "type": "integer",
            "description": "0-15. Can the spokesperson give a specific, non-generic answer without proprietary data/case files the profile doesn't have?",
        },
        "outlet_value": {
            "type": "integer",
            "description": "0-15. 15=tier-1 national or on outlet_priority_list, 10=strong vertical trade pub, 5=SEO-value-only blog, 0=low-quality/link-farm.",
        },
        "matched_signal": {
            "type": ["string", "null"],
            "description": "The specific keyword or clear synonym (from keywords_include, or a term you can name) that ties this query to the profile's expertise. Null if you cannot name one.",
        },
        "rationale": {
            "type": "string",
            "description": "One sentence naming the SPECIFIC overlap (e.g. exact topic + exact profile expertise entry). Never a generic statement like 'relevant to X'.",
        },
    },
    "required": [
        "topical_fit", "source_type_fit", "answerability", "outlet_value",
        "matched_signal", "rationale",
    ],
}

SCORER_SYSTEM_PROMPT = """You are the scoring stage of a HARO (Help a Reporter Out) \
monitoring agent for a digital PR team. You judge whether one journalist query is a \
genuine fit for one expert profile.

Discipline: semantic matching beats keyword matching, but keyword matching prevents \
drift. If you find yourself constructing an elaborate justification for why a query \
is relevant, that is a signal to score it low, not high. False positives destroy \
trust in this agent faster than false negatives do. Score conservatively. Never \
invent or assume facts not present in the query or profile."""


def _deadline_feasibility(hours_remaining: float) -> int:
    if hours_remaining > 48:
        return 10
    if hours_remaining >= 24:
        return 7
    if hours_remaining >= 12:
        return 4
    if hours_remaining >= 6:
        return 2
    return 0


def _keyword_hit(query: Query, profile: Profile) -> str | None:
    haystack = f"{query.summary} {query.requirements_body}".lower()
    for kw in profile.keywords_include:
        if kw.lower() in haystack:
            return kw
    return None


def _build_prompt(query: Query, profile: Profile) -> str:
    spokespeople = "; ".join(
        f"{p.get('name', '?')} ({p.get('credentials', '?')}, {p.get('title', '?')}, "
        f"{', '.join(p.get('locations', []))})"
        for p in profile.spokespeople
    ) or "none listed"
    return f"""PROFILE: {profile.display_name}
EXPERTISE_PRIMARY: {', '.join(profile.expertise_primary)}
EXPERTISE_SECONDARY: {', '.join(profile.expertise_secondary)}
SPOKESPEOPLE: {spokespeople}
KEYWORDS_INCLUDE: {', '.join(profile.keywords_include)}
OUTLET_PRIORITY_LIST: {', '.join(profile.outlet_priority_list) or 'none'}

QUERY SUMMARY: {query.summary}
QUERY CATEGORY: {query.category or 'unknown'}
MEDIA OUTLET: {query.media_outlet or 'unknown'}
QUESTIONS ASKED:
{chr(10).join(f'- {q}' for q in query.questions_asked) or '(none extracted)'}

FULL REQUIREMENTS TEXT:
{query.requirements_body}

Score this query against this profile."""


def score_query(query: Query, profile: Profile, llm_client) -> ScoreBreakdown:
    result = llm_client.structured_call(
        system=SCORER_SYSTEM_PROMPT,
        user_prompt=_build_prompt(query, profile),
        tool_name="submit_score",
        tool_description="Submit the Stage 2 relevance score for this query/profile pair.",
        input_schema=SCORE_SCHEMA,
    )

    keyword_hit = _keyword_hit(query, profile)
    matched_signal = keyword_hit or result.get("matched_signal")

    topical_fit = int(result.get("topical_fit", 0))
    if not matched_signal:
        # §6 scoring discipline: require BOTH semantic fit and a concrete keyword/
        # synonym co-signal. Neither found -> force topical fit to 0 regardless of
        # what the model claimed, so an eager LLM can't manufacture a match.
        topical_fit = 0

    topical_fit = max(0, min(40, topical_fit))
    source_type_fit = max(0, min(20, int(result.get("source_type_fit", 0))))
    answerability = max(0, min(15, int(result.get("answerability", 0))))
    outlet_value = max(0, min(15, int(result.get("outlet_value", 0))))
    deadline_feasibility = _deadline_feasibility(query.hours_remaining or 0)

    rationale = result.get("rationale", "").strip() or "No rationale provided."

    return ScoreBreakdown(
        topical_fit=topical_fit,
        source_type_fit=source_type_fit,
        answerability=answerability,
        outlet_value=outlet_value,
        deadline_feasibility=deadline_feasibility,
        matched_signal=matched_signal,
        rationale=rationale,
    )


def tier_for_score(total: int, match_threshold: int) -> str:
    if total >= 85:
        return "priority"
    if total >= match_threshold:
        return "qualified"
    if total >= 55:
        return "borderline"
    return "discard"
