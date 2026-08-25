// One crawl: live progress while it runs, then the full result set.
//
// The stream is the same SSE endpoint for a running and a finished crawl — it
// tails the database rather than the crawler, so a run executed by the worker in
// another process is watchable here exactly like a manual one. EventSource sends
// the session cookie itself and replays from Last-Event-ID on reconnect, so a
// dropped connection resumes rather than restarting.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  SectionHeader, Card, Button, Badge, MetricCard, EmptyState, useToast,
} from '../ui';
import ModuleRuns from '../components/ModuleRuns';
import ResultsTable from '../components/crawlScope/ResultsTable';
import UrlDrawer from '../components/crawlScope/UrlDrawer';
import {
  healthMetrics, healthScoreExplanation, issueGroups, severityVariant,
  runStatusVariant, formatDuration, toCsv, TERMINAL_STATUSES,
} from '../components/crawlScope/crawlHelpers';
import { cs, saveBlob } from '../lib/crawlScopeApi';

export default function CrawlScopeRunPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [findings, setFindings] = useState([]);
  const [progress, setProgress] = useState({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [issueFilter, setIssueFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [downloading, setDownloading] = useState(false);

  // Results arrive one event at a time and a large crawl is thousands of rows,
  // so they accumulate in a ref and are flushed to state on a timer. Setting
  // state per event would re-render the table on every URL.
  const pending = useRef([]);
  const flushTimer = useRef(null);
  const seenUrls = useRef(new Set());

  const flush = useCallback(() => {
    if (!pending.current.length) return;
    const batch = pending.current;
    pending.current = [];
    setResults((prev) => [...prev, ...batch]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { run: r } = await cs.run(id);
        if (cancelled) return;
        setRun(r);
        setStatus(r.status);
        setProgress(r.progress || {});
        // A finished crawl has its findings (with any review state) ready; a
        // running one has none yet, and gets them from the complete event.
        if (TERMINAL_STATUSES.includes(r.status)) {
          const f = await cs.findings(id);
          if (!cancelled) setFindings(f.findings || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const source = new EventSource(cs.streamUrl(id), { withCredentials: true });

    source.addEventListener('state', (e) => {
      try { setStatus(JSON.parse(e.data).state); } catch { /* ignore */ }
    });

    source.addEventListener('result', (e) => {
      try {
        const row = JSON.parse(e.data);
        // The stream can replay from Last-Event-ID after a reconnect, so the
        // same URL may arrive twice; keep the first.
        if (row?.url && seenUrls.current.has(row.url)) return;
        if (row?.url) seenUrls.current.add(row.url);
        pending.current.push(row);
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(() => { flushTimer.current = null; flush(); }, 400);
        }
      } catch { /* ignore */ }
    });

    source.addEventListener('progress', (e) => {
      try { setProgress(JSON.parse(e.data) || {}); } catch { /* ignore */ }
    });

    source.addEventListener('complete', (e) => {
      flush();
      try {
        const payload = JSON.parse(e.data);
        setStatus(payload.status);
        setRun((prev) => (prev ? { ...prev, status: payload.status, summary: payload.summary, error: payload.error } : prev));
        if (payload.error) toast.error(payload.error);
      } catch { /* ignore */ }
      // Findings only exist once the crawl has written its summary.
      cs.findings(id).then((f) => setFindings(f.findings || [])).catch(() => {});
      source.close();
    });

    source.addEventListener('error', (e) => {
      // A server-sent `error` event carries a message; a transport error does
      // not, and EventSource reconnects on its own — so only the former is worth
      // showing.
      if (e.data) {
        try { setError(JSON.parse(e.data).message); } catch { /* ignore */ }
        source.close();
      }
    });

    return () => {
      source.close();
      if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
      flush();
    };
  }, [id, flush, toast]);

  // ── Pages of THIS site, and the external URLs it links out to ────────────
  //
  // The crawler fetches the external pages a site links to so it can report a
  // broken outbound link. Those are evidence, not pages of the site: no check in
  // analyzer.js ever runs on them, so an external URL never gets a long-title or
  // missing-title finding, and it must not appear in a table of "your pages"
  // either — listing 36 of somebody else's URLs among 50 of yours makes the
  // audit look like it is auditing the whole internet.
  //
  // The findings that DO concern an external URL — broken-external-link,
  // external-403 — are attached to the internal page carrying the link, with the
  // external address in targetUrl. Those stay, because they are defects on your
  // page: the link you shipped is broken.
  //
  // On the live project this is 50 internal pages against 36 external fetches.
  const pages = useMemo(() => results.filter((r) => r.scope !== 'External'), [results]);
  const externalChecked = results.length - pages.length;

  const metrics = useMemo(() => healthMetrics(pages, findings), [pages, findings]);
  const groups = useMemo(() => issueGroups(pages, findings), [pages, findings]);
  const running = !TERMINAL_STATUSES.includes(status);

  async function control(action) {
    setBusy(action);
    try {
      await cs[action](id);
      toast.success(`Crawl ${action === 'stop' ? 'stopping' : `${action}d`}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  function exportCsv() {
    // The export is the table, so it carries the same rows the table shows.
    if (!pages.length) return;
    const host = (() => { try { return new URL(run?.url || '').hostname; } catch { return 'crawl'; } })();
    saveBlob(new Blob([toCsv(pages)], { type: 'text/csv;charset=utf-8' }), `${host}-crawl.csv`);
  }

  async function downloadWorkbook() {
    setDownloading(true);
    try {
      const { blob, filename } = await cs.downloadReport(id);
      saveBlob(blob, filename);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return <main style={{ padding: '28px 32px' }}><EmptyState title="Loading crawl…" /></main>;
  }

  if (error && !run) {
    return (
      <main style={{ padding: '28px 32px' }}>
        <EmptyState
          title="Could not open this crawl"
          description={error}
          action={<Button onClick={() => navigate('/crawl-scope')}>Back to CrawlScope</Button>}
        />
      </main>
    );
  }

  const elapsed = progress.elapsed
    ?? (run?.finished_at && (run.started_at || run.created_at)
      ? new Date(run.finished_at) - new Date(run.started_at || run.created_at)
      : 0);

  return (
    <main style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeader
        title={run?.url || 'Crawl'}
        subtitle={`Started ${new Date(run?.started_at || run?.created_at).toLocaleString()}`}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => navigate('/crawl-scope')}>All crawls</Button>
            {running ? (
              <>
                <Button variant="secondary" loading={busy === 'pause'} onClick={() => control('pause')}>Pause</Button>
                <Button variant="secondary" loading={busy === 'resume'} onClick={() => control('resume')}>Resume</Button>
                <Button variant="secondary" loading={busy === 'stop'} onClick={() => control('stop')}>Stop</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => navigate(`/crawl-scope/runs/${id}/review`)}>
                  Issue review{findings.length ? ` (${findings.length})` : ''}
                </Button>
                <Button loading={downloading} onClick={downloadWorkbook}>Download Excel audit</Button>
              </>
            )}
          </div>
        }
      />

      {error && (
        <Card style={{ borderColor: 'var(--danger)' }}>
          <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
        </Card>
      )}

      {/* Status + progress */}
      <Card>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge variant={runStatusVariant(status)}>{status}</Badge>
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            {progress.crawled ?? results.length} crawled
            {progress.queued ? ` · ${progress.queued} queued` : ''}
            {elapsed ? ` · ${formatDuration(elapsed)} elapsed` : ''}
          </span>
          {run?.summary?.robotsStatus && (
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>robots.txt: {run.summary.robotsStatus}</span>
          )}
        </div>
        {running && (
          <div style={{ marginTop: 12, height: 6, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, Math.round(((progress.crawled || 0) / Math.max(1, (progress.crawled || 0) + (progress.queued || 0))) * 100))}%`,
                background: 'var(--primary)',
                transition: 'width 300ms ease',
              }}
            />
          </div>
        )}
        {run?.error && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--danger)' }}>{run.error}</div>
        )}
      </Card>

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {/* Pages of this site and external URLs checked are separate figures,
            the same way the Tech Audit card reports them. One number covering
            both answers neither question. */}
        <MetricCard label="Pages crawled" value={pages.length.toLocaleString()} />
        <MetricCard label="HTML pages" value={metrics.htmlCount.toLocaleString()} />
        <MetricCard
          label="External URLs checked"
          value={externalChecked.toLocaleString()}
        />
        <div title={healthScoreExplanation(metrics)}>
          <MetricCard
            label="Site health"
            value={metrics.health === null ? '—' : `${metrics.health}%`}
            sub="Hover for the breakdown"
          />
        </div>
        <MetricCard label="Errors" value={metrics.errors.toLocaleString()} sub={`${metrics.affectedErrorPages} page(s)`} />
        <MetricCard label="Warnings" value={metrics.warnings.toLocaleString()} sub={`${metrics.affectedWarningPages} page(s)`} />
        <MetricCard label="Indexable" value={metrics.indexable.toLocaleString()} sub={`of ${metrics.htmlCount} HTML`} />
      </div>

      {/* Issue overview */}
      {groups.length > 0 && (
        <Card title={`Issues found (${groups.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setIssueFilter(issueFilter === g.id ? '' : g.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  border: `1px solid ${issueFilter === g.id ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--r-md)', background: issueFilter === g.id ? 'var(--primary-soft)' : 'transparent',
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <Badge variant={severityVariant(g.severity)}>{g.severity}</Badge>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.label}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>
                  {g.urls.length} URL{g.urls.length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Results — this site's pages only. */}
      <Card title="Pages on this site">
        <ResultsTable
          results={pages}
          issueFilter={issueFilter}
          onClearIssueFilter={() => setIssueFilter('')}
          onRowClick={setSelected}
          onExportCsv={exportCsv}
        />
        {externalChecked > 0 && (
          // Said out loud rather than left as a discrepancy between "86 crawled"
          // in one place and 50 rows here.
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.45 }}>
            {externalChecked} external URL{externalChecked === 1 ? ' was' : 's were'} also fetched to
            check the outbound links on these pages. They are not pages of this site, so they are not
            listed here and are not counted in Site health — a broken one appears as a finding on the
            page that links to it.
          </div>
        )}
      </Card>

      <UrlDrawer result={selected} onClose={() => setSelected(null)} />

      {/* Scoped to this run: the label the server records is `run <id>`. */}
      <ModuleRuns
        toolId="crawl-scope"
        title="Runs for this crawl"
        search={`run ${id}`}
        scopeNote="Report exports for this crawl"
      />
    </main>
  );
}
