# Evidence — technical appendix

For engineers. Every claim in documents 00–05 traces to something here. All paths are repo-relative.

**Method.** Eight parallel read-only inventory agents (entry points, endpoints, database, jobs, config, externals, client shell, dependencies) plus direct verification. Enumerate-then-read; every count states how it was counted. Twenty-five per-module agents were queued but hit an account session limit, so the module deep read was done directly in the main session against the inventory output.

**Repository:** `d:\Repo Merge Project\seo-apps-nikhil-tests\seo-apps-nikhil-tests`, branch `unified-app`, HEAD `180f768`.
**App name:** `SEO Studio` (`client/index.html:12`). `package.json:2` says `seo-automation`; `README.md:1` says `SERP Content Researcher`. Three names, one app.

---

## 1. Shape and entry points

| Item | Value | Evidence |
|---|---|---|
| Manifests | 3 (root, `server/`, `client/`) + 3 lockfiles | `package.json`, `server/package.json`, `client/package.json` |
| HTTP listeners | 1 | `server/server.js:418` (`PORT` default 5000) |
| Router mounts under `/api` | 33 | `server/server.js:135-179` |
| Standalone worker entry points | 2 | `server/worker-module.js`, `server/modules/crawlScope/worker/index.js:495` |
| Process-model switches | 2 | `CRAWLSCOPE_WORKER` `server/server.js:341`; `MODULE_WORKER` `server/server.js:369`. Both default `in-process` |
| In-process schedulers with no external option | 4 | robotsMonitor cron, `server/jobs/cachePurge.js`, workspace purge `server/server.js:284-287`, stale-run sweeper `server/server.js:416` |
| Build | `npm run build` → `vite build` | `package.json:8` |
| Deploy definitions | `Dockerfile` (node:24-slim, `EXPOSE 5000`), `nixpacks.toml` | Both define **one** process. No Procfile / railway.json / render.yaml tracked |
| `engines` field | absent in all 3 manifests | comments claim Node ≥22 (`nixpacks.toml:2`), Dockerfile uses 24, `README.md:23` says 18+ |
| `bin` entries | 0 | corroborated by `audit-loop/config.json:4` |
| dotenv load sites | 5, each with its own relative path | `server/server.js:1`, `server/worker-module.js:10`, `server/modules/crawlScope/worker/index.js:20`, `server/scripts/importKeywordUniverse.js:17`, `server/scripts/reclassify-pages.js:17` |

**Consequence:** the repo as committed runs one process hosting seven background loops plus headless Chrome alongside request handling. Whether production sets the workers to `external` is **UNKNOWN — needs checking** (`.env` is gitignored; both switches are commented out in `.env.example`).

---

## 2. HTTP surface

**253 endpoints** across 33 mounts (`server/server.js:135-179`), plus `GET /api/health`.

| Mount | Endpoints | Router | Guard | Limiter |
|---|---|---|---|---|
| `/api/projects` | 39 | `server/modules/projects/routes.js` | requireAuth + projectAccess | 300/min |
| `/api/location-page-builder` | 38 | `server/routes/locationPageBuilder.js` | requireAuth + `LPB_ENABLED` (`:21`) | 300/min |
| `/api/competitor-tracker` | 21 | `server/modules/competitorAnalysis/routes.js` | requireAuth | 300/min |
| `/api/ai-visibility` | 19 | `server/modules/aiVisibility/routes.js` | requireAuth + projectAccess | 300/min |
| `/api/crawl-scope` | 18 | `server/modules/crawlScope/api/routes.js` | requireAuth + `crawlScopeContext` (`:125`) | 300/min |
| `/api/robots-monitor` | 14 | `server/modules/robotsMonitor/routes.js` | requireAuth | 300/min |
| `/api/market-potential` | 14 | `server/modules/marketPotential/routes.js` | requireAuth | 300/min |
| `/api/content-architect` | 14 | `server/modules/contentArchitect/routes.js` | requireAuth | 300/min |
| `/api/admin` | 9 | `server/routes/admin.js` | requireAuth + `requirePlatformAdmin` (`:26`) | 100/min |
| `/api/workspaces` | 8 | `server/routes/workspaces.js` | requireAuth | 20/min |
| `/api/competitor-analysis` | 7 | `server/routes/competitorAnalysis.js` | **requireSeo** | 20/min |
| `/api/kb` | 6 | `server/routes/kb.js` | requireAuth | 100/min |
| `/api/auth` | 5 | `server/routes/auth.js` | **public** | 20/min |
| `/api/on-page-audit` | 5 | `server/modules/onPageAudit/routes.js` | requireAuth | 300/min |
| `/api/agent-readiness-audit` | 4 | `server/routes/agentReadinessAudit.js` | requireAuth | 20/min |
| `/api/modules`, `/api/runs`, `/api/image-alt-audit`, `/api/article-enhancement`, `/api/article-enhancement-lite` | 3 each | — | requireAuth | mixed |
| `/api/keyword-research`, `/api/article-recommendation`, `/api/profile`, `/api/search` | 2 each | — | requireAuth / requireSeo | 20/min |
| `/api/audit`, `/api/kb-context`, `/api/seo-geo-audit`, `/api/content-enhancement`, `/api/semrush`, `/api/scrape`, `/api/analyze`, `/api/export`, `/api/health` | 1 each | — | mixed | mixed |

- Behind `requireAuth`: **235**. Behind `requireSeo`: **12**. Unauthenticated: **6**.
- Capped at 20/min by the global limiter: **36** — including every `requireSeo` research tool and every SSE handshake for keyword research, article enhancement and image alt audit.
- `OWN_LIMITER_PREFIXES` (`server/server.js:78-94`) is hand-maintained data that must mirror the mount list; verified in sync today. The comment at `:64-77` records three past silent drifts.
- **17 endpoints have no client caller.** Notably the complete page-inventory sub-API (`/api/projects/:projectId/pages/:pageId` read/history/patch/exclude/include/sync) and `PATCH /api/crawl-scope/runs/:id/findings` (the whole review write path, 5000-row cap) — the review screen was removed (`client/src/App.jsx:127-135`).
- **1 client call has no server route:** `POST /api/competitor-analysis/regenerate-obs` at `client/src/components/competitorAnalysis/ReportPreview.jsx:153` → 404.
- Identity resolution is repeated per router rather than done once: `server/routes/runs.js:27,122`, `server/modules/crawlScope/api/routes.js:98`, `server/modules/projects/routes.js:118,190`, `server/routes/workspaces.js:33`. `requireAuth` (`server/routes/auth.js:271`) only verifies the JWT.

---

## 3. Database

**21 migration files** in `supabase/migrations/`, numbered 0006–0025, with **two files numbered 0009** (`0009_lpb_keyword_selections_and_cache_retention.sql`, `0009_run_tracking.sql`). There is no 0001–0005 and no migration runner. *(An earlier estimate of 25 in this session was a file-count slip; 21 is the verified number.)*

- **36 tables created**, all `create table if not exists`, all distinct names.
- **33 tables** referenced by a literal `.from('…')` in `server/`.
- **2 tables created but never referenced:** `workspace_member_events`, `category_rule`.
- **10 tables queried but created by no migration here:** the `lpb_*` collections in `server/locationPageBuilder/store.js:15-21` (`store.js:6` cites an absent `0001_init.sql`). Their existence in the live database is **UNKNOWN — needs checking**.
- **RLS:** enabled on 3 tables (`cache`, `settings`, `lpb_keywordselections`) with **zero policies**; the other 33 have no RLS at all. Access is enforced entirely in the query layer with the service-role key.
- **1 migration** is wrapped in a transaction (`0019:38,193`). The rest are unwrapped — a partial failure leaves a half-applied migration.
- `0022:79-81` adds a constraint with no `if not exists` guard, so it is not re-runnable.
- 4 foreign keys deliberately dropped and never re-added (`0024:92-95`).
- `platform_touch_updated_at()` is redefined by five files; `crawl_touch_updated_at()` is a byte-identical second copy (`0010:40` vs `0011:28`).

### Identity duplication — the core of the problem

| Concept | Copies | Where |
|---|---|---|
| Project / site / client | **6** | `crawl_projects` (0010:51) · `project_domains` (0011:371) · `project_brands` (0018:61) · `lpb_clients` + `lpb_keyword_universe.client_id` (0007:13) · `competitorAnalysis/data/clients.json` · `robotsMonitor/data/clients.json` |
| Page | **6** | `crawl_run_results` (0010:141) · `project_pages` (0015:43) · `project_module_page_runs` (0014:38) · `page_category` (0022:48) · `crawl_run_links.from_url/to_url` (0012:172) · `lpb_pages` |
| Issue / finding | **7** | `crawl_run_findings` (per-rule rollup, 0010:154) · `crawl_run_finding_instances` (per-occurrence, 0023:44) · `crawl_finding_reviews` (0010:179) · `crawl_runs.summary.findings` (legacy array, never dropped) · `project_module_runs.findings` jsonb (0012:82) · `project_module_page_runs.findings` jsonb (0014:66) · `recommendations` (0013:45) |
| Run | **5** | `tool_runs` (0008:71) · `crawl_runs` (0010:73) · `project_module_runs` (0012:55) · `project_module_page_runs` (0014:38) · an untracked pre-existing `runs` table (0008:67-70) |
| Approval lifecycle | **5** | `recommendations` · `ai_visibility_prompts` (0017:101) · `project_brands` (0018:79) · `project_domains.status` (0011:399) · `crawl_finding_reviews.review_status` (0010:186) — five different vocabularies |
| Claim/heartbeat/reap mechanism | **2** | `crawl_runs` (0010:80-89) vs `project_module_runs` (0019:65-85). `0019:17-19` states it copies CrawlScope's mechanism "rather than inventing a second one" — the result is a second one |
| Cron schedule on a project | **2** | `crawl_projects.cron` (0010:58) vs `project_module_schedules.cron` (0019:134) |
| Module-key vocabulary | **3 CHECK constraints** | `0012:117`/`0016:63`/`0017:84` · `0014:94` · `0019:169` — hand-synced, plus `MODULES` in `server/modules/projects/overview.js:26` |

**Key structural facts:**
- `crawl_projects` **is** the product's project row, retrofitted by 0011. `crawl_projects.url` is a "compatibility projection" of the primary domain (`0011:369-370`) with **no trigger or constraint** keeping it in step after the one-time backfill (`0011:430-459`).
- `project_pages` is the only durable page identity — `UNIQUE (project_id, canonical_key)`, stripping fragment, trailing slash and scheme (`0015:60-63`). `page_category` is project-scoped on the **raw** url with no FK to it, so one page has two independent rows that can disagree on spelling.
- `crawl_run_results` is run-scoped and wiped on retry (`server/modules/crawlScope/db/repo.js:717-724`).
- `crawl_finding_reviews` keys on `sha1(ruleId|url|targetUrl|detail)` truncated to 16 hex, scoped to a **run** — so triage does not survive the next crawl.
- `recommendations.source_run_id` → `project_module_runs` only. **A CrawlScope finding cannot become a recommendation.**
- `'technical'` is deliberately excluded from `project_module_runs`' module vocabulary (`0012:114-115`), so the dashboard permanently reads two run lineages.

---

## 4. Persistence split

| Backend | Modules | Survives deploy? |
|---|---|---|
| Supabase tables | crawlScope, projects, aiVisibility, identity/workspaces, runs | Yes |
| Supabase generic jsonb via `services/supabaseStore.js` | locationPageBuilder | Yes (but its tables are undefined here) |
| Atomic JSON files on local disk | contentArchitect, competitorAnalysis, marketPotential, onPageAudit, robotsMonitor | **No** |
| On-disk markdown | knowledge-base | Read yes, **writes no** |
| In-process `Map` | 9 route modules | **No — lost on restart** |

**Verified:** `.gitignore:16` is the bare pattern `data/`, which matches every `server/modules/*/data/` directory. `git ls-files` returns 0 for all five. `.dockerignore:25` is the bare pattern `data`, excluding them from the build context. `knowledge-base/` has 17 tracked files and is in neither ignore file — so it **ships** in the image but editor writes land on the container filesystem.

`server/modules/marketPotential/store.js:2` states "This app has no Postgres" — false for the rest of the app.

**The dashboard depends on two of these disk stores:**
- `server/modules/projects/moduleRunners.js:377` — `caStore = require('../competitorAnalysis/store')`
- `server/modules/projects/moduleRunners.js:640` — `caStore = require('../contentArchitect/store')`

In-memory session/job maps (25 total). Representative: `server/routes/keywordResearch.js:11,14`, `server/routes/articleEnhancement.js:21`, `server/routes/articleEnhancementLite.js:40`, `server/routes/articleRecommendation.js:10`, `server/routes/imageAltAudit.js:10,11`, `server/modules/contentArchitect/routes.js:14,20`, `server/modules/competitorAnalysis/routes.js:16,21,26`, `server/modules/onPageAudit/routes.js:8`, `server/modules/crawlScope/api/routes.js:72`, `server/services/jobStore.js:3`.

**Keyword Research persists nothing:** its only write is `sessions.set(token, …)` at `server/routes/keywordResearch.js:101`.

---

## 5. Background work

**12 distinct systems** on 4 mechanisms; **8 separate run records**.

| System | Mechanism | Table / store | Replica-safe |
|---|---|---|---|
| Module queue + worker | DB claim-poll | `project_module_runs` | Yes (CAS) |
| Module scheduler | croner + DB row | `project_module_schedules` | Yes |
| CrawlScope worker | DB claim-poll | `crawl_runs` | Yes (worker_id + slot uniq) |
| CrawlScope project scheduler | croner + DB row | `crawl_projects` | Yes |
| Cache purge | node-cron | `cache` | **No** |
| Robots Monitor scheduler | node-cron | disk JSON | **No** |
| Workspace purge sweeper | setTimeout/setInterval | `workspaces` | **No** |
| Stale-run sweeper | setInterval hourly | `tool_runs` + `project_module_runs` | **No** |
| `jobStore` registry | in-memory Map + GC | — | **No** |
| Detached fire-and-forget runs | bare IIFE | mixed | **No** |
| Per-module in-memory run maps | Map | — | **No** |
| SSE streams | 12 endpoints | — | **No** (11 of 12) |

- **2 claim queues:** `server/services/moduleQueue.js:115` and `server/modules/crawlScope/db/repo.js:336`. `moduleQueue.js`'s header states it "mirrors" the other "rather than inventing a second mechanism". Retry defaults differ (3 vs 2); env prefixes differ (`MODULE_QUEUE_*` vs `WORKER_*`).
- **2 cron libraries:** `croner ^8.1.2` (crawlScope) and `node-cron ^3.0.3` (cachePurge, robotsMonitor).
- **4 reapers, 3 liveness models, 2 of them on the same table.** `server/services/moduleQueue.js:204-219` carries an explicit filter and comment because its flat 10-minute window was reclaiming healthy ~22-minute inline audits.
- **9 fire-and-forget call sites** outlive their HTTP request; only the crawl manager is drained on shutdown (`server/server.js:479-483`).
- **Only 2 module keys** are registered on the queue: `server/services/moduleExecutors.js:132` exports `ai_visibility` and `competitor`. `server/modules/projects/routes.js:956` sets `QUEUED_MODULES = ['ai_visibility']`.
- `server/modules/projects/streamingAudit.js:62-65` records a measured ~612–637 s queue wait for manual crawls that matches `RUN_STALE_MS` almost exactly, and suspects manual runs are being rescued by stale recovery rather than claimed. **Unresolved.**

---

## 6. The project spine — what it already unifies

`server/modules/projects/` is 11,883 lines across 21 files.

| Fact | Evidence |
|---|---|
| Runnable modules | `moduleRunners.js:25` — `RUNNABLE = ['seo_geo','agent_readiness','competitor','hub_spoke','ai_visibility']` |
| Per-page audits | `moduleRunners.js:922` — `PAGE_AUDITS = { seo_geo, agent_readiness }` |
| Dashboard cards | `overview.js:26` — 6 entries (`technical`, `hub_spoke`, `competitor`, `seo_geo`, `ai_visibility`, `agent_readiness`) |
| Metered modules | `moduleRunners.js:32` — `METERED`; `DEFAULT_AUDIT_MODULES` excludes them (`:57`) |
| Page budget | `store.js` — `MAX_TARGET_PAGES = 10` |
| Direct calls into standalone tools | `moduleRunners.js:102` (seoGeoAudit), `:145` (agentReadinessAudit), `:1139` (aiVisibility/run) |
| Reads disk stores | `moduleRunners.js:377`, `:640` |
| Crawl reuse | `moduleRunners.js:638` (`crawlToArchitect`), `:935` (`crawledPages`) |
| Auth model | never done in the store — every function takes a resolved context from `services/projectAccess.js` (`store.js:11-14`) |

**CrawlScope shares the spine:** `server/modules/crawlScope/db/repo.js` reads and writes `crawl_projects` with the same `workspace_id` scoping (`:57`, `:229`), and `DELETE /api/crawl-scope/projects/:id` delegates to the projects store (`api/routes.js:696-720`).

---

## 7. Duplicate machinery — file-level

| Concern | Copies | Paths |
|---|---|---|
| Full site crawler | 2 | `server/modules/crawlScope/crawler.js`, `server/modules/contentArchitect/crawler.js` |
| Sitemap reader | 3 | `crawlScope/analyzer.js`, `robotsMonitor/sitemapCrawler.js`, `contentArchitect/sitemapDiscovery.js`, `competitorAnalysis/contentAnalysis/sitemapCrawler.js` (4 files, 3 implementations) |
| Open-web fetch of user URLs | **15** | `crawlScope/net/egress.js:17` (only SSRF-guarded), `contentArchitect/urlSafety.js:112` (second safety layer), `onPageAudit/dataCollector.js:44`, `robotsMonitor/sitemapCrawler.js`, `robotsMonitor/indexChecker.js:44`, `competitorAnalysis/contentAnalysis/sitemapCrawler.js:8`, `.../topPagesAnalyzer.js:9`, `utils/linkDiscovery.js`, `checks/seoGeoChecks.js:4`, `routes/articleEnhancement.js:4`, `routes/contentEnhancement.js:4`, `routes/imageAltAudit.js:4`, `routes/seoGeoAudit.js:5`, `routes/agentReadinessAudit.js:3`, `scripts/auditPages.js:19` |
| robots.txt honoured | **1 of 12** referencing files | only `crawlScope/crawler.js` (+ `robotsPatternCache` at `:998`) |
| HTML parsing (cheerio) | 14 files | incl. `checks/onpage.js`, `checks/seoGeoChecks.js`, `checks/contentEnhancementChecks.js`, `onPageAudit/auditor.js`, `contentArchitect/linkGraph.js` |
| Chrome launch + `findLocalBrowser()` | 5 | `services/scraper.js:5`, `checks/onpage.js:7`, `routes/agentReadinessAudit.js:11`, `services/competitorPdfGenerator.js:10`, `aiVisibility/captureEngines/browser.js:35` (only one that pools) |
| `puppeteer.launch` call sites | 6 | above + `services/scraper.js:259` |
| OpenAI client construction | 12 (`new OpenAI`) — 3 in the shared factory, **9 bypassing it** | `services/claude.js:8` (constructs OpenAI, not Anthropic), `services/gptAnalysisCA.js:6`, `marketPotential/openaiClient.js:15`, `locationPageBuilder/pipeline.js:235`, `routes/articleEnhancement.js:83`, `routes/articleRecommendation.js:86`, `routes/contentEnhancement.js:17`, `routes/imageAltAudit.js:799`, `routes/keywordResearch.js:137` |
| SEMrush HTTP clients | 4 | `services/semrush.js:18`, `services/semrushCA.js:14`, `services/semrushBalance.js:14`, `marketPotential/semrush.js:64,162` |
| SEMrush CSV parsers | 5 | above + `services/semrushUploadParser.js` (only one handling quoted fields/BOM) and `utils/semrushParser.js` (**dead**) |
| DataForSEO clients | 2 | `aiVisibility/dataForSeoClient.js:98` (fetch, tracks cost), `marketPotential/dataForSeo.js:115` (axios, does not) |
| PageSpeed clients | 2 | `services/pageSpeedCA.js:143` (batching, backoff, retry), `onPageAudit/dataCollector.js:54` (none) |
| Spend/quota trackers | 4 | `marketPotential/usageStore.js` (file ledger), `competitorAnalysis/unitCosts.js`, `competitorAnalysis/contentAnalysis/unitCosts.js`, `aiVisibility/budget.js` (**only one that checks before spending**) |
| Proxy systems | 2 | `crawlScope/net/egress.js:26` (`EGRESS_MODE`/`PROXY_URL`), `aiVisibility/captureEngines/proxyPool.js:280` (`AIV_PROXIES`) |
| `store.js` files | 7 | `locationPageBuilder/`, `aiVisibility/`, `competitorAnalysis/`, `contentArchitect/`, `marketPotential/`, `onPageAudit/`, `projects/` |
| `/init` → `/stream` SSE token bridge | 9 | `keywordResearch.js:11`, `articleRecommendation.js:10`, `articleEnhancement.js:21`, `articleEnhancementLite.js:40`, `imageAltAudit.js:10`, `locationPageBuilder.js:38`, `contentArchitect/routes.js:14,20`, `middleware/runTracking.js:37` |
| Server-side export builders | 18 | incl. 4 separate `.docx` endpoints and 2 `.xlsx` report endpoints |
| Scoring implementations | 14 | incl. `checks/seoGeoChecks.js`, `aiVisibility/scoring.js`, `contentArchitect/hubSelection.js`, `routes/agentReadinessAudit.js` |

---

## 8. Front end

180 files under `client/src`. 36 route paths in `client/src/App.jsx:92-142`; 36 page files; **1 dead** (`CompetitorAnalysisPage.jsx`).

| Concern | Count | Detail |
|---|---|---|
| Tool registries | **6** | `toolsMeta.js:13` (15 tools — the only live one) · `toolCatalog.js:21` (18 entries, 2 id-less stubs, **zero importers**) · `MacWindow.jsx:34` `TOOL_ICONS` (18 keys) · `runsApi.js:15` · `server/modules/projects/overview.js:31` · `App.jsx:92-141` |
| Orphan routes (no sidebar entry, no in-app link) | **4** | `/keyword-research-public`, `/content-enhancement`, `/robots-monitor`, `/location-page-builder/neuro` |
| API fetch wrappers | **11**, zero shared | `client/src/lib/*Api.js`; `onPageAuditApi.js` has none (5 raw fetches). Only `projectsApi.js:18` attaches status/code to the thrown Error |
| Pages calling `fetch()` directly | 19 of 36 | bypassing all lib clients |
| Shared UI components | 20 in `client/src/ui/` (1779 lines) | **10 of 36 pages import them**; 6 exports have zero consumers |
| Rival primitive sets | **6** (1674 lines) | `studio/primitives.jsx`, `seoGeo/primitives.jsx`, `seoGeo/report/reportKit.jsx`, `crawlScope/report/reportPrimitives.jsx`, `aiVisibility/reportPrimitives.jsx`, `marketPotential/boardBits.jsx` |
| `Eyebrow` | **byte-identical** in 2 files | `crawlScope/report/reportPrimitives.jsx:52`, `seoGeo/report/reportKit.jsx:47` |
| ScoreRing / StatusBadge / MetricTile | 4 / 5 / 6 | see rival sets above |
| Client-selection mechanisms | **5** | `lib/activeProject.js:15` (localStorage, 7 consumers) · `CompetitorAnalysisDashboardPage.jsx:132` · `RobotsMonitorPage.jsx:591` · `LocationPageBuilderPage.jsx:14` (`NEURO_CLIENT_ID`) · KB slug list |
| Hardcoded client slug list | **5 copies** | `KBContextSelector.jsx:3`, `ClientFeedbackPage.jsx:6`, `CreateKBPage.jsx:5`, `KBEditorPage.jsx:5`, `KnowledgeBasePage.jsx:17` |
| Design tokens | 146 | `client/src/index.css` `:root` and `[data-theme='dark']` |
| Code splitting | **none** | no `React.lazy`; all 35 pages statically imported (~21k lines in the initial bundle) while `MacWindow.jsx:12-16` claims routes are split |

---

## 9. Configuration and secrets

| Item | Count | Note |
|---|---|---|
| Distinct env vars read in code | **117** | 219 `process.env` call sites across 60+ files; no config module |
| Documented in `.env.example` | 58 | |
| **Undocumented** | **59** | incl. `PLATFORM_ADMIN_EMAILS`, `DATAFORSEO_LOGIN`/`_PASSWORD`, `CRAWL_ALLOW_PRIVATE_HOSTS`, `PROXY_URL` |
| Documented but read nowhere | 22 | incl. `SEO_USERNAME`/`SEO_PASSWORD`, all `COMP_RES_BETA_*`, all `GSC_*`, the Google Sheets trio |
| Per-module config files | 11 | |
| Numeric named constants in `server/` | ≥256 | floor, not total |
| Files holding live credentials in the working tree | **3** | `.env`, `.env.bak-20260905-190815`, `.env.bak-supabase-20260905-193431` — each 31–33 populated keys incl. a PEM private key. All gitignored and dockerignored; all still on disk |
| Hardcoded platform admin | `nikhil.ashok@position2.com` | `server/services/platformAdmin.js:30` |
| Hardcoded brand/domain literals | `Gentle Dental`, `gentledental.com`, `neurowellnessspa.com` | |
| Port disagreement | `.env.example:41` says 5001; code default and `client/vite.config.js:10` proxy say 5000 | following the example file breaks local dev |
| Cookie env name read both ways | `COOKIE_SAME_SITE` / `COOKIE_SAMESITE` | `server/routes/auth.js:75`; only the first is documented |

---

## 10. Dead code and stale documentation

**16 files unreachable** from runtime entry points, scripts and tests (transitive closure over 496 files; 480 reachable).

| Dead | Files |
|---|---|
| `client/src/pages/CompetitorAnalysisPage.jsx` + `client/src/components/competitorAnalysis/*` | 6 |
| `client/src/components/teamInsights/*` | 6 |
| `client/src/toolCatalog.js` | 1 |
| `client/src/components/project/ModuleDetailPanel.jsx` + `moduleDetailSections.jsx` | 2 |
| `server/utils/semrushParser.js` | 1 |

Also: `server/modules/aiVisibility/retention.js` and `server/modules/projects/hubSpoke.js` are reachable **only from tests** — the AI-visibility retention policy is never invoked at runtime.

**Unused declared packages (4):** `@crawlee/browser-pool`, `googleapis`, `rebrowser-patches` (server), `@types/file-saver` (client — there is no TypeScript in the repo). **Duplicated package:** `docx@^8.5.0` in both server and client.

**Test coverage:** 76 test files; `npm test --prefix server` runs 74. Not run: `server/checks/__tests__/seoGeo.test.js`, `server/services/__tests__/pageSpeedCA.test.js`.

**Contradictory documentation.** Four root documents give four accounts of what this repo is; three give three irreconcilable test totals (`HANDOFF.md:295` = 178; `sitewide-seo-platform-status.md:530` = 369; `audit-loop/config.json` = 184). `SERP_CONTENT_RESEARCHER_BUG_REVIEW.md` reviews a **different folder** (`C:\Users\nikhil.a\serp-content-researcher`) and cites modules that do not exist here. `README.md` still describes the single-tool product.

**No PRD in the repo.** 26 server files cite `PRD §…` section numbers; `find` for any `*prd*` file returns nothing. The specification those 26 files are written against is not in version control.

**Untracked-but-not-ignored top-level directories (5):** `.audit-runs` (59 files), `.claude` (3), `.review-build` (3), `.pytest-review-temp` (7), `audit-loop` (6). They inflate `git status` to 117 dirty paths.

**`modules/bulk-scraper/`:** 348 tracked files, ~340 of them scraped `.html`/`.json` from third-party client websites. `index.js` resolves `puppeteer-core` out of `../../server/node_modules` by absolute path and is referenced by nothing.

---

## 11. Verified counts, with method

| Claim | Value | How counted |
|---|---|---|
| HTTP endpoints | 253 | every `router.*`/`app.*` verb across all router files; prefixes resolved from `server/server.js:135-179` |
| Tables created | 36 | `grep 'create table'` across `supabase/migrations/*.sql` |
| Migration files | 21 | `ls supabase/migrations` (0006–0025, two 0009s) |
| Route paths | 36 (35 + catch-all) | `App.jsx:92-142` |
| Page files | 36; 1 dead | `ls client/src/pages/*.jsx` + import graph |
| Sidebar tools | 15 | `toolsMeta.js:13-49` |
| Dashboard-runnable modules | 5 | `moduleRunners.js:25` |
| Background systems | 12 | read every scheduler/worker/queue/SSE file |
| Run-record systems | 8 | 3 Postgres + 1 disk + 4 in-memory |
| Env vars read | 117 | `grep -rnoE 'process\.env\.[A-Za-z_]\w*'` + 6 literals in `crawlScope/shared/options.js` + `AIV_PROXIES` |
| Files nothing imports | 92 raw → 16 true dead | import graph over 496 files, then transitive DFS from real entry points |
| Crawl rule catalog | 96 | `require('./server/modules/crawlScope/issue-catalog.json').length`; agrees with `audit-loop/rules/rule-classes.json` |
| Open-web fetchers | 15 | files fetching user-supplied URLs |
| SEMrush clients / parsers | 4 / 5 | axios wrapper constructions; `split(';')` row parsers |
| File stores excluded from deploy | 5 | `git check-ignore -v` (`.gitignore:16` `data/`) + `.dockerignore:25` |

---

## 12. Suggested build order — technical

1. **Stage 1** — move `contentArchitect`, `competitorAnalysis`, `marketPotential`, `onPageAudit`, `robotsMonitor` and `kbStore` off disk. Reuse `services/supabaseStore.js`'s generic jsonb pattern for the first pass; give `onPageAudit` and `robotsMonitor` real tables. Back up `server/modules/*/data/` and `knowledge-base/` before switching. Then replace the 25 in-memory `Map` stores with a `saved_results` record.
2. **Stage 2** — `workspace_id` + `project_id` onto every module's records. Delete the four rival client models. Lift `resolveIdentity` into one middleware ahead of every workspace-aware mount.
3. **Stage 3** — expose `crawl_run_results` through a read API; convert the seven fetchers in dependency order. Route residual fetches through `crawlScope/net/egress.js`.
4. **Stage 4** — stable finding identity independent of `run_id`; widen `recommendations.source_run_id` to accept a crawl finding; one `project_keywords` table replacing the three keyword homes.
5. **Stage 5** — writing tools write results against `project_id`; map the five hardcoded KB slug lists onto projects.
6. **Stage 6** — retire `services/moduleQueue.js`/`moduleWorker.js` in favour of the CrawlScope claim mechanism; move the four in-memory job registries to `project_module_runs`; one client per provider; collapse the six tool registries into `toolsMeta.js`.
7. **Stage 7** — one report assembler; delete the 16 dead files, `modules/bulk-scraper/output`, the stale root documents and the duplicate `.env.bak-*` files.

Next: [Open questions](07-open-questions.md)
