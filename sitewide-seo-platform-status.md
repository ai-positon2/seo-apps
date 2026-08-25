# Sitewide SEO/GEO platform — implementation status

Where the repo stands against `sitewide-seo-platform-prd.md`, as of 23 Aug 2026.

This pass delivered two things: the attached homepage design applied as the app's
theme and dashboard, and the PRD's Phase 0/1 foundation that makes that dashboard
real rather than a mockup. Later phases are **not** half-built — they are listed
below with the specific work each one needs.

Read this file before extending any of it. The gaps at the bottom are the ones
that will look like bugs otherwise.

---

## 1. What ships now

### Data foundation

`supabase/migrations/0011_platform_foundation.sql` (489 lines, 7 sections).
Strictly additive and re-runnable: it creates tables, adds columns, and
backfills. It drops nothing and rewrites no existing row's meaning. There is no
RLS — consistent with the rest of this app, **every query carries its own
workspace filter**, and the service-role key never reaches the browser.

| Object | Purpose |
| --- | --- |
| `platform_admin_grants` | Persisted platform-admin grants, seeded with `nikhil.ashok@position2.com` (§7.3) |
| `workspace_member_events` | Membership history, append-only in practice |
| `audit_events` | The immutable trail; an `after`-trigger rejects UPDATE and DELETE |
| `admin_limit_policies` | Versioned limits per scope; append-only, seeded with platform v1 |
| `feature_flag_assignments` | Rollout flags; `unified_project_workspace` seeded globally **off** |
| `project_domains` | Primary + competitor domains, with a partial unique index for one active primary per project |
| `crawl_projects` (+ columns) | `country_code`, `lifecycle_status`, `site_verified_at/by`, `robots_override`, `settings`, `deleted_at/by`, and a `workspace_id` backfill from each creator's personal workspace |

The migration ends with verification queries and rollback notes.

**Applied and verified** (21 Aug 2026): all six tables reachable, the nine
additive `crawl_projects` columns selectable, the initial admin grant active, the
platform limit policy at v1 with all 17 keys (`maxUrlsPerCrawl = 5000`), and
`unified_project_workspace` seeded global-off and resolving to `false`. The
append-only trigger on `admin_limit_policies` rejected a same-value UPDATE with
its own message.

Two things the verification could *not* prove, because there was nothing to prove
them against: `crawl_projects` was empty, so the `workspace_id` and
primary-domain backfills had no input, and `audit_events` was empty, so its
trigger was never fired. The regex-based primary-domain backfill is therefore
still unexercised — it matters only if this schema is ever applied to a database
that already has legacy projects.

### Migrations still to apply

| File | What it adds | Needed by |
| --- | --- | --- |
| `0012_project_module_evidence.sql` | `project_module_runs`, `crawl_run_links` | phases 3 and 4 |
| `0013_recommendations.sql` | `recommendations` | phase 6 |
| `0014_module_page_runs.sql` | `project_module_page_runs` | per-page audits |

Both are additive and re-runnable, and both were written the same way as 0011:
no RLS, every read filtered by workspace in the query itself.

`0014` is the child table behind per-page reports: one row per audited page,
holding that page's own report. Until it is applied, SEO & GEO, On-Page and Agent
Readiness fall back to the site-level report already stored for each project, and
the server logs the missing migration **once** rather than on every request. That
fallback is deliberate: throwing there would have taken the whole module-detail
endpoint down, so every module page would show an error instead of the report it
already has.

**Until they are applied**, the module cards and the recommendation panel report
their tables as missing rather than crashing — but nothing in phases 3, 4, 6 or 7
can store or read anything. `0012` in particular gates the new crawl link graph,
so a crawl run before it is applied stores no edges and Content Architect will keep
saying so.

One deliberate decision inside 0012 worth knowing: it adds **no CHECK constraint
on `audit_events.action`**, even though it adds three new actions. Audit writes
are fire-and-forget by design, so a DB-side vocabulary drifting out of step with
the code would stop the trail recording while every action kept succeeding — a
silent audit gap, which is worse than an unconstrained column. The integrity that
matters there is the append-only trigger 0011 installed.

### Services

| File | What it owns |
| --- | --- |
| `server/services/projectAccess.js` | The single authorization helper. §7.2's permission matrix transcribed as data, `member` → `contributor` normalization, `requireWorkspace` / `requireProject`. Cross-workspace reads answer **404, not 403**, so an id can't be confirmed by probing (AC-001). |
| `server/services/platformAdmin.js` | Grant bootstrap, trim+lowercase exact-email matching, `requirePlatformAdmin`, and a `revokeAdmin` that refuses to remove the last active grant — that is lockout, not a permission change. |
| `server/services/adminLimits.js` | 17 limit keys, each with a declared direction (`min` / `max` / `specific`). `combine()` is a pure function so precedence is unit-tested without a database. A narrower scope can never *raise* a ceiling. |

**Live crawl cap: 50 URLs** (set 21 Aug 2026, temporary). It lives in two places
because two things enforce it, and setting only one leaves a hole:

* `admin_limit_policies` **v2** — `maxUrlsPerCrawl: 50`, carried forward from v1
  with the other 16 keys untouched. This is what new projects are created with
  and what the setup card states. Raise it by publishing v3 from the admin page;
  v1 and v2 stay readable, so the cap that applied on any past date is still
  answerable.
* `MAX_URLS_CEILING=50` in `.env` — `crawlScope/shared/options.js` clamps every
  crawl request against this at the API boundary, *including* ad-hoc crawls from
  the CrawlScope tool, which never touch a project or the admin limits. Without
  it the policy would cap projects while ad-hoc crawls still ran to 5,000.

`.env` is gitignored, so this is local only: set `MAX_URLS_CEILING` in the Railway
dashboard too if the cap is wanted there. The DB policy is shared and already
applies to every environment pointing at this Supabase project.
| `server/services/featureFlags.js` | Most-specific-wins resolution (user > project > workspace > global), default off, 30s cache. |
| `server/services/auditEvents.js` | Closed action vocabulary, state trimmed to 8,000 chars. Fire-and-forget by default so an audit write cannot fail a user's action; `strict: true` where the audit *is* the point (robots override). |

### Projects module

`server/modules/projects/` — `domains.js` (pure normalization), `store.js`,
`overview.js`, `routes.js`. The full §18.2 surface, including
`GET /:projectId/overview`, `POST /:projectId/verify-site`,
`POST /:projectId/robots-override`, and the duplicate-domain 409 that asks for
confirmation instead of refusing.

Two rules worth restating because they are easy to "fix" into something wrong:

* **A country is required and never defaulted.** `normalizeCountry` throws 400
  on a missing or unknown value. It is the market every rank and Search Console
  comparison is measured in; silently choosing `US` would make every later
  number wrong in a way nobody would notice.
* **`normalizeOrigin` does not strip `www` and does not upgrade `http`.** Those
  are different origins to a crawler, and guessing produces a crawl of a site
  the user didn't name.

### Admin API

`server/routes/admin.js`, entirely behind `requirePlatformAdmin`: effective
limits with their source, version history, new versions, flags, grants, and the
audit trail. The check reads the persisted grant — not a JWT claim, not a
header, nothing the browser supplies (AC-002).

### Theme and homepage

The whole app already routed colour through CSS custom properties, so retuning
`client/src/index.css` while keeping every existing token name applied the new
theme app-wide without touching ~120 page files.

* Light `:root` is warm paper (`#F5F3EE`) with a deep green accent (`#2F5D50`);
  dark is near-black (`#14171A`) with `#5FAF97`. Both are designed states.
* `--accent-100..900` and `--neutral-100..900` are **inverted between themes**
  (step 100 is lightest in dark, darkest in light), so an `accent-800` /
  `accent-100` pairing keeps its contrast in both without per-theme overrides at
  every call site.
* Poppins for text, JetBrains Mono kept for tabular figures.
* `ThemeContext` is a working toggle again — it was a no-op while the app was
  dark-only. It reads storage synchronously on first render, so the first commit
  already matches the stored choice.

`client/src/pages/HomePage.jsx` is the dashboard from the attached design: the
active-client card, the audit-profile radar, six module cards, activity and
alerts. No tool catalog — the sidebar already lists every module, and a second
grid of the same links pushed the evidence below the fold. The catalog's copy is
still in `client/src/toolCatalog.js`, currently unreferenced, if a dedicated
launcher page ever wants it.

`MacWindow` gained the design's header: brand, client switcher, Semrush units,
Runs / Projects / Workspaces, a conditional Admin link, the theme toggle, and an
identity chip. Its sidebar is painted from nav tokens instead of white alphas,
which is what let it survive the light theme.

New screens: `ProjectsPage` (§20.9 settings — domains, country, competitors,
schedule, verification, robots policy, lifecycle) and `AdminPage` (§20.10 —
limits, flags, grants).

### Authentication

**Google sign-in is the only way to get a session.** Two shared-token paths were
removed on 21 Aug 2026:

* the `?pt=<PLATFORM_TOKEN>` page-load interceptor in `server/server.js`, which
  minted a seven-day cookie before React rendered;
* `GET /api/auth/platform-login?token=…` in `server/routes/auth.js`, and the
  `client/src/main.jsx` code that called it automatically inside an iframe.

Both produced a `platform_embed` session with no linked user and the privileged
`seo` role, and the credential travelled in a URL — so it accumulated in browser
history, referrer headers, access logs and any shared link.

Already-issued `platform_embed` cookies stay validly signed for up to a week, so
`requireAuth` and `/api/auth/verify` **reject them by identity** rather than
waiting for them to expire. Otherwise "removed" would have meant "removed for
new visitors only".

`JWT_SECRET` no longer falls back to a literal in the source. The server refuses
to boot without it: a published default means any deployment that forgets the
variable accepts sessions forged by anyone who can read this repo.

Verified with no cookie: `/api/projects`, `/api/admin/limits`, `/api/workspaces`,
`/api/runs`, `/api/kb`, `/api/profile`, `/api/semrush/balance`,
`/api/crawl-scope/*`, and POSTs to `/api/search`, `/api/analyze`,
`/api/keyword-research`, `/api/on-page-audit` all answer **401**. Only three
things answer without one, all deliberately: `/` (the SPA shell, which renders
the login card), `/api/health` (liveness probe), and `/api/auth/verify` (it has
to be able to say "no").

#### Who may sign in — open by decision, not by oversight

`ALLOWED_GOOGLE_DOMAIN` and `ALLOWED_GOOGLE_EMAILS` are intentionally unset.
`isAllowedEmail` ends with `return !allowedEmails.length && !allowedDomain`, so an
empty allowlist admits **any verified Google account** — not only
`@position2.com`. This was reviewed on 21 Aug 2026 and kept: people outside
Position2 are meant to be able to sign in with their own Google accounts.

**Do not "fix" this as a bug.** If it ever needs narrowing, it is an env change,
not a code change: set `ALLOWED_GOOGLE_DOMAIN=position2.com`, or list specific
addresses in `ALLOWED_GOOGLE_EMAILS`.

What an unknown signer-in can and cannot do, so the decision is made with its
consequences visible:

* **Cannot** see anyone else's data. `getOrCreateUser` gives them their own
  personal workspace, and every project query is filtered to the workspaces they
  belong to — a project id from another workspace answers 404, not 403.
* **Cannot** reach `/api/admin`. Platform-admin grants match on email, and theirs
  is not granted.
* **Can** consume shared quota: Semrush units, OpenAI / Anthropic / Gemini calls,
  PageSpeed quota, and crawls that run from this deployment's IP against sites
  they choose. That is the real exposure, and it is a cost and reputation
  question rather than a data-access one.

**This breaks the Position2 Intelligence Platform embed** if anything still
relies on the token hand-off. A framed visitor now sees the login card and signs
in with Google like anyone else. `PLATFORM_TOKEN` and `PLATFORM_DEFAULT_ROLE` are
no longer read by any code; the `?embed=1` chrome-less rendering mode is
untouched and still works for signed-in users.

### Module pages show the expanded evidence

Each of the six module pages now leads with that module's project evidence, with
its standalone paste-a-URL tool directly below, unchanged. Before this, a card
reading `88/100 · 49 findings` opened onto an empty input box.

`GET /api/projects/:projectId/modules/:moduleKey/detail`
(`server/modules/projects/moduleDetail.js`) returns one shape for all six:

* `card` — **the same object the dashboard renders**, built by
  `overview.evidenceCard` / `overview.technicalCard`. The panel composes no
  headline of its own, so the two screens cannot drift apart. A test asserts
  `moduleDetail.js` contains no `headline:` of its own.
* `findings` — all of them. The card shows four.
* `payload` — the module's stored detail, rendered per module by
  `client/src/components/project/moduleDetailSections.jsx`.
* `history`, and `cost` for the one metered module.

CrawlScope is the asymmetric case: its evidence lives in `crawl_runs` +
`crawl_run_findings`, so those rows are reshaped into the same finding shape the
other five use and one table renders either source.

One shared fix went with it: `client/src/ui/ScoreRing.jsx` defaulted
`score = 0`, so a module with no rubric would have drawn a confident zero. A
non-finite score now draws the empty track with an em dash. Every existing caller
passes a number, so nothing else changes.

**A module page shows that module's own report and nothing above it.** An earlier
pass put a summary panel at the top of each page — score, severity counts,
findings table, run history. On a page that already renders the real report that
duplicated it in a second visual language, and on Competitor Research it repeated
the dashboard's own units, domains and keyword gap directly above them. Both
files are still in the tree (`ModuleDetailPanel.jsx`, `moduleDetailSections.jsx`),
flagged unreferenced, and can be deleted.

What replaced it:

* The dashboard card links **straight to the module's real report**, resolved in
  one place — `client/src/lib/moduleReportRoute.js`, used by the card so no
  second copy of a route can drift. Site Crawler goes to `/crawl-scope/runs/:id`,
  Content Architect to `/content-architect/:projectId`, Competitor Research to
  `/competitor-analysis?client=:clientId` (that page now reads the id from the
  URL and validates it, so a stale link falls back instead of showing an empty
  dashboard). The runners record the id under `payload.reportRef`, projected onto
  the card next to `note`.
* Where the report renders from page state, `ProjectReportBar` hands a stored
  report to it and adds **one row** of context — whose report it is, and for the
  three per-page modules the page switcher described below. It renders nothing at
  all with no project, no stored run, or no report in it, so a tool page without
  project context is exactly the tool it was.

**Opening a module shows that module's own report, not a summary of it.** Where a
module renders its report from page state, the stored run is handed straight to
it — SEO & GEO through `useSeoGeoAudit`'s new `hydrate()`, On-Page through the
same `setAudit`/`setView` path its own history uses, Agent Readiness through
`setResult`. So the report is the report, produced by the same components an
individual run produces it with. Where the report lives on a route of its own
(Site Crawler, Content Architect, Competitor Research) the panel links to it
rather than redirecting, and the competitor run now mirrors a client record into
that module's store so its dashboard opens on this project's comparison.

That required the runners to store each module's **native** result rather than a
summary (`payload.native`), and to stop skipping the two LLM steps an individual
run includes — SEO & GEO's analysis and Agent Readiness's brief — because a
report missing those sections is visibly a different report. `MAX_PAYLOAD_CHARS`
went from 120,000 to 400,000 to hold them; measured sizes are ~91 KB, ~33 KB and
~11 KB. The dashboard never reads that column (it projects `payload->>note`), so
the size is paid for only by the page that wants the full report.

### SEO & GEO, On-Page and Agent Readiness run across the whole crawl

Those three audit **one URL**. A project has many, so measuring the homepage and
calling the number a site score was wrong in a way no caveat fixes. Each now runs
across the pages the latest crawl found, stores that module's own report **per
page**, and reports the mean of the pages that scored.

| Piece | Where | What it owns |
| --- | --- | --- |
| `project_module_page_runs` | `supabase/migrations/0014_module_page_runs.sql` | one row per audited page: url, ordinal, status, score, counts, findings, and the native report |
| `listCrawledPages` | `server/modules/projects/crawledPages.js` | one definition of "this project's pages", shared by every module that audits them |
| `runAcrossCrawledPages` | `server/modules/projects/moduleRunners.js` | drives the per-page audits, rolls them up |
| `aggregatePages` | `server/modules/projects/moduleEvidence.js` | the mean, and findings merged across pages |
| `ProjectReportBar` | `client/src/components/project/ProjectReportBar.jsx` | the page switcher above each report |

Three properties the driver is responsible for:

1. **A page that fails does not fail the audit.** It becomes a failed page; the
   others still produce reports and the run still has a score.
2. **Pages are audited sequentially.** They are all on one host, and firing ten
   audits at a site at once is the opposite of the politeness the crawler is
   careful about.
3. **The budget is stated, never silent.** `maxPagesPerModuleAudit` (default 10,
   an admin limit like every other) bounds the work — measured, one page takes
   ~130 s for SEO & GEO, so all three modules over 50 pages is about two and a
   half hours. The result always says how many of the crawled pages it covered
   and which ones.

**Which pages a budget covers is a real decision, and the first version got it
wrong.** Ordering was depth, then the crawl's own `data.inlinks`. On the live
crawl that field is **0 on every row** — nothing populates it — and 49 of 50
pages sit at depth 1, because they came from the sitemap. So the ordering
collapsed to row id: ten pages chosen by insertion order, presented as the ten
that matter. The crawler does store a real link graph (`crawl_run_links`, 18,340
edges for that run), so pages are now ranked by **how many distinct pages of the
site link to them** — homepage 49, then 5, 4, 3, 2… — with path depth and then
alphabetical order as deterministic last resorts, so the same crawl always yields
the same audit set. The source is chosen once per run rather than per page: a page
missing from the graph must not fall back to a stale non-zero field and outrank a
page the graph actually counted.

`payload.pageSelection` records which rule was used, and the report bar shows it
next to the coverage figure.

**The score is a mean, and says so.** `scoreBasis` reads *"Mean of 7 page
score(s) from the SEO & GEO audit (rule-based bucket scores, weighted composite,
capped by blocking issues)"* — averaging a module's own per-page scores is
arithmetic on its methodology, not a new one, and §6.2 means the basis has to make
that legible. The bar labels the figure **Site average** with the page count,
because one number over ten pages is a different claim from a number about one
page, and the report below it is about one page.

#### The page switcher

`ProjectReportBar` replaced the one-line loader. In one row: whose report this is,
the site average and what it averages, coverage (*"10 of 50 crawled · most linked
· 40 unaudited"*), and the page walker — previous/next arrows plus a picker
listing every audited page with its score chip, the module's own band, and its
severity counts, filterable once there are more than eight.

Decisions in it worth keeping:

* **It opens on the first page audited** — the homepage, since pages are audited
  shallowest-first. The picker is sorted **worst-first**, which is the order
  somebody fixing things reads in, but landing on a random deep page would be
  disorienting.
* **Unscored and failed pages sort last, not first.** They are not good, they are
  unmeasured; floating them to the top on a `Number(null) === 0` would bury the
  pages that actually scored badly under pages nobody managed to audit.
* **The chip does not invent score bands.** Colouring 62 amber asserts "62 is
  mediocre", which no module said. SEO & GEO publishes its own bands
  (`SCORE_BANDS`) and Agent Readiness its levels (`levelFromScore`), so the chip
  reads those; a band it does not recognise, and On-Page's page-type label, render
  untinted. The rules live in `client/src/lib/pageReportPicker.js` so they are
  testable, and a test asserts no `score >= n` threshold exists in either file.
* **Reports are fetched one page at a time** through
  `GET /api/projects/:projectId/modules/pages/:pageRunId`. A 50-page run holds
  several megabytes of reports and the view shows one URL; the detail response
  carries the page list without the reports.
* **On-Page's bar sits above its view switch.** Inside the input view it
  unmounted the moment a report opened, which made changing page impossible after
  the first one. A test pins the order of the two.

#### Two more null-as-zero bugs, caught by measuring

* **The mean counted failed pages as zeros.** `Number(null)` is `0` and
  `Number.isFinite(0)` is `true`, so a null score passed a finiteness check: 90
  and 70 with one failed page averaged to **53** instead of 80, and the run
  reported 3 of 3 pages scored. The null check now precedes the finiteness check.
  A genuine 0 still counts, because that is a measurement.
* **Rolled-up findings came out in Map insertion order** — whatever the first
  audited page happened to report first. The dashboard card shows the top four, so
  a run could lead with four notices while errors sat twenty rows down. They are
  now ranked by severity, then by how many pages carry them.

#### Three bugs that surfaced while wiring it up

* **Extended thinking ate the output budget.** Moving SEO & GEO's analysis to
  Claude Sonnet produced nothing: measured on that exact prompt, a 32,000-token
  budget went 28,000 tokens on reasoning and returned *truncated* JSON after 318
  seconds. `thinking: { type: 'disabled' }` — accepted by Anthropic's
  OpenAI-compatible endpoint, ignored by the others — returns complete JSON in a
  fraction of the time. The budget is 24,000, set clear of the 12,960–14,471
  tokens two real runs actually used rather than just above them.
* **An empty reply parsed as an empty analysis.** `content || '{}'` turned a
  model that answered nothing into an object that parsed, rendered, and said
  nothing: the report looked finished with no advice in it. Both call sites in
  that file now treat an empty reply as the failure it is, and name the cause.
* **A failure with nowhere to go.** That audit reported AI failures only through
  its SSE `emit`, which is a no-op for a project run — so the analysis vanished
  and `ai: null` was stored with nothing anywhere saying why. Failures are logged
  as well as emitted, and the run records `aiAnalysisPresent` so the page can
  distinguish "no recommendations" from "the recommendation layer did not run".

### The six modules, read together

The modules were connected to the *project*, never to each other: `buildOverview()`
read the latest run per module and drew six independent cards. `server/modules/projects/insights/`
reads them as one body of evidence. It adds no measurement — every number in it was
already stored and nobody was reading it.

| File | What it owns |
| --- | --- |
| `findingIndex.js` | One page-attributed index of every module's findings |
| `backlog.js` | One ranked list of work, with the basis of the ranking on every item |
| `correlations.js` | Eight rules that join two or more modules |
| `changes.js` | New / fixed / regressed against the previous run |
| `index.js` | Assembly, plus `buildGaps` — what is not measured, and what would fix it |

**The crawl was throwing away its best evidence at the dashboard boundary.**
`crawl_run_findings.detail` keeps `{title}` and a count, so the card can only say
"1 error-level finding". The per-instance list survives in `crawl_runs.summary.findings`:
422 rows on the live project, **every one naming a URL**, each carrying the rule
catalog's `priority`, the value measured and the value wanted. Nothing had to be
re-crawled to recover it (§32) — it just had to be read. That single change is what
makes everything below possible.

**Template defects.** With page attribution, a defect covering most of the crawled
inventory is a template problem, not N page problems. Live: *"5 defects run through the
whole site template — 5 changes instead of 227 page edits."* That is the difference
between a defect list and a plan.

**The ranking is a sort, not a score.** §6.2 rules out a methodology that did not come
from a measurement, and a 0–100 "impact score" built from weights somebody picked is
exactly that. So items are ordered by a stated precedence over measured facts — severity,
then template scope, then pages affected, then the crawler's own priority — and every item
renders the line that explains its own position: *"Template-wide (48 of 50 crawled pages)
· warning · Medium Priority (the crawler rule catalog) · Tech Audit"*. A test asserts no
`priorityScore`/`impactScore` field is ever emitted.

An earlier version put template scope first and buried a High Priority sitemap error under
four template-wide notices. Severity leads now; scope promotes within a severity band,
never across one.

**The recommendations board finally has a source.** Its lifecycle has always worked and
nothing in the product could put anything into it — `recommendationsFromFindings` had no
caller, so the board sat empty telling users to fill it from somewhere that did not exist.
`POST /insights/promote` drafts a backlog item into it with its evidence and reach
attached. The item is rebuilt server-side from stored evidence rather than trusted from
the request body, so a recommendation cannot be created claiming a reach nothing measured.

**Checks nobody can action are separated from work.** On-Page marks a check `manual` when
it cannot be automated — "PSI data unavailable", "cannot verify inbound links from a
single-page fetch" — and those became `notice` severity in storage, putting a capability
gap in the same bucket as a minor defect. They now go to their own list (§30), because
nobody can fix "data unavailable".

**Every correlation withholds itself rather than degrading.** Hub and Spoke withholds
`orphanCount` on a capped crawl because an unreached page is indistinguishable from an
unlinked one; the rule respects that and reports the weaker signal it does publish as an
observation, labelled as one. A rule that throws becomes a withheld check with its reason,
not a blank dashboard.

**"Fixed" is the easiest lie in the product.** The page audits work to a budget, so which
pages get audited moves between runs. A fix is only claimed for a page audited in **both**
runs; everything else is `not_rechecked` and counted beside the fixes. Zero fixes across
zero comparable pages reports as `not_comparable`, never as "no change".

**Two truncation bugs found by measuring.** Hub and Spoke reports 39 unclustered pages and
its stored detail string, which is capped, names 15 of them; the competitor module names 10
of 22 gap terms. Reporting the small number understates the problem and the large one
overstates what can be acted on, so both travel together — *"15 of 39 affected pages
named"*. The crawl's 60-occurrences-across-49-pages is **not** the same thing and is not
flagged as partial.

**The composite score is gone.** It averaged SEO & GEO's weighted rule composite, Agent
Readiness's level score and Content Architect's mean cluster health — three different
questions on three different scales — into one number with nothing behind it (§5.2: no
single master score). The card now reports **modules scored, N of 6**, which is what the
composite genuinely knew. The radar stays: each axis is one module on its own scale.

### Honesty rules, implemented rather than described

The mockup showed scores of 78 / 64 / 55 / 84 / 91 / 62 and a composite of 73.
Those numbers do not exist. The design's *layout* ships; the numbers come from
stored rows, and where there are none the card says so:

* CrawlScope reports severity counts and findings but has **no rubric**, so its
  card carries `score: null, scored: false`. §6.2 forbids inventing a scoring
  methodology, so no 0–100 number is fabricated for it.
* The composite is `null` with status `insufficient_data` when nothing is
  scored — never `0`. §16.11 forbids coercing a missing measurement into a
  value, and a ring at zero reads as catastrophe rather than absence.
* The radar only fills its polygon when every axis is scored; unscored axes
  label as `—`.
* Alerts derive only from a failed run or the error/warning findings of the most
  recent terminal crawl. "No alerts" is a statement about the last crawl, not an
  unimplemented panel.

### Tests

`server/services/__tests__/platformFoundation.test.js` (31) and
`server/modules/projects/__tests__/projects.test.js` (35), in the repo's existing
plain-`node` + `assert` style, wired into `server/package.json`'s `test` script.
They cover the security-relevant pure logic: email normalization (including
near-misses like `…@position2.com.evil.com`), the §7.2 matrix, limit precedence
in both directions, origin and country normalization, and the honesty rules
above.

`server/modules/projects/__tests__/perPageAudits.test.js` (48) covers the
per-page layer: which pages a budget covers and why, that the link graph decides
it and outranks the unpopulated crawl field, that the ordering is deterministic,
that the mean ignores unmeasured pages without treating them as zeros, and that
the picker neither invents score bands nor sorts unscored pages to the top.

`server/modules/projects/__tests__/insights.test.js` (56) covers the cross-module layer:
that an unattributed finding never acquires pages, that a withheld measurement never
becomes a zero, that the ranking emits no score field and states its own basis, and that a
page audited in only one of two runs is never called fixed.

Full suite: **all green** — 369 assertions across 15 files, 132 `node:test`,
0 failures. `npm run build --prefix client` succeeds.

Verified against the live database (Gentle Dental, 50 internal pages in the
latest crawl): page selection returns the homepage at 49 inbound links followed
by the most-linked articles, in 2.9 s including the 18,340-edge graph read; and
all six module-detail responses still serve their stored reports with 0014 not
yet applied.

---

## 2. Gaps you will hit

### CrawlScope run endpoints are still creator-scoped

`server/modules/crawlScope/api/routes.js` scopes runs by `req.user.id`, and
finding reviews are keyed per reviewer (`repo.listFindingReviews(db, runId,
owner)`). So a teammate who shares the workspace can see a project and its
stored evidence through `/api/projects`, but cannot launch its crawl or open the
run.

Widening this is not a one-line change: it needs a decision about whether
finding reviews are per-user or per-workspace, which belongs to the review /
approval phase. Rather than ship a button that 404s, the dashboard says so:
`projectView` exposes `createdBy`, the list response exposes `viewerUserId`, and
the Run Full Audit sheet explains the restriction and disables the confirm.

Also still creator-scoped: `GET /api/crawl-scope/projects` (the crawler's own
list). `/api/projects` is the workspace-scoped list.

### The unified-workspace flag doesn't gate the new UI

`unified_project_workspace` exists, resolves correctly, and is seeded off. The
new dashboard ships **unflagged**, because it replaces the tool grid in place
while keeping the launcher — there is no parallel implementation to switch
between. The flag is reserved for the phase-2 navigation change.

### All six modules are connected — with two conditions

Every module now stores project-scoped evidence. Two of them depend on something
before they can say anything, and both say which:

| Module | Evidence source | Needs |
| --- | --- | --- |
| Tech Audit | `crawl_runs` + `crawl_run_findings` | a completed crawl |
| Hub and Spoke | Content Architect's stored analysis | a completed analysis in `/content-architect` |
| SEO & GEO | `project_module_runs` + `project_module_page_runs` | a completed crawl to supply the pages; scores itself per page |
| On-Page | `project_module_runs` + `project_module_page_runs` | a completed crawl; a target keyword per page, or those checks stand down |
| Agent Readiness | `project_module_runs` + `project_module_page_runs` | a completed crawl to supply the pages; scores itself per page |
| Competitor Research | `project_module_runs` | tracked competitors, `SEMRUSH_API_KEY`, and ~1,955 units per domain |

**Hub and Spoke is served by the Content Architect module.** The card reads the
analysis that `/content-architect` stores — its topic clusters, hub selections,
gap hubs, orphan and buried pages, possible cannibalisation — and reports that
module's own mean cluster health as the score (weights in
`contentArchitect/config.js`, summing to 100).

It **reads and never runs** that workflow: Content Architect needs a person to
confirm its URL pattern table, and it crawls the site itself, which §32 forbids
inside an audit module. With no stored analysis the card says so and points at the
tool, rather than computing a weaker second version.

`server/modules/projects/hubSpoke.js` was that weaker second version, clustering
from `crawl_run_links`. It is **no longer wired in** — two implementations of one
idea is what §32's "prefer service extraction over parallel replacement" rules
out. The file and its tests remain, marked unreferenced, and can be deleted.

**Competitor Research is excluded from the default "Run Full Audit" set.** It is
the only module that spends a metered third-party budget — roughly 1,955 SEMrush
units per domain, so about 3,910 for a project with one competitor and 9,775 with
four. "Run Full Audit" is pressed repeatedly, after every fix; billing it each
time is not a default anybody would choose deliberately. It runs from its own
card, and the audit response names it in `excludedBecauseMetered` with the
estimate, so a full audit never quietly means most of one.

Without `SEMRUSH_API_KEY` that module falls back to a mock provider for its own
screen. Simulated numbers are **not** stored as project evidence: they would
appear on a client dashboard and in an exported report as if measured.

They all still run standalone from the launcher, exactly as before.

### Smaller ones

* **Site verification is an assertion.** `POST /verify-site` accepts
  `administrator_assertion` and records who asserted it; automated proof methods
  answer **501**. A robots override requires a verified site plus a reason, and
  is audited strictly.
* **The admin page publishes platform-scope limits only.** Workspace- and
  tier-scope policies are supported by the API and the precedence logic, but
  have no form yet.
* **Workspace lifecycle columns exist without a purge job.** `lifecycle_status`,
  `purge_after` and the restore columns are in place; the 30-day purge cron and
  its UI are phase 2.
* **New projects start with their schedule off.** Enabling it anchors
  `next_run_at`; disabling clears it. This avoids the "enabled but never fires"
  state `crawlScope/shared/cron.js` warns about.
* **Project creation is not transactional.** Supabase REST has no transactions,
  so `createProject` writes the project row before its domains. The ordering is
  deliberate: a project with no primary domain is visible and repairable, where
  an orphan domain row would not be.

---

## 3. Phase map

| Phase | State |
| --- | --- |
| 0 — foundation, authorisation, admin | **Built**, applied, verified |
| 1 — workspace projects, domains, overview | **Built** |
| 2 — workspace lifecycle + purge | **Built** — grace-period deletion, restore, hourly sweeper |
| 3 — shared-evidence audits | **Built** — on-page, SEO&GEO, agent readiness, competitor |
| 4 — sitewide insights | **Built** — Hub and Spoke, reading Content Architect's analysis |
| 5 — Search Console / rank integration | **Not built.** Needs Google Cloud configuration this repo cannot supply — see below |
| 6 — recommendations and approval | **Built** — draft → proposed → approved → shipped, with rejection reasons |
| 7 — reporting | **Built** — one XLSX per project, including a coverage-and-gaps sheet |
| 8 — measurement | **Not built.** Depends on phase 5's data |

### Phase 3 — how a module becomes connected

Each of the four went through the same three steps, and a fifth module was added
in phase 4:

1. **Service extraction, never reimplementation.** `runSeoGeoAudit` and
   `runAgentReadiness` were lifted out of their route handlers and the routes now
   call them. An ad-hoc audit and a project audit therefore run *the same code*
   and cannot report different scores for the same page (§32). On-page already
   had a callable `runAudit`.
2. **A project-derived target.** The module is pointed at the project's primary
   domain rather than a pasted URL. `targetFor` throws rather than guessing —
   auditing the wrong host produces evidence that looks real and is not.
3. **Normalised storage.** `moduleEvidence` writes one `project_module_runs` row
   per execution, opened *before* the work starts so a crash leaves a failed run
   rather than a card that looks unrun.

**Scores are the modules' own.** SEO & GEO and agent readiness compute 0–100
figures with their own methodologies, and those are stored verbatim alongside a
`score_basis` naming the methodology in words — the DB refuses a score without
one. On-page and competitor have no rubric, so they store `null` and their cards
show findings and an em dash. Nothing here invents a scale (§6.2).

**What the composite now shows.** With two modules scoring, the composite is a
real mean of the modules that scored — never averaging in a zero for the ones
that did not, and still `null` when nothing has scored at all.

### Phase 4 — Hub and Spoke, and the link graph

`crawl_run_results` stores `outlinks`/`inlinks` as **counts**, which cannot
answer "which page links to which". The crawler already built the edges in memory
for its findings pass, so nothing is recomputed and nothing is re-fetched (§32
forbids re-crawling inside an audit module) — the payload simply stops throwing
them away, and `crawl_run_links` stores the internal ones.

**Only crawls that run after migration 0012 have a graph.** A project whose
crawls predate it gets an honest `insufficient_data` card saying so, and naming
re-crawling as the fix.

Hub and Spoke reports Content Architect's **own** mean cluster health as its
score. That is the module's methodology, not one invented here — §6.2 forbids
inventing a scale, not reporting an existing one. Its findings are that module's
too: gap hubs, orphans, buried pages, unassigned pages, and *possible*
cannibalisation, kept hedged exactly as the module labels it.

`crawl_run_links` is still written by the crawler and is now read by nothing.
It is cheap and additive, so it stays — say the word and the writer comes out.

### Phase 6 — recommendations

A finding is an observation; a recommendation is advice somebody is accountable
for. The lifecycle is `draft → proposed → approved → shipped`, with
`proposed → rejected` and a reopen path from rejected.

Three properties the design protects:

* **Approval names a person.** Only a role holding `approveRecommendation`
  (approver and above, per §7.2) may approve, and the approver is recorded. A
  CHECK constraint refuses any row in `approved` or `shipped` without an
  `approved_by`, so no automated path can quietly become the approver.
* **A material edit revokes the approval.** Changing the title or body of an
  approved recommendation sends it back to `proposed`. Priority and effort do not
  — re-ordering a queue is not a change to the advice.
* **Nothing is deleted, and a rejection needs a reason.** "Why didn't we do what
  the audit said" is the question a retrospective actually asks.

Severity deliberately does **not** become priority: an error on one page can
matter less than a warning on six hundred, and mapping one to the other would
dress a guess up as a decision.

### Phase 7 — reporting

`GET /api/projects/:id/report.xlsx` assembles one workbook from stored rows only.
It runs no audits and computes no scores, so two exports of an unchanged project
are identical — which is what makes a figure in it quotable.

The sheets are: audit profile, one per module with findings, site structure,
recommendations, and **coverage and gaps**. That last one is the point: a reader
has to be able to tell "we measured this and it was fine" from "we never measured
this" (§30). Unscored cells say *"Not scored"* with the reason rather than being
left blank, because a blank cell in a spreadsheet reads as a zero.

### Phase 5 — what it needs from you

Search Console and rank data are the two things this repo cannot supply itself:

* **Search Console** needs the Search Console API enabled on the Google Cloud
  project, the `webmasters.readonly` scope added to the OAuth client, and a
  verified property per site. The token handling also needs an encryption key —
  §32 requires OAuth tokens encrypted at rest and refresh tokens never sent to
  the browser or written to logs.
* **Rank data** needs a provider. Nothing in this repo tracks positions today.

Nothing has been stubbed for either. There is no code that pretends to have data
it cannot get, and no placeholder score waiting to be mistaken for a measurement.
Phase 8 (measurement — did the shipped change move anything) reads phase 5's
data, so it waits on the same inputs.

## 4. Standing constraints

From §32, and they still hold:

* Migrations stay additive. Legacy endpoints and tables stay in place.
* Never hard-code admin authorization in the frontend. The header's Admin link
  and `AdminPage`'s gate are hints; `/api/admin` re-checks the persisted grant
  on every request.
* Never coerce a missing measurement to zero, and never make a causal
  performance claim from correlated data.
* Don't re-crawl inside an audit module — read the stored crawl.
* The Supabase service-role key never reaches the browser. OAuth refresh tokens
  never reach the browser or the logs.
