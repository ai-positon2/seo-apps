// Shared style tokens and small pure helpers for the AI Visibility screens.
// Moved out of AiVisibilityPage.jsx so the review-screen components can use
// them too without importing a page.

export const card = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: 18,
};

export const muted = { fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 };

/**
 * An INSTANT, in the reader's own timezone, with the clock.
 *
 * Captures are `timestamptz` — a moment, not a calendar day — and they were
 * being rendered as `toISOString().slice(0, 10)`, which truncates to the UTC
 * day and throws the time away. For a reader in IST that meant everything done
 * between midnight and 05:30 showed as YESTERDAY, and five separate runs in one
 * night all rendered the identical string. The report looked frozen when it was
 * updating correctly.
 *
 * Period BOUNDARIES stay UTC — those are genuine
 * UTC calendar days, and re-basing them per viewer would move which captures
 * fall in which period, which §11 forbids. This is for instants only.
 */
export function formatWhen(iso, { withTime = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  });
}

export function band(score) {
  if (score === null || score === undefined) return 'var(--text-3)';
  if (score >= 60) return 'var(--success)';
  if (score >= 30) return 'var(--warning)';
  return 'var(--danger)';
}

/** A bar whose width is a share of the widest value, not of 100. */
export function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 999, background: 'color-mix(in srgb, var(--text-3) 16%, transparent)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color || 'var(--primary)', borderRadius: 999 }} />
    </div>
  );
}

/** 'Uncategorised' always sorts last — everything else alphabetically. */
export function sortTopics(topics) {
  return [...topics].sort((a, b) => {
    const aKey = a.label ?? a.topic ?? '';
    const bKey = b.label ?? b.topic ?? '';
    if (aKey === 'Uncategorised') return 1;
    if (bKey === 'Uncategorised') return -1;
    return aKey.localeCompare(bKey);
  });
}

export function verdictLabel(mentionedOnAnySurface) {
  if (mentionedOnAnySurface === true) return 'NAMED';
  if (mentionedOnAnySurface === false) return 'absent';
  return '?';
}

export function verdictColor(mentionedOnAnySurface) {
  if (mentionedOnAnySurface === true) return 'var(--success)';
  if (mentionedOnAnySurface === false) return 'var(--danger)';
  return 'var(--text-3)';
}
