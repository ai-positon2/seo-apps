import { Badge } from '../../ui';
import { card, muted } from './promptHelpers';

/**
 * data.byTopic, rendered as one card per topic — the same grouping the
 * prompt-set review screen uses, so the two tabs describe the client's world
 * identically. A page-backed topic with measured prompts, zero mentions, and
 * a named competitor is the module's single most actionable output: the page
 * exists and the engine still recommends somebody else.
 */
export function TopicResults({ byTopic }) {
  if (!byTopic.length) return null;
  const withSignal = byTopic.filter((t) => t.measuredCount > 0);
  if (!withSignal.length) return null;

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--text)' }}>By topic</h3>
      <div style={{ ...muted, marginBottom: 12 }}>
        Which of the client&apos;s own topics the brand gets named for.
      </div>

      {withSignal.map((t) => {
        const invisible = t.targetUrl && t.namedCount === 0 && t.competitorsNamed.length > 0;
        return (
          <div key={t.topic} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{t.topic}</span>
              {t.targetUrl && (
                <a href={t.targetUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--primary-text, var(--primary))' }}>
                  page →
                </a>
              )}
              {invisible && <Badge variant="danger">page exists, not named</Badge>}
              <span style={{ ...muted, marginLeft: 'auto' }}>
                {t.namedCount}/{t.measuredCount} named
              </span>
            </div>
            {t.competitorsNamed.length > 0 && (
              <div style={{ ...muted, marginTop: 3 }}>
                Named instead: {t.competitorsNamed.join(', ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default TopicResults;
