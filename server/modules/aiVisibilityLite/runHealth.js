// ── How healthy a measurement run was, per model ─────────────────────────────
//
// A run that lost a whole model is not a normal run. Since 23 Oct every Claude
// answer, and since 3 Nov every Gemini answer, failed on a rejected API key,
// and the run still closed as 'completed' with a score — so the page showed a
// ChatGPT-only measurement as an ordinary three-model one.
//
// This file turns a run's failed captures into something a person can read:
// per model, how many of its answers failed and why, with the raw provider
// errors folded into a handful of plain reasons. The raw strings never group on
// their own — every 401 carries a unique request id.
//
// Pure functions, no I/O: run.js writes the result onto the run's payload,
// report.js reads it off the captures, routes.js off older runs' payloads.

const ENGINE_NAMES = { openai: 'ChatGPT', anthropic: 'Claude', google: 'Gemini' };

// A run is partial when a model answered nothing, or when more than this share
// of all its answers failed — the same 90% line coverage warns at.
const PARTIAL_FAILURE_SHARE = 0.1;

/** "Claude (API · web search)" -> "Claude". */
function modelName(engine, label) {
  if (label) return String(label).split(' (')[0];
  return ENGINE_NAMES[engine] || engine || 'A model';
}

/**
 * A provider's error, as one of a few reasons a person can act on.
 *
 * @param {string|null} reason  the stored failure_reason
 * @returns {{code: string, text: string}}
 */
function normaliseFailure(reason) {
  const r = String(reason || '').toLowerCase();
  if (/not configured|not connected/.test(r)) {
    return { code: 'not_configured', text: 'not connected on our side (no API key is set)' };
  }
  if (/\b40[13]\b|authentication|api key not valid|invalid[ _-]?(x-)?api[ _-]?key|permission_denied|unauthori[sz]ed|forbidden/.test(r)) {
    return { code: 'auth', text: 'our API key for this model was rejected' };
  }
  if (/\b429\b|rate[ _-]?limit|resource_exhausted|quota|too many requests/.test(r)) {
    return { code: 'rate_limited', text: 'the model was rate-limited' };
  }
  if (/time(d)? ?out|did not answer within|etimedout|aborted|deadline/.test(r)) {
    return { code: 'timeout', text: 'the model took too long to answer' };
  }
  if (/empty answer|too short|no answer/.test(r)) {
    return { code: 'empty', text: 'the model returned no usable answer' };
  }
  if (/\b5\d\d\b|overloaded|unavailable|internal/.test(r)) {
    return { code: 'provider_error', text: 'the model’s service had an error' };
  }
  return { code: 'other', text: 'the request failed' };
}

/** The plain sentence an answer card shows for one failed capture. */
function plainFailure(reason) {
  if (!reason) return null;
  const { text } = normaliseFailure(reason);
  return `This answer could not be captured: ${text}.`;
}

/**
 * Per-model health of a set of capture rows (one run's, normally).
 *
 * @param {object[]} rows  {engine, surfaceLabel, status, failureReason}
 * @returns {{total, failed, partial, engines, failedEngines, summary}}
 */
function healthOfRows(rows) {
  const byEngine = new Map();
  for (const row of rows || []) {
    const key = row.engine || 'unknown';
    if (!byEngine.has(key)) {
      byEngine.set(key, {
        engine: key, label: modelName(key, row.surfaceLabel), attempted: 0, failed: 0, reasons: new Map(),
      });
    }
    const e = byEngine.get(key);
    e.attempted += 1;
    if (row.status === 'failed') {
      e.failed += 1;
      const n = normaliseFailure(row.failureReason);
      const r = e.reasons.get(n.code) || { ...n, count: 0 };
      r.count += 1;
      e.reasons.set(n.code, r);
    }
  }
  return finish([...byEngine.values()]);
}

function finish(list) {
  const engines = list
    .map((e) => ({
      engine: e.engine,
      label: e.label,
      attempted: e.attempted,
      failed: e.failed,
      allFailed: e.attempted > 0 && e.failed === e.attempted,
      reasons: [...(e.reasons instanceof Map ? e.reasons.values() : e.reasons || [])]
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine));
  const total = engines.reduce((s, e) => s + e.attempted, 0);
  const failed = engines.reduce((s, e) => s + e.failed, 0);
  const failedEngines = engines.filter((e) => e.allFailed).map((e) => e.label);
  const partial = failedEngines.length > 0 || (total > 0 && failed / total > PARTIAL_FAILURE_SHARE);
  const summary = engines
    .filter((e) => e.failed > 0)
    .map((e) => `${e.label}: ${e.failed} of ${e.attempted} failed (${e.reasons.map((r) => r.text).join('; ')}).`)
    .join(' ');
  return {
    total, failed, partial, engines, failedEngines, summary: summary || null,
  };
}

// Older runs stored only the raw reasons, without the model, so the model is
// read back off the reason's own wording where it says.
function engineOfReason(reason) {
  const r = String(reason || '').toLowerCase();
  if (/anthropic|claude|x-api-key/.test(r)) return 'anthropic';
  if (/gemini|google/.test(r)) return 'google';
  if (/openai|chatgpt|gpt-/.test(r)) return 'openai';
  return null;
}

/**
 * A run's health from its stored payload: the one run.js wrote, or — for runs
 * from before it did — reconstructed from the coverage block every run has.
 *
 * @returns {object|null} null when the payload says nothing about coverage
 */
function healthFromPayload(payload) {
  if (!payload) return null;
  if (payload.health) return payload.health;
  const cov = payload.coverage;
  if (!cov || !Number.isFinite(Number(cov.total))) return null;

  const surfaces = (payload.surfaces || []).map((id) => String(id).split(':')[0]);
  const perEngine = surfaces.length ? Math.round(Number(cov.total) / surfaces.length) : 0;
  const byEngine = new Map(surfaces.map((engine) => [engine, {
    engine, label: modelName(engine), attempted: perEngine, failed: 0, reasons: new Map(),
  }]));
  let unattributed = 0;
  for (const { reason, count } of cov.failureReasons || []) {
    const engine = engineOfReason(reason);
    const e = engine && byEngine.get(engine);
    if (!e) { unattributed += Number(count) || 0; continue; }
    e.failed = Math.min(e.attempted || Infinity, e.failed + (Number(count) || 0));
    const n = normaliseFailure(reason);
    const r = e.reasons.get(n.code) || { ...n, count: 0 };
    r.count += Number(count) || 0;
    e.reasons.set(n.code, r);
  }
  const out = finish([...byEngine.values()]);
  // Failures we could not pin on a model still count towards the run's own
  // total, so a run that lost a third of its answers still reads as partial.
  const failed = Number(cov.failed) || (out.failed + unattributed);
  const total = Number(cov.total) || out.total;
  return {
    ...out,
    total,
    failed,
    partial: out.partial || (total > 0 && failed / total > PARTIAL_FAILURE_SHARE),
    summary: out.summary || (failed ? `${failed} of ${total} answers failed.` : null),
  };
}

/**
 * A run's health, from the best evidence there is: the health run.js stored;
 * else the run's own capture rows, which carry the engine of every failure
 * (a Gemini error that never says 'gemini' is still Gemini's); else, for a run
 * with no captures on file, the stored error text read for model names.
 *
 * @param {object|null} payload  the run's stored payload
 * @param {object[]|null} [rows] the run's captures {engine, surfaceLabel, status, failureReason}
 */
function healthForRun(payload, rows = null) {
  if (payload?.health) return payload.health;
  const own = (rows || []).filter((r) => r && r.engine);
  if (own.length) return healthOfRows(own);
  return healthFromPayload(payload);
}

/**
 * The page's provider list, corrected by what the last run actually saw.
 *
 * `availability()` can only say a key is SET. A key that is set and rejected
 * read as ready, so the page promised three models while every run came back
 * with one. A model that answered nothing on the latest run is reported as not
 * ready, with the reason; `keySet` keeps the configuration fact apart, and the
 * next run still asks it (a fixed key recovers on its own).
 *
 * @param {object[]} surfaces  surfaces.availability()
 * @param {object|null} health healthFromPayload(latest run)
 * @param {string|null} [at]   when that run finished
 */
function surfacesWithHealth(surfaces, health, at = null) {
  const failed = new Map((health?.engines || []).filter((e) => e.allFailed).map((e) => [e.engine, e]));
  const when = at ? ` on the last run (${String(at).slice(0, 10)})` : ' on the last run';
  return (surfaces || []).map((s) => {
    const e = failed.get(s.engine);
    if (!s.ready || !e) return { ...s, keySet: s.ready };
    const why = e.reasons.map((r) => r.text).join('; ') || 'every request failed';
    return {
      ...s,
      keySet: true,
      ready: false,
      lastRunFailed: true,
      reason: `${modelName(s.engine, s.label)} answered none of its ${e.attempted} questions${when}: ${why}. `
        + 'Its figures are missing from that run.',
    };
  });
}

module.exports = {
  normaliseFailure, plainFailure, healthOfRows, healthFromPayload, healthForRun, surfacesWithHealth, modelName,
  PARTIAL_FAILURE_SHARE,
};
