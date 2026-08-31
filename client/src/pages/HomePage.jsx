import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsApi, relativeTime, countryLabel } from '../lib/projectsApi';
import { useActiveProjectId } from '../lib/activeProject';
import { cs } from '../lib/crawlScopeApi';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead,
} from '../components/home/primitives';
import ModuleCard from '../components/home/ModuleCard';
import InsightsPanel from '../components/home/InsightsPanel';
import SiteFavicon from '../components/home/SiteFavicon';
import AuditRadar from '../components/home/AuditRadar';
import Takeaway from '../components/home/Takeaway';
import ProjectSetupCard from '../components/home/ProjectSetupCard';
import HomeSkeleton from '../components/home/HomeSkeleton';
import { useCrawlStatus } from '../lib/useCrawlStatus';

// How often the dashboard re-reads itself while a crawl is running. The crawl
// BAR is not this — that lives in the app shell and polls a cheap endpoint of its
// own. This is the dashboard's own numbers, which a running crawl keeps changing.
const CRAWL_POLL_MS = 8000;

// ── Home — the project dashboard ────────────────────────────────────────────
// The home screen leads with one client site's audit profile (PRD §20.1
// "Overview") instead of a tool grid: what was crawled, what each module found,
// what has run, what needs attention.
//
// It deliberately does NOT carry a tool catalog. The sidebar already lists every
// module, so a second grid of the same links below the dashboard pushed the
// evidence off screen and made the page about the toolkit rather than about the
// client. The catalog's copy still lives in client/src/toolCatalog.js if it is
// ever wanted for a dedicated launcher page.
//
// Every number on this page comes from a stored row. Where a module has no
// project-scoped evidence, the card says so — see components/home/ModuleCard.jsx
// for why that matters more than filling the space.

export default function HomePage() {
  const navigate = useNavigate();

  const [listState, setListState] = useState({ loading: true, error: null, data: null });
  // Shared with the header's client switcher (lib/activeProject.js), so picking
  // a client up there changes what this page shows.
  const [activeProjectId, setActiveProjectId] = useActiveProjectId();
  const [overview, setOverview] = useState({ loading: false, error: null, data: null });
  const [showSetup, setShowSetup] = useState(false);
  const [auditSheet, setAuditSheet] = useState(null);   // null | 'open' | 'running'
  // Bumped when a backlog item is drafted into a recommendation, so the board
  // below re-reads rather than appearing to swallow it.
  // Set when a full audit finishes, so the result is reported where the user
  // already is instead of by navigating them into the crawler's console.
  const [auditBanner, setAuditBanner] = useState(null);
  // The cross-module answer. Owned here because the takeaway at the top of the
  // page and the panel further down are the same answer.
  const [insights, setInsights] = useState({ loading: true, error: null, data: null });

  // Takes the project id as an argument rather than closing over activeProject.
  // It has to: this is declared above the useMemo that computes activeProject, so
  // referencing it here is a temporal-dead-zone error that throws on every render
  // and blanks the page. The build compiles it without complaint.
  const loadInsights = useCallback(async (projectId) => {
    if (!projectId) return;
    setInsights((prev) => ({ ...prev, loading: true, error: null }));
    try {
      setInsights({ loading: false, error: null, data: await projectsApi.insights(projectId) });
    } catch (e) {
      // The dashboard is still useful without the cross-module answer; the panel
      // below reports the failure and offers a retry.
      setInsights({ loading: false, error: e, data: null });
    }
  }, []);
  const [auditError, setAuditError] = useState(null);
  const [auditResults, setAuditResults] = useState(null);   // per-module outcome

  // ── Load the project list ─────────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    setListState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await projectsApi.list();
      setListState({ loading: false, error: null, data });
      return data;
    } catch (e) {
      setListState({ loading: false, error: e, data: null });
      return null;
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const projects = listState.data?.projects || [];

  // Resolve the selected project against what actually came back, so a stale id
  // in localStorage (project deleted, or a different workspace) falls back to
  // the first available one instead of leaving the page blank.
  const activeProject = useMemo(() => {
    if (!projects.length) return null;
    return projects.find((p) => p.id === activeProjectId) || projects[0];
  }, [projects, activeProjectId]);

  // Write the resolved id back, so a stale selection is repaired rather than
  // re-resolved on every load. Guarded, or the write re-enters this effect.
  useEffect(() => {
    if (activeProject && activeProject.id !== activeProjectId) {
      setActiveProjectId(activeProject.id);
    }
  }, [activeProject, activeProjectId, setActiveProjectId]);

  // ── Load the selected project's overview ──────────────────────────────────
  const loadOverview = useCallback(async (projectId, { quiet = false } = {}) => {
    if (!projectId) return;
    // A quiet reload keeps what is on screen while it refetches. The crawl
    // poller below uses it: dropping to a spinner every few seconds would make
    // the dashboard flash, lose scroll position, and tell the reader less than
    // the slightly stale numbers it just threw away.
    if (!quiet) setOverview({ loading: true, error: null, data: null });
    try {
      const data = await projectsApi.overview(projectId);
      setOverview({ loading: false, error: null, data });
    } catch (e) {
      // A dropped poll is not a broken dashboard. Only a reload the user asked
      // for is allowed to replace the page with an error.
      if (quiet) return;
      setOverview({ loading: false, error: e, data: null });
    }
  }, []);

  useEffect(() => {
    if (activeProject?.id) loadOverview(activeProject.id);
  }, [activeProject?.id, loadOverview]);

  // The cross-module answer, read once per client and shared by the takeaway at
  // the top of the page and the panel below it.
  useEffect(() => {
    if (activeProject?.id) loadInsights(activeProject.id);
  }, [activeProject?.id, loadInsights]);

  // ── Follow a live crawl ───────────────────────────────────────────────────
  //
  // The dashboard is otherwise load-once, which was fine when nothing on it
  // moved. A crawl changes what every card will say next, so while one is in
  // flight the page refreshes itself — and stops the moment the crawl reaches a
  // terminal state, because crawlStatus goes null and this effect tears down. A
  // dashboard that polls forever is one nobody can leave open.
  // The shell owns the crawl status and polls for it; the dashboard only needs
  // to know THAT one is running, so it can re-read its own numbers while the
  // crawl keeps changing them.
  const { status: crawlStatus, refresh: refreshCrawl } = useCrawlStatus();
  const liveCrawlRunId = crawlStatus?.runId || null;

  useEffect(() => {
    if (!liveCrawlRunId || !activeProject?.id) return undefined;
    const projectId = activeProject.id;
    const timer = setInterval(() => { loadOverview(projectId, { quiet: true }); }, CRAWL_POLL_MS);
    return () => clearInterval(timer);
    // Keyed on the run id rather than on the status object, which is a new object
    // on every poll and would restart the interval on each tick.
  }, [liveCrawlRunId, activeProject?.id, loadOverview]);

  /**
   * Runs one module against the project and reloads the profile.
   *
   * Most modules are synchronous on the server — they take seconds — so there
   * is nothing to poll. ai_visibility is the exception: a real measurement run
   * is 25-110s PER capture, serially, which can be many minutes for a full
   * prompt set. The server hands that one back still 'running' rather than
   * holding the request open (no proxy would survive that wait), so this
   * polls the overview until it finishes — otherwise the card would just sit
   * on "running" until the next manual reload. Errors propagate to the card
   * that asked, which is where the person is looking.
   */
  const runModule = useCallback(async (moduleKey) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const { run } = await projectsApi.runModule(projectId, moduleKey);
    await loadOverview(projectId);

    if (run?.status !== 'running') return;
    const deadlineAt = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadlineAt) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 8000));
      let data;
      try {
        // eslint-disable-next-line no-await-in-loop
        data = await projectsApi.overview(projectId);
      } catch {
        continue; // a dropped poll is not a failed run — keep trying
      }
      setOverview({ loading: false, error: null, data });
      const stillRunning = (data.modules || []).some((m) => m.key === moduleKey && m.status === 'running');
      if (!stillRunning) break;
    }
  }, [activeProject, loadOverview]);

  /**
   * "Run Full Audit": the connected modules first, then the crawl.
   *
   * The modules finish in seconds and their results are stored, so the profile
   * is already populated by the time the crawl is queued. The crawl is last
   * because navigating to its run page leaves this screen.
   *
   * A module failing does not stop the rest — the server reports each one, and
   * a partial audit is shown as exactly that rather than as a failure.
   */
  async function runFullAudit() {
    if (!activeProject) return;
    // Closed before any request goes out.
    //
    // This used to switch to a 'running' state and hold the sheet open for the
    // length of the audit — minutes — over the dashboard the audit was updating.
    // The crawl bar in the shell reports progress from now on, the module cards
    // report themselves, and the banner reports the finish. Nothing needs a modal
    // parked on top of all three.
    setAuditSheet(null);
    setAuditError(null);
    setAuditError(null);
    setAuditResults(null);

    // The crawl goes first, and the page audits follow it.
    //
    // This used to run every module and THEN queue the crawl, which meant SEO &
    // GEO, On-Page and Agent Readiness audited the pages of the PREVIOUS crawl
    // and the result was presented as the current audit. Queuing first lets those
    // three audit pages as this crawl discovers them, so work starts seconds in
    // rather than after the crawl has finished.
    //
    // A failure here is a downgrade, not a stop: without a crawl to follow the
    // page modules fall back to the last completed crawl, which is the old
    // behaviour and still useful.
    // Queued for anyone on the team. This used to be skipped entirely unless you
    // created the project, because CrawlScope's run endpoint was scoped to the
    // creator rather than to the workspace — an authorization bug the dashboard
    // presented to teammates as a product limitation, with the button disabled.
    // The endpoint is workspace-scoped now, so the branch is gone.
    let queuedCrawlId = null;
    try {
      const { run } = await cs.runProjectNow(activeProject.id);
      queuedCrawlId = run?.id || null;
    } catch (e) {
      console.error('[audit] could not queue a crawl to follow:', e.message);
    }

    let started = null;
    try {
      // 202: the modules were started, not finished. The page audits run for as
      // long as the crawl keeps producing pages, which no request should be held
      // open for.
      started = await projectsApi.runAudit(activeProject.id, null, { crawlRunId: queuedCrawlId });
      setAuditResults({ started: started.started, running: true, crawlRunId: queuedCrawlId });
      // Pull the bar into its live cadence now instead of waiting out the shell's
      // idle interval, so the crawl appears the moment the popup closes.
      refreshCrawl();
    } catch (e) {
      // The sheet is already closed, so a failure has to be reported on the page
      // rather than back inside a modal the user has stopped looking at.
      setAuditError(`The audit could not be started: ${e.message}`);
      return;
    }

    // Watch the overview until nothing is running. Each module writes a
    // 'running' row before it begins, so progress is read from stored state
    // rather than guessed from elapsed time.
    const deadlineAt = Date.now() + 6 * 60 * 1000;
    let last = null;
    while (Date.now() < deadlineAt) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        last = await projectsApi.overview(activeProject.id);
        setOverview({ loading: false, error: null, data: last });
        const stillRunning = (last.modules || []).some((m) => m.status === 'running');
        if (!stillRunning) break;
      } catch {
        // A failed poll is not a failed audit — the work continues server-side.
        // Keep polling; the deadline below is the only thing that gives up.
      }
    }

    const finished = (last?.modules || []).filter((m) => started.started.includes(m.key));
    setAuditResults({
      started: started.started,
      running: false,
      results: finished.map((m) => ({
        moduleKey: m.key,
        ok: m.status !== 'failed',
        status: m.status,
        score: m.scored ? m.score : null,
        findings: m.evidence?.findingCount ?? 0,
        error: m.error || null,
      })),
      ran: finished.filter((m) => m.status !== 'failed').length,
      failed: finished.filter((m) => m.status === 'failed').length,
    });

    // We STAY HERE.
    //
    // This used to navigate to /crawl-scope/runs/:id, so the app's flagship
    // action ended inside one tool's live-progress console — a different visual
    // language, a different name in the breadcrumb, and no mention of the module
    // results that had just finished. The one button a client-facing user is most
    // likely to press was also the one that most undercut the idea that six
    // audits are one audit.
    //
    // The crawl's own progress is still one click away, from the banner below and
    // from the Tech Audit card, where every other module's detail lives too.
    setAuditSheet(null);
    setAuditBanner({
      crawlRunId: queuedCrawlId,
      ran: finished.filter((m) => m.status !== 'failed').length,
      failed: finished.filter((m) => m.status === 'failed').length,
      total: started.started.length,
      followingLiveCrawl: Boolean(started.followingLiveCrawl),
    });
  }

  // ── Page states ───────────────────────────────────────────────────────────

  if (listState.loading) return <HomeSkeleton />;

  if (listState.error) {
    const notConfigured = listState.error.code === 'not_configured' || listState.error.status === 503;
    return (
      <div style={{ padding: '28px 32px', maxWidth: 720 }}>
        <Card style={{ padding: 24, gap: 10 }}>
          <Kicker tone="muted">Projects unavailable</Kicker>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 500 }}>
            {notConfigured ? 'Supabase is not configured' : 'Could not load projects'}
          </h2>
          <Muted size={13}>{listState.error.message}</Muted>
          {notConfigured && (
            <Muted size={12}>
              Projects, crawls and run history are all database-backed. Set SUPABASE_URL and
              SUPABASE_SERVICE_ROLE_KEY, then reload. Every tool in the sidebar that does not need
              persistence keeps working in the meantime.
            </Muted>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <Btn variant="primary" onClick={loadProjects}>Try again</Btn>
          </div>
        </Card>
      </div>
    );
  }

  const canEdit = listState.data?.capabilities?.editProjectSettings === true;

  if (showSetup || !projects.length) {
    return (
      <div style={{ padding: '28px 32px 48px', display: 'flex', flexDirection: 'column', gap: 36 }}>
        {!projects.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 720 }}>
            <Kicker>Start Here</Kicker>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em' }}>
              No client projects yet
            </h1>
            <Muted size={13}>
              A project is how SEO Studio knows which site it is looking at. Create one and the
              dashboard fills in as crawls and audits run against it.
            </Muted>
          </div>
        )}
        <ProjectSetupCard
          limits={listState.data?.limits}
          onCreated={async (project) => {
            setShowSetup(false);
            setActiveProjectId(project.id);
            const data = await loadProjects();
            if (data) loadOverview(project.id);
          }}
          onCancel={projects.length ? () => setShowSetup(false) : undefined}
        />
      </div>
    );
  }

  // ── One loading state, not three ──────────────────────────────────────────
  //
  // The page reads the project list, the overview and the cross-module insight.
  // Each used to render as it landed, so the dashboard assembled itself in front
  // of the reader: header, spinner, six cards, then a panel that pushed
  // everything down. Every arrival moved whatever they had started reading.
  //
  // Now nothing renders until all three have resolved. "Resolved" includes
  // failure — a request that errored is finished, and its section says so —
  // otherwise one broken read would hold the page on a skeleton forever.
  //
  // A quiet crawl poll never re-enters this: it leaves the previous data in
  // place, so `overview.data` stays truthy and the page never flickers back to
  // the skeleton while a crawl runs.
  const settled = (s) => Boolean(s.data) || Boolean(s.error);
  if (activeProject && !(settled(overview) && settled(insights))) {
    return <HomeSkeleton />;
  }

  const data = overview.data;
  const modules = data?.modules || [];
  const composite = data?.composite;

  const lastRunAt = modules.map((m) => m.updatedAt).filter(Boolean).sort().reverse()[0] || null;

  return (
    <div
      style={{
        padding: '24px 32px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        maxWidth: 1520,
        margin: '0 auto',
      }}
    >
      {/* ── Active client ─────────────────────────────────────────────────── */}
      <Card elevation="md" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 280 }}>
            {/* The client's own mark beside their name, so the page looks like it
                is about them rather than about the tool. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <SiteFavicon
                origin={activeProject.primaryDomain?.origin}
                name={activeProject.name}
                size={40}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.015em' }}>
                  {activeProject.name}
                </h2>
                {/* Everything that used to be four separate chips, on one quiet
                    line. None of it is what the reader came for. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {activeProject.primaryDomain ? (
                    <a
                      href={activeProject.primaryDomain.origin}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 13, color: 'var(--primary-text)' }}
                    >
                      {activeProject.primaryDomain.host}
                    </a>
                  ) : (
                    <Tag tone="warn">Primary domain needs attention</Tag>
                  )}
                  {activeProject.countryCode
                    ? <Muted size={12}>· {countryLabel(activeProject.countryCode)}</Muted>
                    : <Tag tone="warn">Country not set</Tag>}
                  <Muted size={12}>
                    · {activeProject.schedule.enabled ? 'Weekly crawl on' : 'No schedule'}
                  </Muted>
                  {activeProject.competitors.length > 0 && (
                    <Muted size={12}>
                      · vs {activeProject.competitors.map((c) => c.host).join(', ')}
                    </Muted>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => navigate('/projects')}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-sans)',
                        textDecoration: 'underline',
                      }}
                    >
                      edit
                    </button>
                  )}
                </div>
              </div>
            </div>

            {activeProject.countryMissing && (
              <Muted size={12} style={{ color: 'var(--viz-warn)' }}>
                This project predates the country requirement. Rank and Search Console comparisons
                need a market before they can run — set it in project settings.
              </Muted>
            )}

          </div>

          {/* Both actions on one row rather than stacked, so the header is a band
              rather than a block. Run Full Audit sits left of Download report: the
              primary action reads first, and the pair still ends where the stacked
              column used to. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <Btn
              variant="primary"
              onClick={() => { setAuditError(null); setAuditSheet('open'); }}
              title={'Crawls the site, then audits its pages for SEO & GEO, On-Page and Agent '
                + 'Readiness as the crawl finds them. Hub & Spoke reads Content Architect\'s '
                + 'latest analysis.'}
              style={{ fontSize: 15, height: 42, padding: '0 20px' }}
            >
              <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" style={{ display: 'block' }}>
                <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z" />
              </svg>
              Run Full Audit
            </Btn>
            {/* The explanations moved to tooltips. They described the app's own
                mechanics — which modules run in what order — to a reader who wants
                to know whether their site is in trouble. */}
            <Btn
              variant="secondary"
              onClick={() => { window.location.href = projectsApi.reportUrl(activeProject.id); }}
              title="One workbook of everything stored for this project, including what it does not cover."
              style={{ height: 42, fontSize: 13, padding: '0 16px' }}
            >
              Download report
            </Btn>
          </div>
        </div>

        {/* The crawl bar used to sit here. It is in the app shell now, above
            every screen, so a crawl stays visible when you walk over to another
            tool — see components/MacWindow.jsx and lib/useCrawlStatus.js. */}

        {/* The answer, at the top, in the reader's words. */}
        <Takeaway
          insights={insights.data}
          loading={insights.loading}
          onOpen={() => {
            document.getElementById('do-this-next')?.scrollIntoView({ behavior: 'smooth' });
          }}
        />
      </Card>

      {/* An audit that could not start.
          It used to be reported inside the confirmation sheet, which is fine
          while the sheet is open — it now closes the moment Run is pressed, so a
          failure has nowhere to appear unless it appears here. */}
      {auditError && (
        <Card
          role="alert"
          style={{
            padding: '12px 16px', flexDirection: 'row', alignItems: 'center', gap: 12,
            border: '1px solid color-mix(in srgb, var(--viz-neg) 45%, transparent)',
            background: 'color-mix(in srgb, var(--viz-neg) 9%, var(--card))',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Kicker's tone prop only knows 'muted'; anything else renders in
                the primary colour, which on an error card reads as a success. */}
            <Kicker style={{ color: 'var(--viz-neg)' }}>Audit not started</Kicker>
            <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{auditError}</span>
          </div>
          <Btn onClick={() => { setAuditError(null); setAuditSheet('open'); }}>Try again</Btn>
          <Btn onClick={() => setAuditError(null)}>Dismiss</Btn>
        </Card>
      )}

      {/* What the full audit did, reported where the user already is. */}
      {auditBanner && (
        <Card style={{ padding: '12px 16px', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Kicker>Full audit complete</Kicker>
            <span style={{ fontSize: 13.5, color: 'var(--text)' }}>
              {auditBanner.ran} of {auditBanner.total} module
              {auditBanner.total === 1 ? '' : 's'} updated
              {auditBanner.failed ? ` · ${auditBanner.failed} failed` : ''}
              {auditBanner.crawlRunId ? ' · site crawl running' : ''}
            </span>
            <Muted size={11.5}>
              {auditBanner.followingLiveCrawl
                ? 'SEO & GEO, On-Page and Agent Readiness are auditing pages as the crawl finds '
                  + 'them. Their cards show progress, and each page is readable in the report as '
                  + 'soon as it is done.'
                : 'No live crawl to follow, so the page audits read the last completed crawl.'}
            </Muted>
          </div>
          <Btn onClick={() => navigate(`/crawl-scope/runs/${auditBanner.crawlRunId}`)}>
            Watch the crawl
          </Btn>
          <Btn onClick={() => setAuditBanner(null)}>Dismiss</Btn>
        </Card>
      )}

      {/* ── Audit insights ───────────────────────────────────────────────── */}
      <section>
        <SectionHead
          title={`Audit Insights — ${activeProject.name}`}
          right={
            overview.loading ? 'Loading…'
            : lastRunAt ? `Latest module evidence ${relativeTime(lastRunAt)}`
            : 'No module has produced evidence for this project yet'
          }
        />

        {overview.error && (
          <Card style={{ padding: 18, gap: 8 }}>
            <Kicker tone="muted">Overview unavailable</Kicker>
            <Muted size={13}>{overview.error.message}</Muted>
            <div><Btn onClick={() => loadOverview(activeProject.id)}>Try again</Btn></div>
          </Card>
        )}

        {data && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(320px, 380px) minmax(0, 1fr)',
              gap: 16,
              alignItems: 'stretch',
            }}
          >
            {/* Audit profile */}
            <Card style={{ padding: 16, gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Kicker>Audit Profile</Kicker>
                <Muted>{modules.length} modules</Muted>
              </div>

{/* One ring per module, outermost first, coloured by how that module is
                  doing rather than by which module it is — with six of them,
                  colour-as-identity would need six arbitrary hues and a key to
                  decode. The legend names them instead.

                  This replaced a six-axis radar whose labels were four characters
                  long ("COMP 7", "PAGE 69"). A radar also asks the reader to
                  compare polygon area against an implied ideal shape, which is a
                  skill; a ring per row is one question answered once.

                  The rings carry their own "N of 6 scored" footer, which is what
                  the block that used to sit here said. */}
              <AuditRadar modules={modules} />

              <FadingRule style={{ marginTop: 4 }} />

              {/* The chart cannot say this and must not be read as saying the
                  opposite: the polygon's shape is not a statement about balance,
                  because each axis is a different module's own scale. */}
              <Muted style={{ lineHeight: 1.45 }}>
                Each axis is that module’s own score on its own scale. They are not
                averaged, and the shape is not a measure of balance — the six
                measure different things.
              </Muted>
            </Card>

            {/* Module cards */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(268px, 1fr))',
                gap: 16,
              }}
            >
              {modules.map((module) => (
                <ModuleCard key={module.key} module={module} onRun={runModule} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── What the six modules say together ────────────────────────────
          The modules above report what each one found. This reports what they
          mean read against each other, which no single card can say. */}
      <InsightsPanel
        projectId={activeProject.id}
        projectName={activeProject.name}
        data={insights.data}
        loading={insights.loading}
        error={insights.error}
        onReload={() => loadInsights(activeProject.id)}
        // Promoting a backlog item changes the backlog, so the panel re-reads
        // itself. It used to bump a counter for the recommendations board that
        // sat below; the board is gone and the backlog is the thing on screen.
        onChanged={() => loadInsights(activeProject.id)}
      />

      {/* The page ends here.
          Activity, Alerts and the Recommendations board used to follow.
          Three more panels below the answer meant the dashboard kept going
          long after it had stopped saying anything new: activity repeated
          the run history the sidebar already reaches, alerts repeated
          findings the cards carry, and the board repeated the backlog
          directly above it. */}

      {/* ── Run Full Audit confirmation ─────────────────────────────────── */}
      {auditSheet && (
        <RunAuditSheet
          project={activeProject}
          modules={modules}
          busy={auditSheet === 'running'}
          error={auditError}
          results={auditResults}
          onConfirm={runFullAudit}
          onClose={() => setAuditSheet(null)}
        />
      )}
    </div>
  );
}

/**
 * The Run Full Audit sheet. It exists because "Run Full Audit" is a six-module
 * promise and only one module currently runs against a project — so the button
 * says what will actually happen before it happens, rather than starting one
 * crawl and letting the label imply five more.
 */
function RunAuditSheet({ project, modules, busy, error, results, onConfirm, onClose }) {
  // What this actually runs: the modules that can be run against a project.
  // 'technical' is excluded because the crawl is queued separately, and it is
  // listed on its own below rather than implied by this list.
  const runnable = modules.filter((m) => m.runnable);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Run full audit"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', padding: 16,
        background: 'color-mix(in srgb, var(--neutral-900) 55%, transparent)', zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(520px, 100%)', display: 'flex', flexDirection: 'column', gap: 14,
          padding: 22, borderRadius: 'var(--r-lg)', background: 'var(--card)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Kicker>Run Full Audit</Kicker>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>{project.name}</h3>
          <Muted size={12.5}>
            {project.primaryDomain?.origin || project.legacyUrl}
          </Muted>
        </div>

        <FadingRule />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            Runs now, one after another — around {Math.max(1, Math.round(runnable.length * 25 / 60))} minute(s)
            in total. Results are saved as each one finishes.
          </span>
          {runnable.map((m) => {
            const state = results?.results?.find((r) => r.moduleKey === m.key);
            return (
              <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span
                  style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: state
                      ? (state.ok ? 'var(--primary)' : 'var(--viz-neg)')
                      : m.status === 'running' ? 'var(--viz-warn)' : 'var(--neutral-600)',
                  }}
                />
                {m.label}
                <Muted style={{ marginLeft: 'auto', textAlign: 'right', maxWidth: 240 }}>
                  {state
                    ? (state.ok
                      ? (state.score !== null && state.score !== undefined
                        ? `scored ${Math.round(state.score)}`
                        : state.status === 'insufficient_data'
                          ? 'nothing to measure'
                          : `${state.findings} finding${state.findings === 1 ? '' : 's'}`)
                      : (state.error || 'failed'))
                    : m.status === 'running' ? 'running…' : busy ? 'waiting its turn' : 'ready'}
                </Muted>
              </div>
            );
          })}

          {/* The crawl is a different kind of job: minutes, not seconds, and it
              runs on the crawl worker rather than in the request. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--neutral-600)' }} />
            Site crawl
            <Muted style={{ marginLeft: 'auto' }}>queued for the crawl worker afterwards</Muted>
          </div>
        </div>

        {results && !results.running && (
          <div
            style={{
              padding: 10, borderRadius: 'var(--r-md)', fontSize: 12.5,
              background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)',
            }}
          >
            {results.ran} of {results.ran + results.failed} module audits saved to this project.
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: 12, borderRadius: 'var(--r-md)', fontSize: 12.5, lineHeight: 1.5,
              background: 'color-mix(in srgb, var(--viz-neg) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--viz-neg) 40%, transparent)',
              color: 'var(--viz-neg)',
            }}
          >
            {error}
            <div style={{ marginTop: 6, color: 'var(--text-3)' }}>
              Scheduled crawls are still owner-scoped from the crawler module, so only the person
              who created this project can start one until that route moves onto the shared
              workspace check.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Running audits…' : 'Run audits'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
