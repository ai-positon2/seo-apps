import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { projectsApi, relativeTime, countryLabel, isModuleInFlight } from '../lib/projectsApi';
import { useActiveProjectId, useProjectsChanged } from '../lib/activeProject';
import { cs } from '../lib/crawlScopeApi';
import {
  Card, Muted, Tag, Btn, FadingRule,
} from '../components/studio/primitives';
import { friendlyError, errorDetail } from '../lib/friendlyError';
import ModuleCard from '../components/home/ModuleCard';
import SiteFavicon from '../components/home/SiteFavicon';
import AuditRadar from '../components/home/AuditRadar';
import ProfileStats from '../components/home/ProfileStats';
import ExecutiveSummary from '../components/home/ExecutiveSummary';
import ProjectSetupCard from '../components/home/ProjectSetupCard';
import HomeSkeleton from '../components/home/HomeSkeleton';
import { takePrefetch } from '../lib/homePrefetch';

// How often the dashboard re-reads itself while a crawl is running. The crawl
// BAR is not this — that lives in the app shell and polls a cheap endpoint of its
// own. This is the dashboard's own numbers, which a running crawl keeps changing.
const CRAWL_POLL_MS = 8000;

// Section and card labels on Home: sentence case at a readable size. These
// replaced the Kicker / SectionHead / `eyebrow` forms — 10-13px letter-spaced
// capitals — which a reader has to decode before they can skip them. Smaller and
// quieter than what they label, so the hierarchy still reads at a glance.
const LABEL = { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' };
const LABEL_TONE = {
  accent: 'var(--primary-text)',
  neg: 'var(--viz-neg)',
};
const Label = ({ children, tone }) => (
  <span style={{ ...LABEL, ...(LABEL_TONE[tone] ? { color: LABEL_TONE[tone] } : null) }}>{children}</span>
);

/**
 * A failed read, as a sentence the reader can act on, with the original text
 * behind a native disclosure for whoever has to debug it. The disclosure only
 * renders when friendlyError() actually replaced something.
 */
function ErrorText({ err, size = 13 }) {
  const detail = errorDetail(err);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Muted size={size} style={{ color: 'var(--text-2)' }}>{friendlyError(err)}</Muted>
      {detail && (
        <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
          <summary style={{ cursor: 'pointer' }}>Show details</summary>
          {detail}
        </details>
      )}
    </span>
  );
}

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
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const reportMenuRef = useRef(null);
  useEffect(() => {
    if (!reportMenuOpen) return undefined;
    const onDoc = (e) => { if (reportMenuRef.current && !reportMenuRef.current.contains(e.target)) setReportMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setReportMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [reportMenuOpen]);
  // Bumped when a backlog item is drafted into a recommendation, so the board
  // below re-reads rather than appearing to swallow it.
  // Set when a full audit finishes, so the result is reported where the user
  // already is instead of by navigating them into the crawler's console.
  const [auditBanner, setAuditBanner] = useState(null);
  // What the server did about Competitor Research when the project was created.
  // It starts by itself once a primary domain and a competitor exist, and it
  // bills per domain — so whether it started, or why it didn't, is reported
  // here rather than left for someone to infer from a card.
  const [competitorBanner, setCompetitorBanner] = useState(null);
  // The cross-module answer. Owned here because the takeaway at the top of the
  // page and the panel further down are the same answer.
  const [insights, setInsights] = useState({ loading: true, error: null, data: null });

  // Declared up here, above the loaders that read it, for the same reason the
  // note below gives: anything they close over has to already exist by the time
  // this component body runs.
  const wantedProjectId = useRef(null);

  // Set when this page unmounts, so the two long-running poll loops below can
  // stop. They are not effects and nothing tears them down: `runModule` polls
  // every 8 seconds for up to FORTY MINUTES and `runFullAudit` every 3 for six,
  // so pressing Run and then walking to another tool left the app issuing
  // requests for a screen that no longer existed — and calling setState on it —
  // for the rest of the deadline. The same pattern, for the same reason, is in
  // components/aiVisibility/RunMeasurementButton.jsx.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);

  // A poll result is only allowed onto the screen if this page is still mounted
  // AND still showing the client it was started for. Without the second half, a
  // run started on one client and left to poll would overwrite the dashboard
  // after the user switched to another — the exact failure `wantedProjectId`
  // was introduced to prevent for the loaders, which the imperative loops never
  // adopted.
  const stillWanted = useCallback(
    (projectId) => !unmounted.current && wantedProjectId.current === projectId,
    [],
  );

  // Takes the project id as an argument rather than closing over activeProject.
  // It has to: this is declared above the useMemo that computes activeProject, so
  // referencing it here is a temporal-dead-zone error that throws on every render
  // and blanks the page. The build compiles it without complaint.
  const loadInsights = useCallback(async (projectId) => {
    if (!projectId) return;
    setInsights((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // Started before React mounted, while the session was still being verified
      // — see lib/homePrefetch.js. Null on every read after the first.
      const data = await (takePrefetch('insights', projectId) || projectsApi.insights(projectId));
      if (wantedProjectId.current !== projectId) return;   // see wantedProjectId
      setInsights({ loading: false, error: null, data });
    } catch (e) {
      if (wantedProjectId.current !== projectId) return;
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
      const data = await (takePrefetch('projects') || projectsApi.list());
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
  //
  // But a selection missing from THIS page's list is not necessarily stale: the
  // list is read once on mount, and a project created since — in another tab,
  // by a teammate, or moments ago with its first crawl still running — is not
  // in it yet. "Repairing" that straight away bounced the header back to the
  // first client, so a brand-new, still-crawling project could not be selected.
  // Re-read the list once for that id first; repair only if it is still absent.
  const recheckedFor = useRef(null);
  useEffect(() => {
    if (!activeProject || activeProject.id === activeProjectId) return;
    if (listState.loading) return;
    if (activeProjectId && recheckedFor.current !== activeProjectId) {
      recheckedFor.current = activeProjectId;
      loadProjects();
      return;
    }
    setActiveProjectId(activeProject.id);
  }, [activeProject, activeProjectId, setActiveProjectId, listState.loading, loadProjects]);

  // Re-read when the set of projects changes elsewhere in this tab (created,
  // deleted, restored) — the header's list already does.
  const projectsVersion = useProjectsChanged();
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) { firstVersion.current = false; return; }
    loadProjects();
  }, [projectsVersion, loadProjects]);

  // ── Which project the evidence reads below are for ──────────────────────
  //
  // This waited for /api/projects, which put the dashboard three round trips
  // deep before a single number appeared: verify the session, list the projects,
  // then read the overview — each one starting only once the last had landed.
  //
  // The list is the slowest of the three and, on every visit after the first, it
  // almost always just confirms the choice already sitting in localStorage. So
  // the stored id is used immediately and the list merely corrects it: when the
  // two agree, the effects below never re-run and the overview has been in
  // flight the whole time the list was, for one round trip instead of two.
  //
  // When they disagree — a deleted project, a different workspace — this id
  // changes to the one the server actually returned and the panels reload. The
  // speculative read is still membership-checked server-side like any other; a
  // stale id gets a 403, and the guard below drops that reply rather than
  // flashing an error for a project nobody asked to see.
  const evidenceProjectId = activeProject?.id
    || (listState.loading ? activeProjectId : null);

  // The id the panels are currently meant to be showing, readable from inside an
  // async read that started before it changed. Anything else resolving is stale:
  // a speculative read the list rejected, or a slow reply for a client the user
  // has already switched away from. Either would otherwise overwrite the newer
  // answer, since neither fetch cancels the other.
  useEffect(() => { wantedProjectId.current = evidenceProjectId; }, [evidenceProjectId]);

  // ── Load the selected project's overview ──────────────────────────────────
  const loadOverview = useCallback(async (projectId, { quiet = false } = {}) => {
    if (!projectId) return;
    // A quiet reload keeps what is on screen while it refetches. The crawl
    // poller below uses it: dropping to a spinner every few seconds would make
    // the dashboard flash, lose scroll position, and tell the reader less than
    // the slightly stale numbers it just threw away.
    if (!quiet) setOverview({ loading: true, error: null, data: null });
    try {
      // A quiet reload is the crawl poller asking for what changed, so it must
      // never be served the startup read — takePrefetch is single-use, but this
      // says so at the call site too.
      const data = await ((!quiet && takePrefetch('overview', projectId))
        || projectsApi.overview(projectId));
      if (wantedProjectId.current !== projectId) return;   // see wantedProjectId
      setOverview({ loading: false, error: null, data });
    } catch (e) {
      // A dropped poll is not a broken dashboard. Only a reload the user asked
      // for is allowed to replace the page with an error.
      if (quiet) return;
      if (wantedProjectId.current !== projectId) return;
      setOverview({ loading: false, error: e, data: null });
    }
  }, []);

  useEffect(() => {
    if (evidenceProjectId) loadOverview(evidenceProjectId);
  }, [evidenceProjectId, loadOverview]);

  // The cross-module answer, read once per client and shared by the takeaway at
  // the top of the page and the panel below it.
  useEffect(() => {
    if (evidenceProjectId) loadInsights(evidenceProjectId);
  }, [evidenceProjectId, loadInsights]);

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
  // The shell already polls this (components/MacWindow.jsx) and draws the crawl
  // bar from it. This page used to start a SECOND poller against the same
  // endpoint on the same cadence, so the dashboard asked twice for one answer --
  // and against the configured database that endpoint is several round trips.
  // Read from the outlet context instead. The ?? {} keeps this a no-op rather
  // than a crash if the page is ever rendered outside the shell.
  const { status: crawlStatus, refresh: refreshCrawl } = useOutletContext() ?? {};
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

    // `queued` counts as started. AI Visibility is enqueued for the module
    // worker rather than run inside the request, so its run is queued until a
    // worker claims it; returning here would stop polling before it began.
    if (!isModuleInFlight(run?.status)) return;
    const deadlineAt = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadlineAt && stillWanted(projectId)) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 8000));
      // Checked again after the wait: eight seconds is plenty of time to leave
      // the page or switch client, and the request below should not be sent at
      // all in that case.
      if (!stillWanted(projectId)) return;
      let data;
      try {
        // eslint-disable-next-line no-await-in-loop
        data = await projectsApi.overview(projectId);
      } catch {
        continue; // a dropped poll is not a failed run — keep trying
      }
      if (!stillWanted(projectId)) return;
      setOverview({ loading: false, error: null, data });
      const stillRunning = (data.modules || []).some((m) => m.key === moduleKey && isModuleInFlight(m.status));
      if (!stillRunning) break;
    }
  }, [activeProject, loadOverview, stillWanted]);

  /**
   * Turn one executive priority into a recommendation draft.
   *
   * A draft, never a proposal: POST /insights/promote is explicit that a person
   * decides what is worth advising on, and auto-proposing would make the
   * approval queue meaningless. The insight layer is re-read afterwards so the
   * "To fix" figure above and this block agree about what is still open.
   *
   * Errors propagate to the row that asked — it reports them in place, which is
   * where the person clicked.
   */
  const promoteInsight = useCallback(async (key) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    await projectsApi.promoteInsight(projectId, key);
    if (stillWanted(projectId)) loadInsights(projectId);
  }, [activeProject, loadInsights, stillWanted]);

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
      refreshCrawl?.();
    } catch (e) {
      // The sheet is already closed, so a failure has to be reported on the page
      // rather than back inside a modal the user has stopped looking at.
      // The error itself is kept, so the banner can show the reader's sentence
      // and still offer the original behind "Show details".
      setAuditError(e);
      return;
    }

    // Watch the overview until nothing is running. Each module writes a
    // 'running' row before it begins, so progress is read from stored state
    // rather than guessed from elapsed time.
    //
    // Pinned to the project the audit was STARTED for, not to whatever
    // `activeProject` points at by the time a tick fires. Reading it from the
    // closure on every iteration meant switching client mid-audit silently
    // repointed the poll at the new one — six minutes of polls attributing one
    // client's audit to another's dashboard.
    const auditedProjectId = activeProject.id;
    const deadlineAt = Date.now() + 6 * 60 * 1000;
    let last = null;
    while (Date.now() < deadlineAt && stillWanted(auditedProjectId)) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!stillWanted(auditedProjectId)) return;
      try {
        last = await projectsApi.overview(auditedProjectId);
        if (!stillWanted(auditedProjectId)) return;
        setOverview({ loading: false, error: null, data: last });
        const stillRunning = (last.modules || []).some((m) => isModuleInFlight(m.status));
        if (!stillRunning) break;
      } catch {
        // A failed poll is not a failed audit — the work continues server-side.
        // Keep polling; the deadline below is the only thing that gives up.
      }
    }

    // Left the page, or switched client, while the audit ran. The audit itself
    // is server-side and unaffected; there is just nothing here to report it to.
    if (!stillWanted(auditedProjectId)) return;

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
    // No setup instructions here. "Set DATABASE_URL, then reload" is a sentence
    // for whoever runs the server, shown to someone who cannot act on it;
    // friendlyError turns it into "ask an admin" and keeps the original behind
    // Show details.
    return (
      <div style={{ padding: '28px 32px', maxWidth: 720 }}>
        <Card style={{ padding: 24, gap: 10 }}>
          <Label>Projects unavailable</Label>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>
            {notConfigured ? 'Projects aren’t available on this server yet' : 'Could not load projects'}
          </h1>
          <ErrorText err={listState.error} />
          {notConfigured && (
            <Muted size={13}>
              Every tool in the sidebar that does not need saved projects keeps working in the
              meantime.
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
            <Label tone="accent">Start here</Label>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em' }}>
              No client projects yet
            </h1>
            {/* The next step, not just the state: what to fill in and what to
                press, and what happens after. */}
            <Muted size={14}>
              Enter the client&rsquo;s website and country below, then press{' '}
              <strong style={{ color: 'var(--text-2)' }}>Create project</strong>. The first scan
              starts by itself, and this page fills in as the results arrive.
            </Muted>
          </div>
        )}
        <ProjectSetupCard
          limits={listState.data?.limits}
          workspaces={listState.data?.workspaces || []}
          activeWorkspaceId={listState.data?.activeWorkspaceId || null}
          onCreated={async (project, competitorResearch) => {
            setShowSetup(false);
            // Only worth a banner when there is something to say: a project
            // created with no competitors and no auto-discovery was never going
            // to start a comparison, and saying so would be noise.
            setCompetitorBanner(
              competitorResearch?.note ? competitorResearch : null,
            );
            // Load the fresh list BEFORE switching to the new project, not
            // after. The "resolve against what actually came back" effect
            // above (line ~141) treats an active id it can't find in `projects`
            // as stale and falls back to `projects[0]` — correct for a
            // genuinely deleted project, wrong for one that is simply newer
            // than the last list fetch. Setting the active id first raced that
            // effect against this await: React re-rendered on the synchronous
            // id change while `projects` was still the pre-creation list, so
            // the repair effect "corrected" the brand-new project back to
            // whichever project happened to be first — silently, before this
            // await even resolved. Awaiting first means `projects` already
            // contains the new project by the time its id is ever set, so the
            // repair effect never has a stale list to be fooled by.
            const data = await loadProjects();
            setActiveProjectId(project.id);
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
  // So nothing renders until the LIST and the OVERVIEW have resolved. "Resolved"
  // includes failure — a request that errored is finished, and its section says
  // so — otherwise one broken read would hold the page on a skeleton forever.
  //
  // The insight layer is deliberately NOT waited for, and that is a change. It
  // used to be, back when it rendered as two whole sections of the page and
  // arriving late meant everything below the header jumped. Those sections are
  // gone: all that is left of it up here is the "To fix" figure, one of four
  // stats in a fixed grid, which has its own designed pending state and cannot
  // reflow anything by filling in.
  //
  // Waiting for it was costing the whole page the difference. On the live Palo
  // Alto project the overview resolves in ~2.4s and the insight layer in ~5.7s,
  // because it re-reads every finding in the crawl and then walks each module's
  // last two runs — so five of those seconds bought one number, while the six
  // module cards it was holding back had been ready the whole time.
  //
  // A quiet crawl poll never re-enters this: it leaves the previous data in
  // place, so `overview.data` stays truthy and the page never flickers back to
  // the skeleton while a crawl runs.
  const settled = (s) => Boolean(s.data) || Boolean(s.error);
  if (activeProject && !settled(overview)) {
    return <HomeSkeleton />;
  }

  const data = overview.data;
  const modules = data?.modules || [];
  // The scraped AI Visibility module stays in `modules` — moduleDetail routing
  // and in-flight-run polling key off its entry existing (see overview.js) —
  // but it answers the same question as AI Visibility Lite, so anything that
  // displays one card/axis per module shows this list instead.
  const visibleModules = modules.filter((m) => m.card !== false);
  const composite = data?.composite;

  const lastRunAt = modules.map((m) => m.updatedAt).filter(Boolean).sort().reverse()[0] || null;

  return (
    <div
      style={{
        padding: '24px 32px 64px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        maxWidth: 1520,
        margin: '0 auto',
      }}
    >
      {/* ── Active client ─────────────────────────────────────────────────── */}
      <Card elevation="md" style={{ padding: 24, gap: 14, borderRadius: 'var(--r-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 280 }}>
            {/* The client's own mark beside their name, so the page looks like it
                is about them rather than about the tool. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <SiteFavicon
                origin={activeProject.primaryDomain?.origin}
                name={activeProject.name}
                size={44}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                {/* The page's one h1: the page is about this client. Same look
                    it had as an h2. */}
                <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1.2 }}>
                  {activeProject.name}
                </h1>
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
                    /* Both of these used to be dead labels: they named a problem
                       and left you to find the screen that fixes it. They are
                       buttons now, pointing at the settings panel that holds the
                       control — which, for the domain, did not exist until the
                       setter was added there. */
                    <button
                      type="button"
                      onClick={() => navigate('/projects')}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      title="Set this project's primary domain"
                    >
                      <Tag tone="warn">Set primary domain →</Tag>
                    </button>
                  )}
                  {activeProject.countryCode
                    ? <Muted size={12}>· {countryLabel(activeProject.countryCode)}</Muted>
                    : (
                      <button
                        type="button"
                        onClick={() => navigate('/projects')}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                        title="Set this project's country"
                      >
                        <Tag tone="warn">Set country →</Tag>
                      </button>
                    )}
                  <Muted size={12}>
                    · {activeProject.schedule.enabled ? 'Weekly scan on' : 'No weekly scan'}
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
              // What it does, for the person deciding whether to press it — not
              // which internal modules run in which order.
              title="Scans the whole site and checks every area, then updates the scores on this page."
              style={{ fontSize: 14, height: 42, padding: '0 20px' }}
            >
              <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" style={{ display: 'block' }}>
                <path d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z" />
              </svg>
              Run Full Audit
            </Btn>
            {/* How many pages the crawl behind this button will fetch, and
                the one place you can change it.
                Next to the button rather than in project settings, because it
                is the ceiling on the pages every score below is computed over:
                a client stored with a small budget re-crawled that fraction of
                the site every week, and the number appeared nowhere on this
                screen. Editable here because the moment you want to change it
                is the moment you are about to press Run. */}
            <CrawlBudget
              /* Keyed, so switching client REMOUNTS it. Without this the
                 editor's own state belonged to whichever project was open
                 first: switch client mid-edit and you were looking at the
                 previous project's number, in an open field, above a Save
                 button that would write it to the new one. The same bug the
                 project detail panel had, reintroduced here. */
              key={activeProject.id}
              project={activeProject}
              canEdit={canEdit}
              workspaceMax={Number(listState.data?.limits?.maxUrlsPerCrawl) || null}
              onSaved={loadProjects}
            />
            {/* The explanations moved to tooltips. They described the app's own
                mechanics — which modules run in what order — to a reader who wants
                to know whether their site is in trouble.

                Same comprehensive report — every module combined, plus what it
                does not cover — in three renderings: the workbook for a
                spreadsheet reader, a PDF for forwarding as-is, markdown for
                pasting into a doc. */}
            <div ref={reportMenuRef} style={{ position: 'relative' }}>
              <Btn
                variant="secondary"
                onClick={() => setReportMenuOpen((v) => !v)}
                title="One report of everything stored for this project, including what it does not cover — choose a format."
                style={{ height: 42, fontSize: 13, padding: '0 16px' }}
              >
                Download report {reportMenuOpen ? '▲' : '▾'}
              </Btn>
              {reportMenuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 30,
                    minWidth: 180, padding: 6, borderRadius: 'var(--r-md)',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    boxShadow: 'var(--shadow-md)', display: 'flex', flexDirection: 'column', gap: 2,
                  }}
                >
                  {[
                    ['xlsx', 'Excel workbook', 'One sheet per module, filterable'],
                    ['pdf', 'PDF', 'Fixed layout, ready to forward'],
                    // Says "text file", not "copy": the item downloads a file,
                    // and a hint promising a clipboard copy would be wrong.
                    ['md', 'Markdown', 'Plain text file, to paste into a doc'],
                  ].map(([format, label, hint]) => (
                    <button
                      key={format}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        window.location.href = projectsApi.reportUrl(activeProject.id, format);
                        setReportMenuOpen(false);
                      }}
                      style={{
                        display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left',
                        padding: '7px 10px', borderRadius: 6, border: 'none', background: 'none',
                        cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <span style={{ fontSize: 13, color: 'var(--text)' }}>{label}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* The crawl bar used to sit here. It is in the app shell now, above
            every screen, so a crawl stays visible when you walk over to another
            tool — see components/MacWindow.jsx and lib/useCrawlStatus.js. */}
      </Card>

      {/* ── The answer, first ───────────────────────────────────────────────
          The verdict, one sentence, and the top three fixes, directly under the
          client's name — above the score tiles and the per-area cards it is
          drawn from.

          History, because this has moved before: it sat at the bottom, below
          the module profile, on the product owner's earlier decision that the
          individual agent scores should come first (the 25 Sep 2026 design
          audit's HOME-5 moved it up; that was reverted at the owner's request).
          It is back at the top for the executive audience, who read the answer
          and stop — at the bottom it was ~1,100px down, below the fold on a
          laptop, under a radar that needed a paragraph of explanation.
          Moving it back is this one block.

          Everything in it is a restatement of a stored figure; the wording is
          composed and tested server-side (insights/executive.js) so the rules
          about what may be claimed live in one place. */}
      <ExecutiveSummary
        /* Keyed, so switching client REMOUNTS it rather than showing the
           previous client's verdict while the new one loads. The same reason
           CrawlBudget and ProjectDetail are keyed. */
        key={activeProject.id}
        projectId={activeProject.id}
        onPromote={promoteInsight}
      />

      {/* The four figures behind the answer, in the reader's numbers.
          This was one line — "12 things to fix, 7 of them one template change"
          — which answered one of the four questions somebody opens this page
          with and left the other three to be assembled out of the six cards
          below. See components/home/ProfileStats.jsx.
          Its own card now, rather than the lower half of the header, so the
          summary can sit between the client's name and these numbers. */}
      <Card style={{ padding: 20, gap: 0 }}>
        <ProfileStats
          composite={composite}
          modules={modules}
          insights={insights.data}
          insightsLoading={insights.loading}
          insightsError={insights.error}
          // The shell's crawl status is for the active client, so a run id
          // means this client is being scanned right now.
          crawling={Boolean(liveCrawlRunId)}
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
            <Label tone="neg">Audit not started</Label>
            <span style={{ fontSize: 14, color: 'var(--text)' }}>
              The audit could not be started. {friendlyError(auditError)}
            </span>
            {errorDetail(auditError) && (
              <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
                <summary style={{ cursor: 'pointer' }}>Show details</summary>
                {errorDetail(auditError)}
              </details>
            )}
          </div>
          <Btn onClick={() => { setAuditError(null); setAuditSheet('open'); }}>Try again</Btn>
          <Btn onClick={() => setAuditError(null)}>Dismiss</Btn>
        </Card>
      )}

      {/* Competitor Research starts itself once the domains exist. What that
          did — and what it costs — is reported here rather than discovered
          later in a run history. */}
      {competitorBanner && (
        <Card style={{ padding: '12px 16px', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Label tone="accent">
              {competitorBanner.scheduled ? 'Competitor Research started' : 'Competitor Research not started'}
            </Label>
            <span style={{ fontSize: 14, color: 'var(--text)' }}>{competitorBanner.note}</span>
            {competitorBanner.scheduled && competitorBanner.estimate && (
              <Muted size={12}>
                About {competitorBanner.estimate.estimate.toLocaleString('en-US')}{' '}
                {competitorBanner.estimate.unit} across{' '}
                {competitorBanner.estimate.domains} domain
                {competitorBanner.estimate.domains === 1 ? '' : 's'}, including this project&rsquo;s own.
              </Muted>
            )}
          </div>
          <Btn onClick={() => setCompetitorBanner(null)}>Dismiss</Btn>
        </Card>
      )}

      {/* What the full audit did, reported where the user already is. */}
      {auditBanner && (
        <Card style={{ padding: '12px 16px', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Label tone="accent">Full audit complete</Label>
            <span style={{ fontSize: 14, color: 'var(--text)' }}>
              {auditBanner.ran} of {auditBanner.total} area
              {auditBanner.total === 1 ? '' : 's'} updated
              {auditBanner.failed ? ` · ${auditBanner.failed} failed` : ''}
              {auditBanner.crawlRunId ? ' · site scan running' : ''}
            </span>
            <Muted size={12}>
              {auditBanner.followingLiveCrawl
                ? 'Pages are being checked as the scan finds them. The cards below update as '
                  + 'results come in.'
                : 'No scan was running, so the page checks used the most recent completed scan.'}
            </Muted>
          </div>
          <Btn onClick={() => navigate(`/crawl-scope/runs/${auditBanner.crawlRunId}`)}>
            Watch the scan
          </Btn>
          <Btn onClick={() => setAuditBanner(null)}>Dismiss</Btn>
        </Card>
      )}

      {/* ── Audit insights ───────────────────────────────────────────────── */}
      <section>
        {/* A sentence-case h2 in place of SectionHead, whose title is 13px
            letter-spaced capitals and an h6 — wrong level under the page's h1,
            and a label the reader has to decode. Same rule and spacing. */}
        <div
          style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            gap: 12, marginBottom: 12, paddingBottom: 8,
            borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
            Where we stand
          </h2>
          <Muted size={13}>
            {overview.loading ? 'Loading…'
              : lastRunAt ? `Latest results ${relativeTime(lastRunAt)}`
              : 'Nothing has been checked yet. Run Full Audit to score this site.'}
          </Muted>
        </div>

        {overview.error && (
          <Card style={{ padding: 18, gap: 8 }}>
            <Label>Scores unavailable</Label>
            <ErrorText err={overview.error} />
            <div><Btn onClick={() => loadOverview(activeProject.id)}>Try again</Btn></div>
          </Card>
        )}

        {data && (
          <div className="home-profile">
            {/* Audit profile */}
            <Card style={{ padding: 16, gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Label tone="accent">Audit profile</Label>
                <Muted size={12}>{visibleModules.length} areas</Muted>
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
              <AuditRadar modules={visibleModules} />

              <FadingRule style={{ marginTop: 4 }} />

              {/* The chart cannot say this and must not be read as saying the
                  opposite: the polygon's shape is not a statement about balance,
                  because each axis is a different module's own scale. One line —
                  the three-sentence version was a caveat longer than the chart's
                  own labels. */}
              <Muted size={12} style={{ lineHeight: 1.45 }}>
                Each area is scored on its own 0–100 scale.
              </Muted>
            </Card>

            {/* Module cards. Three to a row, which is what makes six of them
                read as one profile rather than as a list — the widths are in
                index.css because the breakpoints below need media queries. */}
            <div className="home-modules">
              {/* `card: false` keeps a module in the overview — where its
                  evidence, its detail route and its in-flight status are still
                  read — while leaving it off this grid. The scraped AI
                  Visibility module is the one that uses it: it answers the same
                  question as the API module, and two cards for one question
                  shows an implementation detail rather than a client's profile. */}
              {visibleModules.map((module) => (
                <ModuleCard key={module.key} module={module} onRun={runModule} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* "What the modules say together" used to sit here — the cross-module
          headline and the ranked "Do this next" backlog — and before that
          Activity, Alerts and a Recommendations board. Removed on request. The
          insight layer is still READ, because the "To fix" figure above is its
          backlog total; it is just not rendered as a panel of its own. */}

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
          <Label tone="accent">Run Full Audit</Label>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>{project.name}</h3>
          <Muted size={13}>
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
                      : isModuleInFlight(m.status) ? 'var(--viz-warn)' : 'var(--neutral-600)',
                  }}
                />
                {m.label}
                <Muted
                  size={12}
                  style={{ marginLeft: 'auto', textAlign: 'right', maxWidth: 240 }}
                  // The failure in the reader's words; the original on hover.
                  title={state && !state.ok && state.error ? (errorDetail(state.error) || undefined) : undefined}
                >
                  {state
                    ? (state.ok
                      ? (state.score !== null && state.score !== undefined
                        ? `scored ${Math.round(state.score)}`
                        : state.status === 'insufficient_data'
                          ? 'nothing to measure'
                          : `${state.findings} finding${state.findings === 1 ? '' : 's'}`)
                      : (state.error ? friendlyError(state.error) : 'Failed'))
                    : m.status === 'queued' ? 'queued — starts shortly'
                      : m.status === 'running' ? 'running…' : busy ? 'waiting its turn' : 'ready'}
                </Muted>
              </div>
            );
          })}

          {/* The crawl is a different kind of job: minutes, not seconds, and it
              runs on the crawl worker rather than in the request. Queued
              first (see runFullAudit), so it is described as starting shortly
              — "afterwards" stopped being true when the order was reversed. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--neutral-600)' }} />
            Site scan
            <Muted size={12} style={{ marginLeft: 'auto' }}>queued — starts shortly</Muted>
          </div>
        </div>

        {results && !results.running && (
          <div
            style={{
              padding: 10, borderRadius: 'var(--r-md)', fontSize: 13,
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
              padding: 12, borderRadius: 'var(--r-md)', fontSize: 13, lineHeight: 1.5,
              background: 'color-mix(in srgb, var(--viz-neg) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--viz-neg) 40%, transparent)',
              color: 'var(--viz-neg)',
            }}
          >
            {/* `error` is the Error itself now (see runFullAudit), so it is
                worded for the reader here rather than printed raw. */}
            {friendlyError(error)}
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

// ── The crawl budget, beside the button that spends it ──────────────────────
//
// A read-only figure at first, because that is what it is most of the time —
// and one click from being editable, because the number was previously settable
// only at project creation. `createProject` clamps a requested budget DOWNWARD
// and fills in the policy ceiling when none is given, but never raises one that
// is already stored, so a client created with 150 crawled 150 pages a week
// indefinitely and every score on this page described that fraction of the site.
//
// It reports what was actually stored rather than what was typed. The server
// clamps to the workspace's `maxUrlsPerCrawl`, and a silent clamp would leave
// the field showing a number the next crawl will not use.
function CrawlBudget({ project, canEdit, onSaved, workspaceMax = null }) {
  const stored = Number(project.crawlOptions?.maxUrls) || null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(stored ? String(stored) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // The original text of a failed save, when friendlyError replaced it. Shown
  // on hover only: the line under the field has no room for a disclosure.
  const [errorRaw, setErrorRaw] = useState(null);

  async function save() {
    const asked = Number(value);
    if (!Number.isFinite(asked) || asked < 1) {
      setError('Enter a whole number of pages.');
      return;
    }
    setSaving(true);
    setError(null);
    setErrorRaw(null);
    try {
      const { project: saved } = await projectsApi.update(project.id, {
        crawlOptions: { maxUrls: asked },
      });
      const now = Number(saved?.crawlOptions?.maxUrls);
      // Said out loud when policy lowered it. The alternative is a field that
      // quietly disagrees with the crawl it is about to start.
      if (Number.isFinite(now) && now < asked) {
        setError(`Saved as ${now.toLocaleString('en-US')} — the workspace limit is lower.`);
      } else {
        setEditing(false);
      }
      setValue(Number.isFinite(now) ? String(now) : value);
      await onSaved?.();
    } catch (e) {
      setError(friendlyError(e));
      setErrorRaw(errorDetail(e));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    // Said as what the next audit will do, not as a setting's name.
    //
    // No stored budget means the run-time default applies, which is a real
    // state and not the same as "unlimited": the crawl is still capped at the
    // workspace's maxUrlsPerCrawl, resolved when it starts. So the unset label
    // names that ceiling when the list response carried it, and never claims
    // "all pages" outright.
    const label = stored
      ? `Audit up to ${stored.toLocaleString('en-US')} pages`
      : workspaceMax
        ? `Audit up to ${workspaceMax.toLocaleString('en-US')} pages (workspace limit)`
        : 'Audit all pages the workspace allows';
    if (!canEdit) {
      return (
        <span style={{ fontSize: 13, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          {label}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="How many pages each scan of this client checks. Click to change."
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-3)',
          whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationStyle: 'dotted',
          textUnderlineOffset: 3,
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          value={value}
          autoFocus
          inputMode="numeric"
          aria-label="Pages per crawl"
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { setEditing(false); setError(null); setValue(stored ? String(stored) : ''); }
          }}
          style={{
            width: 84, height: 30, padding: '0 8px', borderRadius: 'var(--r-sm)',
            border: '1px solid var(--border-strong)', background: 'var(--surface)',
            color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>pages</span>
        <Btn
          variant="primary"
          disabled={saving || !value}
          onClick={save}
          style={{ height: 30, fontSize: 12, padding: '0 10px' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Btn>
        <Btn
          onClick={() => { setEditing(false); setError(null); setValue(stored ? String(stored) : ''); }}
          style={{ height: 30, fontSize: 12, padding: '0 10px' }}
        >
          Cancel
        </Btn>
      </span>
      <Muted
        size={12}
        style={{ color: error ? 'var(--viz-warn)' : 'var(--text-3)' }}
        title={errorRaw || undefined}
      >
        {error || 'Takes effect on the next scan — one already running keeps its limit.'}
      </Muted>
    </span>
  );
}
