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

/**
 * Captures grouped one row per PROMPT rather than one row per capture.
 *
 * The UI used to iterate captures directly, so a prompt measured on two
 * surfaces (ChatGPT and Google AI Overview) rendered as two separate blocks,
 * and a prompt with zero captures this run (over budget, or approved after
 * the run started) did not render at all. This is the fix: group first, and
 * every group carries a per-surface breakdown rather than merging surfaces
 * together, because "named by ChatGPT, absent from Google AI Overview" is a
 * real distinction 0016's own header argues for.
 *
 * @param {Array}  rows     capture rows from capture.measure / store.capturesForRun
 * @param {Array} [prompts] promptView rows — supplies metadata AND ensures an
 *                          approved-but-unmeasured prompt still appears, with
 *                          `surfaces: []`, rather than silently vanishing.
 */
function groupByPrompt(rows, prompts = []) {
  const promptById = new Map((prompts || []).map((p) => [p.id, p]));
  const groups = new Map();

  const groupFor = (promptId, fallbackText) => {
    const key = promptId || `text:${fallbackText}`;
    if (!groups.has(key)) {
      const p = promptId ? promptById.get(promptId) : null;
      groups.set(key, {
        promptId: promptId || null,
        text: p?.text || fallbackText,
        slot: p?.slot ?? null,
        intent: p?.intent ?? null,
        source: p?.source ?? null,
        sourceRef: p?.sourceRef ?? null,
        topicKind: p?.topicKind ?? null,
        topicLabel: p?.topicLabel ?? null,
        targetUrl: p?.targetUrl ?? null,
        demandVolume: p?.demandVolume ?? null,
        rationale: p?.rationale ?? null,
        status: p?.status ?? null,
        // A capture whose prompt_id is null — the prompt was deleted since,
        // or captured before prompts were tracked at all. Grouped by its raw
        // text rather than dropped, so the evidence stays visible.
        orphaned: !promptId,
        surfaces: [],
      });
    }
    return groups.get(key);
  };

  for (const row of rows || []) {
    groupFor(row.promptId, row.prompt).surfaces.push(row);
  }
  // An approved prompt this run never got to (over budget, or approved after
  // the run started) still belongs on the report — with an empty surface
  // list, which is what tells the reader "not measured this run" rather than
  // "measured and absent".
  for (const p of prompts || []) {
    groupFor(p.id, p.text);
  }

  return [...groups.values()].map((g) => ({
    ...g,
    mentionedOnAnySurface: g.surfaces.length === 0
      ? null
      : g.surfaces.some((s) => s.mentioned === true)
        ? true
        : g.surfaces.some((s) => s.mentioned === false) ? false : null,
  }));
}

/**
 * groupByPrompt's output, grouped again by topic — the axis that turns "50%"
 * into "which page". Prompts with no topicLabel (every prompt written before
 * generation carried one, or one added by hand without picking one) fold
 * into 'Uncategorised' rather than each becoming its own one-prompt group,
 * which would make the matrix noise instead of signal.
 */
function groupByTopic(promptGroups) {
  const topics = new Map();

  for (const g of promptGroups || []) {
    const label = g.topicLabel || 'Uncategorised';
    if (!topics.has(label)) {
      topics.set(label, {
        topic: label,
        kind: g.topicKind || null,
        targetUrl: g.targetUrl || null,
        prompts: [],
        namedCount: 0,
        measuredCount: 0,
        competitorsNamed: new Set(),
      });
    }
    const t = topics.get(label);
    t.prompts.push(g);
    if (g.mentionedOnAnySurface !== null) t.measuredCount += 1;
    if (g.mentionedOnAnySurface === true) t.namedCount += 1;
    for (const surface of g.surfaces || []) {
      for (const name of surface.competitorsMentioned || []) t.competitorsNamed.add(name);
    }
  }

  return [...topics.values()]
    .map((t) => ({ ...t, competitorsNamed: [...t.competitorsNamed] }))
    .sort((a, b) => b.measuredCount - a.measuredCount || a.topic.localeCompare(b.topic));
}

/**
 * The finding a page-backed topic report exists to produce: a page is live,
 * the engine measured questions about it, and it named a competitor instead
 * of the brand on every single one. Kept separate from `findings()` because
 * it needs topic-grouped data (prompts joined to captures), which `findings`
 * — deliberately capture-only — does not have.
 */
function topicFindings(topics) {
  const invisible = (topics || []).filter(
    (t) => t.targetUrl && t.measuredCount > 0 && t.namedCount === 0 && t.competitorsNamed.length > 0,
  );
  if (!invisible.length) return [];
  return [{
    ruleId: 'aiv-topic-invisible',
    title: `${invisible.length} page(s) exist for topics where a competitor gets named instead`,
    severity: SEVERITY.error,
    category: 'AI Visibility',
    count: invisible.length,
    detail: {
      topics: invisible.map((t) => ({
        topic: t.topic, targetUrl: t.targetUrl, competitorsNamed: t.competitorsNamed,
      })),
    },
  }];
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
  groupByPrompt,
  groupByTopic,
  topicFindings,
};
