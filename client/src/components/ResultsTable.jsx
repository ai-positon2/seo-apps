import { memo } from 'react';

function ResultsTable({ keyword, analysis }) {
  const { sections, wordCountBenchmark, semanticKeywords, contentGaps } = analysis;

  return (
    <div id="results-table">
      {/* Title Banner */}
      <div style={{
        background: 'linear-gradient(90deg, var(--nav-bg-top) 0%, var(--nav-bg-bot) 100%)',
        color: '#fff',
        fontWeight: 600,
        textAlign: 'center',
        padding: '10px 20px',
        fontSize: 13,
        letterSpacing: '0.06em',
        borderRadius: 'var(--r-lg) var(--r-lg) 0 0',
      }}>
        CONTENT ANALYSIS REPORT: {keyword.toUpperCase()} &nbsp;(Based on Competitor Research)
      </div>

      {/* Main Table */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--r-lg) var(--r-lg)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '20%' }} />
            <col style={{ width: '30%' }} />
            <col style={{ width: '50%' }} />
          </colgroup>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              {['Section', 'Recommendations', 'Content'].map(col => (
                <th
                  key={col}
                  style={{
                    textAlign: 'left',
                    fontWeight: 600,
                    padding: '10px 16px',
                    fontSize: 12,
                    color: 'var(--text-2)',
                    borderBottom: '1px solid var(--border)',
                    borderRight: '1px solid var(--border)',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sections.map((section, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ verticalAlign: 'top', background: 'var(--card)', borderRight: '1px solid var(--border)', padding: 16, fontSize: 13 }}>
                  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 4 }}>Section {i + 1}</div>
                  <div style={{ fontWeight: 600, color: 'var(--text)' }}>H2: {section.h2}</div>
                </td>

                <td style={{ verticalAlign: 'top', background: 'var(--card)', borderRight: '1px solid var(--border)', padding: 16, fontSize: 13 }}>
                  {Array.isArray(section.recommendations) && section.recommendations.length > 0 ? (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {section.recommendations.map((point, j) => (
                        <li key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--text)' }}>
                          <span style={{ marginTop: 6, flexShrink: 0, width: 5, height: 5, borderRadius: '50%', backgroundColor: 'var(--primary)', display: 'inline-block' }} />
                          <span style={{ lineHeight: 1.45 }}>{point}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>—</span>
                  )}
                </td>

                <td style={{ verticalAlign: 'top', background: 'var(--surface)', padding: 16 }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Metadata Cards */}
      <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        {/* Word Count */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 10, marginTop: 0 }}>Word Count Benchmark</h3>
          <p style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-mono)', margin: 0 }}>
            {wordCountBenchmark?.toLocaleString() || '—'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>words — competitor page average</p>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
            Aim for at least this many words to stay competitive in this SERP.
          </p>
        </div>

        {/* Semantic Keywords */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 10, marginTop: 0 }}>
            Semantic Keywords <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({semanticKeywords?.length || 0})</span>
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(semanticKeywords || []).map((kw, i) => (
              <span key={i} style={{
                display: 'inline-block',
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 'var(--r-pill)',
                background: 'var(--primary-soft)',
                color: 'var(--primary-text)',
                fontWeight: 500,
              }}>
                {kw}
              </span>
            ))}
            {(!semanticKeywords || semanticKeywords.length === 0) && (
              <span style={{ color: 'var(--text-3)', fontSize: 13, fontStyle: 'italic' }}>None identified</span>
            )}
          </div>
        </div>

        {/* Content Gaps */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 20 }}>
          <h3 style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 10, marginTop: 0 }}>
            Content Gaps <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({contentGaps?.length || 0})</span>
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(contentGaps || []).map((gap, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ color: 'var(--warning)', flexShrink: 0 }}>▸</span>
                <span style={{ fontSize: 13, color: 'var(--text)' }}>{gap}</span>
              </li>
            ))}
            {(!contentGaps || contentGaps.length === 0) && (
              <li style={{ color: 'var(--text-3)', fontSize: 13, fontStyle: 'italic' }}>None identified</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default memo(ResultsTable);
