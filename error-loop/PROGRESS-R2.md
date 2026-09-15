# Error loop progress — Round 2 (loops 29-56)

Lenses: **Resource and lifecycle** and **Data correctness**. See `error-loop/PLAN-R2-R3.md` for why these and not a
repeat of Round 1. Round 1's ledger is `error-loop/PROGRESS.md`.

**Gate (unchanged):** `node --check` · `require-graph` · `npm test --prefix server` ·
`npm run build --prefix client` · every detector relevant to the area.

**Verification rule (unchanged):** no finding is a defect until it has a written failure
scenario. Round 1 rejected ~137 of ~150 mechanical candidates.

## Entry state for this round

| Detector | Result |
|---|---|
| require-graph | 0 unresolved / 0 missing exports |
| async-route-guard (whole server) | 0 unguarded (1 known false positive) |
| route-params | 0 |
| floating-promise | 0 real |
| env-refs | 0 undocumented |
| sql-refs | 0 real |
| api-contract | 0 mismatches (274 routes / 202 calls) |
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | ok |

## Loop ledger

Grade counts are **confirmed** findings only.

| # | Area | Pass | P1 | P2 | P3 | Fixed | Deferred | Gate | Status |
|---|------|------|----|----|----|-------|----------|------|--------|
| 29 | HTTP boundary & auth | C resource | 0 | 0 | 1 | 1 | 0 | ☑ | complete |
| 30 | HTTP boundary & auth | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 31 | Platform services | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 32 | Platform services | D correctness | 0 | 1 | 0 | 1 | 0 | ☑ | **area complete** |
| 33 | Config & bootstrap | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 34 | Config & bootstrap | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 35 | Database layer | C resource | 0 | 0 | 1 | 1 | 1 | ☑ | complete |
| 36 | Database layer | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** |
| 37 | Projects module | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 38 | Projects module | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 39 | CrawlScope | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 40 | CrawlScope | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 41 | AI Visibility | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 42 | AI Visibility | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 43 | Location Page Builder | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 44 | Location Page Builder | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 45 | Checks & scripts | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 46 | Checks & scripts | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 47 | Content Architect | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 48 | Content Architect | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 49 | Competitor Analysis | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 50 | Competitor Analysis | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 51 | Small modules | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 52 | Small modules | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 53 | Client API & state | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 54 | Client API & state | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |
| 55 | Client pages & components | C resource | 0 | 0 | 0 | 0 | 0 | ☑ | complete — no defects |
| 56 | Client pages & components | D correctness | 0 | 0 | 0 | 0 | 0 | ☑ | **area complete** — no defects |

## Confirmed findings

### L29 · P3 · server/routes/locationPageBuilder.js:207 — SSE heartbeat outlived its viewer
**Defect:** `res.on('close', () => { closed = true; })` set a flag but never cleared the
15s heartbeat interval. Every later tick became a no-op, but the timer itself stayed alive.
**Fails when:** a viewer closes the tab early. The interval keeps running — holding a
reference to the response object — until the awaited work finishes, and the work here is
`runKeywordPipeline` (SERP + SEMrush + LLM), which the code's own comment calls a slow
stage. Abandoning a run five seconds in left a timer ticking for the remaining minutes;
repeated abandonment accumulates them.
**Fix:** `clearInterval(heartbeat)` in the close handler, matching what
`routes/imageAltAudit.js` already does. The closure reads a `const` declared below it, which
is safe only because 'close' is emitted asynchronously — stated in the comment, since the
first version of that comment gave the wrong reason (it claimed `clearInterval(undefined)`,
but a TDZ read would throw).

### L32 · P2 · server/services/runStore.js:265 — period stats aggregated over a truncated window
**Defect:** `runStats` selected raw rows with `order by created_at desc limit 5000` and
tallied them in JavaScript. The limit did not make the answer slow, it made it **quietly
wrong**: for a workspace with more than 5000 runs inside the window, `totals` were the
totals of the most recent 5000 only, the per-tool breakdown was skewed toward whichever
tools ran most recently, and `avgDurationMs` averaged that same truncated set. All of it
was presented as figures for the full period with nothing marking them as capped.

**Fails when:** a workspace exceeds 5000 runs in the requested window (default 30 days).
With 20 tracked tools plus module runs and crawls, that is ~167 runs a day — reachable for
a busy agency workspace. `GET /api/runs/stats?days=30` then reports `total: 5000` against a
real 6,200, understating usage by 19% with no indication on the dashboard.

**Fix:** Moved the aggregation into SQL — `count(*) filter (where status = …)` grouped by
`tool_id`, plus `avg(duration_ms) filter (where duration_ms is not null)` and
`max(created_at)`. The cap is gone because the result is one row per tool rather than one
per run, and it is cheaper too (~20 rows over the wire instead of 5000). `avg()` comes back
from pg as a numeric string, so it is coerced before rounding, with `null` preserved rather
than collapsing to `Math.round(null) === 0` — which would have reported a real average of
zero for a tool that has never recorded a duration. Output shape unchanged. Verified every
column against the migrations (`tool_id`, `status`, `duration_ms`, `created_at`,
`workspace_id`); no test covers `runStats`, so nothing constrained the change.

### L35 · P3 · server/services/db.js:83 — a comment asserting a bound that does not exist
**Defect:** The pool config explained the absence of a `statement_timeout` with "the slow
paths that need a bound set their own". Nothing in `server/` sets `statement_timeout`,
`query_timeout` or `lock_timeout` on any query. The only occurrence in the repo is
`scripts/copyFromSupabase.js`, which sets it to **0 (unlimited)** on purpose for a bulk
copy. The two `AbortSignal.timeout` uses bound outbound HTTP, not database queries.
**Fails when:** someone reads db.js and believes query execution is bounded somewhere. It
is not, and `connectionTimeoutMillis` bounds only ACQUIRING a connection, not running a
statement on one — so a blocked query (lock wait, a plan that loses an index) holds its
pooled connection indefinitely and `max` of them stop the process serving.
**Fix:** Comment corrected to state the real position and name the consequence, so it is a
known risk rather than false reassurance. The timeout itself is **deferred** — choosing a
value needs the real p99 of the crawl-completion and evidence-rollup writes, which this
sweep cannot measure, and too low a value would kill exactly the legitimate work the
original comment was protecting.

## Deferred

## Deferred

_None yet._

## Unconfirmed / rejected candidates

Recorded so a later pass does not re-litigate them.

- **L39/L40 · CrawlScope — no defects, plus a positive verification worth keeping.**
  `resource-release` clean. The two per-crawl collections that could grow without bound are
  both capped: `externalSeen` stops accepting at `options.maxExternalUrls` (line 1816), and
  `_hostState` therefore holds at most that many hosts plus the internal one — and both are
  instance state the manager drops when the crawl ends.
  **Catalog-to-emitter check (the `catalog_drift` class audit-loop/config.json names):**
  89 of the 96 rules in `issue-catalog.json` are emitted by `analyzer.js`, and all 7 that
  are not are classified in `rule-classes.json` as structurally impossible from a single
  crawl — `model` (ai-content-signal), `external_gsc` (google-title-differs), `action`
  (indexnow-submit), `delta` (metadata-changed) and `external_analytics` (traffic-drop,
  top10-drop, referring-domains-drop). **Zero rules classed `crawl` are unemitted**, so
  there are no dead detectors advertising checks that can never fire.
  My first run of this check reported 8 missing including `noindex`, which is classed
  `crawl` and `rarity: common` — it looked like exactly such a dead detector. It was my
  regex: it required a hyphen in the id, so single-word ids could not match. `noindex` is
  emitted at `analyzer.js:1172`.
  Recommendation ranges were also checked for off-by-one and are internally consistent
  (titles 30-60, meta descriptions 150-160, with no gap between the branches).
- **L37/L38 · Projects — no defects, and the correctness reasoning is already explicit.**
  `resource-release` clean. `overview.js:345`'s `Promise.all(offsets.map(readPage))` is
  bounded by `CAP / PAGE`, a fixed fan-out, not by row count. The arithmetic Pass D exists
  to check is already guarded, in several cases better than the check would have asked for:
  the crawl-progress percent is clamped to [0,100] with a zero-denominator guard (line 512);
  line 912 deliberately publishes **no** percentage while the denominator is still moving,
  because "a percentage of an unknown total is a made-up number"; and `siteHealth()`
  returns `null` rather than 0 for an absent crawl (a zero score would describe a
  catastrophic site, not a missing measurement), withholds a score rather than reporting
  100% when a pre-0023 run has counts but no per-instance urls, dedups affected pages by
  url so forty warnings on one page cost one page's worth, and floors the result at 0.
  Note for a later reader: severity buckets overlap by design, so error+warning+notice can
  exceed the denominator and drive the raw score negative — `Math.max(0, …)` is load-bearing
  there, not decorative.
- **L36 · 0027 host backfill keeps embedded credentials (rejected — low risk, and the fix
  is worse).** The migration extracts a host from `crawl_projects.url` by stripping the
  scheme and everything from the first `/?#`, which leaves a `user:pass@` prefix intact,
  and the guard `p.host not like '%/%'` does not exclude `@`. Not acted on: the app's own
  `normalizeOrigin()` builds every origin from `url.hostname`, which excludes credentials,
  port and path, so only a pre-normalisation legacy row could carry them — and editing an
  already-applied migration is the exact hazard `--accept-edit` exists to warn about.
  Recorded as accepted risk.

- **L30 · `scoreUrl` position score can go negative (UNCONFIRMED — not fixed).**
  `routes/keywordResearch.js:71` computes `posScore = 1 - (bestPosition - 1) / 10`, which is
  negative for any position past 11 (−0.9 at position 20). Weights sum to exactly 1.00 and
  every other component is bounded [0,1], so this is the only term that can leave the range,
  and `rubricScore` **is shown to the user** (`KeywordResearchPage.jsx:568`).
  Not fixed, because I could not demonstrate the input: both SERP providers request
  `num: 10`, the Google CSE path assigns `position: index + 1` (hard-bounded ≤10), and only
  the Serper path passes the provider's own `position` through. Whether Serper can return
  more organic results than requested is an external-API question this repo cannot answer.
  It is also not an ordering bug — the score stays monotonic in position, so ranking and the
  top-10 slice remain correct, and nothing thresholds it. Left alone deliberately; if Serper
  is ever observed returning >10 organic results, clamp `posScore` to [0,1].
- **L30 · agent-readiness two score denominators (rejected).** `quickWinProjection` divides
  by `100 + onPageMax` while the real score divides by `httpMax + onPageMax`, which looked
  like drift. `httpMax` is assigned the literal `100` at both sites (lines 648 and 803), and
  the projection's own comment already records that the two expressions are therefore
  identical. `Math.min(100, projected)` also caps the result. Correct as written.
- **L29 · 7 outbound axios calls in routes flagged as timeout-less (rejected).** The grep
  matched the call line; every one carries `timeout:` and `maxRedirects:` in its multi-line
  options object (8s-30s). Verified individually.
- **L33 · `server.js:313` purge-sweeper interval (rejected).** Same shape as the
  moduleWorker timers: `.unref()`'d immediately after creation, along with its companion
  `setTimeout`, so neither holds the process open. A process-lifetime sweeper is meant to
  run for the life of the process; there is nothing to release.
- **L34 · registry guard verified by mutation, not by assumption.** `config/runTracking.js`
  is only as good as the test that pins it, so I changed one matcher path from `/run` to
  `/run-TYPO` and re-ran `registry.test.js`: it failed 2 of 7 with the precise message
  `robots-monitor POST /run matches no matcher`. The guard is real, not vacuous. File
  restored and verified (7/7, suite 191/191) — this matters because `trackRuns` returns a
  silent no-op for an unmatched config, so a typo here would otherwise track nothing.
- **L31 · resource-release, 4 candidates (all rejected — detector limitation).**
  `dbCapacity.js:159` and `moduleWorker.js:93/106/119` were reported as "released, but not
  in a finally". For a process-lifetime timer that is the wrong shape to look for: all four
  are `.unref()`'d so they never hold the process open, and all four are cleared in an
  explicit `stop()` (`moduleWorker` returns one; `dbCapacity` exports one). `dbCapacity.init()`
  additionally clears any existing timer first, so re-initialising cannot orphan one. The
  detector cannot see a release that lives in a sibling method; noted so a later round does
  not re-raise these.
- **L31 · unbounded fan-out (rejected in this area).** `Promise.all(xs.map(...))` sites in
  services are bounded by construction: `featureFlags` maps a fixed `Object.values(FLAGS)`
  list, and `kbLoader` maps manifest-declared ids over local file reads — no metered API and
  no caller-controlled length. Sites in `modules/` with genuinely variable input
  (`contentArchitect/routes.js:69`, `projects/overview.js:345`) belong to their own loops.
- **L29 · resource-release over routes+middleware: 0.** Detector self-tested first — it
  catches both a release outside `finally` and a missing release, and passes `db.tx()`'s
  correct shape.


## Round 2 close — loops 29-56

**2 defects fixed** (1 P2, 2 P3 — one of the P3s is the comment correction), **1 deferred**.

| Gate | Result |
|---|---|
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | ok |
| require-graph / route-params / env-refs / api-contract | 0 |
| async-route-guard | 0 (1 known false positive) |
| resource-release (whole server) | 0 real |

### What Pass C found
- **`routes/locationPageBuilder.js`**: an SSE heartbeat that outlived its viewer, ticking
  for the remaining minutes of a keyword pipeline after the tab closed. Fixed.
- Everything else was already correct, and several things were correct in ways the detector
  could not see — which is why the rejection list matters as much as the fix list.
  `moduleWorker`, `dbCapacity` and the purge sweeper all `.unref()` their timers and clear
  them in an explicit `stop()`; `getBrowser()` is a deliberate long-lived singleton with
  per-capture contexts closed individually; `externalSeen` and `_hostState` are capped by
  `maxExternalUrls`; `overview.js`'s parallel page reads fan out by `CAP / PAGE`, not by row
  count.

### What Pass D found
- **`services/runStore.js`**: period statistics aggregated over a truncated 5000-row window
  and presented as totals for the period. Fixed by grouping in SQL — correct *and* cheaper.
- **`services/db.js`**: a comment asserting a query-timeout mitigation that does not exist
  anywhere in the codebase. Corrected; the timeout itself deferred as unmeasurable here.

### What Pass D mostly found instead
The numeric semantics in this repo are unusually disciplined, and it is worth recording
where, so a later round does not re-derive it:
- `ratio()` returns **null** for a zero denominator, never 0 — "0 of 0 is not a zero percent".
- `siteHealth()` returns null rather than 0 for an absent crawl, and withholds a score
  rather than publishing a false 100%.
- The crawl-progress card publishes **no** percentage while its denominator is still moving.
- Market Potential indexes off **raw** per-capita, not the display-rounded value, so a single
  home market reads exactly 100 instead of 99 or 101.
- Share-of-voice excludes an `other` bucket from its denominator so the figure cannot drift
  when a model name-drops an unmeasured brand; position imputes nothing for absence.
- Billing arithmetic verified end to end: 10 + 45 + 1000 + 500 + 400 = **1955 units/domain**,
  `floor(10000 / 1955)` = **5** = client + `MAX_COMPETITORS` (4). Consistent with its cap.
- `seoGeoChecks` bucket scoring divides by `den` with no explicit zero guard, and does not
  need one: `checkTier` can only return 1, 2 or 3 (a `0` override is falsy and falls
  through), and the `relevant.length === 0` early-continue guarantees at least one term.

### Coverage limits carried into Round 3
Pass D probed the highest-value arithmetic rather than reading every line of
`analyzer.js` (2033), `crawler.js` (3502), `seoGeoChecks.js` (2712) or the client's ~51k
lines. The catalog-to-emitter check now covers the analyzer structurally (89/96 emitted,
7 non-crawl by class, 0 dead crawl detectors), which is stronger evidence than a read.
