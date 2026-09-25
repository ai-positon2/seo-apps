import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { SectionHeader, Tabs } from '../ui';
import { useActiveProjectId } from '../lib/activeProject';
import { projectsApi } from '../lib/projectsApi';
import { aiVisibilityApi } from '../lib/aiVisibilityApi';
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
// The navigation is one horizontal tab strip, and it used to be a vertical
// rail. The rail was the right shape for nine reports plus two setup screens in
// two labelled groups; with four reports and two setup screens it was a 240px
// column holding six words, taking a sixth of the width off every table to its
// right. Six flat items is what a tab strip is for, so this uses the app's own
// `ui/Tabs` underline variant rather than a third bespoke nav.
//
// "Prompt set" and "Brands" stay in the same strip rather than behind a second
// layer. Both are part of this module and both gate it outright — an unapproved
// prompt set measures nothing and an unapproved brand set matches nothing — so
// putting them under a nav layer would hide the two screens most likely to
// explain why every number is an em-dash. Brands still carries its "!" when the
// client brand is unapproved; that warning is the reason it is in the strip.
//
// The reading every report has to get right, and the reason so much of this
// file is about empty states: a score is over MEASURED captures, never
// attempted ones. A provider timeout is not an absent brand.

const SETUP_REPORTS = [
  { id: 'prompt-set', label: 'Prompt set', group: 'SET UP' },
  { id: 'brands', label: 'Brands', group: 'SET UP' },
];

/**
 * What the strip calls the four reports.
 *
 * The server's catalogue names them, and it is still the source of which
 * reports exist and in what order — this only renames two of them for the tab,
 * where the design's words are better: a reader scanning a strip understands
 * "Prompts" and "Responses" faster than "Questions" and "Answers", which are
 * the same words the page's own body copy uses for the things inside them.
 * A report id with no entry keeps its catalogue label.
 */
const TAB_LABEL = {
  questions: 'Prompts',
  answers: 'Responses',
};

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

// The report envelope's period is { from, to } (ISO dates), not text; joined
// into the basis line as-is it printed "[object Object]".
function formatPeriod(period) {
  if (!period) return null;
  if (typeof period === 'string') return period;
  const fmt = (iso) => {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const from = period.from ? fmt(period.from) : null;
  const to = period.to ? fmt(period.to) : null;
  if (from && to) return `${from} – ${to}`;
  return from || to;
}

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

  const tabItems = useMemo(() => {
    const reports = (catalogue || []).map((r) => ({
      key: r.id,
      label: TAB_LABEL[r.id] || r.label,
    }));
    const setup = SETUP_REPORTS.map((r) => ({
      key: r.id,
      label: r.label,
      // The one badge worth carrying into the strip: with no approved client
      // brand, nothing matches and every figure on every other tab is an
      // em-dash. The mark is what connects the two.
      badge: r.id === 'brands' && brandState && !brandState.hasApprovedClient
        ? (
          <span
            aria-label="needs attention"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 15, height: 15, borderRadius: '50%', fontSize: 10, fontWeight: 700,
              background: 'var(--viz-warn)', color: 'var(--bg)',
            }}
          >
            !
          </span>
        )
        : undefined,
    }));
    return [...reports, ...setup];
  }, [catalogue, brandState]);

  // The basis line under the title. Assembled from the report envelope's own
  // meta rather than composed here, and each clause is dropped when the field
  // behind it is absent — a sentence that claims a period it does not have is
  // worse than a shorter one.
  const m = envelope.data?.meta;
  const periodLabel = formatPeriod(m?.period);
  const basisLine = [
    `What answer engines say about ${project?.name || 'this client'}`,
    m?.basis ? `— ${m.basis}` : null,
    periodLabel ? `· ${periodLabel}` : null,
    m?.coverageLabel ? `· ${m.coverageLabel}` : null,
    m?.rulesetVersion ? `· ruleset ${m.rulesetVersion}` : null,
  ].filter(Boolean).join(' ');

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

  const migrationError = envelope.error?.code === 'migration_needed' ? envelope.error : null;

  return (
    <main className="aiv-report">
      {/* Who this is about, and what it rests on. The per-report header bar
          that used to sit inside the pane is gone: with the reports one click
          apart in a strip, a second heading naming the report you just clicked
          restated the tab. What that bar carried and this keeps is the basis
          line — the capture count, the question count, the period, the coverage
          and the ruleset version. None of that is decoration: every score on
          this page is over MEASURED captures, and a reader has to be able to see
          how many that was. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span
          style={{
            fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--primary-text)',
          }}
        >
          Optimize
        </span>
        <h1
          style={{
            margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em',
            color: 'var(--text)',
          }}
        >
          AI Visibility
        </h1>
        <span style={{ fontSize: 13.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
          {basisLine}
        </span>
      </div>

      <Tabs
        variant="underline"
        tabs={tabItems}
        active={reportId}
        onChange={selectReport}
      />

      <div ref={paneRef}>

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
    </main>
  );
}
