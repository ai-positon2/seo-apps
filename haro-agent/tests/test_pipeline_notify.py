"""Integration check: a Priority/Qualified-tier match must trigger the configured
notifier. The mock LLM's crude heuristic caps real fixture runs at 'borderline', so
this forces a high score via monkeypatching to actually exercise the notify path."""
from datetime import datetime, timezone
from pathlib import Path

import pytest

from haro_agent import pipeline as pipeline_module
from haro_agent.models import ScoreBreakdown
from haro_agent.pipeline import PipelineConfig, run_pipeline

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def isolated_dirs(tmp_path):
    state_dir = tmp_path / "state"
    reports_dir = tmp_path / "reports"
    return state_dir, reports_dir


def test_priority_match_triggers_console_notification(isolated_dirs, monkeypatch, capsys):
    state_dir, reports_dir = isolated_dirs

    def fake_score_query(query, profile, llm_client):
        return ScoreBreakdown(
            topical_fit=40, source_type_fit=20, answerability=15, outlet_value=15,
            deadline_feasibility=10, matched_signal="dentist",
            rationale="Forced high score for the notify integration test.",
        )

    monkeypatch.setattr(pipeline_module, "score_query", fake_score_query)
    monkeypatch.setattr(pipeline_module, "draft_pitch", lambda q, p, c: "stub pitch")
    monkeypatch.setattr(pipeline_module, "draft_briefing_note", lambda q, p, c: "stub briefing")

    config = PipelineConfig(
        source="local",
        samples_dir=str(ROOT / "samples"),
        profiles_path=str(ROOT / "config" / "profiles.example.yaml"),
        settings_path=str(ROOT / "config" / "settings.example.yaml"),
        state_dir=str(state_dir),
        reports_dir=str(reports_dir),
        llm_mode="mock",
        as_of=datetime(2026, 8, 24, 21, 0, tzinfo=timezone.utc),
        notify_mode="console",
    )

    result = run_pipeline(config)

    assert len(result.summary.matches) > 0
    assert all(m.tier == "priority" for m in result.summary.matches)

    captured = capsys.readouterr().out
    assert "[notify:console]" in captured
    assert captured.count("[notify:console]") == len(result.summary.matches)


def test_discarded_match_does_not_trigger_notification(isolated_dirs, monkeypatch, capsys):
    state_dir, reports_dir = isolated_dirs

    def fake_score_query(query, profile, llm_client):
        return ScoreBreakdown(
            topical_fit=0, source_type_fit=0, answerability=0, outlet_value=0,
            deadline_feasibility=0, matched_signal=None, rationale="Nothing matches.",
        )

    monkeypatch.setattr(pipeline_module, "score_query", fake_score_query)

    config = PipelineConfig(
        source="local",
        samples_dir=str(ROOT / "samples"),
        profiles_path=str(ROOT / "config" / "profiles.example.yaml"),
        settings_path=str(ROOT / "config" / "settings.example.yaml"),
        state_dir=str(state_dir),
        reports_dir=str(reports_dir),
        llm_mode="mock",
        as_of=datetime(2026, 8, 24, 21, 0, tzinfo=timezone.utc),
        notify_mode="console",
    )

    result = run_pipeline(config)

    assert len(result.summary.matches) == 0
    captured = capsys.readouterr().out
    assert "[notify:console]" not in captured
