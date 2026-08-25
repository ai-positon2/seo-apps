// ── Which pages the per-page modules actually audit ─────────────────────────
//
// SEO & GEO, On-Page and Agent Readiness used to work through the crawl in
// discovery order until they hit a page budget. That is a bad default in two
// directions at once: it audits pages nobody chose, and because discovery order
// on a sitemap-seeded crawl is close to arbitrary, ten audits could all land on
// near-identical location pages and report the same template defect ten times.
// The site average then describes one template, not the site.
//
// What replaced it: the homepage, plus four pages chosen to be DIFFERENT FROM
// EACH OTHER. A service page, a location page, an article, a hub — whatever the
// crawl actually offers. Five pages that disagree tell you more about a site
// than fifty that repeat.
//
// The homepage goes first and goes early, before the crawl has finished, because
// it is the one page every site has and the one a reader checks first. The other
// four wait for the crawl to finish, because choosing representative pages needs
// the whole list to choose from.
//
// ── On using a model for this ───────────────────────────────────────────────
//
// The model reads URLs and titles and picks four. It is doing pattern
// recognition over naming conventions — /locations/ vs /services/ vs /blog/ —
// which is exactly what it is good at and exactly what a hand-written rule set
// gets wrong on the next site with different conventions.
//
// It is not trusted, though. Every URL it returns is checked against the
// candidate list before use: a model that invents a plausible-looking URL would
// otherwise send the auditor to a 404 and record that as the site's score. If it
// returns too few, the heuristic below fills the rest; if it is unavailable, the
// heuristic does the whole job. The selection always says which path it took, so
// a report can state how its pages were chosen rather than implying they were
// chosen well.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');

const SELECTION_MODEL = 'claude-sonnet-5';

// Four besides the homepage: five pages is roughly what a person will actually
// read in a report, and each extra page is ~170s of audit against the client's
// own site.
const EXTRA_PAGES = 4;

// How many candidates the model is shown. A 50-page crawl fits comfortably; the
// cap exists so a 5,000-page crawl cannot blow the context window.
const MAX_CANDIDATES = 200;

function safeUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function pathOf(value) {
  const u = safeUrl(value);
  return u ? (u.pathname || '/') : '';
}

/** Depth in path segments. '/' is 0, '/a' is 1, '/a/b' is 2. */
function depthOf(value) {
  return pathOf(value).split('/').filter(Boolean).length;
}

/**
 * The homepage among crawled pages.
 *
 * Preferred: an exact root path on the project's own origin. Falling back to
 * "the shallowest page" is deliberate but second-best — a site served from
 * /en/ has no root in the crawl, and auditing its shallowest page is right,
 * while picking a random deep page would not be.
 *
 * Returns null rather than guessing when there is nothing to pick from.
 */
function pickHomepage(pages, origin = null) {
  const all = (pages || []).filter((p) => safeUrl(p.url));
  if (!all.length) return null;

  const originHost = origin ? safeUrl(origin)?.host : null;

  // Narrow to this site FIRST, before either rule below.
  //
  // Doing it only in the root check was a bug worth keeping the note for: with
  // no root on the client's own host, the shallowest-page fallback ran over
  // every crawled URL and happily returned an external site's root, because
  // https://someone-else.test/ is shallower than https://client.test/en/. The
  // homepage of a different website would then have been audited and scored as
  // this client's homepage.
  //
  // Falls back to the full list when nothing matches the origin, so a project
  // whose recorded origin has drifted from what the crawl found still gets a
  // homepage rather than nothing.
  const onSite = originHost ? all.filter((p) => safeUrl(p.url).host === originHost) : [];
  const list = onSite.length ? onSite : all;

  const roots = list.filter((p) => (safeUrl(p.url).pathname || '/') === '/');
  if (roots.length) return roots[0];

  // Shallowest, then shortest, then alphabetical — deterministic, so two runs of
  // the same crawl pick the same page.
  return [...list].sort((a, b) => {
    const da = depthOf(a.url);
    const db = depthOf(b.url);
    if (da !== db) return da - db;
    const la = String(a.url).length;
    const lb = String(b.url).length;
    if (la !== lb) return la - lb;
    return String(a.url).localeCompare(String(b.url));
  })[0];
}

/**
 * The first path segment, which is what most sites use to separate page types:
 * /services/x, /locations/y, /blog/z. Root and one-segment pages get their own
 * buckets so a top-level service page is not lumped in with the homepage.
 */
function sectionOf(url) {
  const segments = pathOf(url).split('/').filter(Boolean);
  if (!segments.length) return '(root)';
  if (segments.length === 1) return `(top) ${segments[0]}`;
  return segments[0];
}

/**
 * Diversity without a model: one page per section, deepest sections first.
 *
 * Not as good as the model at spotting that /r/ means "resources", but it never
 * invents a URL and never fails, which is what a fallback has to be. Sections
 * are visited in order of how many pages they hold, so the biggest parts of the
 * site are represented before the long tail.
 */
function heuristicSelection(pages, { exclude = new Set(), count = EXTRA_PAGES } = {}) {
  const candidates = (pages || []).filter((p) => safeUrl(p.url) && !exclude.has(p.url));

  const bySection = new Map();
  for (const page of candidates) {
    const section = sectionOf(page.url);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(page);
  }

  // Within a section, the shallowest page is the most representative of it — a
  // section landing page rather than one leaf of it.
  for (const list of bySection.values()) {
    list.sort((a, b) => depthOf(a.url) - depthOf(b.url)
      || String(a.url).localeCompare(String(b.url)));
  }

  const sections = [...bySection.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const picked = [];
  // One pass taking the best page from each section, then a second pass for
  // seconds, so four pages never all come from one section unless that is all
  // the site has.
  for (let round = 0; picked.length < count && round < 5; round += 1) {
    let addedThisRound = false;
    for (const [section, list] of sections) {
      if (picked.length >= count) break;
      const page = list[round];
      if (!page) continue;
      picked.push({ url: page.url, type: section, why: 'section coverage' });
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }

  return picked.slice(0, count);
}

function candidateLines(pages) {
  return pages.slice(0, MAX_CANDIDATES).map((p, i) => {
    const title = String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    return `${i + 1}. ${p.url}${title ? ` — ${title}` : ''}`;
  }).join('\n');
}

/**
 * Ask the model for `count` representative pages.
 *
 * @returns {Promise<Array<{url, type, why}>>} only URLs that were in `pages`
 */
async function modelSelection(pages, { count = EXTRA_PAGES } = {}) {
  const allowed = new Map(pages.map((p) => [p.url, p]));

  const system = 'You choose a small, representative sample of pages from a website crawl for '
    + 'a technical SEO audit. You pick pages that differ from each other in TEMPLATE and PURPOSE '
    + '— for example a service page, a location page, an article or blog post, a hub or category '
    + 'page, a product page, a contact or conversion page. Auditing four pages built from the '
    + 'same template is worth less than auditing four different templates, because a template '
    + 'defect is one defect however many pages carry it. Never invent a URL: choose only from '
    + 'the list given. Reply with JSON only.';

  const user = `Website pages found by the crawl:\n\n${candidateLines(pages)}\n\n`
    + `Choose exactly ${count} URLs from that list, each a DIFFERENT type of page. The homepage `
    + `is already being audited and is not in this list.\n\n`
    + 'Return JSON: {"picks":[{"url":"<exact url from the list>","type":"<short page-type label, '
    + 'e.g. service page>","why":"<under 15 words>"}]}';

  const llm = createLlmClient(SELECTION_MODEL);
  const completion = await llm.chat.completions.create({
    model: llm.model,
    ...chatParams(llm.model, { maxTokens: 1200 }),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const raw = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  const picks = Array.isArray(raw.picks) ? raw.picks : [];

  // Validate against the candidate list. A hallucinated URL would send the
  // auditor to a 404 and record the result as this site's score.
  const seen = new Set();
  const valid = [];
  for (const pick of picks) {
    const url = String(pick?.url || '').trim();
    if (!allowed.has(url) || seen.has(url)) continue;
    seen.add(url);
    valid.push({
      url,
      type: String(pick?.type || '').slice(0, 60) || 'page',
      why: String(pick?.why || '').slice(0, 120),
    });
    if (valid.length >= count) break;
  }
  return valid;
}

/**
 * The four pages to audit alongside the homepage.
 *
 * Never throws: a selection failure downgrades to the heuristic rather than
 * taking the whole audit down with it. The result always names how it was
 * chosen, so the report can say so.
 *
 * @param {Array}  pages     crawled pages: { url, title }
 * @param {Set}    exclude   urls already audited (the homepage, and anything a
 *                           previous run covered)
 * @param {number} count
 * @returns {Promise<{picks: Array, method: 'model'|'heuristic'|'model+heuristic', model: string|null, error: string|null}>}
 */
async function selectKeyPages(pages, { exclude = new Set(), count = EXTRA_PAGES } = {}) {
  const candidates = (pages || []).filter((p) => safeUrl(p.url) && !exclude.has(p.url));
  if (!candidates.length) {
    return { picks: [], method: 'heuristic', model: null, error: null };
  }

  let picks = [];
  let error = null;
  let usedModel = false;

  try {
    picks = await modelSelection(candidates, { count });
    usedModel = picks.length > 0;
  } catch (e) {
    error = e.message;
  }

  if (picks.length < count) {
    const already = new Set([...exclude, ...picks.map((p) => p.url)]);
    const filler = heuristicSelection(candidates, {
      exclude: already,
      count: count - picks.length,
    });
    picks = [...picks, ...filler];
  }

  const method = usedModel
    ? (picks.some((p) => p.why === 'section coverage') ? 'model+heuristic' : 'model')
    : 'heuristic';

  return { picks: picks.slice(0, count), method, model: usedModel ? SELECTION_MODEL : null, error };
}

/**
 * A one-line description of how a run's pages were chosen, for the report.
 * Says plainly when the model was not the one choosing.
 */
function selectionBasis({ method, model, error, count }) {
  const chosen = `the homepage plus ${count} page(s) chosen to cover different page types`;
  if (method === 'model') return `${chosen}, selected by ${model}`;
  if (method === 'model+heuristic') {
    return `${chosen}: ${model} chose some, the rest by section coverage`;
  }
  return `${chosen}, selected by section coverage`
    + (error ? ` — the model selection was unavailable (${error})` : '');
}

module.exports = {
  EXTRA_PAGES,
  SELECTION_MODEL,
  safeUrl,
  pathOf,
  depthOf,
  sectionOf,
  pickHomepage,
  heuristicSelection,
  modelSelection,
  selectKeyPages,
  selectionBasis,
};
