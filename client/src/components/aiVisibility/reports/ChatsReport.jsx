import { useEffect, useState } from 'react';
import { Card, Drawer, Badge } from '../../../ui';
import { Metric, MetricStrip, TypeChip, ReportWarnings } from '../reportPrimitives';
import { ReportTable, MetricCell } from '../ReportTable';
import { muted, formatWhen } from '../promptHelpers';
import { aiVisibilityApi } from '../../../lib/aiVisibilityApi';

// ── Report 8: Chats ─────────────────────────────────────────────────────────
//
// METRICS.md §4. Every captured answer, one row each — the evidence layer
// under every other report.
//
// §4 defines TWO citation counts that differ on purpose and must not be
// conflated: `average_citation` (the KPI) counts INLINE citations only, because
// it answers "how many sources does a reader see"; the per-row `sources` column
// counts every citation, retrieved or inline. Both ship, each labelled.
//
// Drill-down is a Drawer, which is this app's convention everywhere, rather
// than row expansion inside the table.

export function ChatsReport({ envelope, project }) {
  const { data, meta, warnings } = envelope;
  const [open, setOpen] = useState(null);
  const [full, setFull] = useState({ loading: false, capture: null, error: null });
  const rows = data.rows || [];

  // The table carries a 180-character excerpt because 44 rows of prose is not
  // a table. The whole answer is stored — this fetches it when a row is
  // opened, so the drawer shows the evidence rather than a summary of it.
  useEffect(() => {
    if (!open || !project) { setFull({ loading: false, capture: null, error: null }); return; }
    let cancelled = false;
    setFull({ loading: true, capture: null, error: null });
    aiVisibilityApi.capture(project.id, open.captureId)
      .then((d) => { if (!cancelled) setFull({ loading: false, capture: d.capture, error: null }); })
      .catch((e) => { if (!cancelled) setFull({ loading: false, capture: null, error: e }); });
    return () => { cancelled = true; };
  }, [open, project?.id]);

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      <MetricStrip>
        <Metric label="Total chats" metric={data.kpis.totalChats} />
        <Metric
          label="Brand mentioned"
          metric={data.kpis.brandMentioned}
          sub={`of ${data.kpis.totalChats.display} answers`}
        />
        <Metric label="Used web search" metric={data.kpis.webSearch} />
        <Metric
          label="Sources shown"
          metric={data.kpis.averageCitation}
          sub="Inline citations per answer"
        />
      </MetricStrip>

      {data.kpis.mostCommonFeature && (
        <div style={{ ...muted, marginTop: 12 }}>
          Most common answer shape: <span className="num">{data.kpis.mostCommonFeature}</span>.
        </div>
      )}

      <Card title="Every captured answer" style={{ marginTop: 16 }}>
        <div style={{ ...muted, marginBottom: 12 }}>
          A blank position means the client was not named in that answer — not that it
          ranked last.
        </div>

        <ReportTable
          minWidth={900}
          defaultSort="capturedAt"
          onRowClick={setOpen}
          columns={[
            {
              key: 'prompt',
              label: 'Question',
              width: '30%',
              render: (r) => <span style={{ color: 'var(--text)' }}>{r.prompt || '—'}</span>,
            },
            { key: 'engine', label: 'Engine', render: (r) => r.engine },
            {
              key: 'features',
              label: 'Shape',
              sortable: false,
              render: (r) => (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(r.features || []).map((f) => <TypeChip key={f} type={f} />)}
                  {!(r.features || []).length && <span style={{ color: 'var(--text-3)' }}>—</span>}
                </div>
              ),
            },
            {
              key: 'sources',
              label: 'Sources',
              align: 'right',
              sortValue: (r) => r.sources.value,
              title: 'Every citation on this answer, retrieved or shown inline.',
              render: (r) => <MetricCell metric={r.sources} />,
            },
            {
              key: 'position',
              label: 'Position',
              align: 'right',
              sortValue: (r) => r.position.value,
              render: (r) => <MetricCell metric={r.position} />,
            },
            {
              key: 'capturedAt',
              label: 'Captured (your time)',
              align: 'right',
              sortValue: (r) => new Date(r.capturedAt).getTime(),
              // Date AND time, in the reader's zone. A bare UTC date rendered
              // every run of one night as the same string.
              render: (r) => (
                <span className="num" style={{ fontSize: 11.5 }}>
                  {formatWhen(r.capturedAt)}
                </span>
              ),
            },
          ]}
          rows={rows.map((r) => ({ ...r, id: r.captureId }))}
          emptyText="No answers were captured in this period."
        />
      </Card>

      <Drawer open={Boolean(open)} onClose={() => setOpen(null)} title="Captured answer" width={560}>
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div className="eyebrow" style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.18em', color: 'var(--text-3)', marginBottom: 4 }}>
                QUESTION
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--text)' }}>{open.prompt}</div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge variant="neutral">{open.engine}</Badge>
              {open.surfaceLabel && <Badge variant="neutral">{open.surfaceLabel}</Badge>}
              {(open.features || []).map((f) => <TypeChip key={f} type={f} />)}
              {/* Which run this answer came from. Without it, two captures of
                  the same question are indistinguishable in the drawer. */}
              <span style={{ ...muted, marginLeft: 'auto' }}>{formatWhen(open.capturedAt)}</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ ...muted }}>Position</div>
                <div style={{ fontSize: 18, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  <MetricCell metric={open.position} />
                </div>
              </div>
              <div>
                <div style={{ ...muted }}>Sources</div>
                <div style={{ fontSize: 18, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  <MetricCell metric={open.sources} />
                </div>
              </div>
            </div>

            <div>
              <div className="eyebrow" style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.18em', color: 'var(--text-3)', marginBottom: 4 }}>
                THE ANSWER, AS GIVEN
              </div>
              <div style={{
                fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.65,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)', padding: 12,
                whiteSpace: 'pre-wrap', maxHeight: 420, overflowY: 'auto',
              }}
              >
                {full.loading && 'Loading the full answer…'}
                {full.error && `Could not load it: ${full.error.message}`}
                {!full.loading && !full.error
                  && (full.capture?.answerText
                    || open.excerpt
                    || 'No answer text was stored for this capture.')}
              </div>
              {full.capture?.answerText && (
                <div style={{ ...muted, marginTop: 6 }}>
                  <span className="num">{full.capture.answerText.length}</span> characters, stored
                  verbatim. Kept for 12 months as the evidence behind every number on these reports.
                </div>
              )}
            </div>

            {/* Citations, which are the other half of the evidence — what the
                answer leaned on, not just what it said. */}
            <div>
              <div className="eyebrow" style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.18em', color: 'var(--text-3)', marginBottom: 4 }}>
                SOURCES THIS ANSWER USED
              </div>
              {!full.capture && <div style={muted}>…</div>}
              {full.capture && !(full.capture.citations || []).length && (
                <div style={muted}>
                  No sources were exposed on this answer. That is a real result for some
                  engines and questions, not a failure to read them.
                </div>
              )}
              {(full.capture?.citations || []).map((c, i) => (
                <div
                  key={`${c.url || c.domain || c.host}-${i}`}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0',
                    borderTop: i ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 12.5, color: 'var(--primary-text)', wordBreak: 'break-all' }}
                      >
                        {c.url}
                      </a>
                    ) : (
                      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                        {c.domain || c.host || c.publisher || 'unnamed source'}
                      </span>
                    )}
                    {c.title && (
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-3)' }}>{c.title}</span>
                    )}
                    {!c.url && (c.domain || c.host) && (
                      <span style={{ ...muted, display: 'block' }}>
                        Domain only — this engine does not expose the page it used.
                      </span>
                    )}
                  </span>
                  {c.occurrences > 1 && (
                    <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      ×{c.occurrences}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {full.capture && !full.capture.extractedAt && (
              <div style={{ ...muted, color: 'var(--warning)' }}>
                This capture has not been through extraction, so its mentions and citations are
                not counted in any report yet. The answer above is stored regardless.
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}

export default ChatsReport;
