// ── A report's working: what each item cost ─────────────────────────────────
//
// methodology.js says how a score is calculated. This turns the report on
// screen into the numbers that calculation ran on, item by item, so the
// assistant can answer "why did warnings cost 22?" with "links to redirected
// pages on 1,800 of 3,622 pages: 10 × 1,800 ÷ 3,622 = 5.0 points, …".
//
// The client sends the report's per-item inputs (components/chat/
// screenWorking.js). Where the server owns the scoring constants — SEO & GEO
// tiers and points, Agent Readiness weights, the AI Visibility blend — the
// costs are computed HERE with those constants, so an answer can never quote a
// weight the scorer does not use. Tech Audit's costs come computed from the
// client, because that score is computed there (crawlHelpers.healthMetrics).
//
// Input is reduced to plain bounded JSON first: it is our own report data,
// but it arrives from the browser.

const seoGeo = require('../../checks/seoGeoChecks');
const agentScore = require('../../checks/agentReadinessScore');
const { CLUSTER_HEALTH_WEIGHTS, UNVERIFIED_HUB_CREDIT } = require('../contentArchitect/config');

const LIMITS = { string: 300, array: 250, depth: 6 };

function clean(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, LIMITS.string);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth >= LIMITS.depth) return null;
  if (Array.isArray(value)) return value.slice(0, LIMITS.array).map((v) => clean(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 80)) {
    if (typeof v === 'function') continue;
    out[k.slice(0, 60)] = clean(v, depth + 1);
  }
  return out;
}

const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Tech Audit ──────────────────────────────────────────────────────────────

// Site Health v7 (crawlHelpers.HEALTH_WEIGHTS): notices cost nothing; rules no
// scored page carries are charged once for the site (SITE_LEVEL_WEIGHTS).
const WEIGHT = { error: 40, warning: 10, notice: 0 };
const SITE_WEIGHT = { site: { error: 5, warning: 2 }, offPage: { error: 2, warning: 1 } };
const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '?');

// "What is the least we must fix to reach N?" Taking the costliest items first
// gives the fewest fixes; the rounded score reaches N once the exact one is
// N − 0.5. Worked out here: a model reasoning it out loses track of the sums.
const TARGETS = [50, 60, 70, 75, 80, 85, 90, 95];
function fewestFixesToReach(items, start, gain, scoreOf) {
  const out = {};
  for (const target of TARGETS) {
    if (Math.round(scoreOf(start)) >= target) continue;
    let total = start;
    const picked = [];
    for (const it of items) {
      if (Math.round(scoreOf(total)) >= target) break;
      total += gain(it);
      picked.push(it.name);
    }
    if (Math.round(scoreOf(total)) < target) { out[target] = 'not reachable by fixing listed items alone'; continue; }
    out[target] = `${picked.length} fix${picked.length === 1 ? '' : 'es'} (the fewest that reach ${target}): ${picked.join(', ')} → the score becomes ${Math.round(scoreOf(total))} (exact ${r2(scoreOf(total))})`;
  }
  return out;
}

// The checks the client hid, as the working lists them: each rule's id and
// name, with an explicit statement of what hiding does to the score.
function hiddenChecksWorking(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((h) => (typeof h === 'string' ? { ruleId: h } : h))
    .filter((h) => h && typeof h === 'object' && typeof h.ruleId === 'string' && h.ruleId)
    .map((h) => ({
      ruleId: h.ruleId,
      rule: typeof h.rule === 'string' && h.rule ? h.rule : h.ruleId,
      occurrencesInThisCrawl: num(h.occurrences),
    }));
  if (!list.length) return {};
  return {
    hiddenChecks: list,
    hiddenChecksNote: `${list.length} check${list.length === 1 ? ' is' : 's are'} hidden for this client and excluded from this score: `
      + `${list.map((h) => h.rule).join(', ')}. A hidden check costs no points, is not counted in the errors, warnings `
      + 'or notices, and is not in the rule list, on every crawl of this client (the previous crawl in the change '
      + 'indicator is scored without it too). Restoring it puts it back into every figure.',
  };
}

function tech(w) {
  const scored = num(w.pagesScored);
  const rules = arr(w.rules).map((r) => {
    const pages = num(r.pagesAffected);
    const listed = num(r.urlsListedInReport);
    const capped = num(r.pagesCapped) || 0;
    const points = r2(num(r.points));
    const weight = WEIGHT[r.severity];
    const siteLevel = r.siteLevel === 'site' || r.siteLevel === 'offPage' ? r.siteLevel : null;
    // The arithmetic in words, so an answer can quote it rather than redo it.
    let calculation = null;
    if (siteLevel) {
      const base = SITE_WEIGHT[siteLevel][r.severity];
      calculation = `${points} points, charged once for the site rather than per page: `
        + (siteLevel === 'site' ? 'a site-wide problem' : 'found only on redirects, error pages or files, never on a scored page')
        + ` (${base} per ${r.severity} rule; all such rules together are capped at 20${points < base ? ', which scaled this one down' : ''})`;
    } else if (weight && pages === 0) {
      calculation = `0 points: none of the ${listed === null ? '' : `${fmt(listed)} `}URLs it is listed on is a scored page`;
    } else if (weight && pages !== null && scored) {
      calculation = capped
        ? `${weight} × ${fmt(pages)} pages ÷ ${fmt(scored)} = ${r2((weight * pages) / scored)} before the per-page cap; ${fmt(capped)} of those pages hit the 100-point cap and count for less, so ${points}`
        : `${weight} × ${fmt(pages)} pages ÷ ${fmt(scored)} pages scored = ${points}`;
      if (listed !== null && listed > pages) {
        calculation += ` (listed on ${fmt(listed)} URLs; only the ${fmt(pages)} scored pages count)`;
      }
    }
    return {
      rule: r.rule || r.ruleId,
      severity: r.severity,
      pagesAffected: pages,
      urlsListedInReport: listed,
      pagesCapped: capped,
      occurrences: num(r.occurrences),
      points,
      siteLevel,
      calculation,
    };
  });
  const gains = arr(w.rules).map((r) => num(r.gainIfFixed));
  const bySeverity = {};
  arr(w.rules).forEach((raw, i) => {
    const r = rules[i];
    // Site-level rules make up the Site-wide bar, not their severity's.
    const s = (bySeverity[r.siteLevel ? 'site' : r.severity] ||= { rulesListed: 0, rulesCostingPoints: 0, rulesCostingNothing: 0, points: 0 });
    s.rulesListed += 1;
    if (r.points > 0) s.rulesCostingPoints += 1; else s.rulesCostingNothing += 1;
    // Summed unrounded, so the total matches the bar's exact figure.
    s.points += num(raw.points) || 0;
  });
  for (const [severity, s] of Object.entries(bySeverity)) {
    s.points = r2(s.points);
    // A severity's total is the sum of its rules, never weight × pages: a page
    // with two errors pays twice, and zero-cost rules still count as listed.
    const parts = rules.filter((r) => (r.siteLevel ? 'site' : r.severity) === severity).map((r) => r.points ?? 0);
    const shown = r2(parts.reduce((a, b) => a + b, 0));
    s.calculation = `sum of its ${s.rulesListed} rules: ${parts.join(' + ')} = ${s.points}`
      + (shown !== s.points ? ` (the parts are rounded, so they add to ${shown}; the exact total is ${s.points})` : '')
      + (s.rulesCostingNothing ? `; ${s.rulesCostingNothing} of them cost 0` : '');
  }
  const bands = arr(w.bands);
  const exactLoss = bands.reduce((s, b) => s + (num(b.exactPoints) || 0), 0);
  // The most-asked what-if, answered here so the model never has to do it: the
  // score with only this rule fixed, rounded once. From the report's exact
  // gain where it sent one: on a page at the 100-point cap, fixing one rule
  // wins back less than its points, because the page's other rules fill the gap.
  if (bands.length) {
    rules.forEach((r, i) => {
      const gain = gains[i] ?? r.points;
      if (gain !== null) r.scoreIfOnlyThisWereFixed = Math.min(100, Math.round(100 - exactLoss + gain));
      if (gains[i] !== null && r.points !== null && gains[i] < r.points - 0.005) r.gainIfFixed = r2(gains[i]);
    });
  }
  // The report works the fix plan out page by page; the sum of points is the
  // fallback for an older client.
  const plan = w.fewestFixesToReach && typeof w.fewestFixesToReach === 'object' ? clean(w.fewestFixesToReach) : null;
  const sortedRules = [...rules].sort((a, b) => (b.points ?? -1) - (a.points ?? -1));
  return {
    score: num(w.score),
    // "What costs us most", ready to quote in order.
    fewestFixesToReach: plan || (bands.length ? fewestFixesToReach(
      sortedRules.filter((r) => r.points > 0).map((r) => ({ name: r.rule, points: r.points })),
      100 - exactLoss, (it) => it.points, (x) => Math.min(100, x),
    ) : null),
    topByPointsLost: sortedRules.filter((r) => r.points > 0).slice(0, 5)
      .map((r) => `${r.rule} (${r.severity}): ${r.points} points, ${fmt(r.pagesAffected)} pages`),
    // What-ifs start here, not from the rounded score: fixing a rule removes its
    // points from the exact loss, and only the result is rounded.
    exactLossTotal: bands.length ? r2(exactLoss) : null,
    // All severities together; "errors cost 35" was a real misreading of this.
    lossCalculation: bands.length
      ? `${bands.map((b) => `${b.severity}s ${r2(num(b.exactPoints))}`).join(' + ')} = ${r2(exactLoss)} points lost in all`
      : null,
    exactScoreBeforeRounding: bands.length ? r2(100 - exactLoss) : null,
    pagesScored: num(w.pagesScored),
    pagesAtFloor: num(w.pagesAtFloor),
    weights: { error: 40, warning: 10, notice: 0, siteLevel: SITE_WEIGHT, siteLevelCap: 20 },
    bands: arr(w.bands).map((b) => ({
      severity: b.severity, exactPoints: r2(num(b.exactPoints)), barShows: num(b.barShows), pagesWithThisSeverity: num(b.pages),
      howExactPointsAreMade: 'the sum of this severity\'s rule points (rulesTotalBySeverity); pagesWithThisSeverity is a count only, never multiply it by the weight',
    })),
    rulesTotalBySeverity: bySeverity,
    // Costliest first, so "what costs us most" is the top of the list.
    rulesOrder: 'most points lost first',
    rules: sortedRules,
    rulesNotListed: num(w.rulesNotListed) || 0,
    // Checks this client hid (Semrush's "exclude check"): out of the score, the
    // counts and the rule list above, on every crawl. Omitted when none are.
    ...hiddenChecksWorking(w.hiddenChecks),
    note: 'This lists EVERY rule the report shows. Each rule\'s points = weight × scored pages it is on (scaled on pages whose loss hit the 100 cap) ÷ pages scored. Rules with a siteLevel are charged once for the site instead (site-wide problems, or ones found only on redirects, error pages or files) and make up the Site-wide bar. Notices cost 0. A severity\'s rules sum to its exact points; the bars round those so they add up to 100 − score. For what-ifs use scoreIfOnlyThisWereFixed and fewestFixesToReach and never subtract points yourself: on a page at the 100-point cap a fix wins back less than its points (gainIfFixed).',
  };
}

// ── SEO & GEO ───────────────────────────────────────────────────────────────

const BUCKET_OF = Object.fromEntries(
  seoGeo.SCORE_BUCKETS.flatMap((b) => b.categories.map((c) => [c, b])),
);

// "What do all the checks cost together?" answered here, per area and in total,
// so a model never sums a long list itself (it got 11.18 for a real 16.13).
function checksTotal(costed, exactComposite) {
  const byArea = new Map();
  const byStatus = new Map();
  let total = 0;
  for (const c of costed) {
    const st = byStatus.get(c.status) || { status: c.status, checks: 0, headlinePointsLost: 0 };
    st.checks += 1;
    st.headlinePointsLost += c.headlinePointsLost || 0;
    byStatus.set(c.status, st);
    const a = byArea.get(c.area) || { area: c.area, checks: 0, headlinePointsLost: 0 };
    a.checks += 1;
    a.headlinePointsLost += c.headlinePointsLost || 0;
    byArea.set(c.area, a);
    total += c.headlinePointsLost || 0;
  }
  const exactLoss = exactComposite === null ? null : r2(100 - exactComposite);
  return {
    checksCostingPoints: costed.length,
    headlinePointsLost: r2(total),
    calculation: `the ${costed.length} checks' headline points add to ${r2(total)}`
      + (exactLoss === null ? '' : `; the exact loss is 100 − ${r2(exactComposite)} = ${exactLoss} (each check is rounded, so the sum can differ by a few hundredths)`),
    byArea: [...byArea.values()].map((a) => ({ ...a, headlinePointsLost: r2(a.headlinePointsLost) })),
    // "Failing" checks are status fail; warnings cost points too.
    byStatus: [...byStatus.values()].map((a) => ({ ...a, headlinePointsLost: r2(a.headlinePointsLost) })),
  };
}

function capsOnThisPage(w) {
  const held = [];
  if (w.cap?.applied) held.push(`overall capped at ${num(w.cap.value)}${arr(w.cap.groups).length ? ` (${arr(w.cap.groups).map((g) => g.reason || g.id).join('; ')})` : ''}`);
  for (const side of ['seo', 'geo']) {
    const c = w.sides?.[side]?.cap;
    const reasons = Array.isArray(c?.reasons) ? c.reasons.filter((r) => typeof r === 'string') : [];
    if (c?.applied) held.push(`${side.toUpperCase()} side held at ${num(c.value)}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
  }
  return held.length
    ? `${held.join('; ')}. No other cap applies to this page.`
    : 'none: no blocking cap applies to this page or either side.';
}

function seogeo(w) {
  const intent = ['commercial', 'informational'].includes(w.pageIntent) ? w.pageIntent : 'informational';
  const areas = arr(w.areas);
  const areaByKey = new Map(areas.map((a) => [a.key, a]));

  // Σ tier × 100 per area, over the scored checks — the denominator a check's
  // cost inside its area is taken over.
  const checks = arr(w.checks).map((c) => {
    const bucket = BUCKET_OF[c.category] || null;
    const points = seoGeo.checkPoints({ status: c.status, severity: c.severity });
    return { ...c, bucket, points, tier: points === null ? null : seoGeo.checkTier(c.id, intent) };
  });
  const denom = {};
  for (const c of checks) if (c.bucket && c.points !== null) denom[c.bucket.key] = (denom[c.bucket.key] || 0) + c.tier * 100;

  const costed = checks
    .filter((c) => c.bucket && c.points !== null && c.points < 100)
    .map((c) => {
      const areaPoints = (c.tier * (100 - c.points)) / denom[c.bucket.key] * 100;
      const eff = num(areaByKey.get(c.bucket.key)?.effective_weight);
      const d = denom[c.bucket.key];
      return {
        id: c.id,
        check: c.name,
        area: c.bucket.label,
        status: c.status,
        severity: c.severity || null,
        tier: c.tier,
        checkPoints: c.points,
        areaPointsLost: r1(areaPoints),
        headlinePointsLost: eff === null ? null : r2(areaPoints * eff),
        calculation: `tier ${c.tier} × (100 − ${c.points}) ÷ ${d} × 100 = ${r1(areaPoints)} ${c.bucket.label} points`
          + (eff === null ? '' : ` × effective weight ${eff} = ${r2(areaPoints * eff)} headline points`),
      };
    })
    .sort((a, b) => (b.headlinePointsLost ?? b.areaPointsLost) - (a.headlinePointsLost ?? a.areaPointsLost));

  const blockers = new Map(seoGeo.BLOCKER_GROUPS.map((g) => [g.id, g]));

  // The headline is the weighted mean of the AREAS — not a blend of the SEO and
  // GEO side scores, which a model will otherwise invent. Spelled out exactly.
  const scored = areas.filter((a) => num(a.score) !== null && num(a.weight) !== null);
  const wSum = scored.reduce((s, a) => s + a.weight, 0);
  const exactComposite = wSum ? scored.reduce((s, a) => s + a.weight * a.score, 0) / wSum : null;
  const compositeCalculation = wSum
    ? `(${scored.map((a) => `${a.weight} × ${a.score}`).join(' + ')}) ÷ ${r2(wSum)} = ${r2(exactComposite)}, rounded to ${Math.round(exactComposite)}`
    : null;

  return {
    url: w.url || null,
    whatThisScoreIs: `the score of ONE page${w.url ? ` (${w.url})` : ''}, the one open on screen. The dashboard's SEO & GEO module score is a different figure: the mean over all audited pages.`,
    pageIntent: intent,
    overall: num(w.overall),
    composite: num(w.composite),
    exactCompositeBeforeRounding: r2(exactComposite),
    compositeCalculation,
    howOverallRelatesToSides: 'The overall score is the weighted mean of the area scores above (then capped if a blocking cap applies to the overall). It is NOT a blend of the SEO and GEO side scores; the sides are separate views over their own areas, and a side\'s cap (e.g. the GEO answerability hold) affects only that side\'s score.',
    cap: w.cap ? {
      applied: Boolean(w.cap.applied),
      value: num(w.cap.value),
      pointsRemovedByCap: num(w.composite) !== null && num(w.overall) !== null ? num(w.composite) - num(w.overall) : null,
      triggeredBy: arr(w.cap.groups).map((g) => ({ id: g.id, cap: blockers.get(g.id)?.cap ?? num(g.cap), reason: blockers.get(g.id)?.reason || g.reason, checks: blockers.get(g.id)?.ids || null })),
    } : null,
    sides: w.sides || null,
    // The method lists every cap there is; this says which ones THIS page has,
    // so a model does not pick one from the list (it once invented "No H1").
    capsOnThisPage: capsOnThisPage(w),
    areas: areas.map((a) => ({
      area: a.label, side: a.axis, score: num(a.score), weight: num(a.weight), effectiveWeight: num(a.effective_weight), pointsLost: num(a.points_lost),
      checksScored: num(a.checks_scored),
    })),
    checksTotal: checksTotal(costed, exactComposite),
    checksCostingPoints: costed.slice(0, 120),
    checksCostingPointsNotListed: Math.max(0, costed.length - 120),
    note: 'A check\'s area points lost = tier × (100 − its points) ÷ Σ(tier × 100 over the area\'s scored checks) × 100; × the area\'s effective weight = headline points before rounding. A triggered blocking cap removes composite − overall on top.',
  };
}

// ── Agent Readiness ─────────────────────────────────────────────────────────

function agent(w) {
  const site = w.site || {};
  const httpChecks = arr(w.httpChecks);
  const onPageChecks = arr(w.onPageChecks);
  // The scorer's own function, on the checks on screen: 70 points for core
  // access, 20 for the other checks a site can do today, 10 for emerging
  // standards.
  const base = agentScore.readinessScore({ httpChecks, onPageChecks });
  const exact = base.exact;
  const groupName = (id) => agentScore.tierOf(id).toUpperCase();
  // Fixing a check adds to its tier's earned points only, so its effect on
  // the total is fixed: its points ÷ the tier's points available × the
  // tier's share.
  const costed = (c, available, lost) => {
    const g = base[agentScore.tierOf(c.id)];
    const effect = lost ? agentScore.scorePointsFor(base, c.id, lost) : 0;
    return {
      id: c.id, check: c.label, category: c.cat, status: c.status,
      group: groupName(c.id),
      pointsAvailable: available, pointsLost: lost,
      totalScoreEffect: lost === null ? null : r1(effect),
      exactEffect: lost === null ? null : effect,
      calculation: lost ? `${lost} ÷ ${g.max} ${groupName(c.id)} points × ${r2(g.points)} =${r2(effect)} points of the total` : null,
    };
  };
  const http = httpChecks.map((c) => {
    const weight = agentScore.WEIGHTS[c.id];
    const lost = c.status === 'pass' ? 0 : (Number.isFinite(weight) ? weight : null);
    return costed(c, weight ?? null, lost);
  });
  const onPage = onPageChecks.map((c) => {
    const lost = num(c.maxScore) !== null && num(c.score) !== null ? c.maxScore - c.score : null;
    return costed(c, num(c.maxScore), lost);
  });
  const all = [...http, ...onPage];
  const scoreWith = (extra) => (exact === null ? null : Math.min(100, Math.round(exact + extra)));
  for (const c of all) {
    if (c.pointsLost) c.scoreIfOnlyThisWereFixed = scoreWith(c.exactEffect);
  }
  const g = (key) => ({ pointsEarned: base[key].earned, pointsAvailable: base[key].max, shareOfTotal: r2(base[key].points) });
  const term = (key) => `${r2(base[key].points)} × ${base[key].earned} ÷ ${base[key].max}`;
  const terms = ['core', 'now', 'future'].filter((k) => base[k].max > 0).map(term);
  return {
    score: num(site.score),
    level: site.level || null,
    coreGroup: g('core'),
    nowGroup: g('now'),
    futureGroup: g('future'),
    exactScoreBeforeRounding: exact === null ? null : r2(exact),
    totalCalculation: exact === null ? null : `round(${terms.join(' + ')}) = round(${r2(exact)}) = ${scoreWith(0)}`,
    whatIfRule: 'Score if checks were fixed = round(exact score now + the sum of their effects on the total). '
      + 'A check\'s effect = its points ÷ its tier\'s points available × the tier\'s share (70 CORE, 20 NOW, 10 FUTURE).',
    // Score points to gain for each target, and the fewest fixes.
    pointsToEarnToReach: exact === null ? null : Object.fromEntries(TARGETS.filter((t) => scoreWith(0) < t).map((t) => {
      const need = Math.max(0, (t - 0.5) - exact);
      const rate = (key) => (base[key].max ? `${r2(base[key].points / base[key].max)} per ${key.toUpperCase()} point` : null);
      return [t, `gain ${r2(need)} more score points (exact ${r2(exact)} → ${r2(exact + need)} rounds to ${t}); `
        + `fixes earn ${[rate('core'), rate('now'), rate('future')].filter(Boolean).join(', ')}`];
    })),
    fewestFixesToReach: exact === null ? null : fewestFixesToReach(
      all.filter((c) => c.pointsLost > 0).sort((a, b) => b.exactEffect - a.exactEffect).map((c) => ({ name: c.check, effect: c.exactEffect })),
      exact, (it) => it.effect, (x) => Math.min(100, x),
    ),
    categories: arr(w.cats).map((c) => ({ id: c.id, score: num(c.score), passed: num(c.passed), total: num(c.total) })),
    checks: all.map(({ exactEffect, ...c }) => c).sort((a, b) => (b.totalScoreEffect || 0) - (a.totalScoreEffect || 0)),
    note: 'Total = round(70 × CORE points earned ÷ CORE points available + 20 × NOW points earned ÷ NOW points available '
      + '+ 10 × FUTURE points earned ÷ FUTURE points available); a tier with nothing to score gives its share to the others '
      + 'in proportion to their points. CORE = AI bot rules, robots.txt, sitemap; NOW = the other checks a site can do today '
      + '(Link headers, every on-page check that ran); FUTURE = emerging standards (markdown, content signals, API catalog, '
      + 'OAuth, MCP, agent skills, WebMCP, web bot auth).',
  };
}

// ── AI Visibility (API-based) ───────────────────────────────────────────────

const GAP_WEIGHT = { competitor: 1, reference: 1, institutional: 0.9, editorial: 0.8, ugc: 0.7, corporate: 0.6, you: 0, other: 0.5 };

// "How do we compare" in one line, ties named as ties: a model otherwise says
// "you trail your competitors" when everyone is at 0%.
function brandComparison(brands) {
  const rated = brands
    .map((b) => ({ name: b.name, you: Boolean(b.you), named: num(b.answersNamingIt), of: num(b.answersMeasured) }))
    .filter((b) => b.named !== null && b.of);
  if (!rated.length) return null;
  rated.sort((a, b) => b.named / b.of - a.named / a.of);
  const rate = (b) => r1((b.named / b.of) * 100);
  const line = rated.map((b) => `${b.you ? `${b.name} (you)` : b.name} named in ${b.named} of ${b.of} answers (${rate(b)}%)`).join('; ');
  const you = rated.find((b) => b.you);
  if (!you) return line;
  const ahead = rated.filter((b) => !b.you && rate(b) > rate(you)).length;
  const level = rated.filter((b) => !b.you && rate(b) === rate(you)).length;
  const behind = rated.filter((b) => !b.you && rate(b) < rate(you)).length;
  return `${line}. Versus tracked brands: ${ahead} ahead of you, ${level} level with you, ${behind} behind you.`;
}

function aivisLite(w) {
  const parts = arr(w.scoreBreakdown);
  const used = parts.filter((p) => p.included && num(p.value) !== null);
  const W = used.reduce((s, p) => s + (num(p.weight) || 0), 0);
  return {
    score: num(w.score),
    answersMeasured: num(w.answersMeasured),
    competitorsTracked: num(w.competitorsTracked),
    readings: parts.map((p) => ({
      reading: p.key,
      value: r1(num(p.value)),
      nominalWeight: num(p.weight),
      included: Boolean(p.included && num(p.value) !== null),
      effectiveWeight: p.included && W ? r2(num(p.weight) / W) : 0,
      contribution: p.included && W && num(p.value) !== null ? r1((p.value * p.weight) / W) : 0,
      calculation: p.included && W && num(p.value) !== null ? `${r1(p.value)} × ${p.weight} ÷ ${W} = ${r1((p.value * p.weight) / W)}` : 'not measured, left out and the rest reweighted',
    })),
    brands: arr(w.brands),
    brandComparison: brandComparison(arr(w.brands)),
    byEngine: arr(w.byEngine),
    byQuestion: arr(w.byQuestion).slice(0, 60),
    sentiment: w.sentiment || null,
    sourceGaps: arr(w.gaps).slice(0, 40).map((g) => ({ ...g, typeWeight: GAP_WEIGHT[g.sourceType] ?? 0.5 })),
    note: 'Score = Σ reading × weight ÷ Σ weights of the readings present; each reading\'s contribution is listed.',
  };
}

// ── The rest: inputs passed through, plus what can be derived ────────────────

function comp(w) {
  const domains = arr(w.domains).map((d) => ({ domain: d.domain, you: Boolean(d.isClient), traffic: num(d.traffic), keywords: num(d.keywords), authority: num(d.authority), backlinks: num(d.backlinks) }));
  const ranked = domains.filter((d) => d.traffic !== null).sort((a, b) => b.traffic - a.traffic);
  const you = domains.find((d) => d.you) || null;
  const rivals = ranked.filter((d) => !d.you);
  const strongest = rivals[0] || null;
  const ratio = you?.traffic !== null && you?.traffic !== undefined && strongest?.traffic ? you.traffic / strongest.traffic : null;
  return {
    score: num(w.trafficScore?.score),
    yourTraffic: you?.traffic ?? null,
    strongestCompetitor: strongest ? { domain: strongest.domain, traffic: strongest.traffic } : null,
    ratio: r2(ratio),
    // The unrounded percentage, so every answer quotes the same figure.
    exactPercentBeforeRounding: ratio === null ? null : r2(ratio * 100),
    calculation: ratio === null ? null : `min(100, round(${you.traffic} ÷ ${strongest.traffic} × 100)) = min(100, round(${r2(ratio * 100)})) = ${Math.min(100, Math.round(ratio * 100))}`,
    rank: you && you.traffic !== null ? ranked.findIndex((d) => d.you) + 1 : null,
    of: ranked.length,
    // "How far behind are we" per rival, worked out here: a model that subtracts
    // in its head gets it wrong.
    domains: ranked.concat(domains.filter((d) => d.traffic === null)).map((d) => (
      d.you || d.traffic === null || you?.traffic === null || you?.traffic === undefined ? d : {
        ...d,
        trafficGapVsYou: d.traffic - you.traffic,
        gapCalculation: d.traffic >= you.traffic
          ? `${d.traffic} − ${you.traffic} = ${d.traffic - you.traffic} estimated monthly visits: they are ahead of you`
          : `${you.traffic} − ${d.traffic} = ${you.traffic - d.traffic} estimated monthly visits: you are ahead of them`,
        yourShareOfTheirTraffic: d.traffic ? `${r2((you.traffic / d.traffic) * 100)}%` : null,
      })),
  };
}

function hub(w) {
  // The same weights the score is built with (contentArchitect/config.js), so
  // this breakdown cannot drift from the formula: v2 has four parts and no
  // "size" part.
  const W = CLUSTER_HEALTH_WEIGHTS;
  const clusters = arr(w.clusters).map((c) => {
    const depth = num(c.meanDepth);
    const unverified = c.hubConfidence === 'suggested' || c.hubConfidence === 'reference';
    const hubPoints = c.isGap ? 0 : W.hubPresent * (unverified ? UNVERIFIED_HUB_CREDIT : 1);
    const depthPoints = depth === null ? 0 : r1(W.clickDepth * Math.max(0, 1 - depth / 8));
    const health = num(c.health);
    // Vocabulary breadth and hub <-> spoke linking are not stored separately;
    // together they are what is left. Without a hub both are 0 by the formula.
    const rest = health === null ? null : r1(Math.max(0, health - hubPoints - depthPoints));
    return {
      ...c,
      healthParts: {
        hubPresent: { points: hubPoints, max: W.hubPresent },
        clickDepth: { points: depthPoints, max: W.clickDepth },
        vocabularyBreadthPlusHubSpokeLinking: { points: rest, max: W.hubTermCoverage + W.hubSpokeLinking },
      },
      calculation: rest === null ? null
        : `${hubPoints} hub (of ${W.hubPresent}) + ${depthPoints} click depth (of ${W.clickDepth}) + ${rest} hub vocabulary breadth and hub ↔ spoke linking together (of ${W.hubTermCoverage + W.hubSpokeLinking}) = ${health}`,
    };
  });
  // Weakest first, so "which is weakest" is the first row, not a comparison.
  clusters.sort((a, b) => (num(a.health) ?? 101) - (num(b.health) ?? 101));
  return {
    averageHealth: clusters.length ? Math.round(clusters.reduce((s, c) => s + (num(c.health) || 0), 0) / clusters.length) : null,
    // The only cluster-health formula. Answer "what are the parts / maximums"
    // from this, never from older wording.
    formula: {
      parts: [
        { part: 'Hub present', max: W.hubPresent, rule: `${W.hubPresent} with a hub; ${W.hubPresent * UNVERIFIED_HUB_CREDIT} if the hub is only suggested or is a glossary index; 0 if the hub is missing` },
        { part: 'Hub vocabulary breadth', max: W.hubTermCoverage, rule: `${W.hubTermCoverage} × share of the cluster's vocabulary the hub page covers` },
        { part: 'Hub ↔ spoke linking', max: W.hubSpokeLinking, rule: `${W.hubSpokeLinking} × (spokes linking to the hub + spokes the hub links to) ÷ (2 × spokes)` },
        { part: 'Click depth', max: W.clickDepth, rule: `${W.clickDepth} × max(0, 1 − average click depth ÷ 8)` },
      ],
      total: W.hubPresent + W.hubTermCoverage + W.hubSpokeLinking + W.clickDepth,
      notParts: 'Cluster size (number of spoke pages) is not part of the score.',
    },
    clustersOrder: 'weakest health first',
    clusters: clusters.slice(0, 120),
    clustersNotListed: Math.max(0, clusters.length - 120),
    // Topics the client archived: not in `clusters`, not in averageHealth.
    ...(arr(w.archivedClusters).length ? {
      archivedClusters: arr(w.archivedClusters).slice(0, 120),
      archivedNote: 'Archived for this client: excluded from averageHealth, the cluster list and every count, as if they did not exist. Name them only when asked what was left out; never add them back into a figure.',
    } : {}),
    note: 'healthParts are rebuilt from the cluster\'s hub status and click depths. Hub vocabulary breadth (max 20) and hub ↔ spoke linking (max 30) are not stored separately, so only their sum is known; never split it into two figures (± rounding).',
  };
}

const BUILDERS = { tech, seogeo, agent, aivisLite, comp, hub, aivis: (w) => w, overview: (w) => w };

/** The working for the prompt, or null when there is none or it is unusable. */
function buildWorking(screen, raw) {
  if (!raw || typeof raw !== 'object' || !BUILDERS[screen]) return null;
  try {
    return BUILDERS[screen](clean(raw));
  } catch (e) {
    console.warn(`[reportChat] working for ${screen} unusable:`, e.message);
    return null;
  }
}

module.exports = { buildWorking, clean };
