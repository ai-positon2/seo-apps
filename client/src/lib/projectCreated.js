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
  // With none typed, the run only SEARCHES: the competitors it finds are saved
  // as suggestions to review (UX-112), and nothing is compared — or billed per
  // domain — until they are accepted. `suggests` is how many it suggests.
  const compared = autoDiscovers ? 0 : Math.min(typed, MAX_COMPARED_COMPETITORS);
  const suggests = autoDiscovers ? AUTO_DISCOVERY_COUNT : 0;
  const skipped = autoDiscovers ? [] : competitors.slice(MAX_COMPARED_COMPETITORS);
  const units = autoDiscovers ? DISCOVERY_UNITS : (compared + 1) * SEMRUSH_UNITS_PER_DOMAIN;
  // What accepting the suggestions would then cost, for the form to state.
  const unitsIfAccepted = (AUTO_DISCOVERY_COUNT + 1) * SEMRUSH_UNITS_PER_DOMAIN;
  return { autoDiscovers, compared, suggests, skipped, units, unitsIfAccepted };
}

/**
 * The call to action for competitors awaiting a decision: AI suggestions
 * (source 'accepted') read "Review N suggested competitors"; ones a
 * contributor typed read as proposals. Empty string when there are none.
 */
export function reviewPrompt(proposed = []) {
  const list = Array.isArray(proposed) ? proposed : [];
  const n = list.length;
  if (!n) return '';
  const s = n === 1 ? '' : 's';
  const suggested = list.some((d) => d?.source === 'accepted');
  return suggested
    ? `Review ${n} suggested competitor${s}`
    : `${n} proposed competitor${s} awaiting a decision`;
}

/**
 * Which autostarts this deployment runs (GET /api/projects `autostarts`).
 * A server that does not say is treated as running all of them — what every
 * server did before the field existed.
 */
export function autostartOn(autostarts, key) {
  return !autostarts || autostarts[key] !== false;
}

/** What starts on Create, in the order it starts, for the setup form. */
export function startsOnCreate({ maxUrls, competitors = [], autostarts = null }) {
  const est = competitorEstimate(competitors);
  const cap = Number(maxUrls) > 0 ? Number(maxUrls).toLocaleString('en-US') : null;
  const lines = [];
  if (autostartOn(autostarts, 'crawl')) {
    lines.push(`First site crawl${cap ? `, up to ${cap} pages` : ''} — starts now; only the weekly repeat waits for a schedule.`);
  }
  if (autostartOn(autostarts, 'homepageAudits')) lines.push('SEO & GEO and Agent Readiness audits of the homepage.');
  if (autostartOn(autostarts, 'aiVisibilityLite')) {
    lines.push('AI Visibility: questions written for the business, then a first measurement.');
  }
  if (autostartOn(autostarts, 'competitorResearch')) {
    lines.push(est.autoDiscovers
      ? `Competitor Research searches for up to ${est.suggests} competitors to suggest (about ${est.units.toLocaleString('en-US')} SEMrush units). You review them; the comparison runs only after you accept them.`
      : `Competitor Research against ${est.compared} competitor${est.compared === 1 ? '' : 's'}: about ${est.units.toLocaleString('en-US')} SEMrush units.`);
  }
  return lines;
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
  // Per module when the server says (homepageAutostart.perModule): one queued
  // audit is named as started rather than both reading "Not started".
  // Also accepts the per-module map at the top level ({ seo_geo, agent_readiness }).
  const ha = result.homepageAudits;
  const audits = ha?.modules || (ha && (ha.seo_geo || ha.agent_readiness) ? ha : null);
  if (audits && !started(result.homepageAudits)) {
    (started(audits.seo_geo) ? yes : no).push('the homepage SEO & GEO audit');
    (started(audits.agent_readiness) ? yes : no).push('the homepage Agent Readiness audit');
  } else {
    (started(result.homepageAudits) ? yes : no).push('the homepage SEO & GEO and Agent Readiness audits');
  }
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
