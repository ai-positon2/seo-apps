"use strict";

// ── The limits an audit judges pages by ─────────────────────────────────────
//
// Fixed in the code until now. The defaults are those same values; a crawl can
// set its own (and a project, whose saved crawl options carry them), within
// bounds that keep a check meaningful. Semrush, for one, calls a title long
// at 70 characters where these checks said 60.

const THRESHOLDS = {
  titleMinLength: { default: 30, min: 1, max: 200 },
  titleMaxLength: { default: 60, min: 10, max: 300 },
  metaMinLength: { default: 70, min: 1, max: 300 },
  metaMaxLength: { default: 160, min: 50, max: 1_000 },
  // Words of visible text below which a page is thin.
  minWords: { default: 200, min: 1, max: 10_000 },
  // Server response time (time to first byte) above which a page is slow.
  slowResponseMs: { default: 1_000, min: 100, max: 60_000 },
  // Clicks from the start page beyond which a page is deep.
  maxClickDepth: { default: 3, min: 1, max: 50 },
  urlMaxLength: { default: 200, min: 50, max: 2_000 },
  maxLinksPerPage: { default: 3_000, min: 10, max: 100_000 },
};

const DEFAULT_THRESHOLDS = Object.fromEntries(Object.entries(THRESHOLDS).map(([key, spec]) => [key, spec.default]));

// Every threshold: the value asked for, bounded, or the default when it is
// missing, blank or not a number.
function resolveThresholds(raw) {
  const out = {};
  for (const [key, spec] of Object.entries(THRESHOLDS)) {
    const value = raw && typeof raw === "object" ? raw[key] : undefined;
    const number = value === null || value === undefined || value === "" ? Number.NaN : Math.floor(Number(value));
    out[key] = Number.isFinite(number) ? Math.max(spec.min, Math.min(number, spec.max)) : spec.default;
  }
  return out;
}

module.exports = { THRESHOLDS, DEFAULT_THRESHOLDS, resolveThresholds };
