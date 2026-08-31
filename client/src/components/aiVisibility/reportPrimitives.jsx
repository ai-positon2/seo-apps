import { useState } from 'react';
import { MetricCard } from '../../ui';

// ── Primitives the nine reports share ───────────────────────────────────────
//
// Every component here reads a metric envelope from the server —
// `{value, display, delta, deltaDisplay, direction}` — and NEVER computes one.
// METRICS.md §12 puts that rule on the server side; this file is the client
// half of it. If a component in here starts dividing two numbers, the spec has
// stopped being the single source of truth.
//
// No hex codes. Every colour is a token from index.css, so both themes and any
// future retheme come for free.

/**
 * Which way a delta should be coloured.
 *
 * The metric carries `direction` precisely so this decision does not need to
 * know what the metric means. Position is the case that forces it: a rank
 * moving from #4 to #2 is a NEGATIVE delta and an improvement, and colouring
 * by sign alone would paint the best result on the page red.
 */
export function deltaVariant(metric) {
  if (!metric || metric.delta === null || metric.delta === undefined) return 'neutral';
  if (metric.direction === 'neutral') return 'neutral';
  const good = metric.direction === 'lower_is_better' ? metric.delta < 0 : metric.delta > 0;
  if (metric.delta === 0) return 'neutral';
  return good ? 'success' : 'danger';
}

/**
 * One KPI cell, driven entirely by a server metric.
 *
 * `sub` falls back to the metric's own `note`, which is where the server
 * explains an em-dash — "insufficient_captures_per_model", "Not scored". An
 * unexplained em-dash reads as a bug; an explained one reads as an answer.
 */
export function Metric({ label, metric, sub }) {
  if (!metric) return <MetricCard label={label} value="—" sub={sub || 'Not available'} />;
  return (
    <MetricCard
      label={label}
      value={metric.display}
      delta={metric.deltaDisplay || undefined}
      deltaVariant={deltaVariant(metric)}
      sub={sub || metric.note || undefined}
    />
  );
}

/** The KPI strip, at the design's own `auto-fit, minmax(200px, 1fr)`. */
export function MetricStrip({ children, min = 200 }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
      gap: 12,
    }}
    >
      {children}
    </div>
  );
}

/**
 * A bar with its label INSIDE it.
 *
 * Width is a share of the row set's own maximum, never of 100 — a chart whose
 * longest bar is 40% wide wastes more than half the space it was given, and the
 * comparison a reader actually makes is between bars, not against an invisible
 * ceiling.
 */
export function FilledLabelBar({
  label, value, max, display, highlight = false, tone,
}) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const fill = tone || (highlight ? 'var(--primary)' : 'var(--viz-2)');

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        position: 'relative',
        height: 30,
        borderRadius: 'var(--r-sm)',
        background: 'color-mix(in srgb, var(--text-3) 10%, transparent)',
        overflow: 'hidden',
      }}
      >
        <div style={{
          position: 'absolute',
          inset: 0,
          width: `${width}%`,
          background: highlight ? fill : `color-mix(in srgb, ${fill} 55%, transparent)`,
          borderRadius: 'var(--r-sm)',
        }}
        />
        <div style={{
          position: 'relative',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          gap: 10,
        }}
        >
          <span style={{
            fontSize: 12.5,
            color: 'var(--text)',
            fontWeight: highlight ? 600 : 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          >
            {label}
          </span>
          <span className="num" style={{ fontSize: 12, color: 'var(--text-2)', flexShrink: 0 }}>
            {display}
          </span>
        </div>
      </div>
    </div>
  );
}

// §5.3's classification, as colour. Kept as one map because the same eleven
// types appear across the Domains, URLs and Gap reports and three copies would
// eventually disagree about what "reference" looks like.
const TYPE_TONE = {
  you: 'var(--primary)',
  competitor: 'var(--viz-5)',
  reference: 'var(--viz-1)',
  institutional: 'var(--viz-3)',
  editorial: 'var(--viz-2)',
  ugc: 'var(--viz-4)',
  corporate: 'var(--viz-6)',
  other: 'var(--text-3)',
  homepage: 'var(--viz-1)',
  profile: 'var(--viz-2)',
  category: 'var(--viz-3)',
  product: 'var(--viz-4)',
  article: 'var(--viz-2)',
  listicle: 'var(--viz-4)',
  discussion: 'var(--viz-5)',
};

export function typeTone(type) {
  return TYPE_TONE[type] || 'var(--text-3)';
}

/** A small type label. `null` renders as "unknown", not as a missing chip. */
export function TypeChip({ type, title }) {
  const tone = typeTone(type);
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 'var(--r-pill)',
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '.04em',
        color: type ? tone : 'var(--text-3)',
        background: type
          ? `color-mix(in srgb, ${tone} 14%, transparent)`
          : 'color-mix(in srgb, var(--text-3) 10%, transparent)',
        border: `1px solid ${type ? `color-mix(in srgb, ${tone} 34%, transparent)` : 'var(--border)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {type || 'unknown'}
    </span>
  );
}

/**
 * Progressive disclosure over a list.
 *
 * There were four copy-pasted versions of this in the app before the reports
 * needed a fifth. One implementation, and the collapsed count is always stated
 * — "Show 12 more" tells a reader how much they are not seeing; "Show more"
 * does not.
 */
export function ShowMore({ items, initial = 8, render, noun = 'more' }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, initial);
  const hidden = items.length - shown.length;

  return (
    <>
      {shown.map(render)}
      {(hidden > 0 || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={{
            marginTop: 8,
            padding: '5px 9px',
            fontSize: 11.5,
            color: 'var(--text-2)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            cursor: 'pointer',
          }}
        >
          {open ? 'Show fewer' : `Show ${hidden} ${noun}`}
        </button>
      )}
    </>
  );
}

/**
 * The three §11 states, made impossible to confuse.
 *
 * `—` when nothing was measured, a real value otherwise, and a REASON beside
 * the dash. This is the whole nullable-by-default design surfacing in the UI:
 * "we could not ask" must never look like "you were not named".
 */
export function EmptyMetric({ reason }) {
  return (
    <span style={{ color: 'var(--text-3)' }}>
      <span className="num">—</span>
      {reason && <span style={{ fontSize: 11.5, marginLeft: 6 }}>{reason}</span>}
    </span>
  );
}

// Warnings the server can attach to any report envelope. Copy lives here, in
// one place, so the same condition reads identically on all nine screens.
const WARNING_COPY = {
  coverage_below_threshold: {
    tone: 'warning',
    text: 'Coverage is below 90%. Some captures failed, so every number here rests on '
      + 'fewer answers than were attempted.',
  },
  prompt_set_changed: {
    tone: 'warning',
    text: 'The question set changed between periods. Deltas compare only the questions both '
      + 'periods measured.',
  },
  removed_prompts_excluded: {
    tone: 'muted',
    text: 'Questions you removed are not counted here. These numbers describe the questions '
      + 'you ask today, so removing one changes past periods too.',
  },
  no_comparable_period: {
    tone: 'muted',
    text: 'No earlier period to compare against yet, so no deltas are shown.',
  },
  no_client_brand: {
    tone: 'danger',
    text: 'No approved client brand. Nothing can be measured until the measured set is '
      + 'reviewed on the Brands screen.',
  },
  no_approved_brands: {
    tone: 'danger',
    text: 'No approved brands for this client. Derive and approve the measured set first.',
  },
  captures_not_extracted: {
    tone: 'warning',
    text: 'Some captures have not been through extraction. Their answers are stored but not '
      + 'yet counted — they are NOT absences.',
  },
  url_type_unavailable: {
    tone: 'muted',
    text: 'Some engines expose source domains only, with no page path, so URL type is unknown '
      + 'for those rows rather than guessed.',
  },
  perception_not_extracted: {
    tone: 'muted',
    text: 'Perception terms have not been extracted yet.',
  },
};

const WARNING_TONE = {
  danger: { fg: 'var(--danger)', bg: 'var(--danger-soft)', border: 'var(--danger)' },
  warning: { fg: 'var(--warning)', bg: 'var(--warning-soft)', border: 'var(--warning)' },
  muted: { fg: 'var(--text-3)', bg: 'var(--surface)', border: 'var(--border)' },
};

/** Every warning the report carried, spelled out rather than left as a code. */
export function ReportWarnings({ warnings = [], meta }) {
  const known = warnings.filter((w) => WARNING_COPY[w]);
  if (!known.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      {known.map((w) => {
        const { tone, text } = WARNING_COPY[w];
        const c = WARNING_TONE[tone];
        const extra = w === 'captures_not_extracted' && meta?.unextracted
          ? ` ${meta.unextracted} capture(s) affected.`
          : '';
        const note = w === 'prompt_set_changed' && meta?.comparison?.note
          ? ` ${meta.comparison.note}`
          : '';
        return (
          <div
            key={w}
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              padding: '9px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text-2)',
              background: c.bg,
              border: `1px solid color-mix(in srgb, ${c.border} 40%, transparent)`,
              borderRadius: 'var(--r-md)',
            }}
          >
            <span style={{ color: c.fg, fontWeight: 700, flexShrink: 0 }}>!</span>
            <span>{text}{extra}{note}</span>
          </div>
        );
      })}
    </div>
  );
}

export default Metric;
