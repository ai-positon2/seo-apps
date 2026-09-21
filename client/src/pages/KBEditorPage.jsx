import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';

const BRANDS = ['global','gentle-dental','great-lakes','riccobene','clear-behavioral-health','neuro-wellness-spa','new-life-house'];
const INDUSTRY_KBS = ['global','dental-service-organizations','mental-health-organizations','b2b-tech'];
const CATEGORIES = ['industry','brand','client-feedback'];
const ALL_MODULES = ['content-research','keyword-research','article-recommendation'];

export default function KBEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [kb, setKb] = useState(null);
  const [meta, setMeta] = useState({});
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changeNote, setChangeNote] = useState('');

  useEffect(() => {
    fetch(`/api/kb/${id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setKb(d);
        setMeta(d.meta || {});
        setBody(d.body || '');
        setLoading(false);
      })
      .catch(() => { setError('Failed to load KB.'); setLoading(false); });
  }, [id]);

  async function handleSave() {
    setSaving(true); setSaved(false); setError('');
    try {
      const res = await fetch(`/api/kb/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ meta, body, changeNote: changeNote || 'Updated' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMeta(data.meta);
      setSaved(true);
      setChangeNote('');
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Permanently delete "${id}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/kb/${id}`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate('/kb');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  async function handleToggle() {
    if (!window.confirm(`${meta.active ? 'Deactivate' : 'Reactivate'} this KB? ${meta.active ? 'It will be marked deprecated and skipped by all modules.' : 'It will be re-enabled for all linked modules.'}`)) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/kb/${id}/toggle`, { method: 'PATCH', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMeta(prev => ({ ...prev, active: data.active, deprecated: !data.active }));
    } catch (err) {
      setError(err.message);
    } finally {
      setToggling(false);
    }
  }

  const setMetaField = (field, value) => setMeta(prev => ({ ...prev, [field]: value }));

  const toggleModule = (mod) => {
    const current = meta.linked_modules || [];
    setMetaField('linked_modules', current.includes(mod) ? current.filter(m => m !== mod) : [...current, mod]);
  };

  const inputStyle = {
    width: '100%', padding: '0.5rem 0.75rem', borderRadius: 'var(--r-lg)',
    border: '1px solid var(--border)', fontSize: '0.875rem', color: 'var(--text)',
    background: 'var(--card)', outline: 'none', boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block', fontSize: '0.75rem', fontWeight: 600,
    color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem',
  };

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)' }}>
      <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>
    </div>
  );

  if (!kb && !loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)' }}>
      <p style={{ fontSize: '0.875rem', color: 'var(--danger)' }}>KB not found.</p>
    </div>
  );

  const isBrand = meta.category === 'brand';
  const isFeedback = meta.category === 'client-feedback';
  const isIndustry = meta.category === 'industry';

  return (
    <>
      {error && (
        <div style={{
          margin: '1rem 1.5rem 0', padding: '0.75rem 1rem',
          background: 'var(--danger-soft, #FEF2F2)', border: '1px solid var(--danger-border, #FECACA)',
          borderRadius: 'var(--r-lg)', fontSize: '0.875rem', color: 'var(--danger)',
          flexShrink: 0,
        }}>{error}</div>
      )}

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.625rem 1.25rem',
        background: 'var(--card)', borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
          {id}
        </span>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {saved && (
            <span style={{ fontSize: '0.75rem', color: 'var(--success, #16a34a)' }}>Saved</span>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: '0.375rem 0.875rem', borderRadius: 'var(--r-lg)',
              border: '1px solid var(--danger-border, #FECACA)',
              background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)',
              fontSize: '0.8125rem', fontWeight: 500, cursor: deleting ? 'not-allowed' : 'pointer',
              opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting ? 'Deleting…' : 'Delete KB'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '0.375rem 0.875rem', borderRadius: 'var(--r-lg)',
              border: 'none', background: 'var(--primary)', color: '#fff',
              fontSize: '0.8125rem', fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Two-pane layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left pane: frontmatter form */}
        <aside style={{
          width: '18rem', flexShrink: 0,
          background: 'var(--card)', borderRight: '1px solid var(--border)',
          overflowY: 'auto',
        }}>
          <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={labelStyle}>ID</label>
              <div style={{
                padding: '0.5rem 0.75rem', background: 'var(--surface)',
                borderRadius: 'var(--r-lg)', fontSize: '0.875rem', color: 'var(--text-3)',
                fontFamily: 'var(--font-mono)',
              }}>{meta.id}</div>
            </div>

            <div>
              <label style={labelStyle}>Category</label>
              <select
                value={meta.category || ''} onChange={e => setMetaField('category', e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}
                onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Brand field — shown for feedback (which brand this feedback belongs to) */}
            {isFeedback && (
              <div>
                <label style={labelStyle}>Brand</label>
                <select
                  value={meta.client || ''} onChange={e => setMetaField('client', e.target.value)}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                >
                  {BRANDS.filter(b => b !== 'global').map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}

            {/* Display Label — only for client-feedback */}
            {isFeedback && (
              <div>
                <label style={labelStyle}>Display Label</label>
                <input
                  type="text" value={meta.label || ''}
                  onChange={e => setMetaField('label', e.target.value)}
                  placeholder="e.g. Q1 2026 Review"
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
            )}

            {/* Associated Industry KB — only for brand */}
            {isBrand && (
              <div>
                <label style={labelStyle}>Associated Industry KB</label>
                <select
                  value={meta.industry || 'global'} onChange={e => setMetaField('industry', e.target.value)}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                >
                  {INDUSTRY_KBS.map(i => <option key={i} value={i}>{i}</option>)}
                </select>
                <p style={{ fontSize: '0.625rem', color: 'var(--text-3)', marginTop: '0.25rem' }}>
                  Industry KB auto-injected when this brand is selected in any tool.
                </p>
              </div>
            )}

            {/* Tags */}
            {!isFeedback && (
              <div>
                <label style={labelStyle}>
                  Tags <span style={{ textTransform: 'none', fontWeight: 400 }}>(comma-separated)</span>
                </label>
                <input
                  type="text" value={(meta.tags || []).join(', ')}
                  onChange={e => setMetaField('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
            )}

            {/* Priority */}
            {!isFeedback && (
              <div>
                <label style={labelStyle}>
                  Priority <span style={{ textTransform: 'none', fontWeight: 400 }}>(1=highest)</span>
                </label>
                <input
                  type="number" min={1} max={5} value={meta.priority || 3}
                  onChange={e => setMetaField('priority', parseInt(e.target.value))}
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
            )}

            {/* Linked Modules — only for industry and brand */}
            {(isBrand || isIndustry) && (
              <div>
                <label style={{ ...labelStyle, marginBottom: '0.5rem' }}>Linked Modules</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {ALL_MODULES.map(mod => (
                    <label key={mod} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox" checked={(meta.linked_modules || []).includes(mod)}
                        onChange={() => toggleModule(mod)}
                        style={{ borderRadius: '0.25rem', accentColor: 'var(--primary)' }}
                      />
                      <span style={{ fontSize: '0.875rem', color: 'var(--text)' }}>{mod}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label style={labelStyle}>Change Note</label>
              <input
                type="text" value={changeNote} onChange={e => setChangeNote(e.target.value)}
                placeholder="Describe what changed…"
                style={inputStyle}
                onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
              />
            </div>

            <div style={{
              paddingTop: '0.5rem', borderTop: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: '0.25rem',
              fontSize: '0.75rem', color: 'var(--text-3)',
            }}>
              <div>Last updated: {meta.last_updated}</div>
              <div>Version: {meta.version}</div>
            </div>
          </div>
        </aside>

        {/* Right pane: Markdown editor */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }} data-color-mode="light">
          <div style={{ flex: 1, overflow: 'auto' }}>
            <MDEditor
              value={body}
              onChange={val => setBody(val || '')}
              height="100%"
              style={{ minHeight: '100%', borderRadius: 0, border: 'none' }}
              preview="edit"
            />
          </div>
        </div>
      </div>
    </>
  );
}
