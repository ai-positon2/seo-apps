# API Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every `/api` router onto one standard for errors, status codes, validation, pagination, field naming and long-running work, without changing what any feature does.

**Architecture:** A small shared server kit (`server/utils/api/`) and one client request helper (`client/src/lib/apiRequest.js`) come first. Every router then adopts them module by module. Long-running tool work moves onto durable jobs stored in the existing `tool_runs` table plus a new `tool_run_events` table, followed through one generic `/api/runs/:id/events` stream. Old endpoints stay working beside the new ones until a later cleanup.

**Tech Stack:** Node 22, Express 4, zod 3.25 (already a server dependency), Postgres (`services/db`), React + Vite client, Node's built-in `node:test`/`assert`.

**Spec:** The API design audit delivered in conversation on 2026-10-01 (sections 2–4), plus the "will the fixes change features" follow-up. Excluded by the user: the route merges (Article Enhancement + Lite, Competitor Tracker + legacy Competitor Analysis, the three Location Page Builder engines, the six export routes).

## Status (2026-10-04): paused after the foundations

Paused by the user. Three other Claude sessions were editing this same working tree, and they were editing the routers that Parts B–D change. Resume once their work is committed.

**Done (uncommitted, tests passing):**
- **Task 1:** the API kit in `server/utils/api/` and the global handler in `server.js`.
- **Task 2:** client `apiRequest.js`, now used by all 14 `client/src/lib/*Api.js` files.
- **Task 3:**
  - Done in this session: the Robots Monitor run id, the LPB gate `role` check, the Market Potential scenario owner check, the project-create initial crawl (`crawlOptions`, `workspaceId`, `legacyUrl`), and the malformed project id now returning 404.
  - Fix 3 (the address checks) and the server side of fix 1 (Robots Monitor passwords) were already done by another session's data-isolation work, in `robotsMonitor/domainAuth.js`. This session added only the client payload and placeholder for fix 1.
- **Tasks 8–10:**
  - Migration `0042_tool_run_jobs.sql` (another session has since added `0043`).
  - `server/services/jobs.js`, plus `/api/runs/:id/events|result|cancel` in `routes/runs.js`.
  - The interrupted-job sweep in `server.js`, and `runStore.sweepStaleRuns` now skips jobs.
  - `client/src/lib/jobs.js`.

**Not started:** Tasks 4–7 (Part B), Tasks 11–13 (moving tools onto jobs) and Task 14. The detailed list of what is left, router by router, is in `2026-10-04-api-consistency-pending.md` in this folder.

**Migration 0042: applied on production on 2026-10-04.** It was applied on its own, with the runner's own transaction and checksum (`c4adf92228d9ac6a`). `0043_query_performance_indexes.sql` belongs to another session and is still pending; a plain `node scripts/migrate.js` would apply it.

**Testing note:** the PGlite socket server crashes on a client `ECONNRESET`. The scratchpad `serve.mjs` ignores `ECONNRESET`/`EPIPE`.

## Global Constraints

- Do not commit and do not push. Leave every change uncommitted in the working tree (user decision, 2026-10-01). A push to `unified-fast` redeploys production.
- Never `require()` `server/server.js`, `server/worker-module.js` or crawlScope worker entry points; syntax-check them with `node --check`. The local `.env` points at the production database.
- DB-backed tests run only against PGlite served by `@electric-sql/pglite-socket` with `DATABASE_URL` set to localhost before any require; never load the repo `.env`.
- Error bodies keep `error` as a human-readable string. `code` (snake_case) and `details` are added beside it.
- These exact client branches must keep working: `409 + duplicate_domain` (projectsApi), `503` → `unavailable` (runsApi), `403` admin denied (AdminPage), `404` (ContentArchitectProjectPage), `409` conflict (ContentWriterPage), `migration_needed` (AiVisibility, AiVisibilityLite, BrandsPanel), `run_cap_reached` (AiVisibilityLitePage), `not_configured`/`503` (HomePage).
- Every route path change updates `server/config/runTracking.js` in the same change, or run history silently stops recording.
- Lists that are unbounded today stay unbounded when no `limit` is passed.
- Request schemas use `.passthrough()`; a field the client sends that the schema does not list is kept, never stripped.
- Leave behaviour unchanged for: Location Page Builder gate approvals (except that a missing `role` is now a 400 instead of defaulting to `'admin'`), the workspace auto-join inside `GET /api/projects` and `GET /api/workspaces`, and the sentiment backfill started by AI Visibility Lite `GET /report`.
- Stored JSON payloads (crawl result `data`, page documents, report JSON) keep their internal casing; only database-column fields in API responses move to camelCase.
- Commands given to the user are PowerShell 5 (`;`, never `&&`).

## Review Focus

1. Saving a Robots Monitor domain without retyping its password keeps the stored password (Task 3 test).
2. Refreshing a tool page in the middle of a run reattaches to the same run and replays its progress; it never starts a second run (Task 10 test, Task 11 manual check).
3. A server restart mid-job turns the run into `failed` with code `interrupted` within about two minutes instead of spinning forever (Task 9 test).
4. A list endpoint called with no `limit` returns every row it returned before (Tasks 4–7: a test per router that had no limit).
5. The client branches listed in Global Constraints behave exactly as before (Task 2 test plus each module task's test).

---

## Part A — Foundations and safe fixes

### Task 1: Server API kit

**Files:**
- Create: `server/utils/api/errors.js`, `server/utils/api/asyncRoute.js`, `server/utils/api/validate.js`, `server/utils/api/page.js`, `server/utils/api/sse.js`, `server/utils/api/index.js`
- Modify: `server/server.js` (global error handler, ~line 309)
- Test: `server/utils/api/__tests__/api.test.js`; add it to `SUITES` in `server/scripts/testServer.js`

**Interfaces (produced):**
- `class ApiError(status, code, message, details?)`; factories `badRequest(message, details?)`, `notFound(message?)`, `forbidden(message?)`, `conflict(code, message, details?)`, `upstream(message?, details?)`, `notConfigured(message, code?)`
- `errorBody(err) → { status, body: { error, code, details? } }`; `sendError(res, err, context?)`
- `asyncRoute(fn)`: Express handler wrapper that forwards rejections to `next`
- `parseBody(schema, value)`: returns parsed data or throws `badRequest` with `details.issues`
- `isUuid(value)`, `uuidParam(label)`: an Express `router.param` handler that 404s on a non-UUID
- `assertPublicHttpUrl(raw) → URL`: http(s) only, public host, throws `badRequest`
- `parseBool(value) → true | false | undefined`
- `parsePage(query, { defaultLimit = 50, maxLimit = 200, unbounded = false }) → { limit: number | null, offset: number }`
- `pageMeta({ limit, offset, returned, total }) → { limit, offset, total, nextOffset }`
- `parseSort(value, allowedFields, fallback) → { field, direction }`
- `openSse(res, { heartbeatMs = 15000 }) → { send(event, data, id?), comment(text), close(), closed }`

Key rules in `errorBody`:
- 4xx: the message is passed through; `code` = `err.code` if it is a string, else a default per status (400 `invalid_request`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 429 `rate_limited`).
- 502/503: the message is passed through only for an `ApiError` (or `err.expose === true`); otherwise generic.
- Every other 5xx: `{ error: 'Internal server error.', code: 'internal' }`. Never `err.message`.

- [ ] Step 1: Write `api.test.js` covering: `errorBody` for ApiError 400/404/409/502, plain `Error` → 500 generic, an `Error` with `status: 413` and `expose`, an axios-like error (no status) → 500; `asyncRoute` forwards a rejection to `next`; `parseBody` on bad input throws 400 with `details.issues`; `parsePage` clamps `-5` → 1, `9999` → `maxLimit`, `'abc'` → default, and `unbounded` with no `limit` → `null`; `pageMeta` sets `nextOffset` only when a full page came back; `parseBool` on `'1'`, `'true'`, `'false'`, `'0'`, `undefined`, `'maybe'`; `assertPublicHttpUrl` rejects `ftp://x`, `http://127.0.0.1`, `http://169.254.169.254`, and accepts `https://example.com` (the DNS lookup is stubbed through `require.cache`).
- [ ] Step 2: Run `node utils/api/__tests__/api.test.js` from `server/`; expect a failure on the missing module.
- [ ] Step 3: Implement the six files.
- [ ] Step 4: Replace the body of the global error handler in `server.js` with `sendError(res, err, \`${req.method} ${req.originalUrl}\`)`, keeping the `headersSent` guard; `node --check server/server.js`.
- [ ] Step 5: Run the test; expect it to pass.

### Task 2: One client request helper

**Files:**
- Create: `client/src/lib/apiRequest.js`, `client/src/lib/__tests__/apiRequest.test.js`
- Modify: the local `req`/`request` helper in each of `aiVisibilityApi.js`, `aiVisibilityLiteApi.js`, `competitorTrackerApi.js`, `contentArchitectApi.js`, `contentWriterApi.js`, `crawlScopeApi.js`, `lpbApi.js`, `lsPagesApi.js`, `marketPotentialApi.js`, `projectsApi.js`, `robotsMonitorApi.js`, `runsApi.js`, `semrushApi.js`, `onPageAuditApi.js`

**Interfaces (produced):**
- `class ApiRequestError extends Error` with `status`, `code`, `details`, `body`, `unavailable` (true when status is 503)
- `requestJson(url, fetchOptions = {}) → Promise<any>`: fetch-compatible options; adds `credentials: 'include'` and a JSON `Content-Type` when `body` is a string; reads the text body once; parses JSON if present; on `!res.ok` throws `ApiRequestError(body?.error || \`Request failed (${status})\`)`
- `requestRaw(url, fetchOptions) → Response`: same error handling, returns the `Response` for downloads

- [ ] Step 1: Write a `node:test` test with a stubbed `globalThis.fetch`: a 409 `{error, code:'duplicate_domain', existingProjectId}` gives `status` 409, `code`, and `body.existingProjectId`; a 503 sets `unavailable`; an HTML 404 body gives `Request failed (404)`; a 204 resolves `null`; JSON is sent with the header.
- [ ] Step 2: Run `node --test src/lib/__tests__/apiRequest.test.js` from `client/`; expect a failure.
- [ ] Step 3: Implement it. Replace each file's helper body with a one-line call (`const req = (path, options) => requestJson(BASE + path, options)`), keeping every exported function's name and return value. Keep the module-specific fallback messages (`Export failed (…)`, `Download failed (…)`) by passing the message to `requestRaw`.
- [ ] Step 4: Run the client tests and `npm run build --prefix client`.

### Task 3: Safe bug fixes

**Files:**
- Modify: `server/modules/robotsMonitor/routes.js`, `server/modules/robotsMonitor/monitorStore.js`, `server/modules/robotsMonitor/monitorRunner.js`, `client/src/pages/RobotsMonitorPage.jsx`
- Modify: `server/routes/articleEnhancementLite.js`, `server/routes/agentReadinessAudit.js`
- Modify: `server/routes/locationPageBuilder.js` (`/pages/:id/gate`)
- Modify: `server/modules/marketPotential/routes.js`, `server/modules/marketPotential/store.js`
- Modify: `server/modules/projects/routes.js` (create, ~line 303), `server/modules/projects/crawlAutostart.js`
- Modify: `server/services/projectAccess.js` (~line 291)
- Tests: extend `modules/projects/__tests__/projects.test.js`; add `modules/robotsMonitor/__tests__/routes.test.js`, `modules/marketPotential/__tests__/scenarioOwner.test.js`; register them in `testServer.js`

Changes:
1. **Robots Monitor passwords:**
   - `GET /clients` returns `auth: { username, hasPassword: true }`, never the password.
   - `PATCH` keeps the stored password when `auth.password` is missing or empty.
   - `POST` still requires a password.
   - The form starts with an empty password field with placeholder "Leave blank to keep the current password", and the client check requires a password only when adding a new domain.
2. **Robots Monitor run id:**
   - `runMonitorCheck({ triggeredBy, runId })` accepts an id.
   - The route computes `formatRunId(new Date(), timezone)` before starting and returns `202 { ok: true, runId, run: { id: runId, status: 'running' } }`.
   - The 409 becomes `{ error: 'A run is already in progress.', code: 'run_in_progress' }`. Grep confirmed no client code reads `'RUN_IN_PROGRESS'`.
3. **Address checks:** Article Enhancement Lite `/init`, and Agent Readiness `/stream` and `/discover-links`, call `assertPublicHost(parsedUrl.hostname)` and return 400 `{ error }` on failure, the same as `articleEnhancement.js:50-54`.
4. **LPB gate:** a missing `role` returns 400 `role is required`. The server no longer defaults to `'admin'`. The client always sends a role, so current behaviour is unchanged.
5. **Market Potential scenarios:** `deleteScenario(id, owner)` runs `delete … where id = $1 and owner = $2` (use the owner column name already used by `listScenarios`). The route passes the same owner value the list uses.
6. **Project create crawl:**
   - Pass `crawlOptions: project.crawlOptions` at `projects/routes.js:303`.
   - In `crawlAutostart.js`, read `project.workspaceId ?? project.workspace_id`.
   - Test: when created with `crawlOptions: { maxUrls: 50 }` and an admin cap of 20, `scheduleInitialCrawl` receives options clamped to 20 and the workspace id.
7. **Malformed project id:** check `isUuid(projectId)` before the query in `projectAccess` and throw the existing not-found error (404 `not_found`).

- [ ] Write failing tests for 1, 2, 5, 6 and 7. Implement. Run each suite. Syntax-check the touched routers with `node --check`. Build the client.

---

## Part B — Module conformance

Applies the standard to every router. Each task lists its routers; for every one of them do all of the following.

**Errors**
- Replace each `res.status(500).json({ error: err.message })` or its equivalent with `next(err)` (through `asyncRoute`), or with `sendError`.
- Replace message sniffing (`err.message.includes('not found')`) with typed errors thrown in the store: `notFound()` or `conflict()`.
- A message that is useful to the user and currently reaches them through a 400 or 500 becomes a `badRequest` / `notFound` / `upstream` `ApiError` with the same text, so it still shows.

**Status codes**
- Creates return 201 with `{ <noun> }`.
- Starting async work returns 202.
- Deletes return 200 with `{ <noun> }` or `{ deleted: true, id }`.
- Validation is 400 (convert the three 422s).
- "Not ready / no data" conflicts keep 409 with a specific `code`.

**Validation**
- A zod schema with `.passthrough()` per body-taking route.
- `router.param` UUID checks on database-UUID params.
- `assertPublicHttpUrl` on every user-supplied fetch URL.
- Array caps set at least 5× above the client's own limit (state the client limit in a comment).

**Pagination**
- `parsePage` on every list.
- `unbounded: true` where the list has no limit today.
- Return `page: pageMeta(...)` beside the existing key.
- Fix negative limits.

**Field casing**
- Map database rows to camelCase in a `xView(row)` function in the store.
- Grep the client for every snake_case field the response used to return, and update each reader in the same task.

**Docs**
- Each router's header comment lists every route with its method, path and success shape.
- Delete the stale comments named in the audit.

Each task also adds a router test (Express app on an ephemeral port with stubbed stores, in the style of `middleware/__tests__/runTracking.test.js`). Each test covers: one validation 400 with `code`, one 404, one generic 500 that does not leak its message, a list with no `limit` returning all rows, and the module's client branch codes from Global Constraints.

### Task 4: Platform routers
`modules/projects/routes.js`, `routes/runs.js`, `routes/workspaces.js`, `routes/admin.js`, `routes/profile.js`, `routes/modules.js`, `routes/kb.js`, `routes/kbContext.js`, `routes/audit.js`, `routes/semrush.js`, `routes/auth.js`.

Specifics:
- `/api/runs` and module runs return camelCase run views (`runView` in `runStore.js` and `moduleEvidence.js`). Update `RunsPage.jsx`, `ModuleRuns.jsx` and the project module panels.
- Workspaces return camelCase (`isPersonal`). Update `WorkspacesPage.jsx` and its readers.
- kb and modules responses: camelCase keys for `module_id`, `linked_modules`, `total_kbs` and `knowledge_bases`. Update the KB editor pages.
- `PUT /api/modules/:id` and `POST /api/kb` validate their bodies.
- Workspaces `POST` returns 201; adding a member returns 201.
- Boolean query flags go through `parseBool` (accept `1` and `true`).
- Add the missing routes to the projects header comment.

### Task 5: Crawl and audit routers
`modules/crawlScope/api/routes.js` and `api/sse.js`, `modules/onPageAudit/routes.js`, `modules/robotsMonitor/routes.js`, `modules/competitorAnalysis/routes.js`, `routes/competitorAnalysis.js`, `routes/seoGeoAudit.js`, `routes/agentReadinessAudit.js`, `routes/imageAltAudit.js`.

Specifics:
- crawlScope responses: run and project rows go through camelCase views. Update every Crawl Scope page reader; keep `results[].data` untouched.
- `sse.js` error event: `{ error: 'The live stream failed.', code: 'internal' }`, not `error.message`.
- `/results` echoes the clamped limit.
- CT: store errors become typed (`notFound` for a missing client); `POST /clients` returns 201; `updateClient` takes only an allow-list of fields.
- CA: the 422s become 400s.
- Agent Readiness `/discover-links` returns a real error status instead of an empty 200 on failure.
- Image Alt: `urls` must be an array of strings, capped. Remove the stale "file store" comments.

### Task 6: AI and content routers
`modules/aiVisibility/routes.js`, `modules/aiVisibilityLite/routes.js`, `modules/contentArchitect/routes.js`, `modules/contentWriter/routes.js`, `modules/marketPotential/routes.js`.

Specifics:
- AIVL: run items use `id` everywhere (the page-load payload keeps `runId` as an alias).
- AIV `PATCH /prompts/:promptId` accepts `status` (the `POST …/status` route stays). Validate the PATCH fields and the `promptIds` array.
- MP: `reason` moves to `code`, and `details` carries the numbers. Keep `reason` as an alias. `per_run` stays 400 and `daily` stays 429.
- MP: `homeGeoIds` and `rows` must be arrays.
- CArch: `POST /projects` returns 201; `included` must be an array.
- CW: list and get return camelCase article views (the `document` JSON is unchanged). Update `ContentWriterPage.jsx`.

### Task 7: Older tool routers
`routes/articleEnhancement.js`, `articleEnhancementLite.js`, `articleRecommendation.js`, `keywordResearch.js`, `contentEnhancement.js`, `analyze.js`, `search.js`, `scrape.js`, `export.js`, `locationPageBuilder.js`, `lsPages.js`.

Specifics:
- Every SSE failure payload becomes `{ error, code }`. The event name stays `fail` until Part C moves the tool onto jobs.
- `scrape`: the URLs must be strings that pass the address check.
- LS `/brief` `competitorUrls`: capped, and checked with `assertPublicHttpUrl`.
- LPB: list endpoints return camelCase. Update the readers in `LocationPage*` pages.
- LPB: the `wrap` helper uses `sendError`. `wrapStep` regex sniffing becomes typed errors from `lsWizard`/`pageService`.
- LPB `POST /pages` and `POST /entities/:collection` return 201.
- LPB: `/entities/:collection` bodies are validated per collection.
- LPB: `/pages/:id/keywords/run` and `/content/run` return 404 for an unknown page before minting a token.

---

## Part C — Durable jobs

### Task 8: Migration `0042_tool_run_jobs.sql`

**Files:** Create `supabase/migrations/0042_tool_run_jobs.sql`

```sql
-- Durable jobs for tool runs. A job is a tool_runs row that does its work after
-- the response, writes ordered events a client can replay, and heartbeats so a
-- restart is detected. See server/services/jobs.js.
alter table tool_runs add column if not exists is_job              boolean not null default false;
alter table tool_runs add column if not exists progress            jsonb;
alter table tool_runs add column if not exists heartbeat_at        timestamptz;
alter table tool_runs add column if not exists cancel_requested_at timestamptz;

create table if not exists tool_run_events (
  id         bigserial primary key,
  run_id     uuid not null references tool_runs(id) on delete cascade,
  event      text not null,
  data       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_tool_run_events_run on tool_run_events (run_id, id);
create index if not exists idx_tool_runs_job_heartbeat on tool_runs (heartbeat_at) where is_job and status = 'running';
```

- [ ] Apply the full migration stack 0001–0042 in PGlite 0.3.15. Expect a clean apply.

### Task 9: Job service and run endpoints

**Files:**
- Create: `server/services/jobs.js`, `server/services/__tests__/jobs.test.js`
- Modify: `server/routes/runs.js` (add `GET /:id/events`, `GET /:id/result`, `POST /:id/cancel`; include `progress` in `GET /:id`); `server/server.js` (add `jobs.sweepInterrupted()` to the existing sweep interval)

**Interfaces (produced):**
- `startJob(req, { toolId, action = 'run', label, input, work }) → { id, status: 'running', toolId, action, label }`. `work({ emit, progress, signal, runId })` returns a result. The job:
  - records through `runStore.startRun`;
  - sets `is_job`;
  - appends events in order (`emit` is synchronous and queues the insert);
  - writes `progress` events and the `progress` column;
  - heartbeats every 15 s;
  - on success, emits `result` (when defined) and then `status { status: 'completed' }`;
  - on an error, emits `error { error, code }` and then `status { status: 'failed', code }`;
  - on cancel, emits `status { status: 'cancelled' }`;
  - closes out with `runStore.finishRun`.
  - Error text follows `errorBody` rules: only `ApiError` messages reach the client.
- `cancelJob(runId) → boolean`: aborts the in-process controller.
- `sweepInterrupted({ staleMs = 120000 })`: flips stale running jobs to `failed` with `error = 'interrupted'` and writes their terminal events.
- `GET /api/runs/:id/events`:
  - SSE with `retry: 3000`;
  - resumes after `Last-Event-ID` (or `?after=`);
  - polls every 500 ms;
  - sends each row with `id: <event id>`;
  - closes after a terminal `status` event;
  - same workspace access check as `GET /:id`.
- `GET /api/runs/:id/result` → `{ result }`, read from the last `result` event and falling back to `output`; 404 `no_result`.
- `POST /api/runs/:id/cancel` → 202 `{ run }`. Only the run's creator may cancel (403 otherwise). A run that is not active in this process and still `running` is marked `cancelled`.

- [ ] Tests against PGlite through the socket: event order and replay after an id; result and status events; a thrown `ApiError` vs a plain `Error` (generic text); cancel; the sweeper turns a stale job `failed`/`interrupted` with a terminal event; the events endpoint replays from `Last-Event-ID` and closes on the terminal status; a run in another workspace → 404.

### Task 10: Client job helpers

**Files:**
- Create: `client/src/lib/jobs.js`, `client/src/lib/__tests__/jobs.test.js`

**Interfaces (produced):**
- `startRun(url, body) → run`: a POST through `requestJson`, which reads `.run`
- `followRun(runId, handlers) → stop()`:
  - an `EventSource` on `/api/runs/${runId}/events` that registers a listener for each named handler;
  - `status` handlers run on every status event, and the stream closes on `completed`, `failed` or `cancelled`;
  - `error` handlers run only for events that carry data, since data-less errors are reconnects.
- `cancelRun(runId)`
- `getRunIdFromUrl()` and `setRunIdInUrl(id | null)`: read and write `?run=` with `history.replaceState`

- [ ] Test with a fake `EventSource` class: it dispatches named events, closes on terminal status, ignores data-less errors, and round-trips the URL parameter.

### Task 11: Move the token-stream tools onto jobs
Article Enhancement, Article Enhancement Lite, Keyword Research, Article Recommendation, Image Alt Audit (the `ready` event keeps the download token), and LPB keyword/content runs.

For each tool:
1. Move the stream handler's body into `runX(input, { emit, signal })`, replacing `isClosed` checks with `signal.aborted`.
2. The old `/stream/:token` route keeps working by calling `runX` with an emit that writes to the response and a signal aborted on close.
3. Add `POST /runs`: validate the input, check addresses, `startJob`, then `202 { run }`.
4. Do not add a runTracking matcher for `POST /runs`, because `startJob` records the run itself.
5. Mark user-facing throws as `ApiError`s.
6. Client page: replace the init → EventSource flow with `startRun` + `followRun`. Write `?run=` when a run starts. On load, resume from `?run=`. Rename handlers from `fail` to `error` and from `done` to terminal `status`. Add a Cancel button that calls `cancelRun`.

- [ ] Per tool: a server test that `POST /runs` returns 202 and the events end in `status completed` (with the pipeline stubbed). Manual check: run it, refresh mid-run, and confirm the same run resumes.

### Task 12: Move the POST-stream and synchronous tools onto jobs
SEO-GEO `/run`, Agent Readiness `/stream`, Content Writer brief/draft, Content Enhancement `/run`, legacy Competitor Analysis (`/run`, `/run-manual`; progress moves from the in-memory jobStore to events; `/export/:jobId` also accepts a run id). Same recipe as Task 11.

### Task 13: Move the in-memory pollers onto jobs
- **On-Page Audit:** `/run` gains `POST /runs`; `/status/:jobId` stays and reads from the job.
- **Competitor Tracker:** run, run-pagespeed and content-analysis gain `POST …/runs`, and the status endpoints read the latest job for that client.
- **Crawl Scope PageSpeed.**
- **AI Visibility `/extract`:** becomes a job.
- **Content Architect discover and analyze:** keep the token routes; add `POST …/runs`.
- **Robots Monitor:** keeps its own history table; `/run` returns the real id (done in Task 3) plus `GET /runs/current`.
- **AI Visibility Lite `POST /run`:** returns the run id from the queue.

---

## Part D — Naming and documentation

### Task 14: Route aliases and an OpenAPI spec
1. **Standard names, with the old paths kept as aliases.** Register both paths on the same handler and update the client and runTracking to the new path:

   | Old | New |
   |---|---|
   | OPA `GET /list` | `GET /audits` |
   | OPA `GET /result/:auditId` | `GET /audits/:auditId` |
   | OPA `DELETE /:auditId` | `DELETE /audits/:auditId` |
   | MP `/service/...` | `/services/...` |
   | AIVL `POST /:projectId/run` | `POST /:projectId/runs` |
   | RM `/history` | `/runs` |
   | RM `/history/:runId` | `/runs/:runId` |
   | RM `/run/status` | `/runs/current` |
   | CS `GET /runs/:id/report.xlsx` | `GET /runs/:id/export?format=xlsx` |
   | Projects `report.xlsx`, `report.md`, `report.pdf` | `GET /:projectId/report/export?format=` |

2. **OpenAPI:** create `docs/api/openapi.yaml` with every path and method, a summary, parameters, shared components (`Error`, `Page`, `Run`, `RunEvent`) and the standard error responses.
3. **Drift test:** create `server/scripts/__tests__/openapiRoutes.test.js`. It walks each router's `stack`, without requiring `server.js`, using the mount table copied from `server.js`, and asserts that every registered route is in the spec.

---

## Final verification
- `npm test --prefix server` (record the pre-existing `budget-clamp` failure, which is unrelated)
- `npm test --prefix client`
- `npm run build --prefix client`
- `node --check` on `server.js`, `worker-module.js` and every touched router
- A PGlite run of the DB suites that cover `tool_runs` and the jobs
- **Before any deploy:** migration 0042 must be applied on prod (the user's step: `node scripts/migrate.js --dry-run`, then without `--dry-run`, from `server/`)
- **A later cleanup, not part of this plan:** remove the deprecated `/init` + `/stream/:token` and old-path aliases one deploy after this ships
