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
import { useAuth } from '../context/AuthContext';
import ModuleRuns from '../components/ModuleRuns';
import ResultsTable from '../components/crawlScope/ResultsTable';
import MediaLibrary from '../components/crawlScope/MediaLibrary';
import SeoSnapshotGrid from '../components/crawlScope/SeoSnapshotGrid';
import IssuesFoundSection from '../components/crawlScope/IssuesFoundSection';
import SiteFindingsSection from '../components/crawlScope/SiteFindingsSection';
import SiteHealthCard from '../components/crawlScope/SiteHealthCard';
import SeverityCompositionBar from '../components/crawlScope/charts/SeverityCompositionBar';
import IssueConcentrationChart from '../components/crawlScope/charts/IssueConcentrationChart';
import IntegrationsAdoptionChart from '../components/crawlScope/charts/IntegrationsAdoptionChart';
import BacklogSection from '../components/crawlScope/BacklogSection';
import ExecutiveSummary from '../components/crawlScope/ExecutiveSummary';
import IntegrationsSection from '../components/crawlScope/IntegrationsSection';
import UrlDrawer from '../components/crawlScope/UrlDrawer';
import {
  healthMetrics, issueGroups, buildSeoSnapshot,
  runStatusVariant, formatDuration, toCsv, TERMINAL_STATUSES, withEffectiveIssues,
  buildCountHierarchy, siteScopedGroups, buildBacklog,
  BACKLOG_HISTORY_WINDOW,
} from '../components/crawlScope/crawlHelpers';
import { cs, saveBlob } from '../lib/crawlScopeApi';

// A small uppercase label to chunk the main column into named zones — health
// at a glance, then the findings breakdown, then the verification math —
// rather than one undifferentiated stack of cards. Purely visual grouping;
// nothing here changes what's shown, only how it reads.
function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: 'var(--text-3)',
    }}
    >
      {children}
    </div>
  );
}

export default function CrawlScopeRunPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { email } = useAuth();

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
  // Static reference data (id -> {category, description, recommendation}), fetched
  // once and never scoped to this run — it's what puts "a little bit of detail" on
  // an issue card beyond the bare title a rule id alone would give you.
  const [catalog, setCatalog] = useState([]);

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
    cs.catalog().then(setCatalog).catch(() => {});
  }, []);

  // ── Crawl history, for the Backlog section ──────────────────────────────
  // Only a scheduled project has other runs to compare against — a one-off
  // crawl's project_id is null and this simply never fires for one. A bounded
  // window of the project's own prior completed runs (oldest report first, up
  // to BACKLOG_HISTORY_WINDOW back), each with its findings fetched the same
  // way this page fetches its own — there is no cheaper server-side source
  // for a per-check history today; see buildBacklog in crawlHelpers.js.
  const [historyRuns, setHistoryRuns] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!run?.project_id || !TERMINAL_STATUSES.includes(status)) {
      setHistoryRuns([]);
      return undefined;
    }
    setHistoryLoading(true);
    (async () => {
      try {
        const { runs: projectRuns } = await cs.runs({ projectId: run.project_id, limit: 20 });
        const priorCompleted = (projectRuns || [])
          .filter((r) => r.id !== id && r.status === 'completed'
            && new Date(r.created_at) < new Date(run.created_at))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, BACKLOG_HISTORY_WINDOW);
        const withFindings = await Promise.all(
          priorCompleted.map(async (r) => {
            try {
              const { findings: f } = await cs.findings(r.id);
              return { id: r.id, finishedAt: r.finished_at || r.created_at, findings: f || [] };
            } catch {
              return null; // one bad fetch shouldn't blank out the whole comparison
            }
          }),
        );
        if (!cancelled) setHistoryRuns(withFindings.filter(Boolean));
      } catch {
        if (!cancelled) setHistoryRuns([]);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [run?.project_id, run?.created_at, status, id]);

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

  // `pages` still carries each page's crawl-time quickIssues() `.issues` — a
  // smaller, separate detection pass from the full analyzer catalog in
  // `findings`. Once findings exist (post-crawl), every issue-bearing view
  // reads THIS instead, so the table, the drawer, and the SEO snapshot never
  // show a different issue set than "Issue review" and the Excel export do.
  const effectivePages = useMemo(() => withEffectiveIssues(pages, findings), [pages, findings]);

  const metrics = useMemo(() => healthMetrics(effectivePages, findings), [effectivePages, findings]);
  const groups = useMemo(() => issueGroups(effectivePages, findings), [effectivePages, findings]);
  const siteGroups = useMemo(() => siteScopedGroups(findings), [findings]);
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const seoSnapshot = useMemo(
    () => buildSeoSnapshot(effectivePages, groups, catalog),
    [effectivePages, groups, catalog],
  );
  const counts = useMemo(
    () => buildCountHierarchy(results, effectivePages, metrics, groups, siteGroups),
    [results, effectivePages, metrics, groups, siteGroups],
  );
  const backlog = useMemo(() => buildBacklog(findings, historyRuns), [findings, historyRuns]);
  // One bag of everything the Quick summary card's copy formats are built
  // from — see ExecutiveSummary.jsx and its buildEmailShareText /
  // buildChannelShareText / buildTaskTableTsv / buildExecutiveSummaryText
  // builders in crawlHelpers.js. Passed as one object rather than growing
  // the component's prop list to eight individual values.
  const summaryCtx = useMemo(
    () => ({ run, id, metrics, counts, seoSnapshot, groups, siteGroups, backlog, email }),
    [run, id, metrics, counts, seoSnapshot, groups, siteGroups, backlog, email],
  );
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
    if (!effectivePages.length) return;
    const host = (() => { try { return new URL(run?.url || '').hostname; } catch { return 'crawl'; } })();
    saveBlob(new Blob([toCsv(effectivePages)], { type: 'text/csv;charset=utf-8' }), `${host}-crawl.csv`);
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

  // Start a fresh crawl of this same site right now, independent of any
  // schedule — a project's run reuses the project (queued for the worker,
  // same as its own "Run now"); a one-off run just starts again with the
  // same url/options it was created with (repeating a list crawl's exact
  // URL list too, since `options.urls` rode along on the original request).
  // Always lands on the NEW run's own page — this run's page keeps showing
  // this run.
  async function recrawl() {
    setBusy('recrawl');
    try {
      const { run: started } = run.project_id
        ? await cs.runProjectNow(run.project_id)
        : await cs.startRun(
          Array.isArray(run.options?.urls) && run.options.urls.length
            ? { urls: run.options.urls, options: run.options }
            : { url: run.url, options: run.options },
        );
      toast.success('Crawl started.');
      navigate(`/crawl-scope/runs/${started.id}`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
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
    <main style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
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
                  {/* Same reconciled, active-occurrence count the strip and
                      cards below use — not raw findings.length, which also
                      counts findings already marked Resolved/False positive.
                      The review page itself still lists those; only this
                      button's number changed. */}
                  Issue review{counts.occurrences ? ` (${counts.occurrences})` : ''}
                </Button>
                {/* Available on any finished run, scheduled or one-off —
                    the most direct way to get a fresh crawl (new checks,
                    updated content, or just to see this build's latest
                    detections) without leaving the page. */}
                <Button variant="secondary" loading={busy === 'recrawl'} onClick={recrawl}>
                  Recrawl now
                </Button>
                {/* Only for a one-off run (no project_id) — a run that's
                    already part of a scheduled project doesn't need this
                    prompt again. This is the only path from "I just saw this
                    report" to actually setting up a recurring schedule; the
                    New Crawl form that started most runs has zero mention of
                    scheduling anywhere in it. */}
                {!run?.project_id && run?.url && (
                  <Button
                    variant="secondary"
                    onClick={() => navigate('/crawl-scope', {
                      state: {
                        scheduleUrl: run.url,
                        // The new schedule defaults to this crawl's own
                        // day/time — the first report already generated —
                        // rather than an arbitrary fixed slot.
                        scheduleAt: run.started_at || run.created_at,
                      },
                    })}
                  >
                    Schedule this crawl to repeat
                  </Button>
                )}
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

      {/* Quick summary — the whole page in a few dozen lines, structured for
          a one-click copy into an email or a doc. Sits under the crawl
          status, above the detailed layout, so it's the first thing read
          after "is this even done yet." */}
      {!running && pages.length > 0 && <ExecutiveSummary ctx={summaryCtx} />}

      {/* Two columns: a detailed left pane (root-cause findings, the full
          scored SEO snapshot, the media asset table — the SEO-lead/
          implementer working view) and a lean main column (a CXO glance,
          then the page table). Wraps to stacked under a narrow viewport via
          plain flex-wrap — no new responsive framework. */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Left pane — detailed ── */}
        <div style={{ flex: '0 0 380px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <SectionLabel>Detailed findings</SectionLabel>
          <SiteFindingsSection groups={siteGroups} catalogById={catalogById} />

          {/* Full scored quadrants with per-item descriptions — the main
              column gets a compact summary of the same data instead. */}
          {catalog.length > 0 && pages.length > 0 && (
            <Card title="SEO snapshot">
              <SeoSnapshotGrid snapshot={seoSnapshot} />
            </Card>
          )}

          <IssuesFoundSection
            groups={groups}
            catalogById={catalogById}
            issueFilter={issueFilter}
            onToggleIssueFilter={(id) => setIssueFilter((current) => (current === id ? '' : id))}
          />

          {/* Media library — only meaningful once the crawl has actually
              finished: run.summary is written once, on completion, same as
              findings. */}
          {run?.summary?.mediaLibrary && (
            <MediaLibrary mediaLibrary={run.summary.mediaLibrary} />
          )}
        </div>

        {/* ── Main column — CXO glance ── */}
        <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 28 }}>
          {/* Zone 1 — the glance: health, severity mix, and the scored
              quadrants. What a CXO reads and stops. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SectionLabel>Overview</SectionLabel>
            {/* Site health carries real extra structure of its own — a
                budget bar and an expandable breakdown — that a plain
                MetricCard doesn't. Sharing a grid row with two one-line
                stat tiles made it visibly taller than its neighbors, which
                read as misaligned rather than as "this one card just has
                more in it." Its own row avoids the mismatch outright
                instead of forcing three different shapes to look equal. */}
            <SiteHealthCard metrics={metrics} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              <MetricCard
                label="External URLs checked"
                value={externalChecked.toLocaleString()}
                sub="fetched to verify outbound links"
              />
              <MetricCard label="Indexable" value={metrics.indexable.toLocaleString()} sub={`of ${metrics.htmlCount} HTML`} />
            </div>

            <SeverityCompositionBar
              metrics={metrics}
              siteOccurrences={counts.siteOccurrences}
              resourceOccurrences={counts.resourceOccurrences}
              templateOccurrences={counts.templateOccurrences}
            />
          </div>

          {/* Zone 2 — what's actually wrong, and whether it's new or stale.
              The SEO snapshot's own detail (with per-item descriptions) lives
              once, in the pane's "SEO snapshot" card — a compact repeat of
              the same four counts here read as the same fact said twice, so
              it isn't duplicated in this zone. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <SectionLabel>Findings breakdown</SectionLabel>
            <IssueConcentrationChart groups={groups} totalOccurrences={counts.occurrences} />
            <IntegrationsAdoptionChart integrations={run?.summary?.integrations} />
            {run?.project_id && <BacklogSection backlog={backlog} loading={historyLoading} />}
          </div>

          {/* Zone 3 — trust-building detail for whoever wants to verify the
              numbers above, not the headline. */}
          {(pages.length > 0 || results.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SectionLabel>Verification</SectionLabel>
              {/* Count reconciliation — one coherent hierarchy instead of
                  several numbers that look related but are different units
                  of different things (a crawled-URL count, a page count, an
                  occurrence count, and a distinct-check count all used to be
                  shown side by side with no stated relationship).
                  `reconciled` is a real assertion, computed two independent
                  ways in buildCountHierarchy — this fails loudly rather than
                  silently disagreeing if it's ever wrong. */}
              <Card title="Count reconciliation">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <MetricCard label="URLs fetched" value={counts.urlsFetched.toLocaleString()} />
                  <span aria-hidden style={{ color: 'var(--text-3)', fontSize: 16 }}>→</span>
                  <MetricCard label="HTML pages" value={counts.htmlPages.toLocaleString()} sub="the audit universe" />
                  <span aria-hidden style={{ color: 'var(--text-3)', fontSize: 16 }}>→</span>
                  <MetricCard label="Occurrences" value={counts.occurrences.toLocaleString()} sub="every page × check hit" />
                  <span aria-hidden style={{ color: 'var(--text-3)', fontSize: 16 }}>→</span>
                  <MetricCard
                    label="Issue types"
                    value={counts.issueTypes.toLocaleString()}
                    sub="= root-cause groups, for now"
                  />
                </div>
                <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                  {(counts.urlsFetched - counts.htmlPages).toLocaleString()} of the fetched URLs are external
                  links this site points to, or non-HTML assets (images, scripts, stylesheets, PDFs) — not
                  part of the audit universe. Issue types and root-cause groups are the same number in this
                  build: nothing yet consolidates several related checks into one fix action.
                  {(counts.siteOccurrences + counts.resourceOccurrences + counts.templateOccurrences) > 0 && (
                    <>
                      {' '}"Occurrences" above counts page-level findings only — {counts.siteOccurrences}{' '}
                      site-level, {counts.resourceOccurrences} resource-level, and {counts.templateOccurrences}{' '}
                      template-level finding(s) are never added into it (see Site-level findings in the pane), so
                      a whole-site issue can't inflate a per-page count or get silently dropped by one.
                    </>
                  )}
                </div>
                {!counts.reconciled && (
                  <div style={{
                    marginTop: 8, padding: '8px 10px', background: 'var(--danger-soft)', color: 'var(--danger)',
                    borderRadius: 'var(--r-md)', fontSize: 12, fontWeight: 600,
                  }}
                  >
                    Counts disagree: {counts.occurrencesByCheck.toLocaleString()} occurrences summed by check
                    vs {counts.occurrencesByPage.toLocaleString()} summed by page. The figures on this page are
                    not trustworthy until this is fixed — please report it.
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* Results — this site's pages only. */}
          <Card title="Pages on this site">
            <ResultsTable
              results={effectivePages}
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
        </div>
      </div>

      {/* Full-width, not inside either column — a site-wide inventory, not a
          glance or a detail-pane item. Renders nothing until there's
          something detected. */}
      <IntegrationsSection integrations={run?.summary?.integrations} />

      <UrlDrawer result={selected} runId={id} onClose={() => setSelected(null)} />

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
