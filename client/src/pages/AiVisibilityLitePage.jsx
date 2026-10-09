// ── AI Visibility ────────────────────────────────────────────────────────────
//
// A multi-report surface inside the app's existing chrome. The app already owns
// the left sidebar, so navigation here is a grouped horizontal rail rather than
// a second one, and the executive overview is the landing view.
//
// ── Insights first, setup last ─────────────────────────────────────────────
//
// The business profile and the prompt set are INPUTS: they exist so the
// module can write sensible prompts and know which names count as a mention.
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
import { projectsApi } from '../lib/projectsApi';
import { useActiveProjectId } from '../lib/activeProject';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner,
} from '../components/studio/primitives';
import { ReportWarnings } from '../components/aiVisibility/reportPrimitives';
import { REPORTS, REPORT_GROUPS, byId } from '../components/aiVisibilityLite/reportRegistry';
import {
  OverviewReport, InsightsReport, SentimentReport, QuestionsReport,
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
// Not 1080: the sources, pages and prompts tables are four columns wide and
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
          ? `${budget.remaining} left. Each run asks every prompt of all three models.`
          : 'No runs left on this project.'}
      </Muted>
    </div>
  );
}

const DROPPED_REASON = {
  third_party: 'another company’s brand you offer',
  generic: 'too generic to match safely',
};

function ProfileCard({ profile, nameCheck }) {
  if (!profile) return null;
  const list = (items) => (items || []).slice(0, 8).join(' · ');
  return (
    <Card style={{ padding: 18 }}>
      <SectionHead title="How the business was identified" />
      {/* Deliberately framed as an input, not a finding. This is read from the
          client's own website and its only jobs are to write sensible prompts
          and to know which names count as a mention. What the MODELS say lives
          in the Sentiment report, and conflating the two would present our
          reading of someone's marketing copy as though it were a measurement. */}
      <Muted size={11}>
        Read from the client&apos;s own site to write the prompts and to know which names count
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
        {(nameCheck?.kept?.length || profile.brandAliases?.length) ? (
          <div>
            <Muted size={11}>Names we look for in answers</Muted>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {(nameCheck?.kept || profile.brandAliases).map((a) => <Tag key={a} tone="muted">{a}</Tag>)}
            </div>
            {/* Names the site listed that are not the business: counting them
                made answers about, say, Invisalign read as mentions of a
                dental practice. Shown, not hidden, so a wrong call is visible. */}
            {nameCheck?.dropped?.length ? (
              <div style={{ marginTop: 8 }}>
                <Muted size={11}>Not counted as you</Muted>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {nameCheck.dropped.map((d) => (
                    <span key={d.name} title={DROPPED_REASON[d.kind] || d.kind}>
                      <Tag tone="outline" style={{ textDecoration: 'line-through', opacity: 0.75 }}>{d.name}</Tag>
                    </span>
                  ))}
                </div>
                <Muted size={11} style={{ display: 'block', marginTop: 4 }}>
                  {nameCheck.dropped.map((d) => `${d.name}: ${DROPPED_REASON[d.kind] || d.kind}`).join(' · ')}
                </Muted>
              </div>
            ) : null}
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
//
// One dark bar. Every group collapses to a dot, its name and one number, and
// opens a menu of its reports when clicked; the
// group being read opens into a light panel showing its reports, the current
// one as a solid pill. Setup & runs is the page's input, not a report, so it
// sits apart on the right with the run budget drawn as a small pie. The line
// along the bottom is how far through the reports the reader is.
//
// Fixed colours rather than theme tokens: the bar is dark in both themes, so
// its text colours are chosen against that. Deep green, not near-black — the
// app's own accent family, so the bar reads as part of the page (the same
// green as its buttons and pills) instead of a black strip laid over it.

const RAIL = {
  bar: '#1F4239',
  text: '#EEF4F1',
  muted: '#A7C2B8',
  dotDone: '#9FD8BD',
  dotAhead: '#6E8F84',
  panel: '#F3F1EC',
  panelText: '#1D221F',
  panelMuted: '#6B716B',
  pill: '#2F5D50',
  pillStat: '#BFE6D3',
  line: '#9FD8BD',
};

// What a collapsed group is called, and whose number it shows. Groups read by
// their own name ("Demand", "Evidence") except the first, which is the
// overview itself; Sources shows how many sources, not the gap count.
const GROUP_NAME = { 'START HERE': 'Overview' };
const GROUP_STAT = { SOURCES: 'domains' };
const titleCase = (label) => label.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Runs used, as a small filled pie. */
function BudgetPie({ used, cap, size = 18 }) {
  const frac = cap ? Math.min(1, used / cap) : 0;
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={RAIL.dotAhead} strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={RAIL.dotDone}
        strokeWidth="3"
        strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * A collapsed group, as a menu of its reports — so a reader can see what is
 * inside "Sources" before choosing, rather than being dropped on its first
 * report. Each entry carries its number and the one-line description the
 * page header uses.
 */
function GroupMenu({
  group, name, stat, done, active, onPick, statOf, open, onToggle, onClose,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const escape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 11px',
          background: open ? 'rgba(255,255,255,.10)' : 'transparent', border: 'none', borderRadius: 10,
          cursor: 'pointer', font: 'inherit', color: RAIL.text, fontSize: 14, whiteSpace: 'nowrap',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: done ? RAIL.dotDone : RAIL.dotAhead }} />
        {name}
        {stat ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: RAIL.muted }}>{stat}</span> : null}
        <span style={{ fontSize: 10, color: RAIL.muted, marginLeft: 1 }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 30, minWidth: 290,
            background: '#FFFFFF', borderRadius: 14, padding: 6,
            boxShadow: '0 12px 32px rgba(20, 30, 25, .18), 0 2px 6px rgba(20, 30, 25, .08)',
            border: '1px solid #E4E0D8',
          }}
        >
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.12em', color: '#7A807A',
            padding: '8px 12px 6px',
          }}
          >
            {group.label}
          </div>
          {group.ids.map((id) => {
            const r = byId(id);
            const itemStat = statOf(id);
            const on = id === active;
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => { onPick(id); onClose(); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                  border: 'none', borderRadius: 10, cursor: 'pointer', font: 'inherit',
                  background: on ? '#EEF3F0' : 'transparent', color: '#1D221F',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#F3F1EC'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = on ? '#EEF3F0' : 'transparent'; }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</span>
                  {itemStat ? (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#2F5D50', fontWeight: 600 }}>{itemStat}</span>
                  ) : null}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: '#6B716B', marginTop: 2, lineHeight: 1.4 }}>
                  {r.blurb}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Rail({
  active, onPick, report, described, budget,
}) {
  const [menu, setMenu] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const statOf = (id) => (report ? byId(id).stat(report, described) : null);
  const groups = REPORT_GROUPS
    .map((g) => ({ ...g, ids: g.ids.filter((id) => id !== 'run') }))
    .filter((g) => g.ids.length);
  const activeGroup = groups.findIndex((g) => g.ids.includes(active));
  const order = REPORTS.map((r) => r.id);
  const progress = Math.max(0, order.indexOf(active) + 1) / order.length;

  return (
    <nav
      aria-label="Reports"
      style={{
        position: 'relative', background: RAIL.bar, borderRadius: 16, padding: '8px 10px 13px',
        marginBottom: 18,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        {groups.map((g, gi) => {
          const open = gi === activeGroup;
          if (!open) {
            const first = g.ids[0];
            return (
              <GroupMenu
                key={g.label}
                group={g}
                name={GROUP_NAME[g.label] || titleCase(g.label)}
                stat={statOf(GROUP_STAT[g.label] || first)}
                done={active === 'run' || gi < activeGroup}
                active={active}
                onPick={onPick}
                statOf={statOf}
                open={menu === g.label}
                onToggle={() => setMenu((m) => (m === g.label ? null : g.label))}
                onClose={closeMenu}
              />
            );
          }
          return (
            <div
              key={g.label}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: 5,
                background: RAIL.panel, borderRadius: 12, flexWrap: 'wrap',
              }}
            >
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em',
                color: RAIL.panelMuted, padding: '0 8px', whiteSpace: 'nowrap',
              }}
              >
                {String(gi + 1).padStart(2, '0')} {g.label}
              </span>
              {g.ids.map((id) => {
                const on = id === active;
                const stat = statOf(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onPick(id)}
                    aria-current={on ? 'page' : undefined}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 11px',
                      border: 'none', borderRadius: 9, cursor: 'pointer', font: 'inherit',
                      fontSize: 14, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
                      background: on ? RAIL.pill : 'transparent',
                      color: on ? '#FFFFFF' : RAIL.panelText,
                    }}
                  >
                    {byId(id).name}
                    {stat ? (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 11.5,
                        color: on ? RAIL.pillStat : RAIL.panelMuted,
                      }}
                      >
                        {stat}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => onPick('run')}
          aria-current={active === 'run' ? 'page' : undefined}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 9,
            padding: '8px 14px', borderRadius: 12, cursor: 'pointer', font: 'inherit',
            fontSize: 14, whiteSpace: 'nowrap',
            border: `1px solid ${active === 'run' ? RAIL.panel : 'rgba(255,255,255,.14)'}`,
            background: active === 'run' ? RAIL.panel : 'rgba(255,255,255,.03)',
            color: active === 'run' ? RAIL.panelText : RAIL.text,
          }}
        >
          <BudgetPie used={budget?.used || 0} cap={budget?.cap || 0} />
          Setup &amp; runs
        </button>
      </div>

      {/* How far through the reports: the current one's place in the order. */}
      <div style={{
        position: 'absolute', left: 12, right: 12, bottom: 6, height: 3,
        borderRadius: 2, background: 'rgba(255,255,255,.08)',
      }}
      >
        <div style={{
          width: `${progress * 100}%`, height: '100%', borderRadius: 2,
          background: RAIL.line, transition: 'width 200ms ease',
        }}
        />
      </div>
    </nav>
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

  // While the server is tagging answers for sentiment in the background,
  // re-read the report until it says it has finished, so the numbers fill in
  // on their own. Bounded, so a job that never reports done cannot poll forever.
  const sentimentAnalysing = Boolean(reportState.data?.sentimentAnalysing);
  const gapsAnalysing = Boolean(reportState.data?.gapsAnalysing);
  const backfilling = sentimentAnalysing || gapsAnalysing;
  useEffect(() => {
    if (!backfilling || !projectId) return undefined;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const rep = await aivLiteApi.report(projectId);
        setReportState({ loading: false, error: null, data: rep });
        if ((!rep.sentimentAnalysing && !rep.gapsAnalysing) || tries >= 30) clearInterval(timer);
      } catch {
        clearInterval(timer);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [backfilling, projectId]);

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
              Every run asks all {promptsUsed} prompts of all three models. The cap is enforced on
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
          title={`Prompts (${promptsUsed} of ${d.promptCap})`}
          right={d.profile ? (
            <Btn
              disabled={busy || setupRunning}
              onClick={() => act(
                () => aivLiteApi.runSetup(projectId, { regenerate: true }),
                'Rewriting the automatic prompts…',
              )}
            >
              Regenerate
            </Btn>
          ) : null}
        />

        {!promptsUsed && !setupRunning ? (
          <div style={{ padding: '12px 0' }}>
            <Muted size={12}>
              No prompts yet. Setup writes {d.autoPromptCount} from the site itself.
            </Muted>
            <Btn
              variant="primary"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => act(() => aivLiteApi.runSetup(projectId), 'Reading the site…')}
            >
              Identify the business and write prompts
            </Btn>
          </div>
        ) : null}

        {d.prompts.map((p) => (
          <PromptRow
            key={p.id}
            prompt={p}
            busy={busy}
            onSave={(id, text) => act(() => aivLiteApi.updatePrompt(projectId, id, text))}
            onDelete={(id) => act(() => aivLiteApi.deletePrompt(projectId, id), 'Prompt deleted.')}
          />
        ))}

        {roomLeft > 0 ? (
          <>
            <FadingRule style={{ margin: '12px 0' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                placeholder="Add a prompt a buyer would actually type…"
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
              {roomLeft} more can be added. Prompts that name the business are rejected — the
              point is whether a model brings them up on its own.
            </Muted>
          </>
        ) : (
          <Muted size={11}>All {d.promptCap} slots are used. Delete one to add another.</Muted>
        )}
      </Card>

      <ProfileCard profile={d.profile} nameCheck={reportState.data?.nameCheck} />
    </div>
  );

  const body = () => {
    if (active === 'run') return setupBody;
    if (active === 'perception') {
      return (
        <SentimentReport
          report={report}
          described={described}
          describedAt={reportState.data?.describedAt}
          analysing={sentimentAnalysing}
        />
      );
    }
    if (!report) {
      return (
        <Card style={{ padding: 20 }}>
          <Kicker tone="muted">Nothing measured yet</Kicker>
          <Muted size={12} style={{ display: 'block', marginTop: 6 }}>
            {promptsUsed
              ? 'Open Setup & runs and press Measure now to ask all three models every prompt.'
              : 'Open Setup & runs to identify the business and write the prompts first.'}
          </Muted>
        </Card>
      );
    }
    switch (active) {
      case 'insights': return <InsightsReport report={report} />;
      case 'questions': return <QuestionsReport report={report} />;
      case 'gaps':
        return (
          <GapsReport
            report={report}
            analysing={gapsAnalysing}
            onTrack={async (domain) => {
              const res = await projectsApi.addCompetitor(projectId, domain);
              const rep = await aivLiteApi.report(projectId);
              setReportState({ loading: false, error: null, data: rep });
              return res;
            }}
          />
        );
      case 'domains': return <DomainsReport report={report} />;
      case 'urls': return <UrlsReport report={report} />;
      case 'answers': return <AnswersReport report={report} />;
      default: return <OverviewReport report={report} />;
    }
  };

  return (
    <main style={PAGE_COLUMN}>
      <Rail active={active} onPick={setActive} report={report} described={described} budget={d?.budget} />

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

      {setupRunning ? (
        <Card style={{ padding: 16, marginBottom: 14 }}>
          <Spinner label="Reading the site and writing the prompts…" />
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

      <div ref={paneRef}>
        {reportState.loading && !report ? <Spinner label="Building the report…" /> : body()}
      </div>

      {/* Caveats about the figures sit AFTER them. Stacked above the report they
          were the first three things a reader saw — a missing-assistant notice,
          "the question set changed", "no earlier period" — before the answer. */}
      {(unavailable.length || (report && active !== 'run')) ? (
        <div style={{ marginTop: 18 }}>
          {unavailable.length ? (
            <Card style={{ padding: 12, marginBottom: 14 }}>
              <Muted size={12}>{unavailable.map((s) => s.reason).join(' ')}</Muted>
            </Card>
          ) : null}
          {report && active !== 'run' ? (
            <ReportWarnings warnings={report.warnings} meta={report.meta} />
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
