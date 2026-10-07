# Data isolation audit: pending work

Status as of 2026-10-04. Source: the workspace and project data-isolation audit (2026-10-01). Several Claude sessions are fixing it in parallel in the same working tree. Nothing below is committed yet.

**How to use this file:** section 1 gets the finished work shipped. Section 2 can be done without asking anyone. Section 4 needs a product decision before any code is written. Each item names the files to change, the fix, and how to test it.

| Section | What | Items |
|---|---|---|
| 1 | Ship what is already done | 1 checklist |
| 2 | Fixes that need no product decision | 13 |
| 3 | Owned by another plan, so do not duplicate | 3 |
| 4 | Needs your decision first | 11 |
| 5 | Facts to confirm outside the code | 7 |
| 6 | Residual risk after all fixes | 3 |

---

## 0. Already done (not yet committed)

For reference, so nobody redoes these.

| Fix | Where | Test file |
|---|---|---|
| Tools refuse internal addresses on every request and redirect hop (content enhancement, SEO & GEO, image alt, article enhancement full and Lite, agent readiness) | `server/services/safeEgress.js` and the six routes | `services/__tests__/safeEgress.test.js`, `routes/__tests__/egressWiring.test.js` |
| Headless browser (scraper, on-page checks) never opens `file://` or an internal address | `services/scraper.js`, `checks/onpage.js` | same as above |
| Revoking a platform admin works and survives a restart | `services/platformAdmin.js` | `services/__tests__/platformAdminDb.test.js` |
| Queued and scheduled module runs stop for a deleted project | `services/moduleExecutors.js`, `services/moduleScheduler.js` | `services/__tests__/deletedProjectJobsDb.test.js` |
| KB and module file paths cannot escape their folders | `services/kbStore.js` | `services/__tests__/kbStorePaths.test.js` |
| An audit only follows its own project's crawl (`crawlRunId`) | `modules/projects/routes.js`, `streamingAudit.js` | `modules/projects/__tests__/crawlOwnership.test.js` |
| Robots monitor never sends saved staging passwords to the browser | `modules/robotsMonitor/domainAuth.js`, `routes.js` | `modules/robotsMonitor/__tests__/` |
| A new Content Architect analysis belongs to the creator's workspace | `modules/contentArchitect/access.js`, `routes.js` | `modules/contentArchitect/__tests__/newProjectWorkspace.test.js` |
| Only a market potential scenario's owner can delete it | `modules/marketPotential/routes.js`, `store.js` | `modules/marketPotential/__tests__/` |
| Location page builder approval no longer defaults the role to `admin` | `routes/locationPageBuilder.js` | — |
| Agent readiness PDF escapes caller fields and blocks network requests | `routes/agentReadinessAudit.js` | `routes/__tests__/agentReadinessPdf.test.js` |
| A non-UUID project id is a 404, not a 500 | `services/projectAccess.js` | `services/__tests__/projectAccessUuid.test.js` |

---

## 1. Ship what is already done

Do this before starting anything new. The longer this mix of changes stays uncommitted, the harder it is to review or roll back any one part of it.

- [ ] **Wait for the parallel sessions to stop.** Committing now captures their half-finished edits. Shared files: `agentReadinessAudit.js`, `moduleExecutors.js`, `modules/projects/routes.js`, `server.js`, `scripts/testServer.js`.
- [ ] **Run the full server suite.** See section 7 for how to run the database suites safely. Two failures are expected and are not caused by this work: `budgetRetention` (crashes PGlite) and one `portedStores` case (stale test setup).
- [ ] **Commit by topic, not as one change:**
  1. Data-isolation fixes (section 0)
  2. Shared API kit (`server/utils/api/`)
  3. Durable tool jobs (`services/jobs.js`, migration `0042_tool_run_jobs.sql`)
  4. Query performance indexes (migration `0043_query_performance_indexes.sql`)
  5. Client changes (`client/src/`)
- [ ] **Apply migrations 0042 and 0043 to production before pushing** the code that needs them. Dry-run first. Migrations are applied by hand here.
- [ ] **Push at a quiet time.** Pushing `unified-fast-aivisibility` redeploys production on Railway and stops any crawl in progress.

---

## 2. Fixes that need no product decision

Ordered by priority. P1 means do it next.

### 2.1 P1. On-page audit and robots monitor fetch user URLs with no address check

**Risk:** a signed-in user can point either tool at an internal address (cloud metadata, other Railway services). Some of the response comes back in audit results and run history.

**Files:**
- `server/modules/onPageAudit/dataCollector.js`. It follows redirects itself (`maxRedirects: 0` in a hop loop) and checks no host.
- `server/modules/robotsMonitor/indexChecker.js` and `sitemapCrawler.js`. They use plain axios with `maxRedirects: 5`.

**Fix:**
- `dataCollector.js`: call `assertPublicUrl(current)` from `services/safeEgress` at the top of each hop, and pass the request config through `safeAxiosConfig()`.
- `indexChecker.js` and `sitemapCrawler.js`: replace `axios.get` with `safeGet`.
- Robots monitor only: confirm the basic-auth header is not forwarded to a different host on a redirect. Add a `beforeRedirect` that drops `Authorization` when the host changes.

**Test:** extend `routes/__tests__/egressWiring.test.js`: each fetcher pointed at a live `127.0.0.1` server must never reach it.

### 2.2 P1. AI Visibility prompt generation follows redirects unchecked

**Risk:** the page URL is checked against the project's crawled pages, but `fetch` then follows redirects to anywhere (`redirect: 'follow'`). A project creator controls the site, so they control where it redirects.

**File:** `server/modules/aiVisibility/pagePrompts.js` (around line 129).

**Fix:** use `safeGet` from `services/safeEgress`, or `redirect: 'manual'` with `assertPublicUrl` on each hop.

**Test:** add a case to `egressWiring.test.js`.

### 2.3 P1. Content Architect: close the remaining open-access paths

New analyses are fixed (section 0). These parts are still open:

1. **Existing standalone analyses are still readable, editable and deletable by any user.** `authorize()` in `modules/contentArchitect/access.js` does nothing when a record has neither `platformProjectId` nor `workspaceId`.
   - **Fix:** run a one-off backfill that sets `workspace_id` to the Position2 workspace on every row where both links are null. Then change `authorize()` to deny (404) when there is no link.
   - **Order matters:** backfill first. Denying first would hide those analyses from everyone.
2. **The analysis list reads the whole table and filters in JavaScript.** `listProjects()` in `store.js` has no `where`.
   - **Fix:** filter in SQL with `workspace_id = any($1)` using `projectAccess.accessibleWorkspaceIds(userId)`, plus any `platform_project_id` whose project is in those workspaces.
3. **Cross-workspace adoption.** `ensureProject()` in `store.js` adopts the oldest unlinked row with the same host into whichever workspace's project asks first. Anyone can plant a standalone analysis, with its own competitors, that becomes another workspace's Hub & Spoke record.
   - **Fix:** only adopt rows whose `workspace_id` equals the target project's workspace. Once item 1 is done, every row has a workspace, so adoption across workspaces stops naturally.
4. **Competitors are gated by HTTP method.** `router.param('id')` in `routes.js` maps every non-GET, non-DELETE request to `startRun`, so a contributor can set competitors (metered SEMrush) directly.
   - **Fix:** map `PUT /projects/:id/competitors` to `manageCompetitors` explicitly.
5. **Content Writer can claim any analysis as its origin.** `modules/contentWriter/document.js` and `store.js` accept `origin.caProjectId` from the body unchecked.
   - **Fix:** run `authorize(req, caProject, 'view')` on create, and require that the analysis is linked to the article's project.

**Tests:** extend `newProjectWorkspace.test.js`. Cover a list that hides another workspace's rows, a 404 for a foreign or unlinked id after the backfill, no adoption across workspaces, and a contributor getting a 403 on competitors.

### 2.4 P1. CrawlScope: robots override can be bypassed

**Risk:** any member can send `options.respectRobots: false` and crawl while ignoring robots.txt. The admin-only `robots_override` flag on the project is never read by the crawler.

**Files:** `server/modules/crawlScope/shared/options.js` (`respectRobots: raw.respectRobots !== false`), `api/routes.js` (`POST /runs`, `PATCH /projects/:id`).

**Fix:** decide `respectRobots` on the server. For a project crawl, use `!project.robots_override`. Ignore a client-supplied `respectRobots: false` unless the caller passes `requireProject(..., 'overrideRobotsPolicy')`.

**Client:** in `client/src/components/crawlScope/CrawlOptionsForm.jsx`, disable the "Respect robots.txt" checkbox unless the user holds that capability. Whether non-admins can still crawl ad-hoc URLs that ignore robots is decision 4.4.

### 2.5 P2. CrawlScope: report recipients and audit trail

**Risk:** the `manageRecipients` permission exists in the role table but no route checks it. A contributor can add an outside email to their own project's scheduled reports. The CrawlScope `PATCH /projects/:id` writes through `repo.updateProject`, which skips the audit trail entirely.

**Files:** `server/services/projectAccess.js` (capability defined, never used), `modules/crawlScope/api/routes.js` (`POST /projects`, `PATCH /projects/:id`), `modules/projects/store.js` (`updateProject`).

**Fix:**
- Require `access.can('manageRecipients') === true` whenever `recipients` is present in the body. That covers both routers' create and update.
- Send the CrawlScope PATCH through `projects/store.updateProject` so the change is audited.

### 2.6 P2. CrawlScope: smaller gaps

1. **Runs of soft-deleted projects stay fully usable** (results, xlsx, pause, resume, PageSpeed). Fix in `db/repo.js` `getRunForViewer`: join `crawl_projects` and treat `lifecycle_status = 'deleted'` as not found.
2. **Run-level writes check membership but no capability** (`PATCH /runs/:id/findings`, pause/resume/stop, `POST /runs/:id/results/pagespeed`, `POST /projects/:id/run`). Fix: when the run has a `project_id`, call `requireProject(req, run.project_id, 'reviewFinding' | 'startRun')`. Record the caller, not `project.owner`, as the run's owner.
3. **The SSE error event sends raw error text** (`api/sse.js`). This belongs to the API-consistency plan; see section 3.
4. **`next_run_at` and `enabled` are stored unvalidated in PATCH.** Fix: ignore a client-supplied `next_run_at`, and coerce `enabled` to a boolean.

### 2.7 P2. Projects router

1. **`POST /:projectId/recommendations` passes the whole request body into `recommendations.create`.** `sourceRunId` can name another tenant's run (which reveals whether it exists), and `evidence` can be fabricated. Fix: accept only `title`, `body`, `priority` and `effort`. Check `sourceRunId` with `moduleEvidence.getRun(projectId, id)`, or drop it from this route.
2. **`verify-site` needs only `editProjectSettings`,** so any approver, or the contributor who created the project, can mark a site verified. It is the precondition for the robots override. Fix: gate it on `overrideRobotsPolicy`.

### 2.8 P2. Background work and workspace lifecycle

1. **Workspaces in `pending_deletion` can still create projects and start metered runs,** all of which the sweeper later destroys. Fix: in `requireWorkspace` and `requireProject`, refuse every capability except `view` and `restorePendingDeletion` when `workspaces.lifecycle_status <> 'active'`. Apply the same check in `loadActiveProject()` (`moduleExecutors.js`) and in `moduleScheduler.due()`.
2. **Deleting a project leaves its queued runs and schedules in place.** The executor now refuses them, but they still show as queued. Fix: in `modules/projects/store.js` `deleteProject`, cancel queued `project_module_runs` and disable `project_module_schedules` in the same transaction.
3. **The workspace purge can orphan crawl runs.** `workspaceLifecycle.js` deletes `crawl_runs` by `workspace_id` only. Fix: also run `delete from crawl_runs where project_id in (select id from crawl_projects where workspace_id = $1)` before deleting the projects.
4. **The server log mislabels revoked admins.** It prints "Bootstrap grant already present" for an address that was skipped because it was revoked (`server.js`, platform admin bootstrap block). Cosmetic: change the wording to "already has a grant record".

### 2.9 P2. Tokens

1. **Session and emailed-report tokens share one secret with no audience claim.** A report token placed in the session cookie passes `jwt.verify`. It is rejected today only because it carries no email.
   - **Fix:** sign sessions with `audience: 'session'` and report tokens with `audience: 'crawlscope.report'`. Pass `{ audience, algorithms: ['HS256'] }` to each `jwt.verify`.
   - **Effect:** every user is logged out once. To avoid that, accept tokens with no `aud` for seven days.
   - **Files:** `server/routes/auth.js`, `server/modules/crawlScope/run/report.js`.
2. **The emailed report link lasts 7 days and cannot be revoked.**
   - **Fix:** cut it to 24–72 hours and add a `runId` claim. On download, check that the run and its project still exist and are not deleted.
   - **Files:** `modules/crawlScope/worker/index.js` (`signedReportUrl(..., 7 * 24 * 3600)`), `run/report.js`, the download route in `server.js`. Also fix the email text, which says "expires shortly".

### 2.10 P3. AI Visibility

1. **Prompts can be added already approved, skipping the budget check.** `POST /prompts` with `status: 'approved'` goes straight into `store.addPrompts`. Fix: apply the `maxPromptsPerVisibilityRun` check there, as `transitionPrompt` does.
2. **Opening the Lite report can trigger up to 200 LLM calls** (`GET /:projectId/report` starts `startSentimentBackfill`), and its "already tried" set is in memory, so every restart bills again. Fix: store the tried marks in the database, or move the backfill into the run.

### 2.11 P3. Market potential summary cache

**Risk:** the cache key leaves out the `rows` the client sends, so a fake summary can be cached and shown to everyone who views that run.

**File:** `modules/marketPotential/routes.js` (summary route).

**Fix:** include a hash of `rows` in the key, or rebuild the rows on the server.

### 2.12 P3. Location page builder seed endpoints

**Risk:** `POST /seed`, `POST /seed-gentle-dental` and `POST /ls/seed/clear-behavioral-health` replace client reference data, and any user can call them. The replace is a delete followed by a non-transactional insert loop, so a failure partway leaves the client's data empty.

**Fix:** require platform admin, and wrap `replaceAllForClient` (`locationPageBuilder/store.js`) in a transaction.

### 2.13 P3. In-memory job and download ids

**Risk:** competitor analysis `progress/:jobId` and `export/:jobId`, and image alt `download/:token`, are not tied to the user who created them, and `jobStore` never expires entries.

**Check first:** the durable-jobs work (migration 0042, `services/jobs.js`) may already replace these. If not: store `req.user.userId` with each job, compare it on read, and add a TTL.

---

## 3. Owned by another plan, so do not duplicate

Covered by `docs/superpowers/plans/2026-10-01-api-consistency.md`. Check its status before touching these files.

| Item | Plan task |
|---|---|
| Raw database error text in responses: `routes/profile.js`, `modules/crawlScope/api/sse.js` error event, `routes/scrape.js` | Tasks 4, 5, 7 |
| Agent readiness `/discover-links` answers an empty 200 on failure | Task 5 |
| `scrape` route validates that URLs are strings and pass the address check (the scraper itself already refuses them; this adds a route-level 400) | Task 7 |

---

## 4. Needs your decision first

Each of these changes what users see or can do. Record the decision here before implementing.

### 4.1 Workspace walls for the older tools (largest item)

**Today:** competitor tracker, robots monitor (clients, domains, history), on-page audit, location page builder, market potential services and baskets, and the knowledge base are one shared global list. Any signed-in user can read, edit and delete everything in them. That is intended while every user is Position2 staff. It becomes a cross-client leak the day a client company's users are let in.

**Options:**
- A. **Scope by workspace, and assign all existing records to the Position2 workspace (recommended).** Staff see no change; a client workspace sees only its own records.
- B. Scope by project (migration `0038_client_lists_project_link.sql` added a nullable `project_id` that nothing reads). Every tool client would need linking to a project first, which is more disruption.
- C. Leave it shared, and never admit non-Position2 users.

**If A:**
1. Migration: add `workspace_id uuid references workspaces(id)` (nullable at first) to `competitor_analysis_clients`, `robots_monitor_clients`, `robots_monitor_runs`, `on_page_audits`, `lpb_clients` (and the `lpb_*` tables that hang off it), `market_potential_services`, `market_potential_baskets`, plus a KB ownership table or column.
2. Backfill every existing row to the Position2 workspace. Check counts before and after, dry-run first.
3. Make the column `NOT NULL`.
4. Code, one tool per change:
   - stamp `workspace_id` from `workspaceContext.resolveIdentity(req)` on create
   - filter every list with `workspace_id = any($accessible)`
   - check membership on every `:id` route
5. Test each tool: a user in a second workspace sees an empty list and gets a 404 for a Position2 id.

**Order:** one tool per deploy: migration, then backfill, then code.

### 4.2 Who may edit knowledge bases and module manifests

**Today:** any user can create, edit, toggle and delete them, and their content is injected into every AI-generated piece of content. Tool routes also accept any `client` or `kbId` from the request.

**Options:** approver and above (recommended: new staff join as approver, so almost nobody loses access), or platform admin only.

**Files:** `routes/kb.js`, `routes/modules.js`, `routes/kbContext.js`, `routes/audit.js`, `services/kbLoader.js`. Scoping knowledge bases by workspace is part of 4.1.

### 4.3 Robots monitor Slack settings and schedule

**Today:** one global webhook. Any user can point it at their own Slack and receive every client's daily report, or switch off the "noindex on production" alerts for everyone (`PUT /slack-config`).

**Options:** restrict to approver and above (recommended) or platform admin only; later, a webhook per workspace as part of 4.1.

**File:** `modules/robotsMonitor/routes.js`.

### 4.4 Ad-hoc CrawlScope crawls that ignore robots.txt

Linked to 2.4. For a project crawl, the project's admin override decides. For an ad-hoc crawl with no project, decide whether non-admins may untick "Respect robots.txt" at all.

**Recommendation:** no; admins only.

### 4.5 Removal from the Position2 workspace

**Today:** removal does not stick. `joinTeamWorkspace` in `services/identityStore.js` adds the person back on their next request, as **approver**. Removing a contributor therefore promotes them. The code comments call this intended.

**Options:**
- A. Make removal stick: skip auto-join for anyone with a `removed` event in `workspace_member_events`. Also decide where they land; their personal workspace is the natural choice.
- B. Keep auto-rejoin, but restore their previous role instead of approver.
- C. Leave as is. Revoke access through the sign-in allowlist instead.

### 4.6 CORS and CSRF

**Today:** `cors({ origin: true, credentials: true })` in `server.js` echoes back any origin, and there is no CSRF token. Under SameSite=Lax (the code default), any origin on the same site (e.g. another `*.position2.com` host) can make logged-in calls and read the responses. Under SameSite=None, any website can.

**Needs:** the production values of `COOKIE_SAME_SITE`, `COOKIE_DOMAIN` and the app's hostname (see section 5).

**Fix:** an explicit list of allowed origins (the production host, plus `http://localhost:3000` in development only), and reject any state-changing request whose `Origin` is not on it.

**Decision:** does anything else call the API from another origin, such as the old iframe embed?

### 4.7 Session revocation

**Today:** sessions are 7-day JWTs with no way to revoke them. Logout only clears the cookie.

**Fix:** add a `session_version` column on `app_users`, put it in the token, check it in `requireAuth` (cached), and bump it on logout.

**Decision:** a per-user version means logging out on one device logs you out everywhere. Acceptable?

### 4.8 Who can start a workspace deletion

**Today:** any workspace admin can start the 30-day purge of the whole Position2 workspace (`requestWorkspaceDeletion` is granted to admin and owner).

**Recommendation:** owner only, and blocked entirely for workspaces with `auto_join_domain` set.

**File:** `services/projectAccess.js` `CAPABILITIES`.

### 4.9 `requireSeo` cleanup

`requireSeo` checks `role === 'seo'`, but every session is created with that role, so it does nothing beyond `requireAuth`. Replacing it in `server.js` was **blocked by the Claude Code permission system** as weakening security. There is no behavioural difference either way.

**Options:**
- Skip it (fine).
- Allow the edit and swap `requireSeo` for `requireAuth` on the five mounts in `server.js`.
- Introduce real roles, if non-SEO staff are planned.

### 4.10 CrawlScope project crawls aimed at another site

**Today:** `POST /api/crawl-scope/runs` with a `projectId` crawls whatever `url` is in the body. A foreign site's pages then enter the project's page inventory, and its report may be emailed to the project's recipients.

**Decision:** should a project crawl be limited to the project's primary domain? Or also its subdomains and registered alternate domains (blog hosts, staging)? **Recommendation:** primary domain plus subdomains plus registered domains.

### 4.11 Per-user SEMrush cap (optional)

**Today:** the 200k units/day budget in `modules/marketPotential/usageStore.js` is shared. One person can use it up for everyone.

**Options:** a sub-cap per workspace or per user, or leave it as is.

---

## 5. Facts to confirm outside the code

These decide how urgent several items are.

1. **Do users outside Position2 exist in production?** Check `ALLOWED_GOOGLE_EMAILS` and the list of workspaces. If none exist, 4.1 is preparation, not an active leak.
2. **Production `COOKIE_SAME_SITE` and `COOKIE_DOMAIN`, and the app's hostname.** These decide whether 4.6 is Medium or Critical.
3. **Railway replica count.** The admin-status and membership caches are per process (60s and 30s), so a revocation reaches other replicas late.
4. **Whether `file://` navigation worked in the Railway Chromium build before the fix.** This sets how exposed secrets were. Consider rotating `JWT_SECRET` and the provider API keys if the scrape endpoint could have been used. Rotating `JWT_SECRET` logs everyone out.
5. **Whether `crawl_runs` ids appear anywhere a member of another workspace could see them** (links, logs, emails). This mattered for the `crawlRunId` hole, now fixed.
6. **Whether the production filesystem keeps knowledge-base writes across deploys.** This decides whether KB tampering lasts.
7. **How many standalone Content Architect analyses exist in production.** This sizes the backfill in 2.3.

---

## 6. Residual risk after all fixes

1. **DNS rebinding inside Chrome.** The browser does its own DNS, so a host that gives one answer when checked and another when Chrome connects is not caught in the headless browser. The axios path is safe, because its check runs at connect time. A full fix is a forward proxy for Chromium that applies the same address check.
2. **DNS rebinding in `contentArchitect/urlSafety.fetchSafe`.** It resolves, checks, then lets axios resolve again. Moving it onto `safeAxiosConfig()` (connect-time check) would close this.
3. **The approval role in the location page builder still comes from the request body.** It is required now, not defaulted to admin, but it is not derived from the signed-in user. A full fix needs the page-builder roles (seo, clinical, content, account owner) mapped onto app users. Decide this alongside 4.1.

---

## 7. Testing notes

- **Never point `TEST_DATABASE_URL` at production.** `platformAdminDb.test.js` revokes every active admin grant, and production has exactly one. The queue suites insert runs that the live worker claims and executes, spending provider budget. `services/__tests__/helpers/testDatabase.js` refuses when the two URLs match. Keep it that way.
- **Database suites run on PGlite** (`@electric-sql/pglite@0.3.15` with `@electric-sql/pglite-socket@0.0.20`), with every migration in `supabase/migrations` applied. Set `DATABASE_URL` to a dead port (e.g. `postgres://x@127.0.0.1:1/none`) so `.env` cannot supply the production URL, set `TEST_DATABASE_URL` to the PGlite server, and set `DATABASE_POOL_MAX=1`.
- **Run each database suite against a fresh PGlite server.** `budgetRetention.test.js` crashes the PGlite engine, and every database suite after it then fails with "Connection terminated". Those are false failures.
- **Expected failures today, not caused by this work:**
  - `budgetRetention`: PGlite engine crash.
  - `portedStores`, "ensureProject converges on one row": the owner comes from `(select id from app_users limit 1)`, which is null on an empty database. Fix the test to use `helpers/projectFixture.js`.
- **To check changed SQL against production safely,** use a read-only transaction (`set transaction read only`) with `EXPLAIN` and `SELECT` only. This was done for the admin and scheduler changes on 2026-10-04: the old revoke query fails on production's Postgres 17.9, and the new queries run.
- **Commands for the user's shell** (PowerShell 5) must chain with `;`, never `&&`.
