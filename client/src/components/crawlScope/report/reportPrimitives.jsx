// ── The Tech Audit report's own small pieces ────────────────────────────────
//
// The crawl report is one screen with six views, and the same six shapes recur
// across all of them: a pill, a stat tile, a card, a section rule, a severity
// chip and a back link. Defined once here so the views below stay about what
// they show rather than about how a tile is built.
//
// These are deliberately separate from client/src/ui: that library is the
// app-wide vocabulary and its Card/Badge/MetricCard have their own padding and
// radius. This report is drawn to a specific set of measurements and bending the
// shared components to hit them would have changed every other screen too.

/** Severity → the dot, chip and label the whole report uses. */
export const SEV = {
  error: {
    dot: 'var(--viz-neg)',
    chipBg: 'color-mix(in srgb, var(--viz-neg) 20%, transparent)',
    chipFg: 'var(--viz-neg)',
    label: 'Error — blocks the page',
  },
  warning: {
    dot: 'var(--viz-warn)',
    chipBg: 'color-mix(in srgb, var(--viz-warn) 20%, transparent)',
    chipFg: 'var(--viz-warn)',
    label: 'Warning — costs performance',
  },
  notice: {
    dot: 'var(--text-3)',
    chipBg: 'var(--neutral-800)',
    chipFg: 'var(--neutral-200)',
    label: 'Notice — worth tidying',
  },
  info: {
    dot: 'var(--text-3)',
    chipBg: 'var(--neutral-800)',
    chipFg: 'var(--neutral-200)',
    label: 'Info',
  },
};

export const sevOf = (severity) => SEV[severity] || SEV.notice;

/** A finding's review status → the chip it wears in the affected-pages table. */
export const REVIEW_TONE = {
  'Needs review': { bg: 'color-mix(in srgb, var(--viz-warn) 20%, transparent)', fg: 'var(--viz-warn)' },
  'Confirmed issue': { bg: 'color-mix(in srgb, var(--viz-neg) 20%, transparent)', fg: 'var(--viz-neg)' },
  'False positive': { bg: 'var(--neutral-800)', fg: 'var(--neutral-200)' },
  Resolved: { bg: 'var(--accent-800)', fg: 'var(--accent-100)' },
};

/** The report's 10px uppercase label. */
export const Eyebrow = ({ children, tone = 'muted', style }) => (
  <span
    style={{
      fontSize: 10,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontWeight: 600,
      color: tone === 'accent' ? 'var(--primary-text)' : 'var(--text-3)',
      ...style,
    }}
  >
    {children}
  </span>
);

/** A card. The report's own padding and radius, not the shared ui/Card's. */
export const Panel = ({ children, pad = '20px 22px', elevation = 'sm', style }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: pad,
      borderRadius: 'var(--r-lg)',
      background: 'var(--card)',
      border: '1px solid var(--border)',
      boxShadow: elevation === 'md' ? 'var(--shadow-md)' : 'var(--shadow-sm)',
      ...style,
    }}
  >
    {children}
  </div>
);

/** A ruled section heading with a note on the right. */
export const RuledHead = ({ title, note }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      paddingBottom: 8,
      borderBottom: '1px solid var(--border)',
      flexWrap: 'wrap',
    }}
  >
    <h6
      style={{
        margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text)',
      }}
    >
      {title}
    </h6>
    {note && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{note}</span>}
  </div>
);

/**
 * A filter pill. Two sizes because the report has two rows of them: the tall
 * ones that switch the whole view, and the short ones inside a view that filter
 * a table.
 */
export const Pill = ({ active, onClick, children, size = 'lg' }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      height: size === 'lg' ? 34 : 32,
      padding: size === 'lg' ? '0 14px' : '0 12px',
      fontFamily: 'var(--font-sans)',
      fontSize: size === 'lg' ? 13 : 12.5,
      fontWeight: active ? 600 : 400,
      color: active ? 'var(--primary-text)' : 'var(--text-2)',
      background: active ? 'color-mix(in srgb, var(--primary) 14%, transparent)' : 'transparent',
      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      borderRadius: size === 'lg' ? 999 : 8,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </button>
);

/** One number with a label above it and a sentence below. */
export const Tile = ({ label, value, sub, color = 'var(--text)', size = 28 }) => (
  <div
    style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '16px 18px',
      borderRadius: 10, background: 'var(--card)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}
  >
    <span
      style={{
        fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase',
        fontWeight: 600, color: 'var(--text-3)',
      }}
    >
      {label}
    </span>
    <span className="num" style={{ fontSize: size, fontWeight: 600, lineHeight: 1, color }}>
      {value}
    </span>
    {sub && <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.4 }}>{sub}</span>}
  </div>
);

/** A small status/category chip. */
export const Chip = ({ children, bg = 'var(--neutral-800)', fg = 'var(--neutral-200)' }) => (
  <span
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11,
      padding: '3px 10px', borderRadius: 6, whiteSpace: 'nowrap',
      background: bg, color: fg,
    }}
  >
    {children}
  </span>
);

/** The chevron-left link out of a detail view. */
export const BackLink = ({ children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: 0, background: 'none', border: 'none', cursor: 'pointer',
      fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--text-3)',
    }}
  >
    <svg
      width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
    {children}
  </button>
);

/** A button in the report's own outline style. `tone` picks the border colour. */
export const OutlineButton = ({ tone = 'neutral', onClick, disabled, children, style }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      height: 38,
      padding: '0 16px',
      fontFamily: 'var(--font-sans)',
      fontSize: 13,
      fontWeight: 500,
      color: disabled ? 'var(--text-3)' : tone === 'accent' ? 'var(--primary-text)' : 'var(--text)',
      background: 'transparent',
      border: `1px solid ${tone === 'accent' && !disabled ? 'var(--primary)' : 'var(--border)'}`,
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </button>
);

/** The report's table shell: a bordered, rounded, horizontally scrollable card. */
export const TableFrame = ({ children }) => (
  <div
    style={{
      overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10,
      background: 'var(--card)',
    }}
  >
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>{children}</table>
  </div>
);

export const Th = ({ children, align = 'left', nowrap = false }) => (
  <th
    style={{
      padding: '11px 14px', textAlign: align, fontSize: 10.5, fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-3)',
      borderBottom: '1px solid var(--border)',
      whiteSpace: nowrap ? 'nowrap' : undefined,
    }}
  >
    {children}
  </th>
);

/** "Showing 1–8 of 418" with Previous / Next. */
export function Pager({ page, pageCount, note, onPage }) {
  return (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 10, flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{note}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <PagerButton disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</PagerButton>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Page {page} of {pageCount}
        </span>
        <PagerButton disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</PagerButton>
      </div>
    </div>
  );
}

const PagerButton = ({ disabled, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      height: 30, padding: '0 12px', fontFamily: 'var(--font-sans)', fontSize: 12,
      color: disabled ? 'var(--text-3)' : 'var(--text)', background: 'transparent',
      border: '1px solid var(--border)', borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    {children}
  </button>
);

/**
 * Shown wherever findings would go, while a crawl is still running.
 *
 * The report used to render the crawler's live checks here — about a dozen
 * status-code and redirect rules that run per page during the crawl — and it
 * read as the finished audit. After 1,700 pages it said "All Issues (5),
 * Errors (0)", which is not a small inaccuracy: it told the reader their site
 * was clean when nothing had looked.
 *
 * So nothing is shown. The full rule catalog runs once, at crawl
 * completion, and until every rule has run over every page there is no partial
 * answer worth giving — a list that is 5% of the truth invites exactly the
 * wrong conclusion, and the live checks are visible per-page in All Pages
 * anyway for anyone watching the crawl.
 *
 * @param {number?} crawled  pages fetched so far, when known
 */
export const AnalyzingNotice = ({ crawled = null }) => (
  <div
    style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: '22px 24px',
      borderRadius: 'var(--r-lg)', background: 'var(--card)',
      border: '1px dashed var(--border-strong)',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden="true"
        style={{
          width: 8, height: 8, borderRadius: '50%', background: 'var(--viz-warn)',
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>
        Analysing the crawl — findings appear when it finishes
      </span>
    </div>
    <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
      The full audit runs over every page once the crawl reaches a terminal state.
      {crawled ? ` ${crawled.toLocaleString()} pages have been fetched so far.` : ''}
      {' '}
      Nothing is listed until all of it has run: a partial list would understate what is wrong,
      and an empty one would read as a clean site.
    </span>
    <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
      Pages appear in “All Pages” as they are fetched, with the status code and redirect checks
      the crawler runs live.
    </span>
  </div>
);

/** The report's inline search field. */
export const SearchField = ({ value, onChange, placeholder }) => (
  <label
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 10px',
      fontSize: 12.5, color: 'var(--text-3)', background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 8, flex: '1 1 220px',
    }}
  >
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none',
        fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--text)',
      }}
    />
  </label>
);
