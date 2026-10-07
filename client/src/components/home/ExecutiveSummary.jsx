import { useEffect, useRef, useState } from 'react';
import { Card, Muted, Btn, FadingRule } from '../studio/primitives';
import { projectsApi, relativeTime } from '../../lib/projectsApi';
import { friendlyError, errorDetail } from '../../lib/friendlyError';

// "Add to plan" (PriorityRow, below) turned out to lead nowhere from the
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
// This block sits directly under the client's name, above the score tiles and
// the module cards, and says four things, in that order:
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

// Sentence-case section label. It replaced the 10px letter-spaced capitals of
// the `eyebrow` class, which a reader had to decode before they could skip it.
const LABEL = { fontSize: 13, fontWeight: 600, color: 'var(--text-3)' };

/**
 * @param {object}   props
 * @param {string}   props.projectId
 * @param {function} props.onPromote  turns a priority into a recommendation draft
 */
export default function ExecutiveSummary({ projectId, onPromote }) {
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
        <span style={LABEL}>Executive summary</span>
        <div style={{ height: 22, width: '45%', borderRadius: 6, background: 'var(--surface)' }} />
        <div style={{ height: 16, width: '80%', borderRadius: 6, background: 'var(--surface)' }} />
        <div style={{ height: 16, width: '62%', borderRadius: 6, background: 'var(--surface)' }} />
      </Card>
    );
  }

  if (summary.error || !summary.data) {
    // Not hidden. A summary that disappears when it fails is indistinguishable
    // from a site with nothing to report.
    const detail = summary.error ? errorDetail(summary.error) : null;
    return (
      <Card elevation="md" style={{ padding: '18px 22px', gap: 6 }} role="alert">
        <span style={LABEL}>Executive summary unavailable</span>
        <Muted size={13}>
          {summary.error
            ? `${friendlyError(summary.error)} The scores below are unaffected.`
            : 'The summary could not be read. The scores below are unaffected.'}
        </Muted>
        {detail && (
          <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <summary style={{ cursor: 'pointer' }}>Show details</summary>
            {detail}
          </details>
        )}
      </Card>
    );
  }

  const { verdict, standing, leverage, priorities, confidence } = summary.data;
  const tone = STATE_TONE[verdict.state] || STATE_TONE.not_measured;

  return (
    <Card
      elevation="md"
      style={{
        padding: 0, gap: 0, overflow: 'hidden',
        // The state is carried by a rule down the left edge rather than by a
        // tinted card. A whole panel washed red is the kind of alarm a dashboard
        // can only raise once before it is ignored, and this one is on screen
        // every visit.
        borderLeft: `3px solid ${tone.tint}`,
      }}
    >
      {/* ── The verdict ──────────────────────────────────────────────────── */}
      <div style={{ padding: '22px 26px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={LABEL}>Executive summary</span>
          <TrendChip state={trend} />
        </div>

        <h2 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: '-0.01em', color: tone.color }}>
          {verdict.headline}
        </h2>

        {/* The one sentence the whole layer exists to produce. Set at reading
            size, not at caption size — it is the content, not a label for it. */}
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: 'var(--text)', maxWidth: 780 }}>
          {verdict.sentence}
        </p>

        {leverage.sentence && (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-2)', maxWidth: 780 }}>
            {leverage.sentence}
          </p>
        )}

        {trend.data?.state === 'compared' && (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--text-2)', maxWidth: 780 }}>
            {trend.data.sentence}
          </p>
        )}
      </div>

      {/* ── What to do about it ──────────────────────────────────────────── */}
      {priorities.length > 0 && (
        <div
          style={{
            padding: '16px 26px 18px', display: 'flex', flexDirection: 'column', gap: 12,
            borderTop: '1px solid var(--border)', background: 'var(--surface-2)',
          }}
        >
          <span style={LABEL}>
            {priorities.length === 1 ? 'Top fix' : `Top ${priorities.length} fixes`}
          </span>
          {/* Capped at the same measure as the paragraphs above. Without it the
              row stretched the full card and parked its button 700px from the
              title it belongs to on a wide screen — two columns that read as
              unrelated. */}
          <ol
            style={{
              margin: 0, padding: 0, listStyle: 'none', maxWidth: 820,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            {priorities.map((item) => (
              <PriorityRow key={item.key} item={item} onPromote={onPromote} />
            ))}
          </ol>
          {/* The rest of the list. Home no longer renders the full ranked
              backlog, and the place every finding is listed is the workbook
              behind Download report — so that is where this points, rather
              than at a screen that does not exist. The count is the backlog's
              own total, the same figure as the "To fix" tile. */}
          {leverage.actions > priorities.length && (
            <a
              href={projectsApi.reportUrl(projectId, 'xlsx')}
              style={{ fontSize: 13, color: 'var(--primary-text)', alignSelf: 'flex-start' }}
            >
              {`${(leverage.actions - priorities.length).toLocaleString('en-US')} more — see the full list in the Excel report`}
            </a>
          )}
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
        <div
          style={{
            padding: '0 26px 18px', display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <FadingRule />
          <BasisLine label="Overall score">{standing.basis}</BasisLine>
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

/**
 * One of the three things to do.
 *
 * The title is the finding's own, the middle line is what it costs and covers,
 * and the basis is the full audit trail for why it sits at this rank — kept as a
 * tooltip rather than a third line, because three lines per row turns a decision
 * into a document.
 */
function PriorityRow({ item, onPromote }) {
  const [state, setState] = useState('idle');   // idle | saving | done | error
  const [error, setError] = useState(null);

  async function promote() {
    if (!onPromote) return;
    setState('saving');
    setError(null);
    try {
      await onPromote(item.key);
      setState('done');
    } catch (e) {
      setState('error');
      setError(friendlyError(e));
    }
  }

  return (
    // `flexWrap` so the button drops under the title on a phone rather than
    // squeezing it to two characters a line.
    <li style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0, marginTop: 5, width: 8, height: 8, borderRadius: '50%',
          background: SEVERITY_TONE[item.severity] || 'var(--text-3)',
        }}
      />
      <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.4 }} title={item.basis || undefined}>
          {item.title}
        </span>
        <Muted size={12}>
          {[item.reach, item.moduleLabel].filter(Boolean).join(' · ')}
        </Muted>
        {state === 'error' && (
          <Muted size={12} style={{ color: 'var(--viz-neg)' }}>{error}</Muted>
        )}
      </div>

      {/* The one action this row offers. POST /insights/promote has existed since
          the recommendation lifecycle was built and had nothing in the product
          pointing at it, so the board it fills stayed empty while the API to
          fill it sat there working.
          The confirmation names where the item actually went. "Added to
          recommendations" is true and useless: recommendations have no screen of
          their own, and the place they surface is the Recommendations sheet of
          the workbook behind Download report — which is the artifact this
          reader forwards to whoever does the work.

          Hidden for now (on request) — from the reader's seat this button
          appeared to lead nowhere, since its only destination is that
          download, not a visible screen. onPromote/promote() are left wired
          so this is a one-line revert (drop ADD_TO_PLAN_ENABLED, restore the
          plain `{onPromote && (` condition) once there's a screen it feeds
          directly. */}
      {ADD_TO_PLAN_ENABLED && onPromote && (
        state === 'done' ? (
          <Muted
            size={12}
            title="It is on the Recommendations sheet of the workbook behind Download report."
            style={{ marginTop: 4, whiteSpace: 'nowrap' }}
          >
            ✓ Added to the report
          </Muted>
        ) : (
          <Btn
            onClick={promote}
            disabled={state === 'saving'}
            title={'Adds this finding, with its evidence, to the project\u2019s recommendations. '
              + 'It appears in the Recommendations sheet of the downloadable report.'}
            style={{ height: 28, fontSize: 12, padding: '0 10px', flexShrink: 0 }}
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
    return <Muted size={12}>Comparing with the previous audit…</Muted>;
  }
  if (state.error) {
    // The reader's sentence on screen; the raw text, when it was replaced,
    // on hover — this chip has no room for a details toggle.
    return (
      <Muted size={12} style={{ color: 'var(--viz-warn)' }} title={errorDetail(state.error) || undefined}>
        Couldn&rsquo;t compare with the last audit. {friendlyError(state.error)}
      </Muted>
    );
  }
  const trend = state.data;
  if (!trend) return null;

  if (trend.state !== 'compared') {
    return (
      <Muted size={12} title={trend.sentence}>
        {trend.state === 'first_run' ? 'First audit — nothing to compare yet' : 'Not comparable with the last audit'}
      </Muted>
    );
  }

  const t = TREND_TONE[trend.direction] || TREND_TONE.flat;
  return (
    <span
      title={trend.caveat ? `${trend.sentence} ${trend.caveat}` : trend.sentence}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
        fontWeight: 600, color: t.color,
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
          flexShrink: 0, minWidth: 110, fontSize: 12, fontWeight: 600,
          color: tone === 'warn' ? 'var(--viz-warn)' : 'var(--text-3)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>{children}</span>
    </div>
  );
}
