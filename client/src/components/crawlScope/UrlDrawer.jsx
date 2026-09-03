// Per-URL detail drawer — the desktop app's openDrawer(), as a component.
// Everything the crawler recorded for one URL, grouped, plus its issue list.

import { useEffect, useState } from 'react';
import { Drawer, Badge, Button } from '../../ui';
import { formatBytes, severityVariant, statusVariant, declarativeRefreshSummary, redirectLocationIssueSummary } from './crawlHelpers';
import { cs } from '../../lib/crawlScopeApi';

const PSI_POLL_MS = 4000;

function scoreVariant(score) {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 90) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

function fieldVariant(category) {
  if (category === 'FAST') return 'success';
  if (category === 'AVERAGE') return 'warning';
  if (category === 'SLOW') return 'danger';
  return 'neutral';
}

// Server response time as a share of this page's LCP. Past 60% the server
// itself is most of the budget, and no front-end technique below has room
// left to matter — leading with that, not a longer fix list, is the honest
// recommendation at that point.
const TTFB_DOMINANT_THRESHOLD = 0.6;

// Mobile-friendliness, modern-day: Google retired the dedicated Mobile-Friendly
// Test in Dec 2023. PSI's mobile-strategy performance score is the closest
// living equivalent, so it's labeled as exactly that rather than implied to be
// a pass/fail "mobile-friendly" verdict that no longer exists.
function PageSpeedStrategy({ label, strategy }) {
  if (!strategy) return null;
  const ttfbDominant = typeof strategy.ttfbShareOfLcp === 'number' && strategy.ttfbShareOfLcp >= TTFB_DOMINANT_THRESHOLD;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{label}</span>
        <Badge variant={scoreVariant(strategy.score)}>{strategy.score ?? '—'}/100</Badge>
      </div>
      <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontSize: 11 }}>
        <div><span style={{ color: 'var(--text-3)' }}>LCP </span><span style={{ color: 'var(--text)' }}>{strategy.lcp}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>CLS </span><span style={{ color: 'var(--text)' }}>{strategy.cls}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>INP </span><span style={{ color: 'var(--text)' }}>{strategy.inp}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>FCP </span><span style={{ color: 'var(--text)' }}>{strategy.fcp}</span></div>
        <div><span style={{ color: 'var(--text-3)' }}>TTFB </span><span style={{ color: 'var(--text)' }}>{strategy.ttfb}</span></div>
      </div>
      {ttfbDominant && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)', lineHeight: 1.4 }}>
          Server response time is {Math.round(strategy.ttfbShareOfLcp * 100)}% of this page&apos;s LCP.
          Front-end fixes have limited room to help until that comes down — see Slow Server Response.
        </div>
      )}
      {strategy.field && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
              Field data ({strategy.field.scope === 'page' ? 'this page' : 'site-wide'})
            </span>
            {strategy.field.overall && <Badge variant={fieldVariant(strategy.field.overall)}>{strategy.field.overall}</Badge>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(strategy.field.metrics).map(([metric, category]) => (
              <span
                key={metric}
                style={{
                  fontSize: 10.5, padding: '2px 6px', borderRadius: 999,
                  border: '1px solid var(--border)', color: 'var(--text-2)',
                }}
              >
                {metric.toUpperCase()}: {category}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono = false }) {
  if (value === null || value === undefined || value === '' ) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '148px 1fr', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}</span>
      <span style={{
        fontSize: 12.5, color: 'var(--text)', wordBreak: 'break-word',
        fontFamily: mono ? 'var(--font-mono, ui-monospace, monospace)' : undefined,
      }}>
        {value}
      </span>
    </div>
  );
}

function Group({ title, children }) {
  const kids = Array.isArray(children) ? children.filter(Boolean) : children;
  if (!kids || (Array.isArray(kids) && !kids.length)) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }}>
        {title}
      </div>
      {kids}
    </div>
  );
}

export default function UrlDrawer({ result, runId, onClose }) {
  const open = Boolean(result);
  const r = result || {};
  const refresh = declarativeRefreshSummary(r);
  const redirectIssue = redirectLocationIssueSummary(r);

  // Not derived from `results` state in the parent: whether a page's PageSpeed
  // data is fresh depends on when it was checked relative to when the parent's
  // result rows were last loaded, which the drawer has no reliable way to know.
  // So it keeps its own copy, seeded from whatever the parent already has (in
  // case it's already been checked) and always re-checkable from here regardless.
  const [psi, setPsi] = useState(r.pagespeed || null);
  const [psiStatus, setPsiStatus] = useState('idle'); // idle | running | done | error
  const [psiError, setPsiError] = useState('');

  useEffect(() => {
    setPsi(r.pagespeed || null);
    setPsiStatus('idle');
    setPsiError('');
  }, [r.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (psiStatus !== 'running' || !runId || !r.url) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const status = await cs.pageSpeedStatus(runId, r.url);
        if (cancelled) return;
        if (status.status === 'done') {
          setPsi(status.pagespeed || null);
          setPsiStatus('done');
        } else if (status.status === 'error') {
          setPsiError(status.error || 'PageSpeed check failed.');
          setPsiStatus('error');
        }
      } catch { /* transient — keep polling */ }
    }, PSI_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [psiStatus, runId, r.url]);

  async function checkPageSpeed() {
    setPsiStatus('running');
    setPsiError('');
    try {
      await cs.checkPageSpeed(runId, r.url);
    } catch (e) {
      setPsiError(e.message);
      setPsiStatus('error');
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="URL detail" width={620}>
      {open && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: 'var(--primary-text, var(--primary))', wordBreak: 'break-all' }}
            >
              {r.url}
            </a>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <Badge variant={statusVariant(r.status)}>{r.status || '—'} {r.statusText || ''}</Badge>
              <Badge variant={r.indexability === 'Indexable' ? 'success' : 'neutral'}>
                {r.indexability || 'Unknown'}
              </Badge>
              {r.issues?.length ? <Badge variant="warning">{r.issues.length} issue{r.issues.length === 1 ? '' : 's'}</Badge> : null}
            </div>
          </div>

          <Group title="Response">
            <Row label="Status" value={r.status ? `${r.status} ${r.statusText || ''}`.trim() : null} />
            <Row label="Content type" value={r.contentType} />
            <Row label="Size" value={r.size ? formatBytes(r.size) : null} />
            <Row label="Response time" value={r.responseTime ? `${r.responseTime} ms` : null} />
            <Row label="Redirect to" value={r.redirectUrl || redirectIssue || null} mono />
            <Row label="Timed refresh" value={refresh || null} />
            <Row label="Discovered from" value={r.sourceUrl} mono />
            <Row label="Crawl depth" value={r.depth} />
          </Group>

          <Group title="Indexability">
            <Row label="Indexability" value={r.indexability} />
            <Row label="Detail" value={r.indexabilityStatus} />
            <Row label="Robots directives" value={r.robotsDirectives || r.metaRobots} mono />
            <Row label="X-Robots-Tag" value={r.xRobotsTag} mono />
            <Row label="Canonical" value={r.canonical} mono />
          </Group>

          <Group title="Content">
            <Row label="Category" value={r.pageCategory} />
            <Row label="Page title" value={r.title} />
            <Row label="Title length" value={r.titleLength} />
            <Row label="Meta description" value={r.metaDescription} />
            <Row label="Meta length" value={r.metaLength} />
            <Row label="H1" value={r.h1} />
            <Row label="H1 count" value={r.h1Count} />
            <Row label="H2 count" value={r.h2Count} />
            <Row label="Word count" value={r.words} />
            <Row label="Language" value={r.language} />
          </Group>

          <Group title="Links">
            <Row label="Inlinks" value={r.inlinks} />
            <Row label="Outlinks" value={r.outlinks} />
            <Row label="External links" value={r.externalLinks} />
          </Group>

          {r.url && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                  Page Speed
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={psiStatus === 'running'}
                  onClick={checkPageSpeed}
                  disabled={!runId}
                >
                  {psi ? 'Recheck' : 'Check PageSpeed'}
                </Button>
              </div>

              {psiStatus === 'running' && (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  Running Lighthouse for this page (mobile + desktop) — this can take up to a minute…
                </div>
              )}
              {psiStatus === 'error' && (
                <div style={{ fontSize: 12, color: 'var(--danger)' }}>{psiError}</div>
              )}

              {psi && (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <PageSpeedStrategy label="Mobile" strategy={psi.mobile} />
                    <PageSpeedStrategy label="Desktop" strategy={psi.desktop} />
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Badge variant={psi.coreWebVitalsPassed ? 'success' : 'warning'}>
                      {psi.coreWebVitalsPassed ? 'Core Web Vitals: passing' : 'Core Web Vitals: not passing'}
                    </Badge>
                    {psi.checkedAt && (
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        Checked {new Date(psi.checkedAt).toLocaleString()}{psi.auto ? ' (auto)' : ''}
                      </span>
                    )}
                  </div>
                  {psi.fixes?.length ? (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
                        Make this page lighter
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {psi.fixes.map((fix) => (
                          <div key={fix.id} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{fix.title}</span>
                              <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                {[
                                  fix.savingsMs ? `~${(fix.savingsMs / 1000).toFixed(1)}s` : null,
                                  fix.savingsBytes ? `~${formatBytes(fix.savingsBytes)}` : null,
                                ].filter(Boolean).join(' · ')}
                              </span>
                            </div>
                            {fix.description && (
                              <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.4 }}>{fix.description}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {!psi && psiStatus === 'idle' && (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Not checked yet.</div>
              )}
            </div>
          )}

          {r.issues?.length ? (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 8 }}>
                Issues ({r.issues.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {r.issues.map((issue, i) => (
                  <div
                    key={`${issue.id}-${i}`}
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}
                  >
                    <Badge variant={severityVariant(issue.severity)}>{issue.severity}</Badge>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{issue.label}</div>
                      {issue.detail ? (
                        <div style={{ fontSize: 11.5, color: 'var(--text-3)', wordBreak: 'break-word' }}>{issue.detail}</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
