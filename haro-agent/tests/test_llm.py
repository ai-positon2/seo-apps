import pytest

from haro_agent.llm import LLMError, MockLLMClient, build_llm_client


def test_build_llm_client_raises_when_claude_key_missing(monkeypatch):
    """Regression: a production deploy with LLM_MODE=claude but no
    ANTHROPIC_API_KEY must fail with a clear LLMError, not some other crash
    surfaced later mid-request."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(LLMError):
        build_llm_client("claude")


def test_build_llm_client_raises_when_openai_key_missing(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(LLMError):
        build_llm_client("openai")


def test_build_llm_client_mock_never_requires_a_key():
    assert isinstance(build_llm_client("mock"), MockLLMClient)


def test_mock_score_does_not_self_match_against_profile_keyword_list():
    """Regression: the mock's keyword search must scan only the query-specific
    portion of the prompt. Scanning the whole prompt would also match the
    profile's own KEYWORDS_INCLUDE line against itself, "finding" every keyword
    even when the query text never mentions it."""
    client = MockLLMClient()
    prompt = """PROFILE: Gentle Dental
KEYWORDS_INCLUDE: dentist, dental, oral health

QUERY SUMMARY: Travel agents share tips for booking honeymoons
QUESTIONS ASKED:
- What's trending for 2026?

FULL REQUIREMENTS TEXT:
Looking for travel agents only, no other profession applies here."""
    result = client.structured_call(
        system="", user_prompt=prompt, tool_name="submit_score",
        tool_description="", input_schema={},
    )
    assert result["matched_signal"] is None
    assert result["topical_fit"] == 0


def test_mock_score_matches_when_keyword_is_in_query_text():
    client = MockLLMClient()
    prompt = """PROFILE: Gentle Dental
KEYWORDS_INCLUDE: dentist, dental, oral health

QUERY SUMMARY: Dentists explain the latest whitening trends
FULL REQUIREMENTS TEXT:
U.S.-based dentists only."""
    result = client.structured_call(
        system="", user_prompt=prompt, tool_name="submit_score",
        tool_description="", input_schema={},
    )
    assert result["matched_signal"] == "dentist"
    assert result["topical_fit"] > 0
