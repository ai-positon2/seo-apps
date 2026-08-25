import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectsApi, relativeTime } from '../../lib/projectsApi';
import { useActiveProjectId } from '../../lib/activeProject';
import {
  bandTone, defaultPage, isScored, orderWorstFirst, pathOf,
} from '../../lib/pageReportPicker';

// ── The bar above a module's own report ──────────────────────────────────────
//
// SEO & GEO, On-Page and Agent Readiness each audit ONE page, and a project has
// many. So a project run holds a report per crawled page, and this is how you
// move between them: it loads the selected page's report into the page's own
// report view, and the report itself is untouched below.
//
// What it has to communicate, in one line, without becoming a second report:
//
//   • which client, and that this is a stored run rather than a URL you typed
//   • the site average, and that it IS an average — a single number over ten
//     pages is a different claim from a number about one page
//   • which page you are looking at, how it scored, and how to reach the others
//   • how much of the site was covered, because a 10-page budget over a 50-page
//     crawl is not "the site"
//
// The picker lists pages worst-first, because that is the order somebody fixing
// things wants. The selection defaults to the first page audited — the homepage,
// since pages are audited shallowest-first — because landing on a random deep
// page would be disorienting.

// ── Telling the page which screen to draw ───────────────────────────────────
//
// These three modules render their report from page state, so the page mounted
// showing its "audit a URL" form and this bar swapped it for a report a moment
// later, once the stored run had loaded. Anyone opening a client with a report
// saw the form flash first — the app appearing to forget what it already knew.
//
// So the page no longer guesses. `onResolved` reports one of three states, and
// the page draws a skeleton until it is not 'loading':
//
//   'loading'  still finding out whether a stored report exists
//   'report'   one exists and has been handed over
//   'none'     there is nothing stored; show the input form
//
// 'report' is emitted when the report is actually handed to the page, not when
// we merely learn one exists — otherwise the form would be replaced by nothing
// while the per-page fetch was still in flight, trading a flash of form for a
// flash of blank.
export default function ProjectReportBar({ moduleKey, onOpenReport, onResolved }) {
  const [activeProjectId] = useActiveProjectId();

  const [projects, setProjects] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [crawled, setCrawled] = useState(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Hand a report over once per (run, page): without this it re-fires on every
  // render and fights whatever the reader does inside the report.
  const openedKey = useRef(null);
  const boxRef = useRef(null);

  // Held in a ref for the same reason as onOpenReport below: pages pass an inline
  // arrow, so depending on it would re-run these effects every render.
  const resolvedCb = useRef(onResolved);
  useEffect(() => { resolvedCb.current = onResolved; }, [onResolved]);
  const resolvedState = useRef(null);
  const emitResolved = useCallback((state) => {
    // 'none' must never overwrite 'report'. A background reload of the detail
    // briefly has no pages, and letting that emit 'none' would drop the reader
    // back onto the input form with their report still on screen underneath.
    if (resolvedState.current === state) return;
    if (state === 'none' && resolvedState.current === 'report') return;
    resolvedState.current = state;
    if (resolvedCb.current) resolvedCb.current(state);
  }, []);

  const project = useMemo(() => {
    if (!projects?.length) return null;
    return projects.find((p) => p.id === activeProjectId) || projects[0];
  }, [projects, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    projectsApi.list()
      .then((d) => { if (!cancelled) setProjects(d.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const next = await projectsApi.moduleDetail(project.id, moduleKey);
      setDetail(next);
      setError(null);
      const first = defaultPage(next.pages);
      if (first) setSelectedId((current) => current || first.pageRunId);
    } catch (e) {
      setDetail(null);
      setError(e);
    }
  }, [project, moduleKey]);

  useEffect(() => { load(); }, [load]);

  // Switching client resets what this bar has decided.
  //
  // Two things went stale across a switch and they compounded. `selectedId` was
  // only ever set when empty (`current || first`), so it kept pointing at a page
  // run belonging to the previous client. And the resolved-state guard below
  // refuses to go from 'report' back to 'none' — deliberately, so a background
  // reload cannot flash the input form — which meant a new client with no stored
  // report kept the previous client's report on screen indefinitely.
  //
  // Clearing both on the project id makes the guard mean what it was written to
  // mean: it protects a reload WITHIN one client, not across two.
  const lastProjectId = useRef(null);
  useEffect(() => {
    if (!project) return;
    if (lastProjectId.current === project.id) return;
    lastProjectId.current = project.id;
    setSelectedId(null);
    setDetail(null);
    openedKey.current = null;
    resolvedState.current = null;
    emitResolved('loading');
  }, [project, emitResolved]);

  // An audit in flight adds a page every minute or two. Without this the picker
  // shows whatever existed when the page was opened and looks stuck, which is the
  // same lie the dashboard card used to tell.
  useEffect(() => {
    if (!detail?.pagesFromInFlightRun) return undefined;
    const timer = setInterval(() => { load(); }, 15000);
    return () => clearInterval(timer);
  }, [detail?.pagesFromInFlightRun, load]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setPickerOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const pages = detail?.pages || [];
  const isPerPage = Boolean(detail?.isPerPage);

  // Resolve the "nothing to show" cases. The positive case is emitted below, at
  // the moment the report is handed over.
  useEffect(() => {
    if (projects === null) return;                 // still loading the client list
    if (!project) { emitResolved('none'); return; }
    if (error) { emitResolved('none'); return; }
    if (!detail) return;                           // still loading this module
    const hasStored = detail.isPerPage
      ? (detail.pages || []).length > 0
      : Boolean(detail.payload?.native);
    if (!hasStored) emitResolved('none');
  }, [projects, project, detail, error, emitResolved]);

  const ordered = useMemo(() => orderWorstFirst(pages), [pages]);

  const selected = pages.find((p) => p.pageRunId === selectedId) || null;
  const position = ordered.findIndex((p) => p.pageRunId === selectedId);

  // Every page passes onOpenReport as an inline arrow, so its identity changes on
  // each parent render. Held in a ref rather than depended on: On-Page polls every
  // 3.5s, and a poll landing mid-fetch would otherwise cancel the page load while
  // the guard below stopped it being retried — a report that never arrives.
  const openReport = useRef(onOpenReport);
  useEffect(() => { openReport.current = onOpenReport; }, [onOpenReport]);

  // Load the selected page's report into the page's own report view.
  useEffect(() => {
    if (!openReport.current || !project) return;
    const runId = detail?.pagesRunId || detail?.run?.id;
    if (!runId) return;

    // Site-level module, or a run stored before per-page reports: one report.
    if (!isPerPage || !pages.length) {
      const native = detail?.payload?.native;
      if (!native) return;
      const key = `${runId}:site`;
      if (openedKey.current === key) return;
      openedKey.current = key;
      openReport.current(native, detail);
      emitResolved('report');
      return;
    }

    if (!selectedId) return;
    const key = `${runId}:${selectedId}`;
    if (openedKey.current === key) return;
    openedKey.current = key;

    let cancelled = false;
    setLoadingPage(true);
    projectsApi.modulePageReport(project.id, selectedId)
      .then(({ page }) => {
        if (cancelled) return;
        if (page.native) {
          openReport.current(page.native, detail, page);
          emitResolved('report');
        } else {
          setError(new Error(page.error || 'That page has no stored report.'));
          emitResolved('none');
        }
      })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoadingPage(false); });

    return () => { cancelled = true; };
  }, [project, detail, isPerPage, pages.length, selectedId, emitResolved]);

  // ── Analyze another page ──────────────────────────────────────────────────
  //
  // The default report is five pages: the homepage and four chosen to cover
  // different page types. That is a sample, and the page somebody actually cares
  // about is often not in it. This adds one, audits it the same way, and the
  // run's average is recomputed server-side from all its pages — so the number at
  // the top always equals the mean of the list underneath it.
  //
  // The crawl inventory is fetched only when the panel is opened. It is a whole
  // page list, and most visits to a report never open this.
  async function openAdd() {
    setAddOpen((open) => !open);
    setAddError(null);
    if (crawled || !project) return;
    try {
      const data = await projectsApi.projectPages(project.id);
      setCrawled(data.pages || []);
    } catch {
      // Not fatal: the manual field still works, and that is the fallback the
      // panel offers when there is no inventory to list.
      setCrawled([]);
    }
  }

  async function addPage(url) {
    if (!project || !url) return;
    setAdding(true);
    setAddError(null);
    try {
      const result = await projectsApi.addModulePage(project.id, moduleKey, url);
      const next = await projectsApi.moduleDetail(project.id, moduleKey);
      setDetail(next);
      setAddOpen(false);
      // Jump to what was just added, which is what the click was asking for.
      const added = (next.pages || []).find((p) => p.pageRunId === result.page?.id)
        || (next.pages || []).find((p) => p.url === url);
      if (added) setSelectedId(added.pageRunId);
    } catch (e) {
      setAddError(e);
    } finally {
      setAdding(false);
    }
  }

  async function rerun() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.runModule(project.id, moduleKey);
      openedKey.current = null;
      setSelectedId(null);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!project || !detail) return null;

  const { card, run, payload } = detail;
  const label = detail.module?.label || moduleKey;
  const scored = Boolean(card?.scored);

  // A per-page module can still hold a run stored before per-page reports — one
  // report, for one url. Its score is that page's score, so calling it a site
  // average would be a straightforwardly false label. Everything below keys off
  // whether this run actually covered pages, not off what the module usually does.
  const perPageRun = isPerPage && pages.length > 0;

  // Nothing stored yet: one line, and the way to get a report.
  if (!run || (!pages.length && !payload?.native)) {
    return (
      <Bar>
        <Group>
          <Eyebrow>{project.name}</Eyebrow>
          <Text>
            No stored <strong>{label}</strong> report yet
            {payload?.reason === 'no_completed_crawl' ? ' — these audits run across the pages a crawl finds' : ''}
          </Text>
        </Group>
        <Spacer />
        {detail.module?.runnable && <Action onClick={rerun} busy={busy}>{busy ? 'Running…' : 'Run it now'}</Action>}
        {error && <ErrorText>{error.message}</ErrorText>}
      </Bar>
    );
  }

  return (
    <Bar>
      <Group>
        <Eyebrow>{project.name}</Eyebrow>
        <Text>
          {detail.pagesFromInFlightRun
            ? `${label} · auditing now`
            : `${label} · stored run ${run.finishedAt ? relativeTime(run.finishedAt) : ''}`}
        </Text>
      </Group>

      {/* A page list that is still growing must say so, or a reader takes the
          pages shown for the whole audit. */}
      {detail.pagesFromInFlightRun && (
        <Group>
          <Eyebrow>In progress</Eyebrow>
          <Text>
            {pages.length} page{pages.length === 1 ? '' : 's'} done
            {' '}<Dim>more appear as the crawl finds them</Dim>
          </Text>
        </Group>
      )}

      {/* The site figure, labelled as an average so it is not read as one page's
          score. */}
      {perPageRun && (
        <Group>
          <Eyebrow>Site average</Eyebrow>
          <Text>
            {scored ? <strong>{card.score}/100</strong> : <em>not scored</em>}
            {' '}
            <Dim>
              {scored
                ? `mean of ${payload?.pagesScored ?? pages.length} page${(payload?.pagesScored ?? pages.length) === 1 ? '' : 's'}`
                : 'this module reports findings'}
            </Dim>
          </Text>
        </Group>
      )}

      {/* Coverage, because a page budget over a bigger crawl is not "the site" —
          and which pages were picked matters as much as how many. */}
      {perPageRun && payload && (
        <Group>
          <Eyebrow>Coverage</Eyebrow>
          <Text title={payload.pageSelection ? `Pages chosen: ${payload.pageSelection}` : undefined}>
            {payload.pagesAudited} of {payload.pagesCrawled} crawled
            {payload.pagesSkipped
              ? (
                <Dim>
                  {' · '}
                  {payload.linkGraph ? 'most linked' : 'shallowest'}
                  {' · '}
                  {payload.pagesSkipped} unaudited
                </Dim>
              )
              : null}
            {payload.pagesFailed ? <Dim>{' · '}{payload.pagesFailed} failed</Dim> : null}
          </Text>
        </Group>
      )}

      <Spacer />

      {/* The page walker. */}
      {perPageRun && (
        <div ref={boxRef} style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
          <Step
            label="Previous page"
            disabled={position <= 0 || loadingPage}
            onClick={() => setSelectedId(ordered[position - 1]?.pageRunId)}
          >
            ‹
          </Step>

          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, maxWidth: 380,
              height: 30, padding: '0 10px', cursor: 'pointer',
              background: 'var(--card)', color: 'var(--text)',
              border: `1px solid ${pickerOpen ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-sans)', fontSize: 12.5,
            }}
          >
            <ScoreChip score={selected?.score} status={selected?.status} band={selected?.band} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pathOf(selected?.url) || 'Select a page'}
            </span>
            <Dim>{position >= 0 ? `${position + 1}/${ordered.length}` : `${ordered.length} pages`}</Dim>
            <span style={{ color: 'var(--text-3)' }}>▾</span>
          </button>

          <Step
            label="Next page"
            disabled={position < 0 || position >= ordered.length - 1 || loadingPage}
            onClick={() => setSelectedId(ordered[position + 1]?.pageRunId)}
          >
            ›
          </Step>

          {pickerOpen && (
            <PagePicker
              pages={ordered}
              selectedId={selectedId}
              onPick={(id) => { setSelectedId(id); setPickerOpen(false); }}
            />
          )}
        </div>
      )}

      {loadingPage && <Dim>loading…</Dim>}

      {isPerPage && (
        <div style={{ position: 'relative' }}>
          <Action onClick={openAdd} busy={adding}>
            {adding ? 'Analyzing…' : 'Analyze another page'}
          </Action>
          {addOpen && (
            <AddPagePanel
              crawled={crawled}
              already={new Set(pages.map((p) => p.url))}
              busy={adding}
              error={addError}
              onSubmit={addPage}
              onClose={() => setAddOpen(false)}
            />
          )}
        </div>
      )}

      <Action onClick={rerun} busy={busy}>{busy ? 'Re-running…' : 'Re-run'}</Action>
      <Link to="/" style={linkStyle}>Dashboard</Link>
      {error && <ErrorText>{error.message}</ErrorText>}
    </Bar>
  );
}


/**
 * Pick a crawled URL, or type one.
 *
 * Two ways in because there are two situations: the page is one the crawl found
 * (the common case, and picking it avoids a typo), or it is not — a page added
 * since the crawl, or one the crawl's URL cap never reached.
 *
 * Pages already in the report are listed but disabled rather than hidden. Their
 * absence would read as "the crawl missed it", and the honest answer is "it is
 * already here".
 */
function AddPagePanel({ crawled, already, busy, error, onSubmit, onClose }) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');

  const list = crawled === null ? null : crawled.filter((p) => {
    if (!query.trim()) return true;
    return String(p.url).toLowerCase().includes(query.trim().toLowerCase());
  });

  return (
    <div
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30,
        width: 420, maxWidth: '90vw', padding: 12, borderRadius: 'var(--r-md)',
        background: 'var(--card)', border: '1px solid var(--border)',
        boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>
          ADD A PAGE TO THIS REPORT
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search pages the crawl found…"
        style={inputStyle}
      />

      <div style={{ maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {list === null && <Dim>reading the crawl…</Dim>}
        {list !== null && list.length === 0 && (
          <Dim>{crawled.length ? 'Nothing matches that.' : 'No crawled pages on file yet.'}</Dim>
        )}
        {(list || []).slice(0, 200).map((p) => {
          const done = already.has(p.url);
          return (
            <button
              key={p.id || p.url}
              type="button"
              disabled={done || busy}
              onClick={() => onSubmit(p.url)}
              title={done ? 'Already in this report' : p.url}
              style={{
                textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: 'none',
                background: 'none', cursor: done ? 'default' : 'pointer',
                color: done ? 'var(--text-3)' : 'var(--text-2)', fontSize: 12,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                opacity: done ? 0.55 : 1,
              }}
            >
              {p.url}{done ? '  · in report' : ''}
            </button>
          );
        })}
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      <form
        onSubmit={(e) => { e.preventDefault(); onSubmit(manual.trim()); }}
        style={{ display: 'flex', gap: 6 }}
      >
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="…or paste a URL"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="submit"
          disabled={busy || !manual.trim()}
          style={{
            fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text-2)', cursor: busy || !manual.trim() ? 'default' : 'pointer',
            opacity: busy || !manual.trim() ? 0.5 : 1,
          }}
        >
          Analyze
        </button>
      </form>

      {error && <ErrorText>{error.message}</ErrorText>}
      <Dim>Its score joins this report's average.</Dim>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', boxSizing: 'border-box',
};

function PagePicker({ pages, selectedId, onPick }) {
  const [query, setQuery] = useState('');
  const shown = query.trim()
    ? pages.filter((p) => p.url.toLowerCase().includes(query.trim().toLowerCase()))
    : pages;

  return (
    <div
      role="menu"
      style={{
        position: 'absolute', top: 36, right: 0, zIndex: 50,
        width: 420, maxHeight: 420, overflowY: 'auto',
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)', padding: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '2px 4px 8px' }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)' }}>
          Pages · worst first
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{pages.length} audited</span>
      </div>

      {pages.length > 8 && (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by URL…"
          style={{
            width: '100%', boxSizing: 'border-box', minHeight: 30, marginBottom: 6,
            padding: '5px 9px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
            color: 'var(--text)', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', outline: 'none',
          }}
        />
      )}

      {!shown.length && (
        <div style={{ padding: 10, fontSize: 12.5, color: 'var(--text-3)' }}>
          No audited page matches “{query.trim()}”.
        </div>
      )}

      {shown.map((page) => {
        const active = page.pageRunId === selectedId;
        const counts = page.counts || {};
        return (
          <button
            key={page.pageRunId}
            role="menuitem"
            type="button"
            onClick={() => onPick(page.pageRunId)}
            style={{
              width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 8px', border: 'none', cursor: 'pointer',
              background: active ? 'var(--nav-active-bg)' : 'transparent',
              borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-sans)', color: 'var(--text)',
            }}
          >
            <ScoreChip score={page.score} status={page.status} band={page.band} />
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pathOf(page.url)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {page.status === 'failed'
                  ? (page.error ? `failed — ${page.error}` : 'failed')
                  : [
                    // The module's own band first: it says what the number means.
                    isScored(page) ? page.band : null,
                    counts.error ? `${counts.error} error` : null,
                    counts.warning ? `${counts.warning} warning` : null,
                    counts.notice ? `${counts.notice} notice` : null,
                  ].filter(Boolean).join(' · ') || 'no findings'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The dashboard's own three tones, so a page chip and a module card agree about
// what good and bad look like.
const TONE_COLOR = { pos: 'var(--primary)', warn: 'var(--viz-warn)', neg: 'var(--viz-neg)' };

/**
 * A page's score, or what it is instead.
 *
 * An em dash where the module has no rubric, an exclamation where the page could
 * not be audited. Never a 0 standing in for either.
 */
function ScoreChip({ score, status, band }) {
  const failed = status === 'failed';
  const has = isScored({ score });
  const tone = failed
    ? TONE_COLOR.neg
    : (has && TONE_COLOR[bandTone(band)]) || 'var(--text-3)';

  return (
    <span
      title={failed ? 'This page could not be audited'
        : has ? `Score ${score}${band ? ` — ${band}` : ''}`
          : 'This module reports findings, not a score'}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 30, height: 20, padding: '0 6px', flexShrink: 0,
        borderRadius: 'var(--r-pill)', fontSize: 11, fontWeight: 600,
        fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
        color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)`,
      }}
    >
      {failed ? '!' : has ? Math.round(score) : '—'}
    </span>
  );
}

// ── Bar chrome ──────────────────────────────────────────────────────────────

const linkStyle = {
  color: 'var(--primary-text)', fontSize: 12.5, textDecoration: 'none', whiteSpace: 'nowrap',
};

function Bar({ children }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
        padding: '10px 14px', marginBottom: 16,
        borderRadius: 'var(--r-md)',
        background: 'var(--surface)', border: '1px solid var(--border)',
        fontSize: 12.5, color: 'var(--text-2)',
      }}
    >
      {children}
    </div>
  );
}

const Group = ({ children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>{children}</div>
);

const Eyebrow = ({ children }) => (
  <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--text-3)' }}>
    {children}
  </span>
);

const Text = ({ children }) => (
  <span style={{ fontSize: 12.5, color: 'var(--text)', whiteSpace: 'nowrap' }}>{children}</span>
);

const Dim = ({ children }) => (
  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{children}</span>
);

const ErrorText = ({ children }) => (
  <span style={{ fontSize: 12, color: 'var(--danger)' }}>{children}</span>
);

const Spacer = () => <span style={{ flex: 1 }} />;

function Step({ children, label, disabled, onClick }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 26, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--card)', color: disabled ? 'var(--text-3)' : 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        fontSize: 15, lineHeight: 1, padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function Action({ onClick, busy, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        ...linkStyle,
        background: 'none', border: 'none', padding: 0,
        cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
