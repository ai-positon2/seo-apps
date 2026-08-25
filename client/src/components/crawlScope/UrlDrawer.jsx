// Per-URL detail drawer — the desktop app's openDrawer(), as a component.
// Everything the crawler recorded for one URL, grouped, plus its issue list.

import { Drawer, Badge } from '../../ui';
import { formatBytes, severityVariant, statusVariant, declarativeRefreshSummary, redirectLocationIssueSummary } from './crawlHelpers';

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

export default function UrlDrawer({ result, onClose }) {
  const open = Boolean(result);
  const r = result || {};
  const refresh = declarativeRefreshSummary(r);
  const redirectIssue = redirectLocationIssueSummary(r);

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
