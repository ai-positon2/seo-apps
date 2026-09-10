# SERP Content Researcher

A full-stack tool that searches Google for the top 10 ranking pages for any keyword, scrapes their content, and generates a structured content recommendation report using Claude AI.

## What It Does

1. **Search** — Queries Google Custom Search API for the top 10 US results for your keyword
2. **Scrape** — Extracts main body content from each URL using a headless browser (Puppeteer)
3. **Analyze** — Sends all scraped content to Claude AI, which generates:
   - H2 section structure with ready-to-publish content
   - Recommendations on what competitors cover in each section
   - Word count benchmark
   - Semantic keyword list
   - Content gap analysis
4. **Export** — Download as a formatted Word document or copy as plain text

---

## Setup

### 1. Prerequisites

- Node.js 18+ installed
- A Google API key with Custom Search API enabled
- An Anthropic API key

### 2. Clone and Install

```bash
git clone <repo-url>
cd serp-content-researcher
npm install          # installs root (concurrently)
npm install --prefix server
npm install --prefix client
```

Or in one command:
```bash
npm run install:all
```

### 3. Configure Environment Variables

Edit the `.env` file in the root directory:

```env
GOOGLE_API_KEY=your_google_api_key_here
GOOGLE_CX=your_custom_search_engine_id_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
PORT=5000
```

### 4. Run the App

```bash
npm run dev
```

This starts:
- **Backend** at `http://localhost:5000`
- **Frontend** at `http://localhost:3000`

Open `http://localhost:3000` in your browser.

---

## API Keys — How to Get Them

### Google API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **"Custom Search API"** and enable it
5. Go to **APIs & Services → Credentials**
6. Click **"Create Credentials" → "API Key"**
7. Copy the key and paste it as `GOOGLE_API_KEY` in your `.env`

**Note:** The free tier of Google Custom Search API allows **100 queries per day**. After that, you'll see a quota error in the UI. To increase the limit, enable billing in Google Cloud Console (it's $5 per 1,000 additional queries).

### Google Custom Search Engine ID (CX)

1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com/)
2. Click **"Add"** to create a new search engine
3. Under "Sites to search", select **"Search the entire web"**
4. Give it a name and click **"Create"**
5. Go to your new search engine's settings
6. Copy the **"Search engine ID"** (looks like `a55677e01975a4d71`)
7. Paste it as `GOOGLE_CX` in your `.env`

### Anthropic API Key

1. Sign up or log in at [console.anthropic.com](https://console.anthropic.com/)
2. Navigate to **API Keys**
3. Click **"Create Key"**
4. Copy the key and paste it as `ANTHROPIC_API_KEY` in your `.env`

---

## Project Structure

```
serp-content-researcher/
├── .env                          # API keys and config
├── package.json                  # Root — runs both client & server
├── README.md
│
├── server/
│   ├── package.json
│   ├── server.js                 # Express app entry point
│   ├── routes/
│   │   ├── search.js             # POST /api/search
│   │   ├── scrape.js             # POST /api/scrape
│   │   ├── analyze.js            # POST /api/analyze
│   │   └── export.js             # POST /api/export/docx
│   └── services/
│       ├── googleSearch.js       # Google Custom Search API wrapper
│       ├── scraper.js            # Puppeteer-based content scraper
│       └── claude.js             # Anthropic API wrapper
│
└── client/
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── App.jsx               # Main app component
        ├── main.jsx
        ├── index.css
        └── components/
            ├── KeywordInput.jsx  # Search input
            ├── ProgressSteps.jsx # Step-by-step progress indicator
            ├── SerpUrls.jsx      # SERP results list with scrape status
            ├── ResultsTable.jsx  # Main analysis table
            └── ExportButtons.jsx # Word doc & clipboard export
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

## Rate Limits

- **Backend rate limit:** 5 API requests per minute per IP
- **Google quota:** 100 searches/day (free tier) — shown in the top-right of the UI
- **Puppeteer:** Max 3 concurrent pages, 15-second timeout per page

## Notes

- Pages that block scrapers (e.g. Cloudflare-protected sites) will be skipped gracefully — the app continues with whatever pages were successfully scraped
- If fewer than 5 pages are scraped, a warning is shown but analysis continues
- The Word document export is generated server-side and downloaded directly from the browser
- All API keys are kept server-side and never exposed to the browser
