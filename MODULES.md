# App Modules

This document catalogs every module/feature in the SEO/GEO toolkit: what it does, how it works, and which files implement it. It's a companion to `README.md` (setup + run tracking) and `agent-readiness-module.md` (deep dive on that one module).

## Tech Stack

- **Root**: monorepo runner. `concurrently` runs the server (Express + nodemon) and client (Vite/React) together in dev; `npm run build` builds the client into `client/dist`, which Express serves statically in production.
- **Server** (`server/`): Node/Express. Key deps: `express`, `express-rate-limit`, `cors`, `cookie-parser`, `jsonwebtoken`, `google-auth-library`/`googleapis` (OAuth), `@supabase/supabase-js` (persistence), `axios` + `cheerio` (HTTP fetch/HTML parsing), `puppeteer-core` + `@sparticuz/chromium` (headless Chrome scraping/PDF), the `openai` SDK (used both for OpenAI and, via OpenAI-compatible endpoints, Anthropic/Gemini), `docx`/`exceljs`/`pptxgenjs` (document export), `gray-matter` (markdown frontmatter for the knowledge base), `fast-xml-parser`, `node-cron`.
- **Client** (`client/`): React + Vite, `react-router-dom`. Runs embedded as a cross-origin iframe inside a parent "Position2 Intelligence Platform" shell (`RouteBridge`/`notifyRouteChange` in `App.jsx`).

**Route map** (`client/src/App.jsx`): `/`, `/content-research`, `/keyword-research`, `/keyword-research-public`, `/kb`, `/kb/new`, `/kb/audit`, `/kb/feedback/new`, `/kb/:id`, `/article-recommendation`, `/image-alt-audit`, `/agent-readiness-audit` (+`/summary`), `/seo-geo-audit`, `/seo-geo-snapshot`, `/content-enhancement`, `/article-enhancement`, `/article-enhancement-lite`, `/location-page-builder` (+`/wizard`, `/gentle-dental-pages`, `/:id`), `/robots-monitor`, `/on-page-audit`, `/market-potential`, `/competitor-analysis` (Dashboard page), `/workspaces`, `/runs`. The app gates on auth: `LoginPage` while unauthenticated, `ProfileSetupPage` until a profile exists, then the real app.

---

## 1. Content Research

**Purpose:** For a keyword, find the top-10 Google-ranking pages, scrape them, and have an LLM synthesize a structured content brief (H2 sections + recommendations, word-count benchmark, semantic keywords, content gaps).

**How it works:**
1. `POST /api/search` (`routes/search.js`) → `services/googleSearch.js` `searchGoogle()` — queries the Google Custom Search API (`GOOGLE_API_KEY`/`GOOGLE_CX`), falling back to Serper.dev (`SERPER_API_KEY`) on quota/429/403/network failure or once the 100/day Google quota is hit. Tracks a daily in-memory counter.
2. `POST /api/scrape` (`routes/scrape.js`, max 10 URLs) → `services/scraper.js` `scrapeUrls()` — Puppeteer (falls back to a locally installed Chrome/Edge), concurrency-capped at 3, 15s/page timeout, spoofs a "Screaming Frog SEO Spider" user agent, truncates body content to 5000 chars.
3. `POST /api/analyze` (`routes/analyze.js`) → `services/claude.js` `analyzeContent()` (despite the filename, currently calls OpenAI `gpt-4o-mini`) — builds a prompt from scraped pages plus optional knowledge-base context, returns `{ sections, wordCountBenchmark, semanticKeywords, contentGaps }`.
4. `POST /api/export/docx` (`routes/export.js`) — builds a formatted Word document with the `docx` package.

**Key endpoints:** `POST /api/search`, `GET /api/search/count`, `POST /api/scrape`, `POST /api/analyze`, `POST /api/export/docx`.

**Key files:** `client/src/pages/ContentResearchPage.jsx`; `server/routes/{search,scrape,analyze,export}.js`; `server/services/{googleSearch,scraper,claude}.js`.

---

## 2. Keyword Research

**Purpose:** Given a seed keyword, produce exactly 2 primary + 10 secondary keyword recommendations backed by real competitor ranking data, with an explicit informational/commercial intent lens.

**How it works** (`routes/keywordResearch.js`, SSE `POST /init` → `GET /stream/:token`, 2-minute token TTL):
1. **Variant generation** — GPT generates 5 intent-scoped query variants (informational/commercial) alongside the seed.
2. **SERP fan-out** — runs all 6 queries through `googleSearch.searchGoogle`, batched 3 at a time, with a 24h in-memory SERP cache.
3. **URL scoring/selection** — aggregates URLs across all SERPs, caps 2 URLs/domain, scores by position (35%), page-type (30%, penalizes blog/article/directory URLs), keyword-title intent alignment (20%), conversion-word presence (15%); takes the top 10.
4. **SEMrush keyword extraction** — `services/semrush.js` `getUrlKeywords()` pulls up to 30 ranking keywords per URL (3 concurrent), deduping by keyword string and tracking how many of the top-10 pages rank for it.
5. **Composite scoring** — GPT scores each keyword's semantic alignment (0–10) to the seed; composite = 80% alignment + 20% normalized volume.
6. **Primary/secondary selection** — a model selects exactly 2 primaries + 10 secondaries under detailed rules (topical completeness, intent alignment, mutual distinctiveness, a hard-rejection list for branded/navigational/duplicate/volume-trap terms), optionally augmented by knowledge-base context.
7. **Validation pass** — a second call re-audits the selection against the same rules and can replace failing keywords from the full pool, or return an `insufficient` verdict with a user-facing warning rather than settle for a bad match.

**Key endpoints:** `POST /api/keyword-research/init`, `GET /api/keyword-research/stream/:token`.

**Key files:** `client/src/pages/{KeywordResearchPage,KeywordResearchPublicPage}.jsx`; `server/routes/keywordResearch.js`; `server/services/{semrush,googleSearch,kbLoader}.js`.

---

## 3. Article Recommendation

**Purpose:** Produce a full article content brief (H1/H2/H3 outline with writing instructions, keywords, FAQs) modeled on the top-10 ranking pages for a keyword.

**How it works** (`routes/articleRecommendation.js`, SSE `/init` → `/stream/:token`, 5-minute TTL):
1. Google-search the top 10 for the keyword.
2. `scrapeUrlsDetailed()` extracts title/H1/H2s/H3s/H4s/FAQs/body excerpt per page, with progress callbacks.
3. An LLM analyzes cross-page patterns → common H2/H3 topics, recurring angles, FAQ patterns, content gaps, NLP keywords, structural patterns.
4. The LLM generates the full brief (H1→H2→H3 markdown structure, writing instructions + keywords per section, visual-opportunity flags, FAQ section, reference URLs), optionally with a knowledge-base context suffix.
5. **Theme-alignment QA pass** — a follow-up call judges whether every section stays on-theme for the seed keyword; if not aligned, it triggers a realignment rewrite grounded only in the scraped competitor content (no invented facts).

**Key endpoints:** `POST /api/article-recommendation/init`, `GET /api/article-recommendation/stream/:token`.

**Key files:** `client/src/pages/ArticleRecommendationPage.jsx`; `server/routes/articleRecommendation.js`.

---

## 4. Content Enhancement

**Purpose:** Audits an existing page/article for E-E-A-T, GEO, and evidence gaps (statistics, credentials, citations), and generates enhancement suggestions with sourced evidence.

**How it works** (`routes/contentEnhancement.js`, `POST /run`, synchronous JSON):
1. Fetches the URL via axios (spoofed UA) or accepts pasted HTML.
2. `checks/contentEnhancementChecks.js` (`runContentEnhancementChecks`) — a cheerio-based rule engine detecting schema blocks, authoritative-domain citations, healthcare credentials, structural entities (definition/symptoms/causes/treatment/FAQ), and statistic patterns.
3. For flagged gaps, an evidence-enrichment step runs `googleSearch.searchGoogle()` to find supporting evidence from real external pages, extracting and scoring the best matching sentences (percentage stats, ranges, prevalence/incidence language).
4. An LLM turns the findings into structured content recommendations.

**Key endpoints:** `POST /api/content-enhancement/run`.

**Key files:** `client/src/pages/ContentEnhancementPage.jsx`; `server/routes/contentEnhancement.js`; `server/checks/contentEnhancementChecks.js`.

---

## 5. Article Enhancement (full) + Article Enhancer (Lite)

**Purpose:** Enhance an existing article in place — add missing structure, coverage, and (full version only) evidence-backed statistics/citations — returning an HTML diff with new content highlighted, plus a downloadable `.docx`.

**How it works** (`routes/articleEnhancement.js`; `articleEnhancementLite.js` reuses its exported helpers):
- **Full (`article-enhancement`)**: crawls the article (with a manual-paste fallback if crawling yields too little text), extracts theme/query, runs multi-model analysis — the user can pick from several analysis models — for SERP/competitor research and 5-dimension SEO/GEO/E-E-A-T scoring. A single fixed writer model performs all actual content edits. When multiple analysis models are selected, `services/llmSynthesis.js` merges their independent outputs into one document on the writer model. Inserts statistics, expert quotes, and citations sourced via `googleSearch`.
- **Lite (`article-enhancement-lite`)**: same crawl/theme/writer pipeline but explicitly **no SERP/SEMrush research** and **verified-only changes** — never fabricates statistics/citations; every edit must be traceable to the article's own existing text (answer-first rewrites, self-contained context, prose→list/table restructuring, FAQs answerable from the body).
- Both support pluggable writer models via `services/llmProviders.js`, which normalizes OpenAI, Anthropic, and Google models behind one OpenAI-SDK-shaped client (Anthropic/Gemini are addressed through their OpenAI-compatible endpoints; JSON mode is enforced via a system-prompt instruction plus markdown-fence stripping, since those providers don't honor `response_format`).

**Key endpoints:** `POST /api/article-enhancement/init`, `GET /api/article-enhancement/stream/:token`, `POST /api/article-enhancement/export/docx`; the same trio under `/api/article-enhancement-lite`.

**Key files:** `client/src/pages/{ArticleEnhancementPage,ArticleEnhancementLitePage}.jsx`; `server/routes/{articleEnhancement,articleEnhancementLite}.js`; `server/services/{llmProviders,llmSynthesis}.js`; `modules/article-enhancement*/manifest.json`.

---

## 6. SEO & GEO Audit (+ Snapshot)

**Purpose:** Deep on-page SEO + "Generative Engine Optimization" (LLM-answer readiness) audit of a single URL/pasted HTML — schema validation, E-E-A-T signals, content structure, keyword targeting — with an AI-written expert report layered on top of a deterministic rule engine.

**How it works** (`routes/seoGeoAudit.js`, SSE `POST /run`):
1. **Fetch** the URL (axios) or accept pasted HTML.
2. **`checks/seoGeoChecks.js` `runAllChecks()`** — a large cheerio rule engine producing dozens of checks, each with a status (pass/fail/warning/notice/informational/na/skipped) and severity. Detects JSON-LD schema blocks, promotional-language ("puffery") with substantiated-claim exceptions, credential patterns, statistic patterns (excluding phone numbers/zip codes/prices/times), non-descriptive anchor text, authoritative outbound links. Produces weighted scores across 9 buckets (title/meta, content structure, indexability, schema, GEO signals, E-E-A-T, technical, links/media, keyword) plus page context (detected type, YMYL flag, vertical, intent).
3. **AI page-type classification** — when rule confidence is low and no intent was declared, a model call classifies page type to refine intent inference.
4. **AI expert report** — a "senior SEO/GEO strategist" persona receives only the notable checks, page context, schema recommendations, and score breakdown; produces narrative findings, prioritized quick-wins, and schema JSON-LD templates. Intent-aware: commercial pages get GEO-lever recommendations (LocalBusiness schema, review markup, FAQ schema), informational pages keep citation/statistic/authorship recommendations. The Snapshot page is a lighter/condensed view of the same run.

**Key endpoints:** `POST /api/seo-geo-audit/run` (SSE).

**Key files:** `client/src/pages/{SeoGeoAuditPage,SeoGeoSnapshotPage}.jsx`; `server/routes/seoGeoAudit.js`; `server/checks/seoGeoChecks.js`; CLI regression runner `server/scripts/auditPages.js`.

---

## 7. Agent Readiness Audit (+ Summary)

*(Fully documented in `agent-readiness-module.md`; summarized here.)*

**Purpose:** Scores a website 0–100 on readiness for AI-agent traffic (crawlers, LLM browsing agents, MCP clients) across HTTP infrastructure, bot access, API/auth discoverability, and live browser-rendered on-page signals.

**How it works:**
- **13 HTTP checks** (always run, no browser) — robots.txt, sitemap, RFC 8288 Link headers, markdown content negotiation, AI-bot rules (GPTBot/ClaudeBot/PerplexityBot/etc.), Content-Signal directive, `.well-known` discovery for web-bot-auth/API catalog (RFC 9727)/OAuth/OAuth-protected-resource/MCP server card/agent-skills index/WebMCP.
- **10 on-page checks** (Puppeteer, run when action/form URLs are supplied) — form label association, input type correctness, autocomplete, Schema.org SearchAction/transactional actions, CAPTCHA detection, cookie-banner accessibility, a JS-rendering gap check (raw HTML vs. rendered DOM), vague button labels, interactive-div-without-role detection.
- Combined score blends the HTTP score with the on-page score proportionally when action/form URLs are supplied.
- A **CMO Executive Brief** generates a business-level headline/summary/top-risk/60-day-opportunity/competitive-context narrative.
- **PDF export** renders an HTML report template to PDF via server-side Puppeteer.

**Key endpoints:** `GET /api/agent-readiness-audit/discover-links`, `POST /api/agent-readiness-audit`, `POST /api/agent-readiness-audit/stream` (SSE), `POST /api/agent-readiness-audit/pdf`.

**Key files:** `client/src/pages/{AgentReadinessAuditPage,AgentReadinessSummaryPage}.jsx`; `server/routes/agentReadinessAudit.js`; `server/checks/onpage.js`; `agent-readiness-module.md`.

---

## 8. On-Page Audit

**Purpose:** Async, job-tracked on-page SEO audit against a URL + primary keywords — a dedicated module (distinct from SEO & GEO Audit) with its own store/history.

**How it works:** `POST /api/on-page-audit/run` creates an in-memory job ID and fires the audit in the background (fire-and-forget; the response returns immediately). A data collector fetches/collects page data, a page-type detector classifies the page, and the auditor runs checks and persists results. Progress is polled via a status endpoint; results are fetched by audit ID. A run-tracking "deferred" pattern closes the tracked run row when the async work settles, not when the response returns.

**Key endpoints:** `POST /api/on-page-audit/run`, `GET /api/on-page-audit/status/:jobId`, `GET /api/on-page-audit/result/:auditId`, `GET /api/on-page-audit/list`, `DELETE /api/on-page-audit/:auditId`.

**Key files:** `client/src/pages/OnPageAuditPage.jsx`; `server/modules/onPageAudit/{routes,auditor,dataCollector,pageTypeDetector,store}.js`; `server/checks/onpage.js` (shared with Agent Readiness).

---

## 9. Image Alt Audit

**Purpose:** Crawls a site (or list of pages) for images, classifies each by section/context, and generates SEO-appropriate `alt` text recommendations, exportable to Excel.

**How it works** (`routes/imageAltAudit.js`, SSE `/init` → `/stream/:token`):
1. A cheerio-based DOM walk finds `<img>` tags, resolves CDN folder IDs, and infers the surrounding section by walking up ancestor levels looking for headings (including sibling-heading patterns common in Webflow sections).
2. Filters out generic CTA anchor text ("View All", "Book Now", etc.) so it never becomes the inferred image subject.
3. An LLM generates alt-text suggestions per image, batched with configurable concurrency; client-specific brand name/location suffix/prefixes can be injected (blank by default — the tool is site-agnostic).
4. Exports results to `.xlsx` via ExcelJS; downloads served via a token.

**Key endpoints:** `POST /api/image-alt-audit/init`, `GET /api/image-alt-audit/stream/:token`, `GET /api/image-alt-audit/download/:token`.

**Key files:** `client/src/pages/ImageAltAuditPage.jsx`; `server/routes/imageAltAudit.js`.

---

## 10. Competitor Analysis (two distinct systems)

### 10a. One-off PPTX Report (`CompetitorAnalysisPage.jsx` → `/api/competitor-analysis`)

**Purpose:** Auto-discovers organic SEO competitors for a brand/domain and generates a branded PowerPoint competitive analysis deck.

**How it works:**
1. `POST /discover` — pulls organic competitors from SEMrush for a country/database, then an LLM filters to true business competitors (same market/segment/products) and classifies competitor type; results are ranked by competition level and capped.
2. `POST /run` — kicks off a full analysis asynchronously via an in-memory job/event store (2h auto-cleanup); pulls SEMrush data, Core Web Vitals for all domains (batched/staggered to respect PageSpeed Insights' burst quota), and generates a narrative summary.
3. `GET /progress/:jobId` (SSE) streams job events; `GET /export/:jobId` produces the deck.
4. Also supports a manual-upload flow that parses SEMrush's UI-exported CSVs (handling delimiter/BOM/quoting variance).

**Key endpoints:** `POST /discover`, `POST /run`, `GET /progress/:jobId`, `GET /export/:jobId`, `GET /countries`, `POST /prepare`, `POST /run-manual`.

### 10b. Competitor Tracker / Dashboard (`CompetitorAnalysisDashboardPage.jsx` → `/api/competitor-tracker`)

**Purpose:** An ongoing, persisted competitor-tracking dashboard per client — ranking/traffic snapshots, Core Web Vitals, and a "Content Analysis" view (top-pages content mix + sitemap structure), refreshable independently to control SEMrush unit spend.

**How it works:**
- Client + competitor CRUD, with automatic competitor-discovery suggestions.
- `POST /clients/:id/run` — fire-and-forget SEMrush + PageSpeed fetch, persisted as a snapshot; unit-cost estimation/capping keeps a hard budget per run.
- `POST /clients/:id/run-pagespeed` — PageSpeed-only refresh (no SEMrush spend), force vs. 7-day-cache modes.
- **Content Analysis** — crawls the sitemap + top pages, an LLM classifies folder→page-type mapping (user overrides persist across re-runs), with a separate SEMrush sub-budget.
- `POST /clients/:id/export` — synchronous PDF export with cached narrative generation.
- Real vs. mock data source is selectable, gated on whether a live SEMrush key is configured.

**Key endpoints:** `GET /meta`, `GET/POST/PATCH/DELETE /clients[/:id]`, `POST /clients/:id/discover-competitors`, `GET /clients/:id/dashboard`, `POST /clients/:id/run[-pagespeed]`, `GET /clients/:id/run[-pagespeed]/status`, `GET/POST /clients/:id/content-analysis[...]`, `POST /clients/:id/export`.

**Key files (both systems):** `client/src/pages/{CompetitorAnalysisPage,CompetitorAnalysisDashboardPage}.jsx`; `server/routes/competitorAnalysis.js`; `server/services/{gptAnalysisCA,pageSpeedCA,semrushCA,competitorPdfGenerator,pptxGenerator,jobStore,semrushUploadParser}.js`; `server/modules/competitorAnalysis/{routes,store,provider,dataFetcher,discovery,gapAnalysis,reportExport,realProvider,mockProvider,unitCosts,contentAnalysis/orchestrator}.js`.

---

## 11. Market Potential (Beta)

**Purpose:** For a healthcare (or similar) business, compares search-demand "market potential" for a service across a home market vs. candidate adjacent/expansion metro regions, using a curated keyword "basket" indexed to the home market = 100.

**How it works** (`server/modules/marketPotential/routes.js`, mounted at `/api/market-potential`):
1. **Service + basket setup** — a service is created/loaded; if no frozen keyword basket exists, an LLM drafts candidate terms for human review, which can then be edited and frozen (locking/versioning it — editing after freeze bumps the version).
2. **Geo resolution** — never auto-picks an ambiguous location; always returns candidates for human confirmation.
3. **Adjacency suggestion** — pure radius-based geometry around the home geo(s).
4. **Compare (fetch + rank)** — cache-first per (geo, month); a provider abstraction hits either SEMrush ("templated" method) or DataForSEO ("geo-targeted" method); enforces a same-geo-unit rule across compared regions, a max-regions-per-run cap, and hard per-run/daily SEMrush unit budgets with an atomic reserve/reconcile pattern so a failed fetch releases its reservation. Also fetches "competitor density" (how many distinct domains rank for head terms in that metro) classified against the client's own domain.
5. **Executive summary** — an LLM-generated summary (with a deterministic fallback), cached by a hash of the run signature so repeat views never re-bill.
6. **Scenarios** — save/version named comparisons for reproducibility.

**Key endpoints:** `GET /meta`, `GET /usage`, `GET /geo/search`, `GET /geo/all`, `POST /service/resolve`, `POST /service/:id/basket/propose`, `PUT /service/:id/basket/draft`, `POST /service/:id/basket/freeze`, `POST /adjacency`, `POST /compare`, `POST /summary`, `GET/POST/DELETE /scenarios[/:id]`.

**Key files:** `client/src/pages/MarketPotentialPage.jsx`; `server/modules/marketPotential/{routes,store,geoData,basketAgent,ranking,provider,dataForSeo,semrush,competitorTaxonomy,summaryAgent,usageStore,openaiClient}.js`.

---

## 12. Robots Monitor

**Purpose:** Scheduled monitoring of client domains' robots.txt / sitemap / indexability status, with Slack alerting on regressions.

**How it works:**
- Client/domain CRUD; domains are validated to be subdomain-only (no subfolder path) and tagged production/staging, with optional basic-auth credentials for staging.
- A sitemap crawler and an index checker do the actual checks; a page-type classifier classifies discovered URLs.
- A scheduler runs checks on a cron schedule (`node-cron`), configured via a Slack webhook URL, timezone, and time-of-day; a Slack notifier posts alerts, with a test-message endpoint.
- Manual checks can be triggered on demand (fire-and-forget, tracked-run pattern) and polled for status; history of past runs is available.

**Key endpoints:** `GET/POST/PATCH/DELETE /clients[/:id]`, `POST/PATCH/DELETE /clients/:id/domains[/:id]`, `GET/PUT /slack-config`, `POST /slack-config/test`, `POST /run`, `GET /run/status`, `GET /history[/:id]`.

**Key files:** `client/src/pages/RobotsMonitorPage.jsx`; `server/modules/robotsMonitor/{routes,monitorStore,monitorRunner,monitorScheduler,sitemapCrawler,indexChecker,pageTypeClassifier,slackNotifier}.js`.

---

## 13. Location Page Builder (most complex module)

**Purpose:** A structured, multi-stage pipeline for generating SEO location+service landing pages at scale for multi-location businesses. It has two sub-flows: a heavyweight, fully-audited pipeline (used for Neuro Wellness Spa) with SERP/SEMrush keyword mining → LLM content generation → multi-gate human approval → export, and a lightweight, single-call Gentle Dental Wizard for high-volume dental location pages.

**Architecture:** "Page = L1 (global template) + L2 (location data, pulled) + L3 (service content, generated)." File-store backed, feature-flagged, with generic CRUD for reference data (clients, services, locations, providers, reviews, insurance sets, resources, tone profiles, global templates).

### Full pipeline (11 stages):
1. **Eligibility** — a page can only be generated for a GBP-verified location that actually offers the service (a doorway-page guardrail).
2. **Seed generation** — builds seed query variants: `[service] [city]`, "near me", nearby-area variants, metro/region/state variants, commercial modifiers (best/affordable/emergency/24-hour), semantic sub-service variants.
3. **SERP + competitor ranking** — parallel Google searches (24h cache), scoring each ranking URL by ranking frequency, page-type/location/service match, conversion intent, and organic position, capped at 2 URLs/domain, bucketed into "own footprint" / "discovery only" / "model after" (the last feeds content generation).
4. **SEMrush keyword extraction** — per-URL ranking keywords, deduped into a master pool, flagging low-volume "locally relevant" near-me/geo terms.
5. **LLM relevance/prioritization** — classifies the pool into primary (≤2, at least one location-bearing), secondary (≤10), and thematic buckets (local modifier, semantic, FAQ, internal linking, informational-low, excluded); retries once on invalid output; cached by service+location+keyword-set hash.
6. **Human keyword editing/finalize.**
7. **Content generation** — scrapes up to 5 "model after" competitor URLs for structural (not copy) modeling, builds the L1+L2 scaffold (never copies NAP from scraped pages), then an LLM fills unique page copy, merged into the scaffold.
8. **Internal links + schema generation.**
9. **QA engine** — blocking vs. warning checks: hero image actually matches the selected location, NAP matches the L2 record exactly, URL/canonical use correct slugs, meta title/H1 mention both service and location, FAQ visible content exactly mirrors FAQPage schema, review-rating schema only reflects approved real reviews, cross-page content similarity and competitor-overlap checks catch duplicate/templated content.
10. **Approval workflow** — sequential gates (SEO → clinical for YMYL content → content → client), each owned by a role; editing content after a gate clears resets that gate and everything downstream; admins can override any gate (logged).
11. **Export/versioning** — JSON/Markdown/DOCX export; every export snapshots an immutable version.

### Gentle Dental Wizard (separate, lighter flow):
- No approval workflow, no SSE — a single synchronous call. Candidate keywords come from a client-specific keyword universe (which can be seeded from a pre-scored keyword CSV via a CLI import script).
- Generation researches real competitors for the primary keyword (scrapes top non-Gentle-Dental results for headings/FAQs, cached, falls back to LLM-only on failure), builds a dental-specific scaffold, generates content in one LLM call, builds dental schema, and runs dental-specific QC.
- Enforces exactly one page per (client, service, location) tuple — regeneration always upserts, never duplicates.
- A section-level regenerate endpoint can redo just one part (hero intro, meta description, one educational block, all educational body, FAQs, or one FAQ item) without re-billing the whole pipeline.
- Has its own page listing, separate from the Neuro Wellness list.

**Key endpoints:** endpoints under `/api/location-page-builder/`, including `seed`, `seed-gentle-dental`, `clients[/:id]`, `entities/:collection[/:id]`, `pages[/:id]`, `pages/:id/{keywords/run, content/run}`, `stream/:token`, `pages/:id/keywords[/finalize]`, `pages/:id/{section,content,qa,content/regen-field}`, `pages/:id/{gate,comments}`, `keyword-candidates`, `wizard/{generate,existing,regenerate,pages[/:id],qc}`, `pages/:id/export/:format`, `pages/:id/preview/:format`.

**Key files:** `client/src/pages/{LocationPageBuilderPage,LocationPageDetailPage,LocationServiceWizardPage,GentleDentalPagesPage}.jsx`; `server/routes/locationPageBuilder.js`; `server/locationPageBuilder/{config,store,seed,compose,pageService,pipeline,contentGenerator,dentalWizard,qaEngine,approval,schemaGenerator,exporter,keywordAdapter,keywordUniverseMap,keywordUniverseStore,internalLinks,geo,text,urlBuilder,categoryLogic,llmParams}.js`.

---

## 14. Knowledge Base

**Purpose:** A markdown-file-backed knowledge base system (brand, industry, client-feedback, best-practices categories) that every content-generating module can pull structured context from, plus an editor UI and a health-check/audit view.

**How it works:**
- Storage: `knowledge-base/` at the repo root — an index catalog plus per-category subfolders of markdown files with YAML frontmatter, each carrying a version, category, client, active flag, and a changelog appended on every edit.
- `services/kbStore.js` does CRUD over the file store (auto-increments patch version + appends changelog on write) and also reads/writes the `modules/*/manifest.json` module registry (each manifest declares module ID, label, description, required/optional KB dependency patterns like `brand/{client}`, `industry/{client-industry}`, `client-feedback/{client}`, output format, client scope, active flag).
- `services/kbLoader.js` `loadKBContext(moduleId, clientSlug, feedbackKbIds)` resolves a module's manifest KB patterns for a given client, loads them (skipping inactive/missing), auto-selects the most recent client-feedback KB when none is specified, computes a confidence level based on what loaded vs. was missing, and builds a ready-to-append system-prompt suffix (ordered industry → brand → client-feedback → best-practices) framed as low-priority supplemental context that must never override primary SERP/keyword-driven decisions. Every content module calls this the same way.
- The KB Context route resolves brand/industry/feedback-option metadata for the editor UI.
- The Audit route cross-references every module's required/optional KBs against the KB index, flagging errors (required KB missing/inactive), warnings (optional missing/inactive), and info (orphaned KB with no linked modules).

**Key endpoints:** `GET/POST/PUT/DELETE /api/kb[/:id]`, `PATCH /api/kb/:id/toggle`, `GET/PUT /api/modules[/:id]`, `GET /api/kb-context`, `GET /api/audit`.

**Key files:** `client/src/pages/{KnowledgeBasePage,CreateKBPage,KBEditorPage,ClientFeedbackPage,ModuleAuditPage}.jsx`; `server/routes/{kb,kbContext,modules,audit}.js`; `server/services/{kbStore,kbLoader}.js`; `knowledge-base/` (data), `modules/*/manifest.json` (registry).

---

## 15. Workspaces

**Purpose:** Multi-user, shared workspaces that scope run history and team collaboration; each user has a default personal workspace and can be invited into shared ones.

**How it works:**
- List the caller's workspaces and which is active.
- Activating a workspace is membership-checked every time, sets a 30-day cookie, and updates an in-memory cache.
- Owners can create workspaces and manage members; removing a member invalidates their cached active-workspace resolution.
- `services/workspaceContext.js` is the single place deciding which workspace a request's work belongs to: it trusts the workspace cookie only after re-verifying membership, otherwise falls back to (or creates) the user's personal workspace. A short TTL cache plus in-flight-promise dedup means steady-state resolution costs no extra queries. Platform-embed (iframe) sessions resolve to one synthetic shared user/workspace.

**Key endpoints:** `GET /api/workspaces`, `POST /api/workspaces`, `POST /api/workspaces/:id/activate`, `GET /api/workspaces/:id`, `POST/DELETE /api/workspaces/:id/members[/:userId]`.

**Key files:** `client/src/pages/WorkspacesPage.jsx`; `server/routes/workspaces.js`; `server/services/{identityStore,workspaceContext}.js`.

---

## 16. Runs / Run Tracking

*(Documented in detail in the root `README.md`; summarized here.)*

**Purpose:** A unified, cross-module audit trail of every tool invocation ("run") — who ran what, on what input, with what result, scoped to a workspace.

**How it works:**
- A single middleware, installed once per API mount, observes request/response instead of every route being individually instrumented. It handles three run shapes: simple JSON request→response; `POST /init` → SSE `/stream/:token` (input bridged by token, outcome read from the terminal SSE event); and response-returns-early/work-continues-in-background (the module explicitly finishes or fails the run when the real work settles).
- A single declarative registry (`server/config/runTracking.js`) lists which endpoints of which module count as a run; a test fails if a matcher stops corresponding to a real route.
- The run store sanitizes/redacts payloads before storage: credential-shaped keys are redacted, content blobs are replaced with size markers, long strings are truncated with a preview, large arrays are sampled, depth and total payload size are capped. It never throws into the caller. A sweep on boot and hourly closes any run left "running" for more than 2 hours (crash/deploy protection).
- Runs are readable by workspace membership, with filtering and per-tool stats.

**Key endpoints:** `GET /api/runs`, `GET /api/runs/stats`, `GET /api/runs/:id`.

**Key files:** `client/src/pages/RunsPage.jsx`; `server/routes/runs.js`; `server/middleware/runTracking.js`; `server/config/runTracking.js`; `server/services/runStore.js`.

---

## 17. Auth / Profile / Login

**Purpose:** Google OAuth sign-in restricted to an allowlist/domain, JWT session cookie, mandatory post-login profile setup, plus a silent auto-login path for the parent platform iframe embed.

**How it works:**
- Google OAuth consent → callback exchanges the code, verifies the ID token, checks it against an explicit allowed-email list or allowed-domain suffix (open to anyone if neither is configured), creates/updates the user record, and signs a 7-day JWT into an httpOnly session cookie.
- A verify endpoint validates the cookie and resolves whether a profile exists.
- Auth middleware verifies the JWT, attaches the user to the request, and fires a non-blocking activity-recording call using only the already-cached workspace.
- A role check restricts certain raw endpoints (Content Research's search/scrape/analyze/export, the legacy Competitor Analysis PPTX route) to an "seo" role.
- A platform-login endpoint provides silent auto-login for the iframe embed when a shared platform token matches.
- Profile company is force-locked to "Position2" server-side for company emails, regardless of client input.
- Any page load carrying the platform token as a query parameter is intercepted before React renders, to set the session cookie and redirect to a clean URL.

**Key endpoints:** `GET /api/auth/google[/callback]`, `POST /api/auth/logout`, `GET /api/auth/verify`, `GET /api/auth/platform-login`, `GET/POST /api/profile`.

**Key files:** `client/src/pages/{LoginPage,ProfileSetupPage}.jsx`; `server/routes/{auth,profile}.js`; `server/services/identityStore.js`.

---

## 18. Semrush Integration

**Purpose:** Central SEMrush API wrapper set used across Keyword Research, Location Page Builder, and Competitor Analysis.

**Key files:**
- `services/semrush.js` — pulls ranking keywords for a URL, distinguishing "no data" from an invalid-key error.
- `services/semrushBalance.js` — fetches remaining API unit balance via SEMrush's free (non-billed) endpoint, with a short in-memory cache.
- `services/semrushCA.js` — Competitor-Analysis-specific calls: organic competitor discovery, backlinks analytics (a separate API base URL), positional row parsing.
- `services/semrushUploadParser.js` — parses SEMrush's UI-exported CSVs for the manual-upload competitor-analysis flow, handling delimiter variance, BOM, quoted fields, and column-name drift across SEMrush UI versions.
- `utils/semrushParser.js` / `utils/countryToDatabase.js` — shared parsing/country→database mapping helpers.

**Key endpoints:** `GET /api/semrush/balance`.

---

## 19. Scrape / Search Utility Routes

**Purpose:** Thin, reusable HTTP wrappers around the scraping and search services, consumed directly by Content Research and internally by other modules' services (not routes) via direct function import.

**Key files:** `server/routes/{scrape,search}.js` (role-gated, `POST /api/scrape` max 10 URLs / `POST /api/search` + `GET /api/search/count`); `server/services/{scraper,googleSearch}.js`. Other modules (Article Recommendation, Location Page Builder, Content Enhancement) import the scraping/search functions directly as library code rather than going through these HTTP routes.

---

## 20. Module Registry

**Purpose:** Exposes the `modules/*/manifest.json` catalog (module ID, label, description, required/optional KB dependency patterns, output format, client scope, active flag) for the KB editor UI and the health-check audit.

**How it works:** Reads/writes the manifest files directly. Six manifests exist: `content-research`, `keyword-research`, `article-recommendation`, `article-enhancement`, `article-enhancement-lite`, `content-enhancement` — each declaring its KB dependencies in the template-pattern form that `kbLoader.js` resolves at runtime.

**Key endpoints:** `GET /api/modules`, `GET/PUT /api/modules/:id`.

**Key files:** `server/routes/modules.js`; `server/services/kbStore.js`; `modules/*/manifest.json`.

---

## 21. Bulk Scraper (`modules/bulk-scraper/`)

**Purpose:** A standalone CLI script (not wired into the Express app) for bulk-scraping full HTML + structured data from a list of URLs.

**How it works:** Reads a list of URLs from a text file, reuses the server's Puppeteer setup, and writes one JSON file per page plus a consolidated summary CSV to an output folder.

**Key files:** `modules/bulk-scraper/index.js`, `modules/bulk-scraper/urls.txt`, `modules/bulk-scraper/output/`.

---

## 22. Server Scripts (`server/scripts/`)

**Purpose:** Two standalone CLI utilities run outside the HTTP app.

- **`auditPages.js`** — batch regression runner for the SEO & GEO Audit check engine: runs the rule engine against a list of real URLs, writing a summary (and, in full mode, complete per-page output) to a results folder. Used to regression-test the audit engine against real pages without going through the UI.
- **`importKeywordUniverse.js`** — imports a client's own pre-scored keyword export (keyword, volume, pillar/cluster/subtopic, geo type, data confidence) into the keyword-universe table, feeding Location Page Builder's keyword adapter so niche service+location combos aren't limited to whatever surfaces from competitor SEMrush profiles. Idempotent per client.

---

## 23. LLM Provider Abstraction

**Purpose:** A single seam that lets Article Enhancement (full + Lite) run their core content-generation calls against OpenAI, Anthropic, or Google, selected per-run by the user, without any call site needing provider-specific code.

**How it works** (`services/llmProviders.js`):
- Supports a default OpenAI model plus an Anthropic model and a Google model as alternate choices.
- Returns a client shaped exactly like the OpenAI SDK's client regardless of provider — Anthropic and Google are addressed through their OpenAI-compatible chat-completions endpoints, using the same SDK pointed at a different base URL/key, so every existing call site keeps working unchanged.
- For non-OpenAI providers, since neither compat endpoint reliably honors JSON response-format, the wrapper injects a "respond with only raw JSON" instruction and strips markdown code fences from the response before parsing.
- The actual content-editing writer model is fixed to one specific model regardless of user selection (merging multiple models' verbatim-preserving edits isn't reliable), while analysis/recommendation stages can fan out across multiple user-selected models.
- `services/llmSynthesis.js` merges multiple models' independent analysis outputs into one document on the fixed writer client, only invoked when more than one model was selected.
- `services/claude.js` — despite its name, implements Content Research's `analyzeContent()` using the OpenAI SDK directly (not currently calling Anthropic).

**Key files:** `server/services/{llmProviders,llmSynthesis,claude}.js`.

---

## 24. Supabase Persistence Layer

**Purpose:** All durable server-side state (identity/workspaces, run history, per-module job/store data) is backed by Supabase Postgres, accessed only from the server with the service-role key (never exposed to the browser).

**How it works:**
- A lazy singleton client, gated so the app boots and runs stateless/no-op even without Supabase configured.
- A generic jsonb "collection" adapter (list/get/insert/update/remove) mirrors the JSON-file-store API used elsewhere, so any module's store can move onto Supabase without changing its exported function names or route code.
- `services/identityStore.js` — typed relational queries for users, profiles, and workspace membership.
- `services/workspaceContext.js` — the active-workspace resolution cache described in §15.
- `services/runStore.js` — the run-history writer described in §16.
- `services/jobStore.js` — in-memory (not Supabase) event/job store used by the legacy Competitor Analysis PPTX pipeline for SSE progress + tracked-run settlement; auto-cleans jobs older than 2 hours.
- Schema lives in `supabase/migrations/`.

**Key files:** `server/services/{supabase,supabaseStore,identityStore,workspaceContext,runStore,jobStore}.js`; `supabase/migrations/`.
