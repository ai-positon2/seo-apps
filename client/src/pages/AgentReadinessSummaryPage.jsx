import { useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';

/* ── SVG icon helpers ── */
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="7" fill="var(--success)" />
    <path d="M4 7l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconX = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="7" fill="var(--danger)" />
    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconWarning = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M7 1L13 13H1L7 1z" fill="var(--warning)" />
    <path d="M7 5.5v3M7 10v.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

/* ── Shared style constants ── */
const CARD = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: '20px 24px',
  marginBottom: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
};

const LABEL = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 5,
};

export default function AgentReadinessSummaryPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const d = searchParams.get('d');

  const data = useMemo(() => {
    if (!d) return null;
    try { return JSON.parse(atob(d)); } catch { return null; }
  }, [d]);

  if (!data) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--text-2)' }}>Invalid or missing summary data.</p>
        <button
          onClick={() => navigate('/agent-readiness-audit')}
          style={{ marginTop: 12, fontSize: 13, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          Run a new audit →
        </button>
      </div>
    </div>
  );

  const { brief, url, full, score, level, date } = data;

  const scoreColor =
    score >= 70 ? 'var(--success)' :
    score >= 40 ? 'var(--warning)' :
                  'var(--danger)';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)', fontFamily: 'system-ui, sans-serif', padding: '40px 20px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Header card */}
        <div style={CARD}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Agent Readiness Audit
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 500, margin: '0 0 4px', color: 'var(--text)' }}>{url}</h1>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{level} &nbsp;·&nbsp; Scanned {date}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 32, fontWeight: 600, color: scoreColor, lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
                {score}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>out of 100</div>
            </div>
          </div>
        </div>

        {/* Executive Summary card */}
        <div style={CARD}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconCheck /> Executive Summary
          </div>
          <p style={{ fontSize: 17, fontWeight: 500, color: 'var(--text)', margin: '0 0 10px', lineHeight: 1.4 }}>
            {brief.headline}
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 16px', lineHeight: 1.7 }}>
            {brief.summary}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            {/* Top risk */}
            <div style={{ background: 'var(--danger-soft)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ ...LABEL, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <IconX /> Top risk
              </div>
              <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0, lineHeight: 1.55 }}>{brief.risk}</p>
            </div>

            {/* 60-day opportunity */}
            <div style={{ background: 'var(--success-soft)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ ...LABEL, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <IconCheck /> 60-day opportunity
              </div>
              <p style={{ fontSize: 12, color: 'var(--success)', margin: 0, lineHeight: 1.55 }}>{brief.opportunity}</p>
            </div>

            {/* Competitive context */}
            <div style={{ background: 'var(--info-soft)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ ...LABEL, color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 5 }}>
                <IconWarning /> Competitive context
              </div>
              <p style={{ fontSize: 12, color: 'var(--info)', margin: 0, lineHeight: 1.55 }}>{brief.competitive}</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div style={{ textAlign: 'center' }}>
          <button
            onClick={() => navigate('/agent-readiness-audit')}
            style={{
              fontSize: 13,
              color: '#fff',
              background: 'var(--primary)',
              border: 'none',
              borderRadius: 8,
              padding: '10px 24px',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            View full audit →
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
            Generated by Arena · {date}
          </p>
        </div>

      </div>
    </div>
  );
}
