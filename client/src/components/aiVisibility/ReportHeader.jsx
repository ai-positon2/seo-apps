import { Button } from '../../ui';

// ── The report header ───────────────────────────────────────────────────────
//
// Names where you are in the set, states the reporting period, and gives the
// coverage fraction the numbers below rest on.
//
// Coverage sits HERE rather than in a footnote because METRICS.md §3.1 says
// every other metric is unreliable below 90%. A reader who has to scroll to
// find out that a third of the captures failed has already believed the
// headline.

// Period boundaries are UTC CALENDAR DAYS, not instants, so they are rendered
// in UTC deliberately: re-basing them to a viewer's timezone would move which
// captures fall in which period, and §11 requires a past period to reproduce
// the same numbers for everyone. The label says UTC so a reader whose own date
// has already rolled over does not read the end date as "stale".
//
// Individual capture times are the opposite case — they are instants, and they
// render in the reader's zone via promptHelpers' formatWhen.
const fmtDay = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

/** True when the reader's own calendar date differs from the UTC one. */
function offsetFromUtcToday() {
  const now = new Date();
  return now.toISOString().slice(0, 10) !== `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function ReportHeader({
  report, index, total, meta, onPrev, onNext, actions,
}) {
  const period = meta?.period;
  const coverage = meta?.coverage;
  const low = coverage?.value !== null && coverage?.value !== undefined && coverage.value < 0.9;

  return (
    <header style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
      }}
      >
        <div style={{ minWidth: 240 }}>
          {index >= 0 && (
            <div
              className="eyebrow"
              style={{
                fontSize: 9.5,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '.18em',
                color: 'var(--text-3)',
                marginBottom: 5,
              }}
            >
              {`REPORT ${index + 1} OF ${total}`}
            </div>
          )}
          <h2 style={{
            margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em',
          }}
          >
            {report?.label || 'AI Visibility'}
          </h2>

          <div style={{
            display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--text-3)',
          }}
          >
            {period?.from && (
              <span>
                Reporting period{' '}
                <span className="num" style={{ color: 'var(--text-2)' }}>
                  {fmtDay(period.from)} — {fmtDay(period.to)} UTC
                </span>
                {/* Only shown when it would otherwise mislead: if the reader's
                    own date has already rolled over, the end date above looks a
                    day behind and the report reads as stale when it is current. */}
                {offsetFromUtcToday() && (
                  <span title="Periods are bucketed in UTC so past periods reproduce identically for everyone.">
                    {' '}(your date has already rolled over)
                  </span>
                )}
              </span>
            )}
            {meta?.coverageLabel && (
              <span style={{ color: low ? 'var(--warning)' : 'var(--text-3)' }}>
                Coverage{' '}
                <span className="num">{meta.coverageLabel}</span>
              </span>
            )}
            {meta?.rulesetVersion && (
              <span title="The classification ruleset these numbers were produced under.">
                Ruleset <span className="num">{meta.rulesetVersion}</span>
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {actions}
          {(onPrev || onNext) && (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="ghost" size="sm" onClick={onPrev} disabled={!onPrev} aria-label="Previous report">←</Button>
              <Button variant="ghost" size="sm" onClick={onNext} disabled={!onNext} aria-label="Next report">→</Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default ReportHeader;
