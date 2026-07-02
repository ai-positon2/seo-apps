export function InsightCallout({ insight }) {
  if (!insight) return null;
  if (insight.error) {
    return (
      <div style={{
        background: 'var(--danger-soft)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--r-lg)',
        padding: '12px 16px',
        marginBottom: 16,
        fontSize: 12,
        color: 'var(--danger)',
      }}>
        Insight generation failed: {insight.error}
      </div>
    );
  }

  const { observation = [], recommendation = [] } = insight;
  if (!observation.length && !recommendation.length) return null;

  return (
    <div style={{
      background: 'var(--info-soft)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '14px 18px',
      marginBottom: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      {observation.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--info)', marginBottom: 4 }}>
            Observation
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
            {observation.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </div>
      )}
      {recommendation.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--success)', marginBottom: 4 }}>
            Recommendation
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
            {recommendation.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {insight.generatedAt && (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          Generated {new Date(insight.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
      )}
    </div>
  );
}

export default InsightCallout;
