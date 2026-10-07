# Front-end audit: pending work

Status as of 2026-10-04. Covers the React client in `client/` (React 18.3, Vite 5, React Router v6 — not Next.js).

This lists everything from the front-end performance and structure audit that has **not** been done yet, in the order it should be done, with enough detail to pick up any item cold. Each item says what the problem is, where it is, what to change, what users will notice, what can go wrong, and how to check it.

---

## Contents

1. [Already done](#already-done)
2. [Before starting anything: commit what is done](#before-starting-anything-commit-what-is-done)
3. [Recommended order](#recommended-order)
4. [A. Bundle size](#a-bundle-size)
5. [B. Data fetching and polling](#b-data-fetching-and-polling)
6. [C. Component structure and duplication](#c-component-structure-and-duplication)
7. [Deliberately not doing](#deliberately-not-doing)
8. [How to verify changes safely](#how-to-verify-changes-safely)
9. [Baseline measurements](#baseline-measurements)

---

## Already done

Implemented, tested (72/72 client tests pass, production build succeeds) and checked in a browser. **Not committed yet.**

| Audit # | Change | File |
|---|---|---|
| 15 (part) | Lite page now imports the shared markdown renderer instead of its own identical copy | `client/src/pages/ArticleEnhancementLitePage.jsx` |
| 8 | Patterns and saved analysis fetched in parallel | `client/src/pages/ContentArchitectProjectPage.jsx` |
| 11 | Two-scenario compare runs both requests in parallel | `client/src/pages/MarketPotentialPage.jsx` |
| 12 | Crawl-status object keeps its identity until a value changes, so sidebar search no longer re-renders the open page | `client/src/lib/useCrawlStatus.js` |
| 18 | Auth and theme context values memoised | `client/src/context/AuthContext.jsx`, `client/src/components/ThemeContext.jsx` |
| 4 | The current page's code starts downloading next to the session check (`preloadRoute`), not after it | `client/src/App.jsx`, `client/src/main.jsx` |

---

## Before starting anything: commit what is done

The working tree holds **55 modified files, but only the 8 above belong to this work.** The other 47 (server routes, API clients, `MacWindow.jsx`, keyword research components, and more) come from a separate piece of work. Stage the 8 by name; do not use `git add -A`.

```powershell
git add client/src/App.jsx client/src/main.jsx client/src/context/AuthContext.jsx client/src/components/ThemeContext.jsx client/src/lib/useCrawlStatus.js client/src/pages/ArticleEnhancementLitePage.jsx client/src/pages/ContentArchitectProjectPage.jsx client/src/pages/MarketPotentialPage.jsx
git commit -m "Client: preload route chunk, parallel loaders, memoised contexts, shared markdown renderer"
```

Pushing this branch redeploys production (Railway) and interrupts running crawls. Push deliberately.

---

## Recommended order

| Order | Item | Effort (rough) | Payoff | Visible to users? |
|---|---|---|---|---|
| 1 | [A1 Markdown without syntax highlighting](#a1-markdown-libraries-without-syntax-highlighting) | 1 hour incl. check | ~600 kB less JavaScript on 4 pages | Code blocks lose colours |
| 2 | [A2 Lazy-load the AI Visibility Lite answer preview](#a2-lazy-load-the-ai-visibility-lite-answer-preview) | 1–2 hours | Markdown library leaves AI Visibility Lite's first load | Brief placeholder the first time an answer opens |
| 3 | [A3 Lazy-load the Content Writer draft editor](#a3-lazy-load-the-content-writer-draft-editor) | 1 hour | ~435 kB leaves Content Writer's first load | Brief placeholder the first time a draft opens |
| 4 | [C1 Finish de-duplicating Article Enhancement Lite](#c1-finish-de-duplicating-article-enhancement-lite) | 1–2 hours | Fixes land on both pages | None |
| 5 | [B1 AI Visibility Lite: poll status, not the report](#b1-ai-visibility-lite-poll-the-status-not-the-full-report) | 2–3 hours | Stops re-reading every capture every 4 s | Report numbers refresh on state changes, not every tick |
| 6 | [B2 Shared polling hook that pauses in hidden tabs](#b2-one-polling-hook-that-pauses-in-hidden-tabs) | 0.5–1 day | Less background server load | Hidden tabs stop updating until you come back |
| 7 | [B3 One shared project list](#b3-one-shared-project-list) | 0.5–1 day | Fewer duplicate `/api/projects` reads | None if done right |
| 8 | [A4 Lazy-load the Market Potential map](#a4-lazy-load-the-market-potential-map) | 1 hour | 216 kB off that page's first load | Map appears a moment after the form |
| 9 | [C3 Shared helpers and badges](#c3-shared-helpers-and-badges) | 0.5 day | Less drift between tools | None |
| 10 | [C2 One score-colour standard](#c2-one-score-colour-standard) | 0.5 day **after a decision** | Same score, same colour everywhere | Yes — some scores change colour |
| 11 | [C4 Move hand-written tables to DataTable](#c4-move-hand-written-tables-to-datatable) | Ongoing | Consistent sorting / empty states / accessibility | Small layout differences |
| 12 | [C5 Merge the two location-page wizards](#c5-merge-the-two-location-page-wizards) | 3–5 days | Biggest maintenance win | None if done right — needs full testing |
| 13 | [C6 Split the largest page components](#c6-split-the-largest-page-components) | Ongoing, per page | Fewer whole-page re-renders, easier changes | None |

Items 1–3 can ship as one change. Items 5–6 belong together.

---

## A. Bundle size

### A1. Markdown libraries without syntax highlighting

**Problem.** `@uiw/react-markdown-preview` and `@uiw/react-md-editor` both pull in syntax highlighting for 594 programming languages (`refractor`). Together with the markdown parser they form the `vendor-md` chunk: **1,046 kB (362 kB gzip)**, the largest file in the build and the only one over the 600 kB warning limit.

**Where it is imported.**

- `client/src/components/aiVisibilityLite/reports.jsx:18` — `@uiw/react-markdown-preview`
- `client/src/pages/KBEditorPage.jsx:3` — `@uiw/react-md-editor`
- `client/src/pages/CreateKBPage.jsx:3` — `@uiw/react-md-editor`
- `client/src/pages/ClientFeedbackPage.jsx:3` — `@uiw/react-md-editor`

**Change.** Both packages ship a `nohighlight` entry point:

```js
import MarkdownPreview from '@uiw/react-markdown-preview/nohighlight';
import MDEditor from '@uiw/react-md-editor/nohighlight';
```

**Measured effect** (standalone esbuild bundles, so indicative rather than exact Vite output):

| Package | Full | `nohighlight` |
|---|---|---|
| Preview | 984 kB (331 kB gzip) | 392 kB (117 kB gzip) |
| Editor | 1,060 kB (355 kB gzip) | 443 kB (133 kB gzip) |

**What users notice.** Fenced code blocks in AI answers and knowledge-base content render as plain monospace text, without colours.

**Check before shipping.**

- All three editors run with `preview="edit"` (no preview pane), so no rendered preview is affected there. **Not yet confirmed:** whether the editor's own writing area keeps its coloured markdown (headings, bold, list markers) under `nohighlight`. Open the knowledge-base editor and compare. If it loses colours and that matters, switch only the preview import and leave the editor imports as they are — most of the AI Visibility Lite saving still applies.
- Confirm styling: the `vendor-md` CSS chunk must still load and the editor toolbar must look the same.
- Rebuild and confirm `vendor-md` is under the 600 kB warning limit.

### A2. Lazy-load the AI Visibility Lite answer preview

**Problem.** `AiVisibilityLitePage` statically imports `components/aiVisibilityLite/reports.jsx`, which statically imports the markdown preview. The preview is only used inside `AnswerPanel` (`reports.jsx:1577`, rendered at `:1620`), which appears only after a user clicks an answer card. Today the whole markdown chunk downloads with the page.

There is a second trap: `client/vite.config.js` puts the editor **and** the preview (and all of remark/rehype) into one `vendor-md` bucket. Lazy-loading the preview on its own would still pull in the editor code, because a bucket is emitted as a single chunk.

**Change.**

1. In `reports.jsx`, replace the static import with a lazy one and wrap its use in `Suspense`:

   ```jsx
   import { lazy, Suspense } from 'react';
   const MarkdownPreview = lazy(() => import('@uiw/react-markdown-preview/nohighlight'));

   // inside AnswerPanel
   <Suspense fallback={<div style={{ minHeight: 80 }} aria-busy="true" />}>
     <MarkdownPreview source={s.answerText} components={MARKDOWN_COMPONENTS} style={…} />
   </Suspense>
   ```

2. In `client/vite.config.js` `manualChunks`, give the editor its own bucket ahead of the generic markdown rule:

   ```js
   if (is('@uiw/react-md-editor')) return 'vendor-md-editor';   // KB + feedback pages only
   // …existing vendor-md rule follows (preview + remark/rehype)
   ```

   The editor chunk will import `vendor-md`; AI Visibility Lite will load only `vendor-md`.

3. Optional: start the import when the pointer enters an answer card (`onMouseEnter={() => import('@uiw/react-markdown-preview/nohighlight')}`) so the placeholder is rarely seen.

**What users notice.** The first time an answer is opened in a session, a short blank area appears while the preview code downloads.

**Check.**

- Build, then confirm `AiVisibilityLitePage-*.js` no longer has a static import of `vendor-md` (grep the built chunk for `from"./vendor-md`).
- Confirm `dist/index.html` still preloads only the entry, `vendor-react` and `vendor-router` (the rule written in the comment at the top of `vite.config.js`).
- Open an answer: links still open in a new tab (`MARKDOWN_COMPONENTS`), headings and lists render.

### A3. Lazy-load the Content Writer draft editor

**Problem.** `ContentWriterPage` chunk is **465 kB**; Tiptap alone measures **435 kB**. Tiptap is only imported by `components/contentWriter/DraftEditor.jsx`, which only renders on the Draft tab once a draft exists (`ContentWriterPage.jsx:305`).

**Change.** In `client/src/pages/ContentWriterPage.jsx:11`:

```jsx
const DraftEditor = lazy(() => import('../components/contentWriter/DraftEditor'));
```

Wrap the render at `:305` in `<Suspense>` with a fallback that has roughly the editor's height, so the page does not jump. The existing `key={record?.id || 'new'}` remount behaviour is unaffected.

**What users notice.** A short placeholder the first time a draft is shown in a session.

**Check.** Build: `ContentWriterPage-*.js` should drop to roughly 30 kB and a separate chunk should hold Tiptap. Generate or open a draft, switch Preview/Edit, edit text, save — `onChange` must still update `draftHtml`.

### A4. Lazy-load the Market Potential map

**Problem.** `MarketPotentialPage.jsx:9` statically imports `USMetroMap`, which pulls `react-simple-maps` plus the bundled US state outlines (`vendor-maps`: **216 kB, 72 kB gzip**). The map is visible on the form (`:680`), so this only lets the rest of the form appear first.

**Change.** `const USMetroMap = lazy(() => import('../components/USMetroMap'));` and wrap `:680` in `Suspense` with a fixed-height placeholder matching the map's height.

**What users notice.** The map fills in a moment after the rest of the form.

**Check.** Click metros on the map: `onToggle` still adds/removes them from the comparison; home and selected markers still highlight.

---

## B. Data fetching and polling

### B1. AI Visibility Lite: poll the status, not the full report

**Problem.** In `client/src/pages/AiVisibilityLitePage.jsx`:

- `load()` (`:525`) awaits `aivLiteApi.status()` (`:528`) and then `aivLiteApi.report()` (`:534`). The code's own comment says the report "reads every capture the project has".
- While a setup or run is in flight, `setInterval(load, POLL_MS)` (`:579`, `POLL_MS = 4000`) calls **both** every 4 seconds.
- An `async` function inside `setInterval` can overlap itself: if a report read takes longer than 4 s, the next tick starts another before the first finishes.
- The separate sentiment poll (`:550`) re-reads the report every 4 s for up to 30 tries; that one is bounded and can stay, but should use the same timer pattern.

**Change.**

1. Split `load()` into `loadStatus()` and `loadReport()`.
2. While `working`, poll **only** `loadStatus()`, using a `setTimeout` chain (schedule the next call after the previous one finishes) — see B2.
3. Fetch the report when something that changes it happens: `latestRun.status` or `latestRun.id` changes, `setup.status` changes, or `working` goes from true to false. Keep a ref with the last status signature to compare against.
4. If people rely on numbers filling in during a run, also refresh the report on a slower cadence while working (for example every 30 s), not every 4 s.

**What users notice.** Report figures update when the run changes state (and at the slow cadence, if added) instead of every 4 seconds.

**Risks.** Missing a transition means a stale report until the next reload. Always fetch the report once when `working` becomes false.

**Check.** Mock or run a measurement: watch the network panel — during a run only `status` should repeat; the report should be fetched at start, on transitions and at the end.

### B2. One polling hook that pauses in hidden tabs

**Problem.** Eleven polling loops, each hand-written, with six different interval constants. None pauses when the tab is hidden. (`ModuleRuns.jsx:282` listens to `visibilitychange`, but only to refresh on return — it keeps polling while hidden.) Several use `setInterval` with `async` callbacks, which can overlap.

| Location | What it polls | Interval |
|---|---|---|
| `client/src/lib/useCrawlStatus.js:82` | Live crawl status, in the app shell — runs on every page, forever | 4 s live / 15 s idle |
| `client/src/pages/HomePage.jsx:266` | Full dashboard overview during a crawl | 8 s |
| `client/src/components/project/ProjectReportBar.jsx:196` | Module detail while an audit is in flight | 15 s |
| `client/src/pages/AiVisibilityLitePage.jsx:550`, `:579` | Sentiment report; status + report | 4 s |
| `client/src/pages/CompetitorAnalysisDashboardPage.jsx:384`, `:422`, `:505` | Run, PageSpeed and content-analysis status | various |
| `client/src/pages/RobotsMonitorPage.jsx:896` | Robots run status | various |
| `client/src/components/ModuleRuns.jsx:268` | Run list | 5 s active / 15 s idle |

Leave `CrawlScopeRunPage.jsx:383` alone — it is a clock tick for the "stalled" indicator and makes no requests.

**Change.** Add `client/src/hooks/usePoll.js`:

```js
/**
 * usePoll(fn, { intervalMs, enabled = true, pauseWhenHidden = true, immediate = true })
 * - intervalMs may be a number or a function of the last result (for two cadences).
 * - Chains setTimeout after each call resolves, so calls never overlap.
 * - While document.hidden, no calls are made; on becoming visible it calls fn at once.
 * - Clears on unmount and when enabled turns false.
 */
```

Then migrate each loop above. `useCrawlStatus` keeps its two cadences via the function form and its existing `sameStatus` comparison.

**What users notice.** A background tab stops updating crawl progress and run status; it catches up the moment the tab is shown again.

**Risks.**

- Code that relies on a poll to notice completion (for example to show a toast or enable a button) will now do so when the tab becomes visible rather than while hidden. That is the intended behaviour, but check each page's completion handling still fires once.
- Keep cancellation: each migrated loop currently guards against setting state after unmount or after a project switch; the hook must do the same (an `alive` flag per effect run).

**Check.** For each migrated page: start the relevant job, switch to another tab for longer than one interval, confirm in the network panel that requests stop, return, and confirm an immediate request and correct state.

### B3. One shared project list

**Problem.** `GET /api/projects` is called from nine places with three unrelated caches:

| Call site | Cache |
|---|---|
| `client/src/components/MacWindow.jsx:283` (header client switcher) | none |
| `client/src/components/project/ProjectReportBar.jsx:128` | none |
| `client/src/components/project/ModuleDetailPanel.jsx:104` | none |
| `client/src/pages/AiVisibilityPage.jsx:126` | none |
| `client/src/pages/CompetitorAnalysisDashboardPage.jsx:143` | none |
| `client/src/pages/ContentWriterPage.jsx:52` | none |
| `client/src/pages/HomePage.jsx:131` | uses `takePrefetch('projects')` once |
| `client/src/lib/useActiveProject.js:18` | module cache keyed on projects version |
| `client/src/lib/runLabel.js:17` | its own module cache, never invalidated |

On Home, the dashboard consumes the startup prefetch and the header fetches again. On the audit pages, the header, `ProjectReportBar` and (where used) `useActiveProject` each fetch.

**Change.**

1. Create `client/src/lib/projectsList.js` with one cache of the **raw** response (callers need different parts: `projects`, `workspaces`, `activeWorkspaceId`):

   ```js
   getProjectsList({ force = false } = {})   // returns a shared promise
   invalidateProjectsList()                  // called when the projects version changes
   ```

   Key the cache on the version from `useProjectsChanged()` the way `useActiveProject` does today. On failure, clear the cache so the next caller retries.

2. Seed it from `homePrefetch.js` so the startup read is shared rather than single-use.
3. Point every call site above at it. `useActiveProject` keeps its deleted-project filter; `runLabel` builds its name map from the shared result and gains invalidation.
4. **Keep the header's deliberate refresh:** `MacWindow` re-reads the list when its menu opens (to show clients added in another tab or by a teammate) and once before "repairing" an unknown selection. Both must call `getProjectsList({ force: true })`.

Alternative: adopt TanStack Query or SWR app-wide. Larger change; only worth it if more shared server state is coming.

**What users notice.** Nothing, if step 4 is kept.

**Check.** Load Home and an audit page with the network panel open: one `/api/projects` per page load. Create a project from Home's setup card and confirm the header shows it immediately; open the client menu and confirm a fresh read.

---

## C. Component structure and duplication

### C1. Finish de-duplicating Article Enhancement Lite

**Done:** the markdown renderer copy was removed.

**Remaining:** three components are still copied between `client/src/pages/ArticleEnhancementPage.jsx` and `client/src/pages/ArticleEnhancementLitePage.jsx`:

| Component | Full page | Lite page | Difference |
|---|---|---|---|
| `StepIndicator` | `:28` | `:21` | 1 line; each reads its own module-level `STEPS` (the two pipelines have different steps) |
| `EnhancedArticlePanel` | `:126` | `:76` | Caption text only |
| `CrawlFailedPanel` | `:141` | `:92` | Identical |

**Change.** Move all three into `client/src/components/articleEnhancement/`. `StepIndicator` takes `steps` as a prop; `EnhancedArticlePanel` takes `caption`. Both pages import them.

**Check.** Run both enhancers through the crawl-failure path (manual paste) and a normal run; step labels and captions must match what each page shows today.

### C2. One score-colour standard

**Needs a decision first:** this deliberately changes some colours.

**Problem.** Score-to-colour helpers use different bands, so the same score is a different colour in different tools:

| File | Green from | Amber from |
|---|---|---|
| `client/src/ui/ScoreRing.jsx:4` | 70 | 45 |
| `client/src/components/seoGeo/primitives.jsx:77` | 70 | 45 |
| `client/src/components/competitorAnalysisDashboard/utils.js:33` | 70 | 40 (returns tone names, not colours) |
| `client/src/pages/AgentReadinessSummaryPage.jsx:70` | 70 | 40 |
| `client/src/components/onPageAudit/OnPageReport.jsx:75` | 80 | 60 |
| `client/src/lib/scoreVerdict.js` (Home dashboard module badge) | 80 | 60 |
| `client/src/components/competitorAnalysis/ReportPreview.jsx:9` | 90 | 50 |

There are also about 11 inline `score >= N ? 'var(--success…' : …` expressions (six in `AgentReadinessAuditPage.jsx`), and a `scoreTone` in `client/src/components/aiVisibility/reports/RunDetailReport.jsx:23`.

**Decide.** One set of bands for everything, or named sets per score type (for example a stricter one for on-page audits). Whoever owns the reports should pick.

**Change.** Add `scoreTone(score, bands = DEFAULT_BANDS)` next to `ui/ScoreRing.jsx` returning a tone name (`'good' | 'warn' | 'bad'`), and a map from tone to CSS variable. Replace every helper and inline expression with it.

**Watch out.** `client/src/lib/__tests__/scoreVerdict.test.js` pins the Home dashboard badge to 80/60 ("Good" / "Needs attention" / "At risk"), the same bands that dashboard uses to colour the number. If the chosen standard differs, change `scoreVerdict.js`, its test and the dashboard card colouring together so the badge and the number never disagree.

### C3. Shared helpers and badges

| Duplicate | Copies | Keep |
|---|---|---|
| `formatDate` | 5 in `client/src/components/teamInsights/*View.jsx` (4 identical) | Move one to `client/src/lib/format.js` |
| `escapeHtml`, `keyOf` | `KeywordResearchPublicPage.jsx`, both location wizards | Already exported by `client/src/lib/keywordResearchModel.js` |
| `copyToClipboard` | `LocationServiceWizardPage.jsx:58`, `LsWizard.jsx:214`, `ExportButtons.jsx:64` | One in `client/src/lib/clipboard.js` (the wizard version handles HTML + text) |
| `statusColor` | `crawlScope/report/UrlsTable.jsx`, `seoGeo/ScoreDashboard.jsx`, `teamInsights/MondayPlanningView.jsx` | One helper |
| `StatusBadge` | Local copies in `onPageAudit/OnPageReport.jsx`, `SerpUrls.jsx`, `teamInsights/MorningTriageView.jsx` | `client/src/ui/Badge.jsx:69` already exports one |
| Status → badge-variant maps | 20+ per-file maps (`STATUS_VARIANT`, `SEVERITY_VARIANT`, `TONE_TO_VARIANT`, …) | One shared map in `ui/Badge.jsx` |

Pure moves; behaviour must not change. Diff each copy against the one being kept before deleting it — where copies differ, decide which behaviour is right rather than picking one silently.

### C4. Move hand-written tables to DataTable

**Problem.** 34 files contain raw `<table>` markup; only 7 use `client/src/ui/DataTable`. Sorting, empty states, sticky headers and accessibility differ from screen to screen.

**Change.** Migrate opportunistically, starting with the five `client/src/components/teamInsights/*View.jsx` views (same layout, 3–4 tables each), then `KeywordResearchPublicPage.jsx` (4) and `LsWizard.jsx` (3).

**First, check** what `DataTable` supports (row spans, custom cells, sticky header, row click). Extend it where a migration needs something, rather than leaving a page on a raw table.

**What users notice.** Small layout and styling changes in migrated tables. Review each with whoever uses that tool.

### C5. Merge the two location-page wizards

**Problem.** Two separately maintained wizards of about 1,450 lines each:

- `client/src/pages/LocationServiceWizardPage.jsx` — Gentle Dental, route `/location-page-builder/wizard`, 4 steps, main component about 1,095 lines with 37 `useState`.
- `client/src/components/lsPages/LsWizard.jsx` — template-driven clients, used by `ClearBehavioralHealthPage.jsx` (`/location-page-builder/clear-behavioral-health`), 5 steps, main component about 1,185 lines with 37 `useState`.

Only about a quarter of the lines match exactly; the rest is a rewritten copy. More than 15 helpers exist in both, some renamed: `escapeHtml`, `stripHtml`, `keyOf`, `copyToClipboard`, `CopyButton`, `PickerList`, `SourceTag` (different palette), `SectionCard`, `FieldLabel`, `RegenButton`, `CharCount`/`Counter`, `htmlBlockToPlainText`/`htmlToPlain`, `plainTextToHtmlBlock`/`plainToHtml`, and style objects (`btnStyle`/`btn`, `inputStyle`, `labelStyle`, `removeBtnStyle`/`removeBtn`). A fix in one copy silently misses the other.

**Change, in three separately shippable phases.**

1. **Shared helpers (no behaviour change).** Move the helpers and small components into `client/src/components/lsPages/shared/`. Where the two versions differ, decide which is correct and note it in the commit. `SourceTag` has two palettes: either pick one (visible change — confirm with the users of both tools) or give it a `palette` prop.
2. **Shared steps.** Steps that do the same job in both wizards (the first two) become shared components that take the client-specific data as props.
3. **One wizard frame with explicit variants.** A single `LocationWizard` frame (step navigation, saved state, layout) with `GentleDentalSteps` and `TemplateClientSteps` supplying the steps that genuinely differ. Avoid a `mode` flag that branches throughout; each variant should be its own component.

**Test plan (each phase).** Run both wizards end to end: pick location and service, keyword selection, content generation, field regeneration, copy-to-clipboard (HTML and plain text), and export. Compare the output HTML before and after for the same inputs.

### C6. Split the largest page components

Single components with many state hooks re-render in full on every change, and are risky to edit.

| Component | Lines | `useState` |
|---|---|---|
| `client/src/pages/CrawlScopeRunPage.jsx:86` | ~1,059 | 18 |
| `client/src/pages/CompetitorAnalysisDashboardPage.jsx:126` | ~1,038 | 29 |
| `client/src/pages/HomePage.jsx:38` | ~959 | 10 (plus 9 effects) |
| `client/src/pages/AgentReadinessAuditPage.jsx:309` | ~873 | 20 |
| `client/src/pages/KeywordResearchPublicPage.jsx:70` | ~872 | 19 |
| `client/src/pages/MarketPotentialPage.jsx:131` | ~659 | 21 |
| `client/src/pages/ArticleEnhancementPage.jsx:194` | ~622 | 23 |
| `client/src/pages/ProjectsPage.jsx:227` (`ProjectDetail`) | ~622 | 10 |
| `client/src/pages/LocationPageDetailPage.jsx:257` (`ContentTab`) | ~575 | — |
| `client/src/pages/ContentArchitectProjectPage.jsx:88` | ~547 | 15 |
| `client/src/components/project/ProjectReportBar.jsx:48` | ~503 | 11 (plus 11 effects) |

**Approach.** Split by tab or step, moving the state each part owns into it; group state that changes together into a `useReducer` or a custom hook (for example `useCompetitorDashboard`). `client/src/pages/RobotsMonitorPage.jsx` is the model already in the repo: 1,175 lines split into 23 components.

Do this when a page is next changed for another reason, not as a standalone rewrite; `CompetitorAnalysisDashboardPage` (29 `useState`) is the strongest standalone candidate.

---

## Deliberately not doing

**Crawl report: fetching the run and its findings in parallel** (`client/src/pages/CrawlScopeRunPage.jsx:155`–`165`). Today the page reads the run, then — only for a finished crawl — its findings. Starting both at once would save one round trip, but the server's unpaged findings read (`server/modules/crawlScope/api/routes.js:386`) can return thousands of rows, and its own comments warn a 10,000-page crawl risks running out of memory. Firing it speculatively on every visit to a running crawl, only to discard it, is not worth the saving. Revisit if the page moves to the paged (`?limit=`) or per-rule (`?grain=rule`) form of that endpoint.

**Memoising the large AI Visibility Lite report components.** `reports.jsx` has no `useMemo`, but its sorts and filters run over small per-project data. B1 removes the 4-second re-renders that would have made this matter.

---

## How to verify changes safely

The local `.env` points at the production database, so do **not** start the server to test client changes. Instead:

1. **Unit tests:** `cd client; npm test` (72 tests at the time of writing).
2. **Build into a scratch folder** so `client/dist` is untouched:
   `npx vite build --outDir <scratch>/build`
   Check the chunk list, and that `<scratch>/build/index.html` preloads only the entry, `vendor-react` and `vendor-router`.
3. **Browser check without a server:** serve the build with `npx vite preview --outDir <scratch>/build --port 4317 --strictPort`, and drive it with Playwright, answering every `/api/**` request inside the browser (`page.route`). Answer `/api/auth/verify` with `{ "valid": false }` for the login screen, or `{ "valid": true, "hasProfile": true, … }` for a signed-in session, and give each page the fixture data it needs.
   - Known noise: with every other endpoint returning `{}`, all signed-in pages throw `Cannot read properties of undefined (reading 'toLocaleString')`. The unchanged build does the same; it comes from the empty fixtures, not from a regression.
4. **Bundle numbers:** compare the build's chunk table before and after. Do not quote load-time improvements unless they were measured.

---

## Baseline measurements

From `vite build` on 2026-10-01, before any of the pending work. Use these to confirm each change.

| Chunk | Size | Gzip | Loaded by |
|---|---|---|---|
| `index` (entry) | 96 kB | 28 kB | Every visit |
| `vendor-react` | 142 kB | 46 kB | Every visit |
| `vendor-router` | 22 kB | 8 kB | Every visit |
| `vendor-md` | 1,046 kB | 362 kB | AI Visibility Lite, KB editor, Create KB, Client Feedback |
| `ContentWriterPage` | 465 kB | 148 kB | Content Writer |
| `vendor-xlsx` | 429 kB | 143 kB | SEO & GEO Excel export only (already on demand) |
| `vendor-docx` | 319 kB | 91 kB | Article Recommendation Word export only (already on demand) |
| `vendor-maps` | 216 kB | 72 kB | Market Potential |
| `SeoGeoAuditPage` | 113 kB | 31 kB | SEO & GEO audit |

Not measured: page-load times, network timings, or render times in the running app.
