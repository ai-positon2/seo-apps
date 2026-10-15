// ── Explainer and legend copy ───────────────────────────────────────────────
//
// What every "i" says, in plain business English for CMOs and investors reading
// on their own. Started from the design handoff's draft and corrected against
// the scoring code: each calculation line below describes what the code does,
// not what the prototype assumed (docs/superpowers/specs/2026-10-15-explainers-
// design.md §5.2 lists every correction and the file it was checked against).
//
// Shape of each explainer:
//   t     title (tooltip and popover header)
//   s     one line: what this shows. The only body text a hover tooltip shows.
//   why   why it matters to the business
//   good  what good looks like
//   calc  how it is calculated
//   src   where the data comes from
//   next  { label, screen? } the suggested next step; `screen` adds an
//         "Open {Module} →" link
//
// t, s, why and good are always plain strings. calc, src and next may be
// functions of `ctx` — the figures the screen already has loaded — so a worked
// example is the client's own arithmetic. A function must cope with an empty
// ctx: every icon renders before, or without, the data it describes, and a
// missing figure falls back to wording that needs none, never to 0.

import { isNum, num, compact, plural, list } from './explainFormat.js';
import { EXPLAINER_KEYS_BY_SCREEN, MODULE_SCREEN, screenOf } from './explainScreens.js';

export { EXPLAINER_KEYS_BY_SCREEN };

// ── Shared pieces ───────────────────────────────────────────────────────────

const onDashboard = (ctx) => (ctx.modules || []).filter((m) => m.card !== false);
const hasScore = (m) => Boolean(m.scored) && isNum(m.score);

/** Why a module card is not in the composite, as a verb phrase for N modules. */
function leftOutReason(m, many) {
  if (m.status === 'not_run') return many ? 'haven’t run yet' : 'hasn’t run yet';
  if (m.status === 'needs_setup') return many ? 'aren’t set up yet' : 'isn’t set up yet';
  if (!m.scored) return many ? 'report findings rather than a score' : 'reports findings rather than a score';
  return many ? 'have no score yet' : 'has no score yet';
}

/** "(82 + 77) ÷ 2 = 80", or null when nothing has scored. */
function compositeFormula(ctx) {
  const scored = onDashboard(ctx).filter(hasScore);
  if (!scored.length) return null;
  const scores = scored.map((m) => Math.round(m.score));
  const value = isNum(ctx.composite?.value)
    ? ctx.composite.value
    : Math.round(scored.reduce((sum, m) => sum + m.score, 0) / scored.length);
  return `(${scores.join(' + ')}) ÷ ${scored.length} = ${value}`;
}

function compositeCalc(ctx) {
  const never = 'An audit with no score is never counted as zero.';
  const mods = onDashboard(ctx);
  if (!mods.length) {
    return 'The plain average of the audit scores that exist. Audits that report findings rather '
      + `than a score, or haven’t run yet, are left out. ${never}`;
  }
  const formula = compositeFormula(ctx);
  if (!formula) return `Not measured yet: no audit has produced a score. ${never}`;

  // One sentence per reason, so "Hub and Spoke reports findings" and "Agent
  // Readiness hasn't run yet" are not blurred into one excuse.
  const groups = new Map();
  for (const m of mods.filter((x) => !hasScore(x))) {
    const reason = leftOutReason(m, false);
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(m);
  }
  const leftOut = [...groups.values()].map((ms) => {
    const many = ms.length > 1;
    return `${list(ms.map((m) => m.label))} ${leftOutReason(ms[0], many)}, so ${many ? 'they are' : 'it is'} left out.`;
  });
  return [`The plain average of the audit scores that exist: ${formula}.`, ...leftOut, never].join(' ');
}

/** The traffic division behind the competitor score, or null. */
function trafficFormula(ts) {
  if (!ts || !isNum(ts.ratio) || !isNum(ts.clientTraffic) || !isNum(ts.strongestTraffic)) return null;
  const raw = Math.round(ts.ratio * 100);
  const result = raw > 100 ? `${raw}, capped at 100` : String(raw);
  return `${compact(ts.clientTraffic)} ÷ ${compact(ts.strongestTraffic)} = ${result}`;
}

function competitorCalc(ctx) {
  const base = 'Your estimated monthly visits from Google ÷ the strongest tracked competitor’s × 100, capped at 100.';
  if (!('trafficScore' in ctx)) return base;
  const ts = ctx.trafficScore;
  if (!ts) return `${base} Not measured yet: it needs traffic figures for this site and at least one competitor.`;
  if (ts.ratio === null && ts.aheadOfAll) return `${base} Every tracked competitor shows no organic traffic, so the score is 100.`;
  const formula = trafficFormula(ts);
  return formula ? `${base} Today that is ${formula}.` : base;
}

/**
 * The sentence under the Competitive score card. Same wording rules as the
 * dashboard card: a capped 100 says "ahead", not "100%".
 */
export function competitiveScoreSentence(ts) {
  if (!ts) return 'Not measured yet: this needs traffic figures for this site and at least one competitor.';
  const rival = ts.strongestDomain || 'the strongest competitor';
  if (ts.ratio === null && ts.aheadOfAll) return 'Every tracked competitor shows no organic traffic, so you lead.';
  if (!isNum(ts.ratio)) return null;
  if (ts.ratio > 1) return `You’re ahead of ${rival}, the strongest competitor tracked.`;
  if (ts.ratio === 1) return `You’re level with ${rival}, the strongest competitor tracked.`;
  return `Your search traffic is ${Math.round(ts.ratio * 100)}% of ${rival}’s, the strongest competitor tracked.`;
}

const pointsFor = (breakdown, label) => (breakdown || []).find((b) => b.label === label)?.points;

function techLostCalc(ctx) {
  const e = pointsFor(ctx.breakdown, 'Errors');
  const w = pointsFor(ctx.breakdown, 'Warnings');
  const n = pointsFor(ctx.breakdown, 'Notices');
  if (![e, w, n, ctx.health].every(isNum)) {
    return 'The points each kind of problem removed, averaged over all pages. The bars add up to the '
      + 'points lost, and 100 minus that is the score.';
  }
  const lost = e + w + n;
  return `The points each kind of problem removed, averaged over all pages: errors ${e} + warnings ${w} `
    + `+ notices ${n} = ${lost} points lost, so 100 − ${lost} = ${ctx.health}.`;
}

const answersSrc = (n, fallback) => (isNum(n) ? `${num(n)} measured ${plural(n, 'answer')}` : fallback);

// ── The explainers ──────────────────────────────────────────────────────────

export const EXPLAINERS = {
  // ── Overview ──
  exec: {
    t: 'Executive summary',
    s: 'The one-paragraph answer: is the site in good shape, which way is it heading, and what should happen first.',
    why: 'It tells you in seconds whether search performance is a risk to the business right now, without reading any of the detail below.',
    good: 'A green “Healthy” headline, an “Improving” trend and a short list of fixes.',
    calc: 'The verdict follows the most serious problem found in any audit, together with the composite score. Every sentence is written from stored audit results. Nothing is estimated or invented.',
    src: (ctx) => (isNum(ctx.coverage?.covered) && isNum(ctx.coverage?.total) && ctx.coverage.covered > 0
      ? `Stored results from ${ctx.coverage.covered} of ${ctx.coverage.total} audits`
      : 'Stored audit results'),
    next: { label: 'Work through the fixes listed under it, in order.' },
  },
  trend: {
    t: 'Direction since the last audit',
    s: 'Whether the site got better or worse compared with the previous audit.',
    why: 'A score tells you where you are. The direction tells you whether the work you are paying for is paying off.',
    good: '“Improving” on audit after audit.',
    calc: 'Only pages checked in both audits are compared, so a change in what was checked isn’t mistaken for a change in the site. A first audit says “nothing to compare yet” rather than pretending nothing changed.',
    src: 'This audit compared with the previous one',
    next: { label: 'Check this again after the next audit runs.' },
  },
  priorities: {
    t: 'Start with these',
    s: 'The fixes that should move the needle most, across every audit.',
    why: 'It points the team’s time where it has the biggest effect instead of spreading it across dozens of small issues.',
    good: 'Few items, each touching only a few pages.',
    calc: 'Ranked by seriousness first (error, then warning, then notice), then by how many pages each problem reaches. A fix to a shared page template counts once but reaches every page built on it.',
    src: 'Ranked list of fixes from all audits',
    next: { label: 'Share the list with your web team.' },
  },
  composite: {
    t: 'Composite score',
    s: 'One overall number for the site: the average of every audit that produced a score.',
    why: 'A single figure you can track month to month and compare across sites.',
    good: '80 or above is Good. 60–79 Needs attention. Below 60 is At risk.',
    calc: compositeCalc,
    src: (ctx) => (isNum(ctx.composite?.scoredModules) && isNum(ctx.composite?.totalModules) && ctx.composite.scoredModules > 0
      ? `${ctx.composite.scoredModules} of ${ctx.composite.totalModules} audits scored`
      : 'Audits that produced a score'),
    next: { label: 'Find the lowest card below. That’s the audit pulling the average down.' },
  },
  tofix: {
    t: 'To fix',
    s: 'How many separate things need fixing, and how many are a single change that fixes many pages at once.',
    why: 'It sizes the workload. Template changes are the best value: one change by a developer improves many pages.',
    good: 'A small number, with a large share of template changes.',
    calc: 'Each kind of problem counts as one action, however many pages it affects. A “template change” is a problem in a shared layout that many pages use, so fixing it once fixes them all.',
    src: 'Ranked list of fixes from all audits',
    next: (ctx) => {
      const n = ctx.toFix?.templateWide;
      return isNum(n) && n > 0
        ? { label: `Do the ${n} template ${plural(n, 'change')} first. Each one fixes many pages at once.` }
        : { label: 'Start with the first item in the executive summary’s list.' };
    },
  },
  pages: {
    t: 'Pages crawled',
    s: 'How many web pages the latest site crawl read.',
    why: 'It shows how much of the site the scores describe. If it is far below the site’s real size, the scores only describe part of the site.',
    good: 'Close to the number of pages you expect the site to have.',
    calc: 'Counts real web pages only, not images or files. Crawled isn’t the same as audited: page-level audits such as SEO & GEO check a selection of these pages in depth.',
    src: 'Latest site crawl',
    next: { label: 'Open the Tech Audit to see what the crawl found.', screen: 'tech' },
  },
  coverage: {
    t: 'Coverage',
    s: 'How many of the audits have run for this client.',
    why: 'A high score with low coverage can mislead, because it only reflects what was checked. An audit that hasn’t run is a blind spot, not a pass.',
    good: 'Every audit run.',
    calc: 'An audit counts once it has stored any results, whether or not it gives a score.',
    src: 'Audit run history',
    next: (ctx) => {
      const notRun = onDashboard(ctx).filter((m) => m.status === 'not_run');
      if (!ctx.modules) return { label: 'Run any audit that hasn’t run yet.' };
      return notRun.length
        ? { label: `Run ${list(notRun.map((m) => m.label))} to close the blind ${plural(notRun.length, 'spot')}.` }
        : { label: 'Nothing to do. Every audit has run.' };
    },
  },
  radar: {
    t: 'Audit profile',
    s: 'The audit scores laid out in a circle so the weak spots stand out.',
    why: 'It shows at a glance which area is holding the site back.',
    good: 'Every point green and close to the outer ring.',
    calc: 'Each point is one audit’s own score out of 100, coloured with the same bands. The audits use different methods, so the shape doesn’t measure “balance”. A dash at the rim means that audit doesn’t give a score, not that it scored zero.',
    src: 'Latest run of each audit',
    next: (ctx) => {
      const scored = onDashboard(ctx).filter(hasScore);
      if (!scored.length) return { label: 'Open the audit with the lowest point.' };
      const lowest = scored.reduce((lo, m) => (m.score < lo.score ? m : lo), scored[0]);
      return { label: `Open the audit with the lowest point: ${lowest.label}.`, screen: MODULE_SCREEN[lowest.key] };
    },
  },
  m_technical: {
    t: 'Tech Audit',
    s: 'How healthy the site is technically: whether Google can reach, read and trust its pages.',
    why: 'Technical faults quietly stop pages from ranking, however good the content is.',
    good: '80+, with no errors on pages that bring in customers.',
    calc: (ctx) => {
      const pages = num(ctx.module?.evidence?.pagesCrawled);
      return 'Every page starts at 100 and loses 40 points for each kind of error, 10 for each kind of warning '
        + `and 2 for each kind of notice. The score is the average across ${pages ? `all ${pages}` : 'the crawled'} pages.`;
    },
    src: (ctx) => {
      const pages = num(ctx.module?.evidence?.pagesCrawled);
      return pages ? `Site crawl · ${pages} pages` : 'Site crawl';
    },
    next: { label: 'Open the Tech Audit for the ranked fixes.', screen: 'tech' },
  },
  m_hub: {
    t: 'Hub and Spoke',
    s: 'How well the site’s content is organised into topics, each with a main “hub” page.',
    why: 'Search engines and AI assistants favour sites that clearly own a topic. Scattered content competes with itself.',
    good: 'Few findings, and every topic has a hub.',
    calc: 'This audit reports findings rather than a score, so the card shows a count and the audit is left out of the composite.',
    src: 'Content map from the site crawl',
    next: { label: 'Open Hub and Spoke to see which topics need a hub.', screen: 'hub' },
  },
  m_competitor: {
    t: 'Competitor Research',
    s: 'How much search traffic the site wins compared with its strongest competitor.',
    why: 'It’s the clearest single read on your market share in Google.',
    good: '80+ means you are close to, or ahead of, the leader.',
    calc: 'Your estimated monthly visits from Google ÷ the strongest tracked competitor’s × 100, capped at 100.',
    src: 'Semrush estimates',
    next: { label: 'Open Competitor Research to see where the gap is.', screen: 'comp' },
  },
  m_seogeo: {
    t: 'SEO & GEO',
    s: 'How well your key pages are built to rank on Google and to be quoted by AI assistants.',
    why: 'These are the pages that turn visitors into customers, so small gains here show up directly in leads.',
    good: '75 or above on every important service page.',
    calc: 'Each page’s checks are grouped into 9 weighted areas: 6 for search engines (SEO) and 3 for AI answer engines (GEO). The page score blends the two sides, and the card’s small SEO and GEO bars show each side. A serious blocking problem caps a page’s score until it’s fixed. The card shows the average of the pages audited.',
    src: 'Page audits',
    next: { label: 'Open SEO & GEO to see the page-by-page verdicts.', screen: 'seogeo' },
  },
  m_aivis: {
    t: 'AI Visibility',
    s: 'How often AI assistants such as ChatGPT name the brand when people ask about its services.',
    why: 'More buyers ask an AI assistant before they search. If the brand isn’t named, it isn’t considered.',
    good: 'Named in most answers, and ahead of competitors.',
    calc: 'The share of measured answers that name the brand when ChatGPT, Claude and Gemini are asked this project’s prompts through their APIs, with web search on. Prompts that failed to capture are left out, not counted as misses. The report’s headline ring is a different, weighted score; its own (i) explains it.',
    src: 'Latest AI Visibility run',
    next: (ctx) => (ctx.module?.key === 'ai_visibility'
      ? { label: 'Open AI Visibility to see which questions you’re missing.', screen: 'aivis' }
      : { label: 'Open AI Visibility to see which prompts you’re missing.', screen: 'aivisLite' }),
  },
  m_agent: {
    t: 'Agent Readiness',
    s: 'Whether AI agents, assistants that browse and book on a customer’s behalf, can find and use the site.',
    why: 'Agents are a new route to customers. A site they can’t read is left off their shortlist.',
    good: '80+. Below 60 means agents are largely shut out.',
    calc: '13 HTTP checks, plus 10 on-page checks when page and form URLs are given, each worth a set number of points by importance. The score is the points earned out of 100.',
    src: 'Live scan of the site',
    next: { label: 'Open Agent Readiness to see which checks failed.', screen: 'agent' },
  },

  // ── Tech Audit ──
  t_health: {
    t: 'Site health',
    s: 'The technical health of every page the crawl reached, out of 100.',
    why: 'Technical faults stop good pages from being found. This is the floor everything else is built on.',
    good: '80 or above, with no errors on pages that bring in customers.',
    calc: (ctx) => {
      const pages = num(ctx.htmlCount);
      return 'Each page starts at 100 and loses 40 points for each kind of error, 10 for each kind of warning '
        + `and 2 for each kind of notice. The score is the average across the ${pages ? `${pages} ` : ''}HTML pages `
        + 'crawled. Redirects, broken pages and other sites aren’t scored.';
    },
    src: 'Site crawl',
    next: { label: 'Start with “What to do first”.' },
  },
  t_lost: {
    t: 'How the points were lost',
    s: 'Which kind of problem cost the most points. The longest bar is where the score can be won back fastest.',
    why: 'It shows whether a few serious faults or many small ones are holding the score back. Those are two very different jobs.',
    good: 'Short bars, especially for errors.',
    calc: techLostCalc,
    src: 'Site crawl',
    next: (ctx) => {
      const e = pointsFor(ctx.breakdown, 'Errors');
      const rest = (pointsFor(ctx.breakdown, 'Warnings') || 0) + (pointsFor(ctx.breakdown, 'Notices') || 0);
      return isNum(e) && e > rest
        ? { label: 'Fix the errors first. They cost more than everything else combined.' }
        : { label: 'Start with the longest bar.' };
    },
  },
  t_urls: {
    t: 'URLs fetched',
    s: 'Everything the crawler downloaded: pages, images, scripts and files.',
    why: 'It confirms the crawl went deep enough. It is always bigger than the page count.',
    good: 'Comfortably under the page limit, so nothing was cut off.',
    calc: (ctx) => (num(ctx.pageLimit)
      ? `A straight count of addresses fetched, up to the page limit set for this crawl (${num(ctx.pageLimit)}).`
      : 'A straight count of addresses fetched, up to the page limit set for this crawl.'),
    src: 'Site crawl',
    next: { label: 'If this is at the page limit, part of the site wasn’t crawled. Raise the limit and crawl again.' },
  },
  t_html: {
    t: 'HTML pages',
    s: 'The actual web pages found. Every score on this screen is calculated over these.',
    why: 'If this is much smaller than the site’s real size, the score only describes part of the site.',
    good: 'Close to the number of pages you expect.',
    calc: 'Addresses that returned a web page. Images, files, feeds and pages that refused the crawler are left out.',
    src: 'Site crawl',
    next: { label: 'Check this against the size of the site in your CMS.' },
  },
  t_indexable: {
    t: 'Findable by Google',
    s: 'Pages that Google is allowed to show in its results.',
    why: 'A page that isn’t findable can’t bring in search traffic, however good it is.',
    good: 'Every page you want customers to land on.',
    calc: 'Web pages that load properly and aren’t marked “don’t index” or redirected somewhere else.',
    src: 'Site crawl',
    next: { label: 'Check that every page you want customers to land on is findable.' },
  },
  t_issues: {
    t: 'Pages with an error or warning',
    s: 'Errors are likely stopping a page from performing. Warnings are holding it back.',
    why: 'It shows how much of the site is affected, not just how many problems exist.',
    good: 'No errors, and warnings on only a small share of pages.',
    calc: 'Pages with at least one problem of that seriousness. The line underneath shows how many kinds of problem there are and how many times they occur in total.',
    src: 'Site crawl',
    next: { label: 'Start with the errors. They are listed first under “What to do first”.' },
  },
  t_external: {
    t: 'External links checked',
    s: 'Links to other websites, checked to make sure they still work.',
    why: 'Broken links make pages look neglected to visitors and to search engines.',
    good: 'All of them working.',
    calc: 'Each outgoing link is visited once. Any that fail appear as findings.',
    src: 'Site crawl',
    next: { label: 'Fix any broken ones that appear in the issue list.' },
  },
  t_first: {
    t: 'What to do first',
    s: 'The most important technical fixes, with what to do about each.',
    why: 'It turns the audit into a short work order your developers can start on today.',
    good: 'An empty list.',
    calc: 'Ranked by seriousness first, then by how many pages each problem touches. These are the top rows of the full issue list.',
    src: 'Site crawl',
    next: { label: 'Send these to your developers.' },
  },

  // ── SEO & GEO ──
  g_score: {
    t: 'Page score',
    s: 'How well this page is built to rank on Google and to be quoted by AI assistants, out of 100.',
    why: 'Service pages like this one are where visitors become customers.',
    good: '75 or above is Good, 90 or above Excellent. The five bands: Critical 0–39, Poor 40–59, Needs work 60–74, Good 75–89, Excellent 90–100.',
    calc: 'The page’s checks are grouped into 9 weighted areas: 6 for search engines (SEO) and 3 for AI answer engines (GEO). The overall score blends the two sides. A serious blocking problem (noindex, no title, no H1, thin content) caps the score until it’s fixed.',
    src: 'Page audit',
    next: { label: 'Follow the priority verdict below. It names the change worth the most points.' },
  },
  g_seo: {
    t: 'SEO score',
    s: 'Can search engines like Google find, index and rank this page?',
    why: 'This is the half of the score that decides where the page ranks in ordinary search results.',
    good: '75 or above.',
    calc: 'The six SEO areas (title and meta, content and structure, indexability, technical and performance, links and media, keyword targeting), weighted into one number.',
    src: 'Page audit',
    next: { label: 'Open the weakest SEO area below. It’s where points are easiest to win back.' },
  },
  g_geo: {
    t: 'GEO score',
    s: 'Can AI answer engines read, trust and cite this page?',
    why: 'More buyers ask an AI assistant before they search. This half decides whether the page gets quoted.',
    good: '75 or above.',
    calc: 'The three GEO areas (schema, GEO signals, E-E-A-T), weighted into one number. If the engines report a gap, the GEO score is held until it is fixed.',
    src: 'Page audit',
    next: { label: 'Fix any engine marked Not ready first, then the weakest GEO area.' },
  },
  g_verdict: {
    t: 'Priority verdict',
    s: 'The single most valuable change for this page, in one sentence.',
    why: 'It saves anyone reading every check result to find the one that matters.',
    good: 'A small, specific change.',
    calc: 'Written by AI from this page’s own check results and shown with its weakest area. If the AI step didn’t run, this box says so rather than guessing.',
    src: 'AI analysis of this page’s audit',
    next: { label: 'Brief whoever owns this page on the change it names.' },
  },
  g_platforms: {
    t: 'Will AI engines show this page?',
    s: 'Whether each major AI assistant has what it needs to quote or recommend this page.',
    why: 'More buyers ask AI tools before they search. Being quotable is the new page one.',
    good: 'Ready on every engine listed.',
    calc: 'An AI review of the page against what each assistant looks for: clear answers, structure, trust signals and structured data. Each gets Ready, Partial or Not ready, with the reason.',
    src: 'AI analysis of this page’s audit',
    next: { label: 'Start with any engine marked Not ready.' },
  },
  g_wins: {
    t: 'Quick wins',
    s: 'Low-effort changes that should lift the score soon.',
    why: 'They deliver early, visible progress while bigger fixes are scheduled.',
    good: 'Short, and shorter after each audit.',
    calc: 'Picked by the AI analysis from failed checks that are quick to fix.',
    src: 'AI analysis of this page’s audit',
    next: { label: 'Work through them in order. They are the quickest gains.' },
  },
  g_counts: {
    t: 'Check results',
    s: 'How the page did across every check that applies to it.',
    why: 'It gives a quick sense of scale: mostly passing, or lots to do?',
    good: 'No errors, and warnings in single figures.',
    calc: (ctx) => `Counted over the ${num(ctx.checksApplied) ? `${num(ctx.checksApplied)} ` : ''}checks that apply to this page. `
      + 'Checks that don’t apply or were skipped aren’t counted as passes or failures.',
    src: 'Page audit',
    next: { label: 'The errors are listed in the full technical detail.' },
  },

  // ── Agent Readiness ──
  a_score: {
    t: 'Agent readiness score',
    s: 'How ready the site is for AI agents: assistants that browse, compare and book on a customer’s behalf.',
    why: 'Agents are an emerging route to customers. If they can’t read or reach the site, it isn’t on their shortlist.',
    good: '80+. Below 60 means agents are largely shut out.',
    calc: (ctx) => {
      const tail = 'The score is the points earned out of 100. The level, from Not Indexed up to Agent Native, sums up how far along the site is.';
      const cats = (ctx.cats || []).filter(Boolean);
      if (isNum(ctx.checkCount) && ctx.checkCount > 0 && cats.length) {
        return `${ctx.checkCount} automatic checks across ${cats.length} categories (${list(cats)}), each worth points by business impact. ${tail}`;
      }
      return `13 HTTP checks on every scan, plus 10 on-page checks when page and form URLs are given, each worth points by business impact. ${tail}`;
    },
    src: 'Live scan of the site',
    next: { label: 'Start with the failing checks that carry the most points.' },
  },
  a_sub: {
    t: 'Score by category',
    s: 'Where points were won and lost, category by category.',
    why: 'It shows whether this is a quick settings change or a bigger build.',
    good: 'Every bar green.',
    calc: (ctx) => {
      const cats = (ctx.cats || []).filter(Boolean);
      return 'Each bar is the points earned in that category as a share of the points it offers.'
        + (cats.length ? ` Categories in this scan: ${list(cats)}.` : '')
        + ' Bars use the same bands as every score: 80+ green, 60–79 amber, below 60 red.';
    },
    src: 'Live scan of the site',
    next: { label: 'Start with the lowest bar.' },
  },
  a_brief: {
    t: 'Executive summary',
    s: 'What the result means for the business: the biggest risk, the near-term opportunity and how you compare.',
    why: 'It’s written to be forwarded to leadership as is.',
    good: 'A small risk and a concrete opportunity.',
    calc: 'Written by AI from the check results. It doesn’t add anything that wasn’t measured.',
    src: 'AI summary of this scan',
    next: { label: 'Forward this to whoever owns the website roadmap.' },
  },
  a_checks: {
    t: 'Every check',
    s: 'Every individual check, and whether the site passed it.',
    why: 'Hand this list to your web team. Each line is a concrete task.',
    good: 'Every check passing.',
    calc: 'Each check passes or fails. Advisory flags are worth knowing but aren’t scored as a pass or a fail.',
    src: 'Live scan of the site',
    next: { label: 'Start with the failed checks.' },
  },

  // ── AI Visibility (the Lite report the dashboard card opens) ──
  l_score: {
    t: 'AI visibility score',
    s: 'One number, out of 100, for how well AI assistants know and recommend the brand.',
    why: 'It’s the headline answer to “are we winning in AI search?”',
    good: 'Above 60 (“Well known”), AI regularly includes you. Above 80 (“Leading the conversation”), you’re one of the top answers.',
    calc: 'A weighted blend of four readings: how often you’re named (40%), where you’re named (25%), how warmly you’re described (20%) and how often your site is cited (15%). A reading that couldn’t be measured is left out and the rest are reweighted. This is not the dashboard card’s number, which counts only how often you’re named.',
    src: (ctx) => answersSrc(ctx.answersMeasured, 'Measured answers'),
    next: { label: 'Look at the lowest of the readings below. It’s what’s holding the score down.' },
  },
  l_named: {
    t: 'Shows up in AI answers',
    s: 'The share of measured answers that name your brand.',
    why: 'If you aren’t mentioned, you aren’t considered.',
    good: 'Most answers, and more than any tracked competitor.',
    calc: (ctx) => {
      const c = ctx.client;
      return 'Answers that name the brand ÷ all answers measured.'
        + (c && isNum(c.named) && isNum(c.answers) && c.answers > 0 ? ` Here: ${num(c.named)} of ${num(c.answers)} answers.` : '');
    },
    src: (ctx) => answersSrc(ctx.answersMeasured, 'Measured answers'),
    next: { label: 'See the prompts where you’re least visible.' },
  },
  l_share: {
    t: 'Share of the spotlight',
    s: 'Your mentions as a share of every tracked brand’s mentions in the same answers.',
    why: 'It shows your slice of the conversation against competitors, not just in isolation.',
    good: 'The biggest share of any tracked brand.',
    calc: 'Your mentions ÷ the mentions of every tracked brand, across the measured answers.',
    src: 'Measured answers',
    next: { label: 'Compare against the tracked brands below.' },
  },
  l_cited: {
    t: 'Trusted as a source',
    s: 'The share of measured answers that cite a page on your site.',
    why: 'A cited page sends readers to your site and tells the model your content is trustworthy.',
    good: 'Rising from run to run.',
    calc: 'Answers that link to a page on your domain ÷ all answers measured.',
    src: 'Citations in measured answers',
    next: { label: 'Pages with clear answers and structured data get cited more. See the SEO & GEO audit.', screen: 'seogeo' },
  },
  l_rank: {
    t: 'Typical spot when named',
    s: 'Where you fall in the order brands are named. 1 is first.',
    why: 'People act on the first names they read, just as they do with top search results.',
    good: '1 to 2.',
    calc: 'The average order of mention across answers that name you. Answers that don’t name you aren’t counted here.',
    src: 'Measured answers',
    next: { label: 'Visibility matters more right now. Position follows it.' },
  },
  l_grounded: {
    t: 'Based on a live search',
    s: 'The share of answers where the model actually searched the web rather than answering from memory.',
    why: 'Answers built on a live search reflect your site as it is today. Answers from memory may be out of date.',
    good: 'High. It means the answers reflect the current web.',
    calc: 'Answers where the model ran a web search ÷ all answers measured.',
    src: 'Measured answers',
    next: { label: 'Nothing to do. This describes the models, not your site.' },
  },
  l_engines: {
    t: 'By AI model',
    s: 'How often each model names you.',
    why: 'It tells you where effort is most needed.',
    good: 'A small gap between the models.',
    calc: 'Visibility worked out separately for each model.',
    src: 'ChatGPT, Claude and Gemini',
    next: { label: 'Start with the model that names you least.' },
  },
  l_brands: {
    t: 'Against the brands this project tracks',
    s: 'Each tracked brand’s share of answers that name it.',
    why: 'It shows who AI recommends when it doesn’t recommend you.',
    good: 'You at the top.',
    calc: 'Answers that name each brand ÷ all answers measured. Counted in answers, not occurrences, so a brand named twice in one answer counts once.',
    src: 'Measured answers',
    next: { label: 'Open Gap analysis to see where competitors are cited instead of you.' },
  },
  l_weak: {
    t: 'Prompts where you are least visible',
    s: 'The prompts where you’re named least often.',
    why: 'Each one is a content brief waiting to be written.',
    good: 'No prompt where you’re never named.',
    calc: 'Visibility worked out for each prompt on its own. A measured 0% is a real result. A prompt that couldn’t be measured is left out.',
    src: 'Measured answers',
    next: { label: 'Write a page that answers the weakest prompt directly.' },
  },
  l_gaps: {
    t: 'Sources feeding competitors',
    s: 'Sites the models read for answers that named a competitor and not you.',
    why: 'These are the places to get listed, reviewed or featured.',
    good: 'An empty list.',
    calc: 'For each source: the answers that used it and named a competitor, minus the ones that named you, weighted by how often the models read it and by the kind of site. A directory you can get listed in counts for more than a competitor’s own site.',
    src: 'Citations in measured answers',
    next: { label: 'Get listed on the sources at the top of this list first.' },
  },

  // ── AI Visibility (the older scraped report) ──
  v_stand: {
    t: 'Where you stand',
    s: 'Your rank among the tracked brands by how often AI assistants mention you.',
    why: 'It’s the headline answer to “are we winning in AI search?”',
    good: '#1.',
    calc: 'Brands ranked by share of voice across every answer measured in the period.',
    src: (ctx) => {
      const m = ctx.meta;
      if (!m || !isNum(m.captures)) return 'Measured answers';
      const qs = isNum(m.promptsMeasured) ? ` · ${num(m.promptsMeasured)} ${plural(m.promptsMeasured, 'question')}` : '';
      const period = m.period?.from && m.period?.to ? ` · ${m.period.from} to ${m.period.to}` : '';
      return `${num(m.captures)} ${plural(m.captures, 'answer')}${qs}${period}`;
    },
    next: { label: 'See “Where ground is being lost” for how to close the gap.' },
  },
  v_visibility: {
    t: 'Visibility',
    s: 'The share of AI answers that mention your brand.',
    why: 'If you aren’t mentioned, you aren’t considered.',
    good: 'Above 70%, and rising.',
    calc: 'Answers that name the brand ÷ all answers measured. Questions that failed to capture are left out, not counted as misses.',
    src: 'The same questions, asked on a schedule',
    next: { label: 'Look at the weakest questions to see where you’re missing.' },
  },
  v_sentiment: {
    t: 'Sentiment',
    s: 'How favourably the brand is described when it is mentioned, out of 100.',
    why: 'Being named negatively can be worse than not being named at all.',
    good: 'Well above 50.',
    calc: 'Each mention is scored 0–100 for how favourably the sentence naming you reads. This is the average across scored mentions. A mention that couldn’t be scored is left out, not counted as neutral.',
    src: 'Scored mentions in measured answers',
    next: { label: 'If it’s low, read what’s being said about you in the Perception report.' },
  },
  v_position: {
    t: 'Position',
    s: 'Where you appear in an answer when you’re mentioned. 1 means you’re named first.',
    why: 'People act on the first names they read, just as they do with top search results.',
    good: '1 to 2.',
    calc: 'The average order of mention across answers that name you. Answers that don’t name you aren’t counted here.',
    src: 'Measured answers',
    next: { label: 'Visibility matters more right now. Position follows it.' },
  },
  v_sov: {
    t: 'Share of voice',
    s: 'Your mentions as a share of all brand mentions across the answers.',
    why: 'It shows your slice of the conversation against competitors, not just in isolation.',
    good: 'The biggest bar.',
    calc: 'Your mentions ÷ mentions of every tracked brand.',
    src: 'Measured answers',
    next: { label: 'See where the leader is cited instead of you.' },
  },
  v_models: {
    t: 'Strongest and weakest assistant',
    s: 'Which AI assistant mentions you most, and which mentions you least.',
    why: 'It tells you where effort is most needed.',
    good: 'A small gap between the two.',
    calc: 'Visibility worked out separately for each assistant.',
    src: 'Each AI assistant measured',
    next: { label: 'Start with the assistant that mentions you least.' },
  },
  v_gaps: {
    t: 'Where ground is being lost',
    s: 'Websites AI assistants rely on that mention competitors more often than you.',
    why: 'These are the places to get listed, reviewed or featured.',
    good: 'An empty list.',
    calc: 'Sources cited in answers, ranked by how much more often they cite a competitor than you.',
    src: 'Citations in measured answers',
    next: { label: 'Get listed on the sources at the top of this list first.' },
  },
  v_weak: {
    t: 'Weakest questions',
    s: 'Customer questions where you’re least visible.',
    why: 'Each one is a content brief waiting to be written.',
    good: 'No question below 25%.',
    calc: 'Visibility for each question on its own. A measured 0% is a real result. A dash means it couldn’t be measured.',
    src: 'Measured answers',
    next: { label: 'Write a page that answers the weakest question directly.' },
  },

  // ── Competitor Research ──
  c_score: {
    t: 'Competitive score',
    s: 'Your search traffic compared with the strongest competitor, out of 100.',
    why: 'It’s a simple read on your market share in Google.',
    good: '80+, or 100 if you are the leader.',
    calc: competitorCalc,
    src: (ctx) => (isNum(ctx.competitorCount) && ctx.competitorCount > 0
      ? `Semrush estimates · ${ctx.competitorCount} ${plural(ctx.competitorCount, 'competitor')}`
      : 'Semrush estimates'),
    next: { label: 'Compare the keyword mix below. Non-branded searches are usually where the gap is.' },
  },
  c_traffic: {
    t: 'Organic traffic',
    s: 'Estimated monthly visits from Google’s unpaid results.',
    why: 'It’s traffic you don’t pay for per click.',
    good: 'Growing, and closing on the leader.',
    calc: 'Semrush’s estimate from the site’s rankings and how often those terms are searched. Use it for comparison, not as an exact count.',
    src: 'Semrush',
    next: { label: 'Track this monthly against the leader.' },
  },
  c_keywords: {
    t: 'Organic keywords',
    s: 'How many different searches the site shows up for in Google’s top 100.',
    why: 'More keywords means more ways for new customers to find you.',
    good: 'Close to, or above, competitors.',
    calc: 'The number of search terms the site ranks for, from Semrush.',
    src: 'Semrush',
    next: { label: 'New topic pages (see Hub and Spoke) are the fastest way to add keywords.', screen: 'hub' },
  },
  c_authority: {
    t: 'Authority score',
    s: 'How trusted the site looks to search engines, out of 100.',
    why: 'Higher-authority sites rank more easily for competitive searches.',
    good: 'At or above the competitor average.',
    calc: 'Semrush’s rating, based mainly on how many reputable sites link to this one. It moves slowly.',
    src: 'Semrush',
    next: { label: 'Build links from reputable sites in your industry and area.' },
  },
  c_backlinks: {
    t: 'Backlinks',
    s: 'Links from other websites that point to this one.',
    why: 'Each one is a vote of confidence that search engines count.',
    good: 'Steady growth from reputable sites.',
    calc: 'The total number of links Semrush has found. A related figure, referring domains, counts each linking site once.',
    src: 'Semrush',
    next: { label: 'Quality matters more than volume. Focus on reputable sites.' },
  },
  c_mix: {
    t: 'Branded vs. non-branded',
    s: 'How much of the site’s search presence comes from people already searching for it by name.',
    why: 'Non-branded searches come from new customers who don’t know you yet. That’s where growth comes from.',
    good: 'A large non-branded share.',
    calc: 'Keywords that contain the brand name count as branded. Everything else counts as non-branded.',
    src: 'Semrush',
    next: { label: 'A high branded share means growth depends on people who already know you. Invest in service and topic pages.' },
  },

  // ── Hub and Spoke (Content Architect) ──
  h_clusters: {
    t: 'Topic clusters',
    s: 'Groups of pages that are about the same subject.',
    why: 'Search engines and AI assistants reward sites that clearly cover a subject in depth.',
    good: 'Each cluster matches a service you sell.',
    calc: 'Pages are grouped by the words and phrases they share. Each group is then named by AI.',
    src: 'Content Architect analysis of the crawled pages',
    next: { label: 'Check that every service you sell has its own cluster.' },
  },
  h_healthy: {
    t: 'Healthy hubs',
    s: 'Clusters where one page clearly stands out as the main page for the topic.',
    why: 'A clear hub lets search engines and AI assistants see the site owns the topic.',
    good: 'Every cluster.',
    calc: 'A cluster where one page scores high enough to be its hub, well ahead of the next. A glossary’s index page counts as the hub for its entries.',
    src: 'Content Architect analysis of the crawled pages',
    next: { label: 'Nothing to do for these clusters.' },
  },
  h_hubs: {
    t: 'Missing hubs',
    s: 'Topics with no main page tying the related pages together.',
    why: 'Without a hub, related pages compete with each other instead of lifting each other.',
    good: 'None.',
    calc: 'A cluster where no page scores high enough to be its hub. The hub score weighs the page’s address, title and links, with an AI suggestion as one input among several.',
    src: 'Content Architect analysis of the crawled pages',
    next: { label: 'Create a hub page for the largest cluster without one first.' },
  },
  h_unclear: {
    t: 'Unclear hub',
    s: 'Clusters where two or more pages score too close to call, so a person should pick.',
    why: 'Two pages competing to be the hub split the topic’s strength between them.',
    good: 'None.',
    calc: 'A cluster whose top two hub candidates score within a small margin of each other.',
    src: 'Content Architect analysis of the crawled pages',
    next: { label: 'Pick one hub per unclear cluster and link the other page to it.' },
  },
  h_table: {
    t: 'Cluster list',
    s: 'Every topic cluster, its pages, and whether it has a hub page.',
    why: 'It’s the starting point for planning new content and fixing site structure.',
    good: 'Every cluster has a hub.',
    calc: 'One row per cluster. The status says what the cluster needs first: Hub found, Hub unclear or Hub missing. Spoke pages are flagged when nothing links to them (Orphaned), when they’re thin, or when they’re buried deep.',
    src: 'Content Architect analysis of the crawled pages',
    next: { label: 'Work down the Hub missing rows first.' },
  },
};

// ── Resolving ───────────────────────────────────────────────────────────────

const value = (f, ctx) => (typeof f === 'function' ? f(ctx) : f);

/**
 * One explainer as plain strings, with its figures filled in from `ctx`.
 * @returns {{ key, screen, t, s, why, good, calc, src, next: { label, screen } } | null}
 */
export function resolveExplainer(key, ctx = {}) {
  const e = EXPLAINERS[key];
  if (!e) return null;
  const c = ctx || {};
  const next = value(e.next, c) || {};
  return {
    key,
    screen: screenOf(key),
    t: e.t,
    s: e.s,
    why: e.why,
    good: e.good,
    calc: value(e.calc, c),
    src: value(e.src, c),
    next: { label: next.label, screen: next.screen || null },
  };
}

// ── The legend ──────────────────────────────────────────────────────────────

/** Shown at the top of the legend panel on every screen. */
export const LEGEND_SHARED = [
  { key: 'bands', term: 'Score bands', line: '80+ Good · 60–79 Needs attention · below 60 At risk. SEO & GEO uses its own five bands, with Good from 75.' },
  { key: 'dash', term: 'Not measured', line: 'Nothing has been checked yet. A missing number is never shown as 0.' },
  { key: 'trend', term: 'Direction', line: 'Improving, slipping or holding, compared with the previous audit of the same pages.' },
  { key: 'severity', term: 'Severity', line: 'Error: likely stopping a page from performing. Warning: holding it back. Notice: worth tidying.' },
];

/** "The numbers on this screen". `ex` may be a function of ctx; null hides the chip. */
export const LEGEND_BY_SCREEN = {
  overview: [
    { term: 'Composite score', line: 'The average of every audit that gave a score. Audits without one are left out, never counted as zero.', ex: compositeFormula },
    { term: 'Audit scores', line: 'Each audit scores itself out of 100 in its own way. The (i) on each card explains how.', ex: null },
    {
      term: 'To fix',
      line: 'One action per kind of problem. A template change is one fix that improves many pages at once.',
      ex: (ctx) => (isNum(ctx.toFix?.actions) && ctx.toFix.actions > 0
        ? `${num(ctx.toFix.actions)} ${plural(ctx.toFix.actions, 'action')} · ${num(ctx.toFix.templateWide || 0)} template ${plural(ctx.toFix.templateWide || 0, 'change')}`
        : null),
    },
    {
      term: 'Crawled vs. audited',
      line: 'Crawled pages were read by the crawler. Audited pages are a selection checked in depth.',
      ex: (ctx) => (isNum(ctx.pagesCrawled) && ctx.pagesCrawled > 0 ? `${num(ctx.pagesCrawled)} crawled` : null),
    },
    {
      term: 'Coverage',
      line: 'How many of the audits have run. One that hasn’t run is a blind spot, not a pass.',
      ex: (ctx) => (isNum(ctx.coverage?.covered) && isNum(ctx.coverage?.total) && ctx.coverage.covered > 0
        ? `${ctx.coverage.covered} of ${ctx.coverage.total} audits` : null),
    },
    { term: 'Profile chart', line: 'The scores use different methods. Compare the numbers, not the shape.', ex: null },
  ],
  tech: [
    { term: 'Site health', line: 'Each page starts at 100 and loses points for each kind of problem. The score is the average page.', ex: '100 − 40 per error − 10 per warning − 2 per notice' },
    {
      term: 'Points lost',
      line: 'What each kind of problem cost, averaged across all pages.',
      ex: (ctx) => {
        const pts = ['Errors', 'Warnings', 'Notices'].map((l) => pointsFor(ctx.breakdown, l));
        if (!pts.every(isNum) || !isNum(ctx.health)) return null;
        return `100 − (${pts.join(' + ')}) = ${ctx.health}`;
      },
    },
    {
      term: 'URLs vs. pages',
      line: 'URLs include images and files. Only web pages are scored.',
      ex: (ctx) => (isNum(ctx.urlsFetched) && isNum(ctx.htmlCount) && ctx.htmlCount > 0
        ? `${num(ctx.urlsFetched)} URLs → ${num(ctx.htmlCount)} pages` : null),
    },
    {
      term: 'Findable by Google',
      line: 'Pages Google is allowed to show. The rest can’t earn search traffic.',
      ex: (ctx) => (isNum(ctx.indexable) && isNum(ctx.htmlCount) && ctx.htmlCount > 0
        ? `${num(ctx.indexable)} of ${num(ctx.htmlCount)}` : null),
    },
  ],
  seogeo: [
    {
      term: 'Page score',
      line: 'The page’s checks across 9 weighted areas, blending an SEO side and a GEO side. A blocking problem caps it until fixed.',
      ex: (ctx) => (isNum(ctx.overall) ? `${ctx.overall} · ${ctx.cap?.applied ? `capped at ${ctx.cap.value}` : 'no cap applied'}` : null),
    },
    { term: 'Bands', line: 'Critical, Poor, Needs work, Good (75+), Excellent (90+).', ex: null },
    { term: 'AI engine readiness', line: 'Ready: can quote the page. Partial: might. Not ready: missing something it needs.', ex: null },
    {
      term: 'Check results',
      line: 'Only checks that apply to this page are counted.',
      ex: (ctx) => (isNum(ctx.passed) && isNum(ctx.checksApplied) && ctx.checksApplied > 0
        ? `${num(ctx.passed)} passed of ${num(ctx.checksApplied)}` : null),
    },
  ],
  agent: [
    {
      term: 'Readiness score',
      line: 'Every check is worth points by importance. The score is the points earned out of 100.',
      ex: (ctx) => (isNum(ctx.score) ? `${ctx.score} of 100 points` : null),
    },
    {
      term: 'Level',
      line: 'A one-line summary of how far along the site is, from Not Indexed up to Agent Native.',
      ex: (ctx) => ctx.level || null,
    },
    {
      term: 'Pass, fail, advisory',
      line: 'Advisory flags are worth knowing but aren’t scored as a pass or a fail.',
      ex: (ctx) => (isNum(ctx.passCount) && isNum(ctx.failCount)
        ? `${ctx.passCount} pass · ${ctx.failCount} fail · ${ctx.infoCount || 'no'} advisory` : null),
    },
  ],
  aivisLite: [
    { term: 'AI visibility score', line: 'A weighted blend of how often, where and how warmly you’re named, and how often you’re cited.', ex: 'named 40% · position 25% · sentiment 20% · cited 15%' },
    {
      term: 'Shows up in AI answers',
      line: 'The share of measured answers that name you. This is the number on the dashboard card.',
      ex: (ctx) => (ctx.client && isNum(ctx.client.named) && isNum(ctx.client.answers) && ctx.client.answers > 0
        ? `${num(ctx.client.named)} of ${num(ctx.client.answers)} answers` : null),
    },
    { term: 'Share of the spotlight', line: 'Your mentions as a share of every tracked brand’s mentions.', ex: null },
    { term: '0% vs. —', line: '0% is a measured result. A dash means it couldn’t be measured.', ex: null },
  ],
  aivis: [
    { term: 'Visibility', line: 'The share of AI answers that mention you.', ex: (ctx) => ctx.kpis?.visibility?.display || null },
    { term: 'Share of voice', line: 'Your mentions as a share of all brand mentions.', ex: (ctx) => ctx.kpis?.shareOfVoice?.display || null },
    { term: 'Position', line: 'The order you’re named in when you appear. 1 means first.', ex: (ctx) => ctx.kpis?.position?.display || null },
    { term: '0% vs. —', line: '0% is a measured result. A dash means it couldn’t be measured.', ex: null },
  ],
  comp: [
    { term: 'Competitive score', line: 'Your search traffic as a share of the strongest competitor’s, capped at 100.', ex: (ctx) => trafficFormula(ctx.trafficScore) },
    { term: 'Authority score', line: 'A 0–100 rating of how trusted a site looks, based on links from other sites.', ex: null },
    { term: 'Estimates', line: 'Traffic figures are Semrush estimates. They’re reliable for comparison, not exact counts.', ex: null },
    { term: 'Branded vs. non-branded', line: 'Non-branded searches come from people who don’t know you yet.', ex: null },
  ],
  hub: [
    { term: 'Hub', line: 'The main page for a topic, linking out to all the related pages.', ex: null },
    { term: 'Spoke', line: 'A page on one part of the topic that links back to its hub.', ex: null },
    { term: 'Orphaned', line: 'A spoke page that no other crawled page links to.', ex: null },
    {
      term: 'Missing or unclear hub',
      line: 'Missing: no page is strong enough to be the hub. Unclear: two pages are too close to call.',
      ex: (ctx) => (isNum(ctx.gaps) && isNum(ctx.unclear) && ctx.gaps + ctx.unclear > 0
        ? `${ctx.gaps} missing · ${ctx.unclear} unclear` : null),
    },
  ],
};

/** The legend rows for a screen, with example chips filled in from `ctx`. */
export function resolveLegend(screen, ctx = {}) {
  const c = ctx || {};
  return (LEGEND_BY_SCREEN[screen] || []).map((row) => ({
    term: row.term,
    line: row.line,
    ex: value(row.ex, c) || null,
  }));
}
