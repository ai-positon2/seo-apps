// Small pieces every Keyword Research view draws. The keyframes they animate
// with live in index.css (the app-wide `spin`, and `kr-pulse`), not in a
// <style> tag the page injects, so a view embedded in another tool cannot
// redefine that tool's own animations.

export const cardShadow = '0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04)';

export const PAGE_TYPE_STYLES = {
  page:      { bg: 'var(--success-soft)', text: 'var(--success)' },
  article:   { bg: 'var(--info-soft)',    text: 'var(--info)' },
  directory: { bg: 'var(--surface)',      text: 'var(--text-3)' },
};

export function Spinner({ size = 16, color }) {
  return (
    <svg style={{ animation: 'spin 1s linear infinite', width: size, height: size, color, flexShrink: 0 }} viewBox="0 0 24 24" fill="none">
      <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function StepBadge({ status, index }) {
  const baseStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: '50%', flexShrink: 0, fontSize: 12, fontWeight: 700,
  };

  if (status === 'done') return (
    <span style={{ ...baseStyle, background: 'var(--success)', color: '#fff' }}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  if (status === 'active') return (
    <span style={{ ...baseStyle, background: 'var(--primary)', color: '#fff' }}>
      <Spinner size={14} />
    </span>
  );

  return (
    <span style={{ ...baseStyle, background: 'var(--surface)', color: 'var(--text-3)', border: '1px solid var(--border)' }}>
      {index + 1}
    </span>
  );
}

export const CheckIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

export const CopyIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
  </svg>
);

export const EditIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
  </svg>
);

/** Round × button used to remove a pick. */
export function RemoveButton({ onClick, title, size = 20 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: '50%', border: 'none',
        background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)',
        cursor: 'pointer', fontSize: size >= 20 ? 13 : 12, fontWeight: 700, lineHeight: 1, padding: 0, flexShrink: 0,
      }}
    >
      ×
    </button>
  );
}

/** Small "+ Primary" / "+ Secondary" button; greyed out when that list is full. */
export function AddButton({ label, full, fullTitle, onClick, tone }) {
  const bg = tone === 'primary' ? 'var(--primary-soft)' : 'var(--info-soft)';
  const fg = tone === 'primary' ? 'var(--primary)' : 'var(--info)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={full}
      title={full ? fullTitle : `Add as ${tone === 'primary' ? 'Primary' : 'Secondary'}`}
      style={{
        fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none', whiteSpace: 'nowrap',
        background: full ? 'var(--surface)' : bg, color: full ? 'var(--text-3)' : fg,
        cursor: full ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}
