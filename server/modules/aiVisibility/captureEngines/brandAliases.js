// ── Deriving the alias set a brand is actually matched on ───────────────────
//
// Pure. METRICS.md §2.1 needs legal name, trading name, common misspellings,
// domain root and location-suffixed variants before matching can work at all.
// Today the competitor set gives us domain stems — `aspendental`, not "Aspen
// Dental" — so matching against it as-is would miss nearly every real mention
// and report competitors as absent.
//
// Everything here PROPOSES. Nothing derived is used for measurement until a
// human approves it (project_brands.status), because a wrong alias corrupts
// visibility and share of voice silently, which is the worst failure this
// module has: the number still looks plausible.

// Words that carry no identity on their own. A brand whose every token is in
// here has no distinctive form, and the caller is told so rather than being
// handed a matcher that fires on the whole category.
const GENERIC_TOKENS = new Set([
  'the', 'and', 'of', 'for', 'inc', 'llc', 'ltd', 'co', 'company', 'corp',
  'corporation', 'group', 'associates', 'partners', 'holdings', 'services',
  'service', 'center', 'centre', 'centers', 'clinic', 'clinics', 'practice',
  'dental', 'dentist', 'dentistry', 'dentists', 'orthodontics', 'periodontics',
  'medical', 'health', 'healthcare', 'care', 'family', 'smile', 'smiles',
  'law', 'firm', 'attorneys', 'office', 'offices', 'studio', 'studios',
]);

// Common ways a domain stem is written as words.
const SPLIT_HINTS = [
  'dental', 'dentist', 'dentistry', 'health', 'care', 'medical', 'clinic',
  'group', 'center', 'centre', 'family', 'smile', 'smiles', 'ortho',
];

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function titleCase(text) {
  return String(text || '').split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The registrable-ish stem of a host: `www.aspendental.com` → `aspendental`. */
function stemFromDomain(domain) {
  const host = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const label = host.split('.')[0] || '';
  return label.replace(/[^a-z0-9]/g, '');
}

/**
 * Split a concatenated domain stem into words: `aspendental` → "aspen dental".
 *
 * Greedy suffix matching against known industry words. Deliberately
 * conservative — it proposes ONE reading, and a wrong split is caught at
 * review rather than silently measured.
 */
function wordsFromStem(stem) {
  const s = String(stem || '').toLowerCase();
  if (!s) return null;
  for (const hint of SPLIT_HINTS) {
    if (s.length > hint.length && s.endsWith(hint)) {
      const head = s.slice(0, -hint.length);
      if (head.length >= 3) return `${head} ${hint}`;
    }
    if (s.length > hint.length && s.startsWith(hint)) {
      const tail = s.slice(hint.length);
      if (tail.length >= 3) return `${hint} ${tail}`;
    }
  }
  return null;
}

/**
 * Propose the alias set for one brand.
 *
 * @param {object} input
 * @param {string} [input.name]     the name as configured, if any
 * @param {string} [input.domain]
 * @param {string[]} [input.observed]  names seen in real answers — the
 *   strongest signal available, because it is what the models actually call
 *   this brand rather than what we assume they do
 * @returns {{name, aliases, strength, notes}}
 *   strength: 'strong'  a distinctive token survives
 *             'weak'    only the full phrase identifies it
 *             'none'    nothing usable — do not measure this brand
 */
function deriveAliases({ name = '', domain = '', observed = [] } = {}) {
  const notes = [];
  const aliases = new Set();

  const stem = stemFromDomain(domain);
  const stemWords = wordsFromStem(stem);

  // Prefer, in order: a configured name, a name the models actually used, a
  // readable split of the domain, then the bare stem.
  let display = String(name || '').trim();
  const looksLikeStem = display && !display.includes(' ') && display.toLowerCase() === stem;

  if ((!display || looksLikeStem) && observed.length) {
    // The most frequently observed spelling wins.
    const counts = new Map();
    for (const o of observed) {
      const k = String(o || '').trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) { display = best[0]; notes.push('name taken from what models actually call this brand'); }
  }
  if ((!display || looksLikeStem) && stemWords) {
    display = titleCase(stemWords);
    notes.push(`name split from the domain stem "${stem}"`);
  }
  if (!display) display = stem ? titleCase(stem) : '';

  if (display) aliases.add(display);
  // De-spaced form: "Gentle Dental" also appears as "GentleDental".
  if (display.includes(' ')) aliases.add(display.replace(/\s+/g, ''));
  if (stem) aliases.add(stem);
  if (stemWords) aliases.add(titleCase(stemWords));
  for (const o of observed) {
    const k = String(o || '').trim();
    if (k) aliases.add(k);
  }

  // Strength drives whether this brand can be matched safely at all.
  const distinctive = tokenize(display).filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t));
  let strength = 'none';
  if (distinctive.length) strength = 'strong';
  else if (display) { strength = 'weak'; notes.push('every word in this name is a generic industry term — only the full phrase can identify it'); }
  else notes.push('no usable name or domain — this brand cannot be measured');

  return {
    name: display || null,
    aliases: [...aliases].filter(Boolean).sort((a, b) => b.length - a.length),
    strength,
    notes,
  };
}

/**
 * Propose the whole measured set for a project.
 *
 * @param {object} input
 * @param {object} input.project     projectView
 * @param {object} [input.observed]  { [domainOrName]: string[] } names seen
 *   in stored answers, keyed by the brand they belong to
 */
function deriveMeasuredSet({ project, observed = {} } = {}) {
  const out = [];

  const clientDomain = project?.primaryDomain?.host
    || (() => { try { return new URL(project?.legacyUrl).host; } catch { return ''; } })();

  out.push({
    isClient: true,
    domain: String(clientDomain || '').replace(/^www\./, '').toLowerCase() || null,
    ...deriveAliases({
      name: project?.name,
      domain: clientDomain,
      observed: observed[clientDomain] || observed[project?.name] || [],
    }),
  });

  for (const c of project?.competitors || []) {
    const host = String(c.host || '').replace(/^www\./, '').toLowerCase();
    out.push({
      isClient: false,
      domain: host || null,
      ...deriveAliases({
        name: c.name && c.name !== stemFromDomain(host) ? c.name : '',
        domain: host,
        observed: observed[host] || [],
      }),
    });
  }

  return out;
}

module.exports = {
  GENERIC_TOKENS, tokenize, titleCase, stemFromDomain, wordsFromStem, deriveAliases, deriveMeasuredSet,
};
