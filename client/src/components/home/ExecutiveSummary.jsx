import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Kicker, Muted, Btn, FadingRule } from '../studio/primitives';
import { projectsApi, relativeTime } from '../../lib/projectsApi';
import { InfoDot } from '../explain';
import { moduleReportRoute } from '../../lib/moduleReportRoute';

// "Add to plan" (PriorityCard, below) turned out to lead nowhere from the
// reader's seat — its only destination is the Recommendations sheet of the
// downloadable report, not a screen anyone lands on. Off until there's a
// visible place for it to actually go.
const ADD_TO_PLAN_ENABLED = false;

// ── The answer for whoever signs off on the work ─────────────────────────────
//
// Everything else on this dashboard is built for the person running the audit:
// a composite score, six module cards, pages crawled, coverage. That is the
// right screen for an operator and the wrong one for the person paying for it,
// who opens it and reads four figures — two of which are about the TOOL rather
// than the site — and leaves without the answer they came for.
//
// This block sits above all of it and says four things, in that order:
//
//   the verdict      is the site in trouble, in one sentence
//   the direction    which way it has moved since last time
//   the leverage     how much of the work is one change rather than many
//   what to do       the three items, each one click from a recommendation
//
// and then, in smaller type where a caveat belongs rather than where a headline
// does, what the summary is based on and what it does NOT cover.
//
// ── Why almost nothing is computed here ─────────────────────────────────────
//
// Every sentence arrives already written, from
// server/modules/projects/insights/executive.js. That is deliberate: the rules
// about what may be claimed (§6.2 — no invented methodology; §16.11 — nothing
// unmeasured reported as fine) are enforced in one tested place, and a view that
// composed its own wording would be a second, untested copy of them that drifts.
// This file decides layout and colour. It does not decide what is true.

const STATE_TONE = {
  healthy: { color: 'var(--primary)', tint: 'var(--primary)' },
  needs_attention: { color: 'var(--viz-warn)', tint: 'var(--viz-warn)' },
  at_risk: { color: 'var(--viz-neg)', tint: 'var(--viz-neg)' },
  // --border-strong, not a neutral: on the light theme the neutral ramp is
  // near-white and the edge rule vanished, so the one state that MOST needs to
  // look deliberately blank looked like an unfinished card.
  not_measured: { color: 'var(--text-3)', tint: 'var(--border-strong)' },
};

const TREND_TONE = {
  better: { color: 'var(--primary)', mark: '▲', word: 'Improving' },
  worse: { color: 'var(--viz-neg)', mark: '▼', word: 'Slipping' },
  flat: { color: 'var(--text-3)', mark: '—', word: 'Holding' },
};

const SEVERITY_TONE = {
  error: 'var(--viz-neg)',
  warning: 'var(--viz-warn)',
  notice: 'var(--text-3)',
  info: 'var(--text-3)',
};

/**
 * @param {object}   props
 * @param {string}   props.projectId
 * @param {function} props.onPromote  turns a priority into a recommendation draft
 * @param {Array}    props.modules    the dashboard's module cards, so each item links to its report
 */
export default function ExecutiveSummary({ projectId, onPromote, modules = [] }) {
  const [summary, setSummary] = useState({ loading: true, error: null, data: null });
  // Fetched separately and rendered when it arrives. See the comment on the
  // trend endpoint: it is the expensive layer, and the three blocks above it do
  // not depend on it.
  const [trend, setTrend] = useState({ loading: true, error: null, data: null });
  const [showBasis, setShowBasis] = useState(false);

  // Same discipline as the loaders on HomePage: a reply for a client the user
  // has already switched away from is dropped rather than rendered.
  const wanted = useRef(projectId);
  useEffect(() => { wanted.current = projectId; }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    setSummary({ loading: true, error: null, data: null });
    setTrend({ loading: true, error: null, data: null });
    setShowBasis(false);

    projectsApi.executiveSummary(projectId)
      .then((data) => { if (live && wanted.current === projectId) setSummary({ loading: false, error: null, data }); })
      .catch((e) => { if (live && wanted.current === projectId) setSummary({ loading: false, error: e, data: null }); });

    projectsApi.executiveTrend(projectId)
      .then((data) => { if (live && wanted.current === projectId) setTrend({ loading: false, error: null, data: data?.trend || null }); })
      // A trend that cannot be read costs one line, not the block. Reported in
      // place rather than swallowed, because "we could not compare" and "nothing
      // changed" are different facts and the second is the flattering one.
      .catch((e) => { if (live && wanted.current === projectId) setTrend({ loading: false, error: e, data: null }); });

    return () => { live = false; };
  }, [projectId]);

  if (summary.loading) {
    return (
      <Card elevation="md" style={{ padding: '22px 26px', gap: 10, minHeight: 148 }} aria-busy="true">
        <span className="eyebrow">Executive summary</span>
        <div style={{ height: 22, width: '45%', borderRadius: 6, background: 'var(--surface)' }} />
        <div style={{ height: 15, width: '80%', borderRadius: 6, background: 'var(--surface)' }} />
        <div style={{ height: 15, width: '62%', borderRadius: 6, background: 'var(--surface)' }} />
      </Card>
    );
  }

  if (summary.error || !summary.data) {
    // Not hidden. A summary that disappears when it fails is indistinguishable
    // from a site with nothing to report.
    return (
      <Card elevation="md" style={{ padding: '18px 22px', gap: 6 }} role="alert">
        <Kicker tone="muted">Executive summary unavailable</Kicker>
        <Muted size={13}>
          {summary.error?.message || 'The summary could not be read. The audit profile below is unaffected.'}
        </Muted>
      </Card>
    );
  }

  const { verdict, standing, leverage, priorities, confidence } = summary.data;
  const issues = summary.data.issues || null;
  const areas = summary.data.areas || [];
  const market = summary.data.market || [];
  const tone = STATE_TONE[verdict.state] || STATE_TONE.not_measured;
  // The areas worth naming: below par, weakest first. A summary that lists every
  // module repeats the cards above; this lists only the ones that need work.
  const weakAreas = areas.filter((a) => a.band !== 'good').slice(0, 3);
  const routeFor = (moduleKey) => {
    const m = modules.find((x) => x.key === moduleKey);
    return m ? moduleReportRoute(m).path : null;
  };

  return (
    <Card
      elevation="md"
      data-explain-box
      style={{ padding: 0, gap: 0, overflow: 'hidden', borderTop: `3px solid ${tone.tint}` }}
    >
      {/* ── The verdict, and the issue mix beside it ─────────────────────── */}
      <div className="exec-top" style={{ padding: '22px 26px 20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="explain-label-row">
              <span className="eyebrow">Executive summary</span>
              <InfoDot explainKey="exec" />
            </span>
            <span className="explain-label-row">
              <TrendChip state={trend} />
              <InfoDot explainKey="trend" />
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <StateMark state={verdict.state} color={tone.color} />
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.015em', color: tone.color, lineHeight: 1.1 }}>
              {verdict.headline}
            </h2>
          </div>

          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.55, color: 'var(--text)', maxWidth: 680, textWrap: 'pretty' }}>
            {verdict.sentence}
          </p>

          {trend.data?.state === 'compared' && (
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-2)', maxWidth: 680 }}>
              {trend.data.sentence}
            </p>
          )}

          {/* What needs work, and where the site stands in its market — chips,
              each one a link to the report behind it. */}
          {(weakAreas.length > 0 || market.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
              {weakAreas.length > 0 && (
                <ChipRow label="Needs work">
                  {weakAreas.map((a) => (
                    <AreaChip key={a.key} to={routeFor(a.key)} color={BAND_COLOR[a.band]}>
                      {a.label}
                      <strong className="num" style={{ color: BAND_COLOR[a.band] }}>{a.score}</strong>
                    </AreaChip>
                  ))}
                </ChipRow>
              )}
              {market.length > 0 && (
                <ChipRow label="Market">
                  {market.map((m) => (
                    <AreaChip key={m.key} to={routeFor(m.key)} color="var(--text-2)">
                      {m.key.startsWith('ai_visibility') ? 'Named in' : null}
                      <strong className="num" style={{ color: 'var(--text)' }}>{m.display}</strong>
                      {m.unit}
                    </AreaChip>
                  ))}
                </ChipRow>
              )}
            </div>
          )}
        </div>

        {issues && (issues.critical + issues.important + issues.minor) > 0 && (
          <IssueMix issues={issues} leverage={leverage} />
        )}
      </div>

      {/* ── What to do about it ──────────────────────────────────────────── */}
      {priorities.length > 0 && (
        <div
          data-explain-box
          style={{
            padding: '18px 26px 22px', display: 'flex', flexDirection: 'column', gap: 12,
            borderTop: '1px solid var(--border)', background: 'var(--surface-2)',
          }}
        >
          <span className="explain-label-row">
            <span className="eyebrow">{priorities.length === 1 ? 'Do this first' : `Do these ${priorities.length} first`}</span>
            <InfoDot explainKey="priorities" />
          </span>
          <ol className="exec-priorities">
            {priorities.map((item) => (
              <PriorityCard key={item.key} item={item} to={routeFor(item.moduleKey)} onPromote={onPromote} />
            ))}
          </ol>
        </div>
      )}

      {/* ── What this is, and what it is not ─────────────────────────────── */}
      <div
        style={{
          padding: '12px 26px 14px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
        }}
      >
        <Muted size={12} style={{ color: 'var(--text-2)' }}>
          {confidence.sentence}
          {confidence.lastEvidenceAt ? ` Latest evidence ${relativeTime(confidence.lastEvidenceAt)}.` : ''}
        </Muted>

        {/* Collapsed, not hidden. §30 asks for capability gaps to be surfaced,
            and a caveat nobody can reach is not surfaced — but a wall of them
            above the answer buries the answer. The count is always visible, so
            the reader knows there is something there to open. */}
        {(confidence.caveats.length > 0 || standing.basis) && (
          <button
            type="button"
            onClick={() => setShowBasis((v) => !v)}
            aria-expanded={showBasis}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-3)',
              textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3,
            }}
          >
            {showBasis
              ? 'Hide what this is based on'
              : confidence.caveats.length
                ? `What this does not cover (${confidence.caveats.length})`
                : 'What this is based on'}
          </button>
        )}
      </div>

      {showBasis && (
        <div style={{ padding: '0 26px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <FadingRule />
          <BasisLine label="This verdict">{verdict.basis}</BasisLine>
          {leverage.basis && <BasisLine label="Reach">{leverage.basis}</BasisLine>}
          {trend.data?.basis && <BasisLine label="Direction">{trend.data.basis}</BasisLine>}
          {trend.data?.caveat && <BasisLine label="Not re-checked">{trend.data.caveat}</BasisLine>}
          {confidence.caveats.map((c) => (
            <BasisLine key={c} label="Not covered" tone="warn">{c}</BasisLine>
          ))}
        </div>
      )}
    </Card>
  );
}

const BAND_COLOR = { good: 'var(--primary)', fair: 'var(--viz-warn)', poor: 'var(--viz-neg)' };

const SEVERITY_LABEL = { error: 'Critical', warning: 'Important', notice: 'Minor', info: 'Minor' };

/** A round mark beside the headline: ! for trouble, ✓ for fine, – for unmeasured. */
function StateMark({ state, color }) {
  const glyph = state === 'healthy' ? '✓' : state === 'not_measured' ? '–' : '!';
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0, width: 34, height: 34, borderRadius: '50%',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18, fontWeight: 800, color,
        background: `color-mix(in srgb, ${color} 14%, var(--card))`,
      }}
    >
      {glyph}
    </span>
  );
}

function ChipRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ width: 84, flexShrink: 0, whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function AreaChip({ to, color, children }) {
  const style = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 11px', borderRadius: 999,
    fontSize: 12.5, color: 'var(--text)', textDecoration: 'none', background: 'var(--card)',
    border: `1px solid color-mix(in srgb, ${color} 35%, var(--border))`,
  };
  return to ? <Link to={to} className="exec-chip" style={style}>{children}</Link> : <span style={style}>{children}</span>;
}

/**
 * The issue counts as three figures and one bar, so "how bad, and how much of
 * it is critical" is read at a glance rather than out of a sentence.
 */
function IssueMix({ issues, leverage }) {
  const total = issues.critical + issues.important + issues.minor;
  const parts = [
    { key: 'critical', label: 'Critical', n: issues.critical, color: 'var(--viz-neg)' },
    { key: 'important', label: 'Important', n: issues.important, color: 'var(--viz-warn)' },
    { key: 'minor', label: 'Minor', n: issues.minor, color: 'var(--text-3)' },
  ];
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', borderRadius: 14,
        background: 'var(--surface-2)', border: '1px solid var(--border)', alignSelf: 'start',
      }}
    >
      <span className="eyebrow">Issues found · {total}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {parts.map((p) => (
          <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="num" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color: p.n ? p.color : 'var(--text-3)' }}>{p.n}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{p.label}</span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', gap: 2, background: 'var(--border)' }}>
        {parts.filter((p) => p.n).map((p) => (
          <span key={p.key} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-2)' }}>
        {issues.pagesWithCritical > 0 && (
          <span>
            <strong style={{ color: 'var(--text)' }}>{issues.pagesWithCritical.toLocaleString('en-US')}</strong>
            {' '}page{issues.pagesWithCritical === 1 ? '' : 's'} with a critical issue
            {issues.crawledPages ? ` of ${issues.crawledPages.toLocaleString('en-US')} crawled` : ''}
          </span>
        )}
        {issues.templateWide > 0 && (
          <span>
            <strong style={{ color: 'var(--primary-text)' }}>{issues.templateWide}</strong>
            {' '}fixable with one template change each
            {leverage?.templateShare ? ` (${leverage.templateShare}% of the work)` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One of the three things to do, as a card: its rank, how serious it is, what
 * it is, what it covers, and where to go to do it.
 */
function PriorityCard({ item, to, onPromote }) {
  const [state, setState] = useState('idle');   // idle | saving | done | error
  const [error, setError] = useState(null);
  const color = SEVERITY_TONE[item.severity] || 'var(--text-3)';

  async function promote() {
    if (!onPromote) return;
    setState('saving');
    setError(null);
    try {
      await onPromote(item.key);
      setState('done');
    } catch (e) {
      setState('error');
      setError(e.message);
    }
  }

  return (
    <li
      className="exec-priority"
      style={{ borderTop: `3px solid ${color}` }}
      title={item.basis || undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          className="num"
          style={{
            width: 26, height: 26, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700, color, background: `color-mix(in srgb, ${color} 13%, var(--card))`,
          }}
        >
          {item.rank}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color }}>
          {SEVERITY_LABEL[item.severity] || 'To do'}
        </span>
      </div>
      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>{item.title}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{item.reach}</span>
      {state === 'error' && <Muted size={11.5} style={{ color: 'var(--viz-neg)' }}>{error}</Muted>}
      <div style={{ marginTop: 'auto', paddingTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{item.moduleLabel}</span>
        {to && (
          <Link to={to} className="exec-open" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--primary-text)', textDecoration: 'none' }}>
            Open →
          </Link>
        )}
      </div>

      {/* "Add to plan" — see ADD_TO_PLAN_ENABLED at the top of this file. */}
      {ADD_TO_PLAN_ENABLED && onPromote && item.kind !== 'area' && (
        state === 'done' ? (
          <Muted size={12} title="It is on the Recommendations sheet of the workbook behind Download report.">
            ✓ Added to the report
          </Muted>
        ) : (
          <Btn
            onClick={promote}
            disabled={state === 'saving'}
            title={'Adds this finding, with its evidence, to the project’s recommendations. '
              + 'It appears in the Recommendations sheet of the downloadable report.'}
            style={{ height: 28, fontSize: 12, padding: '0 10px', alignSelf: 'flex-start' }}
          >
            {state === 'saving' ? 'Adding…' : 'Add to plan'}
          </Btn>
        )
      )}
    </li>
  );
}

/**
 * Direction of travel, beside the eyebrow.
 *
 * Four states, and three of them are not "flat". A first audit, a pair of runs
 * with no pages in common and a failed read all have to say what they are:
 * rendering any of them as "no change" would claim the site held steady when in
 * fact nothing was compared — the exact confusion insights/changes.js exists to
 * prevent.
 */
function TrendChip({ state }) {
  if (state.loading) {
    return <Muted size={11.5}>comparing with the previous audit…</Muted>;
  }
  if (state.error) {
    return <Muted size={11.5} style={{ color: 'var(--viz-warn)' }}>direction unavailable</Muted>;
  }
  const trend = state.data;
  if (!trend) return null;

  if (trend.state !== 'compared') {
    return (
      <Muted size={11.5} title={trend.sentence}>
        {trend.state === 'first_run' ? 'first audit — nothing to compare yet' : 'not comparable'}
      </Muted>
    );
  }

  const t = TREND_TONE[trend.direction] || TREND_TONE.flat;
  return (
    <span
      title={trend.caveat ? `${trend.sentence} ${trend.caveat}` : trend.sentence}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
        fontWeight: 600, letterSpacing: '0.02em', color: t.color,
      }}
    >
      <span aria-hidden="true">{t.mark}</span>
      {t.word} since the last audit
    </span>
  );
}

function BasisLine({ label, children, tone }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span
        style={{
          flexShrink: 0, minWidth: 96, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: tone === 'warn' ? 'var(--viz-warn)' : 'var(--text-3)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>{children}</span>
    </div>
  );
}
