// Cron/timezone tests. The behaviour that matters for scheduled weekly crawls is:
// a fire stays pinned to its local wall-clock time across DST, and advancing the
// schedule never drifts later or fires a backlog of missed occurrences.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidCron,
  isValidTimezone,
  nextRun,
  advance,
  weeklyCron,
  parseWeeklyCron,
} = require("../shared/cron");

const SUNDAY_10PM = "0 22 * * 0";
const CENTRAL = "America/Chicago";

function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

test("advance moves strictly past the scheduled slot", () => {
  const slot = "2026-08-10T03:00:00.000Z"; // Sun Aug 9, 10:00 PM CDT
  const now = new Date("2026-08-10T03:01:30.000Z");
  const next = advance(SUNDAY_10PM, CENTRAL, slot, now);

  assert.equal(next.toISOString(), "2026-08-17T03:00:00.000Z");
  assert.ok(next > new Date(slot));
});

test("advance never re-fires the slot when the tick arrives a moment early", () => {
  // The discriminating case for anchoring on the slot rather than on `now`.
  //
  // A cron expression re-snaps to its own pattern, so a LATE tick computes the same next
  // fire either way — there is no week-over-week creep to correct. The case that does
  // differ is a tick evaluated just BEFORE the slot instant, which happens with clock
  // skew between the app and the database. Anchored on `now`, the "next" fire is the slot
  // itself, so the fire gets enqueued a second time. Anchored on the slot, it is always
  // the following occurrence.
  const slot = "2026-08-10T03:00:00.000Z";
  const now = new Date("2026-08-10T02:59:58.000Z");

  assert.equal(
    nextRun(SUNDAY_10PM, now, CENTRAL).toISOString(),
    slot,
    "anchoring on now hands back the slot that is about to be fired",
  );
  assert.equal(
    advance(SUNDAY_10PM, CENTRAL, slot, now).toISOString(),
    "2026-08-17T03:00:00.000Z",
    "anchoring on the slot always moves forward",
  );
});

test("a weekly Central fire stays at 22:00 local across both DST boundaries", () => {
  let cursor = new Date("2026-01-04T00:00:00.000Z");
  const utcHours = new Set();

  for (let index = 0; index < 60; index += 1) {
    cursor = advance(SUNDAY_10PM, CENTRAL, cursor, new Date(cursor.getTime() - 1));
    assert.ok(cursor, "expression must keep firing");
    const local = partsIn(cursor, CENTRAL);
    assert.equal(local.weekday, "Sun", `fire ${index} should land on Sunday`);
    assert.equal(local.hour, "22", `fire ${index} should be 22:00 local`);
    assert.equal(local.minute, "00");
    utcHours.add(cursor.getUTCHours());
  }

  // Staying at 22:00 local across a year necessarily means the UTC hour moves:
  // 04:00Z under CST and 03:00Z under CDT. Seeing both proves DST is handled
  // rather than a fixed offset being applied.
  assert.deepEqual([...utcHours].sort(), [3, 4]);
});

test("a worker that was down for weeks fires once, not once per missed week", () => {
  // Five weeks stale. A catch-up loop that emitted every missed occurrence would
  // send five audit emails at once; the contract is exactly one.
  const slot = "2026-01-05T04:00:00.000Z"; // Sun Jan 4, 10:00 PM CST
  const now = new Date("2026-02-09T15:00:00.000Z");
  const next = advance(SUNDAY_10PM, CENTRAL, slot, now);

  assert.ok(next > now, "next fire must be in the future");
  assert.equal(next.toISOString(), "2026-02-16T04:00:00.000Z");
  const local = partsIn(next, CENTRAL);
  assert.equal(local.weekday, "Sun");
  assert.equal(local.hour, "22");
});

test("advance terminates on a stale per-minute cron instead of walking every minute", () => {
  const startedAt = Date.now();
  const next = advance(
    "* * * * *",
    "UTC",
    "2025-01-01T00:00:00.000Z",
    new Date("2026-01-01T00:00:00.000Z"),
    5,
  );
  assert.ok(next > new Date("2026-01-01T00:00:00.000Z"));
  assert.ok(Date.now() - startedAt < 500, "must not walk a year of minutes");
});

test("advance falls back to now when the project has no stored slot", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const next = advance(SUNDAY_10PM, CENTRAL, null, now);
  assert.ok(next > now);
  assert.equal(partsIn(next, CENTRAL).hour, "22");
});

test("nextRun returns the following occurrence when handed an exact fire instant", () => {
  // tickSchedules relies on this: passing the slot back in must not return the slot,
  // or a schedule would re-fire itself forever.
  const fire = new Date("2026-08-17T03:00:00.000Z");
  const next = nextRun(SUNDAY_10PM, fire, CENTRAL);
  assert.equal(next.toISOString(), "2026-08-24T03:00:00.000Z");
});

test("isValidCron rejects an unknown timezone", () => {
  // croner accepts a bogus zone at construction and only throws inside nextRun(), so
  // validating by construction alone would let this through and produce a project that
  // silently never fires.
  assert.equal(isValidCron(SUNDAY_10PM, "Mars/Olympus"), false);
  assert.equal(isValidCron(SUNDAY_10PM, CENTRAL), true);
});

test("isValidCron rejects an expression that parses but never fires", () => {
  assert.equal(isValidCron("0 0 30 2 *", "UTC"), false);
  assert.equal(nextRun("0 0 30 2 *", new Date(), "UTC"), null);
});

test("isValidCron rejects empty and non-string input", () => {
  for (const bad of ["", "   ", null, undefined, 5, {}]) {
    assert.equal(isValidCron(bad, CENTRAL), false, `${JSON.stringify(bad)} must be invalid`);
  }
});

test("isValidTimezone accepts IANA names and rejects nonsense", () => {
  assert.equal(isValidTimezone(CENTRAL), true);
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Mars/Olympus"), false);
  assert.equal(isValidTimezone(""), false);
  assert.equal(isValidTimezone(null), false);
});

test("weeklyCron builds a valid expression and rejects out-of-range input", () => {
  assert.equal(weeklyCron({ dayOfWeek: 0, hour: 22, minute: 37 }), "37 22 * * 0");
  assert.equal(weeklyCron({ dayOfWeek: 6, hour: 0, minute: 0 }), "0 0 * * 6");
  assert.equal(weeklyCron({ dayOfWeek: 7, hour: 22 }), null);
  assert.equal(weeklyCron({ dayOfWeek: 0, hour: 24 }), null);
  assert.equal(weeklyCron({ dayOfWeek: 0, hour: 22, minute: 60 }), null);
  assert.equal(weeklyCron({ dayOfWeek: "x", hour: 22 }), null);
});

test("parseWeeklyCron round-trips weeklyCron and declines other shapes", () => {
  assert.deepEqual(parseWeeklyCron("37 22 * * 0"), { minute: 37, hour: 22, dayOfWeek: 0 });
  assert.equal(parseWeeklyCron("*/5 * * * *"), null);
  assert.equal(parseWeeklyCron("0 22 1 * 0"), null);
  assert.equal(parseWeeklyCron("0 22 * * 1-5"), null);
  assert.equal(parseWeeklyCron("nonsense"), null);
});
