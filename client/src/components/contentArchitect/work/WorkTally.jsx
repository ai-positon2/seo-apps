// The collapsed cluster row's summary of what has been made for it: keyword
// sets, articles (brief or draft) and enhanced pages. Nothing is drawn for a
// cluster with no work, so the row stays as quiet as it was.

export const KeyIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 21 2M16 7l3 3M18.5 4.5l2 2" />
  </svg>
);

export const DocIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" />
  </svg>
);

export const SparkIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </svg>
);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function WorkTally({ tally }) {
  if (!tally?.total) return null;
  const articles = tally.briefs + tally.drafts;
  const items = [
    tally.keywords && { key: 'k', icon: <KeyIcon />, n: tally.keywords, color: 'var(--info)' },
    articles && { key: 'a', icon: <DocIcon />, n: articles, color: 'var(--primary-text)' },
    tally.enhanced && { key: 'e', icon: <SparkIcon />, n: tally.enhanced, color: 'var(--success)' },
  ].filter(Boolean);
  const title = [
    tally.keywords && plural(tally.keywords, 'keyword set'),
    tally.drafts && plural(tally.drafts, 'draft'),
    tally.briefs && plural(tally.briefs, 'brief'),
    tally.enhanced && `${plural(tally.enhanced, 'page')} enhanced`,
  ].filter(Boolean).join(' · ');

  return (
    <span
      title={`Made from this cluster: ${title}`}
      aria-label={`Made from this cluster: ${title}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '3px 4px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)', background: 'var(--surface)' }}
    >
      {items.map((it) => (
        <span key={it.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 5px', fontSize: 11.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: it.color }}>
          {it.icon}{it.n}
        </span>
      ))}
    </span>
  );
}
