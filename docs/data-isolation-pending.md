# Data isolation: what is still to do

Status at 2026-10-04. Follows the data-isolation audit of 2026-10-01, which checked every API route, background job and session path for one thing: can a signed-in user reach data that belongs to another workspace or project?

## Summary

- The newer parts of the app are already walled correctly: projects, CrawlScope, AI Visibility, Content Writer articles, run history, workspaces and admin.
- Most older tools have no walls. Any signed-in user can list, read, edit and delete every client's data in:
  - Competitor Tracker
  - Robots Monitor
  - On-Page Audit
  - Location Page Builder
  - Knowledge Base
  - Market Potential
  - standalone Content Architect analyses created before 2026-10-04
- Today every user is Position2 staff in one shared workspace, so this is not a leak *yet*. **It must be fixed before any outside client company gets a login** (Part 2 of the team-workspace plan).
- The urgent fixes that changed nothing for users are done but **not yet committed** (Phase 1 below).

| Phase | What | Size | Blocks Part 2? |
|---|---|---|---|
| 1 | Commit and ship the fixes already made | S | — |
| 2 | Workspace walls for the older tools | L (7 tools) | **Yes** |
| 3 | Three product decisions | — (you) | Partly |
| 4 | Remaining smaller fixes | M | Some |
| 5 | Checks on production | S | Informs 2 |

---

## Before you start: rules for this codebase

These have each caused a real problem before.

- **A push to `unified-fast` redeploys Railway** and kills any crawl in progress. Check nothing is running, and tell the team, before pushing.
- **The local `.env` points at the production database.** Any script you run locally writes to production. Run every data script in its dry-run or plan mode first, and have a person review the output before using `--apply`.
- **Never `require()` a server entry point** (`server.js`, `worker-module.js`, `modules/crawlScope/worker/index.js`) to test something. They load `.env` and start production workers. Use `node --check` for syntax.
- **Migrations:** add the next free number in `supabase/migrations/` (0044 at time of writing; other sessions are adding them too, so check first). Apply with `node server/scripts/migrate.js` (dry-run first). Restart the Railway process after a migration that adds columns, because `identityStore` and the CrawlScope repo cache missing columns.
- **Tests:** `npm test --prefix server` runs `server/scripts/testServer.js`; add new suites to its `SUITES` list. The local test database on port 5433 is normally down, so the 11 database-backed suites fail with `ECONNREFUSED 127.0.0.1:5433`; that is not a regression. To validate SQL, use PGlite (full migrations plus `pglite-socket` runs the real DB suites).
- **Other Claude sessions edit this working tree at the same time.** Run `git diff` on a file before editing it, and stage your own hunks only.

### The access model every fix below uses

There is one place that decides access: [`server/services/projectAccess.js`](../server/services/projectAccess.js). The database connection is the table owner, so there is no row-level security behind it. A query without a workspace or project filter reads every tenant.

| Call | Use it for |
|---|---|
| `requireProject(req, projectId, capability)` | Anything that belongs to a project. Answers 404 (not 403) for another workspace's project. |
| `requireWorkspace(req, workspaceId, capability)` | Anything that belongs to a workspace but not a project. |
| `accessibleWorkspaceIds(userId)` | Filtering list queries in SQL: `where workspace_id = any($1)`. |
| `resolveIdentity(req)` (`services/workspaceContext.js`) | The caller's home workspace, for stamping new records. |

Which capability each kind of route should require:

| Route does | Capability |
|---|---|
| Reads, exports, status polls | `view` |
| Starts a run, or anything that spends SEMrush or LLM budget | `startRun` |
| Edits or deletes a tool's records | `editProjectSettings` |
| Adds or removes competitors | `manageCompetitors` (contributors get `'propose'`) |
| Changes who receives reports or alerts (email, Slack) | `manageRecipients` |
| Seeds or reconfigures a tool for everyone | platform admin only (`platformAdmin.requirePlatformAdmin`) |

Today every Position2 user joins as `approver` or higher, so these checks block no one on the team.

---

## Phase 1: ship what is already done

### 1.1 Done in this session (uncommitted)

| Fix | Files | Test |
|---|---|---|
| Robots Monitor never sends saved staging passwords to the browser. A blank password on edit keeps the saved one, and moving a domain to another host needs the password typed again. | `server/modules/robotsMonitor/domainAuth.js` (new), `monitorStore.js` (`getDomain`), `routes.js`; `client/src/pages/RobotsMonitorPage.jsx` | `modules/robotsMonitor/__tests__/domainAuth.test.js` |
| Knowledge Base and module manifests can no longer read or write outside their folders (`../` path traversal). | `server/services/kbStore.js`, `server/routes/kb.js`, `server/routes/modules.js` | `services/__tests__/kbStorePaths.test.js` |
| The Agent Readiness PDF escapes caller fields and blocks all network requests while rendering. | `server/routes/agentReadinessAudit.js` (`buildPdfHtml`, `POST /pdf`) | `routes/__tests__/agentReadinessPdf.test.js` |
| `POST /api/projects/:id/audit` refuses a `crawlRunId` from another project. | `server/modules/projects/streamingAudit.js` (`crawlBelongsToProject`), `modules/projects/routes.js` | `modules/projects/__tests__/crawlOwnership.test.js` |
| New Content Architect projects from the tool page are stored in the creator's workspace. | `server/modules/contentArchitect/access.js` (`workspaceForNewProject`), `routes.js` | `modules/contentArchitect/__tests__/newProjectWorkspace.test.js` |

All five suites are registered in `server/scripts/testServer.js`. The full run was 80 of 91 suites passing; the 11 failures were all the local test database being down.

**Shared files.** Another session has edited three of these files too:
- `robotsMonitor/routes.js`: it reworked `POST /run`.
- `RobotsMonitorPage.jsx`: it now leaves a blank password out of the request.
- `agentReadinessAudit.js`: it switched the fetches to `safeEgress`.

Stage hunks (`git add -p`), not whole files, or commit both sessions' work together on purpose.

### 1.2 Done by another session (uncommitted, not reviewed here)

Blocking requests to internal addresses (SSRF):
- `server/services/safeEgress.js` (`safeGet`, `assertPublicUrl`, `guardPage`), with tests in `services/__tests__/safeEgress.test.js` and `routes/__tests__/egressWiring.test.js`.
- Applied in `services/scraper.js`, which covers `/api/scrape` and Location Page competitor scraping.
- Also applied in:
  - `checks/onpage.js`
  - `utils/linkDiscovery.js`
  - `routes/agentReadinessAudit.js`
  - `imageAltAudit.js`
  - `seoGeoAudit.js`
  - `contentEnhancement.js`
  - `articleEnhancement.js`
  - `articleEnhancementLite.js`

**To do:**
- [ ] Review that work, and confirm its tests pass in the full run.
- [ ] Check the fetchers it may not have reached, which also take URLs from users:
  - `modules/onPageAudit` (`POST /api/on-page-audit/run`)
  - `modules/robotsMonitor/indexChecker.js` and `sitemapCrawler.js` (domain URLs entered by users)
  - the Competitor Tracker content analysis
- [ ] Commit, then push when no crawls are running.

---

## Phase 2: workspace walls for the older tools

**Do this before any outside company logs in.** It overlaps heavily with [`docs/design-audit/02-plan-one-client.md`](design-audit/02-plan-one-client.md), which links each tool's client list to a project. That plan gives each record a `project_id`; this phase makes the server enforce it. Do them together, tool by tool.

### The same five steps for every tool

1. **Give every existing record an owner.** Run the matching script in plan mode, have a person review it, then apply it. Records that match no project go on a "needs assigning" list. Until a record is assigned, it stays visible to members of the Position2 workspace only.
2. **Stamp new records.** Creating a record takes a `projectId` (or uses the header's project), checks `requireProject(req, projectId, 'editProjectSettings')`, and saves `project_id` / `workspace_id`.
3. **Check every id route.** Use `router.param('clientId' | 'id' | …)` to load the record, then call `requireProject(req, record.project_id, capabilityFor(method))`. Answer 404 for anything outside the caller's workspaces. Child ids are always queried together with the parent's id (`where id = $1 and client_id = $2`).
4. **Filter lists in SQL** with `accessibleWorkspaceIds`, never in JavaScript after the fact.
5. **Test isolation.** A user in workspace B gets 404 on every route for workspace A's record, and A's records never appear in B's lists. Use the database-backed harness (`services/__tests__/helpers/testDatabase.js`) under PGlite.

**Don't switch on step 3 before step 1 is finished.** A record with no owner would disappear for everyone.

### 2.1 Competitor Tracker (do first)

**Today:**
- All 21 routes in [`server/modules/competitorAnalysis/routes.js`](../server/modules/competitorAnalysis/routes.js) trust `:clientId`.
- `store.getClients()` has no filter; `getClient`, `updateClient` and `deleteClient` look up by id only; artifacts are keyed by `client_id` alone.
- Any user can read any client, export its PDF, delete it, or start paid SEMrush runs on it.
- Status polls read in-memory maps keyed by `clientId`.
- Four content-analysis edit routes (`…/mapping`, `…/reclassify`, `…/summary/top-pages`, `…/summary/sitemap`) don't even check that the client exists.

**Already in place:** `competitor_analysis_clients.project_id` (migration 0038, applied on prod), and `server/scripts/clientListInventory.js`, a read-only matcher.

**Work:**
- [ ] Fill `project_id`: the inventory report, then a reviewed fill step, then resolve the "needs assigning" records by hand.
- [ ] `store.js`: `listClients({ workspaceIds })` filtered in SQL; `getClient` returns `project_id`.
- [ ] `router.param('clientId')` loads the client, then calls `requireProject` with:
  - `view` for GET and export
  - `startRun` for `run`, `run-pagespeed`, `discover-competitors` and `content-analysis/run`
  - `manageCompetitors` for adding or removing competitors
  - `editProjectSettings` for PATCH, DELETE, mapping, reclassify and summary edits
- [ ] `POST /clients` needs a project and stamps it.
- [ ] Client UI: the "Client" dropdown follows the header project (one-client plan, step 3.1).

### 2.2 Robots Monitor

**Today:**
- Every route in [`server/modules/robotsMonitor/routes.js`](../server/modules/robotsMonitor/routes.js) is global: clients, domains, run history, and one shared Slack webhook and schedule.
- Anyone can redirect every client's alerts to their own Slack, or turn the schedule off.
- `monitorRunner` checks every client's domains in one run, and `monitorScheduler` runs one global cron job.
- `robots_monitor_clients.project_id` exists (0038) but is unused.

**Work:**
- [ ] Fill `project_id` (same inventory script).
- [ ] Filter the client list, then check each id route:
  - `editProjectSettings` for client and domain edits
  - `startRun` for `POST /run`
  - `view` for history
- [ ] `robots_monitor_runs`: add `workspace_id` (new migration). Filter `GET /history` and `GET /history/:runId`.
- [ ] Slack settings and schedule per workspace: change the settings key to `robots_monitor.slack:<workspaceId>`; editing them needs `manageRecipients`.
- [ ] The scheduler runs each workspace on its own schedule and posts only that workspace's results to its own webhook.
- [ ] Optional: drop the separate client list and monitor domains straight from projects (one-client plan, step 3.7).

### 2.3 Content Architect: records created before 2026-10-04

**Today:**
- [`access.js`](../server/modules/contentArchitect/access.js) `authorize()` lets anyone in when a record has neither `platformProjectId` nor `workspaceId`.
- New projects no longer get created that way (Phase 1), but older ones exist.
- `ensureProject` in `store.js` lets a workspace take over an unlinked analysis of the same site.
- `PUT /projects/:id/competitors` needs only `startRun`, so it bypasses competitor approval and spends SEMrush units through `suggest-spokes`.

**Work:**
- [ ] Count the open records on prod (read-only; see Phase 5).
- [ ] Backfill `workspace_id` to the Position2 workspace for every record with neither link. Every one of them was created by staff.
- [ ] Then make `authorize()` answer 404 when a record has no link at all. No open fallback.
- [ ] Filter `store.listProjects()` in SQL by `accessibleWorkspaceIds`. Today it loads every row and authorizes them one by one in JavaScript.
- [ ] In `ensureProject`, only take over records already in the same workspace (drop the `!r.workspace_id ||` branch).
- [ ] `PUT …/competitors` requires `manageCompetitors`.
- [ ] Add `content_architect_projects` to the workspace purge (see 4.6).

### 2.4 On-Page Audit

**Today:**
- `GET /list` returns the latest 50 audits of all users.
- `GET /result/:auditId` and `DELETE /:auditId` look up by id only, and delete needs no permission.
- The audits table has no owner column, and the in-memory job map has no owner.
- Files: [`server/modules/onPageAudit/routes.js`](../server/modules/onPageAudit/routes.js), `store.js`.

**Work:**
- [ ] Migration: add `workspace_id`, `created_by`, and an optional `project_id`. Backfill `workspace_id` to Position2.
- [ ] Save the caller's workspace and user on each audit.
- [ ] Filter list, get and delete. Delete is allowed for the audit's creator or `editProjectSettings` holders.
- [ ] Store `userId` on in-memory jobs and check it in `GET /status/:jobId`.

### 2.5 Market Potential

**Today:**
- `market_potential_services.name_key` is unique across everyone.
- `POST /service/resolve` with an existing name **overwrites that service's `ownDomain`** (`store.js` `createService`, `on conflict`). This already hurts staff today: two people resolving the same service name break each other's competitor classification.
- `POST …/basket/propose`, `PUT …/basket/draft`, `POST …/basket/freeze`, `POST /compare` and `POST /summary` trust `serviceId` with no ownership check.
- `DELETE /scenarios/:id` ignores `user_id`.
- The summary cache key leaves out the rows that get summarised.

**Work:**
- [ ] Fix the `ownDomain` overwrite first; it is a bug even with one workspace. Keep `ownDomain` per request or scenario, not on the shared service row, or don't overwrite it on conflict.
- [ ] Migration: give `market_potential_services` a `workspace_id` and make it unique on `(workspace_id, name_key)`. Backfill to Position2.
- [ ] Check ownership on every `serviceId` route.
- [ ] `deleteScenario`: `where id = $1 and user_id = $2`.
- [ ] Summary cache: add a hash of `rows` and the workspace to the key, or recompute the rows on the server.
- [ ] The geo and volume caches can stay global; they only hold third-party data.

### 2.6 Location Page Builder

The largest piece: about 54 routes across [`server/routes/locationPageBuilder.js`](../server/routes/locationPageBuilder.js) and [`lsPages.js`](../server/routes/lsPages.js) (mounted at `/api/location-page-builder/ls`).

**Today:**
- Clients, entities (services, locations, providers, reviews, insurance sets, tone profiles, templates) and pages are all global.
- `PUT /entities/:collection/:id` can move a record to another client by rewriting `client_id`.
- `DELETE /pages/:id` is a hard delete.
- Seed endpoints (`/seed`, `/seed-gentle-dental`, `/ls/seed/clear-behavioral-health`) wipe and rewrite a client's data, and any user can call them. `replaceAllForClient` is not in a transaction.
- Approval gates take the role and actor from the request body (see 3.1).
- `lpb_clients.project_id` exists (0038) but is unused.

**Work:**
- [ ] Fill `lpb_clients.project_id`.
- [ ] Resolve every page and entity to its client, then call `requireProject` before reading or writing. Lists filtered by client.
- [ ] `PUT /entities/...` may not change `client_id`.
- [ ] Seed endpoints: platform admin only. Wrap `replaceAllForClient` in `db.tx`.
- [ ] Routes keyed by `clientId` / `serviceId` / `locationId` (`/wizard/*`, `/ls/keywords`, `/ls/brief`, `/ls/copy`, `/ls/existing`) check the client's project first.
- [ ] `/pages/:id/keywords/run` and `/content/run` (they start paid pipelines) need `startRun` on the page's project.

### 2.7 Knowledge Base (and how Content Writer uses it)

**Today:**
- The KB is flat files plus `knowledge-base/_index.json`, inside the deployed code folder.
- Any user can list, read, rewrite, deactivate or permanently delete any client's brand or feedback KB.
- Any user can rewrite a module's `required_kbs` / `optional_kbs`, which changes what goes into everyone's prompts.
- `feedbackKbIds` and `kbId` from the request are loaded without checking they belong to the chosen client:
  - `services/kbLoader.js` (`loadKBContext`)
  - `routes/articleEnhancement.js`
  - `routes/articleEnhancementLite.js`
  - Content Writer's brief generation (`services/articleBrief.js`, `contentWriter/document.js`)
- The result: an article in one workspace can pull another client's KB into its brief.

**Work:**
- [ ] Decide on storage. Move the KB into Postgres (recommended: it gets the same workspace/project filtering as everything else, and edits survive redeploys), or add `project_id` to the index entries (one-client plan, step 2).
- [ ] Reads are filtered by workspace. Writes and deletes need `editProjectSettings` on the KB's project. Global "best practices" and "industry" KBs are read-only except for platform admins.
- [ ] `PUT /api/modules/:id` is platform admin only.
- [ ] Only accept `feedbackKbIds` / `kbId` whose `client` matches the project's own client. Content Writer maps the article's project to its client and does not trust `document.options.client`.

---

## Phase 3: decisions only you can make

Each of these changes how people work, so it needs a product decision before the code.

### 3.1 Location Pages: who may approve each step?

`POST /api/location-page-builder/pages/:id/gate` takes `role` and `actorId` from the request and defaults the role to `admin`, which may act on any gate. Anyone can approve the SEO, clinical, content and client steps, and fake who approved. `PUT /pages/:id/section` also takes `actorId` from the body.

**Decide:** which workspace role (or named person) may pass each gate. The code then takes the role and actor from the signed-in user and the workspace role. Expect some people who approve today to be refused.

### 3.2 robots.txt: who may crawl a site that blocks crawlers?

The admin-only override in `POST /api/projects/:id/robots-override` (capability `overrideRobotsPolicy`, site verification, reason) is stored but never read. The crawler takes `respectRobots` from the request (`server/modules/crawlScope/shared/options.js`, around line 294), so anyone can switch it off.

**Decide:** whether ignoring robots.txt requires the admin override. If yes, the crawler sets `respectRobots = !(project.robots_override && project.site_verified_at)` and ignores the request value. Any "ignore robots.txt" toggle in the crawl screen stops working for non-admins.

### 3.3 Which URL may a project's crawl target?

`POST /api/crawl-scope/runs` with a `projectId` crawls whatever `url` is in the body (`modules/crawlScope/api/routes.js`, around line 169). It then rewrites that project's page list and emails its recipients.

**Decide:** what counts as the same site: same host only, any subdomain of the primary domain, or explicitly listed staging hosts. Then enforce it.

---

## Phase 4: remaining smaller fixes

Severity is from the audit, assuming outside companies will have their own workspaces.

| # | Sev | Where | Problem | Fix |
|---|---|---|---|---|
| 4.1 | Medium | `server/server.js:57` | CORS reflects any origin and allows credentials. Safe only while the session cookie is `SameSite=lax`. | Allow only the app's own origin (plus `localhost:3000` in development). |
| 4.2 | Low | `modules/crawlScope/api/routes.js` (`PATCH /projects/:id`, around line 796) | A contributor who created a project can change its report recipients without `manageRecipients`. | Also require `manageRecipients` when `recipients` is in the body. |
| 4.3 | Low | `modules/crawlScope/db/repo.js` (`previousComparableRun`, around line 819) | For crawls outside any project, review notes are copied by `owner + url`, so they can land in another workspace. | Also match `workspace_id is not distinct from` the run's. |
| 4.4 | Low | `modules/crawlScope/api/routes.js` (pause, resume, stop, findings, pagespeed) | These check only that the caller can view the run, not a capability. `POST /runs/:id/results/pagespeed` calls the PageSpeed API before checking that the URL belongs to the run. | `requireProject(..., 'startRun' / 'reviewFinding')` when the run has a project. Check the URL first. |
| 4.5 | Low | `server.js` (`GET /api/crawl-scope-report/:token`), `modules/crawlScope/run/report.js` | Emailed report links last 7 days, can't be revoked, and still work after a recipient is removed or the project is purged. Report files are never deleted. | Put `runId` in the token and check the run still exists. Shorten to 24–72 h. Delete files on purge. |
| 4.6 | Medium | `services/workspaceLifecycle.js` (`PURGE_ORDER`) | A workspace purge deletes four tables and relies on cascades. Content Architect records, report files and all the unscoped tools' data survive. | Add every workspace-owned table (after Phase 2) and the stored files. |
| 4.7 | Low | `routes/auth.js` | Sessions last 7 days and logout doesn't revoke them. `jwt.verify` doesn't pin the algorithm. Every session has role `seo`, so `requireSeo` never blocks anyone. | Add a `jti` and a revocation list checked in `requireAuth`. Pass `algorithms: ['HS256']`. Remove `requireSeo` or give it meaning. |
| 4.8 | Low | `routes/competitorAnalysis.js` (around line 101), and other `/stream/:token` and job routes | Job ids and stream tokens aren't tied to their creator. `POST /run` can be re-run on a finished job, spending SEMrush units again. | Save `req.user.userId` on the job and check it. Refuse a re-run of a running or finished job. |
| 4.9 | Low | `modules/aiVisibilityLite/routes.js` (around line 413) | Opening the report (`view`) starts paid sentiment classification. | Require `startRun`, or run it as part of a run. |
| 4.10 | Low | SEMrush and LLM spend in Market Potential, Competitor Tracker, keyword research, search | One shared budget for everyone, with no per-workspace limit or attribution. `GET /api/semrush/balance` shows Position2's balance to every user. | Per-workspace ledgers and caps through `adminLimits`. |

---

## Phase 5: things to check on production

None of these can be answered from the code. Production writes from a Claude session are blocked, so a person runs any query against prod (read-only).

- [ ] **`COOKIE_SAME_SITE` on Railway.** If it is `none`, 4.1 becomes urgent.
- [ ] **Content Architect records with no owner:**
  ```sql
  select count(*) from content_architect_projects
   where platform_project_id is null and workspace_id is null;
  ```
- [ ] **CrawlScope runs with no workspace** (they fall back to creator-only access):
  ```sql
  select count(*) from crawl_runs where workspace_id is null;
  ```
- [ ] **Has the 0038 fill step been applied?**
  ```sql
  select 'competitor' t, count(*) filter (where project_id is null) unassigned, count(*) total from competitor_analysis_clients
  union all select 'robots', count(*) filter (where project_id is null), count(*) from robots_monitor_clients
  union all select 'lpb', count(*) filter (where project_id is null), count(*) from lpb_clients;
  ```
- [ ] **Is `KB_ROOT` persistent on Railway?** If not, KB edits made in the app are lost on every redeploy. That decides 2.7.
- [ ] After the SSRF work ships: from the Railway container, confirm that `169.254.169.254` and private addresses are refused by `/api/scrape` and Agent Readiness.

---

## Suggested order

1. Phase 1: commit and ship.
2. Phase 5: the production checks. They take minutes and they size Phase 2.
3. Market Potential `ownDomain` overwrite (from 2.5). It is a live bug between staff today.
4. Phase 2 in this order:
   1. Competitor Tracker
   2. Robots Monitor
   3. Content Architect backfill
   4. On-Page Audit
   5. Market Potential
   6. Knowledge Base
   7. Location Page Builder
5. Phase 3 decisions, any time. 3.1 is needed before Location Pages is finished in Phase 2.
6. Phase 4, with 4.1 and 4.6 first.

**Done means:** a test user in a second, empty workspace sees an empty app. Every list is empty, and every id from the Position2 workspace answers 404 on every route. Run that as an end-to-end check before the first outside company is onboarded.
