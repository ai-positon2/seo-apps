import { Card } from '../../../ui';
import { Metric, MetricStrip, ReportWarnings } from '../reportPrimitives';
import { ReportTable, MetricCell } from '../ReportTable';
import { muted } from '../promptHelpers';

// ── Report 4: Prompts ───────────────────────────────────────────────────────
//
// METRICS.md §8. Per question, which is the level a weak market is actually
// visible at — a 30% headline can be one topic at 0% and everything else fine,
// and only this table shows which.
//
// The weak-markets list is the SAME query sorted ascending, not a second
// definition. Two definitions of "weak" would eventually disagree.

export function PromptsReport({ envelope }) {
  const { data, meta, warnings } = envelope;
  const rows = data.rows || [];

  const measured = rows.filter((r) => r.visibility.value !== null);
  const invisible = measured.filter((r) => r.visibility.value === 0);

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      <MetricStrip>
        <Metric
          label="Prompts measured"
          metric={{ value: rows.length, display: String(rows.length), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
        <Metric
          label="Never named"
          metric={{
            value: measured.length ? invisible.length : null,
            display: measured.length ? String(invisible.length) : '—',
            delta: null,
            deltaDisplay: null,
            direction: 'lower_is_better',
          }}
          sub={measured.length ? `of ${measured.length} measured` : 'Nothing measured'}
        />
        {/* Zero weak markets over nothing measured is not a clean bill of
            health — it is the absence of a check. */}
        <Metric
          label="Weak markets"
          metric={{
            value: measured.length ? data.weakest.length : null,
            display: measured.length ? String(data.weakest.length) : '—',
            delta: null,
            deltaDisplay: null,
            direction: 'lower_is_better',
          }}
          sub={measured.length ? 'Below 50% visibility' : 'Nothing measured'}
        />
        <Metric label="Coverage" metric={meta.coverage} sub={meta.coverageLabel} />
      </MetricStrip>

      <Card title="Every measured question" style={{ marginTop: 16 }}>
        <div style={{ ...muted, marginBottom: 12 }}>
          Sorted weakest first. A question measured but never naming the client shows
          <span className="num"> 0.0%</span> — a real finding. One that could not be measured
          shows an em-dash instead, which is a different thing.
        </div>

        <ReportTable
          minWidth={860}
          defaultSort="visibility"
          defaultDir="asc"
          columns={[
            {
              key: 'text',
              label: 'Question',
              width: '38%',
              render: (r) => (
                <div>
                  <div style={{ color: 'var(--text)', lineHeight: 1.4 }}>{r.text || '—'}</div>
                  {r.location && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{r.location}</div>
                  )}
                </div>
              ),
            },
            {
              key: 'topicLabel',
              label: 'Topic',
              render: (r) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>{r.topicLabel || 'Uncategorised'}</span>
                  {r.targetUrl && (
                    <a
                      href={r.targetUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ fontSize: 11, color: 'var(--primary-text)' }}
                    >
                      the page this should win
                    </a>
                  )}
                </div>
              ),
            },
            {
              key: 'measured',
              label: 'Captures',
              align: 'right',
              sortValue: (r) => r.measured.value,
              render: (r) => <MetricCell metric={r.measured} />,
            },
            {
              key: 'position',
              label: 'Position',
              align: 'right',
              sortValue: (r) => r.position.value,
              title: 'Average rank among the brands named. Lower is better.',
              render: (r) => <MetricCell metric={r.position} />,
            },
            {
              key: 'visibility',
              label: 'Visibility',
              align: 'right',
              sortValue: (r) => r.visibility.value,
              render: (r) => (
                <span style={{
                  color: r.visibility.value === 0 ? 'var(--danger)' : 'var(--text-2)',
                  fontWeight: r.visibility.value === 0 ? 600 : 400,
                }}
                >
                  <MetricCell metric={r.visibility} />
                </span>
              ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: r.promptId }))}
          emptyText="No prompts were measured in this period."
        />
      </Card>
    </>
  );
}

export default PromptsReport;
