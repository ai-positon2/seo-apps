// UNREFERENCED — kept for reference, mounted nowhere.
//
// This rendered a summary of a module's stored run above that module's own
// report: score, severity counts, findings table, run history. On a page that
// already shows the real report it duplicated it in a second visual language,
// and on Competitor Research it repeated the dashboard's own units, domains and
// keyword gap directly above them.
//
// What replaced it: the dashboard card links straight to the module's real
// report (client/src/lib/moduleReportRoute.js), and where that report renders
// from page state, ProjectReportLoader hands the stored run to it and prints one
// line saying whose report it is. The report is the report.
//
// Delete both files when you are sure the summary is not wanted anywhere.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge, Button, Card, DataTable, EmptyState, MetricCard, ScoreRing, SectionHeader,
} from '../../ui';
import { projectsApi, relativeTime, MODULE_STATUS_LABEL, MODULE_STATUS_TONE, isModuleInFlight } from '../../lib/projectsApi';
import { useActiveProjectId } from '../../lib/activeProject';
import { cs } from '../../lib/crawlScopeApi';
import ModuleDetailSection, { Caveats } from './moduleDetailSections';
import { moduleReportRoute } from '../../lib/moduleReportRoute';

// ── One module's project evidence, on the module's own page ──────────────────
//
// The counterpart to <ModuleRuns/>, which answers "what has this tool been used
// for lately". This answers "what does this tool currently say about the client
// we are looking at" — the expanded form of that module's dashboard card.
//
// It renders the SAME card object the dashboard renders (the server returns it),
// so the headline here can never disagree with the headline there. Everything
// below the headline is what the card had no room for: all the findings rather
// than the top four, the module's own stored detail, and the run history.
//
// The client it follows is the one in the header switcher — same
// useActiveProjectId store — so switching client up there changes this panel.
//
// Opening a module shows that module's OWN report, not a summary of it. How that
// happens depends on where the module keeps its report:
//
//   • SEO & GEO, On-Page, Agent Readiness render their report from page state,
//     so the stored run is handed straight to it (`onOpenReport`) and the page
//     shows exactly what an individual run shows. This happens automatically on
//     open — that is the point — and every one of those views has its own reset
//     for going back to an ad-hoc URL.
//
//   • Site Crawler, Content Architect and Competitor Research keep their report
//     on a route of their own. Those get a prominent link rather than an
//     automatic redirect: bouncing someone off a tool page they navigated to
//     deliberately is worse than one clearly-labelled click.

const TONE_TO_VARIANT = {
  accent: 'success',
  warn: 'warning',
  neg: 'danger',
  muted: 'neutral',
};

// What put a run on the board. Worth naming rather than printing the raw
// column: "auto_setup" is the one a reader is most likely to be surprised by —
// a metered comparison they did not press a button for — and "domains added" is
// the answer to the question they will actually be asking.
const TRIGGER_LABEL = {
  audit_all: 'full audit',
  auto_setup: 'domains added',
  manual: 'manual',
  schedule: 'schedule',
};

const SEVERITY_VARIANT = {
  error: 'danger',
  warning: 'warning',
  notice: 'info',
  info: 'neutral',
};

export default function ModuleDetailPanel({ moduleKey, onOpenReport }) {
  const navigate = useNavigate();
  const [activeProjectId] = useActiveProjectId();

  const [projects, setProjects] = useState(null);      // null = still loading
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);
  const [showAllFindings, setShowAllFindings] = useState(false);

  // Auto-open once per stored run. Without the guard, handing the report to the
  // page would re-fire on every render and fight anything the user does in it.
  const openedRunId = useRef(null);

  // Which client this panel is about: the header's selection, resolved against
  // what the server actually returned so a stale id falls back rather than
  // blanking the panel.
  const project = useMemo(() => {
    if (!projects?.length) return null;
    return projects.find((p) => p.id === activeProjectId) || projects[0];
  }, [projects, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    projectsApi.list()
      .then((data) => { if (!cancelled) setProjects(data.projects || []); })
      .catch((e) => { if (!cancelled) { setProjects([]); setError(e); } });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      setDetail(await projectsApi.moduleDetail(project.id, moduleKey));
      setError(null);
    } catch (e) {
      setError(e);
      setDetail(null);
    }
  }, [project, moduleKey]);

  useEffect(() => { load(); }, [load]);

  // Hand the stored run to the page's own report view, so opening the module
  // shows what an individual run shows rather than a summary of it.
  const nativeReport = detail?.payload?.native || null;
  const storedRunId = detail?.run?.id || null;

  useEffect(() => {
    if (!onOpenReport || !nativeReport || !storedRunId) return;
    if (openedRunId.current === storedRunId) return;
    openedRunId.current = storedRunId;
    onOpenReport(nativeReport, detail);
  }, [onOpenReport, nativeReport, storedRunId, detail]);

  async function run() {
    if (!project) return;
    setBusy(true);
    setRunError(null);
    try {
      if (moduleKey === 'technical') {
        // A crawl is minutes of work on the crawl worker, so this hands off to
        // the run page rather than waiting here.
        const { run: crawlRun } = await cs.runProjectNow(project.id);
        navigate(`/crawl-scope/runs/${crawlRun.id}`);
        return;
      }
      await projectsApi.runModule(project.id, moduleKey);
      await load();
    } catch (e) {
      setRunError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show yet, and nothing worth a placeholder either.
  if (projects === null) return null;

  if (!projects.length) {
    return (
      <Card style={{ marginBottom: 20 }}>
        <EmptyState
          title="No client project yet"
          description={
            'This panel shows what this module has found for one client. Create a project on the '
            + 'home screen and it fills in — the tool below works on any URL in the meantime.'
          }
          action={<Button variant="secondary" onClick={() => navigate('/')}>Go to the dashboard</Button>}
        />
      </Card>
    );
  }

  if (error) {
    // A failure here must not sit on top of a working tool as a red box, so it
    // states itself quietly and stays out of the way.
    return (
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader as="h2" title={`This project — ${project?.name || ''}`} />
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3)' }}>
          Couldn’t load this project’s results: {error.message}
        </p>
      </Card>
    );
  }

  if (!detail) return null;

  const { card, run: lastRun, inFlightRun, findings, payload, history, cost, module } = detail;
  const scored = Boolean(card.scored);
  const counts = card.evidence?.counts || lastRun?.counts || {};
  const running = isModuleInFlight(card.status) || Boolean(inFlightRun);

  const visibleFindings = showAllFindings ? findings : findings.slice(0, 25);
  // The same helper the dashboard card uses, fed the payload's ref so the panel
  // and the card always agree about where this module's report is.
  const routeInfo = moduleReportRoute({
    key: moduleKey,
    toolPath: module.toolPath,
    runId: payload?.crawlRunId || null,
    reportRef: payload?.reportRef || null,
    evidence: card.evidence,
    status: card.status,
  });
  // Only a route AWAY from here is worth a button; the in-page modules have
  // already hydrated by the time this renders.
  const reportRoute = routeInfo.isReport && routeInfo.path !== module.toolPath
    ? { path: routeInfo.path, label: 'Open the full report' }
    : null;

  // A run stored before native reports were kept has findings but no report to
  // open. Saying so beats a button that does nothing.
  const reportMissing = Boolean(lastRun) && !nativeReport && !reportRoute;

  return (
    <Card style={{ marginBottom: 20 }}>
      <SectionHeader
        as="h2"
        eyebrow="This project"
        title={`${module.label} — ${project.name}`}
        subtitle={
          lastRun?.finishedAt
            ? `Last run ${relativeTime(lastRun.finishedAt)}`
            : running ? 'Running now' : 'Not run for this project yet'
        }
        actions={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge variant={TONE_TO_VARIANT[MODULE_STATUS_TONE[card.status]] || 'neutral'}>
              {MODULE_STATUS_LABEL[card.status] || card.status}
            </Badge>

            {/* This module's own report, wherever it lives. */}
            {reportRoute && (
              <Button variant="primary" size="sm" onClick={() => navigate(reportRoute.path)}>
                {reportRoute.label}
              </Button>
            )}
            {!reportRoute && nativeReport && onOpenReport && (
              <Button variant="primary" size="sm" onClick={() => onOpenReport(nativeReport, detail)}>
                Show this project’s report
              </Button>
            )}
            {module.runnable || moduleKey === 'technical' ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                disabled={busy || running}
                onClick={run}
              >
                {running ? 'Running…' : lastRun ? 'Re-run' : 'Run'}
                {/* A metered module states its price on the button itself, not in
                    a tooltip nobody opens. "up to" when this run would find its
                    own competitors first (assumesAutoDiscovery) — the ceiling is
                    real, but discovery may add fewer, or none. */}
                {cost
                  ? ` · ${cost.assumesAutoDiscovery ? 'up to ' : ''}${cost.estimate.toLocaleString('en-US')} ${cost.unit}`
                  : ''}
              </Button>
            ) : null}
          </div>
        )}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Headline: the score when the module has a rubric, severity counts
            otherwise. Never both, and never a zero standing in for neither. */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <ScoreRing score={scored ? card.score : null} size={80} label={scored ? 'score' : 'not scored'} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 16, color: 'var(--text)' }}>{card.headline}</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>{card.detail}</span>
            {/* A number is only defensible if you can say what produced it. */}
            {scored && card.scoreBasis && (
              <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                {card.scoreBasis}
              </span>
            )}
            {!scored && findings.length > 0 && (
              <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                This module reports findings, not a 0–100 score.
              </span>
            )}
          </div>
        </div>

        {card.error && (
          <Caveats items={[card.error]} />
        )}

        {runError && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--danger)' }}>{runError}</p>
        )}

        {(counts.error || counts.warning || counts.notice) ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
            <MetricCard label="Errors" value={counts.error ?? 0} />
            <MetricCard label="Warnings" value={counts.warning ?? 0} />
            <MetricCard label="Notices" value={counts.notice ?? 0} />
            <MetricCard label="Findings stored" value={findings.length} />
          </div>
        ) : null}

        {/* Module-specific detail from the stored payload. */}
        <ModuleDetailSection moduleKey={moduleKey} payload={payload} navigate={navigate} />

        {reportMissing && (
          <Caveats items={[
            'This run was recorded before the module’s own report was kept with it, so only the '
            + 'summary above is available. Re-run the module and the full report opens here.',
          ]} />
        )}

        {detail.payloadTruncated && (
          <Caveats items={[
            'This run’s stored detail was too large to keep in full, so some of it was trimmed. '
            + 'Re-run the module to regenerate it.',
          ]} />
        )}

        {findings.length > 0 && (
          <DataTable
            title={`All ${findings.length} finding${findings.length === 1 ? '' : 's'}`}
            columns={[
              {
                key: 'severity',
                label: 'Severity',
                width: 110,
                render: (v) => <Badge variant={SEVERITY_VARIANT[v] || 'neutral'}>{v}</Badge>,
              },
              { key: 'title', label: 'Finding', maxWidth: 340 },
              { key: 'category', label: 'Category', width: 150 },
              { key: 'count', label: 'Affected', align: 'right', width: 90 },
              { key: 'detail', label: 'Detail', wrap: true, maxWidth: 420 },
              { key: 'recommendation', label: 'What to do', wrap: true, maxWidth: 420 },
            ]}
            rows={visibleFindings.map((f) => ({
              severity: f.severity,
              title: f.title,
              category: f.category || '—',
              count: f.count,
              detail: typeof f.detail === 'string' ? f.detail : (f.detail ? JSON.stringify(f.detail) : '—'),
              recommendation: f.recommendation || '—',
            }))}
            stickyHeader
          />
        )}

        {findings.length > visibleFindings.length && (
          <Button variant="ghost" size="sm" onClick={() => setShowAllFindings(true)}>
            Show all {findings.length} findings
          </Button>
        )}

        {history.length > 1 && (
          <DataTable
            title="Previous runs for this project"
            columns={[
              { key: 'when', label: 'When' },
              { key: 'status', label: 'Status', render: (v) => <Badge variant={TONE_TO_VARIANT[MODULE_STATUS_TONE[v]] || 'neutral'}>{MODULE_STATUS_LABEL[v] || v}</Badge> },
              { key: 'score', label: 'Score', align: 'right', width: 90 },
              { key: 'findings', label: 'Findings', align: 'right', width: 100 },
              { key: 'trigger', label: 'Started by' },
            ]}
            rows={history.map((h) => ({
              when: relativeTime(h.finishedAt || h.startedAt),
              status: h.status,
              // An em dash, not a 0: these modules do not all score.
              score: h.score === null || h.score === undefined ? '—' : h.score,
              findings: h.findingCount,
              trigger: TRIGGER_LABEL[h.trigger] || h.trigger || 'manual',
            }))}
          />
        )}

        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Read from {module.evidenceSource}
          {module.dependsOn ? ` · needs ${module.dependsOn}` : ''}
        </span>
      </div>
    </Card>
  );
}
