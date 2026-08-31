import { Card } from '../../../ui';
import {
  Metric, MetricStrip, FilledLabelBar, TypeChip, ShowMore, ReportWarnings,
} from '../reportPrimitives';
import { PromptByPrompt } from '../PromptByPrompt';
import { TopicResults } from '../TopicResults';
import { muted } from '../promptHelpers';

// ── Report 9: Run detail ────────────────────────────────────────────────────
//
// The one report that already worked on today's data, restyled onto the new
// envelope. Two changes from the old Report tab, both deliberate:
//
//   • The score is labelled "RUN VISIBILITY", never "Visibility". METRICS.md
//     §3.3 is explicit: a run is a handful of captures and reads far lower than
//     the 30-day figure. Two numbers called the same thing, disagreeing, in
//     front of the same client, is the failure this label prevents.
//
//   • The spend line is gone. It was engineering telemetry on a client-facing
//     screen. It still exists on the run row for whoever pays the bill.

/** §3.3 bands. A null score is grey — it is not a bad score, it is no score. */
function scoreTone(value) {
  if (value === null || value === undefined) return 'var(--text-3)';
  if (value >= 60) return 'var(--success)';
  if (value >= 30) return 'var(--warning)';
  return 'var(--danger)';
}

export function RunDetailReport({ envelope, legacy }) {
  const { data, meta, warnings } = envelope;
  const score = data.score?.value ?? null;
  const unextracted = warnings.includes('captures_not_extracted');

  const sovRows = data.shareOfVoice?.rows || [];
  const sovMax = Math.max(...sovRows.map((r) => r.value ?? 0), 0);
  const citedMax = Math.max(...(data.citedInstead || []).map((d) => d.value ?? 0), 0);

  return (
    <>
      <ReportWarnings warnings={warnings} meta={meta} />

      {/* ── Headline ─────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div
              className="eyebrow"
              style={{
                fontSize: 9.5,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '.18em',
                color: 'var(--text-3)',
                marginBottom: 4,
              }}
            >
              {(data.label || 'Run visibility').toUpperCase()}
            </div>
            <div style={{
              fontSize: 46, lineHeight: 1.05, fontFamily: 'var(--font-mono)', color: scoreTone(score),
            }}
            >
              {data.score?.display ?? '—'}
              {score !== null && <span style={{ fontSize: 18, color: 'var(--text-3)' }}>/100</span>}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55 }}>
              {/* The basis carries its own sentence when there is no client
                  brand, because "Named in 34 captures, none matched" would
                  claim a measurement that never happened. */}
              {score === null && data.score?.note
                ? <span className="num">{data.basis}</span>
                : <>Named in <strong className="num">{data.basis}</strong>.</>}
            </div>
            <div style={{ ...muted, marginTop: 6 }}>
              This is one run, not the reporting period. It reads lower than the 30-day
              visibility because it rests on far fewer answers — that is expected, not a
              contradiction.
            </div>
            {meta?.coverageLabel && (
              <div style={{ ...muted, marginTop: 6 }}>
                Coverage: <span className="num">{meta.coverageLabel}</span>.
              </div>
            )}
            {legacy?.scoreBasis && (
              <div style={{ ...muted, marginTop: 8, fontStyle: 'italic' }}>{legacy.scoreBasis}</div>
            )}
          </div>
        </div>
      </Card>

      <MetricStrip>
        <Metric label="Run visibility" metric={data.score} />
        <Metric label="Coverage" metric={data.coverage} />
        <Metric
          label="Captures"
          metric={{ value: meta.captures, display: String(meta.captures), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
        <Metric
          label="Prompts measured"
          metric={{ value: meta.promptsMeasured, display: String(meta.promptsMeasured), delta: null, deltaDisplay: null, direction: 'neutral' }}
        />
      </MetricStrip>

      {/* ── Share of voice + cited instead ───────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16,
      }}
      >
        <Card title="Share of voice">
          {!sovRows.length && (
            <div style={muted}>
              Nobody in the measured set was named in this run.
            </div>
          )}
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
          {data.shareOfVoice?.label && (
            <div style={{ ...muted, marginTop: 8 }}>{data.shareOfVoice.label}</div>
          )}
        </Card>

        <Card title="Cited instead">
          {!(data.citedInstead || []).length && (
            <div style={muted}>No citations were recorded in this run.</div>
          )}
          <ShowMore
            items={data.citedInstead || []}
            initial={8}
            noun="more sources"
            render={(d) => (
              <div
                key={d.domain}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                }}
              >
                <span style={{
                  flex: 1,
                  fontSize: 12.5,
                  color: 'var(--text-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {d.domain}
                </span>
                <TypeChip type={d.domainType} />
                <span className="num" style={{ fontSize: 11.5, color: 'var(--text-3)', flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
                  {d.display}
                </span>
              </div>
            )}
          />
          {citedMax > 0 && (
            <div style={{ ...muted, marginTop: 10 }}>
              Counts are citation rows, not distinct pages — one answer can lean on the same
              source more than once.
            </div>
          )}
        </Card>
      </div>

      {/* ── Per-prompt evidence ──────────────────────────────────────────
          Only shown once extraction has run. The legacy panels are computed by
          the previous scorer, which counted a brand named anywhere in the
          answer INCLUDING inside a link URL. The new pipeline excludes those —
          a linked domain is a citation, not a recommendation — so on
          unextracted captures the two genuinely disagree, and showing both put
          "1 of 4 named" directly beneath "0 of 34 captures".

          Phase 4 rebuilds these from the entity rows. Until then, a
          contradiction is worse than an omission. */}
      {!unextracted && legacy?.byTopic?.length > 0 && <TopicResults byTopic={legacy.byTopic} />}

      {!unextracted && legacy?.byPrompt?.length > 0 && (
        <Card title="Prompt by prompt" style={{ marginTop: 16 }}>
          {legacy.surfaces?.length > 0 && (
            <div style={{ ...muted, marginBottom: 12 }}>{legacy.surfaces.join(' · ')}</div>
          )}
          <PromptByPrompt byPrompt={legacy.byPrompt} />
        </Card>
      )}

      {unextracted && (
        <Card style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>
            Per-prompt evidence is not shown for this run.
          </div>
          <div style={{ ...muted, marginTop: 6 }}>
            These captures have not been through extraction, so there are no mention rows to
            build it from. Running extraction fills this in.
          </div>
        </Card>
      )}
    </>
  );
}

export default RunDetailReport;
