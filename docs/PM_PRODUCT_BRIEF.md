# SEO Studio — Product Manager's Operating Brief

**Audience:** the PM who owns this product day-to-day. Assumes fluency in SEO/GEO, agency delivery economics and platform product management. Nothing here explains what a crawler is.

**Basis of record:** branch `unified-fast-aivisibility`, `HEAD = 5832f88`, working tree as of **21 Sep 2026**. Every count in this document was either read out of source or computed by executing the registry (method noted inline). Where an existing internal doc disagrees with the code, **the code wins**, and the disagreement is logged in §14.

---

## 1. The one-pager

| | |
|---|---|
| **What it is** | A multi-module SEO + GEO (generative engine optimisation) delivery platform. One client site = one **project**. Six audit modules run against that project; sixteen standalone tools sit alongside it for research, optimisation and production work. |
| **Who it's for** | Position² delivery staff — strategists, technical SEO, content editors, account leads — managing a book of client brands. Not self-serve. No billing, no customer-facing administration. |
| **Business model** | Services revenue. The platform is a **cost-structure play, not a SaaS SKU** — it removes delivery hours, it does not replace the strategist. That framing is load-bearing: it is why the approval gates exist and why no agent output ships unreviewed. |
| **Wedge** | **AI Visibility.** Everything else compresses work that already existed. AI Visibility measures something the client cannot see anywhere else, and it is re-measurable — which makes it a retainer line rather than a project. |
| **Maturity** | The foundation is real: Google OAuth, workspaces, projects, RBAC, a migration runner, a durable crawl queue, 85 server test suites. Six modules sit on the shared spine. **Ten-plus standalone tools do not** — they re-ask for the domain and several persist nothing. |
| **Scale today** | 174 commits since 27 Mar 2026. ~116k LOC server, ~54k LOC client. 49 Postgres tables. 10 named contributors. |
| **Biggest open risk** | Six modules still persist to local disk. Without `APP_DATA_ROOT` pointed at a mounted volume, **every deploy is a silent factory reset** — no error, just empty screens. |

### The three things that should own this quarter

1. **Durability (P0).** Close the file-store hole for the six disk-backed modules plus the Knowledge Base. Until this lands, every other roadmap item is built on sand.
2. **Provider continuity (P0, dated).** Google Custom Search JSON API is closed to new customers and existing customers must transition by **1 Jan 2027**. The internal target for cutover to the existing Serper fallback is **30 Nov 2026**. This is a hard calendar dependency, not a preference.
3. **One client, everywhere (P1, big-bang).** Collapse the four rival client lists into the project record. Every cross-tool feature on the roadmap is blocked behind this.

---

## 2. Product identity and positioning

### 2.1 The naming problem — resolve it

The product answers to three names simultaneously:

| Surface | Name |
|---|---|
| UI / README | **SEO Studio** |
| `package.json` | `seo-automation` |
| Legacy docs and some route comments | *SERP Content Researcher* (the original single tool, now `/content-research`) |

This is a live brand-consistency defect and it is called out as an open item in the investor brief. Pick one and enforce it in `package.json`, the README, the document title and the parent shell's breadcrumb. Recommendation: **SEO Studio**.

### 2.2 Positioning statement

> For agency delivery teams whose surface area multiplied when search started answering instead of linking — SEO Studio is the delivery system that measures both classic search health and answer-engine visibility against one client record, then turns the gap into reviewed, shippable work.
>
> Unlike Semrush/Ahrefs (a tool, not a delivery layer) or Conductor/Profound (measurement without the workflow around it), it covers the whole line — and it was built against live paying accounts rather than a roadmap.

### 2.3 ICP and personas

| Persona | Primary JTBD | Primary surface today |
|---|---|---|
| **SEO strategist** | "Decide what to work on next for this client." | Project dashboard → Executive Summary → ranked backlog |
| **Technical SEO** | "Find and prove defects on the pages that matter." | Site Crawler, SEO & GEO Audit, On-Page Audit |
| **Content editor** | "Produce brand-correct content backed by real research." | Content Research, Article Recommendation, Article Enhancer, Knowledge Base |
| **Account lead / approver** | "Approve advice and show the client what we delivered." | Recommendations, exports, run history |
| **Operator (eng/ops)** | "Keep recurring work reliable and inside budget." | Admin, `/runs`, workspaces, limits |

**Secondary audience that materially shapes the product:** strategic and corporate acquirers. A prepared investor narrative exists (`docs/Prompts/investor_deck_brief.md`) with an explicit *claims you must NOT make* list. Treat that list as a **positioning guardrail**, not just deck copy — e.g. never claim "fully unified platform", never imply an Ahrefs integration, never say "all 96 rules".

### 2.4 Competitive frame (as briefed)

| Who | Has | Lacks |
|---|---|---|
| Semrush, Ahrefs | Data, scale, distribution | The delivery layer — they sell the tool, not the outcome |
| Conductor, Profound | Real AI-visibility measurement | The rest of the workflow around it |
| Agency holding groups | Clients and scale | An AI-native delivery system; they are retrofitting |
| AI-native challengers | Speed, no legacy | Live accounts to build and prove against |

---

## 3. Product surface map

### 3.1 The platform core — the "spine"

One **project** = one client site. It carries the client name, a primary domain, `project_domains` (including competitor-role domains), `project_brands` (brand plus aliases), crawl options (`maxUrls`, `maxDepth`), schedules, and every module's stored evidence. It is workspace-scoped and permission-checked on every read and write.

**Properly on the spine today:** Project Dashboard, Site Crawler, AI Visibility, AI Visibility Lite, Run History — plus Hub & Spoke, Competitor Research, SEO & GEO and Agent Readiness, which are runnable from the dashboard and store project-scoped evidence.

### 3.2 The six audit modules (dashboard cards)

Registry: [`server/modules/projects/overview.js`](../server/modules/projects/overview.js).

| Key | Card label | Family | Evidence source | Runnable | Card |
|---|---|---|---|---|---|
| `technical` | Tech Audit | technical | `crawl_runs` + `crawl_run_findings` | via crawler | ✅ |
| `hub_spoke` | Hub and Spoke | technical | Content Architect over stored crawl pages | ✅ | ✅ |
| `competitor` | Competitor Research | seo | `project_module_runs` | ✅ | ✅ |
| `seo_geo` | SEO & GEO | geo | `project_module_runs` | ✅ | ✅ |
| `ai_visibility_lite` | AI Visibility | geo | `project_module_runs` + `aiv_lite_captures` | ✅ | ✅ |
| `agent_readiness` | Agent Readiness | agentic | `project_module_runs` | ✅ | ✅ |
| `ai_visibility` | AI Visibility (scraped) | geo | `project_module_runs` + `ai_visibility_captures` | ✅ | ❌ `card: false` |

**PM note on the seventh row.** The scraped AI Visibility module deliberately keeps a registry entry with `card: false` rather than being deleted. Removing the entry previously broke a poll in `RunMeasurementButton.jsx` that made the UI report "run finished" seconds after the button was pressed. **Do not let anyone "clean up" that entry.**

**The honesty rule — protect it.** A module with no stored evidence reports `not_run`, never a zero and never an interpolated score. This is enforced in `overview.js` and `insights/executive.js` and is one of the few genuinely differentiated product behaviours in the category. The first "let's just show 0 so the chart isn't empty" ticket kills it.

### 3.3 The sidebar tools

Single source of truth: [`client/src/toolsMeta.js`](../client/src/toolsMeta.js). Sixteen tools across four groups; one is `hidden` (route and run-history label intact, no nav entry).

| Group | Tool | Route | Maturity tag shown in product |
|---|---|---|---|
| Research | Keyword Research | `/keyword-research` | — |
| Research | Content Research | `/content-research` | Internal Only |
| Research | Article Recommendation | `/article-recommendation` | — |
| Research | Market Potential | `/market-potential` | Beta |
| Research | Competitor Analysis | `/competitor-analysis` | Beta |
| Optimize | Enhance Existing Article | `/article-enhancement` | Internal Only |
| Optimize | Article Enhancer (lite) | `/article-enhancement-lite` | **hidden from nav** |
| Optimize | AI Visibility (API path) | `/ai-visibility-lite` | Beta |
| Optimize | AI Visibility (scraped) | `/ai-visibility` | Beta |
| Optimize | SEO & GEO Audit | `/seo-geo-audit` | Beta |
| Optimize | Agent Readiness Audit | `/agent-readiness-audit` | — |
| Optimize | Image Alt Tag Audit | `/image-alt-audit` | Beta |
| Build | Location + Service Pages | `/location-page-builder` | Internal Testing |
| Build | Content Architect | `/content-architect` | Internal Testing |
| Build | Knowledge Base | `/kb` | Internal Only |
| Monitor | Site Crawler | `/crawl-scope` | Internal Testing |

**Routed and run-tracked but not in the sidebar:** On-Page Audit (reachable only from inside the SEO & GEO screen), Robots Monitor, Content Enhancement, the legacy Competitor Analysis Report, and three client-specific Location Page pipelines (`/location-page-builder/neuro`, `/…/gentle-dental-pages`, `/…/clear-behavioral-health`).

> **Tag hygiene is a real product problem.** Eight of sixteen tools carry Beta / Internal Only / Internal Testing, and there is no written exit criterion for any of them. Define one (§13 proposes it) or the tags become permanent decoration and stop signalling anything to the delivery team.

### 3.4 The five shared foundations

| Foundation | State |
|---|---|
| Login, workspaces, roles, platform admin, limits | **Working.** Google OAuth only; boot fails closed if no allowlist is configured. |
| Run history and job runners | Partly — two queue implementations and several competing run records |
| Design system (`components/studio/primitives.jsx`) | Partly — rival component sets still live inside tool folders |
| Third-party data purchasing | Partly — no shared connection, cache or budget across providers |
| Legacy scripts and committed scraped pages | Dead code, scheduled for deletion |

---

## 4. Core user journeys

### 4.1 Activation — what actually happens when a project is created

This is the strongest flow in the product and the one to demo. Creating a project fires a chain of autostarts, so a strategist enters a domain, presses Save, and walks away:

```
Create project (name + primary domain)
  ├─ crawlAutostart.js        → full site crawl begins immediately (in-process via RunManager)
  │     └─ hubSpokeAutostart  → Hub & Spoke clusters the pages the crawl already stored
  ├─ homepageAutostart.js     → SEO & GEO + Agent Readiness run against the homepage
  ├─ competitorAutostart.js   → Competitor Research starts when the primary domain arrives
  └─ aiVisibilityLiteAutostart.js
        ├─ setup   (detached): read the site → build a business profile → write 10 questions
        └─ measure (queued):   only once setup succeeded, so it never spends against an empty set
```

Every autostart is independently switchable by environment variable (`CRAWL_AUTOSTART`, `HUB_SPOKE_AUTOSTART`, `COMPETITOR_RESEARCH_AUTOSTART`, …). **Time-to-first-value is therefore "one form, then wait" — that is the product's activation story and it should be measured** (§13).

### 4.2 Day 1 / Week 1 / Month 1 — the intended experience

- **Day 1.** Sign in with Google, see your workspace and its clients. Add a client — name and domain, nothing else. The crawl starts itself. Come back to a health score, findings, the pages that matter and a short list of what to do first.
- **Week 1.** Every tool is a tab on the client, not a separate destination. Keywords already know the domain, competitors are already there, content already knows which pages exist. Triage six issues as "not a problem here" and next week's crawl remembers.
- **Month 1.** The app tells you what changed — not "here is a crawl", but *"three ranking pages lost internal links this month, and here is the recommendation that fixes it."*

### 4.3 Where the journey breaks today

Traced against the code, the second half of that journey collapses:

| # | Break | Consequence |
|---|---|---|
| 1 | **Triage does not survive a re-crawl.** Decisions are keyed to one run's fingerprint. | You re-triage the same ~200 issues every week. |
| 2 | **A crawl finding cannot become a recommendation.** The durable recommendations list only accepts findings from the other five modules. | The strongest evidence source is the one that cannot produce durable work items. |
| 3 | **Keywords carry nothing over.** Re-type the domain; pick the client from a different list; close the tab and the shortlist is gone. | Every content job restarts from zero. |
| 4 | **No single client report.** The crawl exports one workbook, keywords another, AI visibility sits on a third screen. | Account leads merge exports by hand. |
| 5 | **The silent one.** If On-Page Audit results looked fine yesterday and are empty today, nobody did anything wrong — the app was deployed. | Same for Competitor Tracker, Market Potential, Robots Monitor, Content Architect and any KB edit made in the app. |

**Disconnection, quantified:**

| Question | Answer today |
|---|---|
| Add a domain once — how many tools know about it? | 5 of 21 capabilities |
| Crawl a site — how many tools can use that crawl? | 2 |
| Close the laptop mid-job — how many tools remember? | 12 of 21 |
| Deploy an update — how many tools lose data? | 6 |
| Places to look to see everything about one client | At least 7 |

---

## 5. Platform primitives a PM must be fluent in

### 5.1 Object model

```
workspace  (owner + members, roles)
  └─ project  (crawl_projects)  ── "the spine"
       ├─ project_domains       (primary | competitor, active/inactive)
       ├─ project_brands        (brand name + reviewed aliases)
       ├─ project_pages         (durable page record — the only stable page identity)
       ├─ crawl_runs → crawl_run_results / _links / _findings / _finding_instances
       ├─ project_module_runs   (one row per module execution)
       ├─ project_module_page_runs (per-page module work)
       ├─ project_module_schedules
       ├─ recommendations       (durable, approvable work items)
       ├─ ai_visibility_prompts / _captures   (v1, scraped)
       └─ aiv_lite_profiles / _prompts / _captures  (v2, API)
tool_runs  (cross-cutting run history, workspace-scoped)
audit_events (append-only; UPDATE is rejected by trigger)
admin_limit_policies (versioned limit policies — insert, never update)
```

49 tables total. Notable: **`audit_events` is append-only and enforced by trigger.** A guard test (`server/services/__tests__/appendOnlySchema.test.js`) fails if any append-only table carries a live `ON DELETE SET NULL` FK — because that FK is an UPDATE and the trigger rejects it, which once broke permanent project deletion. Do not let that test be "simplified away".

### 5.2 RBAC — four roles plus platform admin, **19 capabilities**

`server/services/projectAccess.js`. Values are `true` / `false` / `'propose'`.

| Capability | contributor | approver | admin | owner | platformAdmin |
|---|---|---|---|---|---|
| view, startRun, createProject, reviewFinding, editRecommendation | ✅ | ✅ | ✅ | ✅ | ✅ |
| manageCompetitors | propose | ✅ | ✅ | ✅ | ✅ |
| editProjectSettings, overrideMachineOutcome, approveRecommendation, recordShippedDate, manageRecipients | ❌ | ✅ | ✅ | ✅ | ✅ |
| configureGscIntegration, overrideRobotsPolicy, manageWorkspaceMembers | ❌ | ❌ | ✅ | ✅ | ✅ |
| purgeProject, requestWorkspaceDeletion, restorePendingDeletion | ❌ | ❌ | ✅ | ✅ | **❌** |
| transferOwnership | ❌ | ❌ | ❌ | ✅ | ✅ |
| configureLimits | ❌ | ❌ | ❌ | ❌ | ✅ |

Two deliberate asymmetries worth knowing when someone files a "platform admin should be able to do everything" ticket:

- A **platform admin cannot purge a project or delete a workspace.** Seeing every workspace is not the same as being entitled to destroy a customer's crawl history.
- An **approver can delete a project (recoverable) but not erase it.** `purgeProject` is deliberately narrower than `editProjectSettings`.

Unknown role strings normalise to `contributor` (least privilege); unknown capability names deny.

### 5.3 Auth posture

Google OAuth only. Shared username/password logins were removed and a validly-signed legacy cookie is now rejected. The server **refuses to boot** if neither `ALLOWED_GOOGLE_EMAILS` nor `ALLOWED_GOOGLE_DOMAIN` is set, and refuses to boot on a weak `JWT_SECRET`. Off-boarding takes effect immediately rather than when a 7-day cookie expires.

### 5.4 Run tracking — the analytics substrate you already own

`tool_runs`, written by `server/middleware/runTracking.js` (installed once per API mount, not per route). It handles the three run shapes in this codebase:

| Shape | Modules | Outcome captured from |
|---|---|---|
| JSON request → response | SEO & GEO, Content Enhancement, Market Potential, Agent Readiness, KB saves | HTTP status + body |
| `POST /init` → `GET /stream/:token` (SSE) | Keyword Research, Article Recommendation, Article Enhancement (+Lite), Image Alt Audit, Location Pages | terminal SSE event |
| Response returns, work continues in background | On-Page Audit, Robots Monitor, Competitor Tracker/Report | `req.run.finish()` / `req.run.fail()` |

A row holds tool, action, label (URL/keyword/client), actor, workspace, status, duration and a sanitised, size-capped copy of input and output. Credential-looking keys are redacted, content blobs reduced to size markers, anything >16 KB summarised and flagged. Runs still `running` after two hours are swept to `failed`.

**Twenty tool ids are tracked** (`server/config/runTracking.js`). Two guard tests enforce the contract: `registry.test.js` fails if a matcher stops corresponding to a real route; `moduleRuns.test.js` fails if a tracked tool shows its runs on no page, or a panel points at a tool id nothing records — both of which look, in the product, exactly like "this tool has never been run".

**This is the closest thing to product analytics that exists.** See §13.

### 5.5 Workspaces

A user's runs land in their **active** workspace, chosen on the Workspaces page and stored in a `workspace_id` cookie, membership-checked on every use. Until someone picks one, runs go to their personal workspace. Being added to a teammate's workspace never silently starts recording your runs there — **a team sharing one run history requires each member to switch to it once.** That is a known onboarding friction point; it is deliberate (privacy), not a bug.

### 5.6 Limits — versioned policy, layered

`server/services/adminLimits.js`. Effective limit = most restrictive applicable platform / workspace / project-tier / provider policy. Changing a limit is an **INSERT of version N+1**, never an update, so history is auditable. Selected defaults a PM will be asked about:

| Key | Default | Direction | Product meaning |
|---|---|---|---|
| `maxUrlsPerCrawl` | 10,000 | min | Crawl ceiling. Now genuinely gates a run (it previously only clamped stored project options — "set 500, got 10,000" was the reported symptom). |
| `maxCrawlDepth` | 10 | min | |
| `scheduleMinIntervalHours` | 24 | max | Weekly is the initial recurrence |
| `globalCrawlConcurrency` | 3 | min | |
| `maxPagesPerModuleAudit` | **10** | min | Per-page audits cost 130s (SEO&GEO), 32s (On-Page), 20s (Agent Readiness) per page. 10 keeps a full audit under ~30 min. The audit always reports coverage, so a budget is never mistaken for the whole site. |
| `maxPromptsPerVisibilityRun` | **20** | min | Bounds spend on one AI Visibility run |
| `modelSpendPerRunUsd` | 5 | min | |
| `providerCallsPerDay` | 5,000 | min | |
| `rawHtmlRetentionMonths` | 12 | min | Customer HTML retention |
| `workspacePurgeGraceDays` | 30 | **specific** | A user protection, not a resource cap — shrinking it is destructive, not restrictive, so most-specific scope wins rather than most-restrictive |

### 5.7 Persistence — the two-tier reality

| Tier | What uses it | Survives deploy |
|---|---|---|
| Postgres | Projects, crawls, findings, module runs, AI visibility, recommendations, run history, workspaces, LPB tables | ✅ |
| Local disk via `resolveDataRoot()` | Content Architect, Competitor Analysis, Market Potential (×2), On-Page Audit, Robots Monitor, CrawlScope report workbooks, Location Page Builder, Knowledge Base (`KB_ROOT`) | **Only with `APP_DATA_ROOT` on a mounted volume** |

`server/services/dataRoot.js` resolves: per-module override env var wins → else `<APP_DATA_ROOT>/<slug>` → else the historical in-tree path. **It does not migrate anything.** Pointing an existing deployment at a new root gives it an empty one, and the modules treat "no file" as "nothing stored yet" rather than an error — so they start clean rather than failing. That is exactly why the failure is silent.

---

## 6. The detection IP — what we actually sell

This is the defensible asset and the answer to "isn't this a GPT wrapper?". All counts below were computed by executing the registries, not read off a slide.

### 6.1 Site Crawler — 96 rules, 89 wired

`server/modules/crawlScope/issue-catalog.json`.

| Category | Rules | | Severity | Rules | | Priority | Rules |
|---|---:|---|---|---:|---|---|---:|
| Indexability | 30 | | error | 27 | | High | 44 |
| Technical | 20 | | warning | 54 | | Medium | 39 |
| Metadata | 16 | | notice | 15 | | Low | 13 |
| Accessibility & Social | 8 | | | | | | |
| Content | 7 | | | | | | |
| Links | 7 | | | | | | |
| Performance | 4 | | | | | | |
| Structured Data | 4 | | | | | | |

**Seven rules have no detection code**, and all seven are catalogued as `detection: "Connected data required"` — they need a Search Console or backlinks feed the platform does not currently pull:

`google-title-differs`, `metadata-changed`, `ai-content-signal`, `traffic-drop`, `top10-drop`, `referring-domains-drop`, `indexnow-submit`.

> **Messaging rule:** say "96 rules, 89 wired" and name the seven. Never "all 96". The specificity is what makes the other 89 believable in diligence.

Also shipped: a **20-entry integration catalog** (GTM, GA4, legacy UA, Meta Pixel, …) detected from page source — tag/analytics/advertising stack discovery as a by-product of the crawl.

### 6.2 SEO & GEO Audit — 266 checks per page

Executed `runAllChecks()` against a fixture: **252 standard checks across 21 categories**, plus **14 keyword checks** when keywords are supplied = **266**.

| Category | n | | Category | n | | Category | n |
|---|---:|---|---|---:|---|---|---:|
| Schema | 31 | | Images | 13 | | Hreflang | 5 |
| Content Quality | 28 | | Open Graph | 12 | | Meta Description | 6 |
| Technical | 22 | | E-E-A-T | 12 | | Security | 6 |
| GEO Signals | 14 | | Meta Robots | 11 | | Miscellaneous | 8 |
| Headings | 13 | | Internal Links | 11 | | Page Speed | 8 |
| | | | Semantic HTML | 11 | | External Links | 7 |
| | | | Accessibility | 9 | | URL Signals | 7 |
| | | | Title Tag / Canonical | 9 / 9 | | | |

**Scoring integrity detail worth knowing.** Four statuses are excluded from both numerator and denominator: `skipped` (could not evaluate), `na` (does not apply to this page type/intent), and `informational` (a measurement, not a verdict). `informational` was introduced because ~30 checks that can never fail were previously scored as free passes — "0 outbound links to authoritative domains" rendering as a green tick and inflating every score. **If anyone proposes "simplifying" the status model, that regression is what they are re-introducing.**

The deck says "200+". The real number is 266. Being under your own published number is the right place to be.

### 6.3 On-Page Audit — 23 sections

`server/modules/onPageAudit/auditor.js` runs 23 numbered sections with page-type detection and a YMYL flag, then derives priority actions and a manual-check list. It is reachable **only** from inside the SEO & GEO screen — a discoverability defect, and the reason its usage is invisible.

### 6.4 Agent Readiness Audit — 13 + 10 checks, 5 levels

| Group | Checks |
|---|---|
| Discoverability | robots, sitemap, link headers |
| Content | markdown |
| Bot Access | aibots, contentsignals, webbotauth |
| API / Auth / MCP | apicatalog, oauth, oauthresource, mcp, agentskills, webmcp |
| **Site-level total** | **13** |
| On-Page Signals | schema_search, schema_action, captcha, cookie_banner, js_rendering |
| Forms | form_labels, input_type, autocomplete, vague_buttons, interactive_divs |
| **Page-level total** | **10** |

Maturity ladder: **Level 0 Not Indexed (<25) → Level 1 Basic Web Presence (25) → Level 2 AI Aware (50) → Level 3 Agent Ready (75) → Level 4 Agent Native (90)**. That is **five bands, not four** — the deck brief says four (§14).

Each check carries a plain-English `business` rationale and a specific `action` with an effort tag (`quick`), and the module computes a **quick-win projected score**: what the score becomes if only the quick fixes are made. That is a genuinely good product mechanic and is underused elsewhere.

**Known methodology gap (P1, already on the backlog as B20):** the AI-bot check passes when it finds a listed bot name in `robots.txt`. It does **not** evaluate whether a relevant URL is actually allowed. This needs path-specific effective-rule evaluation per RFC 9309, preserving the distinction between ordinary search crawling, AI retrieval and model-training controls. Until then, treat the score as directional and do not put it in a client SLA.

### 6.5 The evidence discipline that differentiates the whole product

Three hard constraints in code, not policy. These are the anti-hallucination story and should be in every deck, every pitch and every QBR:

1. **AI Visibility descriptors must carry a verbatim quote** from a stored answer, or they are discarded. If it can't quote it, it doesn't say it.
2. **Article Enhancer is forbidden from inventing** — no statistic, expert quote, citation, study or date that is not grounded in the article's own text.
3. **The generated AI Visibility question is never permitted to name the client.** Asking an engine about a brand guarantees it mentions the brand; that measures the question, not the standing.

---

## 7. AI Visibility — the wedge, in detail

### 7.1 Two paths, one claim — and why both ship

| | **v1 — scraped** (`/ai-visibility`) | **v2 — Lite / API** (`/ai-visibility-lite`) |
|---|---|---|
| What it reads | The consumer products, as a person sees them | The model APIs directly, with web search enabled |
| Surfaces | ChatGPT (scraped + DataForSEO), Gemini (scraped), Google AI Overview (scraped + DataForSEO), Google AI Mode (scraped) | OpenAI, Anthropic, Google — three provider APIs in parallel |
| Run time | **10–35 minutes** (each capture drives a real browser, 25–110s) | **~3 minutes** (prompts serial per provider, providers in parallel) |
| Infrastructure | Headless Chrome, rotating residential proxies required for Google surfaces | None beyond API keys |
| Dashboard card | ❌ (registry entry retained) | ✅ — it is the card |
| Status | Fully reachable, historical runs intact | Default for new work |

`access` (`'scraped'` vs `'api'`) is stored on every capture row and is load-bearing in reporting: the two answer different questions — the consumer product's retrieval stack versus the model's own — and a report that merged them under one label would assert an equivalence that does not hold.

**Do not put this distinction on a client-facing or investor slide.** It belongs in the technical annex. It is a strength in a diligence conversation and a confusion in a pitch.

### 7.2 The Lite run, end to end

1. **Profile** (`businessProfile.js`) — read the site, derive what the business actually sells and what it calls itself. The site's own name beats the project label: a project somebody named "Dentist — NC" measures nothing.
2. **Generate** (`promptGen.js`) — **one** model call producing 10 questions (with 6 over-fetch, because validation rejects brand-naming, duplicate and unmeasurably-vague prompts). One call rather than ten, deliberately: ten independent calls reliably produce ten rewordings of the same question, which measures one thing ten times. Intents span commercial / informational / navigational / comparison.
3. **Measure** (`run.js` → `surfaces/`) — every live prompt against all three APIs, prompts serial per provider (a 20-prompt burst is exactly what a rate limiter exists to refuse), providers parallel.
4. **Extract & score** — mention vs citation recorded as **separate signals**, share of voice over the approved brand set, every descriptor quote-backed.

### 7.3 Caps and unit economics

| Cap | Value | Where enforced |
|---|---|---|
| Auto-generated prompts | 10 | `models.js` |
| Max prompts per project | 20 | `store.js`, server-side |
| Max runs per project | **20** | `run.js`, checked at the top of `runOnce` — no path (autostart, route, retry) can spend a 21st |
| Max searches per answer | 5 | `models.js` |
| Max output tokens | 1,500 | `models.js` |

**Cost model (verified against provider pricing on 2026-09-18):** roughly **$22 per project at the 20-run cap**, across all three providers, with Anthropic the largest line.

Two findings in `models.js` a PM should understand before anyone "optimises" model choice:

- **Grounding dominates the bill, not tokens.** `gemini-2.5-flash-lite` has cheaper tokens than 3.5 but is billed per grounded *prompt* at $35/1,000 vs 3.x's $14/1,000 per search (with 5,000 free/month). Picking the cheaper token rate roughly doubles cost per run.
- **`max_output_tokens` on a reasoning model covers reasoning + answer together.** At 1,500, the first real run failed 8 of 10 OpenAI captures — the entire budget spent thinking, nothing left to say. Every model id is overridable by env var precisely because a pinned, deprecated model name is a *silent, total* failure.

### 7.4 Measurement risks a PM must hold

- **Variance between runs is real.** Concede it immediately and specifically: it is exactly why the product tracks across repeated runs rather than reading a single score. Conceding it is what makes the rest credible.
- **Cohort comparability.** Retiring or editing a question can change a period a client has already seen, because report context filters historical captures to the current question set. The fix (backlog B09/B19) is **saved reports as measured at the time** — frozen prompt revision, brand set, surface config, extraction version and filters. Until that ships, **a number delivered to a client is not guaranteed reproducible.** Treat that as a client-communication constraint today.
- **Mixed extraction states.** The normalised visibility function treats a scope as extracted once *any* capture was extracted. Unprocessed answers must not silently become absences.
- **Domain-only citation evidence cannot establish path-level citation.** Say "cited domain", not "cited page", unless the path is in the evidence.

---

## 8. Data and vendor supply chain

| Provider | Used for | Concentration risk | Notes |
|---|---|---|---|
| **Google Custom Search** | Primary SERP source | **HIGH — dated** | Closed to new customers; existing must transition by **1 Jan 2027**. Free tier 100 queries/day, remaining quota shown in the UI. |
| **Serper** | SERP fallback | — | Already wired as automatic fallback. Target cutover **30 Nov 2026**. |
| **Semrush** | Keyword/competitor data | Medium | Metered in units; the app states estimated cost before spending. Four separate connections, five result parsers, three caps that do not know about each other. |
| **DataForSEO** | AI-answer data (ChatGPT, AI Overview) | Medium | Two connections; only one tracks cost. Adapters default to disabled. |
| **Google PageSpeed (PSI)** | Speed scores | Low | Two clients, one shared quota, only one paces itself. |
| **OpenAI / Anthropic / Google model APIs** | Generation, extraction, AI Visibility Lite | Medium | Shared factory exists (17 call sites use it, **9 bypass it**). |
| **Google Search Console** | Traffic evidence | **Not ingested** | Service-account scaffolding and reserved fields exist; no completed ingestion service. This is why 7 crawl rules are unwired and why the backlog states "pages, not traffic". |
| **Resend** | Report email | Low | |
| **Residential proxies** | Required for scraped Google surfaces | Medium | Measured: from a plain ISP address Google refused `/search` on the first request. |

**Positioning line that is true and worth making:** the SERP layer already falls over to a second provider automatically and market-sizing runs off either of two vendors. Substitutability is demonstrated, not asserted. A vendor can make costs worse; it cannot make the product stop working.

**The spend problem, stated plainly.** There is no single bill, no shared cache and no shared budget. Three different budgeting philosophies coexist: one checks before spending (AI Visibility — the only one that can actually prevent an overspend), one estimates, one reconciles after. One documented cap in the settings file is read by no code at all. Consolidating on **reserve-before-spend with a ledger** is backlog item B07 and is a P0.

---

## 9. Operational envelope

### 9.1 Rate limits (per IP per minute)

| Limit | Applies to |
|---|---|
| 20/min | Everything by default |
| 100/min | Knowledge Base, `/api/runs`, `/api/admin` — the KB editor auto-saves |
| 300/min | Location Page Builder, AI Visibility, `/api/projects` — dashboard, wizard, CRUD and SSE together |

Rate limiting runs **before** body parsing, so an unauthenticated flood of 20 MB JSON bodies is throttled rather than parsed first.

### 9.2 Latency — the single biggest perceived-performance lever

The app is **latency-bound, not CPU-bound**: several sequential queries per request, so distance to the database is multiplied by every one.

| | one `select 1` | a 12-query dashboard build |
|---|---|---|
| DB ~13,000 km away | **264 ms** | **~3.2 s** |
| DB co-located | **0.22 ms** | **~3 ms** |

**Host the app in the same region as its database.** "Add an index" is usually the wrong first move here; reducing the *number* of sequential round trips is the right one.

### 9.3 Deployment checklist (from `docs/deployment.md`)

- [ ] Volume mounted, `APP_DATA_ROOT` set to it
- [ ] App region matches database region
- [ ] `DATABASE_URL` uses the **pooled** endpoint for web + workers; migrations use the **direct** endpoint
- [ ] `PUBLIC_BASE_URL` set (report links are signed against it)

Workers default to in-process (`CRAWLSCOPE_WORKER=in-process`, `MODULE_WORKER=in-process`). The module worker drives headless Chrome at 150–300 MB per page on the same event loop that serves requests. Moving it out is one env var plus a service. **Caveat:** crawls with `trigger: 'manual'` still execute in the web process — the worker deliberately refuses to reclaim them, because nothing else would pick them up.

### 9.4 Scaling constraints — latent single-server assumptions

Four "start a job then poll" features, two scheduled jobs and eleven live-progress streams assume one server. **Whether this matters is an open question that changes Stage 6 from prevention to repair** (§15, Q7). Known failure modes if a second replica is added today:

| Risk | Symptom | Cause |
|---|---|---|
| Two web replicas | "Start job, check progress" silently never finishes | 4 job registries in one process's memory |
| Two web replicas | Daily monitoring runs twice, two histories | No shared lock; writes to local disk |
| Two PageSpeed jobs | Both rate-limited | Two clients, one quota, one paces itself |
| Five browser launchers | Memory exhaustion | Nothing caps the total across them |
| Two crawl schedules | Same site crawled twice | Two schedulers per project, mutually unaware |
| Two stuck-job sweepers | Healthy 20-min audits killed early | Two definitions of "stuck", one with a 10-min cutoff — **already happened, worked around rather than fixed** |

### 9.5 Reliability behaviours worth knowing (and protecting)

- **A stopped crawl is a partial audit, not a lost one** — it runs the normal completion path and stores its findings.
- Pause/resume/stop reach worker-run crawls via a DB control channel polled every 3s, with compare-and-clear so a newer request is not swallowed.
- Crawls survive a restart and resume part-finished work.
- Scraping fails gracefully — pages that block scrapers are skipped and the run continues.
- The dashboard report carries a **completeness line** comparing `run.summary.counts` against what the page received. That single line is the fastest health check on the findings pipeline.

---

## 10. Quality and release engineering

| | |
|---|---|
| Server tests | **85 suites**, run by `server/scripts/testServer.js`, which reports *all* failures rather than stopping at the first (a `&&` chain once let one broken suite hide 55 others) |
| Client tests | **1** — pure helpers only |
| DB-dependent suites | Require a throwaway `TEST_DATABASE_URL`; the guard refuses if it matches `DATABASE_URL`. Unset, they skip. |
| Migrations | 27 files, applied by `server/scripts/migrate.js` with recorded checksums; `--status` answers "has this database seen 0023?"; `--baseline-through` adopts a hand-migrated database |
| UI verification | **The structural gap.** Several report pages have never been rendered in a browser — verified only as "the client builds and the server tests pass", which catches import and syntax errors and nothing else. |

**Two known migration-hygiene issues:** two files share number `0009` (leave it, document it — renumbering an applied file risks more than it fixes), and `0024` was written and applied as `0023` before renumbering (harmless; the statements are `if exists` and the two are independent).

**Local dev hazard.** The web process runs under nodemon watching `modules/`. **Do not edit files under `server/modules/` while a crawl is running** — restarts mid-crawl have cost real runs. The crawl worker is plain `node`, so it does *not* auto-restart on file changes.

---

## 11. Risk register

Ranked by expected damage, not by effort.

| # | Risk | Severity | Status | Owner action |
|---|---|---|---|---|
| R1 | **Silent data loss on deploy** — six file-backed modules + KB | Severe | Mitigable today via `APP_DATA_ROOT`; permanent fix is Stage 1 / B03 + B28 | **Verify the volume is mounted in prod this week.** This single fact changes Stage 1 from a fix to an emergency. |
| R2 | **Google CSE sunset, 1 Jan 2027** | Severe, dated | Fallback exists, cutover not done | Cut over by 30 Nov 2026 |
| R3 | **Client identity fragmentation** — five meanings of "client" | Severe | Known, Stage 2 | Big-bang migration; expect a "needs assigning" queue |
| R4 | **Triage does not survive a re-crawl** | High | Known, Stage 4 | Issue identity that outlives a run; the hard half (bulk write path, 5,000-row cap) is already written but its screen was removed |
| R5 | **No reproducible client reports** — retiring a question changes a delivered number | High | Backlog B09/B19 | Until then, constrain what is promised in client decks |
| R6 | **No single spend view or shared budget** | High, costs money | Backlog B07 | Reserve-before-spend + ledger |
| R7 | **Duplicate crawling/fetching** — 15 fetchers, only 1 obeys robots.txt, crawl delay and SSRF safety | High | Stage 3 | Seven tools stop fetching; the rest route through the crawler's fetch layer |
| R8 | **Agent Readiness bot-access check is not path-aware** | Medium | Backlog B20 | Fix before it carries any commercial weight |
| R9 | **Latent multi-replica bugs** | Medium/Hidden | Unknown whether already biting | Answer Q7, then prevent or repair |
| R10 | **UI never visually verified** on several report pages | Medium | Open | A browser pass is cheap and unglamorous; schedule it |
| R11 | **Credential hygiene** — timestamped `.env` backups with live keys sit in the working folder (correctly gitignored, still present on the machine) | Medium | Open | Delete the backups; rotate if access is in any doubt |
| R12 | **340 committed scraped third-party client pages** in the repo | Low/legal | Open | Delete after confirming nobody needs the archive |
| R13 | **Settings sprawl** — 117 env reads, 59 undocumented, 22 documented-but-unread, 256+ hardcoded values behaving like settings | Low but compounding | Stage 6 | One loader, one documented file |
| R14 | **Open crawl-budget defect** — "500 URLs in, 150 internal crawled" (150 = default `maxExternalUrls`) | Unknown | **Unresolved**, hypotheses only in `HANDOFF.md` §2 | Establish first whether the user pasted a list or set a spider budget — the two code paths are completely different |

---

## 12. Roadmap — two plans, and how to reconcile them

**There are two roadmaps in the repo and they are not the same document.** A PM must decide which is canonical before either is quoted externally.

### 12.1 Plan A — the unification audit (`docs/unification/`)

Seven stages, sized in Claude Code sessions. Structural, inward-facing, about removing duplication.

| Stage | Size | Sessions | Ships alone? | Blocks |
|---|---|---:|---|---|
| 1 · Stop losing work | L | 8–12 | Yes, per tool | Everything |
| 2 · One client, everywhere | L | 10–14 | **No — one push** | Stages 3–7 |
| 3 · One crawl, many readers | L | 14–20 | Yes, per tool | 5, 7 |
| 4 · Issues and keywords that stick | L | 8–10 | Yes | 5, 7 |
| 5 · Writing tools join the client | M×5 | 8–12 | Yes, per tool | 7 |
| 6 · One job runner, budget, menu | L | 8–12 | Yes, in parts | 7 |
| 7 · One report and a clear-out | M | 6–8 | Yes | — |
| **Total** | | **~62–88** | | |

**The build-freeze list is the most useful artefact in that plan.** Until the stage named, do not add: new tools (after Stage 2), anything that saves to disk (after 1), new client lists (after 2), new fetchers/scrapers/crawlers (after 3 — there are already 15), new export builders (after 7 — there are already 31), new component sets inside a tool folder (after 7 — already 7), new schedulers or queues (after 6 — already 12), new settings read straight from env (after 6 — 59 already undocumented).
**Keep building freely in:** Site Crawler, AI Visibility, Project Dashboard. Those three are on the spine and improving them compounds.

### 12.2 Plan B — the product improvement roadmap (`docs/product-improvement-plan.md`)

Four releases, sized in engineering days, assuming 2 engineers at ~7 net days/week. Outward-facing, about the *visibility → content → measurement* loop.

| Release | Outcome | Days | Window | Release gate |
|---|---|---:|---|---|
| **R0** Reliable foundation | Correct project context, protected pilot data, accurate bot-access checks, explicit search provider | 14–22 | wks 1–3 | Restart/restore exercise passes; search works with the primary provider unavailable |
| **R1** Trustworthy measurement | Frozen campaign basis, resumable captures, spend accounting, valid comparisons | 26–40 | wks 4–9 | Interrupted run resumes with no duplicate accepted samples |
| **R2** Working content loop | Gap → work item → source-backed brief → reviewed draft → publication record → scheduled recheck | 22–36 | wks 10–14 | Three pilot projects complete the workflow; saved report numbers survive later config edits |
| **R3** Prioritisation and learning | Better diagnostics/fixes, GSC evidence, outcome views, alerts, off-site research | 23–38 | wks 15–20 | Observed changes trace to baselines; missing GSC is explicit |
| **Total core** | | **85–136 days** | ~14–22 calendar weeks | |

Prioritised with dependency-aware WSJF: `(value + urgency + risk reduction) × confidence ÷ size`. Top three by score: shared project/brand context (3.68), runtime/storage/provider readiness (2.70), stable reports and delivery evidence (2.48). **Reproducible, resumable measurement scores low (1.69) but is gated above its rank** — it is required before scaling measurements. That gate-overrides-rank pattern is correct and worth preserving.

### 12.3 Recommended reconciliation

They are not alternatives; they overlap on the P0s and diverge on ambition.

- **Plan A Stage 1 ≡ Plan B R0/B03** — durability. Do it once, under one ticket set.
- **Plan A Stage 2 ≡ Plan B B02** — client identity. Same work.
- **Plan A Stages 3/4 ≡ Plan B B20/B21/B22** — shared crawl evidence and durable issue identity.
- **Plan B R1/R2 are net new** and are where the commercial upside is (frozen campaigns, spend ledger, the content loop).
- **Plan A Stage 7 (the clear-out) is pure hygiene** and should be scheduled as slack work, not as a release.

Proposal: adopt **Plan B's release structure and gates** (it has acceptance criteria and a measurement contract), and import **Plan A's build-freeze list** as standing engineering policy.

---

## 13. Metrics and instrumentation — the honest gap

### 13.1 What can be measured today

Everything in `tool_runs`: which tool, which action, which workspace, who, on what, status, duration, and a sanitised input/output. That supports:

- runs per tool per week, by workspace and by user
- failure rate and failure reason per tool
- run duration distributions (p50/p95) per tool
- which tools are actually used versus merely present

### 13.2 What cannot be measured today

- **Activation / TTV.** No event for "project created → first useful output viewed".
- **Funnel or retention.** No product analytics; no session, view or click instrumentation.
- **Cost per client or per run.** No unified ledger; spend is per-provider and partly unrecorded.
- **Outcome.** Without GSC ingestion there is no traffic evidence, so no "did the recommendation work".
- **Time saved.** The "30 min → 5 min" figures are internal benchmarks, honest and **not audited**. Say so every time they are quoted.

### 13.3 Proposed metric tree

**North Star:** *Reviewed, evidence-linked work items shipped per strategist per week.* It is the only measure that spans the whole promise — measurement is worthless if it does not become approved, delivered work.

| Layer | Metric | Target (proposed, for pilot) | Source |
|---|---|---|---|
| **Activation** | Median time from project creation to first viewed Executive Summary | < 30 min | new event needed |
| **Engagement** | Projects with ≥1 run in the last 7 days | ≥ 80% of active book | `tool_runs` |
| **Core value** | Median time from opening results to saving an evidence-linked work item | ≤ 15 min (excl. collection) | workflow events (new) |
| **Quality** | Briefs accepted with minor edits by the assigned editor | ≥ 70% | editorial rating, no self-grading |
| **Efficiency** | Reduction in median hands-on brief prep vs baseline | ≥ 50% over ≥10 comparable briefs | manual study |
| **Reliability** | Duplicate accepted samples in restart/race tests | **0** | failure-injection tests |
| **Coverage** | Usable planned samples per supported cohort | ≥ 90%, lower coverage stays visible | campaign matrix vs accepted captures |
| **Guardrail** | Metered actions reserved and reconciled (or explicitly unresolved) | 100% | ledger (B07) |
| **Guardrail** | Saved reports that reproduce their frozen payload after later edits | 100% | snapshot replay fixtures |

### 13.4 Proposed maturity-tag exit criteria

Because eight of sixteen tools are tagged and none has a defined exit:

| Tag | Exits when |
|---|---|
| **Internal Testing → Beta** | Persists to Postgres; reachable from the sidebar; run-tracked; has one automated test of its happy path |
| **Beta → GA** | Hangs off the project spine (no re-typed domain); results survive a restart; has an error state for every external dependency; has been rendered and reviewed in a browser |
| **Internal Only** | Stays internal until it has an approval gate and a client-safe export |

---

## 14. Where the docs and the code disagree

Relevant because several of these numbers appear in external-facing material.

| Claim | Where | Code says | Verdict |
|---|---|---|---|
| "22 distinct permissions" | investor brief | **19** capabilities in `CAPABILITIES` | Correct to 19 before any diligence |
| "4 maturity levels" (Agent Readiness) | investor brief | **5** bands, Level 0–4 | Say "five levels, 0 to 4" |
| "21 tools" | unification audit | `toolsMeta.js` now defines **16** (15 visible + 1 hidden); several of the original 21 are unrouted or merged | The unification count predates consolidation |
| "Fifteen standalone tools" | README / investor brief | 16 defined, 15 in nav | "Fifteen in the sidebar" is accurate |
| "Six modules lose data on deploy" | unification audit | True **only without** `APP_DATA_ROOT`; the resolver and env override now exist | Verify prod config before repeating the stronger claim |
| "There is no migration runner" | `HANDOFF.md` §1 | `server/scripts/migrate.js` exists with checksums and `--status` | `HANDOFF.md` self-corrects at the top; it is a point-in-time record, **not current documentation** |
| "96 rules" | README, deck | 96 catalogued, **89 with detection code** | Always say 89/96 and name the 7 |
| "200+ checks per page" | README, deck | **266** (252 + 14 keyword) | Under-claiming; fine, but know the real number |
| App name | three places | three different names | Unresolved — §2.1 |

---

## 15. Open decisions that need a PM answer

These are the questions this brief could not answer from the code. They are ordered by what they block.

**Blocking — answer before any durability work starts**

1. **Is the production disk actually wiped, or is a volume mounted?** This single fact decides whether Stage 1 is a fix or an emergency, and whether historic customer data is already gone.
2. **Do the ten Location Page Builder tables exist in the live database?** The tool reads and writes them; the repo defines them only partially and the code refers to a setup file that is not here. A live tool on undocumented tables is the largest single unknown.
3. **Where is the PRD?** Twenty-six server files cite section numbers (`§20.1`, `§16.11`, `§6.2`) from a document that is not in the repository. Roughly a tenth of the server is written against something nobody can open.

**Blocking — answer before "one client, everywhere"**

4. **What happens to Knowledge Base clients that match no project** — archive them, or create projects for them?
5. **Is the Neuro Wellness location-page pipeline still live?** It has a client id typed permanently into the code and nothing links to it.
6. **Are Robots Monitor and Content Enhancement hidden on purpose,** or is it an oversight? (Both also break the parent shell's breadcrumb, because the nav list is what tells it which tool you are on.)

**Product decisions, answer before the stage that needs them**

7. **Is the web tier ever run on more than one replica?** Changes §9.4 from prevention to repair.
8. **Should the budget stop a run, or record it afterwards?** Only "check before spending" can actually prevent an overspend, and it will refuse some runs that go through today.
9. **Delete or restore the legacy Competitor Analysis Report?** Its screen is unplugged but seven server endpoints still exist. Recommendation: keep its PDF/slide export, fold it into the shared report layer, delete the rest.
10. **Six unfinished "team insights" screens exist that nothing reaches and no document mentions.** Abandoned, or awaiting a route?
11. **Two fully-built features have no screen:** a complete page-inventory API (read/edit/exclude/include/history/sync) and a complete issue-triage write path (single + bulk, 5,000-row cap). Build the screens or delete the code?

**Housekeeping**

12. Can the 340 committed scraped client pages be deleted?
13. Can the duplicate `.env` credential backups be deleted, and should the keys be rotated?
14. Which of the 22 documented-but-unread settings are real?

---

## 16. Glossary

| Term | Meaning here |
|---|---|
| **Project** | One client site. The spine. Row in `crawl_projects`. |
| **Workspace** | Tenancy and permission boundary. Owns projects, members and run history. |
| **Module** | One of the six (seven with the retained scraped card-less entry) audit capabilities that run against a project and store evidence. |
| **Tool** | A standalone screen in the sidebar. May or may not know about projects. |
| **Run** | One execution. Recorded in `tool_runs` (cross-cutting) and/or `project_module_runs` (module-scoped). |
| **Finding** | A per-occurrence rule hit from the crawler. Currently keyed to one run. |
| **Recommendation** | A durable, approvable work item. **Cannot currently be created from a crawl finding.** |
| **GEO** | Generative Engine Optimisation — being present in the answer, not just the ranking. |
| **Surface** | One measurable answer endpoint, identified as `engine:provider` with an `access` of `scraped` or `api`. |
| **Mentioned vs cited** | Named in an answer vs linked as a source. Different commercial value, different fixes, recorded separately. |
| **`not_run`** | The state a module reports with no stored evidence. Never coerced to a number. |
| **Autostart** | A module that begins itself on project creation or on the completion of an upstream module. |
| **Template scope** | A finding where one change fixes every affected page — a fact about effort, used to promote items *within* a severity band, never across one. |

---

## 17. Appendix — verified fact sheet

Safe to quote internally. Method noted for anything computed.

| Fact | Value | Method |
|---|---|---|
| Crawl rules catalogued | 96 | `issue-catalog.json` length |
| Crawl rules with detection code | 89 | cross-referenced rule ids against `analyzer.js` + `crawler.js` |
| Unwired rules, all "Connected data required" | 7 | same |
| Rule categories | 8 (Indexability 30, Technical 20, Metadata 16, Accessibility & Social 8, Content 7, Links 7, Performance 4, Structured Data 4) | computed |
| Rule severities | error 27 / warning 54 / notice 15 | computed |
| Rule priorities | High 44 / Medium 39 / Low 13 | computed |
| SEO & GEO checks per page | 252 + 14 keyword = **266**, across 21 categories | executed `runAllChecks()` on a fixture |
| On-Page audit sections | 23 | `auditor.js` |
| Agent Readiness site checks | 13, in 4 groups | `CATEGORIES` |
| Agent Readiness page signals | 10, in 2 groups | `ONPAGE_CATEGORIES` |
| Agent Readiness maturity bands | 5 (Level 0–4) | `levelFromScore` |
| Integration/tag detections | 20 | `integration-catalog.json` |
| RBAC capabilities | 19 | parsed `CAPABILITIES` |
| Roles | 4 + platform admin | `ROLES` |
| Sidebar tools | 16 defined, 15 visible | `toolsMeta.js` |
| Dashboard module registry | 7 entries, 6 with cards | `overview.js` |
| Run-tracked tool ids | 20 | `runTracking.js` |
| Postgres tables | 49 | parsed all migrations |
| Migration files | 27 | `supabase/migrations/` |
| Server test suites | 85 | file count |
| Client test suites | 1 | file count |
| Server LOC | ~116,000 | `wc -l`, excl. `node_modules` |
| Client LOC | ~53,700 | `wc -l` |
| Commits | 174, from 27 Mar 2026 to 19 Sep 2026 | `git rev-list --count` |
| AI Visibility Lite: prompts auto-generated | 10 (max 20 per project) | `models.js` |
| AI Visibility Lite: run cap | 20 per project, server-enforced | `run.js` |
| AI Visibility Lite: cost at cap | ~$22 per project across three providers | `models.js`, provider pricing 2026-09-18 |
| AI Visibility Lite: full run duration | ~3 min (vs 10–35 min scraped) | `run.js` |
| Default pages per module audit | 10 | `adminLimits.js` |
| Per-page audit cost | SEO&GEO 130s, On-Page 32s, Agent Readiness 20s | `adminLimits.js` comments |
| Client brands with KB entries | 6 — Clear Behavioral Health, Gentle Dental, Great Lakes, Neuro Wellness Spa, New Life House, Riccobene | `knowledge-base/brand/` |
| Verticals served | Dental (DSO) and mental/behavioral health | `knowledge-base/industry/` |

---

*Compiled 21 Sep 2026 against `HEAD = 5832f88`. Any figure here can be re-derived from the commands noted in the Method column; re-verify before external use.*
