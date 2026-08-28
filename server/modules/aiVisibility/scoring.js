// ── Turning captures into a report ───────────────────────────────────────────
//
// Pure functions over capture rows. No database, no network — so the scoring
// can be tested without spending a cent, and the numbers a client sees can be
// reproduced from stored rows at any time.
//
// The rule that shapes everything here: the denominator is MEASURED prompts,
// never attempted ones. A run that captured 4 of 5 scores out of 4 and says so.
// Scoring out of 5 would fold a provider outage into the client's visibility.

const SEVERITY = { error: 'error', warning: 'warning', notice: 'notice' };

/** Rows that produced a real answer or a real absence. */
function measuredRows(rows) {
  return (rows || []).filter((r) => r.mentioned !== null && r.mentioned !== undefined);
}

/**
 * The module score: share of measured prompts naming the brand.
 *
 * Null when nothing was measured — not 0, which would read as "measured
 * everywhere, named nowhere", the opposite of "we could not measure".
 */
function score(rows) {
  const measured = measuredRows(rows);
  if (!measured.length) return null;
  const named = measured.filter((r) => r.mentioned).length;
  return Math.round((named / measured.length) * 100);
}

/**
 * The sentence that has to travel with the score (PRD §6.2).
 *
 * Names the surfaces, the denominator, and the coverage. A reader who cannot
 * tell 50/100-over-4-prompts from 50/100-over-40 has not been told the score.
 */
function scoreBasis(rows) {
  const measured = measuredRows(rows);
  if (!measured.length) return null;

  const surfaces = [...new Set(measured.map((r) => r.surfaceLabel).filter(Boolean))];
  const named = measured.filter((r) => r.mentioned).length;
  const missing = (rows || []).length - measured.length;

  return `share of measured prompts naming the brand: ${named} of ${measured.length}`
    + `, on ${surfaces.join(' and ') || 'the configured surfaces'}`
    + (missing ? `. ${missing} prompt(s) could not be measured and are excluded` : '');
}

/**
 * Share of voice across measured prompts.
 *
 * The brand and every competitor named, as a count of prompts each appears in.
 * Deliberately prompt-count rather than mention-count: a model that repeats a
 * name six times in one answer has not made that brand six times more visible.
 */
function shareOfVoice(rows, brandName) {
  const measured = measuredRows(rows);
  const tally = new Map();

  if (brandName) tally.set(brandName, measured.filter((r) => r.mentioned).length);
  for (const row of measured) {
    for (const name of row.competitorsMentioned || []) {
      tally.set(name, (tally.get(name) || 0) + 1);
    }
  }

  return [...tally.entries()]
    .map(([name, prompts]) => ({
      name,
      prompts,
      // Null denominator means no percentage, not 0%.
      share: measured.length ? Math.round((prompts / measured.length) * 100) : null,
      isBrand: name === brandName,
    }))
    .sort((a, b) => b.prompts - a.prompts || a.name.localeCompare(b.name));
}

/**
 * Which domains the engines cite, ranked by how many prompts they appear on.
 *
 * The actionable half of the report: if Reddit and a university site own the
 * category, that is the gap, and it is a different fix from "write more pages".
 * Only resolved domains count — an unresolved redirect is not evidence about
 * anybody.
 */
function citedDomains(rows, brandDomain) {
  const measured = measuredRows(rows);
  const counts = new Map();

  for (const row of measured) {
    const seen = new Set();
    for (const citation of row.citations || []) {
      if (!citation.domain || seen.has(citation.domain)) continue;
      seen.add(citation.domain);
      const entry = counts.get(citation.domain)
        || { domain: citation.domain, prompts: 0, publisher: citation.publisher || null };
      entry.prompts += 1;
      if (!entry.publisher && citation.publisher) entry.publisher = citation.publisher;
      counts.set(citation.domain, entry);
    }
  }

  const target = String(brandDomain || '').replace(/^www\./i, '').toLowerCase();
  return [...counts.values()]
    .map((e) => ({
      ...e,
      isBrand: Boolean(target) && (e.domain === target || e.domain.endsWith(`.${target}`)),
    }))
    .sort((a, b) => b.prompts - a.prompts || a.domain.localeCompare(b.domain));
}

/**
 * Findings for the dashboard card and the insight layer.
 *
 * Severity is about commercial consequence, not volume: being absent from a
 * prompt a buyer types is an error; a competitor out-citing you is a warning.
 */
function findings(rows, { brandName, brandDomain } = {}) {
  const measured = measuredRows(rows);
  const out = [];
  if (!measured.length) return out;

  const absent = measured.filter((r) => !r.mentioned);
  if (absent.length) {
    out.push({
      ruleId: 'aiv-absent',
      title: `Not named in ${absent.length} of ${measured.length} measured prompts`,
      severity: SEVERITY.error,
      category: 'AI Visibility',
      count: absent.length,
      detail: { prompts: absent.map((r) => r.prompt).slice(0, 25) },
    });
  }

  // Named, but the answer sends the reader somewhere else.
  const namedNotCited = measured.filter((r) => r.mentioned && r.cited === false);
  if (namedNotCited.length) {
    out.push({
      ruleId: 'aiv-mentioned-not-cited',
      title: `Named without a link to ${brandDomain || 'the site'} on ${namedNotCited.length} prompt(s)`,
      severity: SEVERITY.warning,
      category: 'AI Visibility',
      count: namedNotCited.length,
      detail: { prompts: namedNotCited.map((r) => r.prompt).slice(0, 25) },
    });
  }

  const rivals = shareOfVoice(rows, brandName).filter((s) => !s.isBrand);
  const brandShare = shareOfVoice(rows, brandName).find((s) => s.isBrand)?.prompts ?? 0;
  const ahead = rivals.filter((r) => r.prompts > brandShare);
  if (ahead.length) {
    out.push({
      ruleId: 'aiv-outranked',
      title: `${ahead.length} competitor(s) named more often than ${brandName || 'the brand'}`,
      severity: SEVERITY.warning,
      category: 'AI Visibility',
      count: ahead.length,
      detail: { competitors: ahead.map((r) => ({ name: r.name, prompts: r.prompts })) },
    });
  }

  const top = citedDomains(rows, brandDomain).filter((d) => !d.isBrand).slice(0, 5);
  if (top.length) {
    out.push({
      ruleId: 'aiv-cited-instead',
      title: `Cited instead: ${top.map((d) => d.domain).slice(0, 3).join(', ')}`,
      severity: SEVERITY.notice,
      category: 'AI Visibility',
      count: top.length,
      detail: { domains: top },
    });
  }

  return out;
}

/**
 * The whole report for one run.
 *
 * @param {Array}  rows      capture rows from capture.measure
 * @param {object} brand     { name, domain }
 */
function summarise(rows, { name, domain } = {}) {
  const all = rows || [];
  const measured = measuredRows(all);
  const captureLib = require('./capture');

  return {
    score: score(all),
    scoreBasis: scoreBasis(all),
    coverage: captureLib.coverageOf(all),
    promptsMeasured: measured.length,
    promptsNaming: measured.filter((r) => r.mentioned).length,
    // Null, not 0, when nothing resolved — see citesDomain.
    promptsCiting: measured.some((r) => r.cited === null)
      ? null
      : measured.filter((r) => r.cited).length,
    shareOfVoice: shareOfVoice(all, name),
    citedDomains: citedDomains(all, domain),
    findings: findings(all, { brandName: name, brandDomain: domain }),
    surfaces: [...new Set(all.map((r) => r.surfaceLabel).filter(Boolean))],
    spend: all.reduce((sum, r) => sum + (Number(r.taskCost) || 0), 0),
  };
}

module.exports = {
  SEVERITY,
  measuredRows,
  score,
  scoreBasis,
  shareOfVoice,
  citedDomains,
  findings,
  summarise,
};
