import { AlertRow, Tag, Muted } from './primitives';
import { relativeTime } from '../../lib/projectsApi';

// ── Alerts ──────────────────────────────────────────────────────────────────
// Everything here is derived from stored crawl evidence — a failed run, or the
// error- and warning-severity findings of the most recent terminal crawl, ranked
// by how many URLs each affects. Nothing is synthesized, so "no alerts" is a
// real statement about the last crawl rather than an unimplemented panel.

export default function AlertsPanel({ alerts, hasCrawled }) {
  const open = alerts.length;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h6
          style={{
            margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Alerts
        </h6>
        {open > 0
          ? <Tag tone="neg">{open} open</Tag>
          : <Tag tone="accent">Clear</Tag>}
      </div>

      {open === 0 ? (
        <div
          style={{
            padding: 16,
            borderRadius: 'var(--r-md)',
            background: 'var(--card)',
            border: '1px dashed var(--border)',
          }}
        >
          <Muted size={12.5}>
            {hasCrawled
              ? 'The last crawl produced no error- or warning-level findings.'
              : 'No crawl has completed for this project yet, so there is nothing to report. Alerts are derived from crawl findings.'}
          </Muted>
        </div>
      ) : (
        alerts.map((alert, index) => (
          <AlertRow
            key={`${alert.source}-${alert.ruleId || alert.runId || index}`}
            severity={alert.severity}
            title={alert.title}
            detail={alert.detail}
            at={alert.at ? relativeTime(alert.at) : null}
          />
        ))
      )}
    </section>
  );
}
