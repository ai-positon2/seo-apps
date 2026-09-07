"""Notify a human when a match is found. Slack posts use an Incoming Webhook —
no bot infrastructure needed. This module only ever sends a notification; it never
reads Slack, never replies to a journalist, and is a separate step from pitch
drafting (spec §1's 'never send' guarantee is about the journalist, not the team)."""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from .deadline import to_et
from .models import MatchResult


class NotifyError(RuntimeError):
    pass


def _format_message(match: MatchResult) -> str:
    q = match.query
    deadline_str = to_et(q.deadline_utc).strftime("%B %d, %Y, %I:%M %p ET") if q.deadline_utc else (q.deadline_raw or "unknown")
    hours = f"{q.hours_remaining:.0f}h remaining" if q.hours_remaining is not None else "unknown time remaining"
    tier_label = {"priority": ":red_circle: Priority", "qualified": ":large_yellow_circle: Qualified",
                  "borderline": ":white_circle: Borderline"}.get(match.tier, match.tier)

    lines = [
        f"*{tier_label} HARO match — {match.profile.display_name}* (score {match.score.total})",
        f"*{q.summary}*",
        f"Outlet: {q.media_outlet or 'unknown'}  |  Journalist: {q.journalist_name or 'unknown'}",
        f"Deadline: {deadline_str} ({hours})",
        f"Reply to: `{q.reply_email or 'unknown'}`",
        f"Why: {match.score.rationale}",
    ]
    if q.no_ai_pitches:
        lines.append(":warning: No AI pitches considered — briefing note only, a human must write this one.")
    return "\n".join(lines)


class ConsoleNotifier:
    """Prints the notification instead of sending it — for local testing without
    a real Slack webhook."""

    def notify(self, match: MatchResult) -> None:
        print("\n----- [notify:console] -----")
        print(_format_message(match))
        print("-----------------------------\n")


class SlackNotifier:
    def __init__(self, webhook_url: str):
        if not webhook_url:
            raise NotifyError("SLACK_WEBHOOK_URL is not set")
        self.webhook_url = webhook_url

    def notify(self, match: MatchResult) -> None:
        payload = json.dumps({"text": _format_message(match)}).encode("utf-8")
        req = urllib.request.Request(
            self.webhook_url, data=payload, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status >= 300:
                    raise NotifyError(f"Slack webhook returned HTTP {resp.status}")
        except urllib.error.URLError as exc:
            raise NotifyError(f"Failed to post to Slack webhook: {exc}") from exc


class NullNotifier:
    def notify(self, match: MatchResult) -> None:
        pass


def build_notifier(mode: str, webhook_url: str | None = None):
    if mode == "none":
        return NullNotifier()
    if mode == "console":
        return ConsoleNotifier()
    if mode == "slack":
        return SlackNotifier(webhook_url)
    raise ValueError(f"Unknown notify mode: {mode!r} (expected 'none', 'console', or 'slack')")
