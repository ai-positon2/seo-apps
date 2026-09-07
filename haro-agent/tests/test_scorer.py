from datetime import datetime, timezone

from haro_agent.models import Profile, Query
from haro_agent.scorer import score_query, tier_for_score


class StubLLM:
    """Returns a fixed structured response regardless of prompt content."""

    def __init__(self, response: dict):
        self.response = response

    def structured_call(self, **kwargs):
        return dict(self.response)


def _profile(**overrides):
    defaults = dict(
        id="test-profile",
        display_name="Test Profile",
        client="Test Client",
        active=True,
        priority="high",
        expertise_primary=["general dentistry"],
        expertise_secondary=[],
        spokespeople=[],
        geography={"country": "US"},
        keywords_include=["dentist", "dental"],
        keywords_exclude=[],
        categories_watch=[],
        min_hours_to_deadline=6,
        require_named_outlet=False,
        outlet_blocklist=[],
        outlet_priority_list=[],
        match_threshold=70,
    )
    defaults.update(overrides)
    return Profile(**defaults)


def _query(**overrides):
    defaults = dict(
        query_id="abc123",
        digest_date="2026-08-24",
        digest_edition="Evening",
        query_number=1,
        summary="Some unrelated topic entirely",
        category=None,
        journalist_name=None,
        journalist_profile_url=None,
        reply_email="reply+x@helpareporter.com",
        media_outlet="Forbes",
        media_outlet_url=None,
        deadline_raw="1:00 PM ET - 27 August",
        deadline_utc=datetime(2026, 8, 27, 17, 0, tzinfo=timezone.utc),
        hours_remaining=60,
        no_ai_pitches=False,
        requirements_body="Some unrelated requirements text.",
        questions_asked=[],
        geo_requirement=None,
        source_type_requested=[],
    )
    defaults.update(overrides)
    return Query(**defaults)


def test_llm_claiming_high_topical_fit_is_zeroed_without_any_keyword_or_named_signal():
    """The spec's anti-drift rule: semantic judgment alone is not enough. If neither
    a raw keyword hit nor an LLM-named synonym is present, force topical_fit to 0
    regardless of what the model claims."""
    llm = StubLLM(
        {
            "topical_fit": 40,
            "source_type_fit": 20,
            "answerability": 15,
            "outlet_value": 15,
            "matched_signal": None,
            "rationale": "This is a stretch but I'll allow it.",
        }
    )
    query = _query(summary="A totally unrelated finance query", requirements_body="Nothing relevant to this profile appears here.")
    profile = _profile()

    score = score_query(query, profile, llm)

    assert score.topical_fit == 0
    assert score.matched_signal is None
    # Losing 40 of the 100 possible points on topical fit alone should be enough
    # to keep a truly unrelated query out of "qualified" (70+) territory.
    assert score.total < 70


def test_raw_keyword_hit_preserves_llm_topical_fit():
    llm = StubLLM(
        {
            "topical_fit": 38,
            "source_type_fit": 18,
            "answerability": 12,
            "outlet_value": 15,
            "matched_signal": None,
            "rationale": "Query is squarely about general dentistry.",
        }
    )
    query = _query(summary="Dentists share tips on cavity prevention")
    profile = _profile()

    score = score_query(query, profile, llm)

    assert score.topical_fit == 38
    assert score.matched_signal == "dentist"
    assert score.total >= 85


def test_llm_named_synonym_also_satisfies_the_gate():
    llm = StubLLM(
        {
            "topical_fit": 35,
            "source_type_fit": 15,
            "answerability": 10,
            "outlet_value": 10,
            "matched_signal": "orthodontist",
            "rationale": "Orthodontics is a defensible synonym for dental expertise.",
        }
    )
    query = _query(summary="Orthodontists weigh in on clear aligner trends")
    profile = _profile()

    score = score_query(query, profile, llm)

    assert score.topical_fit == 35
    assert score.matched_signal == "orthodontist"


def test_deadline_feasibility_bands():
    profile = _profile()
    llm = StubLLM(
        {
            "topical_fit": 0, "source_type_fit": 0, "answerability": 0, "outlet_value": 0,
            "matched_signal": None, "rationale": "n/a",
        }
    )
    for hours, expected in [(72, 10), (30, 7), (18, 4), (8, 2), (3, 0)]:
        query = _query(hours_remaining=hours)
        score = score_query(query, profile, llm)
        assert score.deadline_feasibility == expected, f"hours={hours}"


def test_tier_thresholds():
    assert tier_for_score(90, 70) == "priority"
    assert tier_for_score(75, 70) == "qualified"
    assert tier_for_score(60, 70) == "borderline"
    assert tier_for_score(40, 70) == "discard"
