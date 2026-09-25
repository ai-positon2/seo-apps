import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';
import { useTheme } from '../components/ThemeContext';

const CLIENTS = [
  { value: 'gentle-dental', label: 'Gentle Dental' },
  { value: 'great-lakes', label: 'Great Lakes' },
  { value: 'riccobene', label: 'Riccobene' },
  { value: 'clear-behavioral-health', label: 'Clear Behavioral Health' },
  { value: 'neuro-wellness-spa', label: 'Neuro Wellness Spa' },
  { value: 'new-life-house', label: 'New Life House' },
];

function currentQuarter() {
  const d = new Date();
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `${d.getFullYear()}-q${q}`;
}

const PERIODS = (() => {
  const p = [];
  const now = new Date();
  for (let y = now.getFullYear(); y >= now.getFullYear() - 1; y--) {
    for (let q = 4; q >= 1; q--) {
      if (y === now.getFullYear() && q > Math.ceil((now.getMonth() + 1) / 3)) continue;
      p.push(`${y}-q${q}`);
    }
  }
  return p;
})();

const selectStyle = {
  width: '100%',
  padding: '0.625rem 1rem',
  borderRadius: 'var(--r-md, 8px)',
  border: '1px solid var(--border)',
  fontSize: '0.875rem',
  color: 'var(--text)',
  background: 'var(--card)',
  outline: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
};

export default function ClientFeedbackPage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [client, setClient] = useState('gentle-dental');
  const [period, setPeriod] = useState(currentQuarter());
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [clientFocused, setClientFocused] = useState(false);
  const [periodFocused, setPeriodFocused] = useState(false);

  async function handleCreate() {
    if (!body.trim()) { setError('Please add some feedback content.'); return; }
    setSaving(true); setError('');
    const id = `${client}-feedback-${period}`;
    try {
      const res = await fetch('/api/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id,
          category: 'client-feedback',
          client,
          industry: 'global',
          period,
          tags: [client, 'client-feedback', period],
          linked_modules: ['content-research', 'keyword-research'],
          priority: 2,
          body,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate(`/kb/${data.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)', margin: 0 }}>New Client Feedback Entry</h1>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>Log notes from a client call, email, or review. Each entry is versioned and never overwritten.</p>
      </div>

      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
      }}>
        {error && (
          <div style={{
            padding: '0.75rem',
            background: 'var(--danger-soft, #FEF2F2)',
            border: '1px solid var(--danger-border, #FECACA)',
            borderRadius: 'var(--r-md, 8px)',
            fontSize: '0.875rem',
            color: 'var(--danger)',
          }}>{error}</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Client</label>
            <select
              value={client}
              onChange={e => setClient(e.target.value)}
              onFocus={() => setClientFocused(true)}
              onBlur={() => setClientFocused(false)}
              style={{
                ...selectStyle,
                boxShadow: clientFocused ? '0 0 0 2px var(--primary)' : 'none',
                borderColor: clientFocused ? 'var(--primary)' : 'var(--border)',
              }}
            >
              {CLIENTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>Period</label>
            <select
              value={period}
              onChange={e => setPeriod(e.target.value)}
              onFocus={() => setPeriodFocused(true)}
              onBlur={() => setPeriodFocused(false)}
              style={{
                ...selectStyle,
                boxShadow: periodFocused ? '0 0 0 2px var(--primary)' : 'none',
                borderColor: periodFocused ? 'var(--primary)' : 'var(--border)',
              }}
            >
              {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div style={{
          padding: '0.75rem',
          background: 'var(--surface)',
          borderRadius: 'var(--r-md, 8px)',
        }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>This will be saved as KB ID:</div>
          <div style={{ fontSize: '0.875rem', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)', marginTop: '0.125rem' }}>{client}-feedback-{period}</div>
        </div>

        <div data-color-mode={theme}>
          <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.375rem' }}>
            Feedback Notes <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(Markdown)</span>
          </label>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: '0.5rem', marginTop: 0 }}>Include: dated notes, approval preferences, rejected wording, format preferences, open questions.</p>
          <MDEditor value={body} onChange={val => setBody(val || '')} height={350} preview="edit" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', paddingTop: '0.5rem' }}>
          <button
            onClick={() => navigate('/kb')}
            style={{
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md, 8px)',
              color: 'var(--text-2)',
              background: 'var(--card)',
              cursor: 'pointer',
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !body.trim()}
            style={{
              padding: '0.625rem 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              borderRadius: 'var(--r-md, 8px)',
              color: '#fff',
              background: 'var(--primary)',
              border: 'none',
              cursor: saving || !body.trim() ? 'not-allowed' : 'pointer',
              opacity: saving || !body.trim() ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {saving ? 'Creating…' : 'Save Feedback Entry'}
          </button>
        </div>
      </div>
    </main>
  );
}
