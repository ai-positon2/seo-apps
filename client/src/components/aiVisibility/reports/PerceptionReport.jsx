import { Card, EmptyState } from '../../../ui';
import { Metric, MetricStrip, FilledLabelBar, ReportWarnings } from '../reportPrimitives';
import { Heatmap } from '../reportCharts';
import { ReportTable } from '../ReportTable';
import { muted } from '../promptHelpers';

// ── Report 3: Perception ────────────────────────────────────────────────────
//
// METRICS.md §7. What the models associate this client with.
//
// The extraction behind this is not built: §7.1's term→attribute mapping is an
// embedding assignment at ~0.78 with human review and a stored mapping version,
// and it is the heaviest subsystem in the design. So the honest state of this
// screen today is "nothing extracted", said plainly.
//
// It renders the shape rather than a 404 because a client asking "what am I
// known for" and getting a blank panel has been answered; getting an error has
// not. When the extraction lands, the components below are already wired.

export function PerceptionReport({ envelope }) {
  const { data, meta, warnings } = envelope;
  const association = data.association || [];
  const terms = data.terms || [];
  const max = Math.max(...association.map((a) => a.value ?? 0), 0);

  if (!association.length) {
    return (
      <>
        <ReportWarnings warnings={warnings} meta={meta} />
        <Card>
          <EmptyState
            title="No perception terms extracted yet"
            description={'This report reads the words models use about the client — "affordable", '
              + '"gentle", "same-day" — and groups them into attributes. That extraction is not '
              + 'running yet, so there is nothing to show rather than nothing to find.'}
          />
        </Card>
        <div style={{ ...muted, marginTop: 12 }}>
          When it does run, every term is stored with the attribute it mapped to and the version
          of the mapping that made the call, so retuning the mapping later never silently moves
          a past period&apos;s scores.
        </div>
      </>
    );
  }

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      <MetricStrip>
        <Metric
          label="Most associated"
          metric={data.mostAssociated}
          sub={data.mostAssociated?.attributeId}
        />
        <Metric
          label="Biggest gap"
          metric={data.biggestGap}
          sub={data.biggestGap?.attributeId}
        />
        <Metric
          label="Distinct terms"
          metric={{ value: terms.length, display: String(terms.length), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
        <Metric label="Coverage" metric={meta.coverage} sub={meta.coverageLabel} />
      </MetricStrip>

      <Card title="Association by attribute" style={{ marginTop: 16 }}>
        <div style={{ ...muted, marginBottom: 12 }}>
          Bars are scaled to the strongest attribute, not to 100. An attribute the industry
          cares about scoring zero is kept in the list — that is the honest answer, not a
          missing row.
        </div>
        {association.map((a) => (
          <FilledLabelBar
            key={a.attributeId}
            label={a.attributeId}
            value={a.value ?? 0}
            max={max}
            display={a.display}
          />
        ))}
      </Card>

      {data.heatmap?.rows?.length > 0 && (
        <Card title="How the field compares" style={{ marginTop: 16 }}>
          <div style={{ ...muted, marginBottom: 12 }}>
            Named earlier and more often, on questions about that attribute. Each column is
            scaled to its own strongest brand.
          </div>
          <Heatmap rows={data.heatmap.rows} columns={data.heatmap.columns} />
        </Card>
      )}

      <Card title="Terms used" style={{ marginTop: 16 }}>
        <ReportTable
          minWidth={520}
          defaultSort="occurrences"
          columns={[
            { key: 'term', label: 'Term', render: (r) => r.term },
            { key: 'attribute', label: 'Attribute', render: (r) => r.attribute },
            {
              key: 'occurrences',
              label: 'Occurrences',
              align: 'right',
              sortValue: (r) => r.occurrences,
              render: (r) => <span className="num">{r.display}</span>,
            },
          ]}
          rows={terms.map((t, i) => ({ ...t, id: `${t.term}-${i}` }))}
        />
      </Card>
    </>
  );
}

export default PerceptionReport;
