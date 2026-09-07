import json
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest

from haro_agent.models import MatchResult, Profile, Query, ScoreBreakdown
from haro_agent.notify import ConsoleNotifier, NotifyError, SlackNotifier, build_notifier


def _match():
    profile = Profile(
        id="gentle-dental-clinical", display_name="Gentle Dental", client="Gentle Dental",
        active=True, priority="high", expertise_primary=["general dentistry"],
        expertise_secondary=[], spokespeople=[], geography={"country": "US"},
        keywords_include=["dentist"], keywords_exclude=[], categories_watch=[],
        min_hours_to_deadline=6, require_named_outlet=False, outlet_blocklist=[],
        outlet_priority_list=[], match_threshold=70,
    )
    query = Query(
        query_id="abc123", digest_date="2026-08-24", digest_edition="Evening",
        query_number=9, summary="Dentists explain whitening trends", category="Health",
        journalist_name="Kayla Becker", journalist_profile_url=None,
        reply_email="reply+x@helpareporter.com", media_outlet="Verywell Health",
        media_outlet_url=None, deadline_raw="1:30 PM ET - 27 August",
        deadline_utc=datetime(2026, 8, 27, 17, 30, tzinfo=timezone.utc),
        hours_remaining=48, no_ai_pitches=False,
        requirements_body="U.S.-based dentists only.", questions_asked=["Q1?"],
        geo_requirement="U.S.-based", source_type_requested=["dentist"],
    )
    score = ScoreBreakdown(
        topical_fit=40, source_type_fit=20, answerability=15, outlet_value=10,
        deadline_feasibility=10, matched_signal="dentist",
        rationale="Squarely general dentistry.",
    )
    return MatchResult(query=query, profile=profile, score=score, tier="priority")


def test_console_notifier_prints_without_error(capsys):
    ConsoleNotifier().notify(_match())
    out = capsys.readouterr().out
    assert "Dentists explain whitening trends" in out
    assert "Verywell Health" in out


def test_build_notifier_none_is_a_noop():
    notifier = build_notifier("none")
    notifier.notify(_match())  # should not raise


def test_slack_notifier_requires_webhook_url():
    with pytest.raises(NotifyError):
        build_notifier("slack", webhook_url=None)


def test_slack_notifier_posts_json_payload_to_webhook():
    notifier = SlackNotifier("https://hooks.slack.com/services/FAKE")
    fake_response = MagicMock()
    fake_response.status = 200
    fake_response.__enter__.return_value = fake_response
    with patch("haro_agent.notify.urllib.request.urlopen", return_value=fake_response) as mock_urlopen:
        notifier.notify(_match())
    assert mock_urlopen.called
    request_obj = mock_urlopen.call_args[0][0]
    body = json.loads(request_obj.data.decode("utf-8"))
    assert "Dentists explain whitening trends" in body["text"]
    assert "Verywell Health" in body["text"]
