# SERP Content Researcher — Code Review and Bug Candidates

**Review date:** 2026-09-04  
**Reviewed folder:** `C:\Users\nikhil.a\serp-content-researcher`  
**Review type:** Read-only static review plus isolated builds/tests  
**Audience:** Claude Code or another engineer validating and fixing the findings

## Important scope note

No application files were edited. The production server was not started because startup initializes stores and schedulers and could write runtime data. Build and test output was redirected to the separate review workspace.

The repository was already dirty before this review. In particular, `client/vite.config.js` was modified and numerous application files were untracked. Those pre-existing changes were preserved.

## Executive summary

The most urgent problems are:

1. Authentication and authorization are completely bypassed.
2. Several public endpoints can make requests to arbitrary URLs, creating SSRF exposure.
3. Knowledge-base and module paths are built from unvalidated user input, allowing filesystem traversal.
4. The Docker build can copy the real `.env` and other sensitive/local files into the image.
5. Embedded pages send complete tool output to any parent origin via `postMessage('*')`.
6. Competitor Analysis Beta fails for any client with a brand name because its unit-cost model and provider implementation are incomplete.
7. Several substantial features exist in the folder but are not mounted in the server or React router, and many of their source/migration files are not tracked by Git.

The findings below are ordered roughly by remediation priority. “Latent” means the affected implementation is currently unreachable because its routes are not mounted, but the defect will become active when the feature is wired in.

---

## BUG-001 — Authentication and role authorization are disabled

**Severity:** Critical  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/routes/auth.js:28-30` makes `/api/auth/verify` always return `{ valid: true, role: 'seo' }`.
- `server/routes/auth.js:32-40` makes both `requireAuth` and `requireSeo` assign a hard-coded public SEO user and call `next()`.
- `server/server.js:82-106` relies on those functions to protect every significant API.
- `client/src/context/AuthContext.jsx:5-17` starts authenticated and “logout” leaves the user authenticated.
- `useAuth()` has no consumers outside its definition.
- `.env.example:45-49` still documents usernames, passwords, and `JWT_SECRET`, so the public behavior conflicts with the documented configuration.

### Impact

Anyone who can reach the server can read or mutate knowledge-base data, run paid-provider workflows, modify monitor configuration, invoke seed/delete operations, and access every role-restricted SEO endpoint. There is no effective distinction between unauthenticated, normal, and SEO users.

### Suggested fix

Restore credential/session verification in `requireAuth`, enforce the role in `requireSeo`, make `/verify` validate the signed cookie, and have the client represent loading/authenticated/unauthenticated states correctly. Deny access when required configuration is missing rather than falling back to public access.

### Verification

- An unauthenticated request to a protected endpoint returns 401.
- A non-SEO session receives 403 from SEO-only endpoints.
- Logout invalidates the cookie and the client session.
- Invalid, expired, and forged JWTs are rejected.

---

## BUG-002 — Multiple URL-fetching features permit server-side request forgery (SSRF)

**Severity:** Critical  
**State:** Active  
**Confidence:** Confirmed by data-flow inspection

### Evidence

- `server/routes/scrape.js:5-18` accepts an arbitrary array of URLs and passes it to the scraper with no URL, host, or IP validation.
- `server/services/scraper.js:185-203` navigates Chromium directly to the supplied URL and follows navigation/redirects.
- `server/modules/onPageAudit/routes.js:11-29` accepts an arbitrary `url`.
- `server/modules/onPageAudit/dataCollector.js:8-48` fetches it with Axios and manually follows up to ten redirects without revalidating destinations.
- `server/modules/onPageAudit/dataCollector.js:111-130` recursively fetches sitemap URLs controlled by the target, and `:178-208` fetches robots and sitemap resources without private-network checks.
- `server/modules/robotsMonitor/routes.js:11-18,78-95` considers every HTTP(S) URL valid, including localhost and private addresses.
- `server/modules/robotsMonitor/sitemapCrawler.js:21-23,33-47,51-55` fetches user/domain-controlled sitemap locations. Its same-host filtering happens only after sitemap downloads.
- BUG-001 makes all of these entry points effectively public.

### Impact

An attacker can ask the server to access loopback services, RFC1918 networks, link-local/cloud metadata endpoints, or other services reachable only from the application host. Redirects, DNS rebinding, and sitemap indirection provide additional bypass paths. The response/timing and downstream parsing can disclose internal data or enable internal network scanning.

### Suggested fix

Centralize outbound URL validation. Allow only `http:`/`https:`, resolve DNS, reject loopback/private/link-local/reserved IPv4 and IPv6 ranges, re-check every redirect and sitemap URL, set strict response-size/time limits, and consider an explicit hostname allowlist. Apply egress firewall rules as defense in depth.

### Verification

Test direct and redirected requests to `127.0.0.1`, `::1`, RFC1918 ranges, `169.254.169.254`, integer/hex IP forms, and DNS names that resolve or rebind to private addresses. Every variant should be rejected before a connection is made.

---

## BUG-003 — Knowledge-base and module paths allow traversal outside their storage roots

**Severity:** Critical  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/services/kbStore.js:81-97` constructs relative paths from unvalidated body fields such as `id`, `client`, and `period`.
- `server/services/kbStore.js:126-139` joins that path to `KB_ROOT`, writes it, and stores the attacker-controlled path in the index.
- `server/services/kbStore.js:33-44,47-76,144-152` later reads, overwrites, or deletes the indexed path without containment checks.
- `server/services/kbStore.js:186-197` directly joins the route-controlled `moduleId` into a module path for reads and writes.
- `server/routes/kb.js:15-65` and `server/routes/modules.js:15-32` expose those operations without validating safe identifiers.
- BUG-001 makes the operations public.

### Impact

A `client`, `period`, or `id` containing `..` segments can escape the intended knowledge-base directory. Creation can write attacker-controlled Markdown to other writable paths; subsequent read/update/delete operations use the poisoned index entry. Encoded separators in `moduleId` can target a `manifest.json` outside the module directory. This is arbitrary file access within the permissions of the Node process and can cause data loss or potentially code/configuration replacement where filenames line up.

### Suggested fix

Use strict identifier allowlists (for example `^[a-z0-9][a-z0-9_-]*$`), never accept path fragments from request data, resolve the final absolute path, and reject it unless it remains inside the intended root using a separator-aware containment check. Validate existing index entries before using them as paths.

### Verification

Add tests for `..`, encoded slashes/backslashes, absolute paths, drive-letter paths, mixed separators, Unicode lookalikes, and malicious pre-existing index entries.

---

## BUG-004 — Docker build context includes `.env`, Git data, dependencies, logs, and runtime files

**Severity:** Critical  
**State:** Deployment  
**Confidence:** Confirmed for this folder

### Evidence

- There is no `.dockerignore` in the reviewed folder.
- A real `.env` exists in the folder. Its values were not inspected or copied into this report.
- `Dockerfile:26` runs `COPY . .` in a single-stage image.
- `.gitignore` does not control Docker build context.
- The folder also contains `.git`, multiple `node_modules` trees, logs, and runtime data.

### Impact

Building this Dockerfile from the repository root copies secrets and local state into the build context and image layers. Deleting them in a later layer would not remove them from image history. It also produces oversized, non-reproducible images that may contain host-specific native dependencies.

### Suggested fix

Add a restrictive `.dockerignore` before the next image build. At minimum exclude `.env*` except a safe example, `.git`, `node_modules`, logs, coverage/build output, local data/history, test caches, and editor files. Prefer a multi-stage build that copies only lockfiles/source needed for each stage and only production artifacts into the final image. Rotate any credential that may already have been built or pushed.

### Verification

Inspect the Docker build context and final image filesystem/history. Confirm no secret file, Git object, log, local database/history file, or host `node_modules` is present.

---

## BUG-005 — Full tool output is posted to any embedding parent origin

**Severity:** Critical  
**State:** Active when embedded  
**Confidence:** Confirmed by code inspection

### Evidence

- `client/src/lib/agentRunSignal.js:17-26` sends the complete `output` payload with `window.parent.postMessage(..., '*')`.
- Run-start and route-change messages also use `'*'` at `:7-11` and `:38-42`.
- No parent-origin check or handshake is performed.
- `server/server.js` does not configure `Content-Security-Policy: frame-ancestors` or an equivalent frame allowlist.
- BUG-001 means an arbitrary embedding page can load and operate the app without first obtaining a valid app session.

### Impact

Any website that can frame the app can become its parent and receive completed analysis output, which may contain client URLs, content, recommendations, or other sensitive business data. This is a direct cross-origin data-exfiltration path.

### Suggested fix

Use an exact configured platform origin as `targetOrigin`, verify the embedding origin through a nonce-based handshake where appropriate, and enforce the same allowlist with CSP `frame-ancestors`. Do not send full outputs unless the parent has been authenticated and authorized to receive them.

### Verification

Embed the app from an unapproved test origin and confirm that framing and messages are blocked. Confirm the approved platform still receives messages and that origin checks cannot be bypassed with suffix/subdomain tricks.

---

## BUG-006 — Platform login API throws at runtime and the alternate flow uses a known fallback JWT secret

**Severity:** High  
**State:** Active, but mostly hidden by BUG-001  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/routes/auth.js:45-53` calls `jwt.sign(..., JWT_SECRET, ...)`, but that file neither imports `jsonwebtoken` nor defines `JWT_SECRET`.
- A valid `/api/auth/platform-login` request therefore reaches a `ReferenceError` instead of creating a session.
- `client/src/main.jsx:17-23` only calls platform login when `/verify` is invalid, but `/verify` is hard-coded valid, making the client branch dead.
- The separate page middleware in `server/server.js:112-124` imports JWT correctly but uses the hard-coded fallback secret `seo-automation-fallback-secret` when `JWT_SECRET` is missing.

### Impact

The documented API-based iframe login cannot work. If the page middleware is used without `JWT_SECRET`, anyone knowing the source can mint accepted tokens once real JWT validation is restored. Passing platform secrets in query strings also exposes them to browser history and common access logs.

### Suggested fix

Consolidate the two platform-login implementations. Require `JWT_SECRET` and `PLATFORM_TOKEN` at startup, fail closed if either is absent, use a POST or short-lived one-time exchange rather than a reusable query-string secret, and add tests that exercise the actual client flow.

---

## BUG-007 — Robots Monitor stores and returns basic-auth passwords in plaintext

**Severity:** Critical with BUG-001; High after authentication is restored  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/modules/robotsMonitor/routes.js:78-95` accepts a username/password object.
- `server/modules/robotsMonitor/monitorStore.js:80-94` stores it directly in `data/clients.json`.
- `server/modules/robotsMonitor/routes.js:39-45` returns the full clients structure, including every domain's `auth`, to the caller.
- The file is neither encrypted nor redacted; BUG-001 exposes the endpoint publicly.

### Impact

Staging-site credentials can be downloaded in clear text by any caller and are also exposed to filesystem backups, support bundles, and accidental commits. These credentials are often reused or grant access to unreleased client sites.

### Suggested fix

Store secrets in a managed secret store or encrypt them with a key outside the data file. Return only a boolean such as `hasAuth` and never return passwords after creation. Add field-level authorization and rotate credentials already stored by this implementation.

---

## BUG-008 — Competitor Analysis Beta branded-client runs are broken

**Severity:** High  
**State:** Latent because the beta router is not mounted  
**Confidence:** Confirmed by execution and code inspection

### Evidence

- `server/modules/competitorAnalysisBeta/runPlanner.js:31` adds a `branded_keyword_count` operation using `COSTS.brandedKeywordCount` and `ROW_LIMITS.brandedKeywordCount`.
- Neither property exists in `server/modules/competitorAnalysis/unitCosts.js:17-27`.
- The plan reduction at `runPlanner.js:50` therefore produces `NaN`.
- `apiBudgetManager.js:34-38` rejects the plan as `CRB_INVALID_RUN_PLAN`, so every dashboard run for a client with `brandName` fails before execution.
- `meteredProvider.js:50-70` would price this operation at zero and call `semrush.getBrandedKeywordCount(...)`.
- `server/services/semrushCA.js:257-266` exports no such function.
- Running `node server/modules/competitorAnalysisBeta/__tests__/run.js` failed immediately at line 23: “the maximum dashboard plan must fit under the hard cap.”
- A direct read-only probe produced `estimatedMaxUnits: "NaN"` and `typeof semrushCA.getBrandedKeywordCount === "undefined"`.

### Impact

The feature fails for the exact clients that provide a brand name. If validation were bypassed, the same operation would be metered at zero and then fail in live-provider mode because the provider function does not exist.

### Suggested fix

Define a documented row limit and unit cost, implement/export the SEMrush call, update the aggregate per-domain cost, and cover both mock and live-provider adapters with contract tests. Keep the invalid-plan guard.

---

## BUG-009 — Implemented features are unreachable because their routes and UI pages are not registered

**Severity:** High  
**State:** Active integration defect  
**Confidence:** Confirmed by import/route inspection

### Evidence

Server implementations exist for:

- `server/modules/competitorAnalysisBeta/routes.js`
- `server/modules/gscExplorer/routes.js`
- `server/routes/feedback.js`
- `server/routes/runs.js`
- `server/routes/settings.js`

However, `server/server.js:8-30,82-106` neither imports nor mounts them. Client pages and API wrappers exist for Competitor Analysis Beta, GSC Explorer, feedback listing/widget, persisted runs, and settings, but `client/src/App.jsx:8-35,54-90` imports/routes none of those pages. `client/src/toolsMeta.js:13-44` also omits the tools, and `FeedbackWidget.jsx` has no importer.

### Impact

The completed-looking features cannot be reached through the built app. GET requests to their missing API paths can fall through to the SPA HTML response (BUG-023), producing JSON parse errors rather than a clear 404. Documentation claiming paths such as `/api/comp-res-beta` and `/comp-res-beta` does not match runtime behavior.

### Suggested fix

Decide which features are intended to ship, then register their server routers, client routes, navigation metadata, and global components together. If they are intentionally unfinished, remove misleading documentation/API wrappers or gate them behind an explicit feature flag.

---

## BUG-010 — Major application code and database migrations are untracked

**Severity:** High  
**State:** Release/source-control defect  
**Confidence:** Confirmed with `git status --short`

### Evidence

The current working tree reports many application files as untracked, including:

- `server/modules/competitorAnalysisBeta/`
- `server/modules/gscExplorer/`
- `server/routes/feedback.js`, `runs.js`, and `settings.js`
- corresponding client pages, components, hooks, and API libraries
- the entire `content-audit/` Python application
- `supabase/migrations/0001` through `0006` and `0008`
- documentation that describes some of these features

Only later migrations such as `0007` and `0009` are tracked, creating a non-contiguous migration history in a clean checkout.

### Impact

A clean clone, CI build, or Git-based deployment silently omits substantial functionality and the database schema it requires. A developer building directly from this dirty folder sees a different product from production/CI. Later migrations may run against a database missing prerequisite tables.

### Suggested fix

Audit every untracked source and migration, commit intended files in dependency order, remove generated logs/runtime data, and verify a brand-new clone can build, migrate an empty database, and run the same tests. Do not commit secrets or local data while doing this.

---

## BUG-011 — Generic Docker and Nixpacks deployments cannot locate a browser for scraping

**Severity:** High  
**State:** Deployment  
**Confidence:** High

### Evidence

- `Dockerfile:3-22` installs Chromium shared libraries but not Chrome/Chromium itself.
- `server/services/scraper.js:154-161,256-260` treats every environment other than Railway or Render as “local” and calls `findLocalBrowser()`.
- The Docker image is therefore considered local, but none of the searched browser executables is installed.
- In that branch the bundled `@sparticuz/chromium` executable is not used.
- `nixpacks.toml:12` sets `PUPPETEER_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium`, while `scraper.js:5-18` reads `CHROME_PATH` and does not include that Nix path in its candidates.

### Impact

Scraping fails at `puppeteer.launch()` in a generic Docker deployment and potentially in Nixpacks environments that do not set `RAILWAY_ENVIRONMENT`/`RENDER`. Most of the core content-research flow then becomes unusable.

### Suggested fix

Use one explicit browser-executable configuration path. Honor `PUPPETEER_EXECUTABLE_PATH`, validate it at startup, and fall back to `@sparticuz/chromium.executablePath()` based on actual availability rather than vendor-specific environment variables. Add a container smoke test that opens a trivial page.

---

## BUG-012 — Robots Monitor and On-Page Audit are throttled by both rate limiters

**Severity:** High  
**State:** Active  
**Confidence:** Confirmed by middleware order and polling rates

### Evidence

- `server/server.js:41-53` applies a 20-request/minute global limiter and skips only a subset of chatty routers.
- `/api/robots-monitor`, `/api/on-page-audit`, and `/api/content-architect` are not in the skip list.
- `server/server.js:95-99` then applies a separate 300-request/minute limiter to those routes, so the advertised higher limit never replaces the global 20/minute cap.
- `client/src/pages/RobotsMonitorPage.jsx:899-913` polls status every 3 seconds: exactly 20 requests/minute before the initial run, history, and other calls are counted.
- `client/src/pages/OnPageAuditPage.jsx:253-281` polls every 3.5 seconds and silently ignores polling errors.

### Impact

Long-running jobs predictably hit HTTP 429. Robots Monitor can appear stuck because polling errors are swallowed, and the 300/minute limiter provides no practical relief.

### Suggested fix

Add every router with its own limiter to the global skip list, or mount the global limiter only on routes without a specialized policy. Prefer SSE/WebSocket or bounded backoff polling for long jobs.

---

## BUG-013 — Rejected On-Page Audit store promises can terminate the Express 4 process

**Severity:** High  
**State:** Active  
**Confidence:** Confirmed framework/error-flow defect

### Evidence

- The server uses Express `4.19.2` (`server/package.json`). Express 4 does not automatically forward rejected async-handler promises.
- `server/modules/onPageAudit/routes.js:50-65` has async result/list/delete handlers with no `try/catch` and no async wrapper.
- Those handlers await asynchronous store calls that can reject on database/network errors.
- The project itself documents the Express 4 behavior in `server/routes/locationPageBuilder.js:26-27` and wraps handlers there, but the On-Page Audit routes do not follow that pattern.

### Impact

A transient Supabase failure or rejected store operation can become an unhandled rejection. On modern Node configurations this can terminate the whole server instead of returning a controlled 5xx response.

### Suggested fix

Wrap every async route consistently or upgrade to Express 5 after compatibility testing. Add a final error middleware and tests that stub each store method to reject.

---

## BUG-014 — Credentialed CORS reflects arbitrary origins and state-changing requests have no CSRF defense

**Severity:** High  
**State:** Active/configuration-dependent  
**Confidence:** Confirmed configuration weakness

### Evidence

- `server/server.js:37` uses `cors({ origin: true, credentials: true })`, which reflects the requesting origin while allowing credentials.
- `server/routes/auth.js:11-20` supports `SameSite=None`, which is normally required for the cross-site iframe scenario.
- Mutating APIs use cookie authentication semantics but do not validate `Origin`, CSRF tokens, or a custom request header.

### Impact

When cookies are configured for cross-site use, an attacker-controlled origin can issue credentialed API requests and read responses. BUG-001 currently makes authentication irrelevant, but this becomes a direct account-level issue after authentication is restored.

### Suggested fix

Allowlist exact platform/UI origins, reject missing or unexpected origins on unsafe methods, and add an anti-CSRF mechanism compatible with the iframe architecture. Never combine reflected arbitrary origins with credentialed CORS.

---

## BUG-015 — Robots Monitor file storage has lost-update and corruption races

**Severity:** High  
**State:** Active  
**Confidence:** High

### Evidence

- `server/modules/robotsMonitor/monitorStore.js:50-115` implements each mutation as read-all, modify in memory, write-all with no lock.
- Concurrent mutations can read the same old array and the last writer silently discards the other update.
- `monitorStore.js:25-29` uses the same fixed `<file>.tmp` name for every concurrent write, so competing renames can overwrite or fail.
- `monitorStore.js:17-22` catches all read/parse/permission errors and returns an empty fallback. A later save can replace recoverable data with an empty structure.

### Impact

Parallel user actions or scheduler/UI overlap can lose clients, domains, credentials, or Slack configuration. A transient read or malformed JSON can be converted into permanent data loss.

### Suggested fix

Use a database or a per-file mutex plus unique temporary files and durable atomic replacement. Distinguish `ENOENT` from parse/permission errors; never treat corruption as an empty valid store. Keep backups and validate data before replacement.

---

## BUG-016 — Seed/replace operations delete data before replacement succeeds

**Severity:** High  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/services/supabaseStore.js:134-150` deletes an entire table and then inserts replacement rows without a transaction.
- `server/locationPageBuilder/store.js:79-90` deletes all rows for a client and then inserts replacements one at a time.
- Any validation, network, constraint, or process failure after deletion leaves the collection empty or partially populated.
- Publicly reachable seed routes exist at `server/routes/locationPageBuilder.js:47-53` because of BUG-001.

### Impact

A routine re-seed can destroy reference data. A partial insert is especially dangerous because it may appear successful enough for later workflows while silently omitting locations/services/providers.

### Suggested fix

Perform replace operations in a database transaction or call an atomic stored procedure/RPC. Validate the complete replacement set first, insert into staging/upsert safely, and only remove obsolete rows after successful writes.

---

## BUG-017 — GSC daily quota is only a preflight estimate, not a hard cap

**Severity:** High if mounted  
**State:** Latent  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/modules/gscExplorer/gscPuller.js:121-126` estimates one API call per date and explicitly notes that pagination may require more.
- `server/services/gscClient.js:83-119` can make an unbounded number of paginated calls for each date.
- `server/services/gscUsageStore.js:58-63` increments usage but never refuses an increment that crosses the cap.
- The lock at `gscUsageStore.js:15-20` is process-local, and the file comments acknowledge that multi-instance deployments need an external lock.
- The GSC router permits multiple pulls/refreshes to start concurrently (`routes.js:274-308`).

### Impact

Large properties, concurrent jobs, retries, or multiple server instances can exceed the configured daily API-call cap despite passing preflight. This can exhaust quota and disrupt all GSC projects.

### Suggested fix

Reserve each call atomically in the database immediately before making it, using a conditional update/RPC that fails once the cap is reached. Include pagination and retries in reservation/accounting and prevent overlapping jobs for the same project/range.

---

## BUG-018 — Background job maps grow forever and allow overlapping work

**Severity:** Medium  
**State:** On-Page active; GSC latent  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/modules/onPageAudit/routes.js:7-35` stores every job in a module-level `Map` and never deletes it.
- `server/modules/gscExplorer/routes.js:14-36` does the same.
- Neither implementation has a TTL, maximum size, persistence, cancellation, or per-project deduplication.
- GSC pull and refresh endpoints can start simultaneous jobs for the same project.

### Impact

Memory grows with every run until process restart. Overlapping jobs duplicate paid/external calls and can race to update the same rows. A restart also erases all job status, causing clients polling an in-flight ID to get “not found.”

### Suggested fix

Use a durable job queue or add a bounded TTL cache and cleanup on terminal states. Add uniqueness/locking for conflicting jobs and make job ownership explicit.

---

## BUG-019 — GSC summary double-counts URLs selected through overlapping lines/tags

**Severity:** Medium if mounted  
**State:** Latent  
**Confidence:** High

### Evidence

- `server/modules/gscExplorer/routes.js:329-355` can return a direct URL line plus one or more tag rollup lines containing that same URL.
- Overlapping tags can also contain the same URL.
- `routes.js:391-414` computes summary statistics by flattening every returned line and summing them.

### Impact

Selecting a URL directly and via a tag, or selecting overlapping tags, inflates clicks and impressions and distorts CTR/position. The chart may intentionally show overlapping series, but the overall summary should not treat each visual series as distinct underlying traffic.

### Suggested fix

Build summary statistics from a deduplicated set of underlying URL IDs, independent of display rollups. Add tests for direct-plus-tag selection and two tags sharing URLs.

---

## BUG-020 — GSC tags can be assigned across project boundaries

**Severity:** Medium if mounted  
**State:** Latent  
**Confidence:** Confirmed by schema and route inspection

### Evidence

- `server/modules/gscExplorer/routes.js:252-269` accepts any `tagId` with any array of `urlIds`.
- `server/modules/gscExplorer/store.js:210-218` inserts/deletes the pairs without checking that the tag and URLs belong to the same project.
- `supabase/migrations/0006_gsc_explorer.sql:45-49` has separate foreign keys but no constraint enforcing equal `project_id` values.

### Impact

IDs from different projects can be linked, corrupting filters and rollups and potentially exposing cross-project metrics through tag-based views.

### Suggested fix

Verify ownership in the service and enforce it at the database layer, preferably with a project ID in the junction table plus composite foreign keys or an atomic RPC.

---

## BUG-021 — Enabling GSC smoothing removes final/preliminary data-state markers

**Severity:** Medium if mounted  
**State:** Latent  
**Confidence:** Confirmed by return shapes

### Evidence

- Normal URL and rollup rows contain `dataState` (`aggregate.js:59,90`).
- `aggregate.sevenDayRolling()` returns only `date`, `clicks`, `impressions`, `ctr`, and `position` at `aggregate.js:129-144`.
- `server/modules/gscExplorer/routes.js:364-366` replaces each original series with that output when smoothing is requested.

### Impact

The UI/export can no longer distinguish preliminary data from finalized data whenever smoothing is on. That changes data semantics, not just presentation.

### Suggested fix

Carry the current point's `dataState` through smoothing, or derive a conservative window state such as preliminary if any source day is preliminary.

---

## BUG-022 — Robots Monitor can remain permanently “running” after an early configuration error

**Severity:** Medium  
**State:** Active  
**Confidence:** Confirmed by control flow

### Evidence

- `server/modules/robotsMonitor/monitorRunner.js:36-38` sets `isRunning = true`.
- `monitorRunner.js:40-43` then awaits `getSlackConfig()` before entering the `try` block.
- The only reset is in the `finally` at `:168-171`.

### Impact

If Slack configuration loading throws before line 45, the `finally` never runs and every future manual or scheduled run fails with `RUN_IN_PROGRESS` until the process restarts.

### Suggested fix

Put every operation after `isRunning = true` inside the `try/finally`, or load/validate configuration before acquiring the running lock.

---

## BUG-023 — Robots Monitor run IDs collide and the API returns an ID that is never used

**Severity:** Medium  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/modules/robotsMonitor/monitorRunner.js:14-33` generates actual history IDs only to minute precision.
- `monitorStore.js:130-134` writes `${runId}.json`, so two sequential runs in one minute overwrite the same history file.
- `server/modules/robotsMonitor/routes.js:210-216` immediately returns a different placeholder ID (`run_manual_<timestamp-base36>`).
- `runMonitorCheck()` independently generates the actual `run_YYYYMMDD_HHmm` ID and never receives the placeholder.

### Impact

The ID returned to the caller cannot retrieve or correlate the run, and valid history can be overwritten by another run in the same minute.

### Suggested fix

Generate one collision-resistant ID at the API boundary (UUID/ULID), pass it into the runner, status, and history store, and write history with exclusive/atomic semantics.

---

## BUG-024 — Unknown GET API routes return the React app with HTTP 200

**Severity:** Medium  
**State:** Active  
**Confidence:** Confirmed by middleware order

### Evidence

- `server/server.js:130-134` serves static files and then handles every remaining GET path with `index.html`.
- There is no JSON 404 handler for `/api/*` before the SPA fallback.
- This currently affects the unmounted APIs in BUG-009.

### Impact

API clients receive HTML with a successful status and then fail with misleading JSON errors such as `Unexpected token '<'`. Monitoring can also treat a missing API as healthy because it returned 200.

### Suggested fix

Add an `/api` JSON 404 handler before static/SPA middleware, and restrict the SPA fallback to non-API GET requests that accept HTML.

---

## BUG-025 — Content Research promises/generated “content” but deliberately never produces it

**Severity:** Medium; product intent should be confirmed  
**State:** Active  
**Confidence:** Confirmed contract mismatch

### Evidence

- `README.md:9-10` says the tool generates “ready-to-publish content.”
- `server/services/claude.js:43-50` explicitly instructs the model not to include a `content` field.
- `client/src/components/ResultsTable.jsx:24-32,76` renders a 50%-width Content column whose cells are always empty.
- `client/src/components/ExportButtons.jsx:64-71` attempts to copy `section.content`, which is guaranteed to be absent, so it writes `N/A`.
- `server/routes/export.js:74-105` creates a Content column in DOCX exports and deliberately inserts an empty paragraph.

### Impact

Users receive a prominent empty column and exported/copy output that contradicts both the UI shape and README. Half of the main results table is reserved for data that the backend forbids.

### Suggested fix

Choose one product contract. Either generate and validate section content, or remove the Content column/clipboard field and update the README/copy to describe a recommendation brief rather than ready-to-publish content.

---

## BUG-026 — Model output is only shallowly validated

**Severity:** Medium  
**State:** Active  
**Confidence:** High

### Evidence

- `server/services/claude.js:71-90` parses JSON and only verifies that `analysis.sections` is an array.
- It does not validate each section's `h2`/`recommendations` types or the types/ranges of `wordCountBenchmark`, `semanticKeywords`, and `contentGaps`.
- The client and DOCX exporter assume strings/numbers/arrays in multiple places.

### Impact

A syntactically valid but schema-invalid model response can cause rendering/export errors, nonsensical output, or a successful API response that later fails in the browser.

### Suggested fix

Validate with a strict schema (for example Zod, Ajv, or JSON Schema), reject/coerce invalid fields safely, cap string/array sizes, and add fixtures for malformed-but-valid JSON responses.

---

## BUG-027 — Test orchestration excludes important suites and currently hides a failing suite

**Severity:** Medium  
**State:** Active engineering defect  
**Confidence:** Confirmed by scripts and execution

### Evidence

- `server/package.json` defines `npm test` as only `node locationPageBuilder/__tests__/run.js`.
- The SEO/GEO tests, Competitor Analysis Beta tests, and Python `content-audit` tests are not included in a root/server test command.
- The default server suite passed 158 tests, while the manually invoked beta suite failed immediately because of BUG-008.
- There is no root `test` script.

### Impact

CI or developers running the obvious test command can get a green result while a major module's suite is red. New suites can silently become dead tests.

### Suggested fix

Create a root test command that runs every maintained suite and fails if any suite is missing/fails. Add CI discovery or an explicit manifest so new module tests cannot be forgotten.

---

## BUG-028 — GSC search text is interpolated into PostgREST filter syntax

**Severity:** Medium if mounted  
**State:** Latent  
**Confidence:** High

### Evidence

- `server/modules/gscExplorer/store.js:134-139` interpolates raw `search` text into `.or(`full_url.ilike.%${search}%,normalized_url.ilike.%${search}%`)`.
- PostgREST filter expressions use commas, parentheses, dots, and wildcard characters as syntax.

### Impact

Certain ordinary or malicious search strings can change the filter grammar or trigger database 400/500 responses. Depending on PostgREST parsing, they may broaden the intended query.

### Suggested fix

Escape PostgREST reserved characters using the client library's supported mechanism, validate the search length/character set, or move the search into a parameterized RPC.

---

## BUG-029 — Google Custom Search daily limiting resets on restart and races under concurrency

**Severity:** Low/Medium  
**State:** Active  
**Confidence:** Confirmed by code inspection

### Evidence

- `server/services/googleSearch.js:3-13` keeps `dailySearchCount` and its date only in process memory.
- `googleSearch.js:42-47` checks for 100 before the request.
- `googleSearch.js:77` increments only after a successful request and does not synchronize concurrent callers.

### Impact

Restarting or horizontally scaling the app resets/multiplies the apparent quota. Concurrent requests near 100 can all pass the pre-check. The app may exceed the intended Google quota and switch to Serper later than expected.

### Suggested fix

Use an atomic shared quota ledger with an explicit timezone/day boundary. Reserve before issuing the request and release only when policy says a failed request should not count.

---

## BUG-030 — The client ships one very large initial JavaScript bundle

**Severity:** Low/Medium performance issue  
**State:** Active  
**Confidence:** Confirmed by production build

### Evidence

- The isolated Vite build succeeded but emitted one main JavaScript asset of approximately **3,453.93 kB** minified (**878.11 kB gzip**).
- Vite warned that chunks exceed 500 kB.
- `client/src/App.jsx:8-35` eagerly imports every tool page rather than route-level lazy loading.

### Impact

Every user downloads and parses code for all tools, including tools they never open. This increases first-load time, memory use, and failure impact on slower devices/networks.

### Suggested fix

Use `React.lazy()`/dynamic imports per route, split large export/chart dependencies, and establish a bundle-size budget in CI.

---

## Automated checks performed

All checks were run without intentionally writing to the reviewed app folder.

| Check | Result |
|---|---|
| Client production build, output redirected to separate workspace | Passed; 1,188 modules transformed; large-chunk warning |
| `node --check` across 160 server JavaScript files | Passed; 0 syntax failures |
| Default server test (`npm test --prefix server`) | Passed; 158 passed, 0 failed |
| SEO/GEO test (`node server/checks/__tests__/seoGeo.test.js`) | Passed; 65 passed, 0 failed |
| Competitor Analysis Beta test (`node server/modules/competitorAnalysisBeta/__tests__/run.js`) | **Failed** at the first budget assertion; see BUG-008 |
| Python `content-audit` tests, with cache/temp outside app | Passed; 26 passed, 8 warnings |
| Client/server dependency-tree check (`npm ls --depth=0`) | Completed successfully; server also reports many extraneous packages in the existing install |

## Recommended fix order

1. Restore real authentication/authorization and restrict CORS/frame origins.
2. Block SSRF and filesystem traversal before exposing the service again.
3. Prevent credential leakage through Robots Monitor and Docker images; rotate affected secrets.
4. Fix the Competitor Analysis Beta cost/provider contract and make all suites part of CI.
5. Decide which untracked/unmounted features are intended to ship, then commit migrations and wire features atomically.
6. Repair data-loss/concurrency defects in stores, seed operations, jobs, and quota accounting.
7. Resolve the user-facing contract, API fallback, and bundle-performance issues.

## Notes for the validating engineer

- Treat BUG-009, BUG-017 through BUG-021, and BUG-028 as latent until the corresponding unmounted routes are enabled.
- Do not assume the current dirty working tree represents what CI or production receives; reproduce from both this folder and a clean checkout.
- Avoid starting the server against production credentials while validating path traversal, SSRF, seed, or quota findings. Use isolated temp storage, mock providers, and a disposable database.
