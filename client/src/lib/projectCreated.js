// ── What creating a project starts, before and after ─────────────────────────
//
// Creating a project starts four jobs by itself (server/modules/projects/
// routes.js POST /): the first site crawl, the SEO & GEO and Agent Readiness
// homepage audits, AI Visibility's questions and first measurement, and
// Competitor Research. The setup form used to mention only the last, said
// crawls "run weekly once scheduled", and the banner after Create said the
// schedule was off — while a crawl, two audits and a measurement were already
// running. These two helpers are what the form lists and what the banner
// says, so both describe what the server actually does.

// Competitor Research is billed per domain (moduleRunners.METERED; the client's
// own domain is charged too) and a run is hard-capped at 10,000 units, which
// is the client plus 4 competitors (competitorAnalysis/unitCosts.js,
// store.js MAX_COMPETITORS). Competitors past the 4th are saved on the project
// but never fetched in the run.
export const SEMRUSH_UNITS_PER_DOMAIN = 1955;
export const MAX_COMPARED_COMPETITORS = 4;
// discovery.js: how many competitors are found when none are typed, and what
// the discovery call itself costs (unitCosts.DISCOVERY_COST, worst case).
export const AUTO_DISCOVERY_COUNT = 3;
export const DISCOVERY_UNITS = 200;

/**
 * The Competitor Research estimate for the competitors typed in the form.
 * @param {string[]} competitors
 */
export function competitorEstimate(competitors = []) {
  const typed = competitors.length;
  const autoDiscovers = typed === 0;
  const compared = autoDiscovers ? AUTO_DISCOVERY_COUNT : Math.min(typed, MAX_COMPARED_COMPETITORS);
  const skipped = autoDiscovers ? [] : competitors.slice(MAX_COMPARED_COMPETITORS);
  const units = (compared + 1) * SEMRUSH_UNITS_PER_DOMAIN + (autoDiscovers ? DISCOVERY_UNITS : 0);
  return { autoDiscovers, compared, skipped, units };
}

/** What starts on Create, in the order it starts, for the setup form. */
export function startsOnCreate({ maxUrls, competitors = [] }) {
  const est = competitorEstimate(competitors);
  const cap = Number(maxUrls) > 0 ? Number(maxUrls).toLocaleString('en-US') : null;
  return [
    `First site crawl${cap ? `, up to ${cap} pages` : ''} — starts now; only the weekly repeat waits for a schedule.`,
    'SEO & GEO and Agent Readiness audits of the homepage.',
    'AI Visibility: questions written for the business, then a first measurement.',
    `Competitor Research against ${est.autoDiscovers
      ? `the ${est.compared} competitors it finds`
      : `${est.compared} competitor${est.compared === 1 ? '' : 's'}`}: about ${est.units.toLocaleString('en-US')} SEMrush units${est.autoDiscovers ? ' (estimated, including the search for competitors)' : ''}.`,
  ];
}

const started = (r) => Boolean(r?.scheduled);

/**
 * The banner after Create, from the whole create response
 * ({ project, initialCrawl, homepageAudits, aiVisibilityLite, competitorResearch }).
 * Names what actually started and what did not, rather than what was planned.
 */
export function createdBanner(result = {}) {
  const name = result.project?.name || 'The project';
  const yes = [];
  const no = [];
  const maxUrls = result.project?.crawlOptions?.maxUrls;
  (started(result.initialCrawl) ? yes : no).push(
    `the first crawl${started(result.initialCrawl) && maxUrls ? ` (up to ${Number(maxUrls).toLocaleString('en-US')} pages)` : ''}`,
  );
  (started(result.homepageAudits) ? yes : no).push('the homepage SEO & GEO and Agent Readiness audits');
  (started(result.aiVisibilityLite) ? yes : no).push('AI Visibility setup and first measurement');
  (started(result.competitorResearch) ? yes : no).push('Competitor Research');

  const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]);
  const parts = [`${name} created.`];
  if (yes.length) parts.push(`Started: ${list(yes)}.`);
  if (no.length) parts.push(`Not started: ${list(no)}.`);
  parts.push('The weekly crawl repeat stays off until you enable it.');
  if (result.competitorResearch?.note) parts.push(String(result.competitorResearch.note).trim());
  return parts.join(' ');
}
