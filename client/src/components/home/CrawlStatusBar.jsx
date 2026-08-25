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
 * at 60% and the crawl finishes. That is why the label says "of up to" and
 * prints the discovered count next to it — the bar is progress against the
 * limit, and it does not pretend to know the total.
 *
 * ── On the four states ──────────────────────────────────────────────────────
 * queued/pending, running, paused and stalled look different on purpose. A
 * stalled crawl used to be indistinguishable from a slow one, which is the
 * failure mode that wastes the most time: people wait on a process that died.
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
}`;

/** Counts line. Each part is dropped rather than zeroed when unmeasured. */
function countsLine({ crawled, discovered, ceiling }) {
  const parts = [];
  if (crawled !== null && crawled !== undefined) {
    parts.push(ceiling ? `${crawled} of up to ${ceiling}` : `${crawled} crawled`);
  }
  if (discovered !== null && discovered !== undefined) {
    parts.push(`${discovered} discovered`);
  }
  return parts.join(' · ');
}

export function CrawlStatusBar({ status, onWatch }) {
  if (!status) return null;

  const tone = TONE[status.state] || TONE.alive;
  // Null checks come before the finiteness check, every time: Number(null) is 0
  // and Number.isFinite(0) is true, so the other order silently draws an empty
  // bar for a crawl that has simply not reported yet.
  const hasPercent = status.percent !== null && status.percent !== undefined;
  const counts = countsLine(status);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        border: `1px solid color-mix(in srgb, ${tone.color} 32%, var(--border))`,
        background: `color-mix(in srgb, ${tone.color} 7%, var(--card))`,
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
          marginTop: 5,
          flexShrink: 0,
          animation: status.state === 'alive' ? 'crawlPulse 1.6s ease-in-out infinite' : 'none',
        }}
      />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
            {status.headline}
          </span>
          {counts && (
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {counts}
            </span>
          )}
        </div>

        {/* Track. A queued crawl gets a moving sliver rather than a 0% fill:
            zero would claim it started and got nowhere. */}
        <div
          role="progressbar"
          aria-valuenow={hasPercent ? status.percent : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={status.headline}
          style={{
            position: 'relative',
            height: 5,
            borderRadius: 999,
            background: 'color-mix(in srgb, var(--text-3) 18%, transparent)',
            overflow: 'hidden',
          }}
        >
          {hasPercent ? (
            <div
              style={{
                width: `${status.percent}%`,
                height: '100%',
                borderRadius: 999,
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
                borderRadius: 999,
                background: tone.color,
                opacity: 0.65,
                animation: status.state === 'stalled'
                  ? 'none'
                  : 'crawlIndeterminate 1.9s ease-in-out infinite',
              }}
            />
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.45 }}>
            {status.detail}
          </span>
          {onWatch && status.runId && (
            <button
              type="button"
              onClick={() => onWatch(status.runId)}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--text-2)',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Watch the crawl
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CrawlStatusBar;
