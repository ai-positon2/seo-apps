"""Flask-test-client integration tests for the inbound-email webhook."""
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from haro_agent import pipeline as pipeline_module
from haro_agent import webapp
from haro_agent.models import ScoreBreakdown

ROOT = Path(__file__).resolve().parent.parent

# The webhook path has no --as-of override (correctly - production processes real
# live email against real wall-clock time), so hours_remaining is computed against
# whenever the test actually runs. Deadlines must therefore be computed relative to
# "now", not hardcoded - a fixed past date would make every query fail the deadline
# hard filter and silently produce zero matches regardless of scoring logic.
_NOW = datetime.now(timezone.utc)
_DIGEST_DATE = _NOW.strftime("%B %d, %Y")
_DEADLINE_DT = _NOW + timedelta(days=3)
_DEADLINE_RAW = f"1:30 PM ET - {_DEADLINE_DT.day} {_DEADLINE_DT.strftime('%B')}"

_DIGEST_BODY = f"""1) Summary: Dentists explain whitening trends for a webhook test
Category: Health and Pharma
Journalist: Test Journalist
Media Outlet: Verywell Health
Deadline: {_DEADLINE_RAW}

Requirements: U.S.-based dentists only.
1. Are at-home whitening trends safe for enamel?
2. What's a safer alternative you'd recommend?

Reply to: reply+webhooktest1@helpareporter.com
"""


def _cloudmailin_payload(**overrides):
    payload = {
        "headers": {
            "from": "HARO <replies@helpareporter.com>",
            "to": "HARO Agent <abc123@cloudmailin.net>",
            "subject": f"HARO Queries for {_DIGEST_DATE} - Evening Edition",
            "message_id": "<test-message-1@helpareporter.com>",
            "date": _NOW.strftime("%a, %d %b %Y %H:%M:%S +0000"),
        },
        "envelope": {"to": "abc123@cloudmailin.net", "from": "replies@helpareporter.com"},
        "plain": _DIGEST_BODY,
        "html": "",
        "attachments": [],
    }
    payload.update(overrides)
    return payload


def _basic_auth_header(user, password):
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBHOOK_AUTH_USER", "wuser")
    monkeypatch.setenv("WEBHOOK_AUTH_PASS", "wpass")
    monkeypatch.delenv("DASHBOARD_AUTH_USER", raising=False)
    monkeypatch.delenv("DASHBOARD_AUTH_PASS", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.setattr(webapp, "DEFAULT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(webapp, "DEFAULT_REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setattr(webapp, "DEFAULT_PROFILES_PATH", str(ROOT / "config" / "profiles.example.yaml"))
    monkeypatch.setattr(webapp, "DEFAULT_SETTINGS_PATH", str(ROOT / "config" / "settings.example.yaml"))
    monkeypatch.setenv("LLM_MODE", "mock")
    app = webapp.create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_webhook_rejects_missing_auth(client):
    resp = client.post("/webhook/inbound-email", json=_cloudmailin_payload())
    assert resp.status_code == 401


def test_webhook_rejects_wrong_auth(client):
    resp = client.post(
        "/webhook/inbound-email",
        json=_cloudmailin_payload(),
        headers=_basic_auth_header("wuser", "wrongpass"),
    )
    assert resp.status_code == 401


def test_webhook_accepts_valid_payload_and_records_state(client):
    resp = client.post(
        "/webhook/inbound-email",
        json=_cloudmailin_payload(),
        headers=_basic_auth_header("wuser", "wpass"),
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "ok"
    assert body["message_id"] == "test-message-1@helpareporter.com"


def test_webhook_is_idempotent_on_redelivery(client):
    headers = _basic_auth_header("wuser", "wpass")
    first = client.post("/webhook/inbound-email", json=_cloudmailin_payload(), headers=headers)
    second = client.post("/webhook/inbound-email", json=_cloudmailin_payload(), headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    # Second delivery of the same Message-Id must not reprocess/re-score queries.
    assert second.get_json()["matches"] == 0


def test_webhook_handles_malformed_payload_gracefully(client):
    resp = client.post(
        "/webhook/inbound-email",
        json=["not", "an", "object"],
        headers=_basic_auth_header("wuser", "wpass"),
    )
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ignored"


def test_webhook_priority_match_triggers_console_notification(client, monkeypatch, capsys):
    def fake_score_query(query, profile, llm_client):
        return ScoreBreakdown(
            topical_fit=40, source_type_fit=20, answerability=15, outlet_value=15,
            deadline_feasibility=10, matched_signal="dentist",
            rationale="Forced high score for the webhook notify integration test.",
        )

    monkeypatch.setattr(pipeline_module, "score_query", fake_score_query)
    monkeypatch.setattr(pipeline_module, "draft_pitch", lambda q, p, c: "stub pitch")
    monkeypatch.setattr(pipeline_module, "draft_briefing_note", lambda q, p, c: "stub briefing")
    monkeypatch.setenv("NOTIFY_MODE", "console")

    resp = client.post(
        "/webhook/inbound-email",
        json=_cloudmailin_payload(),
        headers=_basic_auth_header("wuser", "wpass"),
    )
    assert resp.status_code == 200
    assert resp.get_json()["matches"] > 0
    assert "[notify:console]" in capsys.readouterr().out


def test_dashboard_open_when_auth_env_vars_unset(client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_dashboard_gated_when_auth_env_vars_set(tmp_path, monkeypatch):
    monkeypatch.setenv("DASHBOARD_AUTH_USER", "duser")
    monkeypatch.setenv("DASHBOARD_AUTH_PASS", "dpass")
    monkeypatch.setattr(webapp, "DEFAULT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(webapp, "DEFAULT_REPORTS_DIR", str(tmp_path / "reports"))
    app = webapp.create_app()
    app.config["TESTING"] = True
    test_client = app.test_client()

    unauthenticated = test_client.get("/")
    assert unauthenticated.status_code == 401

    authenticated = test_client.get("/", headers=_basic_auth_header("duser", "dpass"))
    assert authenticated.status_code == 200


def test_webhook_route_is_never_gated_by_dashboard_auth(tmp_path, monkeypatch):
    """The webhook has its own auth and must stay reachable even when the dashboard
    gate is enabled - CloudMailin authenticates with WEBHOOK_AUTH_*, not DASHBOARD_AUTH_*."""
    monkeypatch.setenv("DASHBOARD_AUTH_USER", "duser")
    monkeypatch.setenv("DASHBOARD_AUTH_PASS", "dpass")
    monkeypatch.setenv("WEBHOOK_AUTH_USER", "wuser")
    monkeypatch.setenv("WEBHOOK_AUTH_PASS", "wpass")
    monkeypatch.setattr(webapp, "DEFAULT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(webapp, "DEFAULT_REPORTS_DIR", str(tmp_path / "reports"))
    monkeypatch.setattr(webapp, "DEFAULT_PROFILES_PATH", str(ROOT / "config" / "profiles.example.yaml"))
    monkeypatch.setattr(webapp, "DEFAULT_SETTINGS_PATH", str(ROOT / "config" / "settings.example.yaml"))
    monkeypatch.setenv("LLM_MODE", "mock")
    app = webapp.create_app()
    app.config["TESTING"] = True
    test_client = app.test_client()

    resp = test_client.post(
        "/webhook/inbound-email",
        json=_cloudmailin_payload(),
        headers=_basic_auth_header("wuser", "wpass"),
    )
    assert resp.status_code == 200
