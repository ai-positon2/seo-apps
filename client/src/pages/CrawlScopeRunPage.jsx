// ── The Tech Audit report ───────────────────────────────────────────────────
//
// One crawl: live progress while it runs, then the result as six views of one
// screen — Overview, the problems (all / errors / warnings / notices), and every
// URL — with an issue's own page and a page's own page hanging off them.
//
// This is a rewrite, and what it replaced is worth recording. The report was two
// columns of eleven cards: an executive summary, a scored SEO snapshot, a media
// library, an integrations inventory, three charts, a count-reconciliation
// panel, a backlog trend, an issues-found accordion, a site-findings list, a
// 34-column page table with five switchable column sets, and the run history.
// Everything the crawler knew was on screen at once, in no particular order,
// and the question a reader actually arrives with — how bad is it, and what do I
// fix first — was answerable only by assembling it yourself.
//
// So the page now answers that in the first view and puts everything else one
// click behind a named tab. What genuinely went away, rather than moving:
//
//   • the SEO snapshot quadrants, the three charts, count reconciliation, the
//     media library, the integrations inventory, the backlog trend and the
//     executive summary. All of it is either in the Excel audit or was a second
//     rendering of a number stated elsewhere on the page.
//   • the table's other four column sets — 34 columns of response headers,
//     metadata lengths and link-graph counts. That is a spreadsheet, the report
//     writes one, and the button for it is at the top of this page.
//   • the separate "Issue review" screen. Its job — confirm or dismiss each
//     finding — is now done in the row, on the issue's own page, where the
//     finding is being read. /crawl-scope/runs/:id/review redirects here.
//
// The stream is the same SSE endpoint for a running and a finished crawl — it
// tails the database rather than the crawler, so a run executed by the worker in
// another process is watchable here exactly like a manual one. EventSource sends
// the session cookie itself and replays from Last-Event-ID on reconnect, so a
// dropped connection resumes rather than restarting.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, EmptyState, useToast } from '../ui';
import {
  Panel, Pill, RuledHead, Eyebrow, OutlineButton,
} from '../components/crawlScope/report/reportPrimitives';
import OverviewPanel from '../components/crawlScope/report/OverviewPanel';
import IssueList from '../components/crawlScope/report/IssueList';
import UrlsTable from '../components/crawlScope/report/UrlsTable';
import IssueDetail from '../components/crawlScope/report/IssueDetail';
import UrlDetail from '../components/crawlScope/report/UrlDetail';
import {
  healthMetrics, issueGroups, siteScopedGroups, healthScoreBreakdown, pageIssueCards, crawlCoverageNotice,
  runStatusVariant, formatDuration, TERMINAL_STATUSES, withEffectiveIssues,
  buildCountHierarchy, SEVERITY_ORDER, isHtmlPage,
} from '../components/crawlScope/crawlHelpers';
import { cs, saveBlob } from '../lib/crawlScopeApi';

// How long a crawl may go without a heartbeat before this page stops calling it
// running. A CLIENT-SIDE heuristic, deliberately generous: it has to exceed the
// server's RUN_HEARTBEAT_MS (30s by default) by enough that a slow write or a
// missed beat is not mistaken for a dead process, and the server's interval is
// an operator setting this page cannot read. Four beats at the default.
const STALE_AFTER_MS = 120_000;

// How often the staleness check re-runs while a crawl is live. Without a
// ticking value the check was computed from `progress.heartbeatAt` alone — and
// a dead crawl keeps that value FROZEN while the SSE loop goes on sending
// progress, so the dependency never changed, the memo never recomputed, and the
// page could never notice. It has to be time that drives this, not data.
const STALE_CHECK_MS = 15_000;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'all', label: 'All Issues' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'notice', label: 'Notices' },
  // "Pages", not "All URLs". It lists HTML pages only, and a tab promising
  // every URL while filtering two thirds of them out is the same species of
  // lie as a count of issues nothing has looked for.
  { id: 'urls', label: 'All Pages' },
];

export default function CrawlScopeRunPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [findings, setFindings] = useState([]);
  // Whether the AUDIT — the full rule catalog's finding set — has actually been loaded.
  //
  // Tracked separately from `findings` because an empty array is ambiguous and
  // the two meanings are opposites: "this crawl found nothing" and "I could not
  // read what it found". Keying the page's honesty gate on `running` instead of
  // this is what let a completed crawl with a failed findings load present the
  // crawler's dozen live status checks as a finished audit, with a health score
  // of 88 over a site that had 11,730 findings nobody could see.
  //
  //   'idle'    nothing attempted yet (crawl still running)
  //   'loading' the fetch is in flight
  //   'ready'   the finding set is in hand — an empty one is a real answer
  //   'error'   the fetch failed; nothing derived from findings can be shown
  const [findingsState, setFindingsState] = useState('idle');
  const [findingsError, setFindingsError] = useState(null);

  const [progress, setProgress] = useState({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [downloading, setDownloading] = useState(false);
  // A pause/stop the worker has not picked up yet. Held so the button does not
  // look ignored during the gap — the whole complaint about the old behaviour.
  const [pendingControl, setPendingControl] = useState(null);
  // Static reference data (id -> {title, category, description, recommendation,
  // priority, detection}), fetched once and never scoped to this run. It is what
  // lets an issue's page say what the check looks for and what to do about it.
  const [catalog, setCatalog] = useState([]);

  // ── Which of the six views is showing, and what is open inside it ─────────
  const [tab, setTab] = useState('overview');
  const [openIssueId, setOpenIssueId] = useState(null);
  const [openUrl, setOpenUrl] = useState(null);

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
          if (!cancelled) setFindingsState('loading');
          try {
            const f = await cs.findings(id);
            if (!cancelled) {
              setFindings(f.findings || []);
              setFindingsState('ready');
            }
          } catch (e) {
            // Its own state, not the page's `error`: the crawl and its results
            // loaded fine and the page is still worth showing. What is not
            // worth showing is a score computed without the findings.
            if (!cancelled) {
              setFindingsState('error');
              setFindingsError(e.message);
            }
          }
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
      try {
        const next = JSON.parse(e.data) || {};
        setProgress(next);
        // The run's status, live. `state` only ever fires once, at connection,
        // so this is the page's only way to learn mid-stream that a crawl was
        // paused or died — which is what a pending stop is waiting to hear.
        if (next.status) setStatus(next.status);
      } catch { /* ignore */ }
    });

    source.addEventListener('complete', (e) => {
      flush();
      try {
        const payload = JSON.parse(e.data);
        setStatus(payload.status);
        setRun((prev) => (prev
          ? { ...prev, status: payload.status, summary: payload.summary, error: payload.error }
          : prev));
        if (payload.error) toast.error(payload.error);
      } catch { /* ignore */ }
      // Findings only exist once the crawl has written its summary.
      //
      // This used to be `.catch(() => {})`. A failed load left `findings` empty
      // with nothing recording that it had failed, and every view on the page
      // then silently fell back to the crawler's live checks.
      setFindingsState('loading');
      cs.findings(id)
        .then((f) => { setFindings(f.findings || []); setFindingsState('ready'); })
        .catch((e) => { setFindingsState('error'); setFindingsError(e.message); });
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
  const pages = useMemo(() => results.filter((r) => r.scope !== 'External'), [results]);
  const externalChecked = results.length - pages.length;

  // `pages` still carries each page's crawl-time quickIssues() `.issues` — a
  // smaller, separate detection pass from the full analyzer catalog in
  // `findings`. Once findings exist (post-crawl), every issue-bearing view
  // reads THIS instead, so the table, the issue pages and the Excel export
  // never show a different issue set.
  // ── The audit, derived from the findings ─────────────────────────────────
  //
  // Back on crawlHelpers after a detour. I had moved all of this server-side
  // behind a rollup endpoint because the findings could not cross the wire —
  // but the real fault was upstream of that: the crawl-completion UPDATE that
  // embedded every finding in crawl_runs.summary was timing out, so nothing was
  // stored to send. Migration 0023 chunk-inserts them into their own table, so
  // the array is available again and these helpers — which are tested and used
  // by the Excel report writer's sibling logic — do the work.
  const effectivePages = useMemo(() => withEffectiveIssues(pages, findings), [pages, findings]);

  const htmlPages = useMemo(() => effectivePages.filter(isHtmlPage), [effectivePages]);
  const nonHtmlInternal = effectivePages.length - htmlPages.length;

  const metrics = useMemo(() => healthMetrics(effectivePages, findings), [effectivePages, findings]);

  // The score's own arithmetic, per severity band. The Overview panel derives
  // this itself from `metrics`, but an issue's page needs it too — for the
  // "health cost" tile — and it was being passed down from here without ever
  // being computed, so opening any issue threw and blanked the report.
  const breakdown = useMemo(() => healthScoreBreakdown(metrics), [metrics]);

  const pageGroups = useMemo(() => issueGroups(effectivePages, findings), [effectivePages, findings]);
  const siteGroups = useMemo(() => siteScopedGroups(findings), [findings]);
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const counts = useMemo(
    () => buildCountHierarchy(results, effectivePages, metrics, pageGroups, siteGroups),
    [results, effectivePages, metrics, pageGroups, siteGroups],
  );

  // Page-level and site-level problems in ONE list.
  //
  // A whole-site finding (no sitemap, a robots directive) cannot live in a
  // page × check matrix, which is why crawlHelpers builds the two separately.
  // The alternative to merging them here was dropping the site-level ones —
  // a report that silently stops mentioning a missing sitemap because the
  // layout had no shelf for it.
  //
  // `count` and `pages` are attached because the views display both and they
  // are different quantities: one page can trip the same check twice, so
  // occurrences and affected pages diverge.
  const groups = useMemo(() => {
    const merged = [...pageGroups, ...siteGroups].map((g) => ({
      ...g,
      count: g.urls.length,
      pages: new Set(g.urls).size,
    }));
    return merged.sort((a, b) => {
      const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      return bySeverity !== 0 ? bySeverity : b.pages - a.pages;
    });
  }, [pageGroups, siteGroups]);

  const findingsByRule = useMemo(() => {
    const map = new Map();
    for (const f of findings) {
      const list = map.get(f.ruleId) || [];
      list.push(f);
      map.set(f.ruleId, list);
    }
    return map;
  }, [findings]);

  const titleByUrl = useMemo(
    () => new Map(effectivePages.map((p) => [p.url, p.title])),
    [effectivePages],
  );

  // How many pages each rule is on, for a page's "see all N pages" link. A rule
  // split across page and template scope appears as two groups; the larger
  // count is the one the link opens.
  const pagesByRule = useMemo(() => {
    const map = new Map();
    for (const g of groups) map.set(g.id, Math.max(map.get(g.id) || 0, g.pages || 0));
    return map;
  }, [groups]);

  const shownGroups = useMemo(() => {
    if (tab === 'all') return groups;
    return groups.filter((g) => g.severity === tab);
  }, [groups, tab]);

  const running = !TERMINAL_STATUSES.includes(status);

  // ── Running, or dead and still labelled running? ─────────────────────────
  //
  // A healthy crawl stamps heartbeat_at every 30 seconds on its own timer, so
  // four missed beats means the process executing it is gone rather than busy.
  // The status column still says 'running' — nothing has moved it, which is the
  // whole point of the reaper — so this page said "running" and counted up an
  // elapsed timer for a crawl that had stopped ten minutes earlier, while the
  // shell's crawl bar said "stopped responding" three inches above it.
  //
  // The same reading overview.crawlHealth() does server-side for that bar, with
  // the same threshold. A stalled crawl is not running, and saying so is the
  // same lie as reporting a failed run as healthy.
  // A clock that ticks only while a crawl is in flight, so the check below has
  // something that changes even when the data does not.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const stalled = useMemo(() => {
    if (!running || status === 'paused' || status === 'queued') return null;
    // progress.heartbeatAt first: `run` is fetched once on mount and only
    // replaced when the crawl completes, so reading run.heartbeat_at made this
    // compare "now" against a timestamp frozen at page load — and declared a
    // healthy crawl dead after two minutes of watching it.
    const beat = Date.parse(progress.heartbeatAt || run?.heartbeat_at || run?.started_at || '');
    if (!Number.isFinite(beat)) return null;
    const silentFor = now - beat;
    if (silentFor <= STALE_AFTER_MS) return null;
    return { silentMinutes: Math.max(1, Math.round(silentFor / 60_000)) };
  }, [running, status, now, progress.heartbeatAt, run?.heartbeat_at, run?.started_at]);
  const sevCount = (s) => groups.filter((g) => g.severity === s).length;

  // ── While a crawl is running, these counts are NOT the audit ─────────────
  //
  // The analyzer's rule catalog runs once, when the crawl reaches a terminal
  // state, and `findings` is empty until then. So withEffectiveIssues() returns
  // the pages unchanged and issueGroups() groups each page's crawl-time
  // quickIssues() instead — about a dozen cheap checks on status code,
  // redirect type, base href and refresh headers.
  //
  // That is a fine thing to show live. Putting a COUNT on it was not: "All
  // Issues (5)" after 1,700 pages reads as "this site has five problems", and
  // "Errors (0)" is worse — it asserts there are none, which is a claim nothing
  // has measured yet. So no counts until there is something real to count, and
  // the list says what it is.
  // Provisional means "the audit is not in hand", which is the only thing that
  // matters to a reader — a crawl still going and a crawl whose findings failed
  // to load are indistinguishable in what the page is entitled to claim.
  const provisional = running || findingsState !== 'ready';
  // What the "analysing" notices report as progress. The stream's own figure
  // where it has one, falling back to the rows actually received.
  const crawledSoFar = Number.isFinite(Number(progress.crawled))
    ? Number(progress.crawled)
    : results.length;

  // ── Still arriving ───────────────────────────────────────────────────────
  //
  // The stream replays every stored row from a cursor, 200 at a time, so a page
  // opened during a crawl catches up rather than missing what came before. It
  // just takes a moment: at 1,986 crawled the table can legitimately hold 344
  // rows and be perfectly correct about the 344 it has.
  //
  // Which is exactly the kind of number that reads as settled when it is not.
  // `progress.crawled` is the server's count of everything fetched, so the two
  // together say whether the list is complete — and while it is not, the page
  // says so instead of publishing a total that will change under the reader.
  const receiving = crawledSoFar > results.length;
  const streamNote = receiving
    ? `receiving — ${results.length.toLocaleString()} of ${crawledSoFar.toLocaleString()} fetched URLs so far`
    : null;

  // A pending pause/stop is resolved by the status it was asking for.
  //
  // Driven off `status` rather than handled inside an event listener: the
  // status now arrives on three different paths — the one-shot `state` event,
  // every `progress` tick, and `complete` — and clearing this in only one of
  // them left the notice on screen indefinitely, which is precisely the
  // "nothing happened when I pressed Stop" this feature exists to end.
  useEffect(() => {
    setPendingControl((p) => {
      if (!p) return p;
      if (p.action === 'stop' && ['stopped', 'completed', 'failed'].includes(status)) return null;
      if (p.action === 'pause' && status === 'paused') return null;
      if (p.action === 'resume' && status === 'running') return null;
      return p;
    });
  }, [status]);

  // ── Did the crawl reach the whole site? ──────────────────────────────────
  //
  // The crawler records why a crawl was partial — run/manager.js stores
  // truncated / depthLimited / edgesTruncated / trapTemplates precisely so the
  // reason survives "instead of being flattened into a single truncated bit
  // nobody could act on" — and this report displayed none of it.
  //
  // That is the difference between "your site scores 88" and "the 200 pages we
  // reached score 88". A crawl stopped at its page budget scores whatever part
  // it saw, and nothing on the page said so.
  const coverage = useMemo(
    () => crawlCoverageNotice(run, catalogById),
    [run?.summary, run?.status, run?.options?.maxUrls, run?.options?.maxDepth, catalogById],
  );

  // ── Does this page show everything the analyser found? ───────────────────
  //
  // Two independent sources for the same quantity. `run.summary.counts` is
  // written server-side by the analyser when the crawl completes; `findings` is
  // what /runs/:id/findings hands this page. If they disagree, findings are
  // being lost between the two and every number on this screen understates the
  // site — which is not a discrepancy anyone should have to notice for
  // themselves.
  //
  // Compared against RAW findings, before the dismissal filter: a finding
  // marked Resolved or False positive is legitimately absent from the lists
  // below but was still found, so counting the filtered set would report a
  // false mismatch on every triaged run.
  const reconciliation = useMemo(() => {
    const stored = run?.summary?.counts;
    if (!stored || running) return null;
    if (findingsState !== 'ready') return null;
    // Every severity the analyser counts, `info` included. Omitting one would
    // put findings permanently outside this check, which is the opposite of
    // what it is for.
    const severities = ['error', 'warning', 'notice', 'info'];
    const rows = severities.map((sev) => ({
      sev,
      analyser: Number(stored[sev]) || 0,
      // Raw findings, before the dismissal filter: a triaged finding was still
      // found, so excluding it would report a false mismatch on a reviewed run.
      // Every scope too — summary.counts is built over all of them, and
      // counting only page-scoped ones reported a shortfall of exactly the
      // site- and resource-scoped findings.
      shown: findings.filter((f) => f.severity === sev).length,
    }));
    const analyser = rows.reduce((sum, r) => sum + r.analyser, 0);
    const shown = rows.reduce((sum, r) => sum + r.shown, 0);
    // Where the findings sit. Computed here now that the whole array is in
    // hand — it was the rollup's `byScope` before, and leaving it null meant
    // the one line that explained a mismatch could never render. It is what
    // told us a 379-vs-133 "shortfall" was site- and resource-scoped findings
    // rather than lost data.
    const byScope = {};
    for (const f of findings) {
      const k = f.scope || 'page';
      byScope[k] = (byScope[k] || 0) + 1;
    }
    return {
      rows, analyser, shown, dismissed: 0,
      stored: findings.length, storedCount: findings.length, byScope,
      agrees: analyser === shown,
      // The audit ran and its output was not kept — the failure mode migration
      // 0023 exists to end. Kept as a check rather than assumed fixed.
      notStored: Boolean(analyser) && findings.length === 0,
    };
  }, [run?.summary?.counts, findings, running, findingsState]);

  // ── Actions ───────────────────────────────────────────────────────────────
  /**
   * Pause, resume or stop.
   *
   * Two outcomes, and the difference matters to the person pressing the button.
   * A manual crawl runs in the web process and stops at once. A PROJECT crawl —
   * everything "Run Full Audit" queues — runs on the worker, which notices the
   * request on its next heartbeat. That used to be a 409 reading "This run is
   * not being executed by this instance" while the crawl carried on.
   *
   * The server says which happened and how long the second one takes; this
   * repeats it rather than guessing, because the interval is an operator
   * setting.
   */
  async function control(action) {
    setBusy(action);
    try {
      const result = await cs[action](id);
      const done = action === 'stop' ? 'stopping' : `${action}d`;
      if (result?.applied === 'requested') {
        setPendingControl({ action, at: Date.now(), note: result.note });
        toast.success(result.note || `Crawl ${done} shortly.`);
      } else {
        setPendingControl(null);
        toast.success(`Crawl ${done}.`);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
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
  // schedule — a project's run reuses the project (queued for the worker, same
  // as its own "Run now"); a one-off run just starts again with the same
  // url/options it was created with. Always lands on the NEW run's own page.
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

  /**
   * Records a review decision on one finding.
   *
   * Written to screen first and persisted after. Triage is a long session over
   * hundreds of rows: waiting for a round trip per row makes it feel broken, and
   * a failed write puts the old value back and says so rather than leaving the
   * row claiming something the database does not hold.
   */
  const onReview = useCallback(async (findingId, reviewStatus) => {
    const previous = findings.find((f) => f.id === findingId)?.reviewStatus || 'Needs review';
    setFindings((prev) => prev.map((f) => (f.id === findingId ? { ...f, reviewStatus } : f)));
    try {
      await cs.saveReviews(id, [{ findingId, reviewStatus, reviewerNotes: '' }]);
    } catch (e) {
      setFindings((prev) => prev.map((f) => (
        f.id === findingId ? { ...f, reviewStatus: previous } : f)));
      toast.error(`Could not save that decision: ${e.message}`);
    }
  }, [findings, id, toast]);

  /** The listed findings, as a CSV of the columns the table shows. */
  const exportFindings = useCallback((rows) => {
    if (!rows.length) return;
    const cell = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['URL', 'Page title', 'What we found there', 'Points at', 'Review'];
    const body = rows.map((f) => [
      f.url,
      titleByUrl.get(f.url) || '',
      f.detail || f.detectedValue || '',
      f.targetUrl || '',
      f.reviewStatus || 'Needs review',
    ]);
    const csv = [header, ...body].map((r) => r.map(cell).join(',')).join('\r\n');
    const host = (() => { try { return new URL(run?.url || '').hostname; } catch { return 'crawl'; } })();
    saveBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `${host}-${rows[0]?.ruleId || 'issue'}.csv`,
    );
  }, [run?.url, titleByUrl]);

  // ── Page states ───────────────────────────────────────────────────────────
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

  const host = (() => {
    try { return new URL(run?.url || '').hostname; } catch { return run?.url || 'this site'; }
  })();

  const finishedWord = status === 'completed' ? 'finished'
    : status === 'stopped' ? 'was stopped'
      : status === 'failed' ? 'failed'
        : 'is running';

  // ── Which view ────────────────────────────────────────────────────────────
  const openGroup = openIssueId ? groups.find((g) => g.id === openIssueId) || null : null;
  const openPage = !openGroup && openUrl
    ? effectivePages.find((p) => p.url === openUrl) || null
    : null;

  const heading = openGroup || openPage ? null
    : tab === 'overview' ? 'Overview'
      : tab === 'urls' ? 'Every HTML page crawled'
        : 'Every problem found';

  const issuesNote = `${groups.length} distinct problem${groups.length === 1 ? '' : 's'} · `
    + `${counts.occurrences.toLocaleString()} finding${counts.occurrences === 1 ? '' : 's'} on `
    + `${metrics.affectedErrorPages + metrics.affectedWarningPages + metrics.affectedNoticePages} `
    + `of ${metrics.htmlCount} pages`;

  const note = provisional && tab !== 'urls'
    ? 'Provisional — the full audit runs when the crawl finishes'
    : tab === 'overview'
      ? 'Site health, key metrics and what to fix first'
      : tab === 'urls'
        ? (streamNote
          || `${htmlPages.length.toLocaleString()} HTML page${htmlPages.length === 1 ? '' : 's'} of this site`)
        : issuesNote;

  return (
    <main className="crawl-report">
      {/* ── Who and when ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 300 }}>
          <Eyebrow tone="accent">Tech Audit</Eyebrow>
          <h1
            style={{
              margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em',
              color: 'var(--text)', lineHeight: 1.15,
            }}
          >
            {host} — site health
          </h1>
          <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
            Crawl of {host} {stalled ? 'stopped responding' : finishedWord}
            {run?.finished_at ? ` ${new Date(run.finished_at).toLocaleString()}` : ''}
            {elapsed ? ` · ${formatDuration(elapsed)} elapsed` : ''}
            {coverage.limit ? ` · budget ${coverage.limit.toLocaleString('en-US')} pages` : ''}
            {run?.summary?.robotsStatus ? ` · robots.txt: ${run.summary.robotsStatus}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* '/crawl-scope' is the standalone tool's own run history — useful
              when this run was a one-off, but a project's Tech Audit already
              has its own way back (the project page, via the module's report
              bar) and "All crawls" here would leave the project context for a
              list of unrelated crawls. */}
          {!run?.project_id && (
            <OutlineButton onClick={() => navigate('/crawl-scope')}>All crawls</OutlineButton>
          )}
          {running ? (
            <>
              <OutlineButton disabled={busy === 'pause'} onClick={() => control('pause')}>
                {busy === 'pause' ? 'Pausing…' : 'Pause'}
              </OutlineButton>
              <OutlineButton disabled={busy === 'resume'} onClick={() => control('resume')}>
                {busy === 'resume' ? 'Resuming…' : 'Resume'}
              </OutlineButton>
              <OutlineButton disabled={busy === 'stop'} onClick={() => control('stop')}>
                {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </OutlineButton>
            </>
          ) : (
            <>
              <OutlineButton disabled={busy === 'recrawl'} onClick={recrawl}>
                {busy === 'recrawl' ? 'Starting…' : 'Recrawl now'}
              </OutlineButton>
              {/* Only for a one-off run — a run already part of a scheduled
                  project does not need this prompt again. This is the only path
                  from "I just saw this report" to a recurring schedule. */}
              {!run?.project_id && run?.url && (
                <OutlineButton
                  onClick={() => navigate('/crawl-scope', {
                    state: {
                      scheduleUrl: run.url,
                      scheduleAt: run.started_at || run.created_at,
                    },
                  })}
                >
                  Schedule this crawl
                </OutlineButton>
              )}
              <OutlineButton tone="accent" disabled={downloading} onClick={downloadWorkbook}>
                {downloading ? 'Building…' : 'Download Excel audit'}
              </OutlineButton>
            </>
          )}
        </div>
      </div>

      {error && (
        <Panel style={{ borderColor: 'var(--viz-neg)' }}>
          <span style={{ fontSize: 13, color: 'var(--viz-neg)' }}>{error}</span>
        </Panel>
      )}

      {/* ── A crawl in flight ──────────────────────────────────────────────
          The design draws a finished report only. A running crawl still has to
          say so: without this the page shows a health score of zero over an
          empty table for the two minutes it takes, which reads as a catastrophic
          site rather than as a crawl that has not finished. */}
      {running && (
        <Panel style={{ gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', fontSize: 11, padding: '3px 10px',
                borderRadius: 6, textTransform: 'capitalize',
                background: stalled || runStatusVariant(status) === 'danger'
                  ? 'color-mix(in srgb, var(--viz-neg) 20%, transparent)'
                  : 'var(--accent-800)',
                color: stalled || runStatusVariant(status) === 'danger'
                  ? 'var(--viz-neg)' : 'var(--accent-100)',
              }}
            >
              {stalled ? 'stopped responding' : status}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
              {progress.crawled ?? results.length} crawled
              {progress.queued ? ` · ${progress.queued} queued` : ''}
              {elapsed ? ` · ${formatDuration(elapsed)} elapsed` : ''}
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, Math.round(((progress.crawled || 0) / Math.max(1, (progress.crawled || 0) + (progress.queued || 0))) * 100))}%`,
                background: 'var(--primary)',
                transition: 'width 300ms ease',
              }}
            />
          </div>
          {pendingControl && (
            <span
              style={{
                fontSize: 12, color: 'var(--viz-warn)', lineHeight: 1.5,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 7, height: 7, borderRadius: '50%', background: 'var(--viz-warn)',
                  flexShrink: 0,
                }}
              />
              {pendingControl.action === 'stop' ? 'Stop' : pendingControl.action === 'pause' ? 'Pause' : 'Resume'}
              {' '}requested. {pendingControl.note || 'Waiting for the worker to pick it up.'}
            </span>
          )}
          {/* A stalled crawl will never write findings on its own, so the
              sentence about "when the crawl reaches a terminal state" is a
              promise it cannot keep. This says what actually happens next. */}
          {stalled ? (
            <span style={{ fontSize: 12, color: 'var(--viz-neg)', lineHeight: 1.55 }}>
              No heartbeat for {stalled.silentMinutes} minute
              {stalled.silentMinutes === 1 ? '' : 's'}, so the process running this crawl has
              stopped. It never reached a terminal state, which is why there are no findings and
              no score — those are written once, at the end. It is reclaimed automatically within
              ten minutes and resumes from its last checkpoint, or you can re-run it now.
            </span>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
              The findings and the health score are written when the crawl reaches a terminal
              state. Pages appear in “All Pages” as they are fetched.
            </span>
          )}
        </Panel>
      )}

      {/* The audit could not be read.
          The crawl succeeded and its pages are all listed; what failed is the
          finding set. Reported here rather than folded into the page's general
          error, because the consequence is specific and severe: every score and
          every issue count on this page is withheld until it loads, and the
          reader needs to know that is why they are looking at em dashes. */}
      {findingsState === 'error' && (
        <Panel
          style={{
            gap: 8,
            background: 'color-mix(in srgb, var(--viz-neg) 10%, var(--card))',
            borderColor: 'color-mix(in srgb, var(--viz-neg) 45%, var(--border))',
          }}
        >
          <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>
            The audit could not be loaded for this crawl
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            The crawl itself finished and every page it fetched is listed under “All Pages”. What
            failed is the finding set — the full audit — so no score, no issue list and no
            counts are shown: they would be computed from the crawler’s live status checks alone
            and would understate the site.
            {run?.summary?.counts && (
              <>
                {' '}The crawl recorded{' '}
                <span className="num">
                  {(['error', 'warning', 'notice']
                    .reduce((sum, k) => sum + (Number(run.summary.counts[k]) || 0), 0))
                    .toLocaleString()}
                </span>{' '}
                findings that are not being displayed.
              </>
            )}
          </span>
          {findingsError && (
            <span style={{ fontSize: 11.5, color: 'var(--viz-neg)', fontFamily: 'var(--font-mono)' }}>
              {findingsError}
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <OutlineButton
              tone="accent"
              onClick={() => {
                setFindingsState('loading');
                setFindingsError(null);
                cs.findings(id)
                  .then((f) => { setFindings(f.findings || []); setFindingsState('ready'); })
                  .catch((e) => { setFindingsState('error'); setFindingsError(e.message); });
              }}
              style={{ height: 34, fontSize: 12.5, padding: '0 14px' }}
            >
              Try again
            </OutlineButton>
            <OutlineButton
              disabled={downloading}
              onClick={downloadWorkbook}
              style={{ height: 34, fontSize: 12.5, padding: '0 14px' }}
            >
              {downloading ? 'Building…' : 'Download the Excel audit instead'}
            </OutlineButton>
          </div>
        </Panel>
      )}

      {run?.error && (
        <Panel style={{ borderColor: 'var(--viz-neg)' }}>
          <span style={{ fontSize: 13, color: 'var(--viz-neg)' }}>{run.error}</span>
        </Panel>
      )}

      {/* ── One problem's own page ────────────────────────────────────────── */}
      {openGroup && (
        <IssueDetail
          group={openGroup}
          entry={catalogById.get(openGroup.id)}
          findings={findingsByRule.get(openGroup.id) || []}
          titleByUrl={titleByUrl}
          metrics={metrics}
          breakdown={breakdown}
          next={(() => {
            const i = groups.indexOf(openGroup);
            const n = groups[i + 1] || groups[0];
            if (!n) return null;
            return {
              id: n.id,
              title: catalogById.get(n.id)?.title || n.label || n.id,
              pages: n.pages,
            };
          })()}
          backLabel={openUrl ? 'Back to this page' : 'Every problem found'}
          onBack={() => {
            setOpenIssueId(null);
            // Arriving here from a page's own view goes back to that page, not
            // to the list — the reader was working through one URL's issues.
            if (!openUrl) setTab((t) => (t === 'overview' ? 'all' : t));
          }}
          onOpenNext={() => {
            const i = groups.indexOf(openGroup);
            const n = groups[i + 1] || groups[0];
            if (n) setOpenIssueId(n.id);
          }}
          onReview={onReview}
          onExport={exportFindings}
        />
      )}

      {/* ── One crawled page's own view ───────────────────────────────────── */}
      {openPage && (
        <UrlDetail
          page={openPage}
          issues={pageIssueCards(findings, openPage.url, catalogById, pagesByRule)}
          onBack={() => setOpenUrl(null)}
          onOpenIssue={(ruleId) => setOpenIssueId(ruleId)}
        />
      )}

      {/* ── The six views ─────────────────────────────────────────────────── */}
      {!openGroup && !openPage && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <RuledHead title={heading} note={note} />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <Pill key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {/* All Pages keeps its count throughout: a crawled page is a
                    crawled page, and that number is real the moment it lands. */}
                {t.id === 'urls' ? ` (${htmlPages.length}${receiving ? '…' : ''})`
                  : provisional ? ''
                    : t.id === 'all' ? ` (${groups.length})`
                      : ['error', 'warning', 'notice'].includes(t.id) ? ` (${sevCount(t.id)})` : ''}
              </Pill>
            ))}
          </div>

          {tab === 'overview' && (
            <OverviewPanel
              reconciliation={reconciliation}
              metrics={metrics}
              counts={counts}
              groups={groups}
              catalogById={catalogById}
              externalChecked={externalChecked}
              provisional={provisional}
              crawled={crawledSoFar}
              coverage={coverage}
            />
          )}

          {['all', 'error', 'warning', 'notice'].includes(tab) && (
            <IssueList
              groups={shownGroups}
              catalogById={catalogById}
              onOpen={setOpenIssueId}
              provisional={provisional}
              crawled={crawledSoFar}
            />
          )}

          {tab === 'urls' && (
            <UrlsTable pages={htmlPages} onOpen={setOpenUrl} />
          )}
        </div>
      )}

      {(externalChecked > 0 || nonHtmlInternal > 0) && tab === 'urls' && !openGroup && !openPage && (
        // Both exclusions, said out loud. Otherwise the crawl reports 1,700
        // fetched at the top of the page and this table holds 1,200 rows, with
        // nothing on screen accounting for the other 500.
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.45 }}>
          The crawler fetched {(externalChecked + nonHtmlInternal).toLocaleString()} more URL
          {externalChecked + nonHtmlInternal === 1 ? '' : 's'} that are not listed here:
          {nonHtmlInternal > 0 && (
            <>
              {' '}{nonHtmlInternal.toLocaleString()} file
              {nonHtmlInternal === 1 ? '' : 's'} this site serves — images, stylesheets, scripts,
              PDFs and feeds — which no check in the audit runs on
            </>
          )}
          {nonHtmlInternal > 0 && externalChecked > 0 ? ', and' : ''}
          {externalChecked > 0 && (
            <>
              {' '}{externalChecked.toLocaleString()} external URL
              {externalChecked === 1 ? '' : 's'} fetched to verify the outbound links on these
              pages, which are not pages of this site — a broken one appears as a finding on the
              page that links to it
            </>
          )}
          . Neither is counted in site health.
        </span>
      )}
    </main>
  );
}
