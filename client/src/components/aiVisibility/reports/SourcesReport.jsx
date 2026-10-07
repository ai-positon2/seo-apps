import { Card } from '../../../ui';
import {
  Metric, MetricStrip, TypeChip, typeTone, ReportWarnings,
} from '../reportPrimitives';
import { ReportTable, MetricCell } from '../ReportTable';
import { muted } from '../promptHelpers';

// ── Reports 6 and 7: Domains and URLs ───────────────────────────────────────
//
// METRICS.md §5. One component for both, because they are the same query at
// two grouping levels and two implementations would drift.
//
// The distinction the table has to keep visible is §5.2's: `retrievals` counts
// citation ROWS, `retrieved in` counts CAPTURES. A capture citing three pages
// of one domain contributes 3 to the first and 1 to the second. §5.2 warns
// against conflating them, so both columns ship with their own tooltip.

/** §5.3's mix, as a single stacked bar. Shares are NOT normalised to 100. */
function TypeMix({ rows, total }) {
  if (!rows?.length) return null;

  return (
    <>
      <div style={{
        display: 'flex', height: 22, borderRadius: 'var(--r-sm)', overflow: 'hidden', gap: 2,
      }}
      >
        {rows.map((r) => {
          const pct = (r.value ?? 0) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={r.type}
              title={`${r.type}: ${r.display} (${r.retrievals.display} retrievals)`}
              style={{
                width: `${pct}%`,
                minWidth: 2,
                background: `color-mix(in srgb, ${typeTone(r.type)} 60%, transparent)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {pct >= 12 && (
                <span className="num" style={{ fontSize: 10.5, color: 'var(--text)' }}>{r.display}</span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
        {rows.map((r) => (
          <span key={r.type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
            <TypeChip type={r.type} />
            <span className="num">{r.display}</span>
          </span>
        ))}
      </div>

      <div style={{ ...muted, marginTop: 10 }}>
        Shares are rounded and will not always sum to 100 — they are not adjusted to force it.
        Total retrievals: <span className="num">{total}</span>.
      </div>
    </>
  );
}

export function SourcesReport({ envelope, level = 'domain' }) {
  const { data, meta, warnings } = envelope;
  const rows = data.rows || [];
  const isUrl = level === 'url';

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      <MetricStrip>
        <Metric label="Total retrievals" metric={data.totalRetrievals} />
        <Metric
          label={isUrl ? 'Distinct pages' : 'Distinct domains'}
          metric={{ value: rows.length, display: String(rows.length), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
        <Metric
          label="Most retrieved"
          metric={rows[0]?.retrievals || null}
          sub={rows[0]?.domain}
        />
        <Metric label="Coverage" metric={meta.coverage} sub={meta.coverageLabel} />
      </MetricStrip>

      {data.typeMix?.length > 0 && (
        <Card title="Source type mix" style={{ marginTop: 16 }}>
          <TypeMix rows={data.typeMix} total={data.totalRetrievals.display} />
        </Card>
      )}

      <Card title={isUrl ? 'Every page cited' : 'Every domain cited'} style={{ marginTop: 16 }}>
        {isUrl && (
          <div style={{ ...muted, marginBottom: 12 }}>
            Only engines that expose a full destination URL appear here. An engine that gives
            source domains alone contributes to the Domains report but cannot contribute a page.
          </div>
        )}

        <ReportTable
          minWidth={880}
          defaultSort="retrievals"
          columns={[
            {
              key: 'id',
              label: isUrl ? 'Page' : 'Domain',
              width: '34%',
              render: (r) => (
                <div>
                  <div style={{
                    color: 'var(--text)', wordBreak: 'break-all', lineHeight: 1.35,
                  }}
                  >
                    {isUrl && r.url
                      ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary-text)' }}>{r.url}</a>
                      : r.domain}
                  </div>
                  {!isUrl && r.host && r.host !== r.domain && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{r.host}</div>
                  )}
                </div>
              ),
            },
            {
              key: 'domainType',
              label: 'Domain type',
              sortValue: (r) => r.domainType || '',
              render: (r) => <TypeChip type={r.domainType} />,
            },
            ...(isUrl ? [{
              key: 'urlType',
              label: 'Page type',
              sortValue: (r) => r.urlType || '',
              title: 'Unknown where the engine exposed no path — guessed types would be worse than an honest gap.',
              render: (r) => <TypeChip type={r.urlType} />,
            }] : []),
            {
              key: 'retrievals',
              label: 'Retrievals',
              align: 'right',
              sortValue: (r) => r.retrievals.value,
              title: 'Citation rows. One answer citing three pages of a domain contributes 3.',
              render: (r) => <MetricCell metric={r.retrievals} />,
            },
            {
              key: 'retrievedPct',
              label: 'Retrieved in',
              align: 'right',
              sortValue: (r) => r.retrievedPct.value,
              title: 'Share of captures whose answer cited this at all. That same three-page answer contributes 1.',
              render: (r) => <MetricCell metric={r.retrievedPct} />,
            },
            {
              key: 'retrievalRate',
              label: 'Per answer',
              align: 'right',
              sortValue: (r) => r.retrievalRate.value,
              title: 'Average citations per answer that used this source.',
              render: (r) => <MetricCell metric={r.retrievalRate} />,
            },
            {
              key: 'citationRate',
              label: 'Shown inline',
              align: 'right',
              sortValue: (r) => r.citationRate.value,
              title: 'Share of this source’s citations the reader can actually see and click.',
              render: (r) => <MetricCell metric={r.citationRate} />,
            },
          ]}
          rows={rows}
          emptyText={isUrl
            ? 'No engine in this period exposed a full page URL.'
            : 'No citations were recorded in this period.'}
        />
      </Card>
    </>
  );
}

export default SourcesReport;
