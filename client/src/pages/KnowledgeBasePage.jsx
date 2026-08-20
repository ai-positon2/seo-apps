import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import KBStatusBadge from '../components/KBStatusBadge';
import ModuleRuns from '../components/ModuleRuns';

const CATEGORIES = ['all', 'industry', 'brand', 'client-feedback', 'best-practices'];
const CATEGORY_LABELS = {
  all: 'All',
  industry: 'Industry',
  brand: 'Brand',
  'client-feedback': 'Client Feedback',
  'best-practices': 'Best Practices',
};

const CLIENTS = [
  { value: '', label: 'All clients' },
  { value: 'gentle-dental', label: 'Gentle Dental' },
  { value: 'great-lakes', label: 'Great Lakes' },
  { value: 'riccobene', label: 'Riccobene' },
  { value: 'clear-behavioral-health', label: 'Clear Behavioral Health' },
  { value: 'neuro-wellness-spa', label: 'Neuro Wellness Spa' },
  { value: 'new-life-house', label: 'New Life House' },
  { value: 'global', label: 'Global' },
];

function PageHeader({ navigate }) {
  return (
    <header style={{
      background: 'var(--card)',
      borderBottom: '1px solid var(--border)',
      height: '3.5rem',
      display: 'flex',
      alignItems: 'center',
      padding: '0 1.5rem',
    }}>
      <div style={{ maxWidth: '80rem', margin: '0 auto', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => navigate('/')}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              color: 'var(--text-2)', background: 'none', border: 'none',
              fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
          >
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            All tools
          </button>
          <span style={{ color: 'var(--border)' }}>/</span>
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>Knowledge Base</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            onClick={() => navigate('/kb/audit')}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 600,
              border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
              color: 'var(--text-2)', background: 'var(--card)', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text-3)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            Audit
          </button>
          <button
            onClick={() => navigate('/kb/feedback/new')}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 600,
              border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
              color: 'var(--text-2)', background: 'var(--card)', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text-3)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            + Client Feedback
          </button>
          <button
            onClick={() => navigate('/kb/new')}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.375rem',
              padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 600,
              borderRadius: 'var(--r-lg)', color: '#fff',
              background: 'var(--primary)', border: 'none', cursor: 'pointer',
            }}
          >
            + New KB
          </button>
        </div>
      </div>
    </header>
  );
}

export default function KnowledgeBasePage() {
  const navigate = useNavigate();
  const [kbs, setKbs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | inactive

  useEffect(() => {
    fetch('/api/kb', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setKbs(d.knowledge_bases || []); setLoading(false); })
      .catch(() => { setError('Failed to load knowledge bases.'); setLoading(false); });
  }, []);

  const filtered = kbs.filter(kb => {
    if (activeCategory !== 'all' && kb.category !== activeCategory) return false;
    if (clientFilter && kb.client !== clientFilter) return false;
    if (statusFilter === 'active' && !kb.active) return false;
    if (statusFilter === 'inactive' && kb.active) return false;
    return true;
  });

  const grouped = CATEGORIES.slice(1).reduce((acc, cat) => {
    acc[cat] = filtered.filter(kb => kb.category === cat);
    return acc;
  }, {});

  const selectStyle = {
    fontSize: '0.75rem',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-lg)',
    padding: '0.375rem 0.75rem',
    background: 'var(--card)',
    color: 'var(--text-2)',
    outline: 'none',
    cursor: 'pointer',
  };

  return (
    <>
      <PageHeader navigate={navigate} />
      <main style={{ maxWidth: '80rem', margin: '0 auto', padding: '1.75rem 2rem' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)' }}>Knowledge Base</h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>
            Manage client context, industry rules, and best practices injected into AI tools.
          </p>
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {/* Category tabs */}
          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                style={activeCategory === cat ? {
                  padding: '0.375rem 0.75rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 500,
                  border: '1px solid var(--primary)', background: 'var(--primary)', color: '#fff', cursor: 'pointer',
                } : {
                  padding: '0.375rem 0.75rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 500,
                  border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-2)', cursor: 'pointer',
                }}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
            <select value={clientFilter} onChange={e => setClientFilter(e.target.value)} style={selectStyle}>
              {CLIENTS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
          </div>
        </div>

        {loading && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}
        {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger)' }}>{error}</p>}

        {!loading && !error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            {(activeCategory === 'all' ? CATEGORIES.slice(1) : [activeCategory]).map(cat => {
              const items = activeCategory === 'all' ? grouped[cat] : filtered;
              if (items.length === 0) return null;
              return (
                <div key={cat}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{CATEGORY_LABELS[cat]}</h2>
                    <span style={{
                      fontSize: '0.75rem', fontWeight: 600, padding: '0.125rem 0.5rem',
                      borderRadius: '9999px', background: 'var(--border)', color: 'var(--text-2)',
                    }}>{items.length}</span>
                  </div>
                  <div style={{
                    background: 'var(--card)', borderRadius: 'var(--r-lg)',
                    border: '1px solid var(--border)', overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
                  }}>
                    <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                          {['ID', 'Client', 'Tags', 'Modules', 'Status', ''].map((h, i) => (
                            <th key={i} style={{
                              textAlign: h === '' ? undefined : 'left',
                              fontSize: '0.75rem', fontWeight: 600,
                              color: 'var(--text-2)', padding: '0.75rem 1rem',
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((kb, idx) => (
                          <tr
                            key={kb.id}
                            style={{ borderTop: idx > 0 ? '1px solid var(--surface)' : undefined }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            <td style={{ padding: '0.75rem 1rem', fontWeight: 500, color: 'var(--text)' }}>{kb.id}</td>
                            <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)' }}>{kb.client}</td>
                            <td style={{ padding: '0.75rem 1rem' }}>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                {(kb.tags || []).slice(0, 3).map(tag => (
                                  <span key={tag} style={{
                                    fontSize: '0.75rem', padding: '0.125rem 0.375rem',
                                    borderRadius: '0.25rem', background: 'var(--surface)', color: 'var(--text-2)',
                                  }}>{tag}</span>
                                ))}
                              </div>
                            </td>
                            <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)', fontSize: '0.75rem' }}>
                              {(kb.linked_modules || []).join(', ') || '—'}
                            </td>
                            <td style={{ padding: '0.75rem 1rem' }}>
                              <span style={kb.active ? {
                                fontSize: '0.75rem', fontWeight: 600, padding: '0.125rem 0.5rem',
                                borderRadius: '0.25rem', background: 'var(--success-soft, #D1FAE5)', color: 'var(--success, #065F46)',
                              } : {
                                fontSize: '0.75rem', fontWeight: 600, padding: '0.125rem 0.5rem',
                                borderRadius: '0.25rem', background: 'var(--surface)', color: 'var(--text-3)',
                              }}>
                                {kb.active ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td style={{ padding: '0.75rem 1rem' }}>
                              <button
                                onClick={() => navigate(`/kb/${kb.id}`)}
                                style={{
                                  fontSize: '0.75rem', fontWeight: 500, background: 'none',
                                  border: 'none', cursor: 'pointer', color: 'var(--primary)',
                                }}
                              >
                                Edit →
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--text-3)', fontSize: '0.875rem' }}>
                No knowledge bases match your filters.
              </div>
            )}
          </div>
        )}
        <ModuleRuns toolId="knowledge-base" title="Recent changes" />
      </main>
    </>
  );
}
