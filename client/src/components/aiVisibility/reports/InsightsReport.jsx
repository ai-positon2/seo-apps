import { Card } from '../../../ui';
import {
  Metric, MetricStrip, FilledLabelBar, ReportWarnings,
} from '../reportPrimitives';
import { LineChart } from '../reportCharts';
import { ReportTable, MetricCell } from '../ReportTable';
import { muted } from '../promptHelpers';

// ── Report 2: Insights ──────────────────────────────────────────────────────
//
// METRICS.md §3. The six KPIs, the visibility trend, share of voice, and which
// brand each engine names first.
//
// This report owns the KPI strip; the Executive overview re-selects it rather
// than recomputing (§10), which is enforced on the server — `overview.data.kpis`
// is the same object `insights.data.kpis` is.

/** The §1 grid: rows are engines, columns are the first four positions. */
function FirstNamedGrid({ rows }) {
  if (!rows?.length) {
    return <div style={muted}>No brand was named in a rankable position yet.</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 4, minWidth: 460 }}>
        <thead>
          <tr>
            <th />
            {[1, 2, 3, 4].map((n) => (
              <th
                key={n}
                style={{
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  color: 'var(--text-3)',
                  padding: '0 6px 6px',
                }}
              >
                #{n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.engine}>
              <td style={{
                fontSize: 12.5, color: 'var(--text-2)', paddingRight: 10, whiteSpace: 'nowrap',
              }}
              >
                {r.engine}
              </td>
              {r.positions.map((p) => (
                <td key={p.ordinal} style={{ padding: 0 }}>
                  <div style={{
                    padding: '6px 10px',
                    borderRadius: 'var(--r-sm)',
                    fontSize: 11.5,
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    // The client gets the brand tint; everyone else is quiet.
                    // A grid where every cell shouted would say nothing.
                    background: p.isClient ? 'var(--primary-soft)' : 'var(--surface)',
                    border: `1px solid ${p.isClient ? 'var(--primary)' : 'var(--border)'}`,
                    color: p.isClient ? 'var(--primary-text)' : 'var(--text-3)',
                    fontWeight: p.isClient ? 600 : 400,
                  }}
                  >
                    {p.name || '—'}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InsightsReport({ envelope }) {
  const { data, meta, warnings } = envelope;
  const kpis = data.kpis;

  if (!kpis) {
    return (
      <>
        <ReportWarnings warnings={warnings} meta={meta} />
        <Card>
          <div style={{ fontSize: 13.5, color: 'var(--text)' }}>
            Nothing can be computed without an approved client brand.
          </div>
          <div style={{ ...muted, marginTop: 6 }}>
            Every metric on this report is about one brand. Approve the measured set on the
            Brands screen and this fills in.
          </div>
        </Card>
      </>
    );
  }

  const sovRows = data.shareOfVoice?.rows || [];
  const sovMax = Math.max(...sovRows.map((r) => r.value ?? 0), 0);

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

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

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginTop: 16,
      }}
      >
        <Card title="Share of voice">
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
          <div style={{ ...muted, marginTop: 10 }}>
            Share of attention across {data.shareOfVoice?.totalMentions ?? 0} mentions.
            {data.shareOfVoice?.otherMentions > 0 && (
              <> {data.shareOfVoice.otherMentions} mention(s) of brands outside the measured
                set are excluded from the denominator.
              </>
            )}
          </div>
        </Card>

        <Card title="Who each model names first">
          <FirstNamedGrid rows={data.firstNamed} />
        </Card>
      </div>

      <Card title="By engine" style={{ marginTop: 16 }}>
        <ReportTable
          minWidth={520}
          defaultSort="visibility"
          columns={[
            { key: 'engine', label: 'Engine', render: (r) => r.engine },
            {
              key: 'measured',
              label: 'Captures',
              align: 'right',
              render: (r) => <span className="num">{r.measured}</span>,
            },
            {
              key: 'visibility',
              label: 'Visibility',
              align: 'right',
              sortValue: (r) => r.value,
              render: (r) => <MetricCell metric={r} />,
            },
            {
              key: 'rankable',
              label: 'Rankable',
              align: 'right',
              sortValue: (r) => (r.rankable ? 1 : 0),
              title: 'A model needs 20+ captures in the period before it can be called strongest or weakest — below that the winner is noise.',
              render: (r) => (
                <span style={{ fontSize: 11.5, color: r.rankable ? 'var(--text-2)' : 'var(--text-3)' }}>
                  {r.rankable ? 'yes' : 'too few captures'}
                </span>
              ),
            },
          ]}
          rows={(kpis.engines || []).map((e) => ({ ...e, id: e.engine }))}
        />
      </Card>
    </>
  );
}

export default InsightsReport;
