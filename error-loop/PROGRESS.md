# Error loop progress

The only state that survives a context reset. Read this first to find where the
loop is. Updated at the end of every pass.

**Plan:** `error-loop/PLAN.md` · **Gate:** node --check · require-graph ·
`npm test --prefix server` · `npm run build --prefix client`

## Baseline — 2026-09-13, branch `unified-app`

| Gate | Result |
|---|---|
| `node --check`, 348 server files | 0 errors |
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | ok, 1231 modules, 7.4s |
| `require-graph.js` | 0 unresolved / 0 missing exports |

Working tree at baseline: 25 modified, 10 untracked, uncommitted.

## Loop ledger

Grade counts are **confirmed** findings only — anything without a written
failure scenario is not counted here.

| # | Area | Pass | P1 | P2 | P3 | Fixed | Deferred | Gate | Status |
|---|------|------|----|----|----|-------|----------|------|--------|
| 1 | HTTP boundary & auth | A contract | 0 | 1 | 1 | 1 | 1 | ☑ | complete |
| 2 | HTTP boundary & auth | B behaviour | 0 | 1 | 1 | 1 | 1 | ☑ | **area complete** |
| 3 | Platform services | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 4 | Platform services | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 5 | Config & bootstrap | A contract | 0 | 1 | 2 | 3 | 0 | ☑ | complete |
| 6 | Config & bootstrap | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 7 | Database layer | A contract | 0 | 0 | 1 | 1 | 0 | ☑ | complete |
| 8 | Database layer | B behaviour | 0 | 1 | 0 | 1 | 0 | ☑ | **area complete** |
| 9 | Projects module | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 10 | Projects module | B behaviour | 0 | 0 | 1 | 0 | 1 | ☑ | **area complete** |
| 11 | CrawlScope | A contract | 0 | 1 | 1 | 2 | 0 | ☑ | complete |
| 12 | CrawlScope | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 13 | AI Visibility | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 14 | AI Visibility | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 15 | Location Page Builder | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 16 | Location Page Builder | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 17 | Checks & scripts | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 18 | Checks & scripts | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 19 | Content Architect | A contract | 0 | 1 | 1 | 2 | 0 | ☑ | complete |
| 20 | Content Architect | B behaviour | 0 | 0 | 1 | 1 | 0 | ☑ | **area complete** |
| 21 | Competitor Analysis | A contract | 0 | 1 | 0 | 1 | 1 | ☑ | complete |
| 22 | Competitor Analysis | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 23 | Small modules | A contract | 0 | 1 | 0 | 1 | 0 | ☑ | complete |
| 24 | Small modules | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 25 | Client API & state | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 26 | Client API & state | B behaviour | 0 | 0 | 1 | 1 | 0 | ☑ | complete |
| 27 | Client pages & components | A contract | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 28 | Client pages & components | B behaviour | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |

## Confirmed findings

One entry per confirmed defect. Every entry must carry a failure scenario.

<!-- Format:
### L<loop> · <grade> · <file>:<line>
**Defect:** one sentence.
**Fails when:** concrete input/state -> wrong output or crash.
**Fix:** what changed, or DEFERRED + why.
-->

### L1 · P2 · server/routes/workspaces.js:22 and server/routes/runs.js:70,111,130
**Defect:** Both files answered an internal failure with `res.status(500).json({ error: e.message })`,
returning the raw error text to the caller. `server.js`'s final error handler and
`routes/admin.js` both deliberately refuse to do this, so these were inconsistent with
the repo's own stated policy rather than a considered choice.

**Fails when:** the database is unreachable or misconfigured. `identityStore.fail()`
throws `Error('[identityStore.<op>] ' + error.message)` with **no** `status`, and
`UpstreamUnavailableError`'s message is `[identityStore.<op>] upstream unavailable:
<cause>`. So `GET /api/workspaces` against a dead database returned, to any signed-in
user, `{"error":"[identityStore.listWorkspacesForUser] upstream unavailable: connect
ECONNREFUSED 10.x.x.x:5432"}` — internal host and port. A credential fault yields
`password authentication failed for user "…"` the same way. A non-UUID `:id` returned
`invalid input syntax for type uuid: "foo"` as a 500.

**Fix:** Gave both files the `handleError(res, e, req)` helper `routes/admin.js` already
uses — an error carrying a `status` keeps its message and `code` (so the deliberate
400/403/404 paths, and the assertions in `routes/__tests__/workspaces.test.js`, are
unchanged); anything else is logged server-side with method and URL and answered with a
fixed generic message.

### L1 · P3 · server/routes/agentReadinessAudit.js:724 — DEFERRED
**Defect:** Same `res.status(err.status || 500).json({ error: err.message })` shape.
**Fails when:** `runAgentReadiness` throws internally.
**Fix:** DEFERRED. Unlike the two above, this path audits an external URL and its errors
are fetch/parse failures (`ENOTFOUND example.com`) that the user needs in order to act.
It touches no identity or database code, so it leaks no infrastructure detail. Changing
it would remove useful diagnostics; graded P3 and left alone deliberately.

### L2 · P2 · server/routes/keywordResearch.js:84 (`cachedSearch`)
**Defect:** `serpCache` was an unbounded `Map`. `SERP_CACHE_TTL` (24h) was checked on
read to decide whether a hit was fresh, but nothing ever deleted anything: a stale entry
was only displaced if the exact same query string came back.

**Fails when:** distinct queries accumulate. Each keyword issues up to `MAX_VARIANTS + 1`
(6) SERP queries, and every distinct one retains a full `searchGoogle` payload for the
life of the process. A few thousand keywords researched between restarts is tens of
thousands of retained payloads, none of them reachable for eviction — the process RSS
climbs until it is OOM-killed, and a restart is the only recovery.

**Fix:** Added `cacheSerp()` — bounded at `SERP_CACHE_MAX` (2000), sweeping entries past
the TTL when the cap is crossed and then dropping oldest-first (Map insertion order) if
still oversized. Same shape as `stashPendingInput` in `middleware/runTracking.js`, which
is the existing idiom in this repo for exactly this.

### L2 · regression check on Pass A
Re-read both Pass A changes. `workspaces.js`: 8 call sites updated, helper declared at
line 30 before first use at 56; status-carrying errors keep message **and** `code`, so
the deliberate 400/403/404 paths and the `invalid_role` / `last_owner` / `forbidden`
assertions in `routes/__tests__/workspaces.test.js` behave as before. `runs.js`: 3 call
sites updated, helper at line 57 before first use at 104. The two lifecycle routes in
`workspaces.js` have their own catch blocks and were untouched. No regression.

### L5 · P2 · .env.example — 49 variables read by the server, documented nowhere
**Defect:** `error-loop/tools/env-refs.js` compared every `process.env.X` in `server/`
against the keys in `.env.example`: 49 were read by running code and listed nowhere.
Three of them are not tuning knobs but configuration a deployment actually needs.

**Fails when:** someone deploys from `.env.example`.
- `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` gate `dataForSeoClient.isConfigured()`.
  Missing, the AI Visibility surfaces and Market Potential provider that depend on them
  simply do not run, and nothing logs an error — the symptom is a capture returning no
  rows, with no indication that a credential is the reason.
- `PLATFORM_ADMIN_EMAILS` is the only way to add a platform administrator beyond the one
  address hard-coded in `services/platformAdmin.js`. The boot banner prints the resulting
  list as `PLATFORM_ADMIN:`, so an operator can see it but had no documented way to change
  it.

**Fix:** Documented all 49 in `.env.example` under a new marked section — the two
credential groups with what breaks without them, the rest grouped by subsystem with
their real defaults read off the code. `env-refs.js` now reports 0 undocumented.

### L5 · P3 · server/server.js:464 — boot banner reported a variable that does not exist
**Defect:** The startup banner printed `APP_USERNAME: ✗ missing`. `APP_USERNAME` appears
in exactly one place in the whole repo: that line. Nothing reads it, no file documents it.

**Fails when:** every boot. The check can only ever print "✗ missing", so every operator
is told their configuration is incomplete and sent looking for a variable that does not
exist and cannot be set.

**Fix:** Removed the line (a fossil of the removed shared-token login) rather than
documenting it, since there is nothing to set. Added a `DATAFORSEO:` line in its place,
which reports a credential pair that *is* read and was previously invisible at boot.

### L5 · P3 · .env.example:77-80 — four dead credential fields, uncommented
**Defect:** `SEO_USERNAME`, `SEO_PASSWORD`, `EXTENDED_USERNAME`, `EXTENDED_PASSWORD` sat
as blank **uncommented** fields under an "Auth" heading. Nothing has read any of the four
since the shared-token logins were removed — `routes/auth.js` now rejects even a
validly-signed cookie minted by them.

**Fails when:** someone sets them up. Presented uncommented under "Auth", they read as
"fill these in to create a login". They create nothing, and a real password typed there
sits in `.env` serving no purpose. (`docs/unification/06-evidence.md:228` had already
counted this drift; it had not been acted on.)

**Fix:** Replaced with a comment saying the shared-token logins were removed, that nothing
reads these four, and that sign-in is Google OAuth plus the allowlist.

### L6 · regression check on Pass A
Re-read all three Loop 5 changes. The `server.js` banner edit is inside the `app.listen`
callback and leaves the surrounding log lines intact; `node --check` and the suite pass.
The two `.env.example` changes are documentation and change no code path — confirmed by
`env-refs.js` reporting the same 116 keys read before and after. No regression.

### L6 · behaviour lens — no defects
- Middleware order: rate limiter before `express.json`, so a 20 MB body flood is throttled
  before it is parsed. Correct, and deliberately commented as such.
- `OWN_LIMITER_PREFIXES` (15 entries) was checked against the actual mounts one by one:
  every route carrying its own `kbLimiter`/`lpbLimiter` is present, so nothing is
  double-limited and nothing carrying a per-route limiter escapes limiting entirely.
- Shutdown budget arithmetic: `WORKER_SHUTDOWN_DRAIN_MS` (15s) + `API_MANAGER_DRAIN_MS`
  (11s) = 26s, inside `SHUTDOWN_FORCE_MS` (28s), as the comment claims. The force timer is
  `unref()`d but the live server handle keeps the loop alive, so it still fires.
- Handler order: static → `/api` 404 → SPA catch-all → 4-arg error handler last. An
  unmatched `/api` path gets JSON 404 rather than the SPA shell.
- `jobs/cachePurge.js` validates the cron expression before scheduling and wraps the purge
  in `.catch`, so neither a bad `LPB_CACHE_PURGE_CRON` nor a failing sweep takes the
  process down.

### L7 · P3 · server/scripts/migrate.js — `--accept-edit <prefix>` silently picked one of two files
**Defect:** `accept()` resolved a prefix with `files.find(f => f.filename.startsWith(arg))`.
Two prefixes match two files each: `0009` and `0026`.

**Fails when:** an operator edits `0026_lpb_collections.sql` and runs
`--accept-edit 0026`. `find()` returns `0026_keyset_pagination_indexes.sql` (sorts first),
whose checksum is intact, so the runner prints a **green "already matches"** and exits 0.
The mismatch that is actually blocking the runner is never touched, and the message reads
like success. `--accept-edit 0009` has the same shape.

**Fix:** Resolve with `filter`, refuse an ambiguous prefix (exit 2) and print both
candidates. Verified by replaying the resolution over the real filenames: `0009` and
`0026` now refuse and list both; `0010` and a full filename still resolve; a
non-matching prefix still exits 2. The header comment documented the 0009 pair but not
the 0026 pair — both are now described, along with why a shared prefix is harmless for
bookkeeping (`schema_migrations` is keyed by full filename) but not for prefix resolution.

### L8 · P2 · supabase/migrations/0022_page_category.sql:79 — the one non-re-runnable statement
**Defect:** `alter table page_category add constraint page_category_client_rule_fk …`
with no guard. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, and every other constraint
in this schema is wrapped in a `do $mig$ … if not exists (select 1 from pg_constraint
where conname = …)` block (0012 does it four times, 0027 twice). The other four DDL
statements in this very file all carry `if not exists`, so this was an oversight rather
than a decision.

**Fails when:** a database that had 0022 applied by hand before the migration runner
existed, and was never baselined. The runner sees 0022 as pending and re-runs it; this
line raises 42710 (`constraint … already exists`); and because the runner stops at the
first failure by design, 0023 through 0027 are blocked behind it. `--baseline-through` is
the documented way around this, but plain `node scripts/migrate.js` — the documented
"apply everything pending" path — hits a hard stop.

**Fix:** Wrapped in the same `pg_constraint` guard the rest of the schema uses. The edit is
schema-neutral (identical resulting schema), which is precisely the case
`--accept-edit 0022` exists for on a database that already applied it.

### L8 · regression check on Pass A
Replayed `--accept-edit` resolution against the real migration filenames after the change:
ambiguous prefixes refused with both candidates listed, unambiguous prefixes and full
filenames unchanged, no-match still exit 2. `node --check` passes and the suite is
191/191. The header-comment edit changes no code path.

### L7/L8 · database layer — what else was checked
- `sql-refs.js` over all of `server/`: no SQL names a table or insert column that no
  migration defines. The 6 remaining hits are benign and identified:
  `schema_migrations` (bootstrapped by `migrate.js` itself, deliberately not a
  migration), one interpolated table name in a one-off copy script, and one prose string.
- **Duplicate migration numbers (0009, 0026) — verified safe, not a defect.**
  `schema_migrations.filename` is the PRIMARY KEY, so the two halves of a pair are two
  independent rows; ordering is a full-filename `.sort()`, so it is deterministic; and
  `--baseline-through` matches on both `<= cutoff` and `startsWith`, so a cutoff of 0009
  or 0026 takes both. Renumbering is explicitly warned against in the file header
  (0009_run_tracking creates `workspaces.is_personal`, which 0011 reads).
- **FK contradiction scan:** parsed 77 FK columns with an `on delete` clause across all
  24 migrations. Zero are `NOT NULL` combined with `ON DELETE SET NULL`.
- **Idempotency scan, 4 candidates rejected.** 0011's `platform_admin_grants` insert and
  0027's `workspaces` / `project_domains` inserts are all guarded by `where not exists`
  (the scanner only looked for `on conflict`). 0027's two `add constraint` statements sit
  in a `DO` block that drops the existing constraint by name first, so a re-run drops and
  re-adds — idempotent.

### L10 · P3 · projects autostart — check-then-enqueue with no database guard — DEFERRED
**Defect:** All four autostart paths decide whether to queue a module run by reading
`project_module_runs` and enqueueing when nothing matches. `project_module_runs` carries
**no unique constraint** on `(project_id, module_key, trigger)` — 0012 and 0019 declare
only non-unique indexes — so the read and the write are not atomic together.
`homepageAutostart` collapses concurrent calls with an in-process `scheduling` Map, which
holds within one process and not across replicas; `hubSpokeAutostart` and
`competitorAutostart` have no equivalent. (`crawlAutostart` deliberately does not check,
and says why: a project that was just created cannot already have a crawl.)

**Fails when:** two setup events for the same project are handled concurrently by two web
replicas — a double-clicked "finish setup" behind a load balancer. Both read no existing
run, both enqueue, and the project gets two `seo_geo` and two `agent_readiness` runs. The
queue claim itself is atomic (`for update skip locked`), so this duplicates work and the
API spend it bills; it does not corrupt anything, and later calls see both rows and stop.

**Fix:** DEFERRED. The correct fix is a partial unique index — e.g. `unique
(project_id, module_key, trigger) where status in ('queued','running')` — plus `on
conflict do nothing` on the enqueue, which would make the guard atomic and let the
in-process Map go. That is a schema change, and adding a migration to a branch that is
mid-merge is out of proportion to a defect sweep. Graded P3 deliberately: it costs
duplicated spend under a narrow race, not correctness.

### L9/L10 · projects module — what was checked
- All five detectors clean over `server/modules/projects` (0 findings each).
- **Authorization coverage: 40/40 routes.** Every route in the 1500-line `routes.js`
  reaches `projectAccess.requireProject` / `requireWorkspace`; none authorizes implicitly.
  Capability split: view 16, editProjectSettings 5, startRun 3, editRecommendation 3,
  manageCompetitors 2, purgeProject 1, overrideRobotsPolicy 1.
- **Capability-name audit (new check, whole server).** `capabilityFor` returns false for
  an unknown name, so a typo silently denies everyone rather than throwing. Every
  capability string reaching `requireProject` / `requireWorkspace` / `.can()` /
  `assertCapability` / `capabilityFor` was compared against the 19 declared keys: **zero
  typos in production code.** The only two unknown names are `aproveRecomendation` and
  `deleteEverything` in `platformFoundation.test.js:224-225`, which exist precisely to
  assert that a typo denies.
- **Three capabilities declared but never enforced** — `reviewFinding`,
  `overrideMachineOutcome`, `manageRecipients`. Checked for the UI-only-permission gap and
  **rejected**: the client references none of the three, and the action they would cover
  (recipients) is protected by `editProjectSettings` on `PATCH /:projectId`. They are
  matrix entries transcribed from PRD §7.2 ahead of the features. No route is
  under-protected.
- **store.js workspace filtering:** both `crawl_projects` queries filter
  `workspace_id = any($1)` in the SQL (with an explicit comment that the filter is never
  applied after the fetch); the `project_domains` join filters `p.workspace_id = $1`; and
  `domainsForProjects` takes ids that were already workspace-scoped by its caller.
- **`projects/routes.js` already had the correct `handleError`** (status-carrying errors
  keep their message, everything else is logged and generalised) — the same shape L1
  applied to `workspaces.js` and `runs.js`, which confirms that fix matched the repo's
  dominant idiom rather than inventing one.
- Coverage limit: `overview.js` (1319 lines), `moduleRunners.js` (1400) and
  `moduleEvidence.js` (1047) were covered by detectors and by the authorization and
  capability audits, **not** read line by line.

### L11 · P2 · server/modules/crawlScope/api/routes.js:804 — router error handler echoed the database
**Defect:** `res.status(status).json({ error: error.message || "Server error." })` for every
status, 500 included. Same class as L1, in a module that reaches the database on nearly
every route.

**Fails when:** anything in `db/repo.js` throws. That file has exactly one `catch` in 966
lines — `createRun` and its neighbours call `client.one(...)` directly — so a driver error
travels raw through `asyncRoute`'s `.catch(next)` into this handler. `POST /runs` against
an unreachable database answered any signed-in caller with `connect ECONNREFUSED
<host>:<port>`; a bad credential with `password authentication failed for user "…"`; a FK
violation with the constraint name `crawl_runs_project_id_fkey`; and `db.one`'s own
`expected exactly one row, got 0` leaked an internal helper's wording.

**Fix:** Split the two cases. Below 500 the error was raised deliberately and its message
is written for the caller (`ValidationError` carries `status = 400`), so it passes through
unchanged along with `code`. At 500 and above the error is logged in full and answered
with a fixed message. Verified no crawlScope test asserts on a 500 body; suite 191/191.

### L11 · P3 · server/modules/crawlScope/api/routes.js:124 — stale count in the catalog comment
**Defect:** The comment described the issue catalog as "92 checks".
**Fails when:** someone trusts it. `issue-catalog.json` holds **96** entries, and
`audit-loop/rules/rule-classes.json`'s `_meta` independently declares 96 (27 error, 54
warning, 15 notice) — the audit tooling already treats a mismatch between those two as a
`catalog_drift` defect, so the comment was the only copy still saying 92.
**Fix:** Corrected to 96 with the severity split, noting both sources agree.

### L12 · behaviour lens — no defects
- **Unbounded-growth sweep** (the class that produced the real L2 finding) over all 23
  `Map`/`Set` declarations in `crawler.js`, `run/manager.js` and `worker/index.js`.
  All rejected: most are per-crawl instance state bounded by the run's `maxUrls` budget
  and freed with the crawler. The two process-lifetime ones are already guarded —
  `robotsPatternCache` is explicitly capped at 5,000 entries with a comment saying a
  pathological robots.txt must not grow it without limit, and the manager's `crawlers`
  Map and `executions` Set are both removed from in cleanup.
- **Resource cleanup on the failure path:** `manager._execute`'s `finally` clears the
  heartbeat and control intervals, deletes the run from `this.crawlers`, and closes the
  fetch dispatcher — so a thrown crawl leaks neither a timer, a map entry, nor a
  dispatcher. The `catch` above it also flushes and marks the run `failed` before
  rethrowing.
- **Middleware ordering:** `router.use(crawlScopeContext)` sits at line 129 and every
  data route is registered after it. The one route before it, `GET /catalog`, is static
  reference data and documented as deliberately readable without a DB round trip.
- **Authorization architecture** (resolving the L9 recon): CrawlScope does not authorize
  in handler bodies. `crawlScopeContext` builds `req.crawlViewer` from
  `projectAccess.accessibleWorkspaceIds`, and `repo.getRunForViewer` applies it as the
  tenancy boundary. The 6 crawlScope routes my handler-body scan flagged are therefore
  **false positives** — the scan could not see router-level guards.
- Coverage limit: `crawler.js` (3502 lines) and `analyzer.js` (2033) were covered by the
  detectors and the sweeps above, not read line by line. Both are heavily covered by the
  existing suite.

### L12 · regression check on Pass A
The error-handler change preserves every deliberate 4xx (status < 500 returns
`error.message` and `code` exactly as before) and alters only the 500 branch, which no
test asserts on. The comment correction changes no code path. `node --check` clean,
191/191, client builds.

### L13/L14 · AI Visibility — no defects found
- All five detectors clean over `server/modules/aiVisibility`.
- **Authorization: 19/19 routes.** `handleError` already follows the correct pattern
  (status-carrying errors keep message and `code`; everything else logged and
  generalised) — unlike `workspaces.js`, `runs.js` and `crawlScope`, which did not.
- **Run-tracking registry audit (new check).** `server.js:48` is
  `track = (mountKey) => trackRuns(RUN_TRACKING[mountKey])`, and `trackRuns` returns a
  **no-op middleware when its config is falsy** — so a mount key absent from the registry
  silently records no runs at all, with no error and no warning. Compared every
  `track('X')` in `server.js` against `Object.keys(RUN_TRACKING)`: **20 keys, 20 mounts,
  zero drift in either direction.**
  My first reading of this looked like drift (`track('competitor-tracker')` with no
  matching `toolId`) and was wrong: the lookup is by object KEY, and `competitor-tracker`
  is a key whose `toolId` is `competitor-analysis`. Recorded because the check is worth
  re-running, and because the toolId/key distinction is easy to misread.
- **`/api/ai-visibility` is mounted without `track()`** — checked and correct, not an
  omission: the module has no `RUN_TRACKING` entry because it keeps its own run lifecycle
  in its own tables, so there is nothing for the generic middleware to observe.
- **`retention.js` reviewed in full.** The batch bound is a subquery inside the `update`
  rather than a select-then-update round trip, so the two steps cannot disagree about
  which rows were swept; it NULLs `raw` instead of deleting capture rows, which keeps
  every historical metric reproducible (METRICS.md §11). `cutoffIso` uses
  `setUTCMonth(-months)`, which drifts by one day when `now` is 29 February — a one-day
  shift in a 12-month window, once every four years. Not recorded as a defect.
- Coverage limit: `store.js` (1563 lines) and the `metrics/` tree (1224) were covered by
  detectors and the audits above, not read line by line. Both are heavily covered by the
  existing suite — a large share of the 191 tests are aiVisibility's.

### L15/L16 · Location Page Builder — no defects found
- All detectors clean over `server/locationPageBuilder`. Its HTTP surface lives in
  `server/routes/lsPages.js` and `routes/locationPageBuilder.js`, both covered in L1/L2,
  where every handler was confirmed to go through a `wrap()`/`wrapStep()` helper that
  catches.
- **Table-name interpolation checked for injection and cleared.** `store.tableFor()`
  builds `lpb_${collection.toLowerCase()}` at runtime and does NOT validate against its own
  `COLLECTIONS` list, so the guard has to be downstream — and is:
  `recordStore.table()` rejects anything not matching `^[a-z_][a-z0-9_]*$` before
  interpolating, and quotes the result. `jsonKey()` guards `data->>'field'` the same way.
  Both are written as literals rather than bound parameters deliberately, because a bound
  key makes the expression opaque to the planner and turns eleven indexed collections into
  sequential scans — the reasoning is documented at the call site.
- The route-level `CRUD_COLLECTIONS` whitelist (9 entries) is deliberately narrower than
  `COLLECTIONS` (11): `pages` and `keywordSelections` are excluded from generic CRUD
  because they have their own routes.
- **Versioned cache keys** — `cachePurge`'s header warns that a hand-bumped key prefix
  orphans rows. Checked all four prefixes (`dental-kw-adapter-v8`,
  `dental-kw-primary-check-v7`, `dental-kw-review-v2`, `ls-brief-v1`): each appears exactly
  once, so no reader is still pointing at a superseded prefix. Expiry is applied on read
  and physical deletion is the `jobs/cachePurge.js` sweeper, verified in L6.
- Coverage limit: the generation/QA tree (`contentGenerator.js` 887, `lsQa.js` 788,
  `qaEngine.js` 749) was covered by detectors, not read line by line. These are pure
  transform functions with direct unit tests in the suite.

### L17/L18 · Checks & scripts — no defects found
- **Script entrypoint cleanup.** 3 of 5 scripts end with `main().catch(async (error) => {
  … await db.end(); process.exit(n) })` and `importKeywordUniverse.js` with
  `main().then(() => db.end()).catch(…)`. `auditPages.js:90` is a bare `main();`, which
  looked like the odd one out and like a pool that never closes — **rejected on reading**:
  that script imports `fs`, `path`, `axios` and `runAllChecks` and touches no database at
  all, so there is no pool to leak, and Node prints and exits non-zero on rejection.
- **`floating-promise` repo-wide reduces to that single `main()`**, now explained. No
  dropped promises anywhere in `server/`.
- **`sql-refs` over checks+scripts:** only `schema_migrations` (×4 in `migrate.js`), which
  that script bootstraps itself precisely because a migrations table cannot be created by
  a migration. Correct.
- **Verified a Loop-1 rejection at runtime rather than by reading.** The first draft of
  `require-graph.js` claimed `seoGeoChecks.js` did not export `resolvePageIntent`,
  `summarizeLocalBusiness`, `validateOpeningHours` or `contentOnlyText`. Required the
  module and checked: all four are `function`. Confirms the 35 v1 "missing export"
  findings were parser artefacts, and that the rewritten detector's zero is the correct one.
- Coverage limit: `seoGeoChecks.js` (2712 lines) and `keywordMatch.js` (1000) were covered
  by detectors, not read line by line. `seoGeoChecks` has a dedicated 515-line test file.

### L19 · P2 · server/modules/contentArchitect/routes.js — 9 handlers with no error containment
**Defect:** Nine `async` handlers had no try/catch, no wrapper, and this router registers
no error middleware of its own. Express 4 does not forward a handler's rejected promise to
`next()`, so nothing reaches `server.js`'s error handler: **no response is written at all**
and the request hangs until the client times out. (`server.js` does register
`process.on('unhandledRejection')`, so the process survives and logs — which is why this
never showed up as a crash.)

**Fails when:** any write fails. `store.writeAtomic()` rethrows whatever the filesystem
gave it, and the data root comes from `CONTENT_ARCHITECT_DATA_ROOT`, which
`services/dataRoot.js` warns is ephemeral inside a container image. Pointed at a path that
is not writable — an unmounted volume, a read-only filesystem, a full disk — every
mutation (`PUT /projects/:id/competitors`, `PUT /projects/:id/patterns`,
`DELETE /projects/:id`, …) hung instead of returning 500.
Reads cannot trigger it: `store.readJson` catches everything and returns a fallback.

**Fix:** Added the `wrap()` helper already used in `routes/lsPages.js`,
`routes/locationPageBuilder.js` and `modules/crawlScope/api/routes.js` (with
`if (!res.headersSent)` so it cannot double-respond), and applied it to all nine. The two
SSE handlers were deliberately left alone — they already carry their own try/catch and
manage a streaming response. `async-route-guard` now reports 0 unguarded / 9 wrapped.

### L19 · P3 · routes.js `PUT /projects/:id/patterns` — null dereference
**Defect:** `const patch = { stats: { ...project.stats, urlsSelected } }` with no null check,
although `store.getProject()` returns `null` for a missing project. The guard above it
only establishes that the *patterns* exist.

**Fails when:** patterns exist but the project does not. Patterns live in their own sidecar
(`<id>_patterns.json`), not in `projects.json`, so the two can disagree:
`deleteProject()` removes the project from `projects.json` **first** and unlinks the four
sidecars **after**, so a request landing in that window reads patterns, gets `null` for the
project, and spreads `...null.stats` into a TypeError — which, before the fix above, hung
the request rather than erroring.

**Fix:** Added the missing `if (!project) return res.status(404)`, matching every sibling
handler in the file.

### L20 · P3 · routes.js `POST /projects` — filesystem paths in a 500 body
**Defect:** `res.status(500).json({ error: err.message })` after the two deliberate 400
cases. **Fails when:** `createProject` fails a write — the body becomes a raw filesystem
error such as `EACCES: permission denied, open '/data/content-architect/projects.json'`,
disclosing deployment paths. **Fix:** Logged and generalised, matching the
`router.param('id')` handler directly above it, which already did this correctly.

### L20 · regression check on Pass A
`wrap()` guards with `if (!res.headersSent)`, so a handler that already responded and then
throws cannot double-respond. The nine wrapped handlers keep their own deliberate 400/404
returns unchanged (those return normally, never throw). The SSE routes were not wrapped and
still hold their own try/catch. `node --check` clean, suite 191/191, client builds.

### L19/L20 · authorization note
Content Architect authorizes in `router.param('id')`, not per handler: it loads the project,
and when it carries a `platformProjectId` it calls `projectAccess.requireProject` with a
capability chosen by method (GET→view, DELETE→editProjectSettings, else startRun). This
resolves the L9 recon count of "only 2 scoped calls" — the module is guarded once, centrally.
Standalone projects with no `platformProjectId` are unscoped by design, like LPB.

### L21 · P2 · server/modules/competitorAnalysis/routes.js — 9 handlers with no error containment
**Defect:** Identical to L19. Nine `async` handlers, no try/catch, no wrapper, no router
error middleware — so a rejection wrote no response and the request hung.

**Fails when:** two routes, and the second is the sharper one.
1. `store.writeAtomic()` does not catch (`fs.writeFile` then `fs.rename`, both raw), and
   `COMPETITOR_ANALYSIS_DATA_ROOT` is ephemeral inside a container image.
2. The store throws **deliberate validation errors** — `'Client not found'`,
   `'domain is required'`, `'Maximum of 4 competitors per client'`. Those were written to
   become 4xx responses. Reaching an unguarded handler, they became hung requests instead:
   `DELETE /clients/:clientId` for an unknown client never answered at all.

**Fix:** Added the same `wrap()` helper and applied it to all nine. Two needed hand
editing — my wrapping script's string tracker treated the apostrophe in the comments
`spec's` and `won't` as an open quote, so it could not find the call's closing paren.
Worth recording: the script reported those as `NO CLOSE` rather than mangling them, and
`node --check` plus the detector confirmed the result either way.

### L23 · P2 · marketPotential (4 handlers) + onPageAudit (3 handlers) — same defect
**Defect and failure mode:** as above. `marketPotential` is reachable through its provider
clients (SEMrush / DataForSEO) as well as store writes under
`MARKET_POTENTIAL_DATA_ROOT`; `onPageAudit` writes through `fs.writeFile` under
`ON_PAGE_AUDIT_DATA_ROOT`. Both roots are ephemeral in a container per
`services/dataRoot.js`.
**Fix:** Same `wrap()` helper in both. `robotsMonitor` was checked and is already clean.

### L21-L24 · outcome: the whole repo now has error containment
`async-route-guard` over `server/modules`, `server/routes` and `server/locationPageBuilder`
reports **0 unguarded handlers**. The single remaining hit is the long-standing false
positive at `routes/agentReadinessAudit.js:909` — `await browser.close().catch(() => {})`
inside a catch block, which cannot reject.

Totals for this defect class across L19-L23: **25 handlers in 4 modules**, every one of
which turned a failure into a hung request rather than a 500.

### L22/L24 · behaviour lens — no further defects
- In-memory run maps (`runs`, `pageSpeedRuns`, `contentAnalysisRuns`) are keyed by
  clientId — a bounded key space — and `DELETE /clients/:clientId` removes all three
  entries. Not the unbounded-growth shape found in L2.
- `POST /clients/:clientId/run` responds `{status:'running'}` and then does its work in a
  fire-and-forget IIFE that has its own try/catch. Wrapping it is safe: `wrap()` guards
  with `if (!res.headersSent)`, so the already-sent response cannot be written twice.
- `robotsMonitor`: 0 unguarded handlers, nothing to fix.

### L25 · client↔server API contract — intact, and proven so
Built `error-loop/tools/api-contract.js`, the detector this area was scheduled for and the
highest-yield check for a branch mid-merge: a route that moved leaves the client calling a
path that no longer exists, and **nothing catches it** — the client is plain JSX so the
build does not resolve template-literal URLs, and no test issues HTTP. The first symptom is
a button that silently does nothing.

**Result: 274 server routes, 202 client calls, 0 mismatches.**

Getting there took three corrections, each found by reading the hits rather than trusting
the count:
1. **74 false positives** from conflating two conventions that sit side by side in
   `client/src/lib`: `crawlScopeApi`'s helper is `fetch(\`${BASE}${path}\`)` with relative
   call sites, while `aiVisibilityApi`'s is `fetch(path)` with call sites passing the full
   path. Prepending BASE to both produced doubled prefixes like `/api/ai-visibility*/*/report`.
2. Template literals containing nested backticks (`${qs ? \`?${qs}\` : ''}`) truncated the
   captured path. Replaced the regex capture with a brace-aware scanner.
3. **19 remaining, all false** — routes generated in loops, e.g.
   `for (const decision of ['approve','reject']) router.post(\`/:projectId/domains/:domainId/${decision}\`)`,
   which normalises to `/*/domains/*/*` while the client calls `…/domains/*/approve`.
   Fixed by comparing segment-wise, treating a server `*` as matching any one segment —
   which is what an Express `:param` actually means.

**Self-tested before the zero was believed:** injected a client call to a nonexistent
endpoint and a nonexistent module; the detector flagged both and left the valid call alone.

### L26 · P3 · client/src/pages/AgentReadinessAuditPage.jsx:833 — unguarded localStorage
**Defect:** `localStorage.removeItem(...)` in an onClick with no try/catch, while the same
file's read and write of that same key (lines 360-369) are both wrapped.
**Fails when:** site data is blocked — *accessing* `localStorage` throws a SecurityError,
it does not return null. The dismiss button then threw inside a React event handler, and
React does not route event-handler errors to an error boundary, so it surfaced as an
uncaught exception while `setDelta(null)` had already run and the dismissal looked
half-applied.
**Fix:** Wrapped, matching the file's own idiom.

### L26 · localStorage audit — all 20 sites
Checked every `localStorage` site in `client/src`. All are guarded, provably unreachable
when storage is blocked, or comments. Two candidates were **rejected on reading**:
- `MacWindow.jsx` and `ThemeContext.jsx` — the app shell and the theme provider, where a
  throw would be a blank page rather than a degraded feature. Both already wrap their
  reads; a line-oriented grep hid the `try {` sitting on the preceding line.
- `MarketPotentialPage.jsx:384` — an unguarded `removeItem` that runs on every mount. Not
  reachable when storage is blocked: `loadSaved()` is guarded and returns `[]`, and
  line 365 returns early on an empty list.

### L27/L28 · client pages & components
`client/src` is ~51k lines across 37 pages and 14 component directories. Coverage here is
deliberately class-based rather than line-by-line, and the classes checked were:
- **Vite production build** — resolves every import across 1231 modules and fails on a bad
  one. Green throughout the sweep.
- **API contract** — all 202 call sites (above).
- **Browser-storage guarding** — all 20 sites (above).
- `client/src/lib/activeWorkspace.js` (new in this working tree) read in full: it activates
  the workspace server-side **first**, so a failure leaves both the cookie and the
  localStorage project selection as they were rather than desynchronised in a new way, and
  it reconciles the project selection into the new workspace. Correct as written.
- Not covered: per-component React semantics (effect dependency arrays, memoisation,
  cleanup). A future pass wanting that should start there.


## Final state — all 28 loops complete

| Gate | Baseline | After |
|---|---|---|
| `node --check`, all server files | 0 errors | 0 errors |
| `npm test --prefix server` | 191 pass / 0 fail | 191 pass / 0 fail |
| `npm run build --prefix client` | ok | ok |
| `require-graph` | 0 / 0 | 0 / 0 |
| `async-route-guard` (whole server) | **25 unguarded handlers** | **0** |
| `route-params` (whole server) | 0 | 0 |
| `floating-promise` (whole server) | 0 real | 0 real |
| `env-refs` | **49 undocumented** | **0** |
| `sql-refs` | 0 real | 0 real |
| `api-contract` | not built | **0 mismatches** (274 routes / 202 calls) |

**13 confirmed defects fixed, 3 deferred** across 14 areas.

### The defects, by what they would have done
1. **25 Express handlers with no error containment** (contentArchitect 9,
   competitorAnalysis 9, marketPotential 4, onPageAudit 3) — a failure wrote no response
   at all and the request hung until the client timed out. Included deliberate validation
   errors (`'Client not found'`) that were meant to be 4xx.
2. **Raw database errors returned to signed-in callers** in `workspaces.js`, `runs.js` and
   `crawlScope` — `connect ECONNREFUSED <host>:<port>`, `password authentication failed
   for user "…"`, constraint names.
3. **49 environment variables read but documented nowhere**, including
   `DATAFORSEO_LOGIN`/`PASSWORD` (silently disables two modules, logs nothing) and
   `PLATFORM_ADMIN_EMAILS` (the only way to add a platform admin).
4. **A migration that blocks every later migration** — 0022's unguarded `add constraint`
   raises 42710 on a re-run, and the runner stops at the first failure.
5. **`--accept-edit 0026` acting on the wrong file** and printing a green "already matches"
   while the real mismatch went untouched.
6. An unbounded `serpCache`, a null dereference, a boot banner reporting a variable that
   does not exist, four dead credential fields, a stale catalog count, an unguarded
   `localStorage` call.

### What the loop's discipline was worth
Roughly **150 mechanical candidates, 13 real defects.** Every detector produced false
positives on its first run — the first one produced 36 of them, all phantom. The rule that
nothing is a defect until it has a written failure scenario is what kept the other ~137
from being "fixed" into a codebase that was already green. Several rejections are recorded
above in as much detail as the fixes, because knowing why something is *not* a bug is what
stops the next pass re-litigating it.

### Honest coverage limits
The largest files were covered by detectors and by targeted class checks, not read line by
line: `crawler.js` (3502), `seoGeoChecks.js` (2712), `analyzer.js` (2033), aiVisibility's
`store.js` (1563) and `metrics/`, projects' `overview.js`/`moduleRunners.js`/`moduleEvidence.js`,
LPB's generation and QA tree, and per-component React semantics across ~51k lines of client
code. Each is noted in its own loop entry as the place a further pass should start.

## Deferred

Findings not fixed in their pass, with the reason. A defect deferred in three
separate areas is not a deferral — it is the next piece of work.

- **L1 · P3 · `routes/agentReadinessAudit.js:724`** returns raw `err.message` on a 500.
  Left deliberately: it audits an external URL, so its errors are the diagnostics the
  user needs, and it touches no identity or database code.
- **L10 · P3 · projects autostart check-then-enqueue race.** Needs a partial unique index
  on `project_module_runs (project_id, module_key, trigger)` plus `on conflict do
  nothing`. Deferred because it is a schema change on a mid-merge branch. Full reasoning
  in the finding above.

## Unconfirmed / rejected candidates

Candidates a detector or a read raised that did **not** survive verification.
Recorded so later passes do not re-litigate them.

- **L3/L4 · Platform services — no defects found.** What was actually checked, so a later
  pass knows what is and is not covered:
  - `require-graph`, `async-route-guard`, `route-params`, `floating-promise` and
    `sql-refs` all run clean over `server/services` (0 findings each).
  - Read in full: `db.js`, `projectAccess.js`, `moduleQueue.js` (claim path),
    `workspaceContext.js` (cache), `platformAdmin.js` (cache), `identityStore.js`
    (error wrapping). Read partially: the remaining 28 service files were covered by
    the detectors and by targeted greps (empty catches, loose equality), **not** line by
    line. A later pass wanting full line coverage of services should start there.
  - `db.tx()` releases its client in a `finally`, so a throwing transaction body cannot
    leak a pool connection.
  - `projectAccess.applyCreatorGrant` compares `project.owner` to `context.userId`;
    verified against 0010 that `crawl_projects.owner` is `uuid references app_users(id)`,
    so the comparison is uuid-to-uuid and the creator grant really does apply. Its comment
    claims 0027 made `workspace_id` NOT NULL with ON DELETE RESTRICT — verified true
    (0027 §5 and §6), so the removed legacy-owner fallback is genuinely unreachable.
  - `moduleQueue.claimNext` is a single statement using `for update skip locked` with
    `and r.status = 'queued'` re-asserted on the update and `attempts` incremented from
    the row's own value. Two workers cannot claim one run.
  - The `workspaceContext` and `platformAdmin` caches were checked against the same
    unbounded-growth defect found in L2, and **rejected**: both are keyed by user id or
    email (a key space bounded by the allowlist) and delete expired entries on read.
    `serpCache` was keyed by arbitrary query text, which is why it grew and these do not.
- **L3 · sql-refs, 2 candidates (rejected — detector bug).** `project_module_runs.attempts`
  and `.scheduled_for` reported as undefined. Migration 0019 does add both, in a single
  `alter table … add column a, add column b, …` statement; the detector's regex matched
  only the first clause. Fixed to read the whole statement. Also tightened: a string merely
  CONTAINING a SQL keyword is no longer treated as SQL, which had produced tables named
  'the', 'an', 'top' and 'each' out of LLM prompt text.
- **L3 · floating-promise, 67 → 4 → 0 candidates (all rejected).** Three separate detector
  faults, each found by reading the hits: async names collected globally so a sync
  `cacheSet` was matched against an async one in another file; concise arrow bodies
  (`() => worker()`, `.then(() => fetchIt(d))`) counted as dropped when they return the
  promise; and class-method declarations (`async _foo() {`) read as calls to themselves.
  After all three fixes `server/services` is clean and the whole of `server/` has one hit,
  `scripts/auditPages.js:90`, which is a CLI's top-level `main()` — Node exits non-zero
  and prints on rejection, so it fails loudly. Not a defect.
- **L3 · process.env.USERNAME (rejected).** Used in four files to build a Windows Chrome
  path. It is one candidate in a `findLocalBrowser()` list that falls back to
  `chromium.executablePath()`; an undefined USERNAME yields a path that simply does not
  exist. Working as intended.
- **L2 · locationPageBuilder has no workspace scoping (rejected — by design).** Every
  `/pages/:id` route reads through `locationPageBuilder/store.js`, which takes no user or
  workspace and filters on neither, so any signed-in user can read any page. Checked the
  schema before calling it a hole: **no LPB table carries a `workspace_id` column** in any
  migration (0006, 0007, 0009, 0026). LPB is a shared org-wide tool, not a multi-tenant
  one, and every session is gated on the same Google allowlist. Adding tenancy here would
  be a feature, not a defect fix. Not changed.
- **L2 · competitorAnalysis.js:170 unguarded `res.write` in a heartbeat (UNCONFIRMED).**
  Its two sibling SSE handlers wrap `res.write` in try/catch; this one does not. `cleanup()`
  clears the interval on both the terminal-event path and `req.on('close')`, so reaching a
  write on a destroyed socket needs a same-tick race I could not demonstrate. Recorded, not
  fixed — no written failure scenario, no change.
- **L2 · runs.js pagination (rejected).** `limit` is clamped through `clampLimit` to
  1..200 and `offset` by `Math.max(parseInt(...) || 0, 0)`. Negative and non-numeric input
  both land on safe defaults.
- **L1 · async-route-guard v1, 27 candidates (all rejected).** First draft flagged every
  `await` outside a try/catch in an Express handler. 24 of the 27 were handlers passed
  through a local `wrap()` / `wrapStep()` helper that already does `.catch(...)`
  (`routes/lsPages.js`, `routes/locationPageBuilder.js`); 2 were *nested* async callbacks
  whose awaits belong to the callback, not the handler (`routes/imageAltAudit.js`); 1 was
  `await browser.close().catch(() => {})`, which cannot reject
  (`routes/agentReadinessAudit.js:909`). Detector rewritten to tell direct handlers from
  wrapped and nested ones; `server/routes` + `server/middleware` are clean.
- **L1 · route-params, 0 candidates.** Self-tested and confirmed to fire; found nothing
  in `server/routes`, `server/middleware`, `server/modules` or `server/locationPageBuilder`.
- **L1 · unreturned `res.status(...).json(...)`.** Reviewed every hit in `server/routes`.
  All are either the final statement of a handler or the final statement of a `catch`.
  No double-response defect.
- **L1 · `recordActivity` not awaited (routes/auth.js:289).** Rejected: the function
  catches internally and always resolves, so there is no unhandled rejection.
- **Detector v1, 36 candidates (all rejected).** First draft of
  `require-graph.js` reported 1 unresolved require and 35 missing exports. The
  unresolved one existed only inside a `//` comment; the 35 came from an
  overlapping-regex bug that captured every other name in a `module.exports`
  list. Detector corrected and self-tested; real count is zero.

## Notes between sessions

Worth recording when a verdict was a judgement call — future sessions will not
remember which ones were close.
