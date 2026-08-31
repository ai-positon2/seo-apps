// ── The page chooser ───────────────────────────────────────────────
//
// Pure. Turns a crawl into a list a person can pick from: one row per URL,
// labelled with what the page is about rather than its raw title.
//
// This file used to carry a second, larger job — deriveTopics, which folded
// pages, Content Architect clusters, content gaps and bare service terms into
// one ranked axis for a topic×intent matrix. That matrix and the generator
// behind it were removed: nobody chose anything from it, and "coverage"
// meaning two different things on one screen was half of why the screen was
// confusing. What is left is the half that a person actually uses.

/** Strips a brand's own name/boilerplate off a page title so the label reads
 *  as a topic ("Dental Implants") rather than a page title
 *  ("Dental Implants | Gentle Dental — Boston, MA"). */
function labelFromTitle(title, brandName) {
  if (!title) return null;
  // A hyphen is only a separator when it is SPACED. A bare one is part of a
  // compound word, and splitting on it turned "What is Pain-Free Dentistry"
  // into "What is Pain" — a topic label nobody could recognise, on a screen
  // whose whole job is recognition.
  let label = String(title).split(/\s[\u2013\u2014-]\s|[|:]/)[0].trim();
  if (brandName) {
    const escaped = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    label = label.replace(new RegExp(escaped, 'i'), '').trim();
  }
  return label || null;
}

function normaliseUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return String(url).toLowerCase();
  }
}

/**
 * The subject of a page, as words.
 *
 * An article title names its own subject more precisely than a keyword tool
 * guesses at it — "What Is a Root Canal? Causes, Symptoms and Treatment"
 * carries root canal, causes, symptoms, treatment. Question words and the
 * brand are dropped; what is left is the subject.
 */
const TITLE_STOPWORDS = new Set([
  'what', 'is', 'are', 'a', 'an', 'the', 'how', 'to', 'do', 'does', 'and', 'or',
  'of', 'for', 'in', 'on', 'with', 'your', 'my', 'you', 'it', 'its', 'guide',
  'ultimate', 'top', 'best', 'tips', 'from', 'about', 'types', 'why', 'when',
]);

// Titles that name a billable service. Ranked first in the chooser, because a
// page selling a treatment is where a buyer question can actually be won.
const SERVICE_TERMS = new RegExp(String.raw`\b(implant|root canal|crown|denture|veneer|invisalign|orthodont|brace|extraction|emergency|urgent|cosmetic|whitening|filling|bridge|periodont|wisdom|cleaning|checkup|sedation|pediatric|dentist)`, 'i');

function termsFromTitle(title, brandName) {
  const label = labelFromTitle(title, brandName);
  if (!label) return [];
  const words = String(label).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !TITLE_STOPWORDS.has(w) && w.length > 2);
  const phrase = kept.join(' ').trim();
  return [...new Set([phrase, ...kept])].filter((t) => t && t.length > 2).slice(0, 6);
}

/**
 * A readable name for a page whose title gave us nothing. Never a metric —
 * this is a row in a chooser, and a row with no name cannot be chosen.
 */
function labelFromPath(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const slug = path.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  if (!slug) return 'Homepage';
  return slug
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || null;
}

/**
 * Every crawled URL as its own topic — one page, one topic, no exceptions.
 *
 * `deriveTopics` is the GENERATOR's view: capped, ranked, mixing pages with
 * clusters and derived services so a project with a thin crawl still produces
 * something. That mixture is right for feeding a generator and wrong for
 * asking a person to choose.
 *
 * A chooser needs a 1:1 mapping. "Teeth Whitening Options" as a cluster and
 * /resources/articles/teeth-whitening as a page are the same thing to a
 * reader, and offering both is a question they cannot answer. So this returns
 * pages only, uncapped, one per URL — the list is the sitemap, and picking a
 * topic means picking a page.
 *
 * Ordering matches deriveTopics so the two views agree about what matters.
 *
 * @returns {Array} [{id, kind:'page', label, targetUrl, terms, group, inlinks, depth}]
 */
function topicPerUrl(evidence = {}, { brandName = null } = {}) {
  const brand = brandName || evidence.brand?.name || null;
  const seen = new Set();
  const out = [];

  const ranked = [...(evidence.pages || [])].sort((a, b) => (
    (SERVICE_TERMS.test(a.title || '') ? 0 : 1) - (SERVICE_TERMS.test(b.title || '') ? 0 : 1)
    || (b.inlinks || 0) - (a.inlinks || 0)
    || (a.depth || 0) - (b.depth || 0)
  ));

  for (const page of ranked) {
    const url = normaliseUrl(page.url);
    if (!url || seen.has(url)) continue;
    // A page whose title is ONLY the brand ("Gentle Dental — Boston") leaves
    // nothing behind once the brand is stripped. That is almost always the
    // homepage, and dropping it silently made the chooser look like it had
    // missed a page. Fall back to the path, which always says something.
    const label = labelFromTitle(page.title, brand) || labelFromPath(page.url);
    if (!label) continue;
    seen.add(url);
    out.push({
      id: `page:${url}`,
      kind: 'page',
      label,
      targetUrl: page.url,
      terms: termsFromTitle(page.title, brand),
      group: groupFor(page),
      inlinks: page.inlinks ?? null,
      depth: page.depth ?? null,
    });
  }
  return out;
}

/**
 * A coarse bucket for presentation only.
 *
 * Never stored and never used in a metric — it exists so a 50-row chooser can
 * be scanned. Path first, because a URL is more reliable than a title.
 */
function groupFor(page) {
  const path = (() => {
    try { return new URL(page.url).pathname.toLowerCase(); } catch { return String(page.url || '').toLowerCase(); }
  })();
  const title = String(page.title || '').toLowerCase();

  if (path === '/' || path === '') return 'Homepage';
  if (path.includes('/meet-our-dentists') || path.includes('/our-team')) return 'Our dentists';
  if (path.includes('/press') || path.includes('/about-us')) return 'About & press';
  if (path.includes('/location') || path.includes('welcome') || path.includes('offer')) return 'Locations & offers';
  if (SERVICE_TERMS.test(title)) return 'Treatments & services';
  if (path.includes('/resources/article')) return 'Conditions & advice';
  return 'Other pages';
}

module.exports = {
  topicPerUrl, groupFor, labelFromTitle, normaliseUrl,
};
