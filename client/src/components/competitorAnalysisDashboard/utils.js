export const DOMAIN_COLORS = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--danger)'];

export function domainColor(index) {
  return DOMAIN_COLORS[index % DOMAIN_COLORS.length];
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function domainLabel(d) {
  return d.label || d.domain;
}

export function scoreColor(score, goodAt = 70, okAt = 40) {
  if (score === null || score === undefined) return 'var(--text-3)';
  return score >= goodAt ? 'var(--success)' : score >= okAt ? 'var(--warning)' : 'var(--danger)';
}
