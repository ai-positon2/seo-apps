"""The actual run: mailbox -> identify -> parse -> filter -> score -> draft -> report.
Shared by the CLI (cli.py), the local web dashboard, and the inbound-email webhook
(webapp.py) so none of them drift out of sync with each other.

process_raw_email() and score_filter_and_notify() are the two reusable halves:
the polling path (run_pipeline, for local/gmail sources) calls them across a batch
of emails fetched from a MailboxAdapter; the webhook handler (webapp.py) calls them
for exactly one pushed email at a time, then does its own small amount of
report/state finalization rather than forcing that through a shared function — the
two call sites' summaries differ enough (batch counts vs. a single email) that
sharing more than the scoring/filtering logic itself would just add indirection."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from .config import load_profiles, load_settings
from .deadline import IST
from .filters import run_hard_filters
from .identify import identify
from .llm import build_llm_client
from .mailbox.local_fixture import LocalFixtureMailbox
from .models import MatchResult, Query, RawEmail
from .notify import build_notifier
from .parser import parse_digest
from .pitch import draft_briefing_note, draft_pitch
from .report import RunSummary, render_report
from .scorer import score_query, tier_for_score
from .state import StateStore

NOTIFY_TIERS = {"priority", "qualified"}


def load_dotenv(path: Path = Path(".env")) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def parse_as_of(value: Optional[str]):
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@dataclass
class PipelineConfig:
    source: str = "local"
    samples_dir: str = "samples"
    profiles_path: str = "config/profiles.example.yaml"
    settings_path: Optional[str] = "config/settings.example.yaml"
    state_dir: str = "state"
    reports_dir: str = "reports"
    lookback_hours: int = 24
    llm_mode: str = "mock"
    model: Optional[str] = None
    as_of: Optional[datetime] = None
    notify_mode: str = "none"
    slack_webhook_url: Optional[str] = None
    notify_tiers: frozenset = field(default_factory=lambda: frozenset(NOTIFY_TIERS))


@dataclass
class PipelineResult:
    report_text: str
    report_path: Path
    summary: RunSummary
    digests_processed: int = 0
    skipped_non_digest: int = 0
    skipped_already_processed: int = 0
    log_lines: list = field(default_factory=list)


@dataclass
class PipelineContext:
    """Everything process_raw_email/score_filter_and_notify need. discarded_count
    and log_lines accumulate as mutable state across calls on the same context."""

    config: PipelineConfig
    profiles: list
    llm_client: object
    state: StateStore
    notifier: object
    known_addresses: Optional[list]
    as_of: Optional[datetime]
    log_lines: list = field(default_factory=list)
    discarded_count: int = 0


def build_context(config: PipelineConfig) -> PipelineContext:
    settings = load_settings(config.settings_path) if config.settings_path else {}
    return PipelineContext(
        config=config,
        profiles=load_profiles(config.profiles_path),
        llm_client=build_llm_client(config.llm_mode, model=config.model),
        state=StateStore(config.state_dir),
        notifier=build_notifier(config.notify_mode, webhook_url=config.slack_webhook_url),
        known_addresses=settings.get("known_haro_subscription_addresses"),
        as_of=config.as_of,
    )


def _build_mailbox(config: PipelineConfig):
    if config.source == "local":
        return LocalFixtureMailbox(config.samples_dir)
    if config.source == "gmail":
        from .mailbox.gmail import GmailMailbox

        return GmailMailbox()
    raise ValueError(f"Unknown source {config.source!r}")


@dataclass
class EmailProcessResult:
    status: str  # "already_processed" | "skipped_non_digest" | "processed"
    queries: List[Query] = field(default_factory=list)


def process_raw_email(email: RawEmail, ctx: PipelineContext) -> EmailProcessResult:
    """Identify + parse one raw email. Records parse failures and marks the email
    processed as a side effect on ctx.state."""
    if ctx.state.is_email_processed(email.message_id):
        return EmailProcessResult(status="already_processed")

    result = identify(email, known_subscription_addresses=ctx.known_addresses)
    if not result.is_digest:
        ctx.log_lines.append(f"[skip] {email.message_id}: {result.reason}")
        return EmailProcessResult(status="skipped_non_digest")

    try:
        queries, failures = parse_digest(
            email.subject, result.cleaned_body, digest_reference=email.message_id, as_of=ctx.as_of
        )
    except ValueError as exc:
        ctx.log_lines.append(f"[format-drift] {email.message_id}: {exc}")
        failures, queries = [], []

    for failure in failures:
        ctx.state.record_parse_failure(failure.digest_reference, failure.error, failure.raw_block)

    ctx.state.mark_email_processed(
        email.message_id,
        digest_date=queries[0].digest_date if queries else "unknown",
        edition=queries[0].digest_edition if queries else "unknown",
        query_count=len(queries),
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    return EmailProcessResult(status="processed", queries=queries)


def score_filter_and_notify(queries: List[Query], ctx: PipelineContext) -> List[MatchResult]:
    """Run every query against every active profile: hard filters, Stage 2 scoring,
    pitch/briefing drafting for Priority/Qualified, state recording, and Slack/console
    notification. Returns the matches surfaced (Priority/Qualified/Borderline).
    Increments ctx.discarded_count for every hard-filter or below-threshold reject."""
    already_reported = ctx.state.already_reported_ids()
    matches: List[MatchResult] = []

    for profile in ctx.profiles:
        for query in queries:
            hard_result = run_hard_filters(query, profile, already_reported)
            if not hard_result.passed:
                ctx.discarded_count += 1
                continue

            score = score_query(query, profile, ctx.llm_client)
            tier = tier_for_score(score.total, profile.match_threshold)
            if tier == "discard":
                ctx.discarded_count += 1
                continue

            match = MatchResult(query=query, profile=profile, score=score, tier=tier)
            if tier in ("priority", "qualified"):
                if query.no_ai_pitches:
                    match.briefing_note = draft_briefing_note(query, profile, ctx.llm_client)
                    ctx.state.record_pitch(query.query_id, match.briefing_note, sent=False)
                else:
                    match.pitch_text = draft_pitch(query, profile, ctx.llm_client)
                    ctx.state.record_pitch(query.query_id, match.pitch_text, sent=False)

            ctx.state.record_match(
                query.query_id,
                profile.id,
                score.total,
                reported_at=datetime.now(timezone.utc).isoformat(),
                action_taken=tier,
            )
            already_reported.add((profile.id, query.query_id))
            matches.append(match)

            if tier in ctx.config.notify_tiers:
                try:
                    ctx.notifier.notify(match)
                except Exception as exc:
                    ctx.log_lines.append(f"[notify-failed] {query.query_id}/{profile.id}: {exc}")

    return matches


def _digest_label(digest_labels: List[tuple]) -> tuple:
    if len(set(digest_labels)) == 1:
        return digest_labels[0]
    if digest_labels:
        return "multiple digests", f"{len(set(digest_labels))} editions"
    return "n/a", "n/a"


def _write_report(ctx: PipelineContext, summary: RunSummary) -> tuple[str, Path]:
    report_text = render_report(summary)
    reports_dir = Path(ctx.config.reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = (ctx.as_of or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    report_path = reports_dir / f"haro_report_{stamp}.md"
    report_path.write_text(report_text, encoding="utf-8")
    return report_text, report_path


def run_pipeline(config: PipelineConfig) -> PipelineResult:
    ctx = build_context(config)

    mailbox = _build_mailbox(config)
    raw_emails = mailbox.fetch_candidate_emails(config.lookback_hours)

    all_queries: List[Query] = []
    digests_processed = 0
    skipped_already_processed = 0
    skipped_non_digest = 0
    digest_labels = []

    for email in raw_emails:
        result = process_raw_email(email, ctx)
        if result.status == "already_processed":
            skipped_already_processed += 1
        elif result.status == "skipped_non_digest":
            skipped_non_digest += 1
        else:
            digests_processed += 1
            all_queries.extend(result.queries)
            if result.queries:
                digest_labels.append((result.queries[0].digest_date, result.queries[0].digest_edition))

    matches = score_filter_and_notify(all_queries, ctx)
    digest_date, digest_edition = _digest_label(digest_labels)

    summary = RunSummary(
        digest_date=digest_date,
        digest_edition=digest_edition,
        run_time_ist=(ctx.as_of or datetime.now(timezone.utc)).astimezone(IST),
        digests_processed=digests_processed,
        queries_parsed=len(all_queries),
        discarded_count=ctx.discarded_count,
        parse_failure_count=len(ctx.state.parse_failures),
        skipped_already_processed=skipped_already_processed,
        matches=matches,
    )
    report_text, report_path = _write_report(ctx, summary)
    ctx.state.save()

    ctx.log_lines.append(
        f"[run log] digests_processed={digests_processed} "
        f"skipped_non_digest={skipped_non_digest} "
        f"skipped_already_processed={skipped_already_processed} "
        f"queries_parsed={len(all_queries)} matches={len(matches)} "
        f"discarded={ctx.discarded_count} parse_failures={len(ctx.state.parse_failures)}"
    )
    ctx.log_lines.append(f"[report written] {report_path}")

    return PipelineResult(
        report_text=report_text,
        report_path=report_path,
        summary=summary,
        digests_processed=digests_processed,
        skipped_non_digest=skipped_non_digest,
        skipped_already_processed=skipped_already_processed,
        log_lines=ctx.log_lines,
    )


def run_single_email(email: RawEmail, config: PipelineConfig) -> PipelineResult:
    """Push-ingestion entry point: process exactly one already-received email
    (e.g. from the inbound-email webhook) through the same scoring/notify pipeline,
    then write a report/state update the same way a polling run would."""
    ctx = build_context(config)
    email_result = process_raw_email(email, ctx)

    matches: List[MatchResult] = []
    digests_processed = 0
    digest_date, digest_edition = "n/a", "n/a"

    if email_result.status == "processed":
        digests_processed = 1
        matches = score_filter_and_notify(email_result.queries, ctx)
        if email_result.queries:
            digest_date = email_result.queries[0].digest_date
            digest_edition = email_result.queries[0].digest_edition

    summary = RunSummary(
        digest_date=digest_date,
        digest_edition=digest_edition,
        run_time_ist=(ctx.as_of or datetime.now(timezone.utc)).astimezone(IST),
        digests_processed=digests_processed,
        queries_parsed=len(email_result.queries),
        discarded_count=ctx.discarded_count,
        parse_failure_count=len(ctx.state.parse_failures),
        skipped_already_processed=1 if email_result.status == "already_processed" else 0,
        matches=matches,
    )
    report_text, report_path = _write_report(ctx, summary)
    ctx.state.save()

    ctx.log_lines.append(f"[webhook] {email.message_id}: status={email_result.status} matches={len(matches)}")
    ctx.log_lines.append(f"[report written] {report_path}")

    return PipelineResult(
        report_text=report_text,
        report_path=report_path,
        summary=summary,
        digests_processed=digests_processed,
        skipped_non_digest=1 if email_result.status == "skipped_non_digest" else 0,
        skipped_already_processed=summary.skipped_already_processed,
        log_lines=ctx.log_lines,
    )
