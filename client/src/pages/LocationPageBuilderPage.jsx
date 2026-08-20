import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { lpb } from '../lib/lpbApi';
import ModuleRuns from '../components/ModuleRuns';

// This page's Pages dashboard + LocationPageDetailPage are built around
// Neuro's page_object shape and approval workflow — NOT generic across
// clients. Gentle Dental has its own dedicated flow (LocationServiceWizardPage)
// with a different section contract. NewPageWizard below is the shared entry
// point: it lets the user pick EITHER client, but branches at the last step —
// Neuro goes through the existing eligibility+createPage pipeline, Gentle
// Dental hands off to the dedicated wizard (with service/location pre-filled)
// instead of trying to run it through Neuro's pipeline.
const NEURO_CLIENT_ID = 'client_neuro_wellness_spa';
const GD_CLIENT_ID = 'client_gentle_dental';
const CLIENT_OPTIONS = [
  { id: NEURO_CLIENT_ID, label: 'Neuro Wellness Spa' },
  { id: GD_CLIENT_ID, label: 'Gentle Dental of New England' },
];

const STAGE_COLORS = {
  'Draft':                { bg: 'var(--surface)',       text: 'var(--text-3)' },
  'Keywords In Progress': { bg: 'var(--warning-soft)',  text: 'var(--warning)' },
  'Keywords Finalized':   { bg: 'var(--info-soft)',     text: 'var(--info)' },
  'Content Generated':    { bg: 'var(--primary-soft)',  text: 'var(--primary-text)' },
  'SEO Review':           { bg: 'var(--warning-soft)',  text: 'var(--warning)' },
  'SEO Approved':         { bg: 'var(--success-soft)',  text: 'var(--success)' },
  'Clinical Review':      { bg: 'var(--warning-soft)',  text: 'var(--warning)' },
  'Clinical Approved':    { bg: 'var(--success-soft)',  text: 'var(--success)' },
  'Content Review':       { bg: 'var(--warning-soft)',  text: 'var(--warning)' },
  'Content Approved':     { bg: 'var(--success-soft)',  text: 'var(--success)' },
  'Client Review':        { bg: 'var(--warning-soft)',  text: 'var(--warning)' },
  'Client Approved':      { bg: 'var(--success-soft)',  text: 'var(--success)' },
  'Exported':             { bg: 'var(--success-soft)',  text: 'var(--success)' },
};

function StatusPill({ status }) {
  const c = STAGE_COLORS[status] || { bg: 'var(--surface)', text: 'var(--text-3)' };
  return (
    <span style={{
      fontSize: '0.75rem',
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: '9999px',
      backgroundColor: c.bg,
      color: c.text,
      display: 'inline-block',
    }}>
      {status}
    </span>
  );
}

function NewPageWizard({ onClose, onCreated, onStartDentalWizard }) {
  const [clientId, setClientId] = useState(NEURO_CLIENT_ID);
  const [data, setData] = useState(null);
  const [serviceId, setServiceId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isDental = clientId === GD_CLIENT_ID;

  useEffect(() => {
    setData(null); setServiceId(''); setLocationId(''); setResult(null); setError('');
    lpb.clients().then(async (clients) => {
      if (!clients.some(c => c.id === clientId)) {
        setError(isDental
          ? 'Gentle Dental reference data not found. Seed it from the Gentle Dental Wizard first.'
          : 'Neuro Wellness Spa not found. Click "Seed Neuro Wellness Spa" first.');
        return;
      }
      const full = await lpb.client(clientId);
      setData(full);
    }).catch(e => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function check() {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await lpb.createPage({ clientId: data.client.id, serviceId, locationId });
      setResult(r);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const overlayStyle = {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50, padding: '1rem',
  };
  const modalStyle = {
    background: 'var(--card)',
    borderRadius: 'var(--r-lg)',
    border: '1px solid var(--border)',
    width: '100%', maxWidth: '32rem',
    padding: '1.5rem',
  };
  const labelStyle = { display: 'block', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-2)', marginBottom: '0.25rem' };
  const selectStyle = { width: '100%', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>New Page</h2>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1rem' }}>
          {isDental ? 'Select a Client · Service · Location, then start the Gentle Dental wizard.' : 'Select a Client · Service · Location. Eligibility is GBP-backed (§15.1).'}
        </p>
        <div style={{ marginBottom: '0.75rem' }}>
          <label style={labelStyle}>Client</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {CLIENT_OPTIONS.map(c => (
              <button
                key={c.id}
                onClick={() => setClientId(c.id)}
                style={{
                  flex: 1, padding: '0.5rem 0.625rem', fontSize: '0.8125rem', fontWeight: 600, borderRadius: 'var(--r-md,6px)', cursor: 'pointer',
                  border: `2px solid ${clientId === c.id ? 'var(--primary)' : 'var(--border)'}`,
                  background: clientId === c.id ? 'var(--primary-soft)' : 'var(--card)',
                  color: clientId === c.id ? 'var(--primary)' : 'var(--text-2)',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {!data && !error && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}
        {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.75rem' }}>{error}</p>}
        {data && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
              <label style={labelStyle}>Service</label>
              <select style={selectStyle} value={serviceId} onChange={e => { setServiceId(e.target.value); setResult(null); }}>
                <option value="">Select a service…</option>
                {data.services.map(s => <option key={s.id} value={s.id}>{s.name} ({s.category})</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Location</label>
              <select style={selectStyle} value={locationId} onChange={e => { setLocationId(e.target.value); setResult(null); }}>
                <option value="">Select a location…</option>
                {data.locations.map(l => <option key={l.id} value={l.id}>{l.location_name}{l.verified ? '' : ' (not GBP-verified)'}</option>)}
              </select>
            </div>

            {!isDental && result && (
              <div style={{
                fontSize: '0.875rem', borderRadius: 'var(--r-md,6px)', padding: '0.75rem',
                background: result.blocked ? 'var(--danger-soft,#FEF2F2)' : result.existing ? '#FFFBEB' : 'var(--success-soft,#ECFDF5)',
                color: result.blocked ? 'var(--danger,#EF4444)' : result.existing ? '#B45309' : 'var(--success,#059669)',
              }}>
                {result.blocked && <>⛔ Not eligible: {result.eligibility.reason}</>}
                {result.existing && <>⚠ A page for this tuple already exists. <button style={{ textDecoration: 'underline', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }} onClick={() => onCreated(result.page.id)}>Open it →</button></>}
                {!result.blocked && !result.existing && result.page && <>✓ Eligible — page created. <button style={{ textDecoration: 'underline', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }} onClick={() => onCreated(result.page.id)}>Open page →</button></>}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', paddingTop: '0.5rem' }}>
              <button style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={onClose}>Cancel</button>
              {isDental ? (
                <button
                  disabled={!serviceId || !locationId}
                  style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', borderRadius: 'var(--r-md,6px)', border: 'none', cursor: (!serviceId || !locationId) ? 'not-allowed' : 'pointer', opacity: (!serviceId || !locationId) ? 0.5 : 1, background: 'var(--primary)' }}
                  onClick={() => onStartDentalWizard({ serviceId, locationId })}
                >
                  Start Wizard →
                </button>
              ) : (
              <button
                disabled={!serviceId || !locationId || busy}
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', borderRadius: 'var(--r-md,6px)', border: 'none', cursor: (!serviceId || !locationId || busy) ? 'not-allowed' : 'pointer', opacity: (!serviceId || !locationId || busy) ? 0.5 : 1, background: 'var(--primary)' }}
                onClick={check}
              >
                {busy ? 'Checking…' : 'Check eligibility & create'}
              </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LocationPageBuilderPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wizard, setWizard] = useState(false);
  const [filter, setFilter] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try { setRows(await lpb.pages()); } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function seed() {
    setSeeding(true);
    try { await lpb.seed(); await load(); } catch (e) { setError(e.message); }
    setSeeding(false);
  }

  const filtered = rows.filter(r =>
    !filter || [r.service_name, r.location_name, r.status, ...(r.primary_keywords || [])].join(' ').toLowerCase().includes(filter.toLowerCase()));

  // Aging flag: not updated in 7+ days and not exported (SLA surface, §12).
  const isStale = (r) => r.status !== 'Exported' && (Date.now() - new Date(r.updated_at).getTime()) > 7 * 864e5;

  return (
    <>
      <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)' }}>Pages</h1>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>Every Location × Service page, its stage, approvals, and QA status.</p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={seed}
              disabled={seeding}
              style={{ padding: '0.5rem 0.75rem', fontSize: '0.875rem', border: '1px solid var(--border)', background: 'var(--card)', borderRadius: 'var(--r-md,6px)', color: 'var(--text-2)', cursor: seeding ? 'not-allowed' : 'pointer', opacity: seeding ? 0.5 : 1 }}
            >
              {seeding ? 'Seeding…' : 'Seed Neuro Wellness Spa'}
            </button>
            <button
              onClick={() => navigate('/location-page-builder/gentle-dental-pages')}
              style={{ padding: '0.5rem 0.75rem', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', cursor: 'pointer' }}
            >
              Gentle Dental Pages
            </button>
            <button
              onClick={() => navigate('/location-page-builder/wizard')}
              style={{ padding: '0.5rem 0.75rem', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', cursor: 'pointer' }}
            >
              Gentle Dental Wizard →
            </button>
            <button
              onClick={() => setWizard(true)}
              style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', background: 'var(--primary)', borderRadius: 'var(--r-md,6px)', border: 'none', cursor: 'pointer' }}
            >
              + New Page
            </button>
          </div>
        </div>

        {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.75rem' }}>{error}</p>}

        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by service, location, status, keyword…"
          style={{ width: '100%', marginBottom: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box' }}
        />

        <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: '0.75rem', color: 'var(--text-2)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Service</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Location</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Stage</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Primary keywords</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>QA</th>
                <th style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)' }}>Loading…</td>
                </tr>
              )}
              {!loading && !filtered.length && (
                <tr>
                  <td colSpan={6} style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)' }}>No pages yet. Seed the client, then create one.</td>
                </tr>
              )}
              {filtered.map(r => (
                <tr
                  key={r.id}
                  style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                  onClick={() => navigate(`/location-page-builder/${r.id}`)}
                >
                  <td style={{ padding: '0.75rem 1rem', fontWeight: 500, color: 'var(--text)' }}>{r.service_name}</td>
                  <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)' }}>{r.location_name}</td>
                  <td style={{ padding: '0.75rem 1rem' }}><StatusPill status={r.status} /></td>
                  <td style={{ padding: '0.75rem 1rem', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{(r.primary_keywords || []).join(', ') || '—'}</td>
                  <td style={{ padding: '0.75rem 1rem' }}>
                    {r.qa_blocking == null ? '—' : r.qa_blocking === 0
                      ? <span style={{ color: 'var(--success,#10B981)' }}>✓ clean</span>
                      : <span style={{ color: 'var(--danger,#EF4444)' }}>{r.qa_blocking} blocking</span>}
                  </td>
                  <td style={{ padding: '0.75rem 1rem', color: 'var(--text-3)', fontSize: '0.75rem' }}>
                    {isStale(r) && <span style={{ color: '#D97706', marginRight: '0.25rem' }} title="Stalled 7+ days">⏳</span>}
                    {new Date(r.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ModuleRuns toolId="location-page-builder" />
      </main>
      {wizard && (
        <NewPageWizard
          onClose={() => { setWizard(false); load(); }}
          onCreated={(id) => navigate(`/location-page-builder/${id}`)}
          onStartDentalWizard={({ serviceId, locationId }) => {
            setWizard(false);
            navigate(`/location-page-builder/wizard?serviceId=${serviceId}&locationId=${locationId}`);
          }}
        />
      )}
    </>
  );
}
