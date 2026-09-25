# Handoff — crawler work, uncommitted

> **Read this first: parts of the document below are now out of date.** It is a
> point-in-time handoff and is kept as a record of what was found and why, not as
> current documentation. Known corrections:
>
> * **§1 "there is no runner in this repo" is no longer true.** Migrations are
>   applied by `server/scripts/migrate.js`, which records what it applied and
>   checksums each file. `--status` answers "has this database seen 0023?".
>   `--baseline-through` brings a hand-migrated database under it.
> * **The branch is `unified-fast`, not `unified-app`,** and the work described
>   here is committed. `HEAD` is well past `e4b3a72`.
> * **§7 "nothing built today has been rendered in a browser"** still applies to
>   the five report pages it names. The dashboard's Executive Summary block,
>   added later, was rendered and screenshotted across five states and two
>   themes before it was committed.
> * **§2, the 500-URL bug, is still open** as far as this document knows, and
>   §2's own warning stands: everything in it is a hypothesis, not a finding.
>
> Everything else below is unverified against the current tree.


Written at the end of a long session. Everything below is **uncommitted**; the
user asked twice that nothing be committed. `HEAD` is still `e4b3a72` and the
branch is `unified-app`.

---

## 0. READ THIS FIRST — two things that will bite you

### The disk is full

A `sed` invocation failed with **`No space left on device`** while writing to
`/tmp` on the `D:` drive. That is why the repo is being moved. It is also a
plausible contributor to problems blamed on the code today — in particular a
worker that stopped heart-beating mid-crawl at ~1,986 pages. **Do not conclude
anything about crawl reliability until the move is done and there is free
space.** I was interrupted before measuring actual free space, so the extent is
unknown; only the symptom is confirmed.

### The backup lives OUTSIDE the repo

```
../_premerge_backup/          ← sibling of the repo directory, NOT inside it
    tracked-changes.patch     10,055 lines — every tracked modification
    untracked.tgz             26 untracked files
    status.txt                the porcelain status at backup time
```

Taken before pulling upstream files. **If you move only the repo directory you
will lose it.** Move or copy that folder too.

74 paths are currently dirty. Nothing is committed. If you want a safety net on
the new drive, `git stash` or a branch commit is the obvious first move — the
"don't commit" instruction was about not committing to the live branch, so
confirm with the user before assuming it still applies.

---

## 1. Migrations — what is applied and what is not

Applied by hand; there is no runner in this repo. The app's own error text is
the precedent: *"Apply `supabase/migrations/0018_...sql`, then reload."*

| File | Applied? | What it does |
|---|---|---|
| `0023_crawl_run_finding_instances.sql` | **NO — apply this first** | Upstream's. Moves per-occurrence findings out of `crawl_runs.summary` into their own chunk-inserted table. **Nothing populates without it.** |
| `0024_audit_events_outlive_their_subjects.sql` | **YES** | Mine. Drops the `ON DELETE SET NULL` FKs on `audit_events` and `admin_limit_policies`. |
| `0025_crawl_run_control_channel.sql` | **NO** | Mine. Adds `control_request` / `control_requested_at` to `crawl_runs`. Stop cannot reach a worker-run crawl without it. |

### The numbering wrinkle

`0024` was **written and applied as `0023`**, then renumbered when upstream
turned out to have its own `0023`. The two are independent — one drops foreign
keys, the other adds a table — so the order they ran in does not matter, and a
database that already ran it under the old name needs nothing further. All the
`drop constraint` statements are `if exists`, so a re-run is a no-op. The file's
header explains this.

### The non-obvious dependency

**Upstream's permanent-project-deletion needs `0024` to work at all.** Its own
comment says *"audit_events.project_id is `set null` and stays behind on
purpose"* — but that SET NULL is an UPDATE, and `audit_events` carries an
append-only trigger that rejects UPDATEs. Upstream ships no migration dropping
that FK. Their purge would fail exactly as mine did with:

```
audit_events is append-only: UPDATE rejected. Write a new row instead.
```

`server/services/__tests__/appendOnlySchema.test.js` (mine, in the test runner)
guards this statically: no append-only table may carry a live `ON DELETE SET
NULL` FK. **Do not "simplify" that test away** — it is the only thing tying the
two facts together.

---

## 2. THE OPEN BUG — 500 URLs in, 150 internal crawled

**Unresolved. This is where to start.**

Reported: filling in **500 URLs** produces a crawl of **300 URLs total, 150 of
them external** — i.e. **150 internal pages**, not 500.

`150` is exactly the default `maxExternalUrls`. That coincidence is the lead and
it points at one of two things:

1. **Internal and external budgets are being confused somewhere.**
   `crawler.js _progress()` reports
   `maxUrls: this.options.maxUrls + this.options.maxExternalUrls` — the two are
   already summed for display. If a *stop condition* anywhere mixes them the
   same way, an internal crawl would halt early. Check `crawler.js` around:
   - `if (this.seen.size >= this.options.maxUrls)` (~line 1725)
   - `this.externalSeen.size >= this.options.maxExternalUrls` (~line 1792)
   - `sitemapBudgetRatio` (~1564): `floor(maxUrls * 0.8)` — 400 of 500, not 150,
     so probably not this, but confirm.

2. **List mode ("fill in 500 URLs") may not mean `maxUrls = 500` in practice.**
   `shared/options.js` pins `maxUrls: listUrls ? listUrls.length : …` and
   `options.urls = listUrls`. But `crawler._inScope` treats list mode as *"same
   host as the page it was found on"* — so a pasted URL on another host can be
   classified **external** and charged against the 150 external budget instead
   of the 500 page budget. If the 500 pasted URLs span hosts, this is the most
   likely explanation and it is arguably working as designed but not as
   expected. **Establish first whether the user pasted a list or set a spider
   budget of 500** — the two paths are completely different and I never
   confirmed which.

Also worth confirming: the crawler's own hard floor is
`Math.min(options.maxUrls || 10_000, 50_000)` (`crawler.js` ~1264), and
`parseCrawlRequest` clamps to the workspace's effective
`admin_limit_policies.maxUrlsPerCrawl` (default 500; `MAX_URLS_CEILING` is now
only the fallback when that table is unreachable). None of those produce 150.

*(Updated: at the time this was written `parseCrawlRequest` clamped to
`MAX_URLS_CEILING` instead, and a bug meant the admin policy did not bind a
spider crawl at all — so a project could indeed be stuck at a number nobody
could find in Admin. See `supabase/migrations/0037_crawl_runs_budget.sql`; a run
now records the budget it used and where the number came from.)*

**I got one command into this investigation before the disk error stopped me.
Treat everything above as hypotheses, not findings.**

---

## 3. What was done today

### 3a. Five report pages redesigned from the Claude Design handoff

Source: `D:\Gentle Dental homepage simplification-handoff\` (7 `.dc.html`
prototypes). Built: **Home, Tech Audit, SEO & GEO, AI Visibility, Competitor
Analysis**. A peer session built **Hub and Spoke** and is mid-flight on **Agent
Readiness** (see §5).

New component trees:

```
client/src/components/crawlScope/report/    Tech Audit report
client/src/components/seoGeo/report/        SEO & GEO report
client/src/components/home/ProfileStats.jsx, moduleIcons.jsx
```

Deleted as orphaned by the redesign: 14 crawlScope components (ExecutiveSummary,
SeoSnapshotGrid, MediaLibrary, IntegrationsSection, IssuesFoundSection,
SiteFindingsSection, SiteHealthCard, BacklogSection, UrlDrawer, ExpandableText,
crawlScope/ResultsTable, three charts), `home/InsightsPanel.jsx`,
`home/Takeaway.jsx`, `aiVisibility/ReportRail.jsx`,
`aiVisibility/ReportHeader.jsx`, and `pages/CrawlScopeReviewPage.jsx` (its
triage folded into the issue detail view; `/review` redirects).

Layout CSS lives in labelled blocks in `client/src/index.css`, all **before**
`/* ── Scrollbar ── */` — utilities and legacy overrides must stay last.

One design deviation worth knowing: the **SEO & GEO** prototype's type scale was
inflated ~1.55× on small text and compressed on large (eyebrows bigger than body
copy). Normalised to the app scale with the user's agreement. The other
prototypes were at normal scale.

### 3b. Pulled the crawler and error analysis from upstream

`origin` **is** `github.com/ai-positon2/seo-apps` and we were already on
`unified-app` — 8 commits behind our own remote. Nothing was ported from
elsewhere.

Done as a **selective file take, not a `git pull`**, because a merge conflicts
on `ContentArchitectProjectPage.jsx` (the peer's live file) and the instruction
was crawler-only. Taken:

```
server/modules/crawlScope/{db/repo.js, api/routes.js, run/manager.js}
server/modules/projects/{overview.js, insights/findingIndex.js, insights/correlations.js}
server/services/adminLimits.js
supabase/migrations/0023_crawl_run_finding_instances.sql
+ upstream's permanent-project-deletion wholesale (store.js, routes.js,
  projectAccess.js, auditEvents.js, projectsApi.js, ProjectsPage.jsx,
  __tests__/projectPurge.test.js) — mine deleted, on the user's instruction
```

**We remain 8 commits behind on everything else** — Content Architect, Article
Recommendation, Keyword Research, googleSearch. That is deliberate, not
forgotten.

Two reconciliations were needed on the files taken:
- Upstream's `ProjectsPage.jsx` imports `../components/home/primitives`, which
  the peer moved to `../components/studio/primitives`. Repointed.
- Re-applied `key={selected.id}` on `ProjectDetail` (upstream lacks it; without
  it the delete-confirmation stays open with the previous project's name typed
  in, in front of a different project).

`866610f` is the commit that matters: *"Fix crawl-completion statement timeout:
move findings out of crawl_runs.summary"*. A ~2,600-page crawl produces
18,000–20,000 findings and the single UPDATE embedding them was failing with
`canceling statement due to statement timeout`, confirmed against three real
failed runs. **That was the cause of "errors are not populating."**

Consequently my own rollup endpoint was deleted and the report rewired onto
upstream's `/runs/:id/findings`. It had existed to work around a payload that
could not cross the wire, when the real fault was upstream of it.

### 3c. Stop mid-crawl (`0025`)

`pause`/`resume`/`stop` only ever reached a run held by the *receiving* process.
Every project and scheduled crawl executes in the **worker**, so Stop on "Run
Full Audit" always returned `409 "This run is not being executed by this
instance"` while the crawl carried on.

Now: the route records the request on the run; the worker collects it on a
**dedicated 3s poll** (`RUN_CONTROL_POLL_MS`), applies it through the same
`crawler.pause/resume/stop()` the in-process buttons use, and clears it with a
**compare-and-clear** so a newer request is not swallowed. The poll is one narrow
indexed row read, stops itself once the crawler is stopped, and warns **once** if
the column is missing (an unapplied `0025` would otherwise fail silently every
3s).

Two facts that made this cheap: `crawler.stop()` aborts the root controller
immediately, and **a stopped crawl still stores its findings** — it runs the
normal completion path. A stopped crawl is a partial audit, not a lost one.

### 3d. Crawl budget, visible and editable

`updateProject` accepts `crawlOptions.maxUrls` / `maxDepth`, clamped to the
workspace's `maxUrlsPerCrawl`, with a policy clamp audited as its own field
(`crawlBudgetClampedByPolicy`). Previously the budget was settable **only at
creation** — `createProject` clamps downward and fills in the ceiling when
absent, but never raises one already stored, so a client created at 150 crawled
150 pages a week forever.

URL count now shows next to both crawl buttons:
- `/crawl-scope` → beside **Start crawl** (`up to N pages · M external links
  checked`; in list mode, `N URLs in the list`)
- Homepage → beside **Run Full Audit**, click-to-edit (`CrawlBudget` in
  `HomePage.jsx`, keyed on project id)

---

## 4. Bugs found and fixed in a 5-pass audit (for context on what to trust)

Four of five passes found **documentation that had drifted from the code** rather
than logic errors — a consequence of rewriting the same files repeatedly. The
one real logic bug was in code I had described as fixed an hour earlier:

**`stalled` could never fire.** It was a `useMemo` keyed on
`progress.heartbeatAt`; when a crawl dies the SSE keeps sending progress with
that value *frozen*, so the dependency never changed and the memo never
recomputed. Now a 15s clock drives it (`STALE_AFTER_MS`, `STALE_CHECK_MS` at
module scope in `CrawlScopeRunPage.jsx`). **Time must drive that check, not
data.**

Also fixed: `send("state")` fires only once at connection, so a pending
stop/pause notice never cleared — status and `heartbeatAt` now ride along with
every `progress` tick (`api/sse.js`), and clearing is driven off `status` in an
effect covering all three arrival paths.

---

## 5. The other session

A peer Claude session worked in **this same checkout** concurrently. It owns:

```
client/src/components/contentArchitect/HubSpokeReport.jsx
client/src/pages/ContentArchitectProjectPage.jsx
client/src/pages/AgentReadinessAuditPage.jsx      (mid-flight)
server/routes/agentReadinessAudit.js              (mid-flight)
client/src/index.css → the ".ara-*" block only
```

It also moved `components/home/primitives.jsx` → `components/studio/primitives.jsx`
and updated every importer. Its Agent Readiness work was **not finished**, and
its uncommitted changes are in the same dirty tree. Coordinate before assuming
any of those files are safe to touch.

Two sessions writing one checkout with no merge step is how the `index.css`
near-collision happened. If parallel work continues, separate clones.

---

## 6. Known-dead code, left alone deliberately

`client/src/components/project/ModuleDetailPanel.jsx` and
`client/src/components/project/moduleDetailSections.jsx` are unreferenced —
and were unreferenced at `HEAD` before this session, so not fallout from any of
today's work. Raised with the user twice; no decision given. ~430 lines.

---

## 7. What has never been verified

**Nothing built today has been rendered in a browser.** Not one of the five
report pages, not the stop button, not the budget editor. Everything is verified
only as "the client builds and the server tests pass" — which catches import and
syntax errors and nothing else. No layout, no theme, no empty state has been
looked at.

The blocker is real: the app is Supabase-gated behind `authState`, the report
views need real audit data, and `/api/auth/dev-login` is disabled (it self-gates
on `NODE_ENV=development` **and** no `GOOGLE_OAUTH_CLIENT_ID`). `puppeteer-core`
is installed and could drive it, but that needs credentials.

**Current verification state:** `client && npm run build` clean;
`server && npm test` → 178 assertions passing, plus upstream's 16 purge tests
and my 4 schema-guard tests.

---

## 8. Suggested order on the new drive

1. Move `../_premerge_backup/` too.
2. Confirm free disk space.
3. `npm ci` in both `client/` and `server/` if `node_modules` did not survive.
4. `client && npm run build` and `server && npm test` — establish the baseline
   still holds after the move.
5. Apply `0023`, then `0025`. Restart **both** the web process and the worker
   (`server/package.json` → `"worker": "node modules/crawlScope/worker/index.js"`
   — plain node, no nodemon, so it does **not** auto-restart on file changes).
6. Run one crawl of a modest site to completion and check the **completeness
   line** on the report Overview: it compares `run.summary.counts` against what
   the page received and states plainly whether the audit is fully displayed.
   That single line is the fastest way to know the findings pipeline is healthy.
7. Then §2 — the 500-URL bug.
8. Then a browser pass over the five pages.

One caution for step 6: **do not edit files under `server/modules/` while a
crawl is running.** The web process runs under nodemon watching `modules/`, and
restarts mid-crawl cost real runs today.
