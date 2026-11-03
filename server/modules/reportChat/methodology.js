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
- The issue list shows rules on every URL crawled. A rule's occurrences on scored pages cost per page (below); a rule on more URLs than scored pages costs per page only for its scored pages.
- Findings counted per page: page-level and template-level findings on scored pages. Reviewer-dismissed findings never count.
- Each scored page loses points per DISTINCT failing rule, by severity (v6+): error 40, warning 10, notice 0 — notices are listed but cost nothing. A rule repeating on one page counts once (five images missing alt text = one rule).
- Site-level charge (v7): a rule no scored page carries is charged ONCE for the site, not per URL — site-wide problems (crawler blocked, robots.txt, sitemaps, soft-404s; also resource files) 5 per error rule and 2 per warning rule; page rules found only on redirects, error pages or files 2 per error rule and 1 per warning rule. All site-level charges together are capped at 20 points (scaled down proportionally above that). Notices cost nothing here either.
- Graded today: a rule's severity is read from the current rule catalog, not the one stored when the crawl ran. v7 downgraded links to redirects, titles a little long, a single slow page load and external sites that were down when checked to notices.
- Cap: a page's loss is capped at 100. When a page's raw loss exceeds 100, every rule on that page is scaled by 100 ÷ raw loss, so the parts still add up.
- Per-severity loss = sum over pages of that severity's (scaled) points ÷ number of pages scored.
- Site health = round(100 − error loss − warning loss − site-level charge), never below 0. Rounding happens once, at the end. Never 100 while an error remains (shown as 99).
- The "How the points were lost" bars (Errors, Warnings, Notices, and Site-wide when it cost anything) show each exact loss rounded so they add up to 100 − score exactly (largest-remainder rounding): each bar is the floor of its exact value, and the leftover points go to the bars with the largest fractions. So a bar can be up to 1 point off its exact value.
- A rule's cost = its weight × (pages it is on, each scaled by that page's cap factor) ÷ pages scored. Uncapped, that is simply weight × pages affected ÷ pages scored — e.g. a warning on 600 of 3,000 pages costs 10 × 600 ÷ 3,000 = 2 points. The rules of one severity sum to that severity's loss; site-level rules sum to the Site-wide bar.
- What-ifs: on a page at the 100-point cap, fixing one rule wins back LESS than its share, because the page's other rules fill the gap. Use the report's scoreIfOnlyThisWereFixed / gainIfFixed / fewestFixesToReach, which recompute page by page; never subtract shares. "Pages at the floor" = pages whose problems add up to 100+ points.
- Comparing crawls: only like for like. The report warns when the page budget changed between crawls, since a score over 50 pages and one over 1,850 pages are different measurements.`;

const SEOGEO = `SEO & GEO AUDIT — PAGE SCORE (server/checks/seoGeoChecks.js calculateScores, checkPoints, checkTier, SCORE_BUCKETS, BLOCKER_GROUPS, geoGates)
- Check points by status: pass 100, notice 85, warning 50, fail 0 if its severity is error, fail 25 otherwise (a warning-severity fail is usually a knock-on of another failure). Skipped / not applicable / informational checks are left out entirely.
- Duplicate checks are counted once: S1 (=M21), S4 (=F25), O1 (=M16), O5 (=G10), M22 (=C9), U4 (=S6), Q4 (=H5), O4 (=G6) are not applicable whenever the first id is in the report.
- Title and meta description length limits are the same as Tech Audit's: title 30–60 characters, meta description 70–160.
- Check importance (tier): 3 for checks whose failure de-indexes or breaks the page, 1 for advisory checks, 2 otherwise. Page intent shifts a few: commercial pages T2, T10, T11, T12, R12, J23 → 3, T13 → 2, T4 → 1; informational pages T4 → 3, T2 → 2.
- Area (bar) score = round(Σ tier × points ÷ Σ tier × 100 × 100) over the scored checks in that area. An area with no scored checks is dropped, never counted as 100.
- The 9 areas and weights. SEO side: Title & Meta 0.14, Content & Structure 0.20, Indexability 0.14, Technical & Performance 0.09, Links & Media 0.07, Keyword Targeting 0.12 (only when keywords were given). GEO side: Schema 0.13, GEO Signals 0.13, E-E-A-T 0.10.
- Composite = round(Σ weight × area score ÷ Σ weight) over the areas present. Each area's effective weight = its weight ÷ Σ weights present; its "points lost" = effective weight × (100 − area score), rounded to 1 decimal.
- Blocking caps (any listed check failing triggers its group): noindex 25 (C1, C3), meta refresh 40 (C10), thin content 50 (F2), no title 60 (A1, A2), no H1 65 (E1, E3), no viewport 65 (M5, M6), canonical conflict 70 (D2), invalid JSON-LD 75 (J3, GEO side only). Cap = max(10, lowest triggered cap − 5 × (number triggered − 1)). Overall = min(composite, cap). Points removed by the cap = composite − overall.
- The overall page score is NOT a blend of the SEO and GEO side scores. It comes straight from the areas, as above.
- SEO and GEO side scores: separate views — the same weighted mean over only that side's areas, with only the caps that apply to that side. GEO is also held when the answerability check (T3) scores under 7/10: capped at 74 for 4–6.9, at 55 below 4.
- Answerability (T3, out of 10) is also reported as its own figure: 7+ "AI can answer from this page", 4–6.9 "Partly answerable", below 4 "Hard for AI to answer from". When it holds the GEO score, that is said beside the headline; the overall score itself is not held.
- A check's cost inside its area = tier × (100 − its points) ÷ (Σ tier × 100 of the area's scored checks) × 100 area points; × the area's effective weight = headline points (before rounding).
- Bands: 90 Excellent, 80 Good, 60 Needs work, 40 Poor, below that Critical.
- The project dashboard's SEO & GEO score is the mean of the scored pages' overall scores, rounded; pages that returned an error or a bot wall are left out, not counted as 0.
- Which pages: taken in turn from each section of the site (first path segment after any locale), so a page budget covers different templates rather than the homepage and the pages one click away. Country homepages queue behind the root.`;

const AGENT = `AGENT READINESS (server/routes/agentReadinessAudit.js WEIGHTS and total; server/checks/onpage.js)
- It measures how future-ready the site is for AI agents, so emerging protocols that few sites have yet are deliberately weighted.
- 13 HTTP checks worth 100 points in total: robots 7, sitemap 7, link headers 6, markdown 10, AI bots 11, content signals 9, web bot auth 0 (informational), API catalog 8, OAuth 8, OAuth resource 8, MCP 10, agent skills 10, WebMCP 6. Only a pass earns the points. Protocol files must be real JSON documents (a web page answering the address does not count).
- Link headers pass only for a rel that points an agent somewhere (api-catalog, service-desc, service-doc, describedby, alternate, sitemap and the like), not preload/preconnect. AI bots pass with named AI-crawler rules, or when robots.txt lets every crawler in. WebMCP passes when the page's own HTML registers tools with navigator.modelContext (scripts in separate files are not read).
- robots.txt, the sitemap and /.well-known files are fetched once per site and shared by every page of a run (10 minutes).
- Up to 9 on-page checks, run only when the matching page/form URL was given: form labels 10, input types 6, autocomplete 6, action schema 5, CAPTCHA 8, cookie banner 6, JS rendering 8, vague buttons 4 (shown as an advisory flag, still costs its 4 when it fails), interactive divs 5. SearchAction is no longer checked (Google retired the feature it powered in November 2024). All or nothing; across several pages, a fail on any page fails the check. Checks that did not run are left out.
- A site that refused the audit (robots.txt and the page both refused or errored) is "Blocked — not measured", never 0.
- Total = round((HTTP points earned + on-page points earned) ÷ (100 + on-page points available) × 100). Only the total is rounded.
- A failed check's effect on the total = its points ÷ (100 + on-page points available) × 100.
- Category scores = round(points earned ÷ points available in that category × 100). HTTP categories: Discoverability 20, Content 10, Bot Access 20, API/Auth/MCP 50.
- Levels: 90+ Level 4 Agent native, 80+ Level 3 Future-ready, 60+ Level 2 Getting ready, 40+ Level 1 Early steps, below Level 0 Not started. The quick-win projection adds the points of failed quick-effort checks, using the same formula, capped at 100.
- The project dashboard's Agent Readiness score is the mean of the scored pages' totals.`;

const AIVIS_LITE = `AI VISIBILITY (server/modules/aiVisibilityLite/report.js; aiVisibility/scoring.js; aiVisibility/metrics/core.js)
- Answers counted: captured answers that are not off-region, for questions that still exist, where it could be decided whether the brand was named. Failed captures are left out, not counted as misses.
- Headline = the mention rate: answers naming the brand ÷ answers measured. Shown with its 95% range (Wilson interval); with 30 answers that is about ±15 points. No headline below 10 measured answers. A change smaller than the range is not shown as a rise or fall, and changes compare only the questions both periods asked.
- Stages on the rate: under 10% Rarely named, under 25% Sometimes, under 50% Often, under 75% Usually, else Almost always named.
- Usual position, how warmly described (perception) and cited rate are shown beside the rate as qualifiers, not blended into it. The rate is also given separately for recommendation questions and informational ones; new question sets are half of each.
- Answers judged not to be about the brand ("not about you") count as not named. Engines that did not answer are flagged and left out, not counted as misses.
- The older blended score (named 40, rank 25, perception 20, cited 15, reweighted over the readings present) is still computed for history but is not the headline.
- Rank = 100 × (N − average mention position) ÷ (N − 1), N = 1 + tracked competitors. Average mention position = the brand's average place in the order tracked brands first appear in each answer that names it. Needs at least 3 answers naming the brand and at least 2 brands, otherwise dropped.
- Perception = average over answers naming the brand of a tone × position score: positive 100 / 85 / 75 / 70, neutral 58 / 55 / 50 / 50, negative 10 / 20 / 25 / 25, for named first in the answer's list / in its top 3 / lower in the list / only in running text. Needs at least 3 toned answers; otherwise the latest run's single overall sentiment reading is used.
- Cited = answers linking to the brand's own domain ÷ answers where citations could be read × 100.
- Share of voice = answers naming the brand ÷ the sum of answers naming each tracked brand (counted in answers, not repeat mentions). Grounded rate = answers where the model ran a web search ÷ all captured answers.
- Per model and per question: named ÷ measured for that slice. Strongest/weakest model needs at least 20 measured answers per model and two models that qualify.
- Source gap score = round(max(0, answers using the source that named a competitor − answers using it that named the brand) × (answers using the source ÷ all measured answers) × 100 × source-type weight). Weights: competitor 1.0, reference 1.0, institutional 0.9, editorial 0.8, user-generated 0.7, corporate 0.6, other 0.5, your own site 0.
- Questions are written for the project's country (its market); the site is read with that country's language preference.`;

const AIVIS = `AI VISIBILITY, SCRAPED (server/modules/aiVisibility/metrics/reports.js kpis; metrics/core.js; captureEngines)
- Answers counted: captured, not off-region; mentions marked as negated ("not X") are excluded.
- Visibility = answers that mention the brand ÷ answers captured.
- Sentiment = plain average of each mention's 0–100 score (0–19 hostile, 20–39 negative, 40–59 neutral with a bare listing at 50, 60–79 positive, 80–100 strongly recommended). Mentions that could not be scored are left out, not counted as neutral. Position does not adjust it.
- Position = average order of mention over the brand's mentions (map-card position where there is one, otherwise after the cards by order in the text). Lower is better; answers without the brand are not counted.
- Share of voice = answers naming the brand ÷ the sum of answers naming each measured brand; an answer that repeats a name counts once (as in the API-based report).
- Where you stand: brands ranked by answers naming them. A brand named in no answer has no rank ("Not named"), and with fewer than 10 measured answers there is no ranking.
- Strongest/weakest model needs at least 20 captures per model. Source gaps use the same formula as the API-based report.`;

const COMP = `COMPETITOR RESEARCH (server/modules/projects/moduleRunners.js competitorTrafficScore; overview.js competitorMetric)
- Uses Semrush's estimated monthly organic traffic per domain. Domains without a traffic figure are left out.
- Strongest competitor = the tracked competitor with the most traffic.
- Market position is context, not a grade: your traffic as a share of the strongest competitor's, uncapped (over 100% means you lead, and by how much), with the same share against the median tracked rival, and the date of the Semrush figures. It mostly reflects company size, so it has no pass mark and is not part of the overall score.
- A domain with no traffic figure (or 0) is "no data", never 0; if the client or every rival has none, it is "Not measured".
- Rank = your place when all tracked domains, you included, are sorted by traffic, highest first.
- Traffic, keywords, authority score and backlinks are Semrush estimates, good for comparison rather than exact counts. Branded keywords are those containing the brand name.`;

const HUB = `HUB AND SPOKE (server/modules/contentArchitect/hubSelection.js, diagnostics.js, config.js)
- Pages are grouped into topic clusters by shared words and phrases, then named by AI.
- Hub score per candidate page (0–1): breadth of the cluster's vocabulary it covers 0.30, links into it from the cluster 0.25, word count 0.15, shallow URL 0.10, broad slug 0.10, AI agreement 0.10; penalties: spoke-style title −0.20, location page −0.40, legal page −0.40. If no page has links from inside the cluster, that 0.25 is shared across the other factors.
- Outcome: top hub score under 0.5 → try an existing broad page (≥3 members, slug made only of the cluster's core words, ≥500 words, no penalty); if none, "Hub missing". Top two within 15% of each other → "Hub unclear". Otherwise "Hub found".
- Cluster health (0–100, v2) = 30 if it has a hub (15 if the hub is only suggested or is a glossary index) + 20 × the hub's vocabulary breadth + 30 × hub ↔ spoke linking ((spokes linking to the hub + spokes the hub links to) ÷ (2 × spokes)) + 20 × max(0, 1 − average click depth ÷ 8), rounded. Click depth is the shortest link path from the homepage where known. Pages in no cluster are listed as unassigned and do not enter the site average (the report says how many). Bands: 80+ healthy, 60–79 needs work, below 60 weak.
- Page flags: Orphaned = no internal links point to it; Buried = 4+ clicks from the homepage; Thin = under 500 words, or not updated in 18 months.
- The dashboard's Hub and Spoke score = the rounded average of the clusters' health.`;

const OVERVIEW = `PROJECT OVERVIEW (server/modules/projects/overview.js buildComposite; insights/executive.js; insights/backlog.js)
- Overall score = round(average of the site-quality module scores that exist): Tech Audit, SEO & GEO, Agent Readiness, Hub and Spoke. A module that has not run is left out, not counted as 0. Competitor Research and AI Visibility are shown as context (a share, a mention rate) and are not part of it.
- Module figures on the cards: Tech Audit = the latest crawl's site health; Hub and Spoke = average cluster health; Competitor = market position (share of the leader's traffic); SEO & GEO and Agent Readiness = average of the audited pages' scores; AI Visibility = the mention rate. While a module is running, its card shows the average of the pages scored so far.
- Verdict, in this order: nothing run → not measured; any error-level finding that lowers a score (for Tech Audit, one counted in site health, including site-level charges) → action needed, whatever the score; overall 80+ → in good shape; below 60 → below where it should be; otherwise worth attention. Errors that are only listed are said to be listed, not critical.
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
