import { Card } from '../../../ui';
import {
  Metric, MetricStrip, FilledLabelBar, ReportWarnings,
} from '../reportPrimitives';
import { LineChart } from '../reportCharts';
import { muted } from '../promptHelpers';

// ── Overview ────────────────────────────────────────────────────────────────
//
// METRICS.md §10: this report computes NOTHING NEW. Every figure on it is
// re-selected from the builders behind it, and the server guarantees that —
// `overview` calls them rather than recomputing, and a test asserts
// `overview.data.kpis` is deep-equal to `insights.data.kpis`.
//
// So this component must not derive anything either. It reads, arranges, and
// links onward. The moment it computes a number the guarantee is gone, and the
// hero figure can disagree with the report it links to.
//
// Written for a reader who will not open the other eight: it answers "are we
// winning or losing", "is that changing", and "where is ground being lost", in
// that order, and every block names the report it came from.

/** A block heading that also says which report the numbers belong to. */
function From({ title, reportId, onOpen, children }) {
  return (
    <Card
      title={title}
      actions={(
        <button
          type="button"
          onClick={() => onOpen?.(reportId)}
          style={{
            fontSize: 11.5,
            color: 'var(--primary-text)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Open report →
        </button>
      )}
      style={{ marginTop: 16 }}
    >
      {children}
    </Card>
  );
}

export function OverviewReport({ envelope, onOpenReport }) {
  const { data, meta, warnings } = envelope;
  const kpis = data.kpis;

  if (!kpis) {
    return (
      <>
        <ReportWarnings warnings={warnings} meta={meta} />
        <Card>
          <div style={{ fontSize: 13.5, color: 'var(--text)' }}>
            There is no headline to report yet.
          </div>
          <div style={{ ...muted, marginTop: 6 }}>
            Every figure on this page is about one brand, and no client brand has been approved.
            The Brands screen is where that starts.
          </div>
        </Card>
      </>
    );
  }

  const sovRows = data.shareOfVoice?.rows || [];
  const sovMax = Math.max(...sovRows.map((r) => r.value ?? 0), 0);
  const leader = sovRows[0];
  const you = sovRows.find((r) => r.isClient);
  const rank = you ? sovRows.indexOf(you) + 1 : null;

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      {/* The one sentence a reader who opens nothing else should leave with. */}
      <Card style={{ marginBottom: 16 }}>
        <div
          className="eyebrow"
          style={{
            fontSize: 9.5,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '.18em',
            color: 'var(--text-3)',
            marginBottom: 6,
          }}
        >
          WHERE YOU STAND
        </div>
        <div style={{ fontSize: 22, color: 'var(--text)', lineHeight: 1.35, fontWeight: 600 }}>
          {rank === null ? (
            'Not named in any measured answer this period.'
          ) : (
            <>
              <span style={{ color: 'var(--primary-text)', fontFamily: 'var(--font-mono)' }}>
                #{rank}
              </span>
              {' '}of {sovRows.length} in share of voice
              {leader && !leader.isClient && <> — {leader.name} leads</>}
            </>
          )}
        </div>
        <div style={{ ...muted, marginTop: 8 }}>
          Across <span className="num">{meta.captures}</span> measured answers
          to <span className="num">{meta.promptsMeasured}</span> questions,
          {' '}{meta.period.from} to {meta.period.to}.
        </div>
      </Card>

      <MetricStrip>
        <Metric label="Visibility" metric={kpis.visibility} />
        <Metric label="Sentiment" metric={kpis.sentiment} />
        <Metric label="Position" metric={kpis.position} />
        <Metric label="Share of voice" metric={kpis.shareOfVoice} />
        <Metric
          label="Strongest model"
          metric={kpis.strongestModel}
          sub={kpis.strongestModel.engine || kpis.strongestModel.note}
        />
        <Metric
          label="Weakest model"
          metric={kpis.weakestModel}
          sub={kpis.weakestModel.engine || kpis.weakestModel.note}
        />
      </MetricStrip>

      {/* "Is that changing" is the second question anyone asks and it used to
          live on another screen, so the screen people opened first could not
          answer it. Re-selected from the same builder, not recomputed. */}
      {data.trend && (
        <Card title="Visibility over time" style={{ marginTop: 16 }}>
          <div style={{ ...muted, marginBottom: 12 }}>
            {data.trend.sizeDays === 1
              ? 'One point per day.'
              : `One point per ${data.trend.sizeDays} days.`}
            {' '}A break in a line is a period with no captures — not a drop to zero.
          </div>
          <LineChart series={data.trend.series} buckets={data.trend.buckets} />
        </Card>
      )}

      <From title="Share of voice" reportId="insights" onOpen={onOpenReport}>
        {!sovRows.length && <div style={muted}>Nobody in the measured set was named.</div>}
        {sovRows.map((row) => (
          <FilledLabelBar
            key={row.brandId}
            label={row.isClient ? `${row.name} (you)` : row.name}
            value={row.value ?? 0}
            max={sovMax}
            display={row.display}
            highlight={row.isClient}
          />
        ))}
      </From>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16,
      }}
      >
        <From title="Where ground is being lost" reportId="gaps" onOpen={onOpenReport}>
          <div style={{ ...muted, marginBottom: 10 }}>
            Sources that feed answers in this category and cite a competitor more often
            than they cite you.
          </div>
          {!data.topGaps?.length && <div style={muted}>No gaps ranked in this period.</div>}
          {(data.topGaps || []).map((g) => (
            <div
              key={g.domain}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12.5,
              }}
            >
              <span style={{
                color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              >
                {g.domain}
              </span>
              <span className="num" style={{ color: 'var(--warning)', flexShrink: 0 }}>{g.display}</span>
            </div>
          ))}
        </From>

        <From title="Weakest questions" reportId="prompts" onOpen={onOpenReport}>
          <div style={{ ...muted, marginBottom: 10 }}>
            Questions this client is least visible on. A measured
            <span className="num"> 0.0%</span> is a finding; an em-dash means it could not
            be measured.
          </div>
          {!data.weakestPrompts?.length && <div style={muted}>No prompts measured in this period.</div>}
          {(data.weakestPrompts || []).map((p) => (
            <div
              key={p.promptId}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12.5,
              }}
            >
              <span style={{
                color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              >
                {p.text}
              </span>
              <span
                className="num"
                style={{
                  flexShrink: 0,
                  color: p.visibility.value === 0 ? 'var(--danger)' : 'var(--text-3)',
                }}
              >
                {p.visibility.display}
              </span>
            </div>
          ))}
        </From>
      </div>

      <div style={{ ...muted, marginTop: 16 }}>
        Every figure on this page is re-selected from the reports it links to — nothing here is
        computed separately, so a number on this page and the same number on its own report
        cannot disagree.
      </div>
    </>
  );
}

export default OverviewReport;
