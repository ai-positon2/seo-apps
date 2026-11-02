// ── How every score is actually calculated ──────────────────────────────────
//
// The info icons explain each score for a CMO in a sentence. That is enough to
// say WHAT a score measures, and not enough to answer "why did warnings cost
// 22 points?" — which needs the weights, the caps, what is left out and where
// the rounding happens. This is that level, written from the scoring code
// itself (file references beside each part), and sent to the assistant for
// the report on screen so it can rebuild a figure from its parts.
//
// When a scoring rule changes in one of the referenced files, change it here.
// The figures themselves are never written here: they come from the report's
// own working (working.js) and the project's data.

const TECH = `TECH AUDIT — SITE HEALTH (client/src/components/crawlScope/crawlHelpers.js healthMetrics, healthLoss; server/modules/projects/overview.js siteHealth uses the same arithmetic)
- Pages scored: internal pages that returned 2xx HTML and were audited. Not scored: redirects, error pages (4xx/5xx), external sites, images/files, pages that refused the crawler (bot protection), status-only probes past the page budget, pages that could not be rendered.
- The issue list shows rules on every URL crawled, but only their occurrences on scored pages cost points. A rule listed in the report that occurs only on redirects (e.g. redirect chains, redirected URLs in the sitemap, temporary redirects), error pages or files (e.g. unminified JavaScript/CSS) costs 0 points; a rule listed on more URLs than scored pages costs only for its scored pages.
- Findings counted: page-level and template-level findings on scored pages. Site-wide findings (robots.txt, sitemap, HSTS, llms.txt) and reviewer-dismissed findings do not affect the score.
- Each scored page loses points per DISTINCT failing rule, by severity: error 40, warning 10, notice 2. A rule repeating on one page counts once (five images missing alt text = one rule).
- Cap: a page's loss is capped at 100. When a page's raw loss exceeds 100, every rule on that page is scaled by 100 ÷ raw loss, so the parts still add up.
- Per-severity loss = sum over pages of that severity's (scaled) points ÷ number of pages scored.
- Site health = round(100 − error loss − warning loss − notice loss), never below 0. Rounding happens once, at the end.
- The "How the points were lost" bars show each severity's exact loss rounded so the three add up to 100 − score exactly (largest-remainder rounding): each bar is the floor of its exact value, and the leftover points go to the bars with the largest fractions. So a bar can be up to 1 point off its exact value.
- A rule's cost = its weight × (pages it is on, each scaled by that page's cap factor) ÷ pages scored. Uncapped, that is simply weight × pages affected ÷ pages scored — e.g. a warning on 600 of 3,000 pages costs 10 × 600 ÷ 3,000 = 2 points. The rules of one severity sum to that severity's loss.`;

const SEOGEO = `SEO & GEO AUDIT — PAGE SCORE (server/checks/seoGeoChecks.js calculateScores, checkPoints, checkTier, SCORE_BUCKETS, BLOCKER_GROUPS, geoGates)
- Check points by status: pass 100, notice 85, warning 50, fail 0 if its severity is error, fail 25 otherwise (a warning-severity fail is usually a knock-on of another failure). Skipped / not applicable / informational checks are left out entirely.
- Check importance (tier): 3 for checks whose failure de-indexes or breaks the page, 1 for advisory checks, 2 otherwise. Page intent shifts a few: commercial pages T2, T10, T11, T12, R12, J23 → 3, T13 → 2, T4 → 1; informational pages T4 → 3, T2 → 2.
- Area (bar) score = round(Σ tier × points ÷ Σ tier × 100 × 100) over the scored checks in that area. An area with no scored checks is dropped, never counted as 100.
- The 9 areas and weights. SEO side: Title & Meta 0.14, Content & Structure 0.20, Indexability 0.14, Technical & Performance 0.09, Links & Media 0.07, Keyword Targeting 0.12 (only when keywords were given). GEO side: Schema 0.13, GEO Signals 0.13, E-E-A-T 0.10.
- Composite = round(Σ weight × area score ÷ Σ weight) over the areas present. Each area's effective weight = its weight ÷ Σ weights present; its "points lost" = effective weight × (100 − area score), rounded to 1 decimal.
- Blocking caps (any listed check failing triggers its group): noindex 25 (C1, C3), meta refresh 40 (C10), thin content 50 (F2), no title 60 (A1, A2), no H1 65 (E1, E3), no viewport 65 (M5, M6), canonical conflict 70 (D2), invalid JSON-LD 75 (J3, GEO side only). Cap = max(10, lowest triggered cap − 5 × (number triggered − 1)). Overall = min(composite, cap). Points removed by the cap = composite − overall.
- The overall page score is NOT a blend of the SEO and GEO side scores. It comes straight from the areas, as above.
- SEO and GEO side scores: separate views — the same weighted mean over only that side's areas, with only the caps that apply to that side. GEO is also held when the answerability check (T3) scores under 7/10: capped at 74 for 4–6.9, at 55 below 4.
- A check's cost inside its area = tier × (100 − its points) ÷ (Σ tier × 100 of the area's scored checks) × 100 area points; × the area's effective weight = headline points (before rounding).
- Bands: 90 Excellent, 75 Good, 60 Needs work, 40 Poor, below that Critical.
- The project dashboard's SEO & GEO score is the mean of the scored pages' overall scores, rounded; pages that returned an error are left out, not counted as 0.`;

const AGENT = `AGENT READINESS (server/routes/agentReadinessAudit.js WEIGHTS and total; server/checks/onpage.js)
- 13 HTTP checks worth 100 points in total: robots 7, sitemap 7, link headers 6, markdown 10, AI bots 11, content signals 9, web bot auth 0 (informational), API catalog 8, OAuth 8, OAuth resource 8, MCP 10, agent skills 10, WebMCP 6. Only a pass earns the points.
- Up to 10 on-page checks, run only when the matching page/form URL was given: form labels 10, input types 6, autocomplete 6, search schema 5, action schema 5, CAPTCHA 8, cookie banner 6, JS rendering 8, vague buttons 4 (shown as an advisory flag, still costs its 4 when it fails), interactive divs 5. All or nothing; across several pages, a fail on any page fails the check. Checks that did not run are left out.
- Total = round((HTTP points earned + on-page points earned) ÷ (100 + on-page points available) × 100). Only the total is rounded.
- A failed check's effect on the total = its points ÷ (100 + on-page points available) × 100.
- Category scores = round(points earned ÷ points available in that category × 100). HTTP categories: Discoverability 20, Content 10, Bot Access 20, API/Auth/MCP 50.
- Levels: 90+ L4, 75+ L3, 50+ L2, 25+ L1, below L0. The quick-win projection adds the points of failed quick-effort checks, using the same formula, capped at 100.
- The project dashboard's Agent Readiness score is the mean of the scored pages' totals.`;

const AIVIS_LITE = `AI VISIBILITY (server/modules/aiVisibilityLite/report.js; aiVisibility/scoring.js; aiVisibility/metrics/core.js)
- Answers counted: captured answers that are not off-region, for questions that still exist, where it could be decided whether the brand was named. Failed captures are left out, not counted as misses.
- Headline score = weighted blend of four readings, each 0–100: named 40, rank 25, perception 20, cited 15. A reading that cannot be measured is dropped and the rest reweighted: score = Σ reading × weight ÷ Σ weights of the readings present. A reading's contribution = reading × weight ÷ that sum.
- Named = round(answers naming the brand ÷ answers measured × 100).
- Rank = 100 × (N − average mention position) ÷ (N − 1), N = 1 + tracked competitors. Average mention position = the brand's average place in the order tracked brands first appear in each answer that names it. Needs at least 3 answers naming the brand and at least 2 brands, otherwise dropped.
- Perception = average over answers naming the brand of a tone × position score: positive 100 / 85 / 75 / 70, neutral 58 / 55 / 50 / 50, negative 10 / 20 / 25 / 25, for named first in the answer's list / in its top 3 / lower in the list / only in running text. Needs at least 3 toned answers; otherwise the latest run's single overall sentiment reading is used.
- Cited = answers linking to the brand's own domain ÷ answers where citations could be read × 100.
- Share of voice = answers naming the brand ÷ the sum of answers naming each tracked brand (counted in answers, not repeat mentions). Grounded rate = answers where the model ran a web search ÷ all captured answers.
- Per model and per question: named ÷ measured for that slice. Strongest/weakest model needs at least 20 measured answers per model and two models that qualify.
- Source gap score = round(max(0, answers using the source that named a competitor − answers using it that named the brand) × (answers using the source ÷ all measured answers) × 100 × source-type weight). Weights: competitor 1.0, reference 1.0, institutional 0.9, editorial 0.8, user-generated 0.7, corporate 0.6, other 0.5, your own site 0.
- Stage labels: up to 20 Barely visible, 40 Starting to show up, 60 Getting noticed, 80 Well known, above Leading the conversation.`;

const AIVIS = `AI VISIBILITY, SCRAPED (server/modules/aiVisibility/metrics/reports.js kpis; metrics/core.js; captureEngines)
- Answers counted: captured, not off-region; mentions marked as negated ("not X") are excluded.
- Visibility = answers that mention the brand ÷ answers captured.
- Sentiment = plain average of each mention's 0–100 score (0–19 hostile, 20–39 negative, 40–59 neutral with a bare listing at 50, 60–79 positive, 80–100 strongly recommended). Mentions that could not be scored are left out, not counted as neutral. Position does not adjust it.
- Position = average order of mention over the brand's mentions (map-card position where there is one, otherwise after the cards by order in the text). Lower is better; answers without the brand are not counted.
- Share of voice = the brand's mentions ÷ mentions of all measured brands; repeat mentions in one answer add up (unlike the API-based report, which counts answers).
- Where you stand: brands ranked by mention count; rank = the brand's place in that list.
- Strongest/weakest model needs at least 20 captures per model. Source gaps use the same formula as the API-based report.`;

const COMP = `COMPETITOR RESEARCH (server/modules/projects/moduleRunners.js competitorTrafficScore; overview.js competitorMetric)
- Uses Semrush's estimated monthly organic traffic per domain. Domains without a traffic figure are left out.
- Strongest competitor = the tracked competitor with the most traffic.
- Competitive score = min(100, round(your traffic ÷ strongest competitor's traffic × 100)). Ahead of all = your traffic ≥ the strongest's. If the strongest competitor has 0 traffic and you have some, the score is 100 ("Leading"); if both are 0 it is not measured. No competitors tracked: not measured, never 0.
- Rank = your place when all tracked domains, you included, are sorted by traffic, highest first.
- Traffic, keywords, authority score and backlinks are Semrush estimates, good for comparison rather than exact counts. Branded keywords are those containing the brand name.`;

const HUB = `HUB AND SPOKE (server/modules/contentArchitect/hubSelection.js, diagnostics.js, config.js)
- Pages are grouped into topic clusters by shared words and phrases, then named by AI.
- Hub score per candidate page (0–1): breadth of the cluster's vocabulary it covers 0.30, links into it from the cluster 0.25, word count 0.15, shallow URL 0.10, broad slug 0.10, AI agreement 0.10; penalties: spoke-style title −0.20, location page −0.40, legal page −0.40. If no page has links from inside the cluster, that 0.25 is shared across the other factors.
- Outcome: top hub score under 0.5 → try an existing broad page (≥3 members, slug made only of the cluster's core words, ≥500 words, no penalty); if none, "Hub missing". Top two within 15% of each other → "Hub unclear". Otherwise "Hub found".
- Cluster health (0–100) = 30 if it has a hub (not a gap) + 20 × the hub's vocabulary breadth + 15 if the cluster has 3–12 pages (hub included) + 20 × link density (links between cluster pages ÷ n × (n − 1)) + 15 × max(0, 1 − average click depth ÷ 8), rounded. Bands: 70+ good, 40+ needs attention, below poor.
- Page flags: Orphaned = no internal links point to it; Buried = 4+ clicks from the homepage; Thin = under 500 words, or not updated in 18 months.
- The dashboard's Hub and Spoke score = the rounded average of the clusters' health.`;

const OVERVIEW = `PROJECT OVERVIEW (server/modules/projects/overview.js buildComposite; insights/executive.js; insights/backlog.js)
- Overall score = round(average of the module scores that exist) over the dashboard cards: Tech Audit, Hub and Spoke, Competitor Research, SEO & GEO, AI Visibility, Agent Readiness. A module that has not run is left out, not counted as 0. The scraped AI Visibility module is not part of it.
- Module scores on the cards: Tech Audit = the latest crawl's site health; Hub and Spoke = average cluster health; Competitor = the competitive score; SEO & GEO and Agent Readiness = average of the audited pages' scores; AI Visibility = the report's headline score. While a module is running, its card shows the average of the pages scored so far.
- Verdict, in this order: nothing run → not measured; any error-level finding anywhere → at risk, whatever the score; overall 80+ → healthy; below 60 → below where it should be; otherwise worth attention.
- Bands: 80+ good, 60–79 needs attention, below 60 at risk.
- Fix list order: severity (error, warning, notice), then template-wide fixes first, then pages affected (most first), then the module's own priority, then title.`;

// The overview gets every method: questions there range over all the modules.
const BY_SCREEN = {
  overview: [OVERVIEW, TECH, SEOGEO, AGENT, AIVIS_LITE, COMP, HUB],
  tech: [TECH, OVERVIEW],
  seogeo: [SEOGEO, OVERVIEW],
  agent: [AGENT, OVERVIEW],
  aivisLite: [AIVIS_LITE, OVERVIEW],
  aivis: [AIVIS, OVERVIEW],
  comp: [COMP, OVERVIEW],
  hub: [HUB, OVERVIEW],
};

/** The scoring method text for a screen; the overview's for any other page. */
function methodologyFor(screen) {
  return (BY_SCREEN[screen] || [OVERVIEW]).join('\n\n');
}

module.exports = { methodologyFor, BY_SCREEN };
