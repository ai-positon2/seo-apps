import { Card } from '../../ui/Card';
import { ScoreRing } from '../../ui/ScoreRing';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { domainLabel, isPageSpeedUsable } from './utils';

function hasUsableScore(strategy) {
  return !!strategy && typeof strategy.score === 'number';
}

function StrategyRow({ label, data }) {
  if (!hasUsableScore(data)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%', border: '2px dashed var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)',
        }}>
          N/A
        </div>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)' }}>{label}</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <ScoreRing score={data.score} size={64} label={label} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', textAlign: 'center' }}>
        <span>LCP {data.lcp}</span>
        <span>CLS {data.cls}</span>
        <span>INP {data.inp}</span>
      </div>
    </div>
  );
}

const SPEED_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
    <path d="M12 3a9 9 0 00-9 9c0 2.4.94 4.58 2.47 6.2" />
    <path d="M21 12a9 9 0 00-4.5-7.8" />
    <path d="M12 12l4-3" />
  </svg>
);

const CHECK_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

function FixesList({ fixes }) {
  if (!fixes || fixes.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--success)' }}>
        {CHECK_ICON}
        <span style={{ fontSize: 13 }}>No major performance issues found — this domain is in good shape.</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {fixes.map((fix, i) => (
        <div key={fix.id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{fix.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>{fix.description}</div>
          </div>
          {fix.savingsMs != null && (
            <Badge variant="warning" style={{ flexShrink: 0, alignSelf: 'flex-start' }}>~{(fix.savingsMs / 1000).toFixed(1)}s</Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function fetchedAgo(iso) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

// Core Web Vitals come from Chrome's real-user data over 28 days; the scores
// above are one lab test. They can disagree (a site can pass for real users and
// score 31 in the lab), so the badge says which measurement it is. Snapshots
// taken before `coreWebVitalsCategory` existed only carry the boolean.
const CWV_LABEL = {
  FAST: { text: 'Real users: Core Web Vitals passed', variant: 'success' },
  AVERAGE: { text: 'Real users: Core Web Vitals need work', variant: 'warning' },
  SLOW: { text: 'Real users: Core Web Vitals failed', variant: 'danger' },
};

function CwvVerdict({ pageSpeed }) {
  const hasCategoryField = Object.prototype.hasOwnProperty.call(pageSpeed, 'coreWebVitalsCategory');
  const known = CWV_LABEL[pageSpeed.coreWebVitalsCategory];
  const v = known
    || (hasCategoryField
      ? { text: 'No real-user data from Google yet', variant: 'neutral' }
      : pageSpeed.coreWebVitalsPassed
        ? CWV_LABEL.FAST
        : { text: 'Real users: Core Web Vitals not passed', variant: 'danger' });
  return (
    <span title="From Google's Chrome UX Report: how real visitors experienced the site over the last 28 days. The scores above are a single lab test.">
      <Badge variant={v.variant}>{v.text}</Badge>
    </span>
  );
}

function RefreshButton({ running, disabled, onRun }) {
  return (
    <button
      onClick={onRun}
      disabled={running || disabled}
      title={disabled ? 'Wait for the current full analysis to finish' : 'Re-check Core Web Vitals — this does not spend SEMrush units'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 14px', borderRadius: 'var(--r-lg)', border: '1px solid var(--border-strong)',
        background: running ? 'var(--surface)' : 'var(--card)',
        color: running || disabled ? 'var(--text-3)' : 'var(--text)',
        fontSize: 13, fontWeight: 600, cursor: running || disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {running && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" style={{ animation: 'spin 0.8s linear infinite' }}>
          <path d="M21 12a9 9 0 11-9-9" />
        </svg>
      )}
      {running ? 'Refreshing…' : 'Refresh Page Speed'}
    </button>
  );
}

export default function PageSpeedTab({ snapshot, running = false, disabled = false, onRun, pageSpeedEnabled = true }) {
  const domains = snapshot?.domains || [];

  if (!domains.length) {
    return <EmptyState icon={SPEED_ICON} title="No data yet" description="Run an analysis to see Page Speed scores." />;
  }

  const hasUsableData = domains.some((d) => isPageSpeedUsable(d.pageSpeed));

  // Intentional single empty state for the whole tab rather than one dead
  // card per competitor. Three distinct cases, checked in order: a
  // background fetch actively in flight (most common right after a fresh
  // "Run Analysis", since Page Speed is no longer fetched inline) always
  // wins over the other two, since a stale "not connected" message would be
  // actively misleading while a fetch is already running with a valid key.
  if (!hasUsableData) {
    let empty;
    if (running) {
      empty = (
        <EmptyState
          icon={SPEED_ICON}
          title="Fetching Page Speed…"
          description="This runs in the background and can take a few minutes, especially if Google's rate limit is hit. The rest of the dashboard is ready to use in the meantime."
        />
      );
    } else if (!pageSpeedEnabled) {
      empty = (
        <EmptyState
          icon={SPEED_ICON}
          title="Page Speed isn't connected yet"
          description="Add a GOOGLE_PSI_API_KEY to enable this. Once connected, each domain will show a 0-100 performance gauge plus LCP / INP / CLS for mobile and desktop."
        />
      );
    } else {
      empty = (
        <EmptyState
          icon={SPEED_ICON}
          title="Page Speed data unavailable for this run"
          description="PageSpeed Insights is connected — this can take a few minutes when Google's rate limit is hit, since a failed check retries automatically. Check back shortly, or refresh manually."
        />
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <RefreshButton running={running} disabled={disabled} onRun={onRun} />
        </div>
        {empty}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Refreshing Page Speed does not spend SEMrush units.</span>
        <RefreshButton running={running} disabled={disabled} onRun={onRun} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {domains.map((d) => {
          const usable = isPageSpeedUsable(d.pageSpeed);
          const ago = fetchedAgo(d.pageSpeedFetchedAt);
          return (
            <Card
              key={d.domain}
              title={domainLabel(d)}
              actions={d.isClient ? <Badge variant="brand">Client</Badge> : null}
            >
              {usable ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 28 }}>
                    <StrategyRow label="Mobile" data={d.pageSpeed.mobile} />
                    <StrategyRow label="Desktop" data={d.pageSpeed.desktop} />
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <CwvVerdict pageSpeed={d.pageSpeed} />
                    {ago && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>Checked {ago}</span>}
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 12, color: 'var(--text-3)' }}>
                  {d.pageSpeed?.strategyErrors?.mobile?.message
                    || d.pageSpeed?.strategyErrors?.desktop?.message
                    || d.pageSpeed?.error
                    || 'Not available for this domain.'}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>Fixes & Recommendations</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {domains.filter((d) => isPageSpeedUsable(d.pageSpeed)).map((d) => (
            <Card key={`${d.domain}-fixes`} title={domainLabel(d)} actions={d.isClient ? <Badge variant="brand">Client</Badge> : null}>
              <FixesList fixes={d.pageSpeed.fixes} />
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
