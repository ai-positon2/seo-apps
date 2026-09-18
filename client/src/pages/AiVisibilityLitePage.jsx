// ── AI Visibility ────────────────────────────────────────────────────────────
//
// A multi-report surface inside the app's existing chrome. The app already owns
// the left sidebar, so navigation here is a grouped horizontal rail rather than
// a second one, and the executive overview is the landing view.
//
// ── Insights first, setup last ─────────────────────────────────────────────
//
// The business profile and the question set are INPUTS: they exist so the
// module can write sensible questions and know which names count as a mention.
// They are not findings, so they live in the last report rather than at the top
// of the first. What the models actually said leads.
//
// ── The page never does metric maths ───────────────────────────────────────
//
// Every number arrives pre-formatted as {value, display, delta, deltaDisplay,
// direction} and this file renders `display`. That is the rule
// metrics/format.js exists to enforce: the moment a component divides two
// numbers, the same metric starts reading differently in two places. Where a
// value is null the server has already decided it renders an em-dash, which is
// a different claim from a measured zero and must stay different.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { aivLiteApi } from '../lib/aiVisibilityLiteApi';
import { useActiveProjectId } from '../lib/activeProject';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner,
} from '../components/studio/primitives';
import { ReportWarnings } from '../components/aiVisibility/reportPrimitives';
import { REPORTS, REPORT_GROUPS, byId } from '../components/aiVisibilityLite/reportRegistry';
import {
  OverviewReport, InsightsReport, PerceptionReport, QuestionsReport,
  GapsReport, DomainsReport, UrlsReport, AnswersReport,
} from '../components/aiVisibilityLite/reports';

// How often to re-read while setup or a measurement is in flight. Both are
// minutes at most, so this is a progress poll, not a background watcher.
const POLL_MS = 4000;

/** Statuses that mean work is still happening. */
const IN_FLIGHT = new Set(['running', 'queued']);

// The app's page column: 32px gutters, 1280 max, centred.
//
// The shell puts no padding around <Outlet />, so every page owns its own
// gutter. 32px is universal across the app and is not the variable here — the
// MAX WIDTH is, and it is what decides how wide the margins actually read:
//
//   1080   Admin, Market Potential          218px margins on a 15" laptop
//   1280   Content Research, Article Enh.   118px
//   1520   Home                              32px  (no centring at all)
//
// This started at 1520, copied from HomePage, and on a laptop that left the
// reports running to within 32px of both edges while every other content page
// sat visibly inset. 1520 is the app's widest value and it earns that on Home,
// which is a grid of dashboard cards; this page is tables and prose, which is
// the Content Research / Article Enhancement shape, so it takes their width.
//
// Not 1080: the sources, pages and questions tables are four columns wide and
// cramping them to read like Admin would trade a layout complaint for a
// legibility one.
//
// One knock-on, stated rather than hidden: the crawl status bar the shell can
// render directly above this is pinned to 1520 to line up with Home, so on a
// wide screen it will sit slightly proud of this page's cards. That is already
// true of Admin and Market Potential at 1080 — it is an existing condition of
// every content page, not something this width introduces.
//
// Shared by the main return AND every early return below, because a "pick a
// client" or migration-needed card that sat edge to edge while the real page
// was inset would look like two different screens.
const PAGE_COLUMN = { padding: '24px 32px 64px', maxWidth: 1280, margin: '0 auto' };

// ── Setup pieces (the last report) ─────────────────────────────────────────

function BudgetBar({ budget }) {
  if (!budget) return null;
  const pct = budget.cap ? Math.round((budget.used / budget.cap) * 100) : 0;
  const low = budget.remaining <= 5;
  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <Muted size={11}>Runs used</Muted>
        <Muted size={11}>
          <strong style={{ color: low ? 'var(--viz-warn)' : 'inherit' }}>
            {budget.used} / {budget.cap}
          </strong>
        </Muted>
      </div>
      <div style={{
        height: 6, borderRadius: 3, background: 'var(--neutral-800)', marginTop: 6, overflow: 'hidden',
      }}
      >
        <div style={{
          width: `${Math.min(100, pct)}%`,
          height: '100%',
          background: low ? 'var(--viz-warn)' : 'var(--primary)',
        }}
        />
      </div>
      <Muted size={11}>
        {budget.remaining > 0
          ? `${budget.remaining} left. Each run asks every question of all three models.`
          : 'No runs left on this project.'}
      </Muted>
    </div>
  );
}

function ProfileCard({ profile }) {
  if (!profile) return null;
  const list = (items) => (items || []).slice(0, 8).join(' · ');
  return (
    <Card style={{ padding: 18 }}>
      <SectionHead title="How the business was identified" />
      {/* Deliberately framed as an input, not a finding. This is read from the
          client's own website and its only jobs are to write sensible questions
          and to know which names count as a mention. What the MODELS say lives
          in the Perception report, and conflating the two would present our
          reading of someone's marketing copy as though it were a measurement. */}
      <Muted size={11}>
        Read from the client&apos;s own site to write the questions and to know which names count
        as a mention. Not a finding.
      </Muted>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 10 }}>{profile.businessName}</div>
      {profile.summary ? <Muted size={12}>{profile.summary}</Muted> : null}

      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        {profile.services?.length ? (
          <div><Muted size={11}>Services</Muted><div style={{ fontSize: 13 }}>{list(profile.services)}</div></div>
        ) : null}
        {profile.products?.length ? (
          <div><Muted size={11}>Products</Muted><div style={{ fontSize: 13 }}>{list(profile.products)}</div></div>
        ) : null}
        {profile.locations?.length ? (
          <div><Muted size={11}>Serves</Muted><div style={{ fontSize: 13 }}>{list(profile.locations)}</div></div>
        ) : null}
        {/* Shown because it is what mention matching runs against. A business
            whose real name is missing here reads as never mentioned, and that
            failure is indistinguishable from a genuine zero unless somebody
            can see the list. */}
        {profile.brandAliases?.length ? (
          <div>
            <Muted size={11}>Names we look for in answers</Muted>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {profile.brandAliases.map((a) => <Tag key={a} tone="muted">{a}</Tag>)}
            </div>
          </div>
        ) : null}
      </div>

      {profile.sourceUrls?.length ? (
        <>
          <FadingRule style={{ margin: '12px 0 8px' }} />
          <Muted size={11}>
            Read from {profile.sourceUrls.length} page{profile.sourceUrls.length === 1 ? '' : 's'} on the site
          </Muted>
        </>
      ) : null}
    </Card>
  );
}

function PromptRow({ prompt, onSave, onDelete, busy }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(prompt.text);

  useEffect(() => { setText(prompt.text); }, [prompt.text]);

  if (editing) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <Btn
          variant="primary"
          disabled={busy || !text.trim() || text.trim() === prompt.text}
          onClick={async () => { await onSave(prompt.id, text.trim()); setEditing(false); }}
        >
          Save
        </Btn>
        <Btn onClick={() => { setText(prompt.text); setEditing(false); }}>Cancel</Btn>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}>
      <div style={{ flex: 1, fontSize: 13 }}>
        {prompt.text}
        {/* Display only — an auto-written question and a typed one are measured,
            edited and deleted identically. */}
        <Tag tone={prompt.source === 'auto' ? 'muted' : 'accent'} style={{ marginLeft: 8 }}>
          {prompt.source === 'auto' ? 'auto' : 'yours'}
        </Tag>
      </div>
      <Btn disabled={busy} onClick={() => setEditing(true)}>Edit</Btn>
      <Btn disabled={busy} onClick={() => onDelete(prompt.id)}>Delete</Btn>
    </div>
  );
}

// ── The rail ───────────────────────────────────────────────────────────────

function Rail({ active, onPick, report, described }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', flexWrap: 'wrap',
      borderBottom: '1px solid var(--border)', marginBottom: 14,
    }}
    >
      {REPORT_GROUPS.map((g, gi) => (
        <div
          key={g.label}
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: '2px 14px 0',
            borderLeft: gi === 0 ? 'none' : '1px solid var(--neutral-800)',
          }}
        >
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.16em',
            color: 'var(--text-3)', paddingLeft: 4,
          }}
          >
            {g.label}
          </div>
          <div style={{ display: 'flex', gap: 2 }}>
            {g.ids.map((id) => {
              const r = byId(id);
              const on = id === active;
              const stat = report ? r.stat(report, described) : null;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPick(id)}
                  aria-current={on ? 'page' : undefined}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 7,
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    font: 'inherit', textAlign: 'left',
                  }}
                >
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', borderRadius: 'var(--r-md)',
                    fontSize: 13, whiteSpace: 'nowrap',
                    color: on ? 'var(--text)' : 'var(--text-3)',
                    background: on ? 'var(--surface)' : 'transparent',
                    fontWeight: on ? 500 : 400,
                  }}
                  >
                    {r.name}
                    {stat ? (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10.5,
                        color: on ? 'var(--primary-text)' : 'var(--text-3)',
                      }}
                      >
                        {stat}
                      </span>
                    ) : null}
                  </span>
                  <span style={{
                    height: 2, borderRadius: '2px 2px 0 0',
                    background: on ? 'var(--primary)' : 'transparent',
                  }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── The screen ─────────────────────────────────────────────────────────────

export default function AiVisibilityLitePage() {
  const outlet = useOutletContext() || {};
  const [activeProjectId] = useActiveProjectId();
  const projectId = outlet.projectId || activeProjectId;

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [reportState, setReportState] = useState({ loading: false, error: null, data: null });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [newPrompt, setNewPrompt] = useState('');
  const [active, setActive] = useState('overview');
  const pollRef = useRef(null);
  const paneRef = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await aivLiteApi.status(projectId);
      setState({ loading: false, error: null, data });

      // The report is a second call on purpose: it reads every capture the
      // project has, and the shell above it should not wait on that.
      setReportState((s) => ({ ...s, loading: true }));
      const rep = await aivLiteApi.report(projectId);
      setReportState({ loading: false, error: null, data: rep });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const d = state.data;
  const report = reportState.data?.report || null;
  const described = reportState.data?.described || null;

  // Poll only while something is actually running. A page that polls when
  // nothing is happening keeps a database busy for no reason.
  const working = useMemo(() => {
    if (!d) return false;
    return IN_FLIGHT.has(d.setup?.status) || IN_FLIGHT.has(d.latestRun?.status);
  }, [d]);

  useEffect(() => {
    if (!working) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    pollRef.current = setInterval(load, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [working, load]);

  const step = useCallback((dir) => {
    setActive((cur) => {
      const i = REPORTS.findIndex((r) => r.id === cur);
      const nextIndex = i + dir;
      // No wrap-around: the ends are ends, and the buttons read Start / End.
      return nextIndex < 0 || nextIndex >= REPORTS.length ? cur : REPORTS[nextIndex].id;
    });
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // Never while somebody is typing a question into the setup report.
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // A reader who scrolled to the bottom of one table should not land halfway
  // down the next.
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const act = useCallback(async (fn, successNote) => {
    setBusy(true);
    setNotice(null);
    try {
      const out = await fn();
      if (successNote) setNotice({ tone: 'ok', text: successNote });
      await load();
      return out;
    } catch (e) {
      setNotice({ tone: 'error', text: e.message, code: e.code });
      return null;
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (!projectId) {
    return (
      <main style={PAGE_COLUMN}>
        <Card style={{ padding: 24 }}>
          <Kicker>AI Visibility</Kicker>
          <Muted>Pick a client above to see what the models say about them.</Muted>
        </Card>
      </main>
    );
  }

  if (state.loading) {
    return <main style={PAGE_COLUMN}><Spinner label="Reading this project…" /></main>;
  }

  if (state.error) {
    const migration = state.error.code === 'migration_needed';
    return (
      <main style={PAGE_COLUMN}>
        <Card style={{ padding: 24 }}>
          <Kicker tone="warn">AI Visibility</Kicker>
          <div style={{ fontSize: 14, marginTop: 8 }}>{state.error.message}</div>
          {migration ? (
            <Muted size={12}>
              Apply supabase/migrations/0030_ai_visibility_lite.sql, then reload.
            </Muted>
          ) : null}
        </Card>
      </main>
    );
  }

  const setupRunning = IN_FLIGHT.has(d.setup?.status);
  const runRunning = IN_FLIGHT.has(d.latestRun?.status);
  const promptsUsed = d.prompts.length;
  const roomLeft = d.promptCap - promptsUsed;
  const unavailable = (d.surfaces || []).filter((s) => !s.ready);
  const meta = byId(active);
  const index = REPORTS.findIndex((r) => r.id === active);
  const prev = index > 0 ? REPORTS[index - 1] : null;
  const next = index < REPORTS.length - 1 ? REPORTS[index + 1] : null;

  // The setup report. Kept in this file because it owns the page's edit
  // handlers; every other report is a pure function of the server payload.
  const setupBody = (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <SectionHead title="Measurement budget" />
            <Muted size={11}>
              Every run asks all {promptsUsed} questions of all three models. The cap is enforced on
              the server, not just here.
            </Muted>
          </div>
          <BudgetBar budget={d.budget} />
        </div>
        <FadingRule style={{ margin: '14px 0 10px' }} />
        <Btn
          variant="primary"
          disabled={busy || runRunning || setupRunning || !promptsUsed || d.budget.remaining <= 0}
          onClick={() => act(() => aivLiteApi.run(projectId), 'Measuring — this takes a few minutes.')}
        >
          {runRunning ? 'Measuring…' : 'Measure now'}
        </Btn>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead
          title={`Questions (${promptsUsed} of ${d.promptCap})`}
          right={d.profile ? (
            <Btn
              disabled={busy || setupRunning}
              onClick={() => act(
                () => aivLiteApi.runSetup(projectId, { regenerate: true }),
                'Rewriting the automatic questions…',
              )}
            >
              Regenerate
            </Btn>
          ) : null}
        />

        {!promptsUsed && !setupRunning ? (
          <div style={{ padding: '12px 0' }}>
            <Muted size={12}>
              No questions yet. Setup writes {d.autoPromptCount} from the site itself.
            </Muted>
            <Btn
              variant="primary"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => act(() => aivLiteApi.runSetup(projectId), 'Reading the site…')}
            >
              Identify the business and write questions
            </Btn>
          </div>
        ) : null}

        {d.prompts.map((p) => (
          <PromptRow
            key={p.id}
            prompt={p}
            busy={busy}
            onSave={(id, text) => act(() => aivLiteApi.updatePrompt(projectId, id, text))}
            onDelete={(id) => act(() => aivLiteApi.deletePrompt(projectId, id), 'Question deleted.')}
          />
        ))}

        {roomLeft > 0 ? (
          <>
            <FadingRule style={{ margin: '12px 0' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder="Add a question a buyer would actually type…"
                style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !newPrompt.trim()) return;
                  act(() => aivLiteApi.addPrompt(projectId, newPrompt.trim())).then(() => setNewPrompt(''));
                }}
              />
              <Btn
                disabled={busy || !newPrompt.trim()}
                onClick={() => act(() => aivLiteApi.addPrompt(projectId, newPrompt.trim()))
                  .then(() => setNewPrompt(''))}
              >
                Add
              </Btn>
            </div>
            <Muted size={11}>
              {roomLeft} more can be added. Questions that name the business are rejected — the
              point is whether a model brings them up on its own.
            </Muted>
          </>
        ) : (
          <Muted size={11}>All {d.promptCap} slots are used. Delete one to add another.</Muted>
        )}
      </Card>

      <ProfileCard profile={d.profile} />
    </div>
  );

  const body = () => {
    if (active === 'run') return setupBody;
    if (active === 'perception') {
      return <PerceptionReport described={described} describedAt={reportState.data?.describedAt} />;
    }
    if (!report) {
      return (
        <Card style={{ padding: 20 }}>
          <Kicker tone="muted">Nothing measured yet</Kicker>
          <Muted size={12} style={{ display: 'block', marginTop: 6 }}>
            {promptsUsed
              ? 'Open Setup & runs and press Measure now to ask all three models every question.'
              : 'Open Setup & runs to identify the business and write the questions first.'}
          </Muted>
        </Card>
      );
    }
    switch (active) {
      case 'insights': return <InsightsReport report={report} />;
      case 'questions': return <QuestionsReport report={report} />;
      case 'gaps': return <GapsReport report={report} />;
      case 'domains': return <DomainsReport report={report} />;
      case 'urls': return <UrlsReport report={report} />;
      case 'answers': return <AnswersReport report={report} />;
      default: return <OverviewReport report={report} />;
    }
  };

  return (
    <main style={PAGE_COLUMN}>
      <Rail active={active} onPick={setActive} report={report} described={described} />

      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 20, flexWrap: 'wrap', padding: '2px 0 14px',
      }}
      >
        <div>
          <div style={{ fontSize: 21, fontWeight: 500, letterSpacing: '-.02em' }}>{meta.name}</div>
          <Muted size={12}>{meta.blurb}</Muted>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Muted size={11} style={{ fontFamily: 'var(--font-mono)' }}>
            {index + 1} OF {REPORTS.length}
          </Muted>
          <Btn disabled={!prev} onClick={() => prev && setActive(prev.id)}>
            ‹ {prev ? prev.name : 'Start'}
          </Btn>
          <Btn disabled={!next} onClick={() => next && setActive(next.id)}>
            {next ? next.name : 'End'} ›
          </Btn>
        </div>
      </div>

      {notice ? (
        <Card style={{
          padding: 12,
          marginBottom: 14,
          borderLeft: `3px solid ${notice.tone === 'error' ? 'var(--viz-warn)' : 'var(--primary)'}`,
        }}
        >
          <div style={{ fontSize: 13 }}>{notice.text}</div>
          {notice.code === 'run_cap_reached' ? (
            <Muted size={11}>The cap is per project and is enforced on the server.</Muted>
          ) : null}
        </Card>
      ) : null}

      {unavailable.length ? (
        <Card style={{ padding: 12, marginBottom: 14 }}>
          <Muted size={12}>{unavailable.map((s) => s.reason).join(' ')}</Muted>
        </Card>
      ) : null}

      {setupRunning ? (
        <Card style={{ padding: 16, marginBottom: 14 }}>
          <Spinner label="Reading the site and writing the questions…" />
        </Card>
      ) : null}

      {d.setup?.status === 'failed' ? (
        <Card style={{ padding: 16, marginBottom: 14 }}>
          <Kicker tone="warn">Setup did not finish</Kicker>
          <div style={{ fontSize: 13, marginTop: 4 }}>{d.setup.error}</div>
          <Btn
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={() => act(() => aivLiteApi.runSetup(projectId, { regenerate: true }), 'Trying again…')}
          >
            Try again
          </Btn>
        </Card>
      ) : null}

      {report && active !== 'run' ? (
        <ReportWarnings warnings={report.warnings} meta={report.meta} />
      ) : null}

      <div ref={paneRef}>
        {reportState.loading && !report ? <Spinner label="Building the report…" /> : body()}
      </div>
    </main>
  );
}
