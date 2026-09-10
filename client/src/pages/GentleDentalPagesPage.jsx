import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { lpb } from '../lib/lpbApi';

// Matches server/locationPageBuilder/seed.js GD_CLIENT_ID.
const GD_CLIENT_ID = 'client_gentle_dental';

// This dashboard exists because generated Gentle Dental pages are ALWAYS
// saved (one per location+service, upserted in place — see dentalWizard.js),
// but without this list there was no way to see that: they're excluded from
// the Neuro Pages dashboard (which can't render this module's page shape),
// so navigating away from the wizard made it look like nothing was saved.
export default function GentleDentalPagesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  async function load() {
    setLoading(true);
    try { setRows(await lpb.wizardPages(GD_CLIENT_ID)); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  // Pages are kept forever unless explicitly deleted; this is the only way to
  // delete one. The server also drops the page's approved-keyword record, so
  // a delete leaves nothing orphaned behind it.
  async function remove(row) {
    const label = [row.service_name, row.location_name].filter(Boolean).join(' — ') || row.url_path || row.id;
    if (!window.confirm(`Permanently delete "${label}"? Its generated content and approved keywords cannot be recovered.`)) return;
    setDeletingId(row.id);
    setError('');
    try {
      await lpb.deletePage(row.id);
      await load();
    } catch (e) { setError(e.message); }
    setDeletingId(null);
  }

  const filtered = rows.filter(r =>
    !filter || [r.service_name, r.location_name, r.primary_keyword, r.url_path].join(' ').toLowerCase().includes(filter.toLowerCase()));

  const btnStyle = { padding: '0.5rem 0.75rem', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', cursor: 'pointer' };

  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)' }}>Gentle Dental Pages</h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>Every generated Location × Service page — one per combination, always saved.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={btnStyle} onClick={() => navigate('/')}>← All Tools</button>
          <button style={{ ...btnStyle, fontWeight: 600, color: '#fff', background: 'var(--primary)', border: 'none' }} onClick={() => navigate('/location-page-builder/wizard')}>+ New Page</button>
        </div>
      </div>

      {/* This page is the module's front door, and the module now runs three
          separate flows. Without this strip the other two are reachable only by
          typing their URL — which is how the Neuro dashboard came to look like
          it had been removed. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>Clients</span>
        <span style={{ ...btnStyle, fontWeight: 600, color: 'var(--primary)', background: 'var(--primary-soft)', border: 'none', cursor: 'default' }}>Gentle Dental</span>
        <button style={btnStyle} onClick={() => navigate('/location-page-builder/clear-behavioral-health')}>Clear Behavioral Health</button>
        <button style={btnStyle} onClick={() => navigate('/location-page-builder/neuro')}>Neuro Wellness Spa</button>
      </div>

      {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.75rem' }}>{error}</p>}

      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Filter by service, location, keyword, URL…"
        style={{ width: '100%', marginBottom: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box' }}
      />

      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', fontSize: '0.75rem', color: 'var(--text-2)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Service</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Location</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Primary Keyword</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Updated</th>
              <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)' }}>Loading…</td></tr>
            )}
            {!loading && !filtered.length && (
              <tr><td colSpan={5} style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)' }}>No pages yet. Generate one from the wizard.</td></tr>
            )}
            {filtered.map(r => (
              <tr
                key={r.id}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}
                onClick={() => navigate(`/location-page-builder/wizard?pageId=${r.id}`)}
              >
                <td style={{ padding: '0.75rem 1rem', fontWeight: 500, color: 'var(--text)' }}>{r.service_name}</td>
                <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)' }}>{r.location_name}</td>
                <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{r.primary_keyword || '—'}</td>
                <td style={{ padding: '0.75rem 1rem', color: 'var(--text-3)', fontSize: '0.75rem' }}>{new Date(r.updated_at).toLocaleString()}</td>
                <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                  <button
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', fontWeight: 500, color: 'var(--danger,#EF4444)', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', cursor: 'pointer' }}
                    disabled={deletingId === r.id}
                    // The row itself opens the page — don't do both.
                    onClick={e => { e.stopPropagation(); remove(r); }}
                  >
                    {deletingId === r.id ? 'Deleting…' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
