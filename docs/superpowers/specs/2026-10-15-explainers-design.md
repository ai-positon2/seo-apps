# Explainers: info icons, Guided mode and the metric legend

**Date:** 2026-10-15 · **Branch:** `unified-fast` (work left uncommitted) · **Source:** Claude Design handoff (README, `explainer-copy.js`, `SEO Studio Explainers.dc.html` prototype)

## 1. Goal

CMOs and investors who log in and explore SEO Studio on their own should be able to understand any output box without a reference document. Three additions:

1. **Info icons ("i")** next to every output box on the project overview and the module reports. Each explains what the box shows, why it matters, what good looks like, how it is calculated, where the data comes from, and a next step.
2. **A Guided mode switch** in the header. On: clicking an icon opens a popover with the full explanation. Off: hovering an icon shows a tooltip with the title and one line.
3. **A floating Legend button** that opens a panel explaining the shared colours and symbols plus the numbers on the current screen.

**Success:** every icon on every screen opens accurate copy that matches what the code calculates; nothing prints a sample figure or a coerced `0`; both themes and both modes work; the header still fits at laptop widths.

**Out of scope** (rejected in design): a side drawer for explanations, a "How to read this" strip, rebuilding any report.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Score bands disagree across screens | Move Agent Readiness (audit + summary pages) to 80/60. SEO & GEO keeps its five bands (Good from 75); the legend says so. |
| Which AI Visibility report | Both: the Lite report (`/ai-visibility-lite`, what the dashboard card opens) gets new copy; the older scraped report (`/ai-visibility`) uses the handoff copy. |
| How live the copy is | Mixed: live figures where the screen already has them; general wording for dates, sources and next steps that name a specific item. |
| Toggle position | Last control before the user chip. Helper text shows only on wide screens and is the first thing to go. |
| Competitive score card | Add it to the top of Competitor Research. |
| SEO & GEO's existing `InfoTip`s | Replace all three with `InfoDot`. Their live breakdowns move into the popover's "How it's calculated" box. |
| Implementation | base-ui Popover and Tooltip (`@base-ui/react` 1.8, already used by `ui/Modal`). |
| Git | No commits. Everything is left in the working tree for review. |

## 3. Architecture

New folder `client/src/components/explain/`:

| File | Responsibility | Depends on |
|---|---|---|
| `explainCopy.js` | All explainer and legend copy. Static strings, plus functions `(ctx) => string` for fields that carry figures. `resolveExplainer(key, ctx)` returns `{ t, s, why, good, calc, src, next: { label, screen } }` as plain strings. `resolveLegend(screen, ctx)` does the same for the legend. No React import, so `node --test` can load it. | `explainFormat.js` |
| `explainFormat.js` | Tiny formatters used by the copy: `num(v)` (locale string), `pct(v)`, `orNotMeasured(v, fmt)`. A missing or non-finite value renders **"not measured yet"**, never `0`. | nothing |
| `explainScreens.js` | `SCREENS` (key → display name), `screenOf(explainKey)`, `LEGEND_SCREEN_FOR` and `nextRoute(screen, ctx)` (the "Open {Module} →" destination; uses `moduleReportRoute` when the overview's module card is in `ctx`, otherwise the tool path). | `lib/moduleReportRoute.js` |
| `GuidedModeContext.jsx` | `GuidedModeProvider` and `useGuidedMode()` → `{ guided, setGuided, openKey, setOpenKey }`. `guided` defaults to `true` and persists to `localStorage['seoStudio.guidedMode']` as `'1'`/`'0'` (reads and writes wrapped in try/catch). One popover open app-wide. `openKey` clears on route change (`useLocation`) and whenever `guided` changes. Mounted in `App.jsx` around `<RouteBridge/>` and `<Routes>`. | react-router |
| `GuidedModeToggle.jsx` | The header switch and its helper text. | context |
| `InfoDot.jsx` | The "i" button. Props: `explainKey`, `ctx`, `tone` (`'default'`/`'onAccent'`), `calcExtra` (optional ReactNode shown under the calc text). Renders `ExplainPopover` when `guided`, `ExplainTooltip` otherwise. Always calls `e.preventDefault(); e.stopPropagation()` on click so it is safe inside a stretched link. | context, copy, popover, tooltip |
| `ExplainPopover.jsx` | base-ui Popover with the layout in §4.4. | base-ui |
| `ExplainTooltip.jsx` | base-ui Tooltip with the layout in §4.3. | base-ui |
| `Legend.jsx` | `<Legend screen="tech" ctx={…} />`: the fixed button plus the panel. Each report renders it itself, so the legend appears only while that report is on screen, not on an empty form or tool picker. | copy |
| `index.js` | Re-exports. | |

Styles go in `client/src/index.css` under `.explain-*` (hover, focus-visible, the hit-target pseudo-element, reduced motion). Colours are tokens only; the handoff's hex values are not used.

**Highlight.** The container an icon explains carries `data-explain-box`. While a popover is open, `InfoDot` finds `closest('[data-explain-box]')` from its own button and adds the class `explain-box--active` (`outline: 2px solid var(--primary); outline-offset: 3px`), removing it on close.

## 4. Component specifications

Measurements are the handoff's, unchanged. Tokens: `--bg --surface --card --border --border-strong --text --text-2 --text-3 --primary --primary-text --primary-soft --accent-700 --accent-900 --viz-warn --viz-neg --neutral-200 --neutral-500 --text-on-primary --r-pill --r-lg --shadow-lg --font-mono`.

### 4.1 GuidedModeToggle

- Placed in `MacWindow.jsx`'s right-hand control row, immediately before `<UserChip>`.
- Wrapper: `display:flex; align-items:center; gap:14px; min-width:0`.
- Helper text: 11.5px, `--text-3`, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0`. On: "Click an info icon for the full explanation". Off: "Hover an info icon for a quick summary". Hidden below 1440px viewport width (`@media`), so it never pushes the nav buttons.
- Switch: `<button role="switch" aria-checked>`, height 32, padding `0 6px 0 12px`, radius `--r-pill`, `flex-shrink:0; white-space:nowrap`. Label "Guided mode", Poppins 12.5px/500, `--text`. Off: `1px solid --border-strong`, background `--card`. On: `1px solid --accent-700`, background `--accent-900`.
- Track 34×20, pill; off `--border-strong`, on `--primary`; `transition: background 160ms`. Knob 16×16 white, `top:2px`, `left:2px` off / `16px` on, `box-shadow: 0 1px 2px rgba(28,30,36,.25)`, `transition: left 160ms`.
- Toggling closes any open tooltip or popover.

### 4.2 InfoDot

- `<button type="button">` showing "i". Visual 16×16, round, `1px solid --border-strong`, background `--card`, colour `--text-3`, Poppins 10px/600, line-height 1, centred, `flex-shrink:0`.
- Hover and `:focus-visible`: border and colour `--primary`, background `--primary-soft`.
- Hit target at least 24×24 via a transparent `::before` (visual size stays 16).
- `tone="onAccent"` (used on the teal Priority verdict box): border `color-mix(in srgb, var(--text-on-primary) 60%, transparent)`, transparent background, colour `--text-on-primary`, hover background `color-mix(in srgb, var(--text-on-primary) 18%, transparent)`.
- Placement: inline after the label, in a `display:flex; align-items:center; gap:6px` row (8px next to 15px titles).
- ARIA: `aria-label="About {title}"`. Guided on: `aria-expanded`, `aria-haspopup="dialog"`, `aria-controls`. Guided off: `aria-describedby` → tooltip.
- Inside `ModuleCard`: `position:relative; z-index:2`, above the stretched `<Link>`.

### 4.3 ExplainTooltip (Guided off)

- Opens on hover and keyboard focus; closes 60ms after the pointer leaves, or on blur. A tap toggles it on touch.
- `role="tooltip"`. Background `--text`, text `--bg`; radius 6, padding `9px 11px`, `max-width:280px; width:max-content`, `--shadow-lg`, `pointer-events:none`, z-index 80.
- Content: title (12px/600), then `s` (12px/1.45, `color-mix(in srgb, var(--bg) 85%, var(--text))`). Nothing else.
- Centred over the icon, 8px above; flips below when the icon is within 150px of the viewport top; kept 152px from either side (base-ui `collisionPadding`).

### 4.4 ExplainPopover (Guided on)

- Opens and closes on icon click. `role="dialog"`, `aria-labelledby` = title id. Focus moves to the close button on open and back to the icon on close.
- Closes on: ×, Esc, outside click, the same icon again, any scroll outside the popover (document-level capture listener), route change, opening another icon.
- Box: width 360, `--card`, `1px solid --border`, radius `--r-lg`, `--shadow-lg`, z-index 70, `overflow:auto`.
- Position: base-ui Positioner with `side="bottom" align="start" alignOffset={-18} sideOffset={10} collisionPadding={12}`, flipping to the top when below is short. `max-height: calc(var(--available-height) - 22px)`.
- Layout, top to bottom:
  1. Header (padding `14px 16px 12px`, column, gap 6): kicker = screen name (10px/600, uppercase, .1em, `--primary-text`) with × on the right (24×24, radius 6, background `--bg`, colour `--text-2`, 15px); title `t` (15px/600); lead `s` (13px/1.5, `--text`, `text-wrap:pretty`).
  2. Body (padding `0 16px 14px`, column, gap 10), four blocks, each a label (10px/600, uppercase, .08em, `--text-3`) and a value (12.5px/1.5, `--text-2`): "Why it matters", "What good looks like", "How it's calculated" (boxed: background `--bg`, radius 8, padding `10px 12px`, value `--text`; `calcExtra` renders inside this box under the text), "Suggested next step".
  3. Footer (border-top, padding `10px 16px`, space-between, wraps): `src` (11.5px, `--text-3`) on the left; on the right, only when `next.screen` is set, a link "Open {Module} →" (12px/500, `--primary-text`).

### 4.5 Legend

- Button: `position:fixed; right:24px; bottom:24px; z-index:900`, height 42, padding `0 18px 0 14px`, pill, no border, background `--text`, colour `--bg`, Poppins 13px/500, `--shadow-lg`, hover background `--neutral-200`. Leading mark: three 8px dots, 3px gap, `#5FAF97 #D3A45E #E9998C`. Label "Legend" / "Close legend"; `aria-expanded`, `aria-controls`.
- Panel: `position:fixed; right:24px; bottom:78px`, width 380 (`max-width: calc(100vw - 48px)`), `max-height: calc(100vh - 150px)`, `overflow:auto`, `--card`, `1px solid --border`, radius 12, `--shadow-lg`, `role="dialog" aria-label="Legend"`. Closes on × / button / Esc, not on outside click. Open state resets on route change.
- Sticky header (padding `16px 18px 12px`, border-bottom, background `--card`): kicker "Legend" (10px/600, uppercase, `--primary-text`), title "How to read {Screen name}" (15px/600), × (28×28, radius 6, background `--bg`).
- Section 1, "Colours and symbols, everywhere" (padding `14px 18px`): grid `64px 1fr`, gap `10px 12px`, items centred; each row a visual, then **term** and line at 12.5px/1.45 `--text-2` (term `--text`/600). Visuals: bands (three 18×10 swatches, radius 2: `--primary`, `--viz-warn`, `--viz-neg`); not measured (em dash, mono 18px/600, `--text-3`); direction (▲ `--primary`, ▼ `--viz-neg`, — `--text-3`); severity (three 8px dots: `--viz-neg`, `--viz-warn`, `--neutral-500`).
- Section 2, "The numbers on this screen" (padding `4px 18px 18px`, gap 10): one card per entry (background `--bg`, radius 8, padding `10px 12px`; term 13px/600; line 12.5px/1.5 `--text-2`; optional example chip in mono 11.5px on `--card`, `1px solid --border`, radius 4, padding `3px 7px`).

### 4.6 Behaviour summary

| | Guided ON | Guided OFF |
|---|---|---|
| Hover icon | Hover state only | Tooltip |
| Focus icon | Focus ring | Tooltip |
| Click / Enter | Opens or closes the popover | Tooltip (touch) |
| Box highlight | While the popover is open | None |

`prefers-reduced-motion: reduce` removes the toggle's 160ms transitions; nothing else moves.

## 5. Copy

The handoff's `explainer-copy.js` is the starting point. Its exports (`EXPLAINERS`, `EXPLAINER_KEYS_BY_SCREEN`, `LEGEND_BY_SCREEN`, `LEGEND_SHARED`) keep their names and shapes, except that `calc`, `src`, `next` and legend `ex` may be functions of `ctx`.

### 5.1 Rules

- `t`, `s`, `why`, `good` stay static strings.
- A figure in copy comes from `ctx`. If the value is missing, the field uses general wording or "not measured yet". It never prints `0` for a missing value (PRD §16.11). A measured zero is still printed as `0`.
- A `next.label` that named a specific sample item ("Create a hub page for Sports injuries first") becomes general wording.
- No sample names (Harborview, Riverbend, Healthgrades) or dates survive anywhere.

### 5.2 Corrections to the draft (for sign-off)

| Key | Draft said | Ships as | Why (code) |
|---|---|---|---|
| `composite.calc` | "(82 + 77 + 78 + 71 + 52) ÷ 5 = 72. Hub and Spoke … left out." | Live: "The plain average of the audit scores that exist: (A + B + …) ÷ n = X." plus a sentence naming each module left out and why (reports findings, or not run yet). With nothing scored: "Not measured yet: no audit has produced a score." | `overview.js buildComposite`: rounded mean of scored modules. |
| `m_seogeo.calc`, `g_score.calc` | "200+ checks grouped into 21 areas" | "The page's checks are grouped into 9 weighted areas: 6 for search engines (SEO) and 3 for AI answer engines (GEO). The overall score blends the two sides; the card's small SEO and GEO bars show each side. A serious blocking problem (noindex, no title, no H1, thin content) caps the score until it's fixed." Live check count on the SEO & GEO screen; none on the card. | `seoGeoChecks.js SCORE_BUCKETS` (9 buckets, `axis: seo/geo`). |
| `g_score.good` | "80+. Rungs from Excellent down to Critical." | "75 or above is Good, 90 or above Excellent. The five bands: Critical 0–39, Poor 40–59, Needs work 60–74, Good 75–89, Excellent 90–100." | `SummaryView.jsx BANDS`. |
| `m_aivis.calc` | "…a fixed set of 40 real customer questions asked every week." | "The share of measured answers that name the brand when ChatGPT, Claude and Gemini are asked this project's prompts through their APIs, with web search on. Prompts that failed to capture are left out, not counted as misses. The report's headline ring is a different, weighted score; its own (i) explains it." | `SCORE_BASIS.ai_visibility_lite`. |
| `m_agent.calc`, `a_score.calc` | "13 automatic checks…" | Live on the report: "{n} automatic checks across {k} categories ({names}), each worth points by business impact…". Card: "13 HTTP checks, plus 10 on-page checks when page and form URLs are given." The level ladder (Not Indexed → Agent Native) is named. | `AgentReadinessAuditPage.jsx` (13 HTTP / 4 categories, or 23 / 6). |
| `a_sub` | "The four areas: being found, being readable, access rules, modern standards." | Title "Score by category". Lists the real categories from `result.cats`: Discoverability, Content, Bot Access, API / Auth / MCP, and, when run, On-Page Signals and Forms. "Bars use the same bands as every score: 80+ green, 60–79 amber, below 60 red." | `result.cats`. |
| `a_checks` | "The 13 checks · pass, partial or fail" | Title "Every check". "Each check passes or fails. Advisory flags are worth knowing but aren't scored as a pass or a fail." | Statuses are `pass` / `fail` / `info`. |
| `a_brief` | "Executive brief" | Title "Executive summary", matching the page. | Page heading. |
| `v_sentiment` (older report) | "share rated positive" | "Each mention is scored 0–100 for how favourably the sentence naming you reads. This is the average across mentions." (Aggregation confirmed against the KPI builder during implementation.) | `aiVisibility/captureEngines/llmExtract.js`. |
| `h_clusters` … `h_table` | "missing hubs = no page links to most others; orphans = in sitemap but unlinked; content gaps" | See §5.3. Content Architect has no summary figure for orphans or content gaps, so `h_orphans` and `h_gaps` move into the legend only. | `HubSpokeReport.jsx`, `contentArchitect/hubSelection.js`. |
| `LEGEND_SHARED.bands` | "Same on every score out of 100." | "80+ Good · 60–79 Needs attention · below 60 At risk. SEO & GEO uses its own five bands, with Good from 75." | Decision in §2. |
| `LEGEND_BY_SCREEN.agent` "Pass, partial, fail" | | "Pass, fail, advisory". | As above. |
| `LEGEND_BY_SCREEN.seogeo` "Rungs" | "Five plain-English rungs, from Excellent down to Critical" | "Critical, Poor, Needs work, Good (75+), Excellent (90+)." | As above. |
| Every `src` | Sample dates and counts | Live where `ctx` has them, otherwise a plain source name ("Site crawl", "Semrush", "Latest AI Visibility run"). | §5.1. |

`m_hub`, `exec`, `trend`, `priorities`, `tofix`, `pages`, `coverage`, `radar`, `t_*` keys other than the figures, `g_verdict`, `g_platforms`, `g_wins`, `c_*`, and the older report's `v_*` keys keep the draft wording, minus sample figures and named items.

### 5.3 New keys (for sign-off)

**SEO & GEO** (replace the `InfoTip`s; each receives the existing explainer as `calcExtra`):

- `g_seo`, **SEO score**. s: "Can search engines like Google find, index and rank this page?" why: "This is the half of the score that decides where the page ranks in ordinary search results." good: "75 or above." calc: "The six SEO areas (title and meta, content and structure, indexability, technical and performance, links and media, keyword targeting), weighted into one number." `calcExtra`: `AxisExplainer` for `scores.seo`.
- `g_geo`, **GEO score**. s: "Can AI answer engines read, trust and cite this page?" why: "More buyers ask an AI assistant before they search. This half decides whether the page gets quoted." good: "75 or above." calc: "The three GEO areas (schema, GEO signals, E-E-A-T), weighted into one number. If engines report a gap, the GEO score is held until it is fixed." `calcExtra`: `AxisExplainer` for `scores.geo`.
- `g_score` gets `calcExtra`: `OverallExplainer`.

**AI Visibility Lite** (screen key `aivisLite`, display name "AI Visibility"):

- `l_score`, **AI visibility score**. s: "One number, out of 100, for how well AI assistants know and recommend the brand." good: "Above 60, AI regularly includes you. Above 80, you're one of the top answers." calc (live weights): "A weighted blend of four readings: how often you're named (40%), where you're named (25%), how warmly you're described (20%) and how often your site is cited (15%). A reading that couldn't be measured is left out and the rest are reweighted. This is not the dashboard card's number, which counts only how often you're named." Stages from `SCORE_STAGES` named in `good`.
- `l_named`, **Shows up in AI answers**. "The share of measured answers that name your brand." Live: "{named} of {measured} answers."
- `l_share`, **Share of the spotlight**. "Your mentions as a share of every tracked brand's mentions in the same answers."
- `l_cited`, **Trusted as a source**. "The share of measured answers that cite a page on your site."
- `l_rank`, **Typical spot when named**. "Where you fall in the order brands are named. 1 is first. Only answers that name you count."
- `l_grounded`, **Based on a live search**. "The share of answers where the model actually searched the web rather than answering from memory."
- `l_engines`, **By AI model**. "How often each model names you."
- `l_brands`, **Against the brands this project tracks**. "Each tracked brand's share of answers that name it. Counted in answers, not occurrences."
- `l_weak`, **Prompts where you are least visible**. "The prompts where you're named least often. A measured 0% is a real result; a prompt that couldn't be measured is left out."
- `l_gaps`, **Sources feeding competitors**. "Sites the models read for answers that named a competitor and not you." calc: competitor answers minus yours, weighted by how often the models read the source and by the kind of site (`aiVisibilityLite/report.js` gapScore).

`why` and `next` for the new keys:

| Key | why | next |
|---|---|---|
| `g_seo` | (above) | "Open the weakest SEO area below; it's where points are easiest to win back." |
| `g_geo` | (above) | "Fix any engine marked Not ready first, then the weakest GEO area." |
| `l_score` | "It's the headline answer to 'are we winning in AI search?'" | "Look at the lowest of the five readings below; it's what's holding the score down." |
| `l_named` | "If you aren't mentioned, you aren't considered." | "See the prompts where you're least visible." |
| `l_share` | "It shows your slice of the conversation against competitors, not just in isolation." | "Compare against the tracked brands below." |
| `l_cited` | "A cited page sends readers to your site and tells the model your content is trustworthy." | "Pages with clear answers and structured data get cited more; see the SEO & GEO audit." (`screen: seogeo`) |
| `l_rank` | "People act on the first names they read, just as they do with top search results." | "Visibility matters more right now. Position follows it." |
| `l_grounded` | "Answers built on a live search reflect your site as it is today; answers from memory may be out of date." | "Nothing to do. This describes the models, not your site." |
| `l_engines` | "It tells you where effort is most needed." | "Start with the model that names you least." |
| `l_brands` | "It shows who AI recommends when it doesn't recommend you." | "Open Gap analysis to see where competitors are cited instead of you." |
| `l_weak` | "Each one is a content brief waiting to be written." | "Write a page that answers the weakest prompt directly." |
| `l_gaps` | "These are the places to get listed, reviewed or featured." | "Get listed on the sources at the top of this list first." |
| `h_healthy` | "A clear hub lets search engines and AI assistants see the site owns the topic." | "Nothing to do for these clusters." |
| `h_unclear` | "Two pages competing to be the hub split the topic's strength between them." | "Pick one hub per unclear cluster and link the other page to it." |

**Hub and Spoke** (Content Architect report):

- `h_clusters`, **Topic clusters**. Draft wording kept ("grouped by the words and phrases they share, then named by AI"). It matches agglomerative clustering plus LLM naming.
- `h_healthy` (new), **Healthy hubs**. "Clusters where one page clearly stands out as the main page for the topic."
- `h_hubs`, **Missing hubs**. calc: "A cluster where no page scores high enough to be its hub. The hub score weighs the page's address, title and links, with an AI suggestion as one input among several."
- `h_unclear` (new), **Unclear hub**. "Two or more pages score too close to call, so a person should pick."
- `h_table`, **the cluster list**. One row per cluster with its hub state.
- Legend `hub`: Hub, Spoke, Orphaned ("a spoke page no other crawled page links to"), Missing or unclear hub.

**Competitor Research:** `c_score` as drafted, with a live worked example (§7).

### 5.4 Live values per screen (`ctx`)

| Screen | `ctx` passed by | Fields |
|---|---|---|
| Overview | `HomePage` / `ProfileStats` / `ModuleCard` | `modules` (label, key, scored, score, status, card), `composite` ({value, scoredModules, totalModules}), `pagesCrawled`, `coverage` ({covered, total}), `toFix` ({actions, templateWide}); per card: `module` incl. `scoreBasis`. |
| Tech Audit | `OverviewPanel` | `health`, `htmlCount`, `breakdown` (points per severity), `urlsFetched`, `pageLimit`, `indexable`. |
| SEO & GEO | `SummaryView` | `overall`, `bandLabel`, `checksApplied`, `cap`. |
| Agent Readiness | `AgentReadinessAuditPage` | `score`, `checkCount`, `cats` (names), `level`. |
| AI Visibility Lite | `OverviewReport` (Lite) | `headline` metrics, `meta.answersMeasured`, brand count. |
| AI Visibility (older) | `OverviewReport` | `kpis`, `meta.captures`, `meta.promptsMeasured`, `meta.period`. |
| Competitor | `OverviewTab` | `trafficScore` ({score, clientTraffic, strongestTraffic, strongestDomain, aheadOfAll}), competitor count. |
| Hub and Spoke | `HubSpokeReport` | cluster, gap, unclear and established counts. |

## 6. Placement

| Screen (route) | File | Anchor → key | Legend |
|---|---|---|---|
| Overview (`/`) | `home/ExecutiveSummary.jsx` | "Executive summary" eyebrow → `exec`; after `TrendChip` → `trend`; "Start with these N" → `priorities` | `overview`, rendered by `HomePage` once data has loaded |
| | `home/ProfileStats.jsx` | `Stat` gains `info` (+ `ctx`): Composite score → `composite`, To fix → `tofix`, Pages crawled → `pages`, Coverage → `coverage` | |
| | `pages/HomePage.jsx` | "Audit Profile" kicker on the radar card → `radar` | |
| | `home/ModuleCard.jsx` | Header right cluster, before the tag/status pills: `technical`→`m_technical`, `hub_spoke`→`m_hub`, `competitor`→`m_competitor`, `seo_geo`→`m_seogeo`, `ai_visibility_lite`/`ai_visibility`→`m_aivis`, `agent_readiness`→`m_agent`. Remove the root `title`; `scoreBasis` → `calcExtra` "This run: {scoreBasis}". | |
| Tech Audit (`/crawl-scope/runs/:id`) | `crawlScope/report/OverviewPanel.jsx`, `reportPrimitives.jsx` | "Site health" → `t_health`; "How the N points were lost" → `t_lost`; `Tile` gains `info`: URLs fetched → `t_urls`, HTML pages → `t_html`, Findable by Google → `t_indexable`, Pages with an error / warning → `t_issues`, External links checked → `t_external`; "What to do first" → `t_first` | `tech` |
| SEO & GEO (`/seo-geo-audit`, report view) | `seoGeo/report/SummaryView.jsx` | "Overall score" (replaces `InfoTip`) → `g_score`; SEO / GEO side scores (replace `InfoTip`) → `g_seo` / `g_geo`; "Priority verdict" (`tone="onAccent"`) → `g_verdict`; "Will AI engines show this page?" → `g_platforms`; "Quick wins" → `g_wins`; new eyebrow "Check results · {n} checks apply" above the count tiles → `g_counts` | `seogeo` |
| Agent Readiness (`/agent-readiness-audit`, summary view) | `pages/AgentReadinessAuditPage.jsx` | Score ring card → `a_score`; "Score by category" → `a_sub`; "Executive summary" → `a_brief`; "Every check — N" → `a_checks` | `agent` |
| AI Visibility Lite (`/ai-visibility-lite`, Executive overview) | `aiVisibilityLite/reports.jsx` `OverviewReport` | Score ring → `l_score`; the 5 metric tiles → `l_named`, `l_share`, `l_cited`, `l_rank`, `l_grounded`; engine cards → `l_engines`; "Against the brands…" → `l_brands`; "Prompts where you are least visible" → `l_weak`; "Sources feeding competitors" → `l_gaps` | `aivisLite` |
| AI Visibility (`/ai-visibility`, overview) | `aiVisibility/reports/OverviewReport.jsx`, `reportPrimitives.jsx` | "WHERE YOU STAND" → `v_stand`; `Metric` gains `info`: Visibility → `v_visibility`, Sentiment → `v_sentiment`, Position → `v_position`, Share of voice → `v_sov`, Strongest/Weakest model → `v_models`; `From` titles: Share of voice → `v_sov`, Where ground is being lost → `v_gaps`, Weakest questions → `v_weak` | `aivis` |
| Competitor Research (`/competitor-analysis`, Overview tab) | `competitorAnalysisDashboard/OverviewTab.jsx`, `charts/KpiScorecard.jsx`, `ui/Card.jsx` usage | New Competitive score card → `c_score`; `KpiScorecard` gains `info`: Organic Traffic → `c_traffic`, Organic Keywords → `c_keywords`, Authority Score → `c_authority`, Backlinks → `c_backlinks`; card titles: Organic Traffic → `c_traffic`, Organic Keywords → `c_keywords`, Backlinks / Referring Domains → `c_backlinks`, Authority Score → `c_authority`, Keyword Mix → `c_mix` | `comp` |
| Hub and Spoke (`/content-architect/:id`) | `contentArchitect/HubSpokeReport.jsx` | `SummaryTile` gains `info`: Topic clusters → `h_clusters`, Healthy hubs → `h_healthy`, Missing hubs → `h_hubs`, Unclear hub → `h_unclear`; cluster list heading → `h_table` | `hub` |

Each anchor's container gets `data-explain-box`. Shared primitives (`Stat`, `Tile`, `Metric`, `KpiScorecard`, `SummaryTile`) get an optional `info` + `infoCtx` prop, so callers that don't pass one are unchanged.

## 7. Competitive score card

- **Server:** the competitor dashboard's snapshot response gains `trafficScore`, computed by the existing `competitorTrafficScore(snapshot.domains)` from `server/modules/projects/moduleRunners.js`. It is imported, not reimplemented, so this card and the dashboard card cannot disagree.
- **Client:** a card above the KPI strip in `OverviewTab`: eyebrow "Competitive score" + `InfoDot c_score`; the score in mono at 44px, coloured by band (`scoreBandColor`), "/ 100"; one sentence:
  - ratio: "Your search traffic is {round(ratio×100)}% of {strongestDomain}'s, the strongest competitor tracked." (When the score is capped at 100 with a ratio above 1: "You're ahead of {strongestDomain}, the strongest competitor tracked.")
  - `aheadOfAll`: "You lead every tracked competitor."
  - `null`: em dash and "Not measured yet: needs traffic figures for this site and at least one competitor."
- Border-top 3px in the band colour, matching the prototype.

## 8. Agent Readiness bands

- Add `scoreBandColor(score)` to `client/src/lib/scoreVerdict.js`: `var(--primary)` at 80+, `var(--viz-warn)` at 60–79, `var(--viz-neg)` below 60, `null` for no score. It sits next to `scoreVerdict` and uses the same thresholds.
- Use it in `AgentReadinessAuditPage.jsx` (`ScoreRing`, `CatBar` bar and text, HTTP and on-page readiness figures) and `AgentReadinessSummaryPage.jsx` (lines ~71–72).
- The level ladder (90 / 75 / 50 / 25) is a separate scale and does not change.

## 9. Testing and verification

**Unit (`node --test`, new files under `client/src/components/explain/__tests__/` and `client/src/lib/__tests__/`):**

- Every key in `EXPLAINER_KEYS_BY_SCREEN` resolves with `ctx = {}` to non-empty `t`, `s`, `why`, `good`, `calc`, `src`, `next.label`, with no `undefined`, `NaN`, `null` or `[object` in any string.
- Missing figures read "not measured yet"; no field renders a lone `0` from missing input.
- Live figures render: composite formula from a module list (and names the excluded modules); the competitor ratio sentence for ratio, ahead-of-all and null; the tech health breakdown sums to `100 − health`; agent check count 13 vs 23.
- Every explainer key belongs to exactly one screen; every `next.screen` is a known screen; every legend screen has entries.
- No sample names survive: no `Harborview`, `Riverbend`, `Healthgrades`, `Sports injuries` or `Oct 2026` in the copy module.
- `scoreBandColor`: 80 → primary, 79 → warn, 60 → warn, 59 → neg, null → null.

**Build:** `npm run build --prefix client` passes.

**In the app (Playwright skill), on each of the 8 screens:** every icon opens the right copy in Guided on (popover, highlight, Esc, outside click, scroll closes, "Open {Module} →" navigates) and Guided off (hover and focus tooltip); legend opens and stays open on outside click; light and dark theme; header at 1280px and 1600px (helper text hidden then shown, nothing wraps); ModuleCard icon click doesn't navigate; keyboard: Tab reaches each icon, Enter opens, focus returns on close.

## 10. Risks

- **Header width.** The right-hand row is already full. If the switch still crowds it at 1280px, the fallback is shortening the label to "Guided" below 1280px. That is decided during the visual check, not up front.
- **Copy drift.** Copy that describes scoring can go stale when scoring code changes. The unit tests catch the structure, not the meaning. Each corrected line in §5.2 names the code it describes, so a reviewer can re-check.
- **Older AI Visibility sentiment aggregation** is confirmed in code during implementation. If the KPI isn't a plain average, `v_sentiment.calc` is worded to match what it is.

## 11. As built (2026-10-15)

Differences from the sections above, and choices made during implementation:

- **Overview figures** are computed once in `components/home/overviewExplainCtx.js`. `ProfileStats` now reads its To fix, Pages crawled and Coverage figures from it (its comments moved with the logic), so the icons and the stats cannot quote different numbers.
- **`ui/Card` and `ui/MetricCard`** pass extra attributes through (`...rest`), so `data-explain-box` can sit on them. This is additive; existing callers are unchanged.
- **SEO & GEO's `InfoTip`** is deleted from `reportKit.jsx`, along with its React hook imports. Nothing else used it.
- **AI Visibility Lite tiles** were a `<button>`. They are now a box with a stretched toggle button, the same pattern as `ModuleCard`'s link, so the "i" can sit on the tile. The toggle keeps `aria-expanded` and an accessible name that includes the value. The score ring gains a caption ("How this score is built") carrying `l_score`, and the engine cards gain a "By AI model" kicker carrying `l_engines`.
- **The "i" ignores inherited `text-transform`**, so it stays an "i" inside uppercase headings (`SectionHead`'s `h6`).
- **Bundle:** `App.jsx` and `MacWindow.jsx` import the provider and toggle from their own files, not the folder index, so base-ui Popover and Tooltip load with the report pages rather than in the entry chunk.
- **Server:** `competitorAnalysis/trafficScore.js` (`withTrafficScore`) attaches the score on `GET /clients/:id/dashboard`, with a test in the server suite.
- **Verification** was done in a fixture harness, not the signed-in app, because local sign-in is Google-only:
  - 175 Playwright checks passed across 7 screens (Overview, Tech Audit, SEO & GEO, AI Visibility Lite, AI Visibility, Competitor, Hub and Spoke), in both themes and both modes;
  - not rendered in the harness: the Agent Readiness page, `ExecutiveSummary`, and the radar card on `HomePage`. All three compile in the production build.
