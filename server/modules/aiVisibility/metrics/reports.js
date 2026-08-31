// ── The nine reports ────────────────────────────────────────────────────────
//
// METRICS.md §12: one shape for every report, so the shell can switch between
// them without bespoke plumbing.
//
//     { meta: {period, comparePeriod, captures, coverage, promptsMeasured,
//              rulesetVersion, generatedAt},
//       data: { … report-specific … },
//       warnings: [ … ] }
//
// Every number leaves here as `{value, display, delta, deltaDisplay,
// direction}`. The UI reads `display` and `deltaDisplay` and picks a colour
// from `direction`. It never divides, never rounds, never decides what an
// empty state means — because the moment it does, this file stops being the
// single source of truth and the same metric starts reading two ways.
//
// Rail order (README): Executive overview | Insights, Perception | Prompts |
// Gap analysis, Domains, URLs | Chats, Run detail.
//
// §10 says the Executive overview computes NOTHING NEW — it is a re-selection
// of reports 2–8. `overview` therefore calls the other builders rather than
// recomputing, which is the only way the hero number and the report it links
// to can be guaranteed to agree.

const core = require('./core');
const period = require('./period');
const { metric, ratio } = require('./format');
const domainClassify = require('../captureEngines/domainClassify');

// ── The four reports ────────────────────────────────────────────────────────
//
// Nine screens, each answering a slice of a question, asked a reader to
// assemble the answer themselves. These four are the questions a person
// actually arrives with: where do we stand, what are we losing, what do we do
// about it, and show me the evidence.
//
// Nothing was recomputed to get here. Each of these RE-SELECTS from the same
// builders as before (§10's rule for the overview, now applied to all four),
// so a number cannot disagree with itself across screens.
const REPORTS = [
  { id: 'overview', label: 'Overview', group: 'REPORTS' },
  { id: 'questions', label: 'Questions', group: 'REPORTS' },
  { id: 'sources', label: 'Sources', group: 'REPORTS' },
  { id: 'answers', label: 'Answers', group: 'REPORTS' },
];

// Every id that still BUILDS. The nine originals are kept reachable — they are
// the components these four are composed from, they cost nothing to leave in,
// and a bookmarked ?report=insights should not 400. They are simply not in the
// rail any more.
const LEGACY_REPORT_IDS = [
  'insights', 'perception', 'prompts', 'gaps', 'domains', 'urls', 'chats', 'run',
];

const REPORT_IDS = [...REPORTS.map((r) => r.id), ...LEGACY_REPORT_IDS];

/**
 * Everything a builder needs, computed once.
 *
 * `scoped` is the headline basis — the full current period. `deltaNow` and
 * `deltaPrev` are the §3.8 intersection: the prompts BOTH periods measured. A
 * builder that used `scoped` for both sides would report a jump caused by
 * approving easier questions as though the client had improved.
 */
function buildContext({
  captures = [], mentions = [], citations = [], brands = [], prompts = [], options = {},
}) {
  // ── Only the questions this client currently asks ────────────────────────
  //
  // A removed question is not part of what we measure, so it is not part of
  // what we report — including its failures. This narrowing happens HERE,
  // above period.split, rather than inside core.scopeCaptures, because
  // coverage (§3.1) is computed from split.current directly: filtering lower
  // down would leave a removed question's failed captures still dragging
  // coverage down while its successes had already gone.
  //
  // The cost is deliberate and was accepted: retiring a question changes past
  // periods too. Reports describe the CURRENT question set, which is the
  // promise the Prompt set screen makes. meta.basis states the set, and
  // 'removed_prompts_excluded' says so when anything was dropped.
  const live = new Set((prompts || []).map((p) => p.id));
  const excluded = (captures || []).filter((c) => !c.promptId || !live.has(c.promptId));
  const inScope = (captures || []).filter((c) => c.promptId && live.has(c.promptId));

  const split = period.split(inScope, options);
  const client = brands.find((b) => b.isClient) || null;
  const competitors = brands.filter((b) => !b.isClient);

  const scoped = core.scopeCaptures(split.current, { engine: options.engine || null });
  const deltaNow = core.scopeCaptures(split.currentForDelta, { engine: options.engine || null });
  const deltaPrev = core.scopeCaptures(split.previousForDelta, { engine: options.engine || null });

  // Which rulesets produced the rows in scope.
  //
  // Nothing read extraction_version before this, so a period spanning a matcher
  // change silently averaged mentions numbered under two different ordinal
  // rules — the exact thing the version column exists to make visible.
  const scopedForVersions = core.scopeCaptures(inScope, {});
  const extractionCounts = {};
  for (const c of scopedForVersions) {
    const v = c.extractionVersion || 'unextracted';
    extractionCounts[v] = (extractionCounts[v] || 0) + 1;
  }
  const scopedIdsForVersions = new Set(scopedForVersions.map((c) => c.id));
  const rulesetCounts = {};
  for (const cit of citations || []) {
    if (!scopedIdsForVersions.has(cit.captureId)) continue;
    const v = cit.rulesetVersion || 'unclassified';
    rulesetCounts[v] = (rulesetCounts[v] || 0) + 1;
  }
  const extractionVersions = Object.keys(extractionCounts).filter((v) => v !== 'unextracted').sort();
  const rulesetVersions = Object.keys(rulesetCounts).filter((v) => v !== 'unclassified').sort();
  const versions = {
    extraction: extractionVersions,
    ruleset: rulesetVersions,
    mixed: extractionVersions.length > 1 || rulesetVersions.length > 1,
    counts: { extraction: extractionCounts, ruleset: rulesetCounts },
  };

  const coverage = core.coverage(split.current);
  const warnings = [...split.warnings];
  // Told, not averaged silently. A matcher change moves ordinals, so a mean
  // position across two versions is comparing two scales.
  if (versions.mixed) warnings.push('mixed_extraction_versions');
  if (coverage.belowThreshold) warnings.push('coverage_below_threshold');
  if (!client) warnings.push('no_client_brand');
  // Told, not hidden: a reader who remembers a bigger number needs to know why
  // this one is smaller, and that the difference is questions they removed.
  if (excluded.length) warnings.push('removed_prompts_excluded');

  return {
    split,
    scoped,
    deltaNow,
    deltaPrev,
    mentions,
    citations,
    brands,
    prompts,
    client,
    competitors,
    coverage,
    warnings,
    versions,
    excludedCaptures: excluded.length,
    // The questions these numbers actually REST on — the ones with a measured
    // capture in the period. Counting every live question instead would include
    // ones awaiting approval, which have never been asked, and the header would
    // then disagree with the KPI basis directly beneath it.
    promptCount: new Set(scoped.map((c) => c.promptId)).size,
    measuredIds: brands.map((b) => b.id),
  };
}

function meta(ctx) {
  return {
    period: ctx.split.period.current,
    comparePeriod: ctx.split.period.previous,
    days: ctx.split.period.days,
    captures: ctx.scoped.length,
    // The set these numbers rest on. Without this, removing a question makes
    // every figure move with nothing on screen accounting for it.
    promptCount: ctx.promptCount,
    basis: `${ctx.scoped.length} capture${ctx.scoped.length === 1 ? '' : 's'} across `
      + `${ctx.promptCount} question${ctx.promptCount === 1 ? '' : 's'}`,
    excludedCaptures: ctx.excludedCaptures,
    coverage: metric(ctx.coverage.value, 'percent'),
    coverageLabel: `${ctx.coverage.captured} of ${ctx.coverage.attempted} captured`,
    promptsMeasured: new Set(ctx.scoped.map((c) => c.promptId).filter(Boolean)).size,
    comparison: ctx.split.comparison,
    // The versions actually present in the ROWS, not the version this build
    // happens to be running.
    //
    // This reported domainClassify.RULESET_VERSION unconditionally, so a report
    // built entirely from captures classified under 2026.08.1 announced
    // 2026.08.2 — and the header printed it. The stamp exists so a past period
    // stays interpretable; stamping it from the code defeated that exactly when
    // it mattered, which is after a rule changed.
    rulesetVersion: ctx.versions.ruleset.length === 1
      ? ctx.versions.ruleset[0]
      : (ctx.versions.ruleset.join(', ') || domainClassify.RULESET_VERSION),
    extractionVersion: ctx.versions.extraction.length === 1
      ? ctx.versions.extraction[0]
      : (ctx.versions.extraction.join(', ') || null),
    // Non-null when the scope spans more than one ruleset, so a reader can see
    // the split rather than being handed one number over two rulesets.
    versionSplit: ctx.versions.mixed ? ctx.versions.counts : null,
    generatedAt: new Date().toISOString(),
  };
}

const envelope = (ctx, data, extraWarnings = []) => ({
  meta: meta(ctx),
  data,
  warnings: [...new Set([...ctx.warnings, ...extraWarnings])],
});

/**
 * The six KPI cells the Insights and Overview reports share.
 *
 * Shared deliberately: §10 makes the overview a re-selection, and two
 * independent computations of "visibility" would eventually disagree by a
 * rounding step and put two different numbers on two screens.
 */
function kpis(ctx) {
  const { client } = ctx;
  if (!client) return null;

  const vis = core.visibility(ctx.scoped, ctx.mentions, client.id);
  const visPrev = core.visibility(ctx.deltaPrev, ctx.mentions, client.id);
  const visNow = core.visibility(ctx.deltaNow, ctx.mentions, client.id);

  const sen = core.sentiment(ctx.scoped, ctx.mentions, client.id);
  const senPrev = core.sentiment(ctx.deltaPrev, ctx.mentions, client.id);
  const senNow = core.sentiment(ctx.deltaNow, ctx.mentions, client.id);

  const pos = core.position(ctx.scoped, ctx.mentions, client.id);
  const posPrev = core.position(ctx.deltaPrev, ctx.mentions, client.id);
  const posNow = core.position(ctx.deltaNow, ctx.mentions, client.id);

  const sov = core.shareOfVoice(ctx.scoped, ctx.mentions, ctx.measuredIds);
  const sovPrevAll = core.shareOfVoice(ctx.deltaPrev, ctx.mentions, ctx.measuredIds);
  const sovNowAll = core.shareOfVoice(ctx.deltaNow, ctx.mentions, ctx.measuredIds);
  const mine = (rows) => rows.find((r) => r.brandId === client.id)?.value ?? null;

  const engines = core.byEngine(ctx.scoped, ctx.mentions, client.id);
  const { strongest, weakest, reason } = core.strongestWeakest(engines);

  return {
    visibility: metric(vis.value, 'percent', {
      // The delta compares like with like; the headline does not.
      previous: visNow.value === null ? null : visPrev.value,
      note: vis.extracted === false
        ? 'Captures stored but not yet counted — run extraction'
        : null,
    }),
    sentiment: metric(sen.value, 'sentiment', {
      previous: senNow.value === null ? null : senPrev.value,
      // Uncalibrated until the §3.6 100-capture audit — the caller decides
      // whether to show it, and this says plainly that it is not yet settled.
      note: sen.scored ? `Scored on ${sen.scored} of ${sen.basis} mentions` : 'Not scored',
    }),
    position: metric(pos.value, 'position', {
      previous: posNow.value === null ? null : posPrev.value,
      direction: 'lower_is_better',
    }),
    shareOfVoice: metric(mine(sov.rows), 'percent', {
      previous: mine(sovNowAll.rows) === null ? null : mine(sovPrevAll.rows),
      note: sov.otherMentions
        ? `${sov.otherMentions} mention(s) of brands outside the measured set are excluded`
        : null,
    }),
    strongestModel: strongest
      ? { engine: strongest.engine, ...metric(strongest.value, 'percent') }
      : { engine: null, ...metric(null, 'percent', { note: reason }) },
    weakestModel: weakest
      ? { engine: weakest.engine, ...metric(weakest.value, 'percent') }
      : { engine: null, ...metric(null, 'percent', { note: reason }) },
    engines: engines.map((e) => ({
      engine: e.engine,
      rankable: e.rankable,
      measured: e.measured,
      ...metric(e.value, 'percent'),
    })),
  };
}

/** §3 — the brand report. */
function insights(ctx) {
  const sov = core.shareOfVoice(ctx.scoped, ctx.mentions, ctx.measuredIds);
  const byId = new Map(ctx.brands.map((b) => [b.id, b]));

  return envelope(ctx, {
    kpis: kpis(ctx),
    shareOfVoice: {
      totalMentions: sov.totalMentions,
      otherMentions: sov.otherMentions,
      rows: sov.rows.map((r) => ({
        brandId: r.brandId,
        name: byId.get(r.brandId)?.name || r.brandId,
        isClient: Boolean(byId.get(r.brandId)?.isClient),
        mentions: metric(r.mentions, 'count'),
        ...metric(r.value, 'percent'),
      })),
    },
    // §1's "who each model names first" grid.
    firstNamed: firstNamedGrid(ctx),
    // The visibility chart. A bucket with no captures carries `null`, so the
    // line breaks rather than dropping to zero on a day nothing ran.
    trend: ctx.client
      ? core.trend(ctx.scoped, ctx.mentions, ctx.client.id, ctx.split.period.current)
      : null,
  });
}

/** Which brand each engine names first, per capture — the §1 grid. */
// A cell needs at least this many observations before it names a brand. One
// capture landing a brand at ordinal 1 is not "the model names them first", and
// the grid was presenting it as though it were.
const MIN_FIRST_NAMED = 3;

// How many ordinal columns the grid shows. The columns are the lowest ordinals
// present in the data, not 1..4 — see the note where the window is built.
const GRID_COLUMNS = 4;

function firstNamedGrid(ctx) {
  const byId = new Map(ctx.brands.map((b) => [b.id, b]));
  const scopedIds = new Set(ctx.scoped.map((c) => c.id));
  const engineOf = new Map(ctx.scoped.map((c) => [c.id, c.engine]));

  const grid = new Map();
  for (const m of core.scopeMentions(ctx.mentions, scopedIds)) {
    const engine = engineOf.get(m.captureId);
    if (!engine || !Number.isFinite(m.ordinal)) continue;
    if (!grid.has(engine)) grid.set(engine, new Map());
    const slot = grid.get(engine);
    const key = m.ordinal;
    if (!slot.has(key)) slot.set(key, new Map());
    const tally = slot.get(key);
    tally.set(m.brandId, (tally.get(m.brandId) || 0) + 1);
  }

  // The window is the ordinals that ACTUALLY OCCUR, lowest first.
  //
  // Two things make a fixed 1-4 range wrong. Prose ordinals are numbered after
  // the last map card, so on an answer with 30 cards every prose mention sits
  // at 31+ and a 1-4 window shows nothing at all. And real data is sparse —
  // this client's mentions land on 1, 4, 5, 6, 7... with 2 and 3 never
  // occurring — so a contiguous range spends half its columns on cells that
  // can never fill.
  //
  // A previous attempt at this used Math.min(4, max(seen)), which can only
  // narrow the range and therefore fixed neither case.
  const seen = [...new Set([...grid.values()].flatMap((slots) => [...slots.keys()]))]
    .sort((a, b) => a - b);
  const window = (seen.length ? seen : [1, 2, 3, 4]).slice(0, GRID_COLUMNS);

  return [...grid.entries()].map(([engine, slots]) => ({
    engine,
    positions: window.map((ordinal) => {
      const empty = {
        ordinal, brandId: null, name: null, isClient: false, basis: 0, tied: false,
      };
      const tally = slots.get(ordinal);
      if (!tally || !tally.size) return empty;

      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const [brandId, count] = ranked[0];
      // Too few observations, or a tie at the top — either way there is no
      // answer here, and printing one would be a coin flip presented as a
      // finding.
      if (count < MIN_FIRST_NAMED) return { ...empty, basis: count };
      if (ranked.length > 1 && ranked[1][1] === count) {
        return { ...empty, basis: count, tied: true };
      }
      return {
        ordinal,
        brandId,
        name: byId.get(brandId)?.name || brandId,
        isClient: Boolean(byId.get(brandId)?.isClient),
        basis: count,
        tied: false,
      };
    }),
  }));
}

/** §8 — per prompt, which is where a weak market is actually visible. */
function promptsReport(ctx) {
  const byPrompt = new Map(ctx.prompts.map((p) => [p.id, p]));
  const ids = [...new Set(ctx.scoped.map((c) => c.promptId).filter(Boolean))];

  const rows = ids.map((promptId) => {
    const scoped = ctx.scoped.filter((c) => c.promptId === promptId);
    const prev = ctx.deltaPrev.filter((c) => c.promptId === promptId);
    const now = ctx.deltaNow.filter((c) => c.promptId === promptId);
    const v = ctx.client ? core.visibility(scoped, ctx.mentions, ctx.client.id) : null;
    const vPrev = ctx.client ? core.visibility(prev, ctx.mentions, ctx.client.id) : null;
    const vNow = ctx.client ? core.visibility(now, ctx.mentions, ctx.client.id) : null;
    const pos = ctx.client ? core.position(scoped, ctx.mentions, ctx.client.id) : null;
    const prompt = byPrompt.get(promptId);

    return {
      promptId,
      text: prompt?.text || scoped[0]?.prompt || null,
      topicLabel: prompt?.topicLabel || null,
      topicKind: prompt?.topicKind || null,
      targetUrl: prompt?.targetUrl || null,
      slot: prompt?.slot || null,
      intent: prompt?.intent || null,
      location: prompt?.location || null,
      measured: metric(scoped.length, 'count'),
      visibility: metric(v?.value ?? null, 'percent', {
        previous: vNow?.value == null ? null : vPrev?.value ?? null,
      }),
      position: metric(pos?.value ?? null, 'position', { direction: 'lower_is_better' }),
    };
  }).sort((a, b) => (a.visibility.value ?? 1) - (b.visibility.value ?? 1));

  return envelope(ctx, {
    rows,
    // The weak markets list IS this table sorted ascending — same query, not a
    // second definition that could drift from it.
    weakest: rows.filter((r) => r.visibility.value !== null && r.visibility.value < 0.5).slice(0, 10),
  });
}

/** §6 — ranked, and data only. §6 is explicit: never write the remedy here. */
function gapsReport(ctx) {
  const rows = core.gaps(ctx.scoped, ctx.mentions, ctx.citations, {
    clientBrandId: ctx.client?.id || null,
    competitorBrandIds: ctx.competitors.map((b) => b.id),
  });
  return envelope(ctx, {
    rows: rows.map((r) => ({
      domain: r.domain,
      domainType: r.domainType,
      typeWeight: r.typeWeight,
      compCaptures: metric(r.compCaptures, 'count'),
      youCaptures: metric(r.youCaptures, 'count'),
      gapCaptures: metric(r.gapCaptures, 'count'),
      retrievedPct: metric(r.retrievedPct, 'percent'),
      gapScore: metric(r.gapScore, 'score'),
    })),
    topFive: rows.slice(0, 5).map((r) => ({ domain: r.domain, ...metric(r.gapScore, 'score') })),
  });
}

/** §5 — Domains and URLs are the same builder over a different grouping key. */
function sourcesReport(ctx, { key = 'domain' } = {}) {
  const rows = core.domains(ctx.scoped, ctx.citations, { key });
  const mix = core.domainTypeMix(rows);

  // §5.4: without a path there is no URL type, and the report says so rather
  // than guessing. ChatGPT exposes domains only; Google exposes full URLs.
  const unknownUrlType = key === 'url' ? 0 : rows.filter((r) => !r.urlType).length;

  return envelope(ctx, {
    totalRetrievals: metric(mix.totalRetrievals, 'count'),
    typeMix: mix.rows.map((r) => ({
      type: r.type,
      retrievals: metric(r.retrievals, 'count'),
      ...metric(r.value, 'percentDense'),
    })),
    rows: rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      host: r.host,
      url: r.url,
      domainType: r.domainType,
      urlType: r.urlType,
      retrievals: metric(r.retrievals, 'count'),
      retrievedPct: metric(r.retrievedPct, 'percent'),
      retrievalRate: metric(r.retrievalRate, 'rate'),
      citationRate: metric(r.citationRate, 'percent'),
    })),
  }, unknownUrlType ? ['url_type_unavailable'] : []);
}

/** §4. */
function chatsReport(ctx) {
  const c = core.chats(ctx.scoped, ctx.mentions, ctx.citations, ctx.client?.id || null);
  return envelope(ctx, {
    kpis: {
      totalChats: metric(c.totalChats, 'count'),
      brandMentioned: metric(c.brandMentioned, 'count'),
      webSearch: metric(c.webSearchPct, 'percent', {
        note: c.featuresRecorded ? null : 'Not recorded for these captures',
      }),
      averageCitation: metric(c.averageCitation, 'rate', {
        note: c.citationsExtracted ? null : 'Citations not extracted yet',
      }),
      mostCommonFeature: c.mostCommonFeature,
    },
    rows: c.rows.map((r) => ({
      ...r,
      sources: metric(r.sources, 'count'),
      position: metric(r.position, 'position', { direction: 'lower_is_better' }),
    })),
  });
}

/**
 * §7 — perception.
 *
 * Returns the shape with empty data when no attributes have been extracted,
 * rather than omitting the report. A client asking "what am I known for" and
 * getting a blank panel has been answered; getting a 404 has not.
 */
function perceptionReport(ctx, attributes = []) {
  const ids = new Set(ctx.scoped.map((c) => c.id));
  const rows = (attributes || []).filter((a) => ids.has(a.captureId));

  if (!rows.length) {
    return envelope(ctx, {
      association: [], heatmap: [], terms: [], mostAssociated: null, biggestGap: null,
    }, ['perception_not_extracted']);
  }

  const byAttribute = new Map();
  const byTerm = new Map();
  for (const a of rows) {
    if (ctx.client && a.brandId !== ctx.client.id) continue;
    const attr = a.attributeId || 'unmapped';
    byAttribute.set(attr, (byAttribute.get(attr) || 0) + (a.occurrences || 1));
    const k = `${a.term}::${attr}`;
    if (!byTerm.has(k)) byTerm.set(k, { term: a.term, attribute: attr, occurrences: 0 });
    byTerm.get(k).occurrences += a.occurrences || 1;
  }

  const association = [...byAttribute.entries()]
    .map(([attributeId, score]) => ({ attributeId, ...metric(score, 'count') }))
    .sort((a, b) => b.value - a.value);

  return envelope(ctx, {
    association,
    // §7.1: keep zero-score attributes — an attribute the industry cares about
    // scoring zero is the honest answer, not a missing row.
    mostAssociated: association[0] || null,
    biggestGap: association.length ? association[association.length - 1] : null,
    terms: [...byTerm.values()]
      .sort((a, b) => b.occurrences - a.occurrences)
      .map((t) => ({ ...t, ...metric(t.occurrences, 'count') })),
    heatmap: [],
  });
}

/** §3.3 — one run. Named "Run visibility", never "Visibility". */
function runReport(ctx, { runCaptures = null } = {}) {
  const scoped = runCaptures
    ? core.scopeCaptures(runCaptures)
    : ctx.scoped;
  const r = ctx.client
    ? core.runVisibility(scoped, ctx.mentions, ctx.client.id)
    : { score: null, named: null, measured: scoped.length, label: 'Run visibility' };

  const sov = core.shareOfVoice(scoped, ctx.mentions, ctx.measuredIds);
  const byId = new Map(ctx.brands.map((b) => [b.id, b]));
  const clientRow = sov.rows.find((x) => x.brandId === ctx.client?.id);

  return envelope(ctx, {
    label: r.label,
    score: metric(r.score, 'score', {
      note: ctx.client ? null : 'No client brand approved — nothing was matched against.',
    }),
    // "0 of 34" would assert a measured zero. With no client brand nothing was
    // matched against at all, and §11 keeps those two states apart: the score
    // is an em-dash, so the basis beside it must not read as a real zero.
    basis: r.named === null
      ? `${r.measured} captures, none matched against a brand`
      : `${r.named} of ${r.measured} captures`,
    coverage: metric(core.coverage(runCaptures || ctx.split.current).value, 'percent'),
    // §3.4: a run is too small for mention weighting, so this is capture
    // counts, and the label says which unit it is in.
    shareOfVoice: {
      unit: 'captures',
      // Null, not "0 of 0" — with nothing measured there is no fraction to
      // state, and a zero-over-zero reads as a result rather than an absence
      // of one.
      label: sov.totalMentions
        ? `${clientRow?.mentions ?? 0} of ${sov.totalMentions} mentions`
        : null,
      rows: sov.rows.map((x) => ({
        brandId: x.brandId,
        name: byId.get(x.brandId)?.name || x.brandId,
        isClient: Boolean(byId.get(x.brandId)?.isClient),
        ...metric(x.value, 'percent'),
      })),
    },
    citedInstead: core.domains(scoped, ctx.citations)
      .filter((d) => d.domainType !== 'you')
      .slice(0, 10)
      .map((d) => ({ domain: d.domain, domainType: d.domainType, ...metric(d.retrievals, 'count') })),
  });
}

/**
 * §10 — the Executive overview computes NOTHING NEW.
 *
 * It re-selects from the other builders, so the hero number and the report it
 * links to cannot disagree. Recomputing here would be the easiest possible way
 * to ship two different answers to the same question.
 */
function overviewReport(ctx) {
  const ins = insights(ctx);
  const gap = gapsReport(ctx);
  const prompts = promptsReport(ctx);

  return envelope(ctx, {
    kpis: ins.data.kpis,
    // The trend used to live one screen away, which meant "are we improving"
    // — the question a person opens this with — could not be answered on the
    // screen they opened. Re-selected, not recomputed.
    trend: ins.data.trend,
    firstNamed: ins.data.firstNamed,
    shareOfVoice: ins.data.shareOfVoice,
    topGaps: gap.data.topFive,
    weakestPrompts: prompts.data.weakest.slice(0, 5),
  }, [...ins.warnings, ...gap.warnings, ...prompts.warnings]);
}

/**
 * Sources: who gets cited instead of you, and where you could be.
 *
 * Gap analysis, Domains and URLs were three screens over one body of data,
 * split by how deep you wanted to look. That is a disclosure control, not a
 * separate report, so it is one screen with the URL level behind a click.
 */
function sourcesOverview(ctx) {
  const gap = gapsReport(ctx);
  const dom = sourcesReport(ctx, { key: 'domain' });
  const url = sourcesReport(ctx, { key: 'url' });

  return envelope(ctx, {
    totalRetrievals: dom.data.totalRetrievals,
    typeMix: dom.data.typeMix,
    domains: dom.data.rows,
    urls: url.data.rows,
    gaps: gap.data.rows,
    topGaps: gap.data.topFive,
  }, [...gap.warnings, ...dom.warnings, ...url.warnings]);
}

/**
 * Build one report by id.
 *
 * @param {string} reportId one of REPORT_IDS
 * @param {object} input    captures, mentions, citations, brands, prompts, attributes, options
 */
function buildReport(reportId, input = {}) {
  const ctx = buildContext(input);
  switch (reportId) {
    case 'overview': return overviewReport(ctx);
    // The four rail reports. Each is a re-selection of the builders below it.
    case 'questions': return promptsReport(ctx);
    case 'sources': return sourcesOverview(ctx);
    case 'answers': return chatsReport(ctx);
    case 'insights': return insights(ctx);
    case 'perception': return perceptionReport(ctx, input.attributes);
    case 'prompts': return promptsReport(ctx);
    case 'gaps': return gapsReport(ctx);
    case 'domains': return sourcesReport(ctx, { key: 'domain' });
    case 'urls': return sourcesReport(ctx, { key: 'url' });
    case 'chats': return chatsReport(ctx);
    case 'run': return runReport(ctx, { runCaptures: input.runCaptures });
    default: {
      const e = new Error(`Unknown report "${reportId}".`);
      e.status = 400;
      e.code = 'unknown_report';
      throw e;
    }
  }
}

module.exports = {
  REPORTS,
  REPORT_IDS,
  LEGACY_REPORT_IDS,
  buildContext,
  meta,
  kpis,
  firstNamedGrid,
  insights,
  perceptionReport,
  promptsReport,
  gapsReport,
  sourcesReport,
  chatsReport,
  runReport,
  overviewReport,
  buildReport,
};
