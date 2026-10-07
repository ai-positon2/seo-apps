# API consistency — remaining work

**Status on 2026-10-04:** the foundations are built and tested, and the module-by-module work has not started. Everything below is still to do.

**Companion files:**
- The full plan and the standard it implements: `docs/superpowers/plans/2026-10-01-api-consistency.md`. Read its "Global Constraints" before touching anything.
- This file lists only what is left, with the specific problems found in each router during the audit of 2026-10-01.

**Line numbers are from that audit.** Other sessions have edited these files since, so re-find each spot before changing it.

---

## 1. Before you start

1. **Wait until the other sessions have committed.** On 2026-10-04 three other Claude sessions were editing these same routers in this working tree, and the work was paused for that reason. Run `ListAgents` and `git status`. Don't start until the other sessions' changes are committed and the remaining diff is only this work.
2. **Commit what is already built, on its own, first.** Ask the user before committing; they asked for everything to stay uncommitted. It is done and passing tests:

   | Area | Files |
   |---|---|
   | Server API kit | `server/utils/api/` (errors, asyncRoute, validate, page, sse, index) and its test |
   | Global error handler | `server/server.js`: the error handler, the `unknown_endpoint` code, and the job sweep wiring |
   | Durable jobs | `server/services/jobs.js` and its test; `server/routes/runs.js` (`/:id/events`, `/:id/result`, `/:id/cancel`, UUID param check); the `not is_job` filter in `server/services/runStore.js` |
   | Migration | `supabase/migrations/0042_tool_run_jobs.sql`, **already applied on production** |
   | Client | `client/src/lib/apiRequest.js` and `jobs.js` with their tests; the 14 `client/src/lib/*Api.js` files rewired onto `apiRequest` |
   | Task 3 bug fixes | Robots Monitor run id; LPB gate `role` required; Market Potential scenario owner check; project-create initial crawl (`crawlOptions`, `workspaceId`, `legacyUrl`); malformed project id now 404 |
   | New test suites | Registered in `server/scripts/testServer.js` |

3. **Database rules:**
   - The local `.env` points at the **production** database.
   - Never `require()` `server.js`, `worker-module.js` or the crawl worker; check them with `node --check` only.
   - For any test that touches the database, use PGlite. Install `@electric-sql/pglite@0.3.15` and `@electric-sql/pglite-socket@0.0.20` (with `--legacy-peer-deps`) into a scratch folder.
   - Write a small script that applies every file in `supabase/migrations` in order, then serves the database on a local port.
   - Make that script ignore `ECONNRESET` and `EPIPE`. Otherwise the server crashes whenever a test process exits.
   - Run with `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres DATABASE_POOL_MAX=1`.
4. **Migrations:** don't run a plain `node scripts/migrate.js` on production. It applies every pending migration, and `0043_query_performance_indexes.sql` belongs to another session and is waiting on the user's decision. To apply a single migration, use the runner's own transaction and checksum (sha256, first 16 hex characters, plus a `schema_migrations` row), the way 0042 was applied.
5. **Deploying:** pushing to `unified-fast` redeploys production and kills any crawl in progress. Warn the user before any push.

---

## 2. The rules every task follows

These are summarised from the plan's Global Constraints, and they are binding.

| Rule | Meaning |
|---|---|
| Error body | `{ error: "<readable sentence>", code: "<snake_case>", details?: {...} }`. `error` is always a string, because every client helper shows it. |
| Codes the client depends on | Keep exactly: `409` + `duplicate_domain`, `503` / `not_configured`, `403` (admin page), `404` (Content Architect project page), `409` (Content Writer conflict), `migration_needed`, `run_cap_reached`. |
| 5xx | Generic message only. Throw `ApiError` (`badRequest`, `notFound`, `conflict`, `upstream`, `notConfigured`) for anything the user should read. |
| Status codes | Create returns 201 `{ <noun> }`. Starting async work returns 202. Delete returns 200 `{ <noun> }` or `{ deleted: true, id }`, **not 204**, because the client helpers parse JSON. Validation errors are 400; retire the three 422s. |
| Validation | zod with `.passthrough()`, so fields the schema doesn't list are kept, never stripped. `uuidParam` on database-UUID params. `assertPublicHttpUrl` on every URL the server will fetch. Array caps at least 5× the client's own limit. |
| Lists | `parsePage(req.query, { unbounded: true })` for lists that have no limit today, so calling one without `limit` still returns every row. Add `page: pageMeta(...)` beside the existing key, which stays as `{ projects }`, `{ runs }` and so on. |
| Field casing | Database-column fields in responses become camelCase, mapped in the store (`xView(row)`). Stored JSON payloads keep their own casing. Every client reader of a renamed field changes **in the same change**. |
| Run history | `server/config/runTracking.js` matches **exact paths**. Any route path change updates it in the same change, or run history silently stops. Don't add a matcher for a new `POST …/runs`: `jobs.startJob` records the run itself. |
| Behaviour to leave alone | LPB gate approvals (who can approve); the workspace auto-join inside `GET /api/projects` and `GET /api/workspaces`; the AI Visibility Lite `GET /report` sentiment backfill. |
| Excluded (product decisions) | Merging Article Enhancement with Lite; Competitor Tracker with legacy Competitor Analysis; the three Location Page Builder engines; the six export routes. |
| Edits | Targeted edits only, never a whole-file write over an existing file; another session may have changed it. |

**Each module task also adds a router test.** Follow the style of `server/middleware/__tests__/runTracking.test.js`: Node `assert`, a real Express app on an ephemeral port, and stores stubbed through `require.cache`. Register it in `server/scripts/testServer.js`. At minimum it covers:
- one 400 with `code`;
- one 404;
- one 500 that does not leak its message;
- a list called with no `limit` returning every row;
- the module's client-dependent codes.

---

## 3. Part B — make every router follow the standard

### Task 4: Platform routers

**Files:** `server/modules/projects/routes.js`, `server/routes/runs.js`, `workspaces.js`, `admin.js`, `profile.js`, `modules.js`, `kb.js`, `kbContext.js`, `audit.js`, `semrush.js`, `auth.js`

**Errors**
- `err.message` is returned in 500s at `profile.js:16, 38`, `modules.js:11, 31`, `kb.js:11, 22`, `kbContext.js:88`, `audit.js:92`, and the 502 at `semrush.js:19`. Route all of them through `sendError`.
- `kb.js:34, 44, 54, 64` pick 404 or 409 by searching the message for `'not found'` or `'already exists'`. Make `services/kbStore.js` throw `notFound()` / `conflict()` instead.
- `modules.js:20-21` turns every error into a 404; only a genuinely missing module should be a 404.
- `workspaces.js:207-211, 219-223` copy the `handleError` logic inline; call the helper instead.
- A session with no userId is handled five different ways (403 in projectAccess, 400 in workspaces and profile, 404 in runs, an empty 200 in projects, runs and profile). Pick one: **401** `unauthenticated`. That is safe because `requireAuth` already guarantees a user.
- `projects/routes.js:742` and `:748` are sibling 409s, but only the first has a `code`; add one to the second.
- The projects 503 body includes `projects: []` on every route (`:104-108`). Keep it on the list route only.

**Casing**
- `/api/runs` list and get return raw rows (`tool_id`, `created_at`, `duration_ms`, `input_truncated`, and the 0042 columns `is_job`, `heartbeat_at`, `cancel_requested_at`). Add `runView` in `runStore.js`, and update `client/src/pages/RunsPage.jsx`, `components/ModuleRuns.jsx` and every other reader.
- Project module runs (`moduleEvidence.listRuns` / `getRun`, `select *` at `:467` and `:483`) also return raw rows. Map them to camelCase and update the project module panels. Page runs (`projects/routes.js:1463-1478`) are already camelCase; match them.
- Workspaces list spreads raw rows (`is_personal`, `workspaces.js:48-56`) and the member response is raw (`:137`). Map both and update `WorkspacesPage.jsx`.
- kb, modules and audit return `knowledge_bases`, `module_id`, `linked_modules`, `summary.total_kbs`. Map them and update the KB editor pages. `GET /api/kb/:id` and `GET /api/modules/:id` return unwrapped objects; wrap them as `{ knowledgeBase }` / `{ module }` and update the callers.

**Validation**
- `PUT /api/modules/:id` (`modules.js:28`) and `POST /api/kb` (`kb.js:41`) write the raw body; add schemas.
- `POST /recommendations` spreads the whole body (`projects/routes.js:1542`). `PATCH /:projectId`, `PATCH /pages/:pageId` and `PATCH /recommendations/:id` pass the body straight through. Add passthrough schemas with type checks.
- The workspace `name` (`workspaces.js:70`) and the profile `fullName` (`profile.js:26`) call `.trim()` without a type check, so a non-string is a 500. Return a 400 instead.
- `POST /:projectId/audit` silently drops unknown module names (`:1298-1300`). Return a 400 that lists them.
- `/modules/:moduleKey/detail` and `/runs` don't check `moduleKey`. Return a 404 for an unknown key.
- `/api/runs` passes the `status`, `action` and `toolId` filters through unchecked. Allow-list `status`.
- UUID checks (`uuidParam`): `:projectId`, `:pageId`, `:domainId`, `:runId`, `:pageRunId`, recommendations `:id`, workspaces `:id` and `:userId`, admin `:grantId`.

**Pagination**
- Module runs (`moduleEvidence.js:471`) and recommendations (`recommendations.js:140`) let a negative `limit` reach SQL; use `parsePage`.
- Projects (1–500), audit events, member events and policies: add `page` metadata.
- `GET /:projectId/pages` returns every page; keep that (`unbounded`) and add optional `limit`/`offset` with `page`.
- Flags: `includeDeleted=1`, `mine=1`, `includeRevoked=1` and `refresh=1` vs `retired=true` and `excluded=false`. Read them all with `parseBool`, which accepts both forms.

**Status codes:** `POST /api/workspaces` (`:78`) and add-member (`:138`) return 200; make them 201.

**Docs:** the projects header list (`:1-36`) is missing purge, content-architect, domains/primary, approve/reject, discover, crawl-status, `modules/:moduleKey/pages`, audit-events, report.md and report.pdf. Add them. `/api/audit` is a KB/module health check unrelated to project audits; say so in its header.

### Task 5: Crawl and audit routers

**Files:** `server/modules/crawlScope/api/routes.js` and `api/sse.js`, `server/modules/onPageAudit/routes.js`, `server/modules/robotsMonitor/routes.js`, `server/modules/competitorAnalysis/routes.js` (Competitor Tracker), `server/routes/competitorAnalysis.js` (legacy), `seoGeoAudit.js`, `agentReadinessAudit.js`, `imageAltAudit.js`

**Crawl Scope**
- **Casing:** run and project rows are raw snake_case (`report_path`, `finished_at`, `heartbeat_at`, `site_diagnostics`, `control_request`). Add views, and update every Crawl Scope page (`CrawlScopeRunPage.jsx` and the others).
- **Leave `results[].data` alone;** it is crawler output, not database columns.
- **One naming in the stream:** `sse.js:101-114` already renames some fields; once the views exist, use them there so a run is named the same way everywhere.
- **Stream errors:** the stream sends `String(error.message)` on failure (`sse.js:121`). Send `{ error: 'The live stream failed.', code: 'stream_failed' }` instead.
- `/results` echoes the requested `limit` instead of the clamped one (`:239-247`); echo the clamped one.
- A negative `limit` gets through on `/runs` and `/results` (`:219`, `:240`); use `parsePage`.
- `PATCH /projects/:id` takes snake_case `next_run_at` (`:825`); accept `nextRunAt` too.
- A `ValidationError` has no `code`; give it `invalid_request`.
- Stale comments: `sse.js:3` and `:24` ("Supabase", `run_results`), `:869` ("Deliberately still creator-scoped"), and `:568-572`, which repeats itself.

**On-Page Audit**
- `url` is only checked for presence (`:27`). Add `assertPublicHttpUrl`.
- `/list` is fixed at 50 with no parameters; add `parsePage` (default 50).
- The header comment (`:11-12`) still says it uses a file store.

**Robots Monitor**
- `err.message` is in every 500 (`:43, 53, 63, 72, 98, 126, 150, 188, 198, 235, 245`).
- 404 is chosen by searching the message for `'not found'`.
- `name.trim()` runs with no type check (`:49, 59`).
- `/history` has no cap (`:231`).
- `GET /clients` returns a bare array (`:41`); wrap it as `{ clients }` and update the client.
- Success bodies vary (`{ ok, … }`); make them consistent.
- Already done (2026-10-04): the run id fix and password redaction.

**Competitor Tracker**
- Every store error is a 400, including "Client not found" (`:71, 78, 93, 100`, `:282-327`). Make the store throw `notFound()` and `badRequest()`.
- `POST /clients` returns 200 (`:70`); make it 201.
- `updateClient` merges arbitrary keys into jsonb (`competitorAnalysis/store.js:72-78`); allow-list them.
- `err.message` leaks at `:124` and `:355`.
- `/discover-competitors` returns a bare result (`:122`).
- Status polls use epoch-millisecond numbers (`:153`) where the rest of the app uses ISO strings.
- Stale comments: `:10-12` (file store), `:159-160` ("mock provider is instant"), and `:286-288` (orphaned).

**Legacy Competitor Analysis**
- 422 at `:54` and `:276`; make them 400.
- `targetUrl` is never parsed; `maxCompetitors` is uncapped (`:40`); the `competitors` array is not validated (`:102`, `:241`).
- `err.message` leaks at `:95` and `:199`.
- `/run` has no duplicate-run guard (`:101-125`).

**SEO-GEO**
- `fetchUrl` follows 5 redirects without checking each hop (`:358-360`); fetch through `services/safeEgress.js` (`safeGet`).
- `...body` is spread into the runner, so a caller can set `skipAi` (`:697`); pass named fields only.
- Its own 502 and 422 statuses (`:438`, `:449`) never reach the browser.
- Two header comments for one route (`:377`, `:659`).

**Agent Readiness**
- `/discover-links` turns a failure into a 200 with empty lists (`:607-609`); return a real error status.
- `err.message` leaks at `:777` and `:964`.
- `POST /stream` copies the scoring logic of `POST /` (`:693-765` vs `:848-918`). Have both call `runAgentReadiness`. That is a refactor, not a merge, and it removes the drift that already left `/stream` without `skipBrief`.

**Image Alt Audit**
- `urls` has no length cap.
- `u.trim()` throws on a non-string (`:753`).
- `config` spreads arbitrary keys (`:788`).
- axios follows 5 redirects unchecked (`:448`); use `safeEgress`.

### Task 6: AI and content routers

**Files:** `server/modules/aiVisibility/routes.js`, `aiVisibilityLite/routes.js`, `contentArchitect/routes.js`, `contentWriter/routes.js`, `marketPotential/routes.js`

**AI Visibility**
- **Run shape:** the embedded copy of a generation run in `GET /prompts` (`{ runId, … }`, `:122-128`) differs from `GET /prompts/generation` (`{ run: { id, … } }`, `:404-421`). Use `{ run: { id, … } }` in both, and keep `runId` as an alias until the client is moved.
- **Coverage:** returns both `limit` and the back-compat `quota` (`:77-78`). Keep both for now and note when `quota` can go.
- **Status changes:** add `status` to `PATCH /prompts/:promptId` (`:467-476`). Keep `POST …/status` (`:483`) as an alias.
- **PATCH validation:** add type and length checks for `text`, `intent`, `slot` and `rationale`.
- **Unchecked input:**
  - The `prompts` array is unbounded, and `source` / `demandVolume` pass through unchecked (`:431-452`).
  - `promptIds` is unbounded and not type-checked (`:509`).
  - Brand `status` is unchecked (`:715`).
  - `from` / `to` are free strings (`:594-595`).
- **IDs:** UUID checks on `:promptId`, `:brandId`, `:captureId` (and `:projectId`, if it isn't already checked by projectAccess).
- **Docs:** the header (`:3-13`) lists 11 routes, uses `:id` where the code uses `:promptId`, and omits topics, reports, captures, brands and extract.
- **Generic message:** "Something went wrong reading AI visibility." is used for writes too (`:56`); reword it so it fits both.

**AI Visibility Lite**
- Run items use `runId` on the page-load payload (`:91-99`) but `id` in `/runs` (`:328-336`). Use `id` and keep `runId` as an alias.
- The page-load run exposes the raw `payload`; check whether the client needs it.
- The `prompts` body is not checked to be an array (`:253`).
- `runs?limit` allows negatives (`:319`); use `parsePage`.
- `includeRetired=true` (`:240`) is called `retired` in AI Visibility. Accept both.
- Leave `GET /report` starting the sentiment backfill (`:413`) as it is.

**Content Architect**
- `POST /projects` returns 200 (`:96`); make it 201.
- `GET /projects` returns a bare array (`:84`) and authorizes each project in turn. Wrap it as `{ projects }` and update `contentArchitectApi.js` and its callers.
- `included` is not checked to be an array (`:258`), so a wrong type is a 500.
- `vertical`, `intent` and `selection` are unchecked (`:254`, `:551`).
- `err.message` leaks at `:317`, `:532`, `:612` and in the stream `fail` events (`:239`, `:404`).
- `router.param('id')` skips authorization when the project doesn't exist (`:51-56`). The handlers then 404, so this is harmless, but make the param itself 404.
- A failed analysis leaves `workflowState` at `'analyzing'` (`:370`, `:402`); set it back on failure.
- The "provisional endpoint name" comment on `draft-clusters` (`:284-285`) should be resolved or removed.
- The `/projects/:id` id is a Content Architect id, while `/api/content-writer/projects/:projectId` is a platform project id. Rename the router param to `:caProjectId` (internal only; the URL doesn't change).

**Content Writer**
- List, get, create and PUT return raw snake_case rows (`project_id`, `updated_at`, `has_draft`; store.js `:5-7`; routes `:50, 56, 69`). Map them to camelCase (the `document` JSON is unchanged) and update `ContentWriterPage.jsx`.
- `generate` compares `req.body.revision` without parsing it (`:78`).
- Export accepts a client-supplied `document` with only view access (`:12-14`). This is intended, since export is read-only, but add a comment saying so.

**Market Potential**
- Errors carry `reason` instead of `code` (`too_many_regions` `:212`, `per_run` `:278-281`, `daily` `:283-286`). Add `code` with the same value, put the numbers in `details`, and keep `reason`. `per_run` stays 400 and `daily` stays 429.
- `freeze` turns every error, including database errors, into a 400 with `err.message` (`:166-168`).
- `err.message` leaks at `:127, 140, 155, 190, 361, 397, 418`.
- `homeGeoIds` is not checked to be an array (`:175`, `:201`), so a string is a 500.
- `rows` (`:373`) and `terms` (`:150`) are unbounded, and scenario fields are unchecked (`:411`).
- `/geo/*` and `/adjacency` aren't wrapped with `asyncRoute`.
- `POST /scenarios` returns 200; make it 201.
- Comments name single providers ("One DataForSEO call" `:195`, "OpenAI" `:368`) where the code now switches between providers.
- Already done: the scenario delete owner check.

### Task 7: Older tool routers

**Files:** `server/routes/articleEnhancement.js`, `articleEnhancementLite.js`, `articleRecommendation.js`, `keywordResearch.js`, `contentEnhancement.js`, `analyze.js`, `search.js`, `scrape.js`, `export.js`, `locationPageBuilder.js`, `lsPages.js`

**Errors**
- `err.message` is returned in 500s at `analyze:35`, `scrape:31`, `export:178`, `AE:1961`, `AEL:888` and `CE:1075`, in every LPB catch (`:34, 56, 61, 162, 185, 300, 314, 326, 358, 372, 418, 426, 448, 539`), and by LS `wrap` and `wrapStep` (`:46`, `:57`).
- Stream `fail` payloads become `{ error, code }`. The event name stays `fail` until the tool moves onto jobs in Task 11.
- `analyze` answers a missing key with 401 + `err.message` (`:28`); make it 503 `not_configured`.
- KR `/init` answers a missing SEMrush key with 500 (`:124`); make it 503 `not_configured`.
- Content Enhancement: 422 for short fetched content but 400 for a short paste (`:1017`, `:1023`); make both 400 with the same `code`. A malformed `url` in html mode is a 500 (`:1021`); make it 400.

**Location Page Builder**
- The `wrap` helper always answers 500; use `sendError`.
- The catch-alls on `/pages/:id/keywords`, `section`, `content`, `qa`, `regen-field`, `gate`, `comments`, `wizard/regenerate`, `PUT wizard/pages/:id` and `wizard/qc` answer 400 for every failure, including LLM and store errors (`:245-286, 339, 386, 465, 486`). Make the service throw typed errors and let anything else be a 500.
- `keyword-candidates` and `wizard/generate` send everything outside their explicit checks to 500.
- A missing page on export or preview is a 400 (`:492`, `:545`); make it 404. `/pages/:id` with the wrong page type is a 400 (`:138`); make it 404.
- Creates return 200 (`POST /pages`, `POST /entities/:collection`); make them 201.
- **Casing:** `/clients/:id`, `/entities` and `/pages/:id` return raw store rows (`:77, 88, 145`). The lists are snake_case (`client_name`, `primary_keywords`, `qa_blocking`, `url_path`, `qc_verdict`, `updated_at`; `:122-131`, `:407-415`, LS `:208-219`). The generate result mixes styles (`{ qa_result, status }`, `:232`). Map them all and update `LocationPage*` pages, `lpbApi.js` and `lsPagesApi.js` callers.
- Query strings read only `client_id` on `/entities` and `/pages` (`:84`, `:114`); accept `clientId` too, as the wizard and LS routes do.
- `/entities/:collection` POST and PUT pass `req.body` straight to the store. The collection is allow-listed; add a schema per collection.
- `/pages/:id/comments` and `PUT /pages/:id/content` pass the raw body (`:284`, `:260`).
- `/pages/:id/keywords/run` and `/content/run` mint tokens without checking the page exists (`:189-194`); return a 404 first.
- `wizard/qc/check` and `ls/qc/check` save the client's `checks` array when `pageId` is present (`:477-482`; LS `:265-271`). Validate its shape.
- `preview/:format` returns JSON for any value other than `markdown` (`:546-554`); return a 400 for unknown formats, as export already does (`:539`).
- `POST wizard/keywords` and `ls/keywords` treat a missing `approved` as `true` (`:355`; LS `:119`). Keep the behaviour, but write it down in the header comment.
- **Location Pages (`/ls`):** `wrapStep` picks 400 or 500 by matching the message against `/required|before|must reference|not found|Approve the content brief/i` (`:53-57`). Make `lsWizard` and `pageService` throw typed errors. "not found" should become a 404.
- **Lists:** LPB and LS lists are unbounded bare arrays (`:64, 84, 132, 417`; LS `:206`). Wrap them as `{ <plural> }` with `page`, keeping them unbounded by default.
- **Stale comments:** `:2` ("File-store backed") and `:279` ("app auth is currently a stub").

**Validation**
- `scrape`: URLs are capped at 10 but neither type- nor host-checked (`:12`).
- `analyze`: `scrapedPages` is only checked with `Array.isArray` (`:13`).
- `export.js`: only checks that `analysis.sections` is truthy (`:41`).
- LS `/brief` `competitorUrls`: unbounded, and scraped without a host check (LS `:149`; `lsWizard.js:59-67`). Cap it and add `assertPublicHttpUrl`.
- Text fields bounded only by the 20 MB body limit (CE `html`, AE/AEL `manualContent`, KR/AR keywords): add sensible caps, at least 5× the largest real input.

**Docs:** add a route list to each header. The AEL header (`:1-3`) has the two tool names swapped.

---

## 4. Part C — move long-running work onto durable jobs

The job service and endpoints are built. Every tool moves onto them with the same recipe.

**Server side**
1. Move the work out of the stream handler into `runX(input, { emit, signal })`. Replace the handler's `isClosed` checks with `signal.aborted`.
2. Keep the old route, for example `GET /stream/:token`, working unchanged by calling `runX` with an `emit` that writes to the response and a signal that aborts when the connection closes. Old tabs keep working across the deploy.
3. Add `POST …/runs`:

   ```js
   router.post('/runs', asyncRoute(async (req, res) => {
     const input = parseBody(schema, req.body);
     await assertPublicHttpUrl(input.url);                 // when it fetches a URL
     const run = await jobs.startJob(req, {
       toolId: '<tool-id as in config/runTracking.js>',
       action: 'run',
       label: input.url,                                    // what runTracking's deriveLabel would use
       input,
       work: ({ emit, progress, signal }) => runX(input, { emit, progress, signal }),
     });
     res.status(202).location(`/api/runs/${run.id}`).json({ run });
   }));
   ```

4. Turn the messages users should see into `ApiError`s (`badRequest`, `upstream`). Any other thrown error reaches the user as "The run failed. Try again…".
5. Don't call `emit('status')` or `emit('error')`; the framework writes those. Throw to fail.
6. Don't add a run-tracking matcher for `POST …/runs`.

**Client side**
1. Replace the init-then-stream flow with `startRun(url, body)` followed by `followRun(run.id, handlers)` from `client/src/lib/jobs.js`.
2. Write `?run=<id>` with `setRunIdInUrl` when the run starts. On page load, read `getRunIdFromUrl()` and call `followRun` to resume. The events replay from the start, so build the page's state from events only.
3. Rename the handlers: `fail` becomes `error`, and `done` becomes `status` with `completed`, `failed` or `cancelled`.
4. Add a Cancel button that calls `cancelRun(id)`.

**Tests for each tool**
- A server test with the pipeline stubbed: `POST /runs` returns 202, and the run's events end in `status: completed`. A user-facing failure ends in `error` + `status: failed` with the right `code`.
- A manual check in the browser: start a run, refresh halfway through, and confirm the same run resumes with its earlier progress, without starting a second run.

### Task 11: Token-stream tools

| Tool | Server file | Client page | Notes |
|---|---|---|---|
| Article Enhancement | `routes/articleEnhancement.js` | `ArticleEnhancementPage.jsx` | Results go out as separate events (`recommendations`, `coverage`, `enhanced`) with no combined final event. Have `runX` also return a combined result. Keep the `origin.caProjectId` save and its `saved` event. Token TTL is 120 s. |
| Article Enhancement Lite | `routes/articleEnhancementLite.js` | `ArticleEnhancementLitePage.jsx` | Reuses AE's helpers. The address check is already done. |
| Keyword Research | `routes/keywordResearch.js` | `KeywordResearchPublicPage.jsx`, `lib/useKeywordResearch.js` | Events: `seed`, `variants`, `urls`, `url_status`, `url_keywords`, `result`. A missing SEMrush key becomes a 503 before the run starts. |
| Article Recommendation | `routes/articleRecommendation.js`, `services/articleBrief.js` | `ArticleRecommendationPage.jsx` | Events: `urls`, `scrape_progress`, `warning`, `result`. Token TTL is 300 s. |
| Image Alt Audit | `routes/imageAltAudit.js` | `ImageAltAuditPage.jsx` | Today a reconnect gets a 404 (`:805`). Keep the `ready { downloadToken, filename }` event and `GET /download/:token` (30-minute TTL). Stream errors are called `fail`. |
| LPB keyword and content runs | `routes/locationPageBuilder.js` (`/pages/:id/keywords/run`, `/content/run`, `/stream/:token`) | `LocationPageDetailPage.jsx` | The only stream with a heartbeat; `startJob` already has one. Check the page exists before starting. The generate result returns only `{ qa_result, status }`, so the client re-fetches the page; keep that. |

### Task 12: Tools that stream from a POST, or run synchronously

| Tool | Today | Notes |
|---|---|---|
| SEO-GEO (`routes/seoGeoAudit.js`, `hooks/useSeoGeoAudit.js`) | `POST /run` is itself the stream. Events: `step`, `result`, `error`. No heartbeat. | `EventSource` can't do a POST; jobs fix that. |
| Agent Readiness (`routes/agentReadinessAudit.js`, `AgentReadinessAuditPage.jsx`) | `POST /stream` (stream) and synchronous `POST /`. Events: `check`, `score`, `complete`, `error`. | Move `/stream` onto jobs. Keep `POST /` (synchronous), since other code may call it. Do the shared-scoring refactor from Task 5 first. |
| Content Writer brief/draft (`modules/contentWriter/routes.js:119-120`, `writer.js`, `ContentWriterPage.jsx`, `contentWriterApi.js` `generate`) | POST streams `step`, `urls`, `scrape_progress`, `warning`, `result` (the saved row), `done`; failures arrive as `fail { message, code, issues }`. A revision check returns 409. | Keep the 409 revision conflict before the run starts (`ContentWriterPage.jsx:127` depends on it). |
| Content Enhancement (`routes/contentEnhancement.js` `/run`, `ContentEnhancementPage.jsx`) | Synchronous: fetch, Google search, scrape and LLM in one request. | Return the same combined result object as the run's result. |
| Legacy Competitor Analysis (`routes/competitorAnalysis.js`, `CompetitorAnalysisPage.jsx`) | `/discover` or `/prepare` return a `jobId`; `/run` and `/run-manual` start the work; `GET /progress/:jobId` streams unnamed `data:` lines with `type` (`section_start`, `section_done`, `done`, `error`). State lives in memory, 2 hours (`services/jobStore.js`). | Use named events. `GET /export/:jobId` (PPTX) must also accept a run id and read the report from the run's result. |

### Task 13: In-memory pollers

| Module | Today | What to do |
|---|---|---|
| On-Page Audit | `POST /run` returns `{ jobId }`; `GET /status/:jobId` polls an in-memory Map that is never cleared (`:22`). When a fetch fails, the job says `complete` but the audit says `failed`. | Add `POST /runs` (job; the result is the `auditId`). Make `/status/:jobId` read from the run. Report failure honestly. |
| Competitor Tracker ×3 | `/clients/:id/run`, `/run-pagespeed` and `/content-analysis/run` return `{ status: 'running' }` with no id, backed by three Maps that are never cleared (`:36, 41, 46`). | Add `POST …/runs` for each. The existing `…/status` routes return the latest run for that client, in the same shape. |
| Crawl Scope PageSpeed | `POST /runs/:id/results/pagespeed` plus polling by `?url=`, in an in-memory Map with a 10-minute TTL (`:78`, `:286`). | Make it a job. The status route reads the latest job for that crawl run and URL. |
| AI Visibility `/extract` | Synchronous: up to 200 LLM calls in one request (`:735`). | Make it a job; `GET /extract/pending` stays. |
| Content Architect discover/analyze | `POST` mints a token; `GET …/stream/:token` does the work and writes to the database. | Add `POST …/discover/runs` and `…/analyze/runs`. Keep the token routes for one release. |
| Robots Monitor | Global `isRunning` and `currentRunId`, with its own history table. | Keep its history table. Add `GET /runs/current` (alias of `/run/status`). The run id fix is already done. |
| AI Visibility Lite `POST /run` | Returns 202 `{ status, budget }` with **no run id** (`:311`). | Return the run id from the module queue, in the `{ run: { id, status } }` shape. |

**Status words:**
- On the wire, statuses are `queued`, `running`, `paused` (crawls) and then `completed`, `failed` or `cancelled`.
- Map the old words when you touch a module: `complete`/`done` become `completed`, and `error` becomes `failed`.
- Module-specific results such as `insufficient_data` go in an `outcome` field.

---

## 5. Part D — naming and documentation

### Task 14: Standard route names (old names kept as aliases) and an OpenAPI spec

Register both paths on the same handler. Switch the client and `config/runTracking.js` to the new one. Remove the old path one release later.

| Old | New |
|---|---|
| OPA `GET /list` | `GET /audits` |
| OPA `GET /result/:auditId` | `GET /audits/:auditId` |
| OPA `DELETE /:auditId` | `DELETE /audits/:auditId` |
| MP `/service/…` | `/services/…` |
| AIVL `POST /:projectId/run` | `POST /:projectId/runs` |
| RM `/history`, `/history/:runId` | `/runs`, `/runs/:runId` |
| RM `/run/status` | `/runs/current` |
| CS `GET /runs/:id/report.xlsx` | `GET /runs/:id/export?format=xlsx` |
| Projects `report.xlsx`, `report.md`, `report.pdf` | `GET /:projectId/report/export?format=` |
| kb `PATCH /:id/toggle` | `PATCH /:id { enabled }` |

Also, in projects, `GET /modules/pages/:pageRunId` and `GET /modules/runs/:runId` put a literal word where `:moduleKey` normally goes. Add `GET /:projectId/page-runs/:pageRunId` and `GET /:projectId/module-runs/:runId` as the clear names.

**OpenAPI**
- Create `docs/api/openapi.yaml`: every path and method with a summary and parameters, shared components (`Error`, `Page`, `Run`, `RunEvent`), and the standard error responses.
- Full request and response schemas are needed only for the shared shapes and the job endpoints.

**Drift test:** create `server/scripts/__tests__/openapiRoutes.test.js`. It loads each router module directly (not `server.js`), walks `router.stack` with the mount table copied from `server.js`, and fails when a registered route isn't in the spec.

---

## 6. Open decisions for the user

1. **LPB approvals.** Today anyone signed in can approve any step, because the client sends the role for each step itself. The user chose to leave it this way for now. A real fix means assigning roles (SEO, clinical, content, account owner) to users.
2. **Migration 0043** (another session's query indexes) is still pending on production, waiting for the user's go-ahead. It is not part of this work.
3. **Robots Monitor run ids** only go down to the minute. Two manual runs in the same minute share an id, and the second overwrites the first in history, because `saveRunHistory` upserts. Scheduled runs already worked this way. A fix would add seconds or a suffix, which changes the id format the history page shows.
4. **The excluded route merges** (section 2) need someone who owns each tool to decide.

---

## 7. Final verification (once everything is done)

- `npm test --prefix server`. `budget-clamp.test.js` "the admin policy lowers the page budget" already fails on `unified-fast` and is unrelated. DB suites without a test database fail with `ECONNREFUSED 127.0.0.1:5433`; run them against PGlite instead.
- `npm test --prefix client`
- `npm run build --prefix client`
- `node --check` on `server/server.js`, `server/worker-module.js` and every changed router.
- Using the app locally needs a non-production `DATABASE_URL`. Check the `.env` first; it points at production.
- Run every tool's run → refresh mid-run → resume → cancel check in the browser.
- Confirm run history (`/runs` page) still records every tool: one run per tool, and nothing missing after a path change.

## 8. Cleanup one release after this ships

- Remove the old `POST /init` + `GET /stream/:token` routes and their `initStreamMatchers` entries in `config/runTracking.js`.
- Remove the in-memory job Maps (OPA, CT, CS PageSpeed), `services/jobStore.js` (legacy Competitor Analysis), and the old token Maps.
- Remove the route aliases from Task 14 and the back-compat fields (`runId` aliases, `quota`, `reason`).
- Remove the 308 / alias notes from the OpenAPI spec.
