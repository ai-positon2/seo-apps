# Database audit: pending work

Status as of 2026-10-04. Covers the PostgreSQL database (Amazon RDS `prod-agents`, database `seo_tool`, PostgreSQL 17.9) and the server code that queries it (`server/`, node-postgres, no ORM). Schema lives in `supabase/migrations/` and is applied by `server/scripts/migrate.js`.

This lists everything from the database schema and query audit that has **not** been done yet, in the order it should be done, with enough detail to pick up any item cold. Each item says what the problem is, where it is, what to change, what users will notice, what can go wrong, and how to check it.

Line numbers are as of commit `c8c8daa`. Items marked **(reported)** came from the audit's code review and were not re-verified line by line; everything else was checked against the code.

---

## Contents

1. [Already done](#already-done)
2. [Recommended order](#recommended-order)
3. [A. Bugs found during the audit](#a-bugs-found-during-the-audit)
4. [B. Same behaviour, but needs care](#b-same-behaviour-but-needs-care)
5. [C. Visible changes that need a decision](#c-visible-changes-that-need-a-decision)
6. [D. Longer-term schema work](#d-longer-term-schema-work)
7. [E. Housekeeping and operations](#e-housekeeping-and-operations)
8. [Deliberately not doing](#deliberately-not-doing)
9. [How to verify changes safely](#how-to-verify-changes-safely)
10. [Baseline measurements](#baseline-measurements)

---

## Already done

Shipped 2026-10-04 in commit `c8c8daa` on `unified-fast`, deployed on Railway, migration applied on production and verified afterwards (all 12 new indexes valid, the planner uses them).

| Change | File |
|---|---|
| 12 indexes added: internal-page partial, PageSpeed partial, per-rule finding delete, module-run history, page keyset, and 7 foreign-key indexes that deletes check | `supabase/migrations/0043_query_performance_indexes.sql` |
| 5 unused indexes dropped, incl. 63 MB of never-used `crawl_run_links` indexes. 6 redundant-but-used ones deliberately kept | same |
| Finding-instance readers seek to each page's id range instead of `OFFSET` (46 s → 5 s on a 240k-instance run, locally); still parallel | `server/modules/crawlScope/db/repo.js`, `server/modules/projects/overview.js` |
| AI Visibility period report: keyset instead of `OFFSET` | `server/modules/aiVisibility/store.js` |
| Project page reads (`syncFromCrawl`, `keyToId`): keyset instead of `OFFSET` | `server/modules/projects/pages.js` |
| Link-graph reads: 5,000 rows per round trip instead of 500 | `server/modules/projects/crawledPages.js`, `crawlToArchitect.js` |
| `latestPolicy` predicate now matches its unique index | `server/services/adminLimits.js` |

All of these return exactly the same rows as before (checked against a single unpaged query on a synthetic 60k-page crawl). Nothing here changes what users see.

---

## Recommended order

| Order | Item | Effort (rough) | Payoff | Visible to users? |
|---|---|---|---|---|
| 1 | [A1 Insights backlog never sees per-page findings](#a1-insights-backlog-never-sees-per-page-findings) | 30 min | Correct backlog | Yes — findings appear that were missing |
| 2 | [A2 Streaming audit misses a late homepage and can "stall"](#a2-streaming-audit-misses-a-late-homepage-and-can-stall) | 1–2 hours | Correct first-page audit on sitemap-seeded crawls | Yes — fewer false "crawl stalled" |
| 3 | [B1 Stop reading the crawl checkpoint on every progress tick](#b1-stop-reading-the-crawl-checkpoint-on-every-progress-tick) | 1–2 hours | Biggest live win: MBs per SSE tick → KBs | No |
| 4 | [B2 Crawl-status poll: check first, then read lean](#b2-crawl-status-poll-check-first-then-read-lean) | 1 hour | Every screen polls this every 4–15 s | No |
| 5 | [B3 Drop the separate "distinct texts" pass](#b3-drop-the-separate-distinct-texts-pass-in-the-findings-reader) | 2 hours | Removes most of the remaining findings-list time | No |
| 6 | [B11 Saving a review reads every finding](#b11-saving-a-review-reads-every-finding-of-the-run) (step 1 only) | 2 hours | Review saves stop reading up to 50k findings | No (step 1) |
| 7 | [B4 Module runs: stop loading `payload` for lists](#b4-module-runs-stop-loading-payload-for-lists) | 2–3 hours | Up to ~16 MB less per module detail view | No |
| 8 | [B5 PageSpeed refresh: shorter locked transaction](#b5-pagespeed-refresh-shorter-locked-transaction) | 1–2 hours | Shorter row lock per PSI click | No |
| 9 | [E1 Turn on `pg_stat_statements`](#e1-turn-on-pg_stat_statements) | 30 min + RDS reboot window | Real slow-query data instead of reasoning from code | No |
| 10 | [C1 Deleting a user deletes their crawl data](#c1-deleting-a-user-deletes-their-crawl-data) | 0.5 day **after a decision** | Removes a data-loss trap | Only if a user is ever deleted |
| 11 | [C2 Competitor card reads every tenant's clients](#c2-competitor-card-reads-every-tenants-clients) | 1–2 hours | Stops a cross-tenant read | Possibly — see item |
| 12 | [C3 Recommendations summary capped at 500](#c3-recommendations-summary-capped-at-500) | 30 min | Correct totals | Yes — totals over 500 become correct |
| 13 | [B6 Heartbeat rewrites the whole checkpoint every 30 s](#b6-heartbeat-rewrites-the-whole-checkpoint-every-30-s) | 2–3 hours **after a decision** | Less write and bloat on `crawl_runs` | Only on crash-resume |
| 14 | [C4 Content Architect project list](#c4-content-architect-project-list-reads-everything) | 0.5 day **after a decision** | One query instead of N+1 | Possibly — see item |
| 15 | [B7 Persist finished-crawl counts](#b7-persist-finished-crawl-counts) | 2–3 hours | Removes repeated counts on the overview | No |
| 16 | [B8 Link graph: use the stored inlink counts](#b8-link-graph-use-the-stored-inlink-counts) | 0.5–1 day incl. parity check | Removes full graph reads at crawl end | No, if parity holds |
| 17 | [C5 `activity_log` grows forever](#c5-activity_log-grows-forever) | 1–2 hours **after a decision** | Bounded table | No |
| 18 | Remaining B and C items, then D | Ongoing | | |

Items 3 and 4 can ship together, as can 5 and 6 (both touch the findings reader). Item 9 should happen before the larger items so their effect can be measured.

---

## A. Bugs found during the audit

These are correctness bugs, not performance. Both were confirmed in the code.

### A1. Insights backlog never sees per-page findings

**Problem.** The insights layer builds its per-page backlog from each page run's `findings`, but the query that loads page runs never selects that column, so the list is always empty.

**Where.**

- `server/modules/projects/moduleEvidence.js:878` — `pageRunsForRun` selects `id, url, ordinal, status, score, score_max, band, counts, error, finished_at, payload_truncated` (no `findings`).
- `server/modules/projects/insights/findingIndex.js:193` calls it, and `:223` reads `page.findings`.
- The column exists: `project_module_page_runs.findings jsonb not null default '[]'`.

**Change.** Add `findings` to the select list in `pageRunsForRun`. It has six other callers; check each one to make sure the extra column is harmless (larger responses, or rows sent straight to the browser): `server/modules/projects/routes.js:759`, `moduleDetail.js:110`, `insights/changes.js:47`, `moduleRunners.js:1091`, and `moduleEvidence.js:302` and `:704`. If any of them would be hurt by it, give the insights adapter its own function instead.

**What users notice.** Per-page findings from on-page / SEO-GEO / agent-readiness runs start appearing in the insights backlog and dashboard.

**Check.** Run `modules/projects/__tests__/insights.test.js`; add a case where a page run has findings and assert they reach `perPageAdapter`'s output.

### A2. Streaming audit misses a late homepage and can "stall"

**Problem.** Phase 1 of the streaming audit looks for the homepage by re-reading the **first 200** internal pages of the crawl every few seconds. On a sitemap-seeded crawl where the root URL is not among the first 200 stored pages, the homepage is never found. Worse, the "pages seen" counter can never exceed 200, so once 200 pages are stored the idle clock stops being reset and the audit declares the crawl stalled after 3 minutes (`IDLE_TIMEOUT_MS`, `:67`) while the crawl is healthy.

**Where.** `server/modules/projects/streamingAudit.js:117-124` (`pagesSoFar`, `limit 200`), called with `afterId = 0` on every pass at `:271`. Phase 3 (around `:318`) also chooses key pages from the first 200 rows only **(reported)**.

**Change.** Track the last id seen and pass it as `afterId`, keeping a running count, so each pass reads only new rows (`pagesSoFar` already supports `id > $2`). Look for the homepage among the new rows each pass. The new partial index `idx_crawl_run_results_run_internal (run_id, id)` serves this exactly.

**What users notice.** Fewer false "crawl stalled" outcomes; the homepage result appears for sitemap-seeded crawls.

**Check.** `modules/projects/__tests__/streamingAudit.test.js`; add a case with the root URL stored after 250 other pages.

---

## B. Same behaviour, but needs care

Each of these returns the same thing users see today **if done carefully**. The risk is always the same: dropping a field or changing a shape that some caller still reads. Every item lists the callers to check.

### B1. Stop reading the crawl checkpoint on every progress tick

**Problem.** `getRunForViewer` is `select * from crawl_runs`. That row carries `checkpoint` (the whole crawl frontier) and `summary`. On production, `crawl_runs` holds **27 rows but 551 MB**, about 20 MB per row. This read runs at the start of every `/runs/:id/*` route and on every SSE tick (about once a second per open viewer); on a finished run the SSE loop repeats it once per 200 rows without sleeping. Measured locally: 129 ms → 1 ms per call with a column list.

**Where.**

- `server/modules/crawlScope/db/repo.js:393` — `getRunForViewer`.
- Callers: `server/modules/crawlScope/api/routes.js:230, 244, 264, 327, 389, 451, 513, 583`; `server/modules/crawlScope/api/sse.js:54, 79`.

**Change.** Select every column **except `checkpoint`**. Verified: nothing in `server/modules/crawlScope/api/` and nothing in `client/src` reads `run.checkpoint`. **Keep `summary` and `site_diagnostics`**: `GET /runs/:id` (`routes.js:232`) sends the row to the browser, the run pages read `run.summary`, SSE sends `summary` and `siteDiagnostics` when a run finishes (`sse.js:111-113`), and `loadRunFindings` (`routes.js:357`) falls back to `run.summary.findings` for runs finalized before migration 0023. A further step, later: in SSE, read `summary` only once the run is terminal.

**What can go wrong.** A route that later needs `checkpoint` gets `undefined`. Grep for `checkpoint` in each caller before merging.

**Check.** `modules/crawlScope/__dbtests__/*` and the crawlScope `node:test` suite; open a live and a finished run in the browser and compare the network payloads before/after (only `checkpoint` should disappear).

### B2. Crawl-status poll: check first, then read lean

**Problem.** The crawl-status poll (every 4–15 s, from every screen) reads the 12 newest runs and extracts keys from `summary`, including `summary->'findings'`. Extracting a key still detoasts the whole `summary`, which is many MB on runs finalized before migration 0023. It usually returns "nothing running".

**Where.** `server/modules/projects/overview.js:182` (`recentCrawlRuns`) and its use in `liveCrawlStatus`.

**Change.** First run `select exists(select 1 from crawl_runs where project_id = $1 and status = any('{queued,running,paused}'))` (served by `idx_crawl_runs_project_status_finished`). Only if that is true, or when a caller actually needs history, read the runs with a lean column list. Keep the function's return shape identical.

**Check.** `modules/projects/__tests__/projects.test.js`, `executiveSummary.test.js`; compare `/api/projects/:id/overview` and the crawl-status response before and after on a project with old runs.

### B3. Drop the separate "distinct texts" pass in the findings reader

**Problem.** `listAllRunFindingInstances` still runs a second query over **every** instance of the run (`select distinct md5(...), data->>'recommendation', data->>'description'`), not limited by the 50k cap. Locally this pass alone took ~5.5 s of the remaining ~5 s per call on a 240k-instance run (they run in parallel on RDS, but it is still the heaviest statement). It runs on the findings page, on **every review save** (`PATCH /runs/:id/findings`), and for the xlsx report.

**Where.** `server/modules/crawlScope/db/repo.js` — `listAllRunFindingInstances` (`:1091`), the `select distinct` at `:1143`.

**Change.** Have each page query return the full `recommendation` / `description` text only the first time a hash appears (for example, `row_number() over (partition by md5(...) order by id) = 1` inside the page), and fill the maps in JS as pages arrive. The function must still return a byte-identical array (the header comment at `:1111-1114` says so explicitly).

**Check.** Reuse the equivalence approach in [How to verify](#how-to-verify-changes-safely): compare output with a single `select data ... order by id limit cap` for caps 1, 5,000, 12,345, 50,000 and more than the total. `modules/crawlScope/__dbtests__/findingsCap.test.js` must still pass.

### B4. Module runs: stop loading `payload` for lists

**Problem.** `moduleEvidence.listRuns` is `select *` and drags `payload` (up to 400 KB per row, `MAX_PAYLOAD_CHARS`) into lists. The module detail view asks for 40 rows (up to ~16 MB). One caller reads 10 full rows just to check `status`. Two writes echo the payload back with `returning '*'`.

**Where.**

- `server/modules/projects/moduleEvidence.js:461` (`listRuns`), `:261` and `:352` (`returning: '*'`).
- Callers to audit, one by one, for whether they read `payload`: `server/modules/projects/moduleDetail.js:93`, `server/modules/projects/routes.js:737` and `:1497`, `server/modules/projects/insights/changes.js:35`, `server/modules/aiVisibility/routes.js:119, 143, 326, 401`, `server/modules/aiVisibilityLite/routes.js:88, 322`.

**Change.** Add a lean variant (all columns except `payload`) and switch the callers that do not read `payload`; fetch the one payload that is needed with `getRun`. Return only the columns the two writers' callers use.

**What can go wrong.** A caller that reads `run.payload.something` silently gets `undefined`. This is why each caller must be checked.

**Check.** `modules/projects/__tests__/moduleEvidence.test.js`, `moduleDetail.test.js`, `moduleReportRoute.test.js`, AI Visibility suites; compare JSON responses of the affected routes before and after.

### B5. PageSpeed refresh: shorter locked transaction

**Problem.** Each on-demand PageSpeed check runs one transaction that locks the run row with `select * ... for update` (pulling `summary` and `checkpoint`), reads every result and every previous-run finding, and writes the run back with the default `returning *`. The new indexes already made two of its statements fast (759 ms → 2 ms and 1.9 s → 0.24 s locally).

**Where.** `server/modules/crawlScope/run/pagespeed-findings.js:130-200`; `server/modules/crawlScope/db/repo.js:966` (`lockRun`), `:835` (`listRunIssueRows`).

**Change.**

- `lockRun`: select only the columns the refresh reads (check `pagespeed-findings.js` for which).
- `updateRun` at `pagespeed-findings.js:182`: pass `{ returning: false }` if the result is unused.
- `listRunIssueRows(previous)` at `:191`: add an optional rule-id filter so it reads only the Core Web Vitals rules it then filters to in JS.

**Check.** `modules/crawlScope/__dbtests__/pagespeedFindings.test.js` (7 tests).

### B6. Heartbeat rewrites the whole checkpoint every 30 s

**Problem.** While a crawl runs, every heartbeat (`RUN_HEARTBEAT_MS`, default 30 s) writes the full frontier snapshot into `crawl_runs.checkpoint`. Each write creates a new multi-MB TOAST version, and the old one becomes garbage for autovacuum. This is the likely reason `crawl_runs` is 551 MB for 27 rows (see [E3](#e3-check-crawl_runs-bloat)).

**Where.** `server/modules/crawlScope/run/manager.js:514-529`.

**Change (needs a decision).** Write the checkpoint every Nth heartbeat, or only when at least M new pages were stored since the last one, while still writing `heartbeat_at` every time.

**What users notice.** Nothing normally. After a crash, a resumed crawl may redo up to N × 30 s of pages. Decide what N is acceptable.

**Check.** `modules/crawlScope/__dbtests__/resume.test.js`; watch `n_tup_upd` and table size of `crawl_runs` on production for a week before and after.

### B7. Persist finished-crawl counts

**Problem.** The overview recounts "internal pages" and "internal HTML pages" for the last **finished** crawl on every load (every 8 s while a crawl is live). These answers never change once the crawl ends. The new partial index made `internalPageCount` an index-only scan, but `internalHtmlPageCount` still reads each internal page's `data` for four more conditions.

**Where.** `server/modules/projects/overview.js:225` (`internalHtmlPageCount`), `:536` (`internalPageCount`). Do **not** cache `healthAffectedPages` (`:473`): it depends on review status, which users change.

**Change.** Compute both at crawl completion and store them in `crawl_runs.summary`; read from there, falling back to the current query for runs finished before the change.

**Check.** `modules/projects/__tests__/siteHealthDb.test.js`; compare overview numbers for one old and one new run.

### B8. Link graph: use the stored inlink counts

**Problem.** `inboundCounts` reads the whole link graph for a run (now 5,000 rows per trip; production has 2.1M edges in total) to count distinct referring pages. It runs at every crawl completion (`syncFromCrawl`), in per-page module runs, and on AI Visibility `GET /:projectId/prompts/topics`, which needs 60 rows.

**Where.** `server/modules/projects/crawledPages.js:115` (`inboundCounts`), `:203` (`listCrawledPages`), `:315` (`listPageContent`); `server/modules/aiVisibility/routes.js:266`.

**Change.** Crawls now write the final distinct-page inlink count back into each result's `data.inlinks` at completion (`manager.js` "Whole-crawl values the analyzer computed"). For runs that have it, read that instead of the graph. **First prove parity**: the graph count uses `canonicalKey()` normalisation; compare both numbers for every page of a few real runs before switching. For the topics route, push `order by … limit 60` into SQL only if the ranking can be expressed there.

**What can go wrong.** If normalisation differs, inbound-link numbers shift slightly on Projects/Pages screens.

### B9. Crawl completion rewrites every result row three times

**Problem.** At the end of a crawl, three separate passes update `crawl_run_results`: clear the per-page edges, patch page categories, patch link counts. Each pass rewrites every row's jsonb and its index entries.

**Where.** `server/modules/crawlScope/run/manager.js` around `:900-955`.

**Why it is not simple.** Each pass is wrapped in its own `try/catch` on purpose: if categories fail, link counts still land. Merging them into one `update … from jsonb_to_recordset(...)` changes that failure isolation. Only merge if you accept "all or nothing", or keep separate error handling around a merged statement.

### B10. Recommendations from findings: one insert per finding

**Problem.** Creating recommendations from a module run's findings does one insert plus one audit insert per finding (2N round trips).

**Where.** `server/modules/projects/routes.js:1578` loop → `recommendations.create`.

**Why it is not simple.** Batching gives every row the same `created_at` (list order among them can change) and makes the batch all-or-nothing (today, rows before a failing one are kept). Batch only with explicit, increasing `created_at` values and an agreed failure rule.

### B11. Saving a review reads every finding of the run

**Problem.** `PATCH /runs/:id/findings` (saving one dropdown, or "mark all") loads the run's **entire** finding list (up to 50,000 instances plus the texts pass from [B3](#b3-drop-the-separate-distinct-texts-pass-in-the-findings-reader)) just to check that the submitted finding ids belong to the run, then sends that whole list back merged with reviews.

**Where.** `server/modules/crawlScope/api/routes.js:448-493`; `loadRunFindings` at `:357` (falls back to `run.summary.findings` for runs finalized before migration 0023).

**Change.**

1. Validate only the submitted ids: `select finding_id, rule_id from crawl_run_finding_instances where run_id = $1 and finding_id = any($2::text[])`, with a new index `create index … on crawl_run_finding_instances (run_id, finding_id) include (rule_id);`. Keep the `summary.findings` fallback for old runs.
2. Optionally, return only the saved reviews instead of the whole merged list.

**What can go wrong.**

- Step 2 changes the API response, so the client (`client/src/lib/crawlScopeApi.js` and the run page) must change in the same release. Step 1 alone keeps the response identical.
- Today a finding beyond the 50,000 cap cannot be reviewed (it fails validation). A targeted lookup would accept it. That is a fix, but it is a behaviour change.

**Check.** `modules/crawlScope/__dbtests__/comparison.test.js` (carried reviews) and the crawlScope route tests; save reviews on a large run and compare the response before and after.

---

## C. Visible changes that need a decision

### C1. Deleting a user deletes their crawl data

**Problem.** `owner` on `crawl_projects`, `crawl_runs`, `crawl_run_results`, `crawl_run_findings`, `crawl_run_finding_instances` and `crawl_finding_reviews` is `NOT NULL REFERENCES app_users ON DELETE CASCADE` (migrations `0010` lines 56, 78, 147, 160, 185; `0023` line 47). Deleting an `app_users` row would silently delete every project that person created in the shared Position2 workspace, plus all its crawl data. None of those `owner` columns are indexed, so the delete would also scan the largest tables. At the same time `workspaces.created_by` is `NO ACTION`, which blocks deleting anyone who created a workspace — the two rules contradict each other.

Nothing in `server/` deletes `app_users` rows today, so this is a trap, not an active bug.

**Options.**

1. `ON DELETE SET NULL` (make `owner` nullable). Check `projectAccess.js` `applyCreatorGrant` (around `:343-351`) and anything else that assumes `owner` is set.
2. `ON DELETE RESTRICT`: deleting a user with projects fails loudly; reassign first.
3. Keep `CASCADE` and add `owner` indexes on the four large tables (faster, but the data-loss risk stays).

**Recommendation.** Option 2 for projects and runs; drop the `owner` FK entirely on the per-row crawl tables (results, findings, instances, reviews) since their tenancy comes from `run_id`.

### C2. Competitor card reads every tenant's clients

**Problem.** When the competitor card is `not_run`, the overview loads **every** competitor-analysis client from **every** tenant, with full JSON, and matches by domain in JS.

**Where.** `server/modules/projects/overview.js:1362-1365` → `server/modules/competitorAnalysis/store.js:35` (`getClients`, no `WHERE`).

**Change.** Look up by `project_id = $1 limit 1` (index `idx_competitor_analysis_clients_project`), falling back to `data->>'domain' = $2` (index `idx_competitor_analysis_clients_domain`; store the domain normalised).

**What users notice.** A project whose competitor client was linked only by a domain match in another tenant's data stops showing it. That is arguably correct (tenancy), but decide.

### C3. Recommendations summary capped at 500

**Problem.** The board header's counts come from fetching up to 500 full rows and counting in JS, so any project with more than 500 recommendations shows wrong totals.

**Where.** `server/modules/projects/recommendations.js:171` (`summary`).

**Change.** `select status, count(*) from recommendations where project_id = $1 group by status`.

**What users notice.** Totals above 500 become correct.

### C4. Content Architect project list reads everything

**Problem.** `GET /api/content-architect/projects` loads every Content Architect project across all workspaces with its full report JSON, then runs one uncached access check per project, all at once (N+1).

**Where.** `server/modules/contentArchitect/store.js:61` (`listProjects`), `server/modules/contentArchitect/routes.js:74`, `server/modules/contentArchitect/access.js`.

**Decision needed.** Today a legacy project with **no** linked platform project **and no** workspace passes `authorize` and is visible to everyone. A SQL filter by the caller's workspaces would hide it. Decide whether such rows should stay visible, be assigned to the team workspace, or be hidden.

**Change.** Filter in SQL by the caller's workspaces (plus whatever rule is decided for legacy rows), select only list fields (`data->>'domain'`, name, dates), batch the access check.

**Note.** Another session has uncommitted changes in `contentArchitect/access.js` and `routes.js`; coordinate before editing.

### C5. `activity_log` grows forever

**Problem.** Every authenticated API request inserts a row, including the 4-second polls. Nothing reads the table and nothing deletes old rows.

**Where.** `server/services/identityStore.js:971` (`recordActivity`), called from `server/routes/auth.js:289`.

**Decision needed.** Retention period (for example 90 days), and whether GET polls should be logged at all.

**Change.** Skip or sample poll endpoints; add a daily retention delete; index for it: `create index … on activity_log using brin (created_at);`.

### C6. Runs list: exact totals and page numbers

**Problem.** The runs list uses `count(*) over ()` plus `OFFSET` and `label ILIKE '%…%'`, polled every 5–15 s.

**Where.** `server/services/runStore.js:202-230`.

**Status.** **Not needed yet**: production has 125 `tool_runs` rows. Revisit at tens of thousands. The fix (keyset paging, capped "1,000+" total) changes the RunsPage / ModuleRuns UI.

---

## D. Longer-term schema work

| Item | Problem | Change |
|---|---|---|
| D1 Copied `workspace_id` columns | About 12 child tables (`crawl_runs`, `project_pages`, `recommendations`, `ai_visibility_*`, `tool_runs`, …) carry their own nullable `workspace_id` with `ON DELETE SET NULL`, and nothing checks it matches the project's workspace. Reads filter by project, so nothing leaks today, but the copies can drift. | Drop the copies and read the project's workspace, or enforce with a composite FK on `(project_id, workspace_id)`. Highest-risk item in this list. |
| D2 Content Architect child tables have no FK | `content_architect_keyword_research`, `_enhancements`, `_spoke_suggestions` store `project_id text` with no foreign key, so deleting a project leaves orphans. | Delete orphans, then `add foreign key (project_id) references content_architect_projects(id) on delete cascade`. Deleting a project then also deletes its saved work (today it is orphaned). |
| D3 `scope` lives only inside JSON | `crawl_run_results.data->>'scope'` is filtered by seven readers; the new partial index covers the hot ones. | Store `scope` (and `is_asset`) as real columns at insert time, like `status` / `content_type` already are. |
| D4 Ownership only inside JSON | `lpb_*` tables keep `client_id` only in `data`; `competitor_analysis_clients`, `robots_monitor_clients`, `lpb_clients` have no workspace at all. | Move to columns with FKs when those modules are next reworked. |
| D5 Unbounded generic store reads | `server/services/recordStore.js:57` (`list`) has no limit for the location-page builder callers; `:205` (`replaceAll`) inserts one row at a time. | Pass limits; use `insertMany`. Small tables today. |
| D6 No statement timeout anywhere | `server/services/db.js` sets no `statement_timeout`; a blocked query holds its pooled connection forever, and 10 such queries stop the process serving. | Set a generous default (for example 60 s) once [E1](#e1-turn-on-pg_stat_statements) shows real p99s, with explicit overrides for the long crawl-completion writes. |

---

## E. Housekeeping and operations

### E1. Turn on `pg_stat_statements`

All query findings so far were reasoned from code plus local measurements. With `pg_stat_statements` enabled on RDS (parameter group `shared_preload_libraries`, needs a reboot, then `create extension pg_stat_statements`), the real top queries by total time are one query away:

```sql
select calls, round(total_exec_time) total_ms, round(mean_exec_time, 1) mean_ms, left(query, 120)
  from pg_stat_statements order by total_exec_time desc limit 20;
```

Do this before starting the larger B items so their effect can be measured.

### E2. Re-check the kept prefix indexes

Migration 0043 kept six indexes that are prefixes of wider ones because production showed them in use: `idx_crawl_runs_status`, `idx_crawl_run_finding_instances_run`, `idx_crawl_run_results_run`, `idx_admin_limit_policies_effective`, and the two Content Architect `project_id` indexes. Now that new indexes exist, some may stop being used. Snapshot their scan counts and compare in 2–4 weeks; drop any whose count has not moved.

```sql
select indexrelname, idx_scan, last_idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
  from pg_stat_user_indexes
 where indexrelname in ('idx_crawl_runs_status','idx_crawl_run_finding_instances_run','idx_crawl_run_results_run',
                        'idx_admin_limit_policies_effective','idx_content_architect_keyword_research_project',
                        'idx_content_architect_spoke_suggestions_project');
```

Baseline on 2026-10-04: 94,440 / 10,311 / 5,011 / 3,415 / 31 / 100 scans.

### E3. Check `crawl_runs` bloat

27 rows, 551 MB. Find out how much is live data (old runs' `summary.findings`) versus dead versions from checkpoint rewrites ([B6](#b6-heartbeat-rewrites-the-whole-checkpoint-every-30-s)):

```sql
select n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
  from pg_stat_user_tables where relname = 'crawl_runs';
```

If most of it is dead, a plain `VACUUM crawl_runs` (not `VACUUM FULL`, which locks the table) returns space for reuse.

### E4. Commit the other session's migration

`0042_tool_run_jobs.sql` is **applied on production but not committed**; it is still uncommitted in the working tree with the durable-jobs code. Until it is committed, any fresh database built from the repo is missing `tool_run_events` and the new `tool_runs` columns.

### E5. Local access to production

This machine cannot reach RDS port 5432 (public IP `111.92.70.57` is not allowed by the security group), so a local dev server pointed at production shows a blank app. Either allow the IP in the `prod-agents` security group or keep using Railway SSH for checks.

### E6. Railway SSH key

The key `nikhil-laptop-db-audit` (`~/.ssh/id_ed25519`) is registered on the Railway account for the read-only checks. Remove it with `railway ssh keys remove` when it is no longer needed.

### E7. Test-suite issues found while verifying

- `services/__tests__/portedStores.test.js:230-235` fails on any database built from current migrations: its fixture inserts a `crawl_projects` row with no `owner`/`workspace_id`, which migration 0027 made `NOT NULL`. Pre-existing; fix the fixture to create a user and workspace first.
- The PGlite stand-in database used for local DB suites crashes intermittently (WebAssembly `unreachable`) in `budgetRetention.test.js` and `crawlScope/__dbtests__/comparison.test.js`, with and without migration 0043. The local test Postgres on port 5433 is always down. A real throwaway Postgres (Docker or a small RDS/Neon test instance) would make the DB suites reliable.

---

## Deliberately not doing

| Idea | Why not |
|---|---|
| Per-rule SQL aggregate for the overview finding reader | Measured slower (8 s vs 4.6 s): the overview stops at 50k rows, the aggregate scans the whole run. Seek paging was used instead. |
| `(workspace_id, user_id, created_at)` index on `tool_runs` | Existing `idx_tool_runs_user (user_id, created_at desc)` already serves the "mine" filter; the planner preferred it. |
| `(run_id, finding_id)` index on finding instances (on its own) | No current query looks up by `finding_id`. Add it together with [B11](#b11-saving-a-review-reads-every-finding-of-the-run), which is the query that needs it. |
| Dropping the six in-use prefix indexes | Production shows them used; they are tiny. Revisit via [E2](#e2-re-check-the-kept-prefix-indexes). |
| Covering indexes for `runStore.runStats` | `tool_runs` has 125 rows on production. |

---

## How to verify changes safely

**Never run anything locally that reads the repo `.env`**: `DATABASE_URL` there points at **production**.

**Local database.** The pattern that worked for the shipped changes:

1. `npm install @electric-sql/pglite@0.3.15` and `@electric-sql/pglite-socket@0.0.20 --legacy-peer-deps` in a scratch folder (not the repo).
2. Apply every file in `supabase/migrations/` in filename order.
3. Seed synthetic data with `generate_series` (60k pages, 240k finding instances and 480k links took about 2 minutes).
4. Serve it with `PGLiteSocketServer` from a small script that ignores `ECONNRESET` (the stock server dies when a client disconnects).
5. Run the real modules against it with `DATABASE_URL` set to the local socket **before** requiring anything, and compare their output with one unpaged query (`assert.deepStrictEqual`).
6. Run DB suites with `DATABASE_URL= TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres DATABASE_POOL_MAX=1`, one fresh database per suite.

**Production, read-only.** From Railway SSH into environment `unified-fast`, service `seo-apps` (the environment named `production` has no database). Open the connection with `options: '-c default_transaction_read_only=on -c statement_timeout=15000'` so Postgres rejects any write. `railway ssh` truncates long commands: upload scripts gzip+base64 in ~1.5 KB chunks to `/tmp`, run, delete.

**Applying migrations.** `migrate.js` wraps each file in a transaction, so `CREATE INDEX CONCURRENTLY` cannot be used in a migration file; plain `CREATE INDEX` blocks writes to that table while it builds. Check nothing is running first, run `node scripts/migrate.js --dry-run`, then apply:

```
npx -y @railway/cli@latest ssh --service seo-apps --environment unified-fast -- "cd /app/server && node scripts/migrate.js --dry-run"
```

**Deploying.** A push to `unified-fast` redeploys production and kills any running crawl.

---

## Baseline measurements

Production, 2026-10-04 (statistics since 2026-08-27):

| Table | Rows | Total size |
|---|---|---|
| `crawl_run_links` | 2.1 M | 754 MB |
| `crawl_runs` | 27 | 551 MB |
| `crawl_run_results` | 49.6 k | 326 MB |
| `crawl_run_finding_instances` | 216.6 k | 298 MB |
| `project_pages` | 15.5 k | 14 MB |
| `page_category` | 17 k | 7.4 MB |
| `project_module_runs` | 517 | 2 MB |
| `tool_runs` | 125 | 0.4 MB |

Largest single run: 76,070 finding instances, 11,500 result rows.

Local (PGlite, synthetic 60k-page run; ratios matter, not absolute times):

| Query | Before | After |
|---|---|---|
| Whole findings list (`listAllRunFindingInstances`) | 46.4 s | 5.0 s |
| Deepest findings page | 1,906 ms | 70 ms |
| Internal-page count | 1,091 ms | 13 ms |
| PageSpeed rows | 759 ms | 2 ms |
| Delete one rule's findings | 1,903 ms | 235 ms |
| Delete a small crawl run | 1,467 ms | 657 ms |
| Insert 10k link edges | 781 ms | 341 ms |
| Run row with checkpoint (`select *`) vs column list | 129 ms | 1 ms (B1, not shipped) |
