// ── Core metrics ────────────────────────────────────────────────────────────
//
// Pure. Takes rows already read from the database and returns numbers.
// METRICS.md §3 (brand), §4 (chats), §5 (sources), §6 (gaps).
//
// One rule governs every function here, and it is §3's opening notation:
//
//     C = captures with status 'captured' AND off_geo = false
//
// The denominator is MEASURED captures, never attempted ones. A failed capture
// is not evidence of absence — it is the absence of evidence — and letting one
// into a denominator quietly converts "we could not ask" into "you were not
// named". `scopeCaptures` is the only place that filter lives, so no metric can
// forget to apply it.
//
// The second rule is §3.4's: brands named but NOT in the configured measured
// set go into an `other` bucket that is excluded from the share-of-voice
// denominator. Otherwise share drifts every time a model name-drops an
// unrelated practice, and last month's number changes for no reason anyone can
// point at.

const { ratio } = require('./format');

/**
 * §3's `C`. Everything downstream takes its captures from here.
 *
 * `off_geo` captures are dropped rather than counted as absences: an answer
 * about the wrong city genuinely does not name a Boston practice, and counting
 * that as a miss would penalise a client for our own targeting error.
 */
function scopeCaptures(captures, { engine = null, promptIds = null } = {}) {
  const ids = promptIds ? new Set(promptIds) : null;
  return (captures || []).filter((c) => {
    if (c.status !== 'captured') return false;
    if (c.offGeo) return false;
    if (engine && c.engine !== engine) return false;
    if (ids && !ids.has(c.promptId)) return false;
    return true;
  });
}

/** Mentions that count: in scope, not negated. */
function scopeMentions(mentions, captureIds) {
  const ids = captureIds instanceof Set ? captureIds : new Set(captureIds);
  return (mentions || []).filter((m) => ids.has(m.captureId) && !m.negated);
}

/**
 * §3.1. The ONLY metric whose denominator includes failed captures.
 *
 * Below 90% every other number on the page is unreliable, so this returns the
 * warning alongside rather than leaving each report to remember.
 */
function coverage(allCaptures) {
  const attempted = (allCaptures || []).length;
  const captured = (allCaptures || []).filter((c) => c.status === 'captured').length;
  const value = ratio(captured, attempted);
  return {
    attempted,
    captured,
    value,
    belowThreshold: value !== null && value < 0.9,
  };
}

/**
 * Has anything in scope actually been through extraction?
 *
 * Mentions live in their own table, written by the extraction pass. Over a
 * scope where NOTHING has been extracted there are no rows — and reporting
 * "0% visibility" from that asserts the client was measured and never named,
 * when the truth is that nobody has counted yet.
 *
 * This is the same distinction as `mentioned: null` on a failed capture, one
 * level up: an unrun analysis is not a result.
 */
function anyExtracted(scoped) {
  return (scoped || []).some((c) => c.extractedAt);
}

/** §3.2. Share of measured captures in which a brand was named at all. */
function visibility(scoped, mentions, brandId) {
  const named = new Set(
    scopeMentions(mentions, scoped.map((c) => c.id))
      .filter((m) => m.brandId === brandId)
      .map((m) => m.captureId),
  );
  // Unextracted scope: unknown, not zero.
  if (!anyExtracted(scoped)) {
    return { named: 0, measured: scoped.length, value: null, extracted: false };
  }
  return {
    named: named.size,
    measured: scoped.length,
    value: ratio(named.size, scoped.length),
    extracted: true,
  };
}

/**
 * §3.3. One run, expressed 0–100.
 *
 * Deliberately a separate function from `visibility` despite the identical
 * formula, because the LABEL is load-bearing: a run is a handful of captures
 * and reads far lower than the 30-day figure. Calling both "visibility" puts
 * two contradictory numbers in front of the same client.
 */
function runVisibility(scoped, mentions, clientBrandId) {
  const v = visibility(scoped, mentions, clientBrandId);
  return {
    ...v,
    score: v.value === null ? null : Math.round(v.value * 100),
    label: 'Run visibility',
  };
}

/**
 * §3.4. Share of ATTENTION, not of captures.
 *
 * The denominator is mention counts across the measured set only. `other` is
 * returned so the number stays auditable — a reader can see how much naming
 * happened outside the configured set without it moving the percentages.
 */
function shareOfVoice(scoped, mentions, measuredBrandIds) {
  const inSet = new Set(measuredBrandIds);
  const extracted = anyExtracted(scoped);
  const scopedMentions = scopeMentions(mentions, scoped.map((c) => c.id));

  const byBrand = new Map();
  let denominator = 0;
  let other = 0;

  for (const m of scopedMentions) {
    const n = m.mentionCount || 1;
    if (!inSet.has(m.brandId)) { other += n; continue; }
    byBrand.set(m.brandId, (byBrand.get(m.brandId) || 0) + n);
    denominator += n;
  }

  const rows = [...inSet].map((brandId) => {
    const mentionsFor = byBrand.get(brandId) || 0;
    return {
      brandId,
      mentions: mentionsFor,
      // Null over an unextracted scope: a share of nothing counted is not 0%.
      value: extracted ? ratio(mentionsFor, denominator) : null,
    };
  }).sort((a, b) => b.mentions - a.mentions);

  return {
    rows, totalMentions: denominator, otherMentions: other, extracted,
  };
}

/**
 * §3.5. Mean ordinal over captures where the brand WAS named.
 *
 * Captures where it is absent contribute nothing — §3.5 is explicit that a
 * worst-case rank must not be imputed, because absence is already fully
 * penalised in visibility and counting it twice makes the two metrics
 * disagree about the same fact.
 */
function position(scoped, mentions, brandId) {
  const rows = scopeMentions(mentions, scoped.map((c) => c.id))
    .filter((m) => m.brandId === brandId && Number.isFinite(m.ordinal));
  if (!rows.length) return { value: null, basis: 0 };
  const sum = rows.reduce((acc, m) => acc + m.ordinal, 0);
  return { value: sum / rows.length, basis: rows.length };
}

/**
 * §3.6. Mean sentiment over scored mentions, every mention weighted equally.
 *
 * `scored` is reported separately from `basis` on purpose: a brand with 40
 * mentions of which 2 were scored has a number built on 2 observations, and the
 * report has to be able to say so rather than presenting it as a settled view.
 */
function sentiment(scoped, mentions, brandId) {
  const all = scopeMentions(mentions, scoped.map((c) => c.id))
    .filter((m) => m.brandId === brandId);
  const scored = all.filter((m) => Number.isFinite(m.sentimentScore));
  if (!scored.length) return { value: null, scored: 0, basis: all.length };
  const sum = scored.reduce((acc, m) => acc + m.sentimentScore, 0);
  return { value: sum / scored.length, scored: scored.length, basis: all.length };
}

/**
 * §3.7. Strongest and weakest engine by client visibility.
 *
 * A model needs ≥ 20 captures in the period to be ranked. Below that the
 * winner is noise, and naming a "strongest model" off three captures is a
 * confident answer to a question the data cannot answer.
 */
const MIN_CAPTURES_PER_MODEL = 20;

function byEngine(scoped, mentions, brandId) {
  const engines = [...new Set(scoped.map((c) => c.engine))];
  return engines.map((engine) => {
    const rows = scoped.filter((c) => c.engine === engine);
    const v = visibility(rows, mentions, brandId);
    return {
      engine,
      measured: rows.length,
      named: v.named,
      value: v.value,
      rankable: rows.length >= MIN_CAPTURES_PER_MODEL,
    };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

function strongestWeakest(engineRows) {
  const rankable = engineRows.filter((r) => r.rankable && r.value !== null);
  if (!rankable.length) {
    return { strongest: null, weakest: null, reason: 'insufficient_captures_per_model' };
  }
  // With one rankable engine this returned it as BOTH, printing the same
  // number twice under opposite labels — a comparison presented where no
  // comparison exists. One engine has a visibility, not a ranking.
  if (rankable.length < 2) {
    return { strongest: rankable[0], weakest: null, reason: 'only_one_rankable_model' };
  }
  return { strongest: rankable[0], weakest: rankable[rankable.length - 1], reason: null };
}

// ── Trend (the visibility chart) ───────────────────────────────────────────

/**
 * Bucket boundaries covering a period.
 *
 * Daily up to ~5 weeks, weekly beyond. A 12-month period at daily resolution
 * is 365 points on a 230px-wide chart, which is noise drawn at high precision
 * — and every point past the first hundred is sub-pixel.
 */
function bucketsFor({ from, to } = {}) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  // Without this the arithmetic yields NaN, the loop never runs, and the caller
  // gets an empty series that renders as "no captures in any bucket" — a chart
  // asserting a flat absence when the truth is that nobody said which period.
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`bucketsFor needs a from/to date range, got ${JSON.stringify({ from, to })}`);
  }
  const days = Math.round((end - start) / 86400000) + 1;
  const size = days <= 35 ? 1 : Math.ceil(days / 26);

  const out = [];
  for (let offset = 0; offset < days; offset += size) {
    const bStart = start + offset * 86400000;
    const bEnd = Math.min(bStart + (size - 1) * 86400000, end);
    out.push({
      from: new Date(bStart).toISOString().slice(0, 10),
      to: new Date(bEnd).toISOString().slice(0, 10),
    });
  }
  return { buckets: out, sizeDays: size };
}

/**
 * Visibility over time, per engine and overall.
 *
 * A bucket with no captures yields `null`, NOT zero. The distinction is the
 * whole point: a day nothing ran is a gap in the line, and drawing it at zero
 * would show a client's visibility collapsing on a day the scheduler simply
 * did not fire.
 *
 * @returns {{sizeDays, buckets:[{from,to}], series:[{key,label,points:[{value,measured,named}]}]}}
 */
function trend(scoped, mentions, brandId, { from, to } = {}) {
  const { buckets, sizeDays } = bucketsFor({ from, to });
  const engines = [...new Set(scoped.map((c) => c.engine))].sort();

  // Parse each capture's timestamp ONCE. This used to re-parse inside the
  // bucket filter, so a 26-bucket trend over a month of captures parsed every
  // date 26 times.
  const at = new Map();
  for (const c of scoped) at.set(c, new Date(c.capturedAt).getTime());

  const inBucket = (rows, b) => {
    const s = new Date(`${b.from}T00:00:00Z`).getTime();
    const e = new Date(`${b.to}T00:00:00Z`).getTime() + 86399999;
    return rows.filter((c) => {
      const t = at.has(c) ? at.get(c) : new Date(c.capturedAt).getTime();
      return Number.isFinite(t) && t >= s && t <= e;
    });
  };

  const seriesFor = (rows, key, label) => ({
    key,
    label,
    points: buckets.map((b) => {
      const slice = inBucket(rows, b);
      if (!slice.length) return { value: null, measured: 0, named: 0 };
      const v = visibility(slice, mentions, brandId);
      return { value: v.value, measured: v.measured, named: v.named };
    }),
  });

  return {
    sizeDays,
    buckets,
    series: [
      seriesFor(scoped, 'all', 'All engines'),
      ...engines.map((e) => seriesFor(scoped.filter((c) => c.engine === e), e, e)),
    ],
  };
}

// ── §4 Chats ───────────────────────────────────────────────────────────────

/**
 * §4. `average_citation` counts INLINE citations only — it answers "how many
 * sources does a reader see". The per-row `sources` count is every citation,
 * inline or not. The two differ on purpose and §4 says to keep both.
 */
function chats(scoped, mentions, citations, clientBrandId) {
  const ids = new Set(scoped.map((c) => c.id));
  const scopedCitations = (citations || []).filter((c) => ids.has(c.captureId));

  const inlineByCapture = new Map();
  const allByCapture = new Map();
  for (const c of scopedCitations) {
    if (c.isInlineCited) inlineByCapture.set(c.captureId, (inlineByCapture.get(c.captureId) || 0) + 1);
    allByCapture.set(c.captureId, (allByCapture.get(c.captureId) || 0) + 1);
  }

  // Two "we do not know" cases that must not render as measured zeros.
  //
  //   • `features` is NOT NULL with a `{}` default, so a capture taken before
  //     the column existed is indistinguishable from one that used no
  //     features. If NOTHING in scope has any, the field was not recorded —
  //     reporting "0% used web search" would assert a fact about every engine.
  //
  //   • Citations live in their own table, written by extraction. Over a scope
  //     where nothing has been extracted there are no rows yet, and "0 sources
  //     per answer" would claim readers see none.
  const anyFeatures = scoped.some((c) => (c.features || []).length > 0);
  const anyExtracted = scoped.some((c) => c.extractedAt);

  const withWebSearch = scoped.filter((c) => (c.features || []).includes('web_search'));

  const featureCounts = new Map();
  for (const c of scoped) {
    const key = [...(c.features || [])].sort().join(' & ');
    if (!key) continue;
    featureCounts.set(key, (featureCounts.get(key) || 0) + 1);
  }
  const mostCommonFeature = [...featureCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0] || null;

  const inlineTotal = [...inlineByCapture.values()].reduce((a, b) => a + b, 0);
  const named = visibility(scoped, mentions, clientBrandId);

  const ordinalByCapture = new Map();
  for (const m of scopeMentions(mentions, ids)) {
    if (m.brandId === clientBrandId) ordinalByCapture.set(m.captureId, m.ordinal);
  }

  return {
    totalChats: scoped.length,
    brandMentioned: named.named,
    webSearchCount: anyFeatures ? withWebSearch.length : null,
    webSearchPct: anyFeatures ? ratio(withWebSearch.length, scoped.length) : null,
    featuresRecorded: anyFeatures,
    averageCitation: anyExtracted ? ratio(inlineTotal, scoped.length) : null,
    citationsExtracted: anyExtracted,
    mostCommonFeature: mostCommonFeature ? mostCommonFeature[0] : null,
    rows: scoped.map((c) => ({
      captureId: c.id,
      promptId: c.promptId,
      prompt: c.prompt,
      engine: c.engine,
      surfaceLabel: c.surfaceLabel,
      capturedAt: c.capturedAt,
      features: c.features || [],
      sources: anyExtracted ? (allByCapture.get(c.id) || 0) : null,
      // Blank, not 0 — the client was not ranked last, it was not there.
      position: ordinalByCapture.has(c.id) ? ordinalByCapture.get(c.id) : null,
      excerpt: excerpt(c.answerText),
    })),
  };
}

/** §4's answer excerpt: 180 chars, markdown headers stripped, word boundary. */
function excerpt(answerText, max = 180) {
  const text = String(answerText || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// ── §5 Sources ─────────────────────────────────────────────────────────────

/**
 * §5.2, per domain over the period.
 *
 * `retrievals` counts citation ROWS; `retrievedPct` counts CAPTURES. §5.2 warns
 * against conflating them and the table shows both — a capture citing three
 * pages of one domain contributes 3 to the first and 1 to the second.
 */
function domains(scoped, citations, { key = 'domain' } = {}) {
  const ids = new Set(scoped.map((c) => c.id));
  const scopedCitations = (citations || []).filter((c) => ids.has(c.captureId));
  const total = scoped.length;

  const acc = new Map();
  for (const c of scopedCitations) {
    const id = c[key];
    if (!id) continue;
    if (!acc.has(id)) {
      acc.set(id, {
        id,
        domain: c.domain,
        host: c.host,
        url: c.url || null,
        domainType: c.domainType || null,
        urlType: c.urlType || null,
        retrievals: 0,
        inlineCount: 0,
        captureIds: new Set(),
      });
    }
    const row = acc.get(id);
    row.retrievals += c.occurrences || 1;
    if (c.isInlineCited) row.inlineCount += c.occurrences || 1;
    row.captureIds.add(c.captureId);
  }

  return [...acc.values()].map((r) => ({
    id: r.id,
    domain: r.domain,
    host: r.host,
    // At domain level this is ONE arbitrary member of the group, not the
    // domain's own address — named as a sample so a reader does not take it
    // for the page that was cited. At url level it is exact.
    url: r.url,
    sampleUrl: key === 'domain',
    domainType: r.domainType,
    urlType: r.urlType,
    retrievals: r.retrievals,
    captures: r.captureIds.size,
    retrievedPct: ratio(r.captureIds.size, total),
    retrievalRate: ratio(r.retrievals, r.captureIds.size),
    citationRate: ratio(r.inlineCount, r.retrievals),
  })).sort((a, b) => b.retrievals - a.retrievals);
}

/**
 * §5.3. Shares are NOT normalised to sum to 100 — §5.3 says so explicitly, and
 * the total is returned beside them so a reader can check the arithmetic
 * instead of being handed a number that has been quietly made to add up.
 */
function domainTypeMix(domainRows) {
  const total = domainRows.reduce((a, r) => a + r.retrievals, 0);
  const acc = new Map();
  for (const r of domainRows) {
    const t = r.domainType || 'other';
    acc.set(t, (acc.get(t) || 0) + r.retrievals);
  }
  return {
    totalRetrievals: total,
    rows: [...acc.entries()]
      .map(([type, retrievals]) => ({ type, retrievals, value: ratio(retrievals, total) }))
      .sort((a, b) => b.retrievals - a.retrievals),
  };
}

// ── §6 Gap analysis ────────────────────────────────────────────────────────

const TYPE_WEIGHT = require('../captureEngines/domainClassify').TYPE_WEIGHT;

/**
 * §6. A source that feeds answers in your category but never cites you.
 *
 * §6 closes with "present it as data only — rank the gaps, never write the
 * remedy in the UI", so this returns the ranking and the inputs that produced
 * it, and nothing that reads as advice.
 */
function gaps(scoped, mentions, citations, { clientBrandId, competitorBrandIds = [] } = {}) {
  const ids = new Set(scoped.map((c) => c.id));
  const total = scoped.length;
  const scopedCitations = (citations || []).filter((c) => ids.has(c.captureId));
  const scopedMentions = scopeMentions(mentions, ids);

  const competitors = new Set(competitorBrandIds);
  const namesClient = new Set();
  const namesCompetitor = new Set();
  for (const m of scopedMentions) {
    if (m.brandId === clientBrandId) namesClient.add(m.captureId);
    else if (competitors.has(m.brandId)) namesCompetitor.add(m.captureId);
  }

  const acc = new Map();
  for (const c of scopedCitations) {
    if (!c.domain) continue;
    if (!acc.has(c.domain)) {
      acc.set(c.domain, {
        domain: c.domain, domainType: c.domainType || 'other', captureIds: new Set(),
      });
    }
    acc.get(c.domain).captureIds.add(c.captureId);
  }

  return [...acc.values()].map((r) => {
    const compCaptures = [...r.captureIds].filter((id) => namesCompetitor.has(id)).length;
    const youCaptures = [...r.captureIds].filter((id) => namesClient.has(id)).length;
    const gapCaptures = Math.max(0, compCaptures - youCaptures);
    const retrievedPct = ratio(r.captureIds.size, total);
    const weight = TYPE_WEIGHT[r.domainType] ?? 0.5;
    const score = retrievedPct === null
      ? null
      : Math.round(gapCaptures * retrievedPct * 100 * weight);
    return {
      domain: r.domain,
      domainType: r.domainType,
      compCaptures,
      youCaptures,
      gapCaptures,
      captures: r.captureIds.size,
      retrievedPct,
      typeWeight: weight,
      gapScore: score,
    };
  }).sort((a, b) => (b.gapScore ?? -1) - (a.gapScore ?? -1));
}

module.exports = {
  MIN_CAPTURES_PER_MODEL,
  anyExtracted,
  scopeCaptures,
  scopeMentions,
  coverage,
  visibility,
  runVisibility,
  shareOfVoice,
  position,
  sentiment,
  byEngine,
  strongestWeakest,
  bucketsFor,
  trend,
  chats,
  excerpt,
  domains,
  domainTypeMix,
  gaps,
};
