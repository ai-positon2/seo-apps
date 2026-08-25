// Schedule presentation + fire-time spreading, shared by the API and the browser UI.

const { parseWeeklyCron } = require("./cron");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Common zones offered in the UI. Anything else is still accepted by the API as long
// as Intl resolves it.
const TIMEZONE_CHOICES = [
  { value: "America/Chicago", label: "US Central (CT)" },
  { value: "America/New_York", label: "US Eastern (ET)" },
  { value: "America/Denver", label: "US Mountain (MT)" },
  { value: "America/Los_Angeles", label: "US Pacific (PT)" },
  { value: "Europe/London", label: "UK (GMT/BST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "UTC", label: "UTC" },
];

// Spread projects across the hour instead of firing every one on :00.
//
// This is the cheapest and largest efficiency win in the scheduling design: without
// it, every project that wants "Sunday 10 PM Central" lands on the same minute and
// the worker chews through them serially while the client waits. With it, ten
// projects fire roughly six minutes apart and the herd never forms.
//
// Deterministic (FNV-1a over a per-project seed) rather than random so a project keeps
// the same minute across edits, and so tests are reproducible.
function staggerMinute(seed) {
  const text = String(seed || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // >>> 0 keeps this in unsigned 32-bit space; Math.imul avoids float precision loss.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 60;
}

function formatHour(hour) {
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 0 || value > 23) return "";
  const suffix = value < 12 ? "AM" : "PM";
  const display = value % 12 === 0 ? 12 : value % 12;
  return `${display}:00 ${suffix}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function timezoneLabel(timezone) {
  return TIMEZONE_CHOICES.find((choice) => choice.value === timezone)?.label || timezone;
}

// Human-readable recurrence, e.g. "Sundays at 10:37 PM US Central (CT)". Falls back to
// showing the raw cron for any expression the weekly parser does not recognize, so a
// hand-set cron is still legible rather than rendering as blank.
function describeSchedule({ cron, timezone } = {}) {
  const weekly = parseWeeklyCron(cron);
  if (!weekly) return cron ? `cron ${cron} (${timezone || "UTC"})` : "Not scheduled";
  const hour12 = weekly.hour % 12 === 0 ? 12 : weekly.hour % 12;
  const suffix = weekly.hour < 12 ? "AM" : "PM";
  return `${DAY_NAMES[weekly.dayOfWeek]}s at ${hour12}:${pad(weekly.minute)} ${suffix} ${timezoneLabel(timezone)}`;
}

// Render an instant in the project's own timezone, so "next crawl" reads in the same
// frame of reference the user configured rather than in the viewer's local time.
function formatInTimezone(instant, timezone) {
  if (!instant) return "—";
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

module.exports = {
  DAY_NAMES,
  TIMEZONE_CHOICES,
  staggerMinute,
  formatHour,
  timezoneLabel,
  describeSchedule,
  formatInTimezone,
};
