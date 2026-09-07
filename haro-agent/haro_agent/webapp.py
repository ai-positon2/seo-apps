"""Web dashboard + inbound-email webhook. Locally (python -m haro_agent.cli serve)
this binds to 127.0.0.1 and the dashboard is open - matches the original local-only
tool. Deployed (Railway, via the Procfile/gunicorn), the same app also exposes
POST /webhook/inbound-email for CloudMailin's push delivery, and the dashboard
routes get gated behind HTTP Basic Auth if DASHBOARD_AUTH_USER/PASS are set - set
them whenever this is reachable from the public internet."""
from __future__ import annotations

import html
import os
import sys
from pathlib import Path

import markdown as md
from flask import Flask, make_response, redirect, request, url_for

from .config import load_profiles
from .inbound import InboundPayloadError, parse_cloudmailin_payload
from .pipeline import PipelineConfig, load_dotenv, parse_as_of, run_pipeline, run_single_email
from .state import StateStore

load_dotenv()

DEFAULT_PROFILES_PATH = os.environ.get("PROFILES_PATH", "config/profiles.example.yaml")
DEFAULT_SETTINGS_PATH = os.environ.get("SETTINGS_PATH", "config/settings.example.yaml")
DEFAULT_SAMPLES_DIR = os.environ.get("SAMPLES_DIR", "samples")
DEFAULT_STATE_DIR = os.environ.get("STATE_DIR", "state")
DEFAULT_REPORTS_DIR = os.environ.get("REPORTS_DIR", "reports")

PAGE_SHELL = """<!doctype html>
<html><head><meta charset="utf-8">
<title>{title} - HARO Agent</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 900px;
         margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.5; }}
  nav {{ margin-bottom: 1.5rem; padding-bottom: 0.75rem; border-bottom: 2px solid #222; }}
  nav a {{ margin-right: 1.2rem; text-decoration: none; color: #0b5fff; font-weight: 600; }}
  nav a:hover {{ text-decoration: underline; }}
  h1 {{ font-size: 1.5rem; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
  th, td {{ border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }}
  th {{ background: #f4f4f4; }}
  .card {{ border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; background: #fafafa; }}
  form.run-form label {{ display: inline-block; min-width: 110px; }}
  form.run-form div {{ margin: 0.4rem 0; }}
  button {{ background: #0b5fff; color: white; border: none; padding: 0.5rem 1.1rem;
            border-radius: 6px; cursor: pointer; font-size: 0.95rem; }}
  button:hover {{ background: #0947c2; }}
  .flash {{ background: #eaffea; border: 1px solid #4caf50; padding: 0.6rem 1rem; border-radius: 6px; margin-bottom: 1rem; }}
  .muted {{ color: #666; font-size: 0.85rem; }}
  pre {{ background: #f6f6f6; padding: 0.8rem; border-radius: 6px; overflow-x: auto; }}
  .report-body {{ border: 1px solid #ddd; border-radius: 8px; padding: 1.2rem 1.5rem; background: white; }}
  .report-body h1, .report-body h2, .report-body h3 {{ margin-top: 1.2em; }}
  .report-body hr {{ border: none; border-top: 1px solid #ddd; margin: 1.5rem 0; }}
</style>
</head><body>
<nav>
  <a href="{home}">Dashboard</a>
  <a href="{reports}">Reports</a>
  <a href="{state}">State</a>
  <a href="{profiles}">Profiles</a>
</nav>
{body}
</body></html>"""


def _shell(title: str, body: str) -> str:
    return PAGE_SHELL.format(
        title=html.escape(title),
        body=body,
        home=url_for("dashboard"),
        reports=url_for("list_reports"),
        state=url_for("view_state"),
        profiles=url_for("view_profiles"),
    )


def _unauthorized(realm: str):
    response = make_response("Unauthorized", 401)
    response.headers["WWW-Authenticate"] = f'Basic realm="{realm}"'
    return response


def _basic_auth_ok(user_env: str, pass_env: str) -> bool:
    expected_user = os.environ.get(user_env)
    expected_pass = os.environ.get(pass_env)
    if not expected_user or not expected_pass:
        return False
    auth = request.authorization
    return bool(auth) and auth.username == expected_user and auth.password == expected_pass


def create_app() -> Flask:
    app = Flask(__name__)

    @app.before_request
    def _require_dashboard_auth():
        if request.path.startswith("/webhook/"):
            return None  # the webhook route checks its own, separate credentials
        expected_user = os.environ.get("DASHBOARD_AUTH_USER")
        expected_pass = os.environ.get("DASHBOARD_AUTH_PASS")
        if not expected_user or not expected_pass:
            return None  # not configured - stays open, matches local-dev behavior
        auth = request.authorization
        if not auth or auth.username != expected_user or auth.password != expected_pass:
            return _unauthorized("HARO dashboard")
        return None

    @app.route("/")
    def dashboard():
        reports_dir = Path(DEFAULT_REPORTS_DIR)
        report_files = sorted(reports_dir.glob("*.md"), reverse=True) if reports_dir.exists() else []
        latest = report_files[0] if report_files else None

        try:
            state = StateStore(DEFAULT_STATE_DIR)
            stats = (
                f"<b>{len(state.processed_emails)}</b> emails processed &middot; "
                f"<b>{len(state.reported_matches)}</b> matches reported &middot; "
                f"<b>{len(state.parse_failures)}</b> parse failures &middot; "
                f"<b>{len(state.pitch_log)}</b> pitches/briefings drafted"
            )
        except Exception:
            stats = "(no state yet — run the agent once)"

        flash = ""
        if request.args.get("ran") == "1":
            flash = f'<div class="flash">Run complete. <a href="{url_for("view_report", filename=request.args.get("report", ""))}">View the new report</a>.</div>'

        latest_link = (
            f'<a href="{url_for("view_report", filename=latest.name)}">{html.escape(latest.name)}</a>'
            if latest else "<span class='muted'>none yet</span>"
        )

        body = f"""
{flash}
<h1>HARO Monitoring Agent</h1>
<div class="card">
  <b>State summary:</b> {stats}<br>
  <b>Most recent report:</b> {latest_link}
</div>

<div class="card">
  <h2 style="margin-top:0">Run now</h2>
  <form class="run-form" method="post" action="{url_for('trigger_run')}">
    <div><label>Source</label>
      <select name="source">
        <option value="local" selected>local fixtures ({DEFAULT_SAMPLES_DIR}/)</option>
        <option value="gmail">gmail (requires OAuth setup)</option>
      </select>
    </div>
    <div><label>Scoring engine</label>
      <select name="llm">
        <option value="mock" selected>mock (offline, free, heuristic)</option>
        <option value="claude">claude (real scoring/drafts, needs ANTHROPIC_API_KEY)</option>
      </select>
    </div>
    <div><label>As-of (optional)</label>
      <input type="text" name="as_of" placeholder="2026-08-24T21:00:00" size="24">
      <span class="muted">fixes the reference time for hours-remaining; blank = now</span>
    </div>
    <div><label>Lookback hours</label>
      <input type="number" name="lookback_hours" value="24" size="4">
    </div>
    <div><label>Notify</label>
      <select name="notify">
        <option value="none" selected>none</option>
        <option value="console">console (print, for local testing)</option>
        <option value="slack">slack (needs SLACK_WEBHOOK_URL in .env)</option>
      </select>
      <span class="muted">posts one message per Priority/Qualified match</span>
    </div>
    <div style="margin-top:0.8rem"><button type="submit">Run HARO check</button></div>
  </form>
  <p class="muted">Note: running twice against the same fixtures produces zero new
  matches the second time (idempotency) unless you clear <code>{DEFAULT_STATE_DIR}/</code> first.</p>
</div>
"""
        return _shell("Dashboard", body)

    @app.route("/run", methods=["POST"])
    def trigger_run():
        config = PipelineConfig(
            source=request.form.get("source", "local"),
            samples_dir=DEFAULT_SAMPLES_DIR,
            profiles_path=DEFAULT_PROFILES_PATH,
            settings_path=DEFAULT_SETTINGS_PATH,
            state_dir=DEFAULT_STATE_DIR,
            reports_dir=DEFAULT_REPORTS_DIR,
            lookback_hours=int(request.form.get("lookback_hours") or 24),
            llm_mode=request.form.get("llm", "mock"),
            as_of=parse_as_of(request.form.get("as_of") or None),
            notify_mode=request.form.get("notify", "none"),
            slack_webhook_url=os.environ.get("SLACK_WEBHOOK_URL"),
        )
        result = run_pipeline(config)
        return redirect(url_for("dashboard", ran="1", report=result.report_path.name))

    @app.route("/webhook/inbound-email", methods=["POST"])
    def inbound_email_webhook():
        if not _basic_auth_ok("WEBHOOK_AUTH_USER", "WEBHOOK_AUTH_PASS"):
            # Fails closed: an unconfigured or wrong-credential webhook is refused
            # outright, rather than silently accepting unauthenticated POSTs from
            # the public internet onto an endpoint that spends LLM/Slack calls.
            return _unauthorized("HARO inbound webhook")

        data = request.get_json(silent=True)
        try:
            raw_email = parse_cloudmailin_payload(data)
        except InboundPayloadError as exc:
            # 200 on purpose: CloudMailin retries (and eventually disables) a
            # webhook that keeps erroring, so a malformed payload should be logged
            # and acknowledged, not treated as a delivery failure to retry forever.
            print(f"[webhook] payload parse failed: {exc}", file=sys.stderr)
            return {"status": "ignored", "reason": str(exc)}, 200

        config = PipelineConfig(
            profiles_path=DEFAULT_PROFILES_PATH,
            settings_path=DEFAULT_SETTINGS_PATH,
            state_dir=DEFAULT_STATE_DIR,
            reports_dir=DEFAULT_REPORTS_DIR,
            llm_mode=os.environ.get("LLM_MODE", "mock"),
            notify_mode=os.environ.get("NOTIFY_MODE", "none"),
            slack_webhook_url=os.environ.get("SLACK_WEBHOOK_URL"),
        )
        result = run_single_email(raw_email, config)
        return {
            "status": "ok",
            "message_id": raw_email.message_id,
            "matches": len(result.summary.matches),
            "report": result.report_path.name,
        }, 200

    @app.route("/reports")
    def list_reports():
        reports_dir = Path(DEFAULT_REPORTS_DIR)
        files = sorted(reports_dir.glob("*.md"), reverse=True) if reports_dir.exists() else []
        if not files:
            body = "<h1>Reports</h1><p class='muted'>No reports yet — run the agent from the Dashboard.</p>"
        else:
            items = "".join(
                f'<li><a href="{url_for("view_report", filename=f.name)}">{html.escape(f.name)}</a></li>'
                for f in files
            )
            body = f"<h1>Reports</h1><ul>{items}</ul>"
        return _shell("Reports", body)

    @app.route("/reports/<path:filename>")
    def view_report(filename):
        reports_dir = Path(DEFAULT_REPORTS_DIR).resolve()
        report_path = (reports_dir / filename).resolve()
        if reports_dir not in report_path.parents or not report_path.exists():
            return _shell("Not found", "<h1>Report not found</h1>"), 404
        raw = report_path.read_text(encoding="utf-8")
        rendered = md.markdown(raw, extensions=["extra"])
        body = f"<h1>{html.escape(filename)}</h1><div class='report-body'>{rendered}</div>"
        return _shell(filename, body)

    @app.route("/state")
    def view_state():
        try:
            state = StateStore(DEFAULT_STATE_DIR)
        except Exception as exc:
            return _shell("State", f"<h1>State</h1><p>Could not load state: {html.escape(str(exc))}</p>")

        def _table(rows, columns):
            if not rows:
                return "<p class='muted'>none</p>"
            head = "".join(f"<th>{c}</th>" for c in columns)
            body_rows = "".join(
                "<tr>" + "".join(f"<td>{html.escape(str(row.get(c, '')))[:200]}</td>" for c in columns) + "</tr>"
                for row in rows
            )
            return f"<table><tr>{head}</tr>{body_rows}</table>"

        processed_rows = [
            {"message_id": k, **v} for k, v in list(state.processed_emails.items())[-25:]
        ]

        body = f"""
<h1>State</h1>

<h2>Processed emails ({len(state.processed_emails)})</h2>
{_table(processed_rows, ["message_id", "digest_date", "edition", "query_count", "processed_at"])}

<h2>Reported matches ({len(state.reported_matches)})</h2>
{_table(state.reported_matches[-25:], ["query_id", "profile_id", "score", "action_taken", "reported_at"])}

<h2>Parse failures ({len(state.parse_failures)})</h2>
{_table(state.parse_failures[-25:], ["digest_reference", "error"])}

<h2>Pitch log ({len(state.pitch_log)})</h2>
{_table(state.pitch_log[-25:], ["query_id", "sent", "placement_result"])}
<p class="muted">Showing the most recent 25 rows per section. Full detail is in the {DEFAULT_STATE_DIR}/*.json files.</p>
"""
        return _shell("State", body)

    @app.route("/profiles")
    def view_profiles():
        try:
            profiles = load_profiles(DEFAULT_PROFILES_PATH, active_only=False)
        except Exception as exc:
            return _shell("Profiles", f"<h1>Profiles</h1><p>Could not load profiles: {html.escape(str(exc))}</p>")

        cards = ""
        for p in profiles:
            cards += f"""
<div class="card">
  <h2 style="margin-top:0">{html.escape(p.display_name)} <span class="muted">({p.id})</span></h2>
  <p><b>Active:</b> {p.active} &middot; <b>Priority:</b> {p.priority} &middot; <b>Match threshold:</b> {p.match_threshold}</p>
  <p><b>Expertise (primary):</b> {html.escape(', '.join(p.expertise_primary))}</p>
  <p><b>Expertise (secondary):</b> {html.escape(', '.join(p.expertise_secondary)) or '<span class="muted">none</span>'}</p>
  <p><b>Keywords include:</b> {html.escape(', '.join(p.keywords_include))}</p>
  <p><b>Keywords exclude:</b> {html.escape(', '.join(p.keywords_exclude)) or '<span class="muted">none</span>'}</p>
  <p><b>Geography:</b> {html.escape(str(p.geography))}</p>
  <p><b>Min hours to deadline:</b> {p.min_hours_to_deadline} &middot; <b>Outlet priority list:</b> {html.escape(', '.join(p.outlet_priority_list)) or '<span class="muted">none</span>'}</p>
</div>
"""
        body = f"<h1>Profiles</h1><p class='muted'>Loaded from {DEFAULT_PROFILES_PATH}</p>{cards}"
        return _shell("Profiles", body)

    return app


def run_server(host: str = "127.0.0.1", port: int = 5000, debug: bool = False) -> None:
    app = create_app()
    print(f" * HARO agent dashboard: http://{host}:{port}/")
    app.run(host=host, port=port, debug=debug)


if __name__ == "__main__":
    run_server()
