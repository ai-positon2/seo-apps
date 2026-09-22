import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Muted, Tag, TAG_TONES } from '../studio/primitives';
import ModuleIcon from './moduleIcons';
import { MODULE_STATUS_LABEL, MODULE_STATUS_TONE, relativeTime, isModuleInFlight } from '../../lib/projectsApi';
import { moduleReportRoute } from '../../lib/moduleReportRoute';
// Same dictionary the sidebar reads (toolsMeta.js) — one source of truth for
// a tag shown on both surfaces, per that file's own header comment.
import { TAGS } from '../../toolsMeta';

// ── One module of the audit profile ─────────────────────────────────────────
//
// One card, one number, one sentence, and the whole thing is the link to the
// module's own report. What it deliberately does NOT carry any more: a score
// ring, a severity strip and a list of top findings. Six cards each holding
// three visualisations of the same run made a wall that had to be read rather
// than scanned, and every one of those pieces exists in full one click away —
// the findings in the module's own report, the ranked version of them in "Do
// this next" below.
//
// Three shapes, and which one renders is decided by the data, not by a prop:
//
//   scored          the module's own 0-100, banded green/amber/red, with a bar
//   findings only   the finding count and the word "findings" — no bar, because
//                   there is no scale for one to be a fraction of
//   no evidence     an em dash, "no data yet", and a line saying what would put
//                   a number there
//
// The third shape is the point of the component. A dashboard that renders a
// confident 78 for a module that has never run is worse than one that admits it
// has nothing: the PRD forbids coercing missing data into a value (§16.11) and
// rules out inventing a new score (§6.2), and this is where that is honoured on
// screen.

const BAND = [
  { min: 80, color: 'var(--primary)' },
  { min: 60, color: 'var(--viz-warn)' },
  { min: 0, color: 'var(--viz-neg)' },
];

const bandColor = (score) => (BAND.find((b) => score >= b.min) || BAND[2]).color;

/**
 * The card's headline number, its unit, and the colour both take.
 *
 * The colour is also the card's top rule, which is what makes the grid readable
 * at arm's length: a row of green rules with one red one in it is a finding in
 * itself. A module that reports findings rather than a score gets a neutral
 * rule — it has measured something, and a count is not a judgement.
 */
function headlineNumber(module) {
  if (module.scored && Number.isFinite(module.score)) {
    const score = Math.round(module.score);
    return {
      text: String(score),
      unit: '/ 100',
      color: bandColor(score),
      barWidth: `${Math.max(2, Math.min(100, score))}%`,
    };
  }
  const found = module.evidence?.findingCount;
  if (Number.isFinite(found)) {
    return {
      text: String(found),
      unit: `finding${found === 1 ? '' : 's'}`,
      color: 'var(--text)',
      barWidth: null,
    };
  }
  return { text: '—', unit: 'no data yet', color: 'var(--text-3)', barWidth: null };
}

/**
 * The sentence under the number: what this module found, and what it read.
 *
 * `headline` is the finding and `detail` is what it was computed over, and the
 * card shows both — the second clamped, because six cards in a grid have to be
 * the same height and the full text is on the module's own page. A module that
 * has never run says what would put a number here instead, which is what the
 * dashed box the card used to carry said.
 */
function blurbLines(module) {
  if (module.status === 'not_run' && !module.evidence) {
    return {
      lead: module.headline || 'Never run for this client',
      support: module.runnable
        ? 'No stored evidence yet — run it to populate this card.'
        : module.live
          ? 'No stored evidence for this client yet.'
          : `Runs standalone today. Client-scoped evidence arrives with ${module.pendingPhase || 'a later phase'}.`,
    };
  }
  return { lead: module.headline, support: module.detail };
}

export default function ModuleCard({ module, onRun }) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState(null);

  const tone = MODULE_STATUS_TONE[module.status] || 'muted';
  const statusLabel = MODULE_STATUS_LABEL[module.status] || module.status;
  const tint = TAG_TONES[tone] || TAG_TONES.muted;
  const number = headlineNumber(module);
  const blurb = blurbLines(module);
  const canRun = Boolean(module.runnable && onRun);
  // 'queued' counts as in flight. A run that starts itself when a project's
  // domains are set up sits queued for its coalescing window before a worker
  // claims it, and an enabled Run button during that minute invites a second
  // run of a module that bills per domain.
  const running = busy || isModuleInFlight(module.status);
  const reportRoute = moduleReportRoute(module);

  async function run(e) {
    // The whole card is a link. Running the module is the one thing on it that
    // is not "open the report", so the click has to be kept off the link
    // underneath — otherwise pressing Run navigates away from the card that is
    // about to change.
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setRunError(null);
    try {
      await onRun(module.key);
    } catch (err) {
      setRunError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // On the card, not on the number.
      //
      // Every score on this dashboard carries the basis it was computed from,
      // and that used to be a title on the span holding it. The stretched link
      // below covers every span in the card, so the pointer never reaches one
      // of them and the tooltip could not be opened at all. The browser walks
      // up from whatever is hovered to find a title, so putting it here is what
      // makes it reachable — and hovering anywhere on the card is a lower bar
      // than finding the two characters the number is printed in.
      title={module.scoreBasis || module.note || module.detail || undefined}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        borderRadius: 'var(--r-md)',
        background: 'var(--card)',
        border: `1px solid ${hover ? 'var(--primary)' : 'var(--border)'}`,
        // The band colour, as a rule across the top of the card. Declared after
        // the shorthand or the shorthand would overwrite it.
        borderTop: `3px solid ${number.color}`,
        boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'border-color 150ms var(--ease), transform 150ms var(--ease), '
          + 'box-shadow 150ms var(--ease)',
      }}
    >
      {/* The link IS the card.
          Stretched over the whole surface rather than wrapped around it, so the
          Run button below can sit above it as a sibling — a button inside an
          anchor is invalid markup and behaves differently in every browser. A
          real anchor is also what keeps middle-click, cmd-click and the keyboard
          working, which an onClick on the div would have thrown away. */}
      <Link
        to={reportRoute.path}
        aria-label={`${module.label} — ${reportRoute.label.toLowerCase()}`}
        // The focus ring is in index.css: the link has no content of its own, so
        // without one, tabbing through the profile moves through six invisible
        // stops with nothing on screen to say where you are.
        className="module-card-link"
        style={{ position: 'absolute', inset: 0, zIndex: 1, borderRadius: 'var(--r-md)' }}
      />

      {/* Header: the module's mark and name, and how its last run went. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span
            style={{
              flexShrink: 0, width: 44, height: 44, borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: tint.bg, color: tint.fg,
            }}
          >
            <ModuleIcon moduleKey={module.key} />
          </span>
          <span
            style={{
              fontSize: 13.5, fontWeight: 500, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {module.label}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {/* Same pill and colour the sidebar shows next to this module's own
              nav entry — so "this is new/still settling" reads the same way
              wherever a reader meets it. */}
          {module.tag && TAGS[module.tag] && (
            <span style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              padding: '2px 6px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              background: TAGS[module.tag].bg,
              color: TAGS[module.tag].fg,
            }}
            >
              {TAGS[module.tag].short || TAGS[module.tag].label}
            </span>
          )}
          {/* An interrupted run is a real caveat, but it is one word, not a
              paragraph. */}
          {module.partial && <Tag tone="warn">Partial</Tag>}
          <Tag tone={tone}>{statusLabel}</Tag>
        </div>
      </div>

      {/* The number. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span
          className="num"
          style={{ fontSize: 40, fontWeight: 600, lineHeight: 1, color: number.color }}
        >
          {number.text}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{number.unit}</span>
      </div>

      {/* The bar is a fraction of 100, so only a scored module gets one. The
          track stays either way, which is what keeps every card in the grid the
          same height. */}
      <div style={{ height: 4, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
        {number.barWidth && (
          <div
            style={{
              height: '100%', borderRadius: 999, width: number.barWidth, background: number.color,
            }}
          />
        )}
      </div>

      {/* What it found, and what it read to find it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        {blurb.lead && (
          <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>
            {blurb.lead}
          </span>
        )}
        {blurb.support && (
          <span
            style={{
              fontSize: 11, color: 'var(--text-3)', lineHeight: 1.45,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {blurb.support}
          </span>
        )}
      </div>

      {/* A run that failed: the reason, not just a red tag. The design has no
          slot for this because no card in it has failed — but a card that says
          "Failed" and nothing else sends the reader to the server logs. */}
      {(module.error || runError) && (
        <div
          style={{
            padding: '9px 11px', borderRadius: 'var(--r-sm)', fontSize: 11.5, lineHeight: 1.5,
            background: 'color-mix(in srgb, var(--viz-neg) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--viz-neg) 32%, transparent)',
            color: 'var(--viz-neg)',
          }}
        >
          {runError || module.error}
        </div>
      )}

      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, marginTop: 'auto',
        }}
      >
        <Muted>
          {module.updatedAt ? `Updated ${relativeTime(module.updatedAt)}` : 'Never run for this client'}
        </Muted>
        {/* Kept from the card this replaces. The design's footer is the updated
            line alone, but re-running one module without re-running the whole
            audit is the only way to refresh a single card, and the alternative
            is a six-module audit to fix one stale number. */}
        {canRun && (
          <button
            type="button"
            onClick={run}
            disabled={running}
            title={`Run ${module.label} against this client now`}
            style={{
              // Above the stretched link, or this click opens the report instead.
              position: 'relative', zIndex: 2,
              padding: 0, border: 'none', background: 'none', flexShrink: 0,
              cursor: running ? 'default' : 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 11.5,
              color: running ? 'var(--text-3)' : 'var(--primary-text)',
            }}
          >
            {module.status === 'queued' && !busy
              ? 'Queued…'
              : running ? 'Running…' : module.updatedAt ? 'Re-run' : 'Run'}
          </button>
        )}
      </div>
    </div>
  );
}
