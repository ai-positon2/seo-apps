# SEO Studio

A multi-module SEO and GEO platform. One client site — a **project** — is
crawled, audited by six modules, and reported on in one place; fifteen standalone
tools cover research, optimisation and build work alongside it.

> **The name in this README used to be "SERP Content Researcher".** That was the
> first tool in here and is now one of fifteen (`/content-research`). If you find
> documentation elsewhere in the repo describing this as a single-purpose app,
> it predates the platform.

## What it does

**The dashboard** (`/`) is about one client at a time. It leads with an
**executive summary** — what state the site is in, which way it has moved since
the last audit, how much of the work is a single template change, and the three
things to start with — then the six-module audit profile beneath it. Every figure
on it is read from a stored run; a module that has not run says so rather than
showing a zero. See `server/modules/projects/insights/` for the composition
rules, which are deliberately strict about what may be claimed.

**The six audit modules**, run together by *Run Full Audit* or individually from
their cards:

| Module | What it measures |
| --- | --- |
| Tech Audit | A full site crawl (`server/modules/crawlScope`), 96 rules, per-page findings |
| Hub and Spoke | Content architecture over the pages the crawl already stored |
| Competitor Research | SEMrush comparison against the project's tracked rivals |
| SEO & GEO | 200+ on-page and generative-engine checks, per page |
| On-Page | Per-page technical and content audit |
| AI Visibility | Brand presence across ChatGPT, Gemini, Google AI Overviews and others |

**The standalone tools** in the sidebar: Keyword Research, Content Research,
Article Recommendation, Market Potential, Content Enhancement, Article
Enhancement (and Lite), SEO & GEO Audit, Agent Readiness Audit, Image Alt Audit,
Location Page Builder, Content Architect, Knowledge Base, Crawl Scope and Robots
Monitor. Each records what it ran — see **Run Tracking** below.

---

## Setup

### 1. Prerequisites

- **Node.js 22.8 or newer.** The crawler needs 22, and the test runner needs
  22.8 for `--test-isolation`. `server/package.json` declares this in `engines`.
- **A Postgres database.** Projects, crawls, run history, workspaces and audit
  evidence are all database-backed. Without `DATABASE_URL` the dashboard reports
  "The database is not configured" and every tool that does not need persistence
  keeps working.
- API keys for whichever providers you intend to use — see `.env.example`, which
  documents every variable and which ones are optional.

### 2. Install

```bash
npm run install:all      # root, server and client
```

### 3. Configure

```bash
cp .env.example .env     # then fill it in
```

`.env.example` is the reference, not this file: it explains every variable
including which endpoint to use for migrations, which providers are optional,
and what breaks if a value is missing. The two that are not optional for the
platform (as opposed to the standalone tools) are `DATABASE_URL` and
`APP_DATA_ROOT` — see **Deploying**.

### 4. Apply the migrations

```bash
cd server && node scripts/migrate.js --status     # what is applied, what is pending
cd server && node scripts/migrate.js              # apply everything pending
```

Apply them over the database's **direct** endpoint; on Neon that is the
`DATABASE_URL` host with `-pooler` removed. The runner records what it applied
and checksums each file, so "has this database seen 0023?" is a question with an
answer. An existing database that was migrated by hand can be brought under the
runner with `--baseline-through`.

### 5. Run

```bash
npm run dev
```

- Backend on `http://localhost:5000`
- Frontend on `http://localhost:3000`, proxying `/api` to the backend

Two background processes are separate and are **not** started by `npm run dev`:

```bash
cd server && npm run worker          # the crawl worker
cd server && npm run module-worker   # the module run queue
```

Project crawls and AI Visibility runs execute in those, not in the web process,
so a queued run sits at `queued` until one is running.

---

## Tests

```bash
npm test                 # both suites
npm test --prefix server # 60 suites
npm test --prefix client # pure helpers
```

The server runner (`server/scripts/testServer.js`) runs every suite and reports
all failures, rather than stopping at the first — a chain of `&&` meant one
broken suite hid the fifty-five after it.

A few suites need a **throwaway** database with the schema applied, set as
`TEST_DATABASE_URL`; the guard refuses if it matches `DATABASE_URL`. Unset, those
suites skip.

---

## Project structure

```
.
├── .env.example              every variable, documented
├── supabase/migrations/      numbered SQL, applied by server/scripts/migrate.js
├── docs/                     deployment, unification notes, delivery backlog
├── knowledge-base/           per-brand and per-industry KB markdown
│
├── server/
│   ├── server.js             Express entry point
│   ├── scripts/
│   │   ├── migrate.js        the migration runner
│   │   └── testServer.js     the test runner
│   ├── routes/               one file per standalone tool's API
│   ├── modules/
│   │   ├── projects/         the dashboard: overview, insights, recommendations
│   │   │   └── insights/     backlog, changes, findingIndex, executive summary
│   │   ├── crawlScope/       the crawler, its worker, analyzer and rule catalog
│   │   ├── aiVisibility/     capture engines, surfaces, scoring, metrics
│   │   ├── competitorAnalysis/ onPageAudit/ contentArchitect/
│   │   ├── marketPotential/  robotsMonitor/
│   │   └── */data/           runtime file-stores (gitignored)
│   ├── locationPageBuilder/  the location + service page engine
│   │   └── data/             per-client reference data (source, committed)
│   ├── services/             db, auth, workspaces, run tracking, queues
│   └── config/               which endpoints count as a run, module registry
│
└── client/src/
    ├── App.jsx               routes, all lazy except the login path
    ├── pages/                one per screen
    ├── components/
    │   ├── studio/           the design primitives every screen draws from
    │   ├── home/             the dashboard, including ExecutiveSummary
    │   ├── crawlScope/ seoGeo/ aiVisibility/ …   per-module report views
    └── lib/                  the API clients, one per module
```

---

## Run Tracking

Every module records what it ran into the `tool_runs` table (Postgres), scoped
to a workspace, and the workspace belongs to a primary user — its creator/owner.
The history is readable in two places:

- **/runs** ("Runs" in the top bar) — every run in the active workspace, with
  filters for tool, status, who ran it and what it ran on.
- **Each module's own page** — a "Recent runs" panel at the bottom of the tool,
  showing only that tool's runs, newest first and grouped by day (Today /
  Yesterday / weekday), with an *Everyone / Just me* switch, a 30-day rollup
  line, the failure reason inline on failed runs, and the same click-through to
  a run's full input and output. It refreshes itself (5s while a run is in
  flight, 15s otherwise, plus on tab focus), so a run started on the page — or
  finished in the background — appears without a reload.

  One component does this: `client/src/components/ModuleRuns.jsx`, added to a
  page as `<ModuleRuns toolId="keyword-research" />`. Pages that are already
  about one thing scope the panel to it with the `search` prop (the label
  `page <id>` on a location page's detail view, `client <id>` on the competitor
  dashboard) so the panel lists that page's or client's runs rather than the
  whole tool's.
  `server/config/__tests__/moduleRuns.test.js` fails if a tracked tool shows its
  runs on no page, or a panel points at a tool id nothing records — both of
  which look, in the product, exactly like "this tool has never been run".

**What a run row holds:** tool, action (`run` / `export` / `save` / …), a label
(the URL, keyword or client it ran on), who ran it, which workspace, status
(`running` / `completed` / `failed` / `cancelled`), duration, and a sanitized,
size-capped copy of the input and output.

**How it is captured** — `server/middleware/runTracking.js`, installed once per
API mount, observes the request/response instead of each route being rewritten.
It handles the three run shapes in this codebase:

| Shape | Modules | How the outcome is captured |
| --- | --- | --- |
| JSON request → response | SEO & GEO Audit, Content Enhancement, Market Potential, Agent Readiness, KB saves | HTTP status + response body |
| `POST /init` → `GET /stream/:token` (SSE) | Keyword Research, Article Recommendation, Article Enhancement (+ Lite), Image Alt Audit, Location Pages | Input bridged from `/init` by token; outcome from the terminal SSE event (`done`/`complete` vs `fail`/`error`) |
| Response returns, work continues in the background | On-Page Audit, Robots Monitor, Competitor Tracker, Competitor Report | Row opens as `running`; the module closes it with `req.run.finish()` / `req.run.fail()` |

**Which endpoints count as a run** is declared in one place:
`server/config/runTracking.js`. Status polls, result fetches and settings are
deliberately not tracked; sub-steps of a larger run (`/api/search` and
`/api/scrape`, which feed `/api/analyze`) are recorded as the one run they
belong to. `server/config/__tests__/registry.test.js` fails if a matcher there
stops corresponding to a real route.

**Workspaces.** A user's runs land in their active workspace — chosen on the
Workspaces page ("Use this workspace", stored in a `workspace_id` cookie and
membership-checked on every use). Until someone picks one, their runs go to
their own personal workspace, created on their first run and owned by them;
being added to a teammate's workspace never silently starts recording your runs
there, so a team sharing one run history means each member switching to it once.
Platform-embed sessions (shared iframe token, no individual user) are attributed
to one synthetic user and workspace rather than being dropped.

**Safety properties** worth keeping if you touch this:

- Tracking never breaks a tool: the store swallows and logs its own errors, and
  nothing is awaited in the request path.
- Payloads are sanitized before storage — keys that look like credentials are
  redacted, content blobs (HTML, pasted articles, CSV uploads) are reduced to
  size markers, and anything over 16 KB is summarized and flagged as truncated.
- Runs still `running` after two hours are swept to `failed`, so a crash or
  deploy mid-run can't leave rows dangling.

Requires `DATABASE_URL` and the migrations in `supabase/migrations/`. Without it
the app runs exactly as before and records nothing.

The server connects straight to Postgres (`server/services/db.js`) — there is no
REST layer, no service-role key, and nothing database-related reaches the
browser. Apply the migrations over the connection's **direct** endpoint; on Neon
that is the `DATABASE_URL` host with `-pooler` removed.

---

## Deploying

See **[docs/deployment.md](docs/deployment.md)** before deploying anywhere.

Two things there are easy to miss and both have bitten this app:

- **`APP_DATA_ROOT` must point at a mounted volume.** Six modules still keep
  their state as JSON on disk. Without a volume the container ships that
  directory empty and every deploy silently resets them — Content Architect
  projects, saved comparisons, monitor history. Nothing errors; the screen just
  says the data is not there.
- **Host the app in the same region as its database.** The app makes several
  sequential queries per request, so distance between the two is multiplied by
  every one of them. Measured: a trivial query costs 264 ms across continents
  and 0.22 ms alongside.

## Rate limits

Three limiters, per IP per minute (`server/server.js`). They exist because the
screens differ enormously in how chatty they are, not to ration work:

| Limit | Applies to |
| --- | --- |
| 20/min | Everything, by default |
| 100/min | Knowledge Base and `/api/runs`, `/api/admin` — the KB editor auto-saves |
| 300/min | Location Page Builder, AI Visibility and `/api/projects` — dashboard, wizard, CRUD and SSE together |

Rate limiting runs **before** body parsing, so an unauthenticated flood of 20 MB
JSON bodies is throttled rather than parsed first.

Provider quotas are separate and per provider. The Google Custom Search free
tier is 100 queries/day and the remaining quota is shown in the UI; SEMrush is
metered in units and the app states the estimated cost before spending it.

## Notes

- **Scraping fails gracefully.** Pages that block scrapers (Cloudflare and
  similar) are skipped and the run continues with what it did get. The
  single-page scraper caps at 3 concurrent pages with a 15-second timeout; the
  site crawler (`server/modules/crawlScope`) is a different engine with its own
  politeness, budget and stop controls.
- **A stopped crawl is a partial audit, not a lost one** — it still stores its
  findings through the normal completion path.
- **API keys stay server-side.** Nothing database- or credential-related reaches
  the browser; there is no REST layer and no service-role key.
- **`data/` directories under `server/modules/` are runtime state** and are
  gitignored. `server/locationPageBuilder/data/` is not — it is per-client
  reference source and is meant to be committed. See the README in that folder
  for why that distinction once broke a deploy.
