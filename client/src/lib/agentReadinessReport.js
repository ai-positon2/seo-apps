// ── Agent Readiness: rules the report page runs on ──────────────────────────
//
// Plain ES module code, no JSX, so client/src/lib/__tests__ can load it.

// ── Share links ─────────────────────────────────────────────────────────────
//
// "Share summary" did btoa(JSON.stringify(payload)). btoa only takes Latin-1,
// and every level label has an em dash ("Level 0 — Not started") and the
// model's prose has curly quotes, so it threw on every report and nothing was
// copied. The payload is UTF-8 encoded first and written as base64url, which
// also needs no escaping in a query string.

/** Any JSON value as a URL-safe string. */
export function encodeSharePayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The value back, or null for anything that is not a link we made.
 *
 * Accepts plain base64 too, so an ASCII-only link copied before the change
 * (the only kind the old encoder could produce) still opens. A '+' in such a
 * link arrives from the query string as a space.
 */
export function decodeSharePayload(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    let b64 = text.trim().replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * True when a decoded payload can be drawn. An incomplete link used to get as
 * far as `brief.headline` and take the whole app down with it.
 */
export function isShareableSummary(data) {
  if (!data || typeof data !== 'object') return false;
  const { brief } = data;
  if (!brief || typeof brief !== 'object') return false;
  const hasText = ['headline', 'summary', 'risk', 'opportunity', 'competitive']
    .some((k) => typeof brief[k] === 'string' && brief[k].trim());
  return hasText && typeof data.url === 'string' && Boolean(data.url);
}

// The checks reconcileStoredReport can mark as scored with older rules.
const OLDER_RULE_IDS = ['aibots', 'webmcp'];

/**
 * Which checks a share link says were scored with older rules.
 *
 * Links now carry the list (['webmcp'], ['aibots', 'webmcp']). Links copied
 * before that carry `olderRules: true`, which was set for either check, so it
 * reads as ['unknown']: the notice then names neither rule.
 */
export function sharedOlderRules(data) {
  const value = data?.olderRules;
  if (value === true) return ['unknown'];
  if (!Array.isArray(value)) return [];
  return OLDER_RULE_IDS.filter((id) => value.includes(id));
}

/**
 * What a share link carries: the summary, plus where the full report lives.
 * `olderRules` is the list of re-read checks (result.olderRules); a boolean
 * true is still accepted and kept as the old flag.
 */
export function sharePayload(result, { projectId = null, pageRunId = null, olderRules = null } = {}) {
  const older = Array.isArray(olderRules)
    ? OLDER_RULE_IDS.filter((id) => olderRules.includes(id))
    : (olderRules === true ? true : null);
  return {
    brief: result.cmoBrief,
    url: result.site.url,
    full: result.site.full,
    score: result.site.score,
    level: result.site.level,
    date: result.site.date,
    ...(projectId ? { projectId } : {}),
    ...(pageRunId ? { pageRunId } : {}),
    ...((older === true || older?.length) ? { olderRules: older } : {}),
  };
}

// ── Reports scored with older rules ─────────────────────────────────────────
//
// Two checks changed rules after reports were stored:
//
//   aibots  failed any robots.txt that did not NAME an AI crawler, so a site
//           letting every crawler in scored 0 for Bot Access and was called
//           "blocking AI agents" (LogicGate, Beta Bionics).
//   webmcp  could not pass at all: "not detectable via HTTP".
//
// A stored report keeps robots.txt's verdict but not its text, so the old aibots
// failure cannot be re-decided: nothing says whether `User-agent: *` shut the
// site. What CAN be read from the stored strings is applied; the rest is shown
// as not re-checked, never as a failure or a block, and the page says to re-run.

export const OLD_AIBOTS_FAIL = 'No AI-specific bot rules found in robots.txt';
const INTERIM_AIBOTS_FAIL = /^No AI-specific bot rules found in robots\.txt, and the general rules do not let every crawler in/;
const OLD_WEBMCP = /not detectable via HTTP/i;
export const BLOCKS_AI = /^robots\.txt blocks AI crawlers/i;

// Weights of the checks re-read here (server/routes/agentReadinessAudit.js).
const RECHECK_WEIGHTS = { aibots: 11, webmcp: 6 };

/** True when a check records a real refusal of AI crawlers. */
export function isBlockingCheck(check) {
  return Boolean(check) && check.status !== 'pass'
    && (check.blocking === true || BLOCKS_AI.test(String(check.tech || '')));
}

/**
 * A stored report brought up to the current rules as far as its data allows.
 *
 * Returns the report unchanged (same object) when nothing needed it, so a fresh
 * audit is never touched. Otherwise a copy, with `olderRules` listing what was
 * not re-checked and `olderRulesPoints` how many points those could be worth.
 */
export function reconcileStoredReport(result) {
  if (!result || !Array.isArray(result.checks) || !result.checks.length) return result;
  const robotsPassed = result.checks.some((c) => c.id === 'robots' && c.status === 'pass');
  const olderRules = [];
  let changed = false;

  const checks = result.checks.map((c) => {
    const tech = String(c.tech || '');
    if (c.id === 'aibots' && c.status === 'fail' && INTERIM_AIBOTS_FAIL.test(tech)) {
      // The interim rule failed only when robots.txt was readable and
      // `User-agent: *` disallowed the whole site — a real block — or when
      // robots.txt could not be read, which is not one.
      changed = true;
      return robotsPassed
        ? { ...c, blocking: true, tech: 'robots.txt blocks AI crawlers: every crawler is refused by "User-agent: *" with "Disallow: /"' }
        : { ...c, tech: 'robots.txt could not be read, so it states no rules for AI crawlers' };
    }
    if (c.id === 'aibots' && c.status === 'fail' && tech.trim() === OLD_AIBOTS_FAIL) {
      changed = true;
      olderRules.push('aibots');
      return {
        ...c,
        status: 'info',
        olderRule: true,
        tech: 'Not re-checked. This report was scored with an older rule that failed any robots.txt not naming AI crawlers, even one letting every crawler in. Re-run the audit to check whether robots.txt lets AI crawlers in.',
      };
    }
    if (c.id === 'webmcp' && c.status === 'fail' && OLD_WEBMCP.test(tech)) {
      changed = true;
      olderRules.push('webmcp');
      return {
        ...c,
        status: 'info',
        olderRule: true,
        tech: 'Not measured. This report was scored when WebMCP could not be detected at all, so it failed on every site. Re-run the audit to check the page for a WebMCP registration.',
      };
    }
    return c;
  });

  if (!changed) return result;
  const totalMax = 100 + (result.site?.onPageMax || 0);
  const points = olderRules.reduce((s, id) => s + (RECHECK_WEIGHTS[id] || 0), 0);
  return {
    ...result,
    checks,
    olderRules,
    olderRulesPoints: points ? Math.round((points / totalMax) * 100) : 0,
  };
}

// ── The "at a glance" groups ────────────────────────────────────────────────
//
// "Blocking AI agents" was every category under 45, so a Bot Access of 0 —
// nothing more than a missing Content-Signal line — was announced as a block.
// It now holds only categories with a check that records a real refusal; other
// weak categories are "not yet set up".

/**
 * @param cats   [{ id, score }]
 * @param checks the report's checks (each with `cat`)
 * @param tone   score -> 'success' | 'warning' | 'danger'
 */
export function glanceGroups(cats = [], checks = [], tone) {
  const blockedCats = new Set(checks.filter(isBlockingCheck).map((c) => c.cat));
  const groups = { working: [], middle: [], notSetUp: [], blocking: [] };
  for (const cat of cats) {
    if (blockedCats.has(cat.id)) groups.blocking.push(cat);
    else if (tone(cat.score) === 'success') groups.working.push(cat);
    else if (tone(cat.score) === 'warning') groups.middle.push(cat);
    else groups.notSetUp.push(cat);
  }
  return groups;
}
