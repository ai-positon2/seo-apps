import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Kicker, Muted, Tag, Btn, ScoreRing, SeverityBars, SignalDot } from './primitives';
import { MODULE_STATUS_LABEL, MODULE_STATUS_TONE, relativeTime } from '../../lib/projectsApi';
import { moduleReportRoute } from '../../lib/moduleReportRoute';

// ── One module of the audit profile ─────────────────────────────────────────
// Two shapes, and which one renders is decided by the data, not by a prop:
//
//   live evidence  — a score ring when the module has a rubric, severity bars
//                    and top findings when it reports findings instead
//   no evidence    — the same card frame, an em dash where the number would be,
//                    and a line saying what would put a number there
//
// The second shape is the point of the component. A dashboard that renders a
// confident 78 for a module that has never run is worse than one that admits it
// has nothing: the PRD forbids coercing missing data into a value (§16.11) and
// rules out inventing a new score (§6.2), and this is where that is honoured on
// screen.

export default function ModuleCard({ module, onRun }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);
  const tone = MODULE_STATUS_TONE[module.status] || 'muted';
  const statusLabel = MODULE_STATUS_LABEL[module.status] || module.status;
  const hasEvidence = Boolean(module.evidence);
  const canRun = Boolean(module.runnable && onRun);
  const reportRoute = moduleReportRoute(module);

  async function run() {
    setBusy(true);
    setRunError(null);
    try {
      await onRun(module.key);
    } catch (e) {
      setRunError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 12, padding: 16 }}>
      {/* Header: score ring when scored, kicker + status tag otherwise */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {module.scored && (
            <ScoreRing
              value={module.score}
              tone={tone === 'muted' ? 'accent' : tone}
              label={module.scoreBasis
                ? `${module.label}: ${module.score} — ${module.scoreBasis}`
                : `${module.label} score`}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <Kicker>{module.label}</Kicker>
            <span style={{ fontSize: 13, color: 'var(--text)' }}>{module.headline}</span>
            {/* Clamped to two lines so every card in the grid is the same shape
                and the findings below stay visible. The full text is on the
                module's own page, and on hover here. */}
            <span
              title={module.note || module.detail || undefined}
              style={{
                fontSize: 11,
                color: 'var(--text-3)',
                lineHeight: 1.45,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {module.detail}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* An interrupted run is a real caveat, but it is one word, not a
              paragraph. */}
          {module.partial && <Tag tone="warn">Partial</Tag>}
          <Tag tone={tone}>{statusLabel}</Tag>
        </div>
      </div>

      {/* Evidence: severity strip + the findings that make it up */}
      {hasEvidence && module.evidence.counts && (
        <>
          <SeverityBars counts={module.evidence.counts} />
          {module.evidence.topFindings?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {module.evidence.topFindings.map((finding) => (
                <SignalDot
                  key={finding.ruleId}
                  tone={finding.severity === 'error' ? 'neg' : finding.severity === 'warning' ? 'warn' : 'accent'}
                >
                  <span
                    style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: 'var(--text-2)',
                    }}
                    title={`${finding.title} — ${finding.count} URL(s)`}
                  >
                    {finding.title}
                  </span>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-3)', flexShrink: 0 }}>
                    {finding.count}
                  </span>
                </SignalDot>
              ))}
            </div>
          )}
        </>
      )}

      {/* A run that failed: the reason, not just a red tag */}
      {module.error && (
        <div
          style={{
            padding: '9px 11px', borderRadius: 'var(--r-sm)', fontSize: 11.5, lineHeight: 1.5,
            background: 'color-mix(in srgb, var(--viz-neg) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--viz-neg) 32%, transparent)',
            color: 'var(--viz-neg)',
          }}
        >
          {module.error}
        </div>
      )}

      {/* Measured, but this module has no rubric — say so where the ring would be */}
      {hasEvidence && !module.scored && module.evidence?.findingCount > 0 && (
        <Muted size={11}>
          {module.evidence.findingCount} finding{module.evidence.findingCount === 1 ? '' : 's'} stored ·
          this module reports findings, not a 0–100 score
        </Muted>
      )}

      {/* No evidence AND no run: say what would produce some.
          //
          // Gated on 'not_run' rather than on the absence of an evidence block. A
          // module that ran and reported insufficient_data has no evidence either,
          // and showing this alongside its headline produced two sentences that
          // contradicted each other — "the module ran and found nothing" directly
          // above "no stored evidence yet — run it". */}
      {!hasEvidence && module.status === 'not_run' && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--r-sm)',
            background: 'var(--surface)',
            border: '1px dashed var(--border)',
            fontSize: 11.5,
            color: 'var(--text-3)',
            lineHeight: 1.5,
          }}
        >
          {module.runnable
            ? 'No stored evidence for this project yet — run it to populate this card.'
            : module.live
              ? 'No stored evidence for this project yet.'
              : `Runs standalone today. Project-scoped evidence arrives with ${module.pendingPhase || 'a later phase'}.`}
        </div>
      )}

      {runError && (
        <Muted size={11} style={{ color: 'var(--viz-neg)' }}>{runError}</Muted>
      )}

      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, marginTop: 'auto',
        }}
      >
        <Muted>
          {module.updatedAt ? `Updated ${relativeTime(module.updatedAt)}` : 'Never run for this project'}
        </Muted>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {canRun && (
            <Btn
              variant="primary"
              disabled={busy || module.status === 'running'}
              onClick={run}
              style={{ height: 30, fontSize: 12, padding: '0 12px' }}
            >
              {busy || module.status === 'running'
                ? 'Running…'
                : module.updatedAt ? 'Re-run' : 'Run'}
            </Btn>
          )}
          {/* Straight to this module's own report. For the three modules whose
              report lives on a route, that is the route; for the three that
              render it from page state, it is the tool page, whose project panel
              hands the stored run to that page's report view on arrival. Either
              way there is no intermediate page to click through. */}
          <Btn
            variant="secondary"
            onClick={() => navigate(reportRoute.path)}
            style={{ height: 30, fontSize: 12, padding: '0 12px' }}
          >
            {reportRoute.label}
          </Btn>
        </div>
      </div>
    </Card>
  );
}
