# Site Audit Screens — Build Spec

**For:** `seo-apps-nikhil-tests` (React 18 + Vite client / Express + Supabase server)
**Source of the pattern:** Semrush Site Audit, campaign 30139488 (`utimaco.com`), observed 2026-08-24
**Audience:** Claude Code, working inside this repo
**Status:** implementation spec — read §0 and §12 before writing any code

---

## 0. Read this first

This repo **already has a site audit engine**. `server/modules/crawlScope/` is a 92-check SEO crawler with a persisted issue catalog, a severity model, per-run findings, a reviewer workflow, and three screens (`/crawl-scope`, `/crawl-scope/runs/:id`, `/crawl-scope/runs/:id/review`).

So this project is **not "build a crawler"**. It is:

> Take the crawl data we already store, and re-present it as a Semrush-grade Site Audit product surface.

Roughly 80% of the work is composition, routing, aggregation queries and chart components. Roughly 20% is new persistence (thematic scores, a health-score history table, a per-check registry keyed to the catalog).

Three hard constraints from `sitewide-seo-platform-status.md` govern everything below. They are asserted by tests. Do not break them to make a screen look nicer:

1. **Never coerce a missing measurement to zero.** No rubric → `score: null`, `scored: false`, render an em dash. A composite with insufficient inputs is `null` with `status: 'insufficient_data'`, never `0`.
2. **A score must carry its basis.** `project_module_runs` has `CHECK (score IS NULL OR score_basis IS NOT NULL)`. Every score this spec introduces must ship with a machine-readable basis string.
3. **No `priorityScore` / `impactScore` fields.** Ordering is a *sort over stated facts*, and each row renders the sentence explaining its own position.

Also: `README.md` is stale. `sitewide-seo-platform-status.md` is the architecture of record.

---

## 1. The mental model Semrush uses

Everything on the surface derives from a four-level hierarchy. Get this right and the screens fall out of it.

```
Project (a site + crawl config)      → crawl_projects
  └─ Crawl run (a dated snapshot)    → crawl_runs
       ├─ Crawled page (one URL)     → crawl_run_results / project_pages
       ├─ Check (a rule, ~100 of them, fixed catalog)
       └─ Finding (check × page, the actual defect instance)
                                     → crawl_run_findings + summary.findings
```

Four derived layers sit on top, and each one is a screen:

| Layer | What it is | Screen |
|---|---|---|
| **Portfolio** | one row per project, latest run only | Site Audit Home |
| **Snapshot** | one run, summarized | Overview dashboard |
| **Thematic** | one run, sliced by subject area | Crawlability / Performance / Linking / … |
| **Instance** | one check, every failing page | Issue detail |

And two time layers:

| Layer | What it is | Screen |
|---|---|---|
| **Diff** | run A vs run B, per check, with Fixed/New | Compare Crawls |
| **Trend** | any metric over all runs | Progress |

**The single most important design idea in Semrush Site Audit:** every number on every screen is a *link into a filtered list of URLs*. A count you cannot click is a dead end. Build every count as a link.

---

## 2. Screen inventory and routing

Follow the existing router shape in `client/src/App.jsx` (react-router-dom v6, flat `<Routes>`, all children of `<MacWindow />`). Pages are `PascalCase` + `Page.jsx` suffix in `client/src/pages/`.

| # | Screen | Proposed route | Semrush equivalent | New or extends |
|---|---|---|---|---|
| 1 | Site Audit Home | `/site-audit` | `/siteaudit/` | New |
| 2 | Audit Overview | `/site-audit/:runId` | `…/review/overview` | New |
| 3 | Issues | `/site-audit/:runId/issues` | `…/review/issues` | Extends `CrawlScopeReviewPage` |
| 4 | Issue detail | `/site-audit/:runId/issues/:ruleId` | `…/review/issue/detail/:id` | New |
| 5 | Crawled Pages | `/site-audit/:runId/pages` | `…/review/pagereport/pages` | Extends `ResultsTable` |
| 5b | Site Structure | `/site-audit/:runId/structure` | `…/review/pagereport/structure` | New |
| 6 | Statistics | `/site-audit/:runId/statistics` | `…/review/statistics/tile` | New |
| 7 | Compare Crawls | `/site-audit/:runId/compare` | `…/review/compare` | New |
| 8 | Progress | `/site-audit/:runId/progress` | `…/review/history` | New |
| 9 | Thematic report | `/site-audit/:runId/report/:themeKey` | `…/review/crawlability` etc. | New |

Note Semrush's own URLs are inconsistent (`/review/linking` for "Internal Linking", `/review/history` for "Progress", `/review/performance` for "Site Performance"). **Do not copy that.** Use `:themeKey` from a single registry so every theme is one route.

Register the tool in `client/src/toolsMeta.js` under the **Monitor** group, tag `beta`. Label it **Site Audit** — distinct from the existing "Site Crawler", which stays as the raw run/debug surface.

---

## 3. Screen 1 — Site Audit Home (portfolio)

**Route:** `/site-audit`

This is the screen most people mean by "the site audit homepage". It is a **portfolio table, not a dashboard.** One row per project, showing the latest run only. No hero chart, no marketing panel.

### Layout

```
┌───────────────────────────────────────────────────────────────────┐
│ Site Audit                                    [+ New audit]       │
│ ┌─────────────────────┐                                           │
│ │ 🔍 Project or domain│                                           │
│ └─────────────────────┘                                           │
├───────────────────────────────────────────────────────────────────┤
│ Project │ Last  │ Pages   │ Site  │ Errors │ Warn │ Crawl │ Perf │…│
│         │ Update│ Crawled │Health │        │      │ ability│     │ │
├───────────────────────────────────────────────────────────────────┤
│ utimaco │ 6d ago│ 4,161   │  75%  │  640   │4,802 │  81%  │ 79% │ │
│ .com    │       │ /15,000 │  -8%  │  +406  │+4,527│  -7%  │ -21%│ │
│ ⚙ 👥    │       │         │       │        │      │       │     │ │
└───────────────────────────────────────────────────────────────────┘
                                          Prev  Next   Page 1 of 3
```

### Columns (exact set observed)

| Column | Type | Notes |
|---|---|---|
| Project | name (link) + domain (muted) + gear + share icons | two-line cell |
| Last Update | relative time | `14h ago`, `2d ago`, `3w ago` |
| Pages Crawled | `crawled / limit` | ⚠ icon when `crawled === limit` (cap hit) |
| Site Health | % | |
| AI Search Health | % | *skip in v1 — we have no equivalent measurement* |
| Errors | integer | |
| Warnings | integer | |
| Crawlability | % | |
| HTTPS | % | |
| Int. SEO | % or `Not implemented` | |
| Site Performance | % | |
| Internal Linking | % | |
| Markups | % | |
| Core Web Vitals | % | `0%` when no CrUX/PSI connection |

### The delta pattern — build this as a primitive first

Every metric cell is **two stacked lines**: current value on top, delta from the previous run underneath, in a smaller muted-but-colored type.

```
 75%
 -8%
```

Rules, observed and non-obvious:

- Delta is **signed and always rendered**, including `0%` / `0`. Absence of change is information.
- Delta **color is semantic, not arithmetic**. On Errors, `+406` is red and `-1,067` is green. On Site Health, `-8%` is red and `+9%` is green. Each metric declares its own polarity.
- When there is no prior run, render an em dash — **not** `0`. (This is constraint #1.)
- `Not implemented` is a distinct third state from `0%` and `—`. It means the check family does not apply to this site. Keep it.

Implement as `client/src/components/siteAudit/MetricDelta.jsx`:

```jsx
/*
 * MetricDelta — value over signed delta.
 *
 * `polarity` says which direction is good, because the same "+406" is bad on
 * Errors and good on Pages Crawled. Getting this from the metric registry rather
 * than from the sign is the whole point of the component: it is the mistake this
 * component exists to prevent.
 *
 * A null/undefined delta renders an em dash. It NEVER renders as 0 — a first run
 * has no delta, and showing 0 would claim "nothing changed", which is a different
 * and false statement. See constraint #1 in the site audit spec.
 */
```

Reuse `STATUS` from `ui/Badge.jsx` for the delta colors so there is one source of truth for success/danger.

### Sorting & paging

- Every column sortable; sort state in the URL (`?sort=health_asc`).
- 10 rows per page. Semrush uses a hash route for paging — **use querystring instead**, consistent with the rest of this repo.

### Data

One query. Add a repo method in `server/modules/crawlScope/db/repo.js`:

```
GET /api/site-audit/projects
→ { projects: [{
      id, name, url, workspaceId,
      lastRun: { id, finishedAt, pagesCrawled, pageLimit, capped },
      scores: { health, crawlability, https, intlSeo, performance, linking, markup },
      counts: { errors, warnings, notices },
      deltas: { health, errors, warnings, crawlability, ... }   // null when no prior run
    }] }
```

Compute deltas server-side against the immediately-preceding **completed** run of the same project. Do not compute them in the browser — the client would need two full runs per project.

**Workspace filter is mandatory on this query.** There is no RLS; the filter *is* the tenancy check.

---

## 4. Screen 2 — Audit Overview (the snapshot dashboard)

**Route:** `/site-audit/:runId`

### Persistent header (appears on screens 2–9)

```
┌───────────────────────────────────────────────────────────────────┐
│ Site Audit: Utimaco July ▾        [↻ Rerun] [PDF] [Export] [⚙]    │
│ utimaco.com · Updated: Tue, Aug 18, 2026 · 📱 Mobile ·             │
│ JS rendering: Disabled · Pages crawled: 4,161/15,000 ·             │
│ Excluded checks: 3                                                 │
├───────────────────────────────────────────────────────────────────┤
│ Overview │ Issues │ Crawled Pages │ Statistics │ Compare │ Progress│
└───────────────────────────────────────────────────────────────────┘
```

Two things worth stealing:

1. **The campaign name is a dropdown**, so you can switch projects without going home. Cheap, used constantly.
2. **The metadata strip is the crawl's provenance.** Device, JS rendering, page count vs limit, excluded-check count. It answers "why does this number look wrong" before the user asks. `Excluded checks: 3` is a link to the settings.

Build as `components/siteAudit/AuditHeader.jsx`. It is close in spirit to the existing `components/project/ProjectReportBar.jsx` — extend that rather than starting fresh if the shape fits.

Map to this repo's crawl options (`server/modules/crawlScope/shared/options.js`):

| Semrush strip item | Our field |
|---|---|
| Mobile / Desktop | user agent (we don't vary this yet — omit or hardcode) |
| JS rendering | we use `cheerio`, not `puppeteer-core`, for the main pass → `Disabled` |
| Pages crawled: n/limit | `run.progress.crawled` / `options.maxUrls` |
| Excluded checks: n | new — see §11 |

⚠️ **The live crawl cap is whatever `admin_limit_policies.maxUrlsPerCrawl` is set to** for the workspace — read it from Admin → Limits, or `GET /api/crawlscope/limits`, rather than from this document or from `.env`. It has been as low as 50 and the built-in default is 500. `MAX_URLS_CEILING` is only a fallback for a server that cannot reach the limits table; it no longer caps a crawl.

Design for the low end: every screen must render honestly at n=50. Do not design a dashboard that only reads well at n=4,000.

### Body layout

Four regions, top to bottom:

**Region 1 — KPI row (4 cards, equal width)**

| Card | Content |
|---|---|
| Site Health | Half-donut gauge, big `75%`, delta `-8`. Below: `Your site 75%` vs a benchmark row `Top-10% websites 92%` with the benchmark as a dropdown. |
| Crawled Pages | Big `4,161` + delta. A thin stacked bar. Then a legend-as-table: Healthy / Broken / Have issues / Redirects / Blocked, each with count and delta. |
| AI Search Health | *Skip in v1.* We have `agent-readiness` as a separate module — link to it instead of faking a score. |
| Blocked from AI Search | Bot-by-bot list with ✓ All good. We have `robots-parser` and the Robots Monitor module — this is genuinely buildable. |

The **Crawled Pages card is the best-designed thing on the page** and the easiest win. Five mutually exclusive page states derived from one crawl:

| State | Definition | Colour |
|---|---|---|
| Healthy | 2xx, indexable, zero findings | success |
| Broken | 4xx or 5xx | danger |
| Have issues | 2xx, indexable, ≥1 finding | warning |
| Redirects | 3xx | info |
| Blocked | robots.txt / meta noindex / X-Robots-Tag | neutral |

**Evaluate in that exact order** — a 404 that also has a missing title is "Broken", not "Have issues". Classify once, server-side, and store on the row. Do not recompute per widget or the totals will disagree across screens.

Note in the sample data: Healthy = 1 out of 4,161. That is the normal state of a real site. **Design the card so a 1-pixel green sliver still reads.** Minimum segment width, not proportional-only.

**Region 2 — Errors & Warnings sparklines + Top issues (2 cols, ~40/60)**

Left: two stacked mini-charts, `Errors 640 +406` with a red area sparkline, `Warnings 4,802 +4,527` with an amber one. Y-axis labelled `0` and a rounded max (`12K`, `28K`). Roughly 8 crawl points.

Right: **Top 5 issues.** Each row: severity icon · title · `47 pages` (link) · `How to fix` (link). Footer: `View all issues →`.

Ranking for the top-5 — **and this is where constraint #3 bites.** Semrush appears to rank by raw affected-page count, which is why 13,420 anchor-text notices outrank 2 pages returning 4xx. That is bad advice. Use a sort over stated facts:

```
ORDER BY severity_rank ASC,        -- error < warning < notice
         catalog_priority ASC,     -- High < Medium < Good-to-have (already in issue-catalog.json)
         affected_pages DESC
```

and render the reason on the row, e.g. *"Error · High priority · 47 pages"*. No composite number.

**Region 3 — Thematic report cards**

A 4-across grid of small cards. Each: title, a small progress ring, `81%`, delta `-7`, and a `View details` button.

Observed set: Robots.txt (special — no score, shows `No changes` / `Open file`), Crawlability, HTTPS, International SEO, Core Web Vitals, Site Performance, Internal Linking, Markup.

Use the existing `ui/ScoreRing.jsx`. **Its band thresholds are `>=70 success / >=45 warning / else danger`, while `components/home/AuditRadar.jsx` uses `>=80 / >=60`.** Pick one and unify before building this, or the same 79% will be green on one screen and amber on another.

**Region 4 —** Semrush puts a Crazy Egg upsell here. Skip.

---

## 5. Screen 3 — Issues

**Route:** `/site-audit/:runId/issues`

The workhorse screen. This repo already has most of it in `CrawlScopeReviewPage.jsx` (22KB) — that page's review workflow is *better* than Semrush's, which has no triage state at all. Keep our review vocabulary (`Needs review | Confirmed issue | False positive | Resolved`) and add Semrush's filtering and grouping on top.

### Filter bar

```
┌──────────┬─────────────────────────────────────────┬─────────────────────────┐
│ 🔍Search │ All 25 │ AI Search 3 │ Crawlability 11 │ │ All 25 │ Errors 9 │…  │
│          │ Content 4 │ Meta tags 6 │ ⋯              │ │ Warnings 9│Notices 7│
│          │                                          │ │ [With issues ✕]      │
└──────────┴─────────────────────────────────────────┴─────────────────────────┘
```

Three independent filter groups on one row:

1. **Category chips**, each carrying its own count. Overflow past 4 goes into a `⋯` dropdown that *also* shows counts, including zeros. Full category set observed: `AI Search, Crawlability, Content, Meta tags, Indexability, Duplicates, HTTP Status, Links, Site Performance, Mobile SEO, Canonicalization, Security and HTTPS`.
2. **Severity chips**: All / Errors / Warnings / Notices, with counts.
3. **A removable "With issues" pill** — the default filter, hiding the ~105 checks that passed. Removing it shows every check including zero-count ones.

Our `issue-catalog.json` already has `category` on every rule (8 categories: Indexability 30, Technical 17, Metadata 15, Accessibility & Social 8, Content 7, Links 7, Performance 4, Structured Data 4). **A rule can belong to more than one category** — the duplicate-meta-description check shows `Category: Meta tags, Duplicates, Indexability`. Model this as an array. If our catalog is single-valued, keep it single-valued and don't invent memberships.

### Filter state lives in the URL

Semrush base64-encodes a JSON object into a `restrictions` param:

```
?restrictions=eyJzZWFyY2giOiIiLCJzZXZlcml0eSI6ImFsbCIsImNoZWNrcyI6Im5vbnplcm8ifQ==
→ {"search":"","severity":"all","checks":"nonzero"}
```

**Copy the idea, not the encoding.** Base64 makes URLs unreadable and undebuggable. Use plain params:

```
/site-audit/:runId/issues?severity=error&category=crawlability&q=hreflang&checks=nonzero
```

This matters because it powers cross-screen navigation (§7).

### Issue rows, grouped by severity

```
Errors (9)                                            ╭───────╮
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ (red rule)
336 pages have duplicate meta descriptions  How to fix
                              251 new issues  ▁▂▅▃  [↗ Send to…] [👁]
```

- Group header with a **coloured 2px horizontal rule** underneath: red / amber / blue.
- **The count is baked into the sentence**, and only the count is a link: "**336 pages** have duplicate meta descriptions". Not "Duplicate meta descriptions — 336". The sentence form is more scannable and states the unit (pages vs issues vs items vs links). Our `issue-catalog.json` has `title` — add a `sentenceTemplate` field with a `{n}` slot and a `unit`.
- `How to fix` opens the explainer popover (§6).
- `251 new issues` — delta since previous run, itself a link to a filtered view.
- A per-check sparkline.
- `Send to…` → Trello / Zapier. **We should send to our own `recommendations` table instead** — the table already exists (`recommendations`, migration 0013, with `rule_id`, `evidence jsonb`, and a draft→proposed→approved→shipped lifecycle) and `POST /api/projects/:projectId/recommendations/from-findings` already does this. Wire the button to that.
- 👁 eye icon = hide/exclude this check.

---

## 6. Screen 4 — Issue detail

**Route:** `/site-audit/:runId/issues/:ruleId`

```
[← All issues]
┌─────────────────────────────────────────────────────────────────┐
│ 336 pages have duplicate meta descriptions  [Error]             │
│                        [↗ Send to…] [⊞ Site Structure] [👁 Exclude]│
│ ⓘ How to fix              Failed: 336  Successful: 17,217,194 ▓▓▓│
│ ┌────────┬────────┐ ┌────────┐ ┌──────────────┐                 │
│ │Issues 336│Hidden 0│ │ Search │ │Advanced filters ▾│            │
│ └────────┴────────┘ └────────┘ └──────────────┘                 │
├────┬──────────────────────────┬───────────┬───────────┬─────────┤
│ ☐  │ Page URL              ⇅  │ Duplicates│ Discovered│         │
├────┼──────────────────────────┼───────────┼───────────┼─────────┤
│ ☐  │ Gen AI Data Protection…  │ › 1 page  │ Aug 11    │      👁 │
│    │ https://utimaco.com/…    │           │           │         │
└────┴──────────────────────────┴───────────┴───────────┴─────────┘
```

### Five things to copy exactly

**1. Failed vs Successful.** `Failed: 336  Successful: 17,217,194` with a proportion bar. This reframes 336 defects as 336-out-of-17-million, which is the honest reading. The denominator is *check executions*, not pages — one page can be checked many times (once per link, per image, per hreflang pair). Track and store both.

**2. The How-to-fix popover is two columns.**

| About the issue | How to fix |
|---|---|
| What the crawler considers a match ("only if they are exact matches") | The remediation |
| What the thing is | Links to primary sources (Google docs) |
| Why it matters | Links to our own KB |
| `Category: Meta tags, Duplicates, Indexability` | |

Our `issue-catalog.json` already carries `title`, `description`, `recommendation`, `category`, `priority`, `severity`, `detection` — that is nearly the whole popover. Add a `detectionNote` (the "only exact matches" sentence, which prevents most false-positive reports) and a `references[]` array. Pull the "how to fix" body from `knowledge-base/` where an article exists.

**3. Table columns are per-check.** This is the key structural insight, and the thing most people get wrong by building one generic table.

| Check | Columns |
|---|---|
| Duplicate meta descriptions (id 15) | Page URL, **Duplicates** (expandable), Discovered |
| Broken external links (id 12) | Page URL, **Link URL**, **HTTP Status Code** (badge), Discovered |
| Slow load speed | Page URL, **Load Time**, Discovered |

Add a `columns[]` descriptor to each rule in `issue-catalog.json`:

```json
{
  "id": "meta-duplicate",
  "columns": [
    { "key": "url",        "label": "Page URL",   "type": "url",    "sortable": true },
    { "key": "duplicates", "label": "Duplicates", "type": "expand", "unit": "page" },
    { "key": "firstSeen",  "label": "Discovered", "type": "date" }
  ],
  "filterFields": ["url"]
}
```

Then one `<IssueDetailTable>` renders every check from its descriptor. Extend `ui/DataTable.jsx` rather than writing a new table.

**4. Row expansion shows the *sibling* rows.** Clicking `› 2 pages` on a duplicate-meta row expands in place to list the other URLs sharing that description, **with the differing part of the URL highlighted** (`/qday-li` vs `/qday`). For any grouped defect — duplicate content, duplicate titles, redirect chains, hreflang clusters — the group is the finding, not the row.

**5. `Discovered` + a `New` badge.** Every finding carries a first-seen timestamp, and anything first seen in the current run gets a `New` pill. Our `project_pages` table already has `first_seen_at` / `first_seen_run`; we need the same on findings. `crawl_run_findings` currently aggregates by `rule_id` — we need a stable per-instance identity to carry first-seen across runs. Suggested key: `sha1(rule_id + canonical_key + secondary_ref)` where `secondary_ref` is the link URL, image src, or empty.

### Issues / Hidden sub-tabs

`Issues 336 | Hidden 0`. Hiding is per-finding and reversible, and hidden items stay counted but out of the way. Map onto our existing `crawl_finding_reviews.review_status = 'False positive'` — we already have the better version of this, with reviewer notes and an audit trail. Just surface it as a tab.

### Advanced filters

`[Include ▾] [Page URL ▾] [____________]` + `Add condition` + `Apply filters` / `Clear all`. Field list is **per-check**, driven by `filterFields` above. Duplicate-meta offers only `Page URL`; broken-links should also offer `Link URL` and `HTTP Status Code`.

---

## 7. Screen 5 — Crawled Pages & Site Structure

**Route:** `/site-audit/:runId/pages` and `/site-audit/:runId/structure`

A `[≡ Pages] [⊞ Site Structure]` segmented toggle, then a shared filter row: a scope dropdown (`Everywhere ▾`), search, and Advanced filters.

### Pages view — 22 columns, 9 on by default

`Manage columns 9/22` opens a checklist with `Reset to default` / `Select all`. **ILR and Page URL are checked and disabled** — the identity columns can't be removed.

Full set observed, in order:

```
ILR*, Page URL*, Title, Description, Status Code, Issues,
Blocked AI Search Bots, Crawl Depth, Pageviews, Load Time,
Markup, Structured data, Canonicalization, Sitemap,
Incoming Int. Links, Outgoing Int. Links, Outgoing Ext. Links,
AMP link, Hreflang, JS and CSS Files, JS and CSS Size, Reaudit
                                                    (* = locked)
```

Default on: ILR, Page URL, Title, Status Code, Issues, Blocked AI Search Bots, Crawl Depth, Pageviews, Reaudit.

Persist the selection per user. `localStorage` is fine — it is a per-viewer convenience, not shared state.

Most of these map to `crawl_run_results.data jsonb` and `project_pages`. The ones we'd need to add: ILR (§10), Pageviews (needs the GA connection — render `Connect GA` as a call to action rather than `0`, exactly as Semrush does), JS/CSS file count and size.

`Reaudit` is a per-row ↻ button that re-crawls one URL on demand. Genuinely useful during a fix cycle, and cheap for us — `crawler.js` already supports list mode (`body.urls[]`). Worth building.

### Site Structure view

A directory tree, one row per path segment, expandable, with **URLs** and **Issues** counts per folder:

```
▾ 📁 https://utimaco.com     43    455
  › 📁 /de                    8     68
  › 📁 /es                    8     68
  › 📁 /news                  7     89
```

This is how you find that one bad section of a site. We have the data — `project_pages.canonical_key` is already host+path+query normalized, so the tree is a `GROUP BY` over path prefixes.

### The cross-navigation pattern — build this

From an issue detail, `Site Structure` navigates to the structure view **carrying the check as a filter**:

```
…/review/pagereport/structure?restrictions={"triggeredIssue":12}
```

So you go: *"111 broken external links"* → *"…and 68 of them are in /de"*. In our URL scheme:

```
/site-audit/:runId/structure?rule=broken-external-links
```

Make `rule`, `severity`, `category`, `statusCode`, and `depth` a **shared filter vocabulary understood by Issues, Pages, and Structure alike.** Any screen can hand off to any other. This is the highest-leverage thing on the whole surface and costs almost nothing if you design the param set up front — and a lot if you retrofit it.

---

## 8. Screen 9 — Thematic reports

**Route:** `/site-audit/:runId/report/:themeKey`

There are **two distinct templates**. Recognising this is what keeps you from writing seven bespoke pages.

Shared header for both:

```
[← Go to Overview]
Crawlability / Score: 81%  ◔ -7%
```

### Template A — "Diagnostic grid" (Crawlability)

A 2-column grid of visualization cards, no check list.

| Widget | Chart | Data |
|---|---|---|
| Site Indexability | Donut with total in the hole | indexable vs non-indexable |
| Crawl Budget Waste | Horizontal bar list, label / count / bar | 10 named waste categories |
| Pages Crawled | Line chart over crawl dates | run history |
| Incoming Internal Links | Histogram, buckets `0,1,2-5,6-15,16-50,51-150,151-500,500+` | link distribution |
| Pages Crawl Depth | Donut + legend by click count | |
| Sitemap vs. Crawled Pages | Two overlapping circles (Venn), area-proportional | sitemap ∩ crawled |
| HTTP Status Code | Donut + legend `5xx/4xx/3xx/2xx/1xx/No code` | |

The **Crawl Budget Waste** widget deserves special mention. Ten rows: Temporary redirects, Permanent redirects, Duplicate content, Canonical to another page, Large page size, Slow page (HTML) load speed, Blocked from crawling, 4xx errors, 5xx errors, Redirect chains and loops. Bars are scaled to the largest value, and **zero-value rows stay visible** as an empty track. Showing the zeros is the point — it's a checklist of every way you can waste crawl budget, and the empties are reassurance.

`No code` as a status bucket (4 pages here) is a nice touch — connection failures are distinct from HTTP errors.

### Template B — "Distribution + checklist" (Site Performance, Internal Linking, and most others)

Two columns, ~35/65:

**Left rail:** stacked distribution widgets (donuts, histograms).
**Right column:** every check in that theme, grouped by severity, one row each:

```
Performance Issues
Errors ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Large HTML page size            Learn more        No issues
Redirect chains and loops       Learn more        No issues
Slow page (HTML) load speed     How to fix       [42 issues]
Warnings ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Uncompressed pages              Learn more        No issues
Uncached JavaScript and CSS     How to fix       [14 issues]
```

Two details worth copying:

- **Passing checks are listed, not hidden**, with `No issues` in green plain text (no badge). Failing checks get a bordered count pill. The visual weight difference does the work; you scan for pills.
- **The action link changes with state**: `Learn more` when passing, `How to fix` when failing. One word of copy that tells you whether you have work to do.

Internal Linking adds a third element below: **Pages passing most Internal LinkRank** — a top-10 table of ILR / URL / Unique Pageviews / Outgoing Links, with `View full report`.

And its **Internal Link Distribution** widget is a good pattern for any two-sided ratio:

```
Links          Pages
 96%    →       22%      907 Strong pages   (ILR > 70)
  3%    →       66%    2,730 Medium pages   (ILR 10–70)
 ~0%    →       12%      508 Weak pages     (ILR < 10)
```

Two paired bars per row showing link-share against page-share, so the concentration is legible at a glance: 22% of pages hold 96% of the link equity. Note `~0%` rather than `0%` for a small non-zero value — do not round a real value to zero.

### Theme registry

One file, `client/src/components/siteAudit/themes.js`:

```js
export const THEMES = [
  { key: 'crawlability',  label: 'Crawlability',       template: 'grid',
    ruleIds: [...], widgets: ['indexability','crawlBudget','pagesCrawled', ...] },
  { key: 'performance',   label: 'Site Performance',   template: 'checklist',
    ruleIds: [...], widgets: ['loadSpeed','avgLoadSpeed','jsCssFiles','jsCssSize'] },
  { key: 'linking',       label: 'Internal Linking',   template: 'checklist',
    ruleIds: [...], widgets: ['crawlDepth','internalLinks','ilrDistribution'],
    extras: ['topIlrTable'] },
  ...
];
```

`ruleIds` are keys into `issue-catalog.json`. Two pages (`ThematicGridPage`, `ThematicChecklistPage`) render all seven themes.

**Only ship themes we can actually measure.** Our catalog has Performance 4, Links 7, Indexability 30, Structured Data 4 — so Site Performance, Internal Linking, Crawlability and Markup are real. Core Web Vitals needs a PSI/CrUX integration we don't have; render the card as `Not implemented`, never `0%`.

---

## 9. Screens 6–8 — Statistics, Compare Crawls, Progress

### Statistics (`/statistics`)

`[⊞ Tile] [📊 Graph]` toggle. Tile view = a 4-across grid of eight tiles. Each tile is: **title, one headline percentage, a sentence naming what the percentage measures, then the full breakdown**.

```
HTTP Status Code
0%
pages with 4xx and 5xx status codes
  5xx: 0%    4xx: 0%    3xx: 0%
  2xx: 100%  1xx: 0%    No code: 0%
```

The headline is the *actionable* number, not the biggest one — "0% have 4xx/5xx", not "100% are 2xx". Choose each tile's headline for what it tells you to do.

Eight tiles observed: HTTP Status Code, Sitemap vs. Crawled Pages, Pages Crawl Depth, Incoming Internal Links, Markup Types, Canonicalization, Hreflang Usage, AMP Links.

### Compare Crawls (`/compare`)

Two date pickers (`Aug 14, 2026 (10:25)` vs `Aug 18, 2026 (15:53)`) and a five-column table:

```
                              │ Aug 14  │ Aug 18  │ Fixed │  New
General ──────────────────────┼─────────┼─────────┼───────┼────────
Pages crawled                 │  1,339  │ 4,161   │       │
Site Health                   │     83  │    75   │       │
Total issues                  │  7,182  │ 23,930  │ [119] │[16,867]
Errors ───────────────────────┼─────────┼─────────┼───────┼────────
5xx errors        Learn more  │      0  │     0   │   —   │   —
Duplicate title tags          │     81  │   171   │   [7] │   [97]
```

- **The better of the two values is bold and green.** Direction of "better" comes from each metric's polarity.
- **Fixed / New are separate columns, not a net delta.** 81 → 171 decomposes to *7 fixed, 97 new*. A net `+90` hides both facts and is the single most useful thing on this screen.
- `—` for a check that was zero in both runs. Not `0`.
- Every check in the catalogue is listed, all 100, including permanent zeros.
- A per-row 📈 icon jumps to that metric on Progress.

We already have `server/modules/projects/insights/changes.js` computing new/fixed/regressed vs previous run. Reuse it. **And respect its existing rule:** a fix is only claimed for a page audited in *both* runs; otherwise `not_rechecked` / `not_comparable`. When comparing a 1,339-page crawl with a 4,161-page crawl, most "new" issues are new *coverage*, not new *defects* — the screen must say so or it lies. Add a banner: *"Crawl scope changed (1,339 → 4,161 pages). Counts are not directly comparable."*

Semrush shows exactly that warning at the top of every screen in this campaign: *"Your crawler settings have changed since your previous audit."* Steal it.

### Progress (`/progress`)

`HISTORICAL CHART FOR AUDITS  FROM: [date] TO: [date]` + a line chart + `LEGEND: [Total issues ✕]`.

The chart is empty until you pick series from a picker organised as **General / Errors / Warnings / Notices**, listing every check by name. General offers: Pages crawled, Site Health, Total issues, Total errors, Total warnings, Total notices.

Also: a **Notes** feature — `Notes: [+ Add] [View all]` pins an annotation to a date on the chart ("shipped the redirect fix"). Small feature, high value for client reporting, and we have `activity_log` and `audit_events` to hang it off.

> **The full 100-check catalogue is enumerated in the Progress series picker and in Compare Crawls.** Both raw captures are in the appendix of this document's companion notes. Use them to audit gaps between our 92 checks and Semrush's — but only add checks we can actually detect. A check that always returns 0 because it isn't implemented is worse than no check.

---

## 10. Metrics and scoring

### Site Health

Semrush's tooltip says the score derives from the count of errors and warnings, weighted by — in their word — "uniqueness", and that the benchmark line is an industry average drawn from their Traffic Analytics panel.

Two things follow. First, **notices are excluded** — only errors and warnings count. Second, **"uniqueness" is doing real work**: one template bug hitting 4,000 pages should not score like 4,000 distinct bugs.

The exact formula is proprietary and **you should not try to reverse-engineer it.** Observed points don't fit a simple model anyway (4,161 pages / 640 errors / 4,802 warnings → 75%; the prior run 1,339 pages / 234 / 275 → 83%).

**Proposed formula for our app** — transparent, defensible, and satisfying the `score_basis` constraint:

```
For each failing check c:
    instances(c)      = number of findings
    templateScope(c)  = distinct URL path-templates affected   ← the "uniqueness" term
    weight(c)         = 10 if severity=error, 3 if warning, 0 if notice
    penalty(c)        = weight(c) × log2(1 + templateScope(c))

health = round(100 × (1 − Σ penalty(c) / maxPenalty))
maxPenalty = Σ over all applicable checks of weight(c) × log2(1 + totalTemplates)

score_basis = "errors+warnings, template-scoped, log2, v1"
```

Using template scope rather than raw instance count means fixing one shared header fixes the score in one step, which is what actually happens. `log2` stops any single check from dominating.

**Store the basis string with the score, and version it.** When the formula changes, the basis changes, and historical scores stay interpretable. If fewer than N pages were crawled, or the crawl was capped, return `null` with `status: 'insufficient_data'` — do not return a number computed from a partial crawl and pretend it's comparable.

### Thematic scores

Same shape, scoped to the theme's `ruleIds`:

```
themeScore = 100 × (1 − Σ penalty(c ∈ theme) / maxPenalty(theme))
```

A theme with no applicable checks returns `null` → the card renders `Not implemented`.

### Internal LinkRank (ILR)

A 0–100 PageRank-style score over the internal link graph. We already store the graph in `crawl_run_links` (`from_url`, `to_url` — 18,340 edges on the sample project), so this is computable today:

1. Build the adjacency from `crawl_run_links` for the run.
2. Run ~20 power iterations of PageRank, damping 0.85, uniform seed.
3. Normalise so the max page = 100.
4. Store on `project_pages` and `crawl_run_results`.

Bands (from the Internal Link Distribution widget): **Strong > 70, Medium 10–70, Weak < 10.**

⚠️ ILR is only meaningful on a reasonably complete crawl. **At the 50-URL live cap it is noise.** Withhold it (constraint: withhold rather than degrade) with reason `crawl_capped`, exactly as the existing code does for orphan counts.

### Crawl depth

Clicks from the homepage, via BFS over the internal link graph. Note the sample shows `1 click: 100%` for all 4,161 pages — that is a sitemap-sourced crawl where nothing was reached by following links, so depth is degenerate. **Depth is only valid for spider-mode crawls.** In list/sitemap mode, withhold it. Do not render "everything is 1 click from home" as a good result.

### Metric polarity registry

One table, used by `MetricDelta`, Compare Crawls bolding, and sort defaults:

| Metric | Higher is | Format |
|---|---|---|
| Site Health, all thematic scores, ILR | better | `%` |
| Errors, Warnings, Notices, Total issues | worse | integer |
| Pages crawled | neutral | integer + limit |
| Avg. load speed | worse | `2.12 sec` |
| Indexable pages | better | integer |

---

## 11. Cross-cutting patterns

**Exclude checks.** A per-project list of checks to skip, surfaced as `Excluded checks: 3` in the header (a link) and as a per-check `👁 Exclude check` action. Essential for agency work — the "low word count" check on a photo gallery is noise forever. Store on `crawl_projects.settings jsonb`, apply in `analyzer.js`, and **subtract excluded checks from the health denominator** so excluding a check doesn't inflate the score.

**Crawl config model** (from Semrush's settings menu — a good checklist for our `shared/options.js`):

```
Scope: utimaco.com              Subdomains included: no
Pages to crawl: sitemap URL     Google Analytics: not connected
Page limit: 15,000              User agent: SiteAuditBot (Mobile)
Parameters to ignore: 0         Bypass rules: no
Crawl with my credentials: no   Crawl with Web Bot Auth signature: no
Exclude checks                  Schedule: once
```

We already have most of this. Gaps: user-agent choice (mobile/desktop), parameters-to-ignore, credentialed crawling, and `Pages to crawl` as an explicit named source.

**Sortable everywhere.** Every table column, sort state in the URL.

**Empty and partial states.** Four distinct states, and they must look different:

| State | Render | Never render as |
|---|---|---|
| Measured, zero defects | `No issues` (green text) | |
| Check not applicable | `Not implemented` | `0%` |
| Not measurable this run | `—` + reason on hover | `0` |
| Not yet run | skeleton | empty table |

`ui/EmptyState.jsx` and `ui/Skeleton*.jsx` already exist. `ScoreRing` already draws an em dash on a non-finite score — that behaviour is correct, keep it.

**Charts.** There is no charting library in this repo, and the existing charts (`components/competitorAnalysisDashboard/charts/`, `components/home/AuditRadar.jsx`) are hand-written SVG. Continue that. New primitives needed:

`Donut` (with center label) · `HorizontalBarList` · `Histogram` (bucketed) · `Sparkline` · `LineChart` (multi-series, date x-axis) · `VennTwo` (area-proportional) · `PairedBar` (the links-vs-pages widget) · `HalfDonutGauge` (Site Health)

`ScoreLollipop`, `CompositionBar`, `RankedBarChart` and `KpiScorecard` already exist — check them before writing new ones.

---

## 12. House rules — match these or the PR gets rejected

From `client/src/ui/` and `client/src/index.css`:

- **Plain JavaScript `.jsx`.** No TypeScript anywhere in `client/src`.
- **Inline `style={{}}` objects reading CSS custom properties** (`var(--card)`, `var(--text-2)`, `var(--r-md)`). Tailwind is installed but barely used — do not introduce it here.
- **Both a named export and a default export** per component; consumers import named from `'../ui'`.
- Destructure the style prop as `style: extraStyle` and spread it last.
- JSDoc `@param` header on every component.
- **Heavy prose comment blocks at the top of files explaining *why* a decision was made and what mistake it prevents.** This is the most distinctive thing about this codebase. Imitate it, especially for the delta-polarity and null-vs-zero logic.
- Sizes and spacing are raw numbers in inline styles (`fontSize: 13`, `gap: 8`); radii, colors and motion are tokens.
- **The `--accent-*` / `--neutral-*` ramps invert between light and dark** by design: `background: var(--accent-800); color: var(--accent-100)` stays legible in both. Respect it.
- Dark is the default theme; light is a designed alternative, not an afterthought.

Server side:

- New work follows the **`server/modules/<name>/`** pattern (routes + store + logic co-located), not the older flat `server/routes/*.js`.
- Responses are named-key objects, never bare arrays: `{ runs: [...] }`, `{ findings: [...] }`.
- Errors are `{ error: "<human sentence>" }` with the right status; `ValidationError` → 400.
- **Every query carries its own workspace filter.** There is no RLS. Cross-workspace reads answer **404, not 403**.
- Migrations are additive, re-runnable, hand-applied SQL in `supabase/migrations/`, heavily commented. Note that **0012, 0013 and 0014 may not be applied on a given database** — degrade gracefully when their tables are missing, as existing code does.
- Tests are `node:test` / `assert`.

⚠️ **Known gap to fix before shipping:** CrawlScope run endpoints are scoped by `req.user.id`, not by workspace. A teammate can see a project through `/api/projects` but cannot open its crawl run. Every screen in this spec reads run data. **Fix the scoping first** or the whole feature is single-user.

---

## 13. What NOT to copy from Semrush

- **Ranking top issues by raw affected-page count.** It surfaces 13,420 anchor-text notices above 2 pages returning 4xx. Sort by severity → catalog priority → count, and show the reason.
- **Base64-encoded URL filter state.** Unreadable, undebuggable, unlinkable by hand.
- **Seven bespoke thematic report routes** with inconsistent slugs (`/linking`, `/history`, `/performance`). One `:themeKey` route, one registry.
- **`Core Web Vitals 0%`** when there is no data source connected. That is a lie dressed as a measurement. `Not implemented`.
- **Tooltips that only open on click.** Semrush's info icons don't respond to hover. Support both.
- **The upsell panel** in the overview.
- **Comparing two crawls of wildly different scope without a warning.** Semrush shows the settings-changed banner but still renders `+16,867 new issues` as though it were a regression.

---

## 14. Build order

**Phase 1 — the spine.** Metric registry with polarity. `MetricDelta`. The shared filter vocabulary (`rule`, `severity`, `category`, `statusCode`, `depth`). `AuditHeader`. Fix the workspace scoping on run endpoints. *Nothing renders yet; everything after this is cheap.*

**Phase 2 — read paths.** Page state classifier (Healthy/Broken/Have issues/Redirects/Blocked), stored on the row. Health score + basis. Thematic scores. `GET /api/site-audit/projects`. `GET /api/site-audit/runs/:id/overview`.

**Phase 3 — Home + Overview.** Screens 1 and 2. First thing anyone can look at.

**Phase 4 — Issues + Issue detail.** Extend the catalog with `sentenceTemplate`, `columns[]`, `filterFields`, `detectionNote`, `references[]`. Per-check table descriptors. Wire `Send to…` into the existing `recommendations` table.

**Phase 5 — Pages + Site Structure.** Manage-columns. The directory tree. Cross-navigation handoffs.

**Phase 6 — Thematic reports.** Both templates + the theme registry. Chart primitives.

**Phase 7 — Time.** Compare Crawls (reuse `insights/changes.js`), Progress, Notes.

**Phase 8 — Extras.** ILR + PageRank. Exclude checks. Reaudit-single-URL.

---

## Appendix A — Semrush URL map (as observed)

```
/siteaudit/                                          portfolio
/siteaudit/campaign/:id/review/overview              overview
/siteaudit/campaign/:id/review/issues?restrictions=  issues (base64 JSON)
/siteaudit/campaign/:id/review/issue/detail/:checkId?sort=url_asc
/siteaudit/campaign/:id/review/pagereport/pages?sort=prScore_desc&page=1
/siteaudit/campaign/:id/review/pagereport/structure?restrictions=
/siteaudit/campaign/:id/review/statistics/tile
/siteaudit/campaign/:id/review/compare
/siteaudit/campaign/:id/review/history               "Progress"
/siteaudit/campaign/:id/review/crawlability          grid template
/siteaudit/campaign/:id/review/performance           checklist template
/siteaudit/campaign/:id/review/linking               checklist template
```

Note `sort=prScore_desc` on the pages report — Semrush's internal name for ILR is `prScore` (PageRank score), confirming the algorithm family.

## Appendix B — check catalogue coverage

Semrush enumerates exactly 100 checks: Errors 41, Warnings 34, Notices 25 (counted from the Compare Crawls table and the Progress series picker, which both list the complete catalogue). Our `issue-catalog.json` has 92: severity `warning` 54 / `error` 23 / `notice` 15; priority `High` 40 / `Medium` 39 / `Good to have` 13; detection `Automatic` 85 / `Connected data required` 7.

Notable Semrush checks we do not appear to have, worth evaluating (only add what we can actually detect):

`www resolve issues` · `Certificate Expiration` · `Old security protocol version` · `Certificate registered to incorrect name` · `Insecure encryption algorithms` · `No SNI support` · `No HSTS support` · `Issues with mixed content` · `Neither canonical URL nor 301 redirect from HTTP homepage` · `Too large sitemap.xml` · `Encoding not declared` · `Doctype not declared` · `Frames used` · `Incompatible plugins used` · `Low text to HTML ratio` · `Too many URL parameters` · `Underscores in URL` · `URLs longer than 200 characters` · `Orphaned pages (Google Analytics)` · `Outdated content` · `Low Semantic HTML usage`

The AMP family (4 checks) is almost certainly not worth building in 2026.
