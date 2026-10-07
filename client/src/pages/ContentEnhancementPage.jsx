import { useMemo, useState } from 'react';
import ModuleRuns from '../components/ModuleRuns';

const CATEGORY_COLORS = {
  'Content Structure': '#2563EB',
  Authority: '#DC2626',
  Schema: '#7C3AED',
  'Entity Clarity': '#0F766E',
  Input: 'var(--text-2)',
};

const SEVERITY = {
  error: { bg: 'var(--danger-soft)', text: 'var(--danger)', label: 'High' },
  warning: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: 'Medium' },
  notice: { bg: 'var(--info-soft)', text: 'var(--info)', label: 'Low' },
  info: { bg: 'var(--surface)', text: 'var(--text-2)', label: 'Info' },
};

/* ── Spinner keyframes injected once ── */
const spinnerStyle = (
  <style>{`@keyframes _spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}._spinner{animation:_spin .8s linear infinite}`}</style>
);

function ScoreRing({ score, size = 92 }) {
  const radius = (size / 2) - 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 75 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth="7" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x={size / 2} y={(size / 2) + 2} textAnchor="middle" dominantBaseline="middle" fontSize="18" fontWeight="700" fill={color}>
        {score}
      </text>
    </svg>
  );
}

function SeverityBadge({ severity }) {
  const style = SEVERITY[severity] || SEVERITY.info;
  return (
    <span style={{
      fontSize: '0.75rem',
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: '4px',
      backgroundColor: style.bg,
      color: style.text,
    }}>
      {style.label}
    </span>
  );
}

function CategoryScore({ item }) {
  const color = CATEGORY_COLORS[item.category] || 'var(--primary)';
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>{item.category}</span>
        <span style={{ fontSize: '0.875rem', fontWeight: 700, color }}>{item.score}</span>
      </div>
      <div style={{ height: '0.5rem', borderRadius: '9999px', background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '9999px', width: `${item.score}%`, backgroundColor: color }} />
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.5rem' }}>{item.passed}/{item.total} checks passed</p>
    </div>
  );
}

function PriorityCard({ item, index }) {
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <span style={{
          width: '1.5rem',
          height: '1.5rem',
          borderRadius: '9999px',
          background: 'var(--text)',
          color: '#fff',
          fontSize: '0.75rem',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          {index + 1}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>{item.title}</h3>
            <SeverityBadge severity={item.severity || (item.priority <= 2 ? 'error' : 'warning')} />
            {item.effort && (
              <span style={{
                fontSize: '0.75rem',
                padding: '2px 8px',
                borderRadius: '4px',
                background: 'var(--surface)',
                color: 'var(--text-2)',
              }}>
                {item.effort}
              </span>
            )}
          </div>
          {(item.why_it_matters || item.current_state) && (
            <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.5rem', marginBottom: 0 }}>
              {item.why_it_matters || item.current_state}
            </p>
          )}
          {(item.how_to_fix || item.recommendation) && (
            <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.5rem', marginBottom: 0 }}>
              {item.how_to_fix || item.recommendation}
            </p>
          )}
          {item.example_copy && (
            <div style={{
              marginTop: '0.75rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '0.375rem',
              padding: '0.75rem',
            }}>
              <p style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.25rem', marginTop: 0 }}>Example</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>{item.example_copy}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ListCard({ title, items, empty = 'No items detected.' }) {
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>{title}</h3>
      {items?.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text)' }}>
              <span style={{
                width: '0.375rem',
                height: '0.375rem',
                borderRadius: '9999px',
                background: 'var(--primary)',
                marginTop: '0.5rem',
                flexShrink: 0,
              }} />
              <span>{typeof item === 'string' ? item : item.text || item.href || JSON.stringify(item)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '0.875rem', color: 'var(--text-3)', margin: 0 }}>{empty}</p>
      )}
    </div>
  );
}

function CheckRow({ check }) {
  const color = check.status === 'pass'
    ? 'var(--success)'
    : check.severity === 'error'
      ? 'var(--danger)'
      : check.severity === 'warning'
        ? 'var(--warning)'
        : 'var(--info)';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: '0.75rem',
      padding: '0.625rem 0',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-3)', width: '3rem', paddingTop: '0.125rem', flexShrink: 0 }}>{check.id}</span>
      <span style={{ width: '0.5rem', height: '0.5rem', borderRadius: '9999px', marginTop: '0.375rem', flexShrink: 0, backgroundColor: color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>{check.name}</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>{check.category}</span>
        </div>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.125rem', marginBottom: 0 }}>{check.detail}</p>
        {check.recommendation && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text)', marginTop: '0.25rem', marginBottom: 0 }}>{check.recommendation}</p>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ value }) {
  if (!value) return null;
  return (
    <pre style={{
      fontSize: '0.75rem',
      background: 'var(--nav-bg-top)',
      color: 'var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
      overflowX: 'auto',
      whiteSpace: 'pre-wrap',
      maxHeight: '20rem',
      margin: 0,
    }}>
      {value}
    </pre>
  );
}

function TableRecommendation({ table }) {
  if (!table) return null;
  const columns = table.columns || [];
  const rows = table.rows || [];
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
    }}>
      <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>{table.title || 'Recommended Table'}</h3>
        {table.why_it_helps && (
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem', marginBottom: 0 }}>{table.why_it_helps}</p>
        )}
      </div>
      {columns.length > 0 && rows.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--surface)' }}>
              <tr>
                {columns.map((col, idx) => (
                  <th key={idx} style={{
                    padding: '0.5rem 0.75rem',
                    textAlign: 'left',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: 'var(--text-2)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', verticalAlign: 'top' }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ padding: '1rem', fontSize: '0.875rem', color: 'var(--text-3)', margin: 0 }}>No table rows returned.</p>
      )}
    </div>
  );
}

function FaqRecommendation({ faq }) {
  if (!faq?.questions?.length) return null;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem', marginTop: 0 }}>Recommended FAQ Block</h3>
      {faq.why_it_helps && (
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '0.75rem', marginTop: 0 }}>{faq.why_it_helps}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {faq.questions.map((item, idx) => (
          <div key={idx} style={{ background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '0.75rem' }}>
            <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{item.question}</p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.25rem', marginBottom: 0 }}>{item.answer}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TextBlock({ title, value }) {
  if (!value) return null;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.5rem', marginTop: 0 }}>{title}</h3>
      <p style={{ fontSize: '0.875rem', color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>{value}</p>
    </div>
  );
}

function CitationTargets({ items }) {
  if (!items?.length) return <ListCard title="Citation Targets" items={['No citation targets returned.']} />;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>Citation Targets</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '0.75rem' }}>
            <a href={item.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}
              onMouseEnter={e => e.target.style.textDecoration = 'underline'}
              onMouseLeave={e => e.target.style.textDecoration = 'none'}
            >
              {item.source_title || item.source_url}
            </a>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
              {item.source_type && (
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                  {item.source_type}
                </span>
              )}
              {item.where_to_add && (
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                  {item.where_to_add}
                </span>
              )}
            </div>
            {item.claim_to_support && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.5rem', marginBottom: 0 }}>Claim: {item.claim_to_support}</p>
            )}
            {item.draft_sentence && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.5rem', whiteSpace: 'pre-wrap', marginBottom: 0 }}>{item.draft_sentence}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatisticsRecommendations({ items }) {
  if (!items?.length) return <ListCard title="Statistics to Add" items={['No statistics recommendations returned.']} />;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>Statistics to Add</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '0.75rem' }}>
            <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', margin: 0 }}>{item.claim_or_stat_needed || item}</p>
            {item.recommended_source_url ? (
              <a href={item.recommended_source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: 'var(--primary)', textDecoration: 'none' }}
                onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                onMouseLeave={e => e.target.style.textDecoration = 'none'}
              >
                {item.recommended_source_title || item.recommended_source_url}
              </a>
            ) : item.recommended_source_type ? (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.25rem', marginBottom: 0 }}>Source: {item.recommended_source_type}</p>
            ) : null}
            {item.where_to_place && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.25rem', marginBottom: 0 }}>Placement: {item.where_to_place}</p>
            )}
            {item.sample_sentence_template && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.5rem', whiteSpace: 'pre-wrap', marginBottom: 0 }}>{item.sample_sentence_template}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CsqafRecommendations({ items }) {
  if (!items?.length) return <ListCard title="CSQAF Recommendations" items={[]} empty="No CSQAF recommendations returned." />;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '1rem',
    }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>CSQAF Recommendations</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((item, idx) => (
          <div key={idx} style={{ background: 'var(--surface)', borderRadius: 'var(--r-lg)', padding: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>{item.element || `Fix ${idx + 1}`}</span>
              {item.placement && (
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
                  {item.placement}
                </span>
              )}
            </div>
            {item.specific_action && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.5rem', marginBottom: 0 }}>{item.specific_action}</p>
            )}
            {item.draft_copy && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text)', marginTop: '0.5rem', whiteSpace: 'pre-wrap', marginBottom: 0 }}>{item.draft_copy}</p>
            )}
            {item.source_url && (
              <a href={item.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem', color: 'var(--primary)', textDecoration: 'none', marginTop: '0.5rem', display: 'inline-block' }}
                onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                onMouseLeave={e => e.target.style.textDecoration = 'none'}
              >
                {item.source_title || item.source_url}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Shared input style ── */
const inputStyle = {
  width: '100%',
  padding: '0.625rem 1rem',
  borderRadius: 'var(--r-lg)',
  border: '1px solid var(--border)',
  fontSize: '0.875rem',
  color: 'var(--text)',
  background: 'var(--card)',
  outline: 'none',
  boxSizing: 'border-box',
};

export default function ContentEnhancementPage() {
  const [inputMode, setInputMode] = useState('html');
  const [url, setUrl] = useState('');
  const [html, setHtml] = useState('');
  const [primaryKeyword, setPrimaryKeyword] = useState('');
  const [pageType, setPageType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [copied, setCopied] = useState(false);

  const canRun = inputMode === 'url' ? url.trim() : html.trim().length >= 80;

  const ai = result?.ai;
  const findings = result?.findings;
  const priorityItems = useMemo(() => {
    if (ai?.priority_recommendations?.length) return ai.priority_recommendations;
    return findings?.recommendations?.topFixes || [];
  }, [ai, findings]);

  async function runAudit() {
    if (!canRun || loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    setCopied(false);

    try {
      const response = await fetch('/api/content-enhancement/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          inputMode,
          url: url.trim() || undefined,
          html: inputMode === 'html' ? html : undefined,
          primaryKeyword: primaryKeyword.trim() || undefined,
          pageType: pageType.trim() || undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Analysis failed.');
      setResult(data);
      setActiveTab('summary');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function copySummary() {
    const payload = ai || findings?.recommendations || {};
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '1.75rem 2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {spinnerStyle}

      <div>
        <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Content Enhancement Recommendations</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem', marginBottom: 0 }}>
          Audit content structure, authority, citations, schema, and AI-answer readiness from a URL or pasted HTML.
        </p>
      </div>

      {/* Input panel */}
      <section style={{
        background: 'var(--card)',
        borderRadius: '0.75rem',
        border: '1px solid var(--border)',
        padding: '1.5rem',
        boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
      }}>
        {/* Mode toggle */}
        <div style={{
          display: 'flex',
          gap: '0.25rem',
          background: 'var(--surface)',
          borderRadius: '0.5rem',
          padding: '0.25rem',
          width: 'fit-content',
          marginBottom: '1.25rem',
        }}>
          {[
            ['html', 'Paste HTML'],
            ['url', 'Fetch URL'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setInputMode(id)}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: '0.375rem',
                fontSize: '0.875rem',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
                background: inputMode === id ? 'var(--card)' : 'transparent',
                color: inputMode === id ? 'var(--text)' : 'var(--text-2)',
                boxShadow: inputMode === id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Grid: main input + sidebar */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
          <div style={{ gridColumn: '1 / 3' }}>
            {inputMode === 'url' ? (
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Page URL</label>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://example.com/resources/article"
                  style={inputStyle}
                />
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>HTML Source</label>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>{html.length.toLocaleString()} chars</span>
                </div>
                <textarea
                  value={html}
                  onChange={e => setHtml(e.target.value)}
                  placeholder="Paste the page HTML here. Use this for sites that block scraping or bots."
                  rows={10}
                  style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
                />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Primary Keyword</label>
              <input
                value={primaryKeyword}
                onChange={e => setPrimaryKeyword(e.target.value)}
                placeholder="e.g. hypodontia"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Page Type</label>
              <input
                value={pageType}
                onChange={e => setPageType(e.target.value)}
                placeholder="article, service, location"
                style={inputStyle}
              />
            </div>
            {inputMode === 'html' && url.trim() && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', margin: 0 }}>
                The URL will be used only for canonical/internal-link context. The pasted HTML is the source of truth.
              </p>
            )}
            {inputMode === 'html' && (
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Optional Page URL</label>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://example.com/page"
                  style={inputStyle}
                />
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={runAudit}
            disabled={!canRun || loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1.5rem',
              borderRadius: 'var(--r-lg)',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#fff',
              background: 'var(--primary)',
              border: 'none',
              cursor: !canRun || loading ? 'not-allowed' : 'pointer',
              opacity: !canRun || loading ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {loading && (
              <svg className="_spinner" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {loading ? 'Analyzing...' : 'Generate Recommendations'}
          </button>
          {result && (
            <button
              onClick={copySummary}
              style={{
                padding: '0.625rem 1rem',
                borderRadius: 'var(--r-lg)',
                border: '1px solid var(--border)',
                fontSize: '0.875rem',
                fontWeight: 600,
                background: 'var(--card)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
          )}
        </div>
      </section>

      {/* Error */}
      {error && (
        <div style={{
          padding: '1rem',
          background: 'var(--danger-soft)',
          border: '1px solid var(--danger)',
          borderRadius: '0.75rem',
        }}>
          <p style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Results */}
      {findings && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Score header */}
          <div style={{
            background: 'var(--card)',
            borderRadius: '0.75rem',
            border: '1px solid var(--border)',
            padding: '1.25rem',
            boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1.25rem', flexWrap: 'wrap' }}>
                <ScoreRing score={findings.scores.overall} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                      {findings.meta.h1 || findings.meta.title || 'Analyzed Content'}
                    </h2>
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: 'var(--surface)',
                      color: 'var(--text-2)',
                    }}>
                      {findings.meta.inputType === 'html_paste' ? 'HTML paste' : 'URL fetch'}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.5rem', marginBottom: 0 }}>
                    {ai?.executive_summary?.verdict || `${findings.scores.counts.fail} improvement opportunities found across structure, authority, schema, and entity clarity.`}
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-2)' }}>
                    <span>{findings.meta.wordCount.toLocaleString()} words</span>
                    <span>{findings.signals.h2s.length} H2s</span>
                    <span>{findings.signals.authoritativeCitations.length} trusted citations</span>
                    <span>{findings.signals.schemaTypes.length || 0} schema types</span>
                  </div>
                </div>
                {ai?.executive_summary?.readiness && (
                  <div style={{
                    borderRadius: 'var(--r-lg)',
                    background: 'var(--surface)',
                    padding: '0.75rem 1rem',
                    minWidth: '150px',
                  }}>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Readiness</p>
                    <p style={{ fontSize: '1.125rem', fontWeight: 700, textTransform: 'capitalize', color: 'var(--text)', marginTop: '0.125rem', marginBottom: 0 }}>
                      {ai.executive_summary.readiness}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Category score cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.75rem' }}>
            {findings.scores.categories.map(cat => <CategoryScore key={cat.category} item={cat} />)}
          </div>

          {/* Tab bar */}
          <div style={{
            display: 'flex',
            gap: '0.25rem',
            background: 'var(--surface)',
            borderRadius: '0.5rem',
            padding: '0.25rem',
            width: 'fit-content',
            flexWrap: 'wrap',
          }}>
            {[
              ['summary', 'Recommendations'],
              ['research', 'Research'],
              ['structure', 'Structure'],
              ['authority', 'Authority'],
              ['assets', 'Copy-Ready Assets'],
              ['schema', 'Schema'],
              ['checks', 'All Checks'],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                style={{
                  padding: '0.375rem 0.75rem',
                  borderRadius: '0.375rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background 0.15s, color 0.15s',
                  background: activeTab === id ? 'var(--card)' : 'transparent',
                  color: activeTab === id ? 'var(--text)' : 'var(--text-2)',
                  boxShadow: activeTab === id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Tab: Recommendations */}
          {activeTab === 'summary' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {ai?.executive_summary?.highest_impact_fix && (
                <div style={{
                  background: 'var(--card)',
                  border: '1px solid var(--primary)',
                  borderRadius: 'var(--r-lg)',
                  padding: '1rem',
                }}>
                  <p style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem', marginTop: 0, color: 'var(--primary)' }}>
                    Highest Impact Fix
                  </p>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text)', margin: 0 }}>{ai.executive_summary.highest_impact_fix}</p>
                </div>
              )}
              {priorityItems.map((item, index) => <PriorityCard key={index} item={item} index={index} />)}
            </div>
          )}

          {/* Tab: Structure */}
          {activeTab === 'structure' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <ListCard title="Recommended Outline Changes" items={ai?.content_structure?.recommended_outline_changes || findings.recommendations.sectionIdeas} />
              <ListCard title="Answer Blocks to Add" items={ai?.content_structure?.answer_blocks_to_add || findings.recommendations.sectionIdeas} />
              <ListCard title="Detected H2s" items={findings.signals.h2s} />
              <ListCard title="FAQ Recommendations" items={ai?.content_structure?.faq_questions || findings.recommendations.faqIdeas} />
            </div>
          )}

          {/* Tab: Research */}
          {activeTab === 'research' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <ListCard title="Competitor Patterns" items={ai?.research_summary?.competitor_patterns || []} empty="No competitor patterns returned." />
              <ListCard title="Content Gaps to Exploit" items={ai?.research_summary?.content_gaps || []} empty="No content gaps returned." />
              <div style={{ gridColumn: '1 / -1', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>Top Ranking Sources Used</h3>
                {ai?.research_summary?.source_urls?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {ai.research_summary.source_urls.map((source, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', fontSize: '0.875rem' }}>
                        <span style={{
                          width: '1.5rem',
                          height: '1.5rem',
                          borderRadius: '9999px',
                          background: 'var(--primary)',
                          color: '#fff',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>{idx + 1}</span>
                        <div>
                          <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}
                            onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                            onMouseLeave={e => e.target.style.textDecoration = 'none'}
                          >
                            {source.title || source.url}
                          </a>
                          {source.use_for && (
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.125rem', marginBottom: 0 }}>{source.use_for}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-3)', margin: 0 }}>No researched source list returned.</p>
                )}
              </div>
              {result.researchError && (
                <div style={{ gridColumn: '1 / -1', padding: '1rem', background: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 'var(--r-lg)' }}>
                  <p style={{ fontSize: '0.875rem', color: 'var(--warning)', margin: 0 }}>Research warning: {result.researchError}</p>
                </div>
              )}
            </div>
          )}

          {/* Tab: Authority */}
          {activeTab === 'authority' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <ListCard title="Expert Signal Recommendations" items={ai?.authority?.expert_signal_recommendations || findings.recommendations.authorityIdeas} />
              <CitationTargets items={ai?.authority?.citation_targets} />
              <StatisticsRecommendations items={ai?.authority?.statistics_to_add} />
              <ListCard title="Detected Trusted Citations" items={findings.signals.authoritativeCitations.map(c => `${c.host} - ${c.text || c.href}`)} />
              <CsqafRecommendations items={ai?.csqaf?.recommendations} />
              <TextBlock title="Expert Quote Integration" value={ai?.authority?.expert_quote_integration ? `${ai.authority.expert_quote_integration.credential_to_request}\n\nPlacement: ${ai.authority.expert_quote_integration.placement}\n\nPrompt: ${ai.authority.expert_quote_integration.sample_quote_prompt}\n\nFormat: ${ai.authority.expert_quote_integration.sample_quote_format}` : ''} />
              <TextBlock title="Author Bio & Byline Optimization" value={ai?.authority?.author_bio_byline ? `${ai.authority.author_bio_byline.recommendation}\n\nByline: ${ai.authority.author_bio_byline.sample_byline}\n\nBio: ${ai.authority.author_bio_byline.sample_bio}` : ''} />
            </div>
          )}

          {/* Tab: Copy-Ready Assets */}
          {activeTab === 'assets' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <TextBlock title="Direct Answer Block" value={ai?.direct_answer_formatting?.recommended_block} />
              <FaqRecommendation faq={ai?.faq_block} />
              {(ai?.html_comparison_tables || []).map((table, idx) => <TableRecommendation key={idx} table={table} />)}
              {!ai?.direct_answer_formatting?.recommended_block && !ai?.faq_block?.questions?.length && !ai?.html_comparison_tables?.length && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1rem' }}>
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-3)', margin: 0 }}>No copy-ready assets returned.</p>
                </div>
              )}
            </div>
          )}

          {/* Tab: Schema */}
          {activeTab === 'schema' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <ListCard title="Detected Schema Types" items={findings.signals.schemaTypes} empty="No JSON-LD schema types detected." />
              <ListCard title="Schema Recommendations" items={ai?.schema?.missing_or_improved_schema || ['Article or MedicalWebPage schema with author, reviewedBy, datePublished, dateModified, and citation fields.']} />
              <div style={{ gridColumn: '1 / -1', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1rem' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem', marginTop: 0 }}>Starter JSON-LD</h3>
                <CodeBlock value={ai?.schema?.starter_json_ld} />
                {!ai?.schema?.starter_json_ld && (
                  <p style={{ fontSize: '0.875rem', color: 'var(--text-3)', margin: 0 }}>No starter schema returned.</p>
                )}
              </div>
            </div>
          )}

          {/* Tab: All Checks */}
          {activeTab === 'checks' && (
            <div style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '0.75rem',
              padding: '0 1rem',
              boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
            }}>
              {findings.checks.map(check => <CheckRow key={check.id} check={check} />)}
            </div>
          )}
        </section>
      )}
      <ModuleRuns toolId="content-enhancement" />
    </main>
  );
}
