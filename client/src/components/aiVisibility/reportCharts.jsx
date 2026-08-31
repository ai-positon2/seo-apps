import { useState } from 'react';

// ── Charts ──────────────────────────────────────────────────────────────────
//
// No chart library. These are inline SVG at `viewBox="0 0 100 100"` with
// `preserveAspectRatio="none"`, so the drawing is in percentage space and the
// element stretches to whatever box it is given. Every stroke carries
// `vectorEffect="non-scaling-stroke"` — without it the non-uniform stretch
// makes a 1px line thick horizontally and hairline vertically.
//
// Gridlines carry NO numeric meaning. They are at fixed thirds purely as a
// reading aid; the axis labels beside the chart are where the values are
// stated. A gridline that looked like 50% but wasn't would be worse than none.

const SERIES_TOKENS = [
  'var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)',
  'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)',
];

/**
 * Split a series into unbroken runs, so a gap stays a gap.
 *
 * A bucket with no captures carries `null`, and the line must BREAK there.
 * Interpolating across it would draw a smooth trend through days nothing ran;
 * plotting it at zero would show visibility collapsing on a day the scheduler
 * simply did not fire. Both are inventions.
 */
function segments(points) {
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (p.value === null || p.value === undefined) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ ...p, i });
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Multi-series line chart.
 *
 * @param {Array} series [{key, label, points:[{value|null}]}]
 * @param {Array} buckets [{from, to}] — same length as every series' points
 * @param {Function} [format] value → label, for the axis and tooltips
 */
export function LineChart({
  series = [], buckets = [], height = 230, format = (v) => `${Math.round(v * 100)}%`,
}) {
  const [hidden, setHidden] = useState(() => new Set());

  const visible = series.filter((s) => !hidden.has(s.key));
  const allValues = visible.flatMap((s) => s.points.map((p) => p.value)).filter((v) => v !== null && v !== undefined);

  // A SHARED maximum across every series — scaling each to its own maximum
  // would make a series that never exceeds 5% look identical to one at 90%.
  const rawMax = allValues.length ? Math.max(...allValues) : 0;
  const max = rawMax > 0 ? rawMax : 1;

  const n = buckets.length;
  const x = (i) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v) => 100 - (v / max) * 96 - 2; // 2% padding top and bottom

  const anyData = allValues.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        {/* Axis. Three labels, because a dense axis on a 230px chart is noise. */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          height,
          paddingBottom: 2,
          fontSize: 10.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-3)',
          textAlign: 'right',
          minWidth: 34,
        }}
        >
          <span>{anyData ? format(max) : ''}</span>
          <span>{anyData ? format(max / 2) : ''}</span>
          <span>{anyData ? format(0) : ''}</span>
        </div>

        <div style={{
          flex: 1,
          height,
          position: 'relative',
          background: 'var(--surface)',
          borderRadius: 'var(--r-md)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
        >
          {!anyData && (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: 'var(--text-3)',
            }}
            >
              Nothing measured in this period.
            </div>
          )}

          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ width: '100%', height: '100%', display: 'block' }}
            role="img"
            aria-label="Visibility over time"
          >
            {[25, 50, 75].map((gy) => (
              <line
                key={gy}
                x1="0"
                x2="100"
                y1={gy}
                y2={gy}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {anyData && visible.map((s, si) => {
              const tone = SERIES_TOKENS[si % SERIES_TOKENS.length];
              return segments(s.points).map((run, ri) => (
                run.length === 1
                  ? (
                    <circle
                      key={`${s.key}-${ri}`}
                      cx={x(run[0].i)}
                      cy={y(run[0].value)}
                      r="1.4"
                      fill={tone}
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                  : (
                    <polyline
                      key={`${s.key}-${ri}`}
                      points={run.map((p) => `${x(p.i)},${y(p.value)}`).join(' ')}
                      fill="none"
                      stroke={tone}
                      strokeWidth={s.key === 'all' ? 2.5 : 1.5}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )
              ));
            })}
          </svg>
        </div>
      </div>

      {/* Dates under the plot, aligned to the axis gutter above. */}
      {buckets.length > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginLeft: 46,
          marginTop: 6,
          fontSize: 10.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-3)',
        }}
        >
          <span>{buckets[0].from}</span>
          <span>{buckets[buckets.length - 1].to}</span>
        </div>
      )}

      {/* Legend doubles as a series toggle. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        {series.map((s, si) => {
          const off = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(s.key)) next.delete(s.key); else next.add(s.key);
                return next;
              })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 8px',
                fontSize: 11.5,
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-pill)',
                cursor: 'pointer',
                color: off ? 'var(--text-3)' : 'var(--text-2)',
                opacity: off ? 0.5 : 1,
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: SERIES_TOKENS[si % SERIES_TOKENS.length],
                display: 'inline-block',
              }}
              />
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Heatmap — brands down, attributes across (§7.2).
 *
 * Intensity is `value / columnMax`, per COLUMN, because §7.2 scales each
 * attribute independently: a column where every brand scores low is still
 * meaningful about which brand leads it.
 *
 * The ink flips at t > 0.65 so a label never sits dark-on-dark at the top of
 * the ramp.
 */
export function Heatmap({ rows = [], columns = [], format = (v) => String(v) }) {
  if (!rows.length || !columns.length) return null;

  const colMax = columns.map((c) => Math.max(...rows.map((r) => r.values[c.key] || 0), 0));

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 3, minWidth: 480 }}>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  letterSpacing: '.04em',
                  color: 'var(--text-3)',
                  padding: '0 4px 6px',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{
                fontSize: 12.5,
                color: r.highlight ? 'var(--primary-text)' : 'var(--text-2)',
                fontWeight: r.highlight ? 600 : 400,
                paddingRight: 10,
                whiteSpace: 'nowrap',
              }}
              >
                {r.label}
              </td>
              {columns.map((c, ci) => {
                const v = r.values[c.key] || 0;
                const t = colMax[ci] > 0 ? v / colMax[ci] : 0;
                return (
                  <td
                    key={c.key}
                    title={`${r.label} · ${c.label}: ${format(v)}`}
                    style={{
                      width: 52,
                      height: 34,
                      textAlign: 'center',
                      borderRadius: 'var(--r-md)',
                      fontSize: 11.5,
                      fontFamily: 'var(--font-mono)',
                      background: `color-mix(in srgb, var(--primary) ${(0.08 + t * 0.5) * 100}%, transparent)`,
                      color: t > 0.65 ? 'var(--primary-text)' : 'var(--text-2)',
                    }}
                  >
                    {v ? format(v) : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default LineChart;
