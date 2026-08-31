import { Card } from '../../../ui';
import {
  Metric, MetricStrip, FilledLabelBar, TypeChip, ReportWarnings,
} from '../reportPrimitives';
import { ReportTable, MetricCell } from '../ReportTable';
import { muted } from '../promptHelpers';

// ── Report 5: Gap analysis ──────────────────────────────────────────────────
//
// METRICS.md §6: a source that feeds AI answers in your category but never
// cites you.
//
// §6 closes with "present it as data only — rank the gaps, never write the
// remedy in the UI", and this report holds that line. It shows the inputs that
// produced each score so a reader can judge it, and stops there. The remedy is
// a conversation, not a table cell.

export function GapsReport({ envelope }) {
  const { data, meta, warnings } = envelope;
  const rows = data.rows || [];
  const withGap = rows.filter((r) => (r.gapCaptures.value ?? 0) > 0);
  const max = Math.max(...rows.map((r) => r.gapScore.value ?? 0), 0);

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      <MetricStrip>
        <Metric
          label="Sources seen"
          metric={{ value: rows.length, display: String(rows.length), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
        {/* "0 gaps" over no citations reads as a clean result rather than an
            unrun check. */}
        <Metric
          label="Gaps"
          metric={{
            value: rows.length ? withGap.length : null,
            display: rows.length ? String(withGap.length) : '—',
            delta: null,
            deltaDisplay: null,
            direction: 'lower_is_better',
          }}
          sub={rows.length ? 'Cite a competitor more than you' : 'No sources seen yet'}
        />
        <Metric
          label="Top gap score"
          metric={rows[0]?.gapScore || null}
          sub={rows[0]?.domain}
        />
        <Metric label="Coverage" metric={meta.coverage} sub={meta.coverageLabel} />
      </MetricStrip>

      {withGap.length > 0 && (
        <Card title="Ranked gaps" style={{ marginTop: 16 }}>
          <div style={{ ...muted, marginBottom: 12 }}>
            Score is gap captures × how often the source is retrieved × a weight for what kind
            of source it is — a directory you can get listed in outweighs a competitor&apos;s own
            site you can never appear on.
          </div>
          {withGap.slice(0, 10).map((r) => (
            <FilledLabelBar
              key={r.domain}
              label={r.domain}
              value={r.gapScore.value ?? 0}
              max={max}
              display={r.gapScore.display}
            />
          ))}
        </Card>
      )}

      <Card title="Every source" style={{ marginTop: 16 }}>
        <ReportTable
          minWidth={820}
          defaultSort="gapScore"
          columns={[
            { key: 'domain', label: 'Source', render: (r) => r.domain },
            {
              key: 'domainType',
              label: 'Type',
              sortValue: (r) => r.domainType || '',
              render: (r) => <TypeChip type={r.domainType} />,
            },
            {
              key: 'typeWeight',
              label: 'Weight',
              align: 'right',
              title: 'How actionable this kind of source is (§6). A competitor site scores 1.0 on gap but you can never appear on it.',
              render: (r) => <span className="num">{r.typeWeight.toFixed(1)}</span>,
            },
            {
              key: 'compCaptures',
              label: 'Cites a rival',
              align: 'right',
              sortValue: (r) => r.compCaptures.value,
              render: (r) => <MetricCell metric={r.compCaptures} />,
            },
            {
              key: 'youCaptures',
              label: 'Cites you',
              align: 'right',
              sortValue: (r) => r.youCaptures.value,
              render: (r) => <MetricCell metric={r.youCaptures} />,
            },
            {
              key: 'retrievedPct',
              label: 'Retrieved in',
              align: 'right',
              sortValue: (r) => r.retrievedPct.value,
              title: 'The share of captures whose answer cited this source at all.',
              render: (r) => <MetricCell metric={r.retrievedPct} />,
            },
            {
              key: 'gapScore',
              label: 'Gap score',
              align: 'right',
              sortValue: (r) => r.gapScore.value,
              render: (r) => (
                <span style={{ color: (r.gapScore.value ?? 0) > 0 ? 'var(--warning)' : 'var(--text-3)' }}>
                  <MetricCell metric={r.gapScore} />
                </span>
              ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: r.domain }))}
          emptyText="No citations were recorded in this period, so no gaps can be ranked."
        />
      </Card>
    </>
  );
}

export default GapsReport;
