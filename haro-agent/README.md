# HARO Monitoring Agent

Scans a mailbox for HARO digest emails, parses every query, scores each one against
your expert profiles, and produces a Markdown report of what's worth pitching. It
never sends, replies, or archives anything — every mailbox adapter is read-only, and
pitches/briefing notes are always drafts for a human to review and send.

Built from `haro-agent-prompt.md` (the full spec). See that file for the detailed
rules this implements.

## How it's split up

- **Deterministic Python** (no API key needed): digest identification (`identify.py`),
  parsing (`parser.py`, `deadline.py`), Stage 1 hard filters (`filters.py`), state
  (`state.py`), and report rendering (`report.py`).
- **Claude-backed** (`llm.py`, `scorer.py`, `pitch.py`): Stage 2 relevance scoring
  (topical fit, source-type fit, answerability, outlet value), rationale writing, and
  pitch/briefing drafting — these are judgment and generation tasks, not something
  regex should be doing. Deadline feasibility (the 5th scoring component) is computed
  deterministically from `hours_remaining`, not by the model.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

(If `python` resolves to the Microsoft Store stub on Windows, install a real Python
first — this project was set up with `winget install -e --id Python.Python.3.12`.)

## Running it locally — no mailbox needed

The `local` mailbox adapter reads plain-text email fixtures from a folder instead of
a real inbox, so you can test the entire pipeline (identify → parse → filter → score
→ draft → report) with zero mailbox setup. Three sample digests are already in
`samples/`:

- `digest_evening_normal.txt` — a 6-query digest mirroring the spec's worked example
  (Appendix A): an antitrust attorney query, an MD-required query, a dermatologist
  query, a forensic-psychologist query, a dental query, and a crypto/iPhone query
  that should get excluded by keyword.
- `digest_no_ai_pitch.txt` — exercises the `No AI Pitches Considered` flag (produces
  a briefing note instead of a send-ready draft).
- `digest_forwarded_malformed.txt` — a manually-forwarded digest (Outlook-style
  wrapper + `>` quoting) with one deliberately malformed query block, to exercise
  forwarding-wrapper stripping and `parse_failed` logging.

Two example expert profiles are in `config/profiles.example.yaml`: a dental clinical
spokesperson roster and a behavioral-health/forensic-psychology roster — the same
pairing the spec's Appendix A uses to show that a query should score high for one
profile and correctly score zero for an unrelated one.

**Run without an API key** (offline heuristic scoring, to sanity-check the plumbing):

```powershell
.\.venv\Scripts\python.exe -m haro_agent.cli run --source local --llm mock --as-of 2026-08-24T21:00:00
```

**Run with real Claude scoring and pitch drafting** (needs `ANTHROPIC_API_KEY`):

```powershell
.\.venv\Scripts\python.exe -m haro_agent.cli run --source local --llm claude --as-of 2026-08-24T21:00:00
```

`--as-of` fixes the reference time used to compute `hours_remaining`, so results are
reproducible regardless of when you actually run it (the sample digests are dated
around 2026-08-24-25). Drop it to use the real current time.

Each run prints the Markdown report to stdout, writes it to `reports/`, and persists
state to `state/` (`processed_emails.json`, `reported_matches.json`,
`parse_failures.json`, `pitch_log.json`). Idempotency is real: running the same
command twice in a row produces zero new matches the second time, because the digest
message IDs are already in `processed_emails.json`. Delete the files in `state/` (or
point `--state-dir` elsewhere) to start over.

## Local web dashboard

If you'd rather click a button than run CLI commands, there's a small local-only
Flask dashboard:

```powershell
.\.venv\Scripts\python.exe -m haro_agent.cli serve --port 5000
```

Then open **http://127.0.0.1:5000/** in a browser. It has:

- **Dashboard** — state summary, link to the most recent report, and a "Run now"
  form (choose `local`/`gmail` source and `mock`/`claude` scoring, no CLI needed).
- **Reports** — every past run's report, rendered from Markdown to HTML.
- **State** — the last 25 rows of each state store (processed emails, reported
  matches, parse failures, pitch log).
- **Profiles** — a read-only view of the loaded expert profiles.

It binds to `127.0.0.1` only (not `0.0.0.0`) — it's for local testing, not for
exposing on a network. Stop it with Ctrl+C in the terminal it's running in.

### Testing with your own real HARO digests

Drop `.txt` files into `samples/` in this format — a simple header block, a blank
line, then the raw digest body:

```
From: HARO <replies@helpareporter.com>
To: your-inbox@yourcompany.com
Subject: HARO Queries for <Month> <DD>, <YYYY> - <Edition> Edition

<paste the full digest body here, unmodified>
```

Then rerun the `run` command above (with a fresh `--state-dir` or after clearing
`state/` if you want them treated as new). No code changes needed — the parser is
built from the same field-extraction rules the spec documents, not from the specific
sample text.

## Running the unit tests

```powershell
.\.venv\Scripts\python.exe -m pytest tests\ -v
```

These cover digest identification, parsing edge cases (year rollover, forwarding
wrapper stripping, malformed blocks, `No AI Pitches Considered`), hard filters
(reproducing the spec's Appendix A worked example), and the scorer's keyword+semantic
anti-drift gate — all without needing an API key.

## Connecting a real mailbox (Gmail)

`mailbox/gmail.py` is a read-only Gmail API adapter (OAuth, `gmail.readonly` scope
only — this codebase has no code path capable of sending mail). To use it:

1. `.\.venv\Scripts\pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib`
   (commented out in `requirements.txt` by default since local testing doesn't need them).
2. In Google Cloud Console, create an OAuth client ID (Desktop app type) for a project
   with the Gmail API enabled, and download the client secret JSON.
3. Set `GOOGLE_OAUTH_CLIENT_SECRET_FILE` in `.env` to that file's path.
4. Optionally set `GMAIL_LABEL` (default `HARO`) if you route HARO into its own label.
5. Run with `--source gmail`. The first run opens a browser for one-time OAuth
   consent and saves a token to `GMAIL_TOKEN_FILE` (default `gmail_token.json`) for
   subsequent runs.

If your inbox is a Google Workspace account (e.g. `@position2.com`) and you don't
have permission to create OAuth clients in Google Cloud Console yourself, ask
whoever administers your Workspace's Google Cloud project to create one (or grant
you access) — this is a one-time setup step done through Google's own console, not
something this codebase can do on your behalf.

## Slack notifications

`--notify slack` posts one message per Priority/Qualified match to a Slack channel
via an Incoming Webhook (see `.env.example` for where `SLACK_WEBHOOK_URL` goes):

1. In Slack: **Workspace settings > Manage apps** (or visit
   https://api.slack.com/apps > **Create New App > From scratch**), then under
   **Incoming Webhooks**, toggle it on and **Add New Webhook to Workspace**, picking
   the channel you want alerts in.
2. Copy the webhook URL (`https://hooks.slack.com/services/...`) into
   `SLACK_WEBHOOK_URL` in `.env`.
3. Run with `--notify slack`, e.g.:
   `python -m haro_agent.cli run --source local --llm mock --notify slack`

Test it first with `--notify console` (prints the exact message instead of posting)
so you can see the formatting without spamming the channel. Only Priority (≥85) and
Qualified (≥`match_threshold`) matches notify — Borderline matches still show up in
the report but don't page anyone.

## Production: push-based ingestion (CloudMailin + Railway)

If you don't have DNS/domain control (so the Gmail-polling path above isn't an
option) or you'd rather react to HARO digests the instant they arrive instead of
polling on a schedule, the app can run as an always-on webhook receiver instead:
the real HARO subscriber forwards digests to a CloudMailin inbound address (no DNS
needed), and CloudMailin POSTs each one straight to the app's
`/webhook/inbound-email` route, which runs the exact same identify → parse → filter
→ score → draft → notify pipeline per email as it arrives.

### 1. Forward HARO digests out of the real subscriber's inbox

On the real subscriber's Gmail (e.g. `somesh.das@position2.com`):

1. **Settings → Forwarding and POP/IMAP → Add a forwarding address** → enter the
   CloudMailin address from step 2 below (you'll do this after step 2, since Gmail
   needs that address to exist first to send it a verification code).
2. Create a **filter**: `from:(helpareporter.com)` → **Forward it to:** the
   CloudMailin address. Scoping the forward to just HARO's sender keeps the rest of
   that inbox private from this pipeline.

### 2. CloudMailin (receives the forwarded mail, no DNS needed)

1. Sign up at cloudmailin.com and create an address — it hands you a ready
   `xxxx@cloudmailin.net` immediately, nothing to configure in DNS.
2. Set the **Target URL** to
   `https://<WEBHOOK_AUTH_USER>:<WEBHOOK_AUTH_PASS>@<your-app>.up.railway.app/webhook/inbound-email`
   (pick any username/password — they're compared against the
   `WEBHOOK_AUTH_USER`/`WEBHOOK_AUTH_PASS` env vars set on Railway below, not a real
   account).
3. Set the **Target Format** to **JSON Normalized** — that's what `inbound.py` parses.

### 3. Deploy to Railway

1. `railway login` (opens a browser — has to be you) and `railway link` to the
   existing project, or `railway init` for a new one.
2. Add a **Volume** mounted at `/data` (Railway dashboard → your service →
   Volumes) so match history/state survives redeploys.
3. Set these environment variables on the Railway service:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Claude API key |
   | `LLM_MODE` | `claude` |
   | `SLACK_WEBHOOK_URL` | from the Slack setup above |
   | `NOTIFY_MODE` | `slack` |
   | `WEBHOOK_AUTH_USER` / `WEBHOOK_AUTH_PASS` | whatever you put in CloudMailin's target URL |
   | `DASHBOARD_AUTH_USER` / `DASHBOARD_AUTH_PASS` | credentials to view the dashboard — **set these**, since Railway gives the app a public URL and the dashboard shows reply-to addresses and draft pitches |
   | `STATE_DIR` | `/data/state` |
   | `REPORTS_DIR` | `/data/reports` |

4. `railway up` (or push to the connected repo/branch) to deploy. Railway detects
   the `Procfile` and runs `gunicorn "haro_agent.webapp:create_app()"` — the Flask
   dev server (`cli.py serve`) is for local testing only, not production.

### Testing the webhook before any of the above exists

`tests/test_webhook.py` posts a synthetic CloudMailin-shaped JSON payload straight
at `/webhook/inbound-email` via Flask's test client — Basic Auth, a valid digest,
idempotent redelivery, and a malformed payload are all covered without a real
CloudMailin account or Railway deployment. Run `pytest tests/test_webhook.py -v`.
To try it manually against a locally-running dashboard, POST a similar JSON body
with Basic Auth headers to `http://127.0.0.1:5000/webhook/inbound-email`.

Once CloudMailin is wired up, send a test email through it (most inbound-email
services have a "send test message" button) and confirm it shows up on the deployed
app's `/state` page.

## Polling instead (Gmail OAuth, if you do have DNS/Cloud Console access)

The spec's original design is polling every 3 hours, 6am–11pm IST, 5+ runs/day (3 on
weekends) rather than push-based. This CLI is a single run; scheduling is external —
wire up Windows Task Scheduler (or cron/whatever runs this) to call
`python -m haro_agent.cli run --source gmail --llm claude --notify slack` on that
cadence. A manual run is just running the same command on demand. This is an
alternative to the CloudMailin/Railway push setup above, not required alongside it.

## Configuring expert profiles

Edit `config/profiles.example.yaml` (or copy it to `config/profiles.yaml` and point
`--profiles` at that) — see the spec's §5 and Appendix B for the full field
reference. `match_threshold` is the report cutoff per profile (default 70); scores
≥85 are always "Priority" and get an automatic draft, ≥`match_threshold` are
"Qualified" and also get a draft, 55+ are "Borderline" one-liners with no draft, and
below 55 is discarded and logged only.
