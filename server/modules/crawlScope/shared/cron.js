// Cron helpers. Projects use a standard 5-field cron evaluated in the project's own
// IANA timezone, so a weekly "Sunday 22:00 US Central" stays at 22:00 local across the
// CST/CDT boundary. Verified against croner 8.1.2: `0 22 * * 0` in America/Chicago
// fires at 04:00Z in winter and 03:00Z in summer — both 22:00 local.

const { Cron } = require("croner");

const DEFAULT_TIMEZONE = process.env.SCHEDULE_DEFAULT_TIMEZONE || "America/Chicago";

// Bounds the catch-up walk in advance(). 64 hops covers over a year of missed weekly
// fires; it only matters for pathological sub-hourly expressions this app never creates.
const MAX_CATCHUP_HOPS = Number(process.env.SCHEDULE_MAX_CATCHUP_HOPS) || 64;

// croner accepts an unknown timezone at CONSTRUCTION and only throws later, inside
// nextRun(). So constructing in a try/catch — the shape this module used to have —
// silently accepts a bogus zone, which then fails during the worker tick and leaves
// next_run_at NULL, i.e. a project that never fires and reports no error anywhere.
function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function compile(expr, timezone = DEFAULT_TIMEZONE) {
  if (typeof expr !== "string" || !expr.trim()) return null;
  const zone = timezone || DEFAULT_TIMEZONE;
  if (!isValidTimezone(zone)) return null;
  try {
    return new Cron(expr, { timezone: zone });
  } catch {
    return null;
  }
}

// Valid means: the zone resolves, the expression parses, AND it actually fires at
// least once. An expression like "0 0 30 2 *" (Feb 30th) parses cleanly and returns
// null forever — accepting it would create a permanently dormant project.
function isValidCron(expr, timezone = DEFAULT_TIMEZONE) {
  const job = compile(expr, timezone);
  if (!job) return false;
  try {
    return Boolean(job.nextRun());
  } catch {
    return false;
  }
}

// Next fire time strictly after `from`, or null if the expression never fires again.
// `timezone` is the third parameter so existing two-argument callers keep working.
function nextRun(expr, from = new Date(), timezone = DEFAULT_TIMEZONE) {
  const job = compile(expr, timezone);
  if (!job) return null;
  try {
    return job.nextRun(from) || null;
  } catch {
    return null;
  }
}

// Advance a schedule past the occurrence it just fired.
//
// Anchors on the INTENDED fire time (`from` = the project's old next_run_at) rather than
// on wall-clock now. For a cron expression a late tick gets the same answer either way,
// because cron re-snaps to its own pattern — there is no week-over-week creep. What this
// guards is the opposite case: a tick arriving at, or a moment before, the slot instant
// (clock skew between app and database, or landing exactly on the boundary). Anchored on
// `now`, nextRun would hand back the slot itself and the same fire would be enqueued
// twice. Anchored on the slot, the result is always strictly forward.
//
// Then skips forward until strictly after `now`. Skipping rather than firing once per
// missed occurrence is deliberate: a worker down for a month must enqueue ONE crawl and
// send ONE email, not four. croner's nextRun() is strictly-after, so the walk is
// monotonic and cannot spin.
//
// On exhausting maxHops we jump straight past `now`, losing cron phase. That is
// unreachable for the weekly expressions this app creates and is preferable to an
// unbounded loop.
function advance(expr, timezone, from, now = new Date(), maxHops = MAX_CATCHUP_HOPS) {
  const job = compile(expr, timezone);
  if (!job) return null;

  const parsed = from ? new Date(from) : null;
  const anchor = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;

  try {
    let next = job.nextRun(anchor);
    let hops = 0;
    while (next && next <= now && hops < maxHops) {
      next = job.nextRun(next);
      hops += 1;
    }
    if (next && next <= now) next = job.nextRun(now);
    return next || null;
  } catch {
    return null;
  }
}

// Build a weekly expression from the UI's day/hour pickers. `minute` is supplied by
// the caller so projects can be staggered across the hour instead of all firing on
// :00 (see staggerMinute in src/shared/schedule.js).
function weeklyCron({ dayOfWeek, hour, minute = 0 }) {
  const day = Number(dayOfWeek);
  const hours = Number(hour);
  const minutes = Number(minute);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  return `${minutes} ${hours} * * ${day}`;
}

// Inverse of weeklyCron, for rendering a saved project back into the pickers.
// Returns null for any expression that is not a simple weekly one.
function parseWeeklyCron(expr) {
  if (typeof expr !== "string") return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || !/^\d$/.test(dow)) return null;
  return { minute: Number(minute), hour: Number(hour), dayOfWeek: Number(dow) };
}

module.exports = {
  isValidCron,
  isValidTimezone,
  nextRun,
  advance,
  weeklyCron,
  parseWeeklyCron,
  DEFAULT_TIMEZONE,
  MAX_CATCHUP_HOPS,
};
