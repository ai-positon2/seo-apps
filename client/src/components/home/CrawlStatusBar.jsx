/**
 * CrawlStatusBar — the live crawl, at the top of the dashboard.
 *
 * A crawl was already reported, but only inside the Tech Audit card: the answer
 * to "is anything happening right now" sat three cards down, in the same visual
 * weight as five things that were not happening. A crawl is the one event that
 * changes what every other card will say next, so it gets a line of its own,
 * above everything it is about to change.
 *
 * Renders nothing when no crawl is in flight. That is the common case, and a
 * dashboard that keeps a dead progress bar around teaches people to ignore it.
 *
 * ── On the bar's denominator ────────────────────────────────────────────────
 * The fill is crawled/ceiling, never crawled/discovered. `discovered` grows as
 * the crawl finds links, so a bar drawn against it moves BACKWARDS every time a
 * page turns up new ones — which reads as the crawl losing ground. The ceiling
 * is fixed for the whole run, so the fill only ever advances.
 *
 * The cost is that it undershoots on a site smaller than the cap: the bar stops
 * at 60% and the crawl finishes. That is why the sentence says "of up to" until
 * the crawl has found at least as many pages as the cap — only then is the cap
 * the real total, and only then is a percentage of it printed.
 *
 * The ceiling is the PAGE cap a caller actually asked for — overview.js's
 * crawlStatus reads it from the run's own stored options, not from
 * crawler._progress()'s own maxUrls, which is options.maxUrls +
 * options.maxExternalUrls (the page budget plus the separate external-link
 * check budget). An earlier version of this bar showed that combined number,
 * labelled "URLs" rather than "pages" to avoid implying a page cap that
 * wasn't there — a project asking for 150 pages saw "up to 300 URLs". That
 * still read as confusing (a caller thinks in pages, not "URLs including
 * link-validity checks"), so the ceiling itself was fixed instead: it is now
 * the page cap alone, and external-link checking still happens, just without
 * being represented in this number.
 *
 * ── On the four states ──────────────────────────────────────────────────────
 * queued/pending, running, paused and stalled look different on purpose. A
 * stalled crawl used to be indistinguishable from a slow one, which is the
 * failure mode that wastes the most time: people wait on a process that died.
 *
 * ── On the wording ──────────────────────────────────────────────────────────
 * One slim row, one plain sentence: "Scanning nice.com: 8,619 of 10,000 pages
 * checked (86%)". It used to be ~120px on every screen — a headline, a
 * monospace counts line, the bar, then "Findings appear as soon as the crawl
 * reaches a terminal state" — which is a lot of an executive's screen spent on
 * engineering vocabulary. The sentence is built here from the status fields
 * rather than shown as the server's `headline`/`detail`, because those are
 * written for operators; the server's text is left alone so nothing else that
 * reads it changes. The secondary sentence shows on wide screens only, and is
 * the row's tooltip everywhere.
 *
 * @param {object}   status    overview.crawlStatus, or null
 * @param {Function} onWatch   opens the crawl's own run page
 */

const TONE = {
  alive: { color: 'var(--primary)', label: 'Running' },
  pending: { color: 'var(--text-3)', label: 'Queued' },
  paused: { color: 'var(--viz-warn)', label: 'Paused' },
  stalled: { color: 'var(--viz-neg)', label: 'Stopped' },
};

const KEYFRAMES = `
@keyframes crawlPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.35; transform: scale(0.82); }
}
@keyframes crawlIndeterminate {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}
/* The secondary sentence is for wide screens only. Below this the row already
   wraps, and a third line is exactly the height the bar was slimmed to lose;
   the sentence stays available as the row's tooltip. */
@media (max-width: 1099px) {
  .crawl-bar-note { display: none; }
}`;

const has = (v) => v !== null && v !== undefined;
// Grouped digits ("8,619"), in the reader's own locale.
const fmt = (n) => Number(n).toLocaleString();
const plural = (n, one, many) => (n === 1 ? one : many);

/** "nice.com" from the crawl's start URL, or null if there is none. */
function siteName(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    // A bare host with no scheme is not a valid URL, but is still a name.
    return String(url).replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./, '') || null;
  }
}

/**
 * "8,619 of 10,000 pages checked (86%)". The cap is the real total only once
 * the crawl has found at least that many pages; until then the site may be
 * smaller and the crawl will finish short of it, so the cap is a limit ("of up
 * to") and a percentage of it would undersell the progress. See the header
 * note on the bar's denominator. Null when nothing has been measured yet.
 */
function progressPhrase({ crawled, discovered, ceiling, percent }) {
  if (!has(crawled)) return null;
  if (!ceiling) return `${fmt(crawled)} ${plural(crawled, 'page', 'pages')} checked`;
  const capIsTotal = has(discovered) && discovered >= ceiling;
  return capIsTotal
    ? `${fmt(crawled)} of ${fmt(ceiling)} pages checked${has(percent) ? ` (${percent}%)` : ''}`
    : `${fmt(crawled)} of up to ${fmt(ceiling)} pages checked`;
}

/**
 * Which of the six situations this is. The server sends `state` (pending,
 * alive, paused, stalled) but not the wind-down phase, only the headline it
 * built from it ("Crawl stopping · …", "Crawl finished · analysing …"), so
 * those two are recognised from that sentence, in the server's own order of
 * precedence. Should its wording change, they fall through to the running or
 * paused wording, which still reads true.
 */
function phaseOf(status) {
  if (status.state === 'pending' || status.state === 'stalled') return status.state;
  const headline = String(status.headline || '');
  if (/stopping/i.test(headline)) return 'stopping';
  if (/finished|analys/i.test(headline)) return 'analysing';
  return status.state === 'paused' ? 'paused' : 'alive';
}

/** { lead, rest, note }: the bold opening, what follows it, the quiet aside. */
function wording(status) {
  const site = siteName(status.url);
  const of = site ? ` of ${site}` : '';
  const { crawled, followers } = status;
  const progress = progressPhrase(status);

  switch (phaseOf(status)) {
    case 'pending':
      return { lead: `Scan${of} queued`, note: 'Waiting for a free slot to start. Nothing is wrong.' };
    case 'stalled': {
      const m = status.silentMinutes;
      const silent = has(m) ? `${m} ${plural(m, 'minute', 'minutes')}` : 'a few minutes';
      return {
        lead: `Scan${of} stopped responding`,
        // The stale sweep reclaims the run and retries it from its checkpoint.
        note: `No update for ${silent}. It restarts automatically within ten minutes, or you can start it again now.`,
      };
    }
    case 'stopping':
      return {
        lead: `Stopping the scan${of}`,
        rest: progress,
        note: 'No new pages are being checked. Results are being prepared from the pages already checked.',
      };
    case 'analysing':
      return {
        lead: `Scan${of} finished`,
        rest: has(crawled)
          ? `preparing results for ${fmt(crawled)} ${plural(crawled, 'page', 'pages')}`
          : 'preparing results',
        note: 'Every page has been checked. Results are being prepared.',
      };
    case 'paused':
      return { lead: `Scan${of} paused`, rest: progress, note: 'Nothing is being checked until it is resumed.' };
    default:
      if (!crawled) {
        return { lead: `Starting the scan${of}`, note: 'Results appear when the scan finishes.' };
      }
      return {
        lead: site ? `Scanning ${site}` : 'Scanning the site',
        rest: progress,
        // Page audits that follow the crawl score pages before it finishes, so
        // "when the scan finishes" would be untrue for this case.
        note: followers
          ? `${fmt(followers)} page ${plural(followers, 'audit is', 'audits are')} scoring pages as the scan finds them.`
          : 'Results appear when the scan finishes.',
      };
  }
}

export function CrawlStatusBar({ status, onWatch }) {
  if (!status) return null;

  const tone = TONE[status.state] || TONE.alive;
  // Null checks come before the finiteness check, every time: Number(null) is 0
  // and Number.isFinite(0) is true, so the other order silently draws an empty
  // bar for a crawl that has simply not reported yet.
  const hasPercent = status.percent !== null && status.percent !== undefined;
  const { lead, rest, note } = wording(status);
  const sentence = rest ? `${lead}: ${rest}` : lead;

  return (
    <div
      title={note}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: 12,
        rowGap: 6,
        minHeight: 44,
        boxSizing: 'border-box',
        // Bottom padding leaves room for the 3px track drawn along the edge.
        padding: '7px 12px 9px',
        borderRadius: 'var(--r-md)',
        border: `1px solid color-mix(in srgb, ${tone.color} 32%, var(--border))`,
        background: `color-mix(in srgb, ${tone.color} 7%, var(--card))`,
        overflow: 'hidden',
      }}
    >
      <style>{KEYFRAMES}</style>

      {/* Status light. Pulses only while genuinely fetching — a steady dot on a
          stalled crawl would be the same lie the card used to tell. */}
      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: tone.color,
          flexShrink: 0,
          animation: status.state === 'alive' ? 'crawlPulse 1.6s ease-in-out infinite' : 'none',
        }}
      />

      {/* The sentence. Body font with tabular figures, so the count does not
          jitter sideways as it ticks up; it wraps (and breaks a long host name)
          rather than pushing the row wider than a phone. */}
      <p style={{
        flex: '1 1 220px',
        minWidth: 0,
        margin: 0,
        fontSize: 13.5,
        lineHeight: 1.4,
        color: 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
        overflowWrap: 'anywhere',
      }}>
        <span style={{ fontWeight: 600 }}>{lead}</span>
        {rest && <>: {rest}</>}
        {note && (
          <span className="crawl-bar-note" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {' · '}{note}
          </span>
        )}
      </p>

      {onWatch && status.runId && (
        <button
          type="button"
          onClick={() => onWatch(status.runId)}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-2)',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          Watch the crawl
        </button>
      )}

      {/* Track, a thin line along the bottom edge. A queued crawl gets a moving
          sliver rather than a 0% fill: zero would claim it started and got
          nowhere. */}
      <div
        role="progressbar"
        aria-valuenow={hasPercent ? status.percent : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={sentence}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 3,
          background: 'color-mix(in srgb, var(--text-3) 18%, transparent)',
          overflow: 'hidden',
        }}
      >
        {hasPercent ? (
          <div
            style={{
              width: `${status.percent}%`,
              height: '100%',
              background: tone.color,
              transition: 'width 600ms ease',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              insetBlock: 0,
              width: '30%',
              background: tone.color,
              opacity: 0.65,
              animation: status.state === 'stalled'
                ? 'none'
                : 'crawlIndeterminate 1.9s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}

export default CrawlStatusBar;
