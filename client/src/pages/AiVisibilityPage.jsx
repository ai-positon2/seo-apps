import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SectionHeader } from '../ui';
import { useActiveProjectId } from '../lib/activeProject';
import { projectsApi } from '../lib/projectsApi';
import { aiVisibilityApi } from '../lib/aiVisibilityApi';
import { ReportRail } from '../components/aiVisibility/ReportRail';
import { ReportHeader } from '../components/aiVisibility/ReportHeader';
import { RunDetailReport } from '../components/aiVisibility/reports/RunDetailReport';
import { OverviewReport } from '../components/aiVisibility/reports/OverviewReport';
import { InsightsReport } from '../components/aiVisibility/reports/InsightsReport';
import { PerceptionReport } from '../components/aiVisibility/reports/PerceptionReport';
import { PromptsReport } from '../components/aiVisibility/reports/PromptsReport';
import { GapsReport } from '../components/aiVisibility/reports/GapsReport';
import { SourcesReport } from '../components/aiVisibility/reports/SourcesReport';
import { ChatsReport } from '../components/aiVisibility/reports/ChatsReport';
import { PromptSetTab } from '../components/aiVisibility/PromptSetTab';
import { BrandsPanel } from '../components/aiVisibility/BrandsPanel';
import { SourcesScreen } from '../components/aiVisibility/reports/SourcesScreen';
import { muted } from '../components/aiVisibility/promptHelpers';

// ── AI Visibility ───────────────────────────────────────────────────────────
//
// Four reports over what answer engines say about this client, plus the two
// screens that decide what gets measured at all.
//
// It was nine. Each answered a slice of a question and left the reader to
// assemble the answer; these four are the questions a person actually arrives
// with — where do we stand, what are we losing, what do we do about it, and
// show me the evidence. The nine builders still exist on the server and these
// four RE-SELECT from them, so no number moved in the collapsing.
//
// The navigation is a single vertical rail, not tabs. It stays a rail: the
// setup screens sit in it too, and `ui/Tabs`' underline variant handles neither
// the count nor the grouping. The app already has the right pattern for a long
// single-select list (CrawlScopeReviewPage's rule rail), so the rail copies it.
//
// "Prompt set" and "Brands" sit in the rail as a SET UP group rather than
// behind a second layer of tabs. Both are part of this module and both gate it
// outright — an unapproved prompt set measures nothing and an unapproved brand
// set matches nothing — so burying them under a nav layer would hide the two
// screens most likely to explain why every number is an em-dash.
//
// The reading every report has to get right, and the reason so much of this
// file is about empty states: a score is over MEASURED captures, never
// attempted ones. A provider timeout is not an absent brand.

const SETUP_REPORTS = [
  { id: 'prompt-set', label: 'Prompt set', group: 'SET UP' },
  { id: 'brands', label: 'Brands', group: 'SET UP' },
];

/**
 * Which component renders which report.
 *
 * A map rather than a switch so the rail can ask "is this built?" without
 * duplicating the list — a rail item pointing at a screen that does not exist
 * is worse than one that is honestly marked.
 */
const RENDERERS = {
  // The four.
  overview: (p) => <OverviewReport {...p} />,
  questions: (p) => <PromptsReport {...p} />,
  sources: (p) => <SourcesScreen {...p} />,
  answers: (p) => <ChatsReport {...p} />,

  // The originals, still reachable by URL. They are what the four are composed
  // from, they cost nothing to leave mapped, and a bookmark should not 404.
  insights: (p) => <InsightsReport {...p} />,
  perception: (p) => <PerceptionReport {...p} />,
  prompts: (p) => <PromptsReport {...p} />,
  gaps: (p) => <GapsReport {...p} />,
  domains: (p) => <SourcesReport {...p} level="domain" />,
  urls: (p) => <SourcesReport {...p} level="url" />,
  chats: (p) => <ChatsReport {...p} />,
  run: (p) => <RunDetailReport {...p} />,
};

export default function AiVisibilityPage() {
  const [activeProjectId] = useActiveProjectId();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState(null);

  const [catalogue, setCatalogue] = useState(null);
  const [envelope, setEnvelope] = useState({ loading: false, error: null, data: null, forReport: null });
  const [legacy, setLegacy] = useState(null);
  const [brandState, setBrandState] = useState(null);

  const paneRef = useRef(null);

  useEffect(() => {
    projectsApi.list()
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
  }, []);

  const project = projects?.find((p) => p.id === activeProjectId) || projects?.[0] || null;

  const reportId = searchParams.get('report') || 'overview';

  const selectReport = useCallback((id) => {
    const next = new URLSearchParams(searchParams);
    // Every report names itself in the URL. This used to strip the param for
    // 'run' because that was the default; the default is 'overview' now, so the
    // same line would have quietly sent Run detail to the Overview.
    next.set('report', id);
    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);

  // ── Rail catalogue + the setup screens' badge counts ──────────────────
  useEffect(() => {
    if (!project) return;
    aiVisibilityApi.reportCatalogue(project.id)
      .then((d) => setCatalogue(d.reports || []))
      .catch(() => setCatalogue([]));
    aiVisibilityApi.brands(project.id)
      .then(setBrandState)
      .catch(() => setBrandState(null));
  }, [project?.id]);

  // The legacy run payload carries the per-prompt and per-topic evidence the Run
  // detail report shows beneath its headline. Only that screen reads it, so it
  // is fetched only when that screen is open — every other report was paying
  // for a response it never rendered.
  useEffect(() => {
    if (!project || reportId !== 'run' || legacy) return;
    aiVisibilityApi.report(project.id)
      .then(setLegacy)
      .catch((e) => setLegacy({ error: e }));
  }, [project?.id, reportId, legacy]);

  // Drop it when the client changes, or the next project's Run detail would
  // render the previous client's prompts.
  useEffect(() => { setLegacy(null); }, [project?.id]);

  const isSetup = SETUP_REPORTS.some((r) => r.id === reportId);

  // The envelope records WHICH report it is for. Without that, switching
  // reports renders the new component against the old payload for one frame —
  // effects run after render, so clearing state inside the effect is too late.
  // Every report has a different `data` shape, so that frame is a crash, not a
  // flicker: Gap analysis reading a Prompts payload finds no `gapCaptures`.
  useEffect(() => {
    if (!project || isSetup) return;
    let cancelled = false;
    setEnvelope({ loading: true, error: null, data: null, forReport: reportId });
    aiVisibilityApi.report9(project.id, reportId)
      .then((d) => {
        if (!cancelled) setEnvelope({ loading: false, error: null, data: d, forReport: reportId });
      })
      .catch((e) => {
        if (!cancelled) setEnvelope({ loading: false, error: e, data: null, forReport: reportId });
      });
    return () => { cancelled = true; };
  }, [project?.id, reportId, isSetup]);

  // Reset the content pane's scroll on every switch — a reader landing
  // halfway down a report they have not seen is disorienting.
  useEffect(() => {
    paneRef.current?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [reportId]);

  const railItems = useMemo(() => {
    const reports = (catalogue || []).map((r) => ({
      id: r.id,
      label: r.label,
      group: r.group,
      stat: undefined,
    }));
    const setup = SETUP_REPORTS.map((r) => ({
      ...r,
      stat: r.id === 'brands' && brandState && !brandState.hasApprovedClient ? '!' : undefined,
    }));
    return [...reports, ...setup];
  }, [catalogue, brandState]);

  const orderedIds = useMemo(() => (catalogue || []).map((r) => r.id), [catalogue]);
  const index = orderedIds.indexOf(reportId);

  // ArrowLeft / ArrowRight step through the reports. No wrap-around — reaching
  // the end of a set and silently starting over loses your place.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (index < 0) return;
      if (e.key === 'ArrowLeft' && index > 0) selectReport(orderedIds[index - 1]);
      if (e.key === 'ArrowRight' && index < orderedIds.length - 1) selectReport(orderedIds[index + 1]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, orderedIds, selectReport]);

  if (projects === null) {
    return <main style={{ padding: '28px 32px' }}><div style={muted}>Loading…</div></main>;
  }

  if (!project) {
    return (
      <main style={{ padding: '28px 32px' }}>
        <SectionHeader title="AI Visibility" subtitle="No client selected." />
      </main>
    );
  }

  const activeReport = (catalogue || []).find((r) => r.id === reportId)
    || SETUP_REPORTS.find((r) => r.id === reportId)
    || null;

  const migrationError = envelope.error?.code === 'migration_needed' ? envelope.error : null;

  return (
    <main style={{ padding: '28px 32px 64px', maxWidth: 1520, margin: '0 auto' }}>
      <SectionHeader
        title={`AI Visibility — ${project.name}`}
        subtitle="Whether answer engines name this client, and which sources they cite instead."
        actions={<Link to="/" style={{ fontSize: 12, color: 'var(--text-2)' }}>Dashboard</Link>}
      />

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(200px, 240px) 1fr',
        gap: 20,
        alignItems: 'start',
        marginTop: 4,
      }}
      >
        <ReportRail items={railItems} activeId={reportId} onSelect={selectReport} />

        <div ref={paneRef}>
          <ReportHeader
            report={activeReport}
            index={index}
            total={orderedIds.length}
            meta={envelope.data?.meta}
            onPrev={index > 0 ? () => selectReport(orderedIds[index - 1]) : undefined}
            onNext={index >= 0 && index < orderedIds.length - 1
              ? () => selectReport(orderedIds[index + 1])
              : undefined}
          />

          {migrationError && (
            <div style={{
              background: 'var(--card)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--r-lg)',
              padding: 18,
              marginBottom: 16,
            }}
            >
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{migrationError.message}</div>
              <div style={{ ...muted, marginTop: 6 }}>
                Apply <code>supabase/migrations/0018_ai_visibility_entities.sql</code>, then reload.
              </div>
            </div>
          )}

          {reportId === 'prompt-set' && <PromptSetTab project={project} />}
          {reportId === 'brands' && (
            <BrandsPanel
              project={project}
              onChange={() => aiVisibilityApi.brands(project.id).then(setBrandState).catch(() => {})}
            />
          )}

          {!isSetup && (envelope.loading || envelope.forReport !== reportId) && (
            <div style={muted}>Reading stored captures…</div>
          )}

          {!isSetup && envelope.error && envelope.forReport === reportId && !migrationError && (
            <div style={{
              background: 'var(--card)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--r-lg)',
              padding: 18,
            }}
            >
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{envelope.error.message}</div>
            </div>
          )}

          {!isSetup && envelope.data && envelope.forReport === reportId && (
            (RENDERERS[reportId] || RENDERERS.run)({
              envelope: envelope.data,
              legacy: legacy?.error ? null : legacy,
              onOpenReport: selectReport,
              project,
            })
          )}
        </div>
      </div>
    </main>
  );
}
