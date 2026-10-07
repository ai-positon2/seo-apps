import { Panel, PanelTitle, Eyebrow, Chip } from './reportKit';

// ── GEO & Content ───────────────────────────────────────────────────────────
//
// Schema analysis and the model's content recommendations. Two blocks, where
// this panel used to have four: platform readiness and the top GEO fix have
// moved up to the Summary view, which is where the design puts them and where
// they belong — "will AI engines show this page" is the answer, not a detail.

const CONTENT_FIELDS = [
  ['Rewrite priority', 'rewrite_priority'],
  ['Direct answer rewrite', 'direct_answer_rewrite'],
  // Informational-intent only; the prompt omits them for commercial pages.
  ['Statistics to add', 'statistics_to_add'],
  ['Expert quote guidance', 'expert_quote_guidance'],
  // Commercial-intent only.
  ['Entity completeness actions', 'entity_completeness_actions'],
  ['Word count verdict', 'word_count_verdict'],
];

export default function GeoPanel({ findings, ai }) {
  const schema = ai?.schema_analysis || null;
  const detected = schema?.detected || [];
  // `relevant: false` is the model saying "this schema type exists but does not
  // apply to this page" — showing it as a recommendation would be noise.
  const recommended = (schema?.recommended || []).filter((r) => r.relevant !== false);
  const recs = ai?.content_recommendations || null;
  const onPageSchemas = findings?.detectedSchemas || [];

  if (!ai) {
    return (
      <Panel style={{ borderColor: 'var(--viz-warn)' }}>
        <Eyebrow style={{ color: 'var(--viz-warn)' }}>AI analysis unavailable</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          This panel is entirely the model’s reading of the page’s markup and content, and that
          analysis did not complete. Every rule-based check still ran — they are under “Issues”.
        </span>
      </Panel>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {(detected.length > 0 || recommended.length > 0 || onPageSchemas.length > 0) && (
        <Panel pad="22px 24px" style={{ gap: 12 }}>
          <PanelTitle>Schema analysis</PanelTitle>

          {detected.length > 0 && (
            <>
              <Eyebrow>Detected</Eyebrow>
              {detected.map((s, i) => {
                const missing = Array.isArray(s.missing_fields)
                  ? s.missing_fields.join(', ')
                  : s.missing_fields || '';
                // A detected schema with required fields missing is not a pass,
                // and the border says which it is before the chip is read.
                const bad = Boolean(missing);
                return (
                  <div
                    key={`${s.type || i}`}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px',
                      borderRadius: 8, background: 'var(--surface)',
                      border: `1px solid ${bad ? 'color-mix(in srgb, var(--viz-warn) 45%, var(--border))' : 'var(--border)'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                        {s.type || 'Unnamed type'}
                      </span>
                      <Chip
                        bg={bad
                          ? 'color-mix(in srgb, var(--viz-warn) 20%, transparent)'
                          : 'color-mix(in srgb, var(--primary) 20%, transparent)'}
                        fg={bad ? 'var(--viz-warn)' : 'var(--primary-text)'}
                      >
                        {s.status || (bad ? 'Incomplete' : 'Valid')}
                      </Chip>
                    </div>
                    {missing && (
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        Missing fields: {missing}
                      </span>
                    )}
                    {s.note && (
                      <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>{s.note}</span>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* What the crawler itself found in the markup, when the model listed
              nothing. Two different sources for one question, and saying "no
              schema" because the model was silent would be wrong. */}
          {detected.length === 0 && onPageSchemas.length > 0 && (
            <>
              <Eyebrow>Detected in the markup</Eyebrow>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {onPageSchemas.map((t) => <Chip key={t}>{t}</Chip>)}
              </div>
            </>
          )}

          {recommended.length > 0 && (
            <>
              <Eyebrow style={{ marginTop: 6 }}>Recommended / missing</Eyebrow>
              {recommended.map((r, i) => (
                <div
                  key={`${r.type || i}`}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px',
                    borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {r.type || 'Unnamed type'}
                    </span>
                    {r.priority && (
                      <span
                        style={{
                          fontSize: 11.5, fontWeight: 600,
                          color: /high/i.test(r.priority) ? 'var(--viz-neg)'
                            : /med/i.test(r.priority) ? 'var(--viz-warn)' : 'var(--text-3)',
                        }}
                      >
                        {r.priority}
                      </span>
                    )}
                  </div>
                  {r.reason && (
                    <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>{r.reason}</span>
                  )}
                </div>
              ))}
            </>
          )}
        </Panel>
      )}

      {recs && (
        <Panel pad="22px 24px" style={{ gap: 10 }}>
          <PanelTitle>Content recommendations</PanelTitle>
          {CONTENT_FIELDS.filter(([, key]) => recs[key]).map(([label, key]) => (
            <div key={key} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <Eyebrow>{label}</Eyebrow>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {asText(recs[key])}
              </p>
            </div>
          ))}
          {recs.faq_recommendation && (
            <div style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <Eyebrow>FAQ recommendations</Eyebrow>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {asText(recs.faq_recommendation)}
              </p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function asText(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (v && typeof v === 'object') return Object.values(v).join('\n');
  return v ?? '';
}
