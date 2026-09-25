import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';
import { useTheme } from '../components/ThemeContext';

const BRANDS = ['gentle-dental','great-lakes','riccobene','clear-behavioral-health','neuro-wellness-spa','new-life-house'];
const INDUSTRY_KBS = ['global','dental-service-organizations','mental-health-organizations','b2b-tech'];
const CATEGORIES = ['industry','brand','client-feedback','best-practices'];
const ALL_MODULES = ['content-research','keyword-research','article-recommendation','article-enhancement'];

// Steps per category
const STEPS_BY_CATEGORY = {
  brand:             ['Category', 'Brand Slug', 'Industry KB', 'Tags & Priority', 'Linked Modules', 'Content'],
  industry:          ['Category', 'Tags & Priority', 'Linked Modules', 'Content'],
  'client-feedback': ['Category', 'Brand', 'Label & Content'],
  'best-practices':  ['Category', 'Tags & Priority', 'Linked Modules', 'Content'],
};

export default function CreateKBPage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    id: '', category: 'brand', client: 'gentle-dental', industry: 'dental-service-organizations',
    tags: '', priority: 3, linked_modules: [], body: '', label: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const toggleModule = mod => set('linked_modules',
    form.linked_modules.includes(mod) ? form.linked_modules.filter(m => m !== mod) : [...form.linked_modules, mod]
  );

  const STEPS = STEPS_BY_CATEGORY[form.category] || STEPS_BY_CATEGORY.brand;
  const currentStepName = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  async function handleCreate() {
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      };
      if (!payload.label) delete payload.label;
      const res = await fetch('/api/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      navigate(`/kb/${data.id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const canAdvance = () => {
    if (currentStepName === 'Category') return !!form.category;
    if (currentStepName === 'Brand Slug') return !!form.client;
    if (currentStepName === 'Brand') return !!form.client;
    if (currentStepName === 'Label & Content') return !!form.id.trim();
    if (currentStepName === 'Content') return !!form.id.trim();
    return true;
  };

  function handleCategoryChange(cat) {
    set('category', cat);
    setStep(0); // reset to first step when category changes
  }

  const inputStyle = {
    width: '100%', padding: '0.625rem 1rem', borderRadius: 'var(--r-lg)',
    border: '1px solid var(--border)', fontSize: '0.875rem', color: 'var(--text)',
    background: 'var(--card)', outline: 'none', boxSizing: 'border-box',
  };

  const labelStyle = {
    display: 'block', fontSize: '0.875rem', fontWeight: 600,
    color: 'var(--text)', marginBottom: '0.375rem',
  };

  return (
    <>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <main style={{ maxWidth: '48rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
        {/* Step progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: '2rem' }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{
                  width: '1.75rem', height: '1.75rem', borderRadius: '9999px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700,
                  ...(i < step
                    ? { background: 'var(--primary)', color: '#fff' }
                    : i === step
                    ? { background: 'var(--text)', color: '#fff' }
                    : { background: 'var(--border)', color: 'var(--text-3)' }
                  ),
                }}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span style={{
                  fontSize: '0.75rem', marginTop: '0.25rem', textAlign: 'center', whiteSpace: 'nowrap',
                  color: i === step ? 'var(--text)' : 'var(--text-3)',
                  fontWeight: i === step ? 600 : 400,
                }}>
                  {s}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{
                  flex: 1, height: '0.125rem', marginBottom: '1.25rem', margin: '0 0.25rem',
                  background: i < step ? 'var(--primary)' : 'var(--border)',
                }} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div style={{
          background: 'var(--card)', borderRadius: 'var(--r-lg)',
          border: '1px solid var(--border)', padding: '2rem',
          boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
        }}>
          {error && (
            <div style={{
              marginBottom: '1rem', padding: '0.75rem 1rem',
              background: 'var(--danger-soft, #FEF2F2)', border: '1px solid var(--danger-border, #FECACA)',
              borderRadius: 'var(--r-lg)', fontSize: '0.875rem', color: 'var(--danger)',
            }}>{error}</div>
          )}

          {/* Step: Category */}
          {currentStepName === 'Category' && (
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>Choose a category</h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1.25rem' }}>What type of knowledge base is this?</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => handleCategoryChange(cat)}
                    style={{
                      padding: '1rem', borderRadius: 'var(--r-lg)', textAlign: 'left',
                      border: `2px solid ${form.category === cat ? 'var(--primary)' : 'var(--border)'}`,
                      background: form.category === cat ? 'var(--primary-soft)' : 'var(--card)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text)' }}>{cat}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.125rem' }}>
                      {cat === 'industry' && 'Sector context, compliance rules'}
                      {cat === 'brand' && 'Client voice, services, personas'}
                      {cat === 'client-feedback' && 'Notes from client interactions'}
                      {cat === 'best-practices' && 'Reusable guidelines for AI modules'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Brand Slug (for brand category) */}
          {currentStepName === 'Brand Slug' && (
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>Select brand</h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1.25rem' }}>Which brand does this KB represent? The brand slug becomes the KB ID.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {BRANDS.map(b => (
                  <button
                    key={b}
                    onClick={() => { set('client', b); set('id', b); }}
                    style={{
                      padding: '0.75rem', borderRadius: 'var(--r-lg)', textAlign: 'left',
                      fontSize: '0.875rem', fontWeight: 500,
                      border: `2px solid ${form.client === b ? 'var(--primary)' : 'var(--border)'}`,
                      background: form.client === b ? 'var(--primary-soft)' : 'var(--card)',
                      color: form.client === b ? 'var(--text)' : 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Brand (for client-feedback category) */}
          {currentStepName === 'Brand' && (
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>Select brand</h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1.25rem' }}>Which brand does this feedback belong to?</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {BRANDS.map(b => (
                  <button
                    key={b}
                    onClick={() => set('client', b)}
                    style={{
                      padding: '0.75rem', borderRadius: 'var(--r-lg)', textAlign: 'left',
                      fontSize: '0.875rem', fontWeight: 500,
                      border: `2px solid ${form.client === b ? 'var(--primary)' : 'var(--border)'}`,
                      background: form.client === b ? 'var(--primary-soft)' : 'var(--card)',
                      color: form.client === b ? 'var(--text)' : 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Industry KB (for brand category) */}
          {currentStepName === 'Industry KB' && (
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>Associated Industry KB</h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1.25rem' }}>Which industry KB should be auto-injected alongside this brand?</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {INDUSTRY_KBS.map(ind => (
                  <button
                    key={ind}
                    onClick={() => set('industry', ind)}
                    style={{
                      width: '100%', padding: '0.75rem', borderRadius: 'var(--r-lg)', textAlign: 'left',
                      fontSize: '0.875rem', fontWeight: 500,
                      border: `2px solid ${form.industry === ind ? 'var(--primary)' : 'var(--border)'}`,
                      background: form.industry === ind ? 'var(--primary-soft)' : 'var(--card)',
                      color: form.industry === ind ? 'var(--text)' : 'var(--text-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {ind === 'global' ? 'global (no industry KB)' : ind}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step: Tags & Priority */}
          {currentStepName === 'Tags & Priority' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>Tags & Priority</h2>
              <div>
                <label style={labelStyle}>
                  Tags <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(comma-separated)</span>
                </label>
                <input
                  type="text" value={form.tags} onChange={e => set('tags', e.target.value)}
                  placeholder="dental, dso, brand"
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  Priority <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(1 = highest, 5 = lowest)</span>
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {[1,2,3,4,5].map(n => (
                    <button
                      key={n}
                      onClick={() => set('priority', n)}
                      style={{
                        width: '2.5rem', height: '2.5rem', borderRadius: 'var(--r-lg)',
                        fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                        border: `2px solid ${form.priority === n ? 'var(--primary)' : 'var(--border)'}`,
                        background: form.priority === n ? 'var(--primary-soft)' : 'var(--card)',
                        color: form.priority === n ? 'var(--primary)' : 'var(--text-2)',
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step: Linked Modules */}
          {currentStepName === 'Linked Modules' && (
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>Linked Modules</h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1.25rem' }}>Which modules should load this KB?</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {ALL_MODULES.map(mod => (
                  <label
                    key={mod}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '1rem', borderRadius: 'var(--r-lg)', cursor: 'pointer',
                      border: `2px solid ${form.linked_modules.includes(mod) ? 'var(--primary)' : 'var(--border)'}`,
                      background: form.linked_modules.includes(mod) ? 'var(--primary-soft)' : 'var(--card)',
                    }}
                  >
                    <input
                      type="checkbox" checked={form.linked_modules.includes(mod)} onChange={() => toggleModule(mod)}
                      style={{ width: '1rem', height: '1rem', accentColor: 'var(--primary)' }}
                    />
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>{mod}</div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Step: Content (brand / industry) */}
          {currentStepName === 'Content' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>ID & Content</h2>
              <div>
                <label style={labelStyle}>
                  KB ID <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(unique slug, kebab-case)</span>
                </label>
                <input
                  type="text" value={form.id}
                  onChange={e => set('id', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                  placeholder="e.g. dental-service-organizations"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div data-color-mode={theme}>
                <label style={labelStyle}>
                  Content <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(Markdown)</span>
                </label>
                <MDEditor value={form.body} onChange={val => set('body', val || '')} height={300} preview="edit" />
              </div>
            </div>
          )}

          {/* Step: Label & Content (client-feedback) */}
          {currentStepName === 'Label & Content' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>ID, Label & Content</h2>
              <div>
                <label style={labelStyle}>
                  KB ID <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(unique slug, kebab-case)</span>
                </label>
                <input
                  type="text" value={form.id}
                  onChange={e => set('id', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
                  placeholder={`e.g. ${form.client}-feedback-q1-2026`}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  Display Label <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(shown in the feedback selector)</span>
                </label>
                <input
                  type="text" value={form.label} onChange={e => set('label', e.target.value)}
                  placeholder="e.g. Q1 2026 Review, Post-Launch Feedback"
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
                  onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
                />
              </div>
              <div data-color-mode={theme}>
                <label style={labelStyle}>
                  Content <span style={{ fontWeight: 400, color: 'var(--text-2)' }}>(Markdown)</span>
                </label>
                <MDEditor value={form.body} onChange={val => set('body', val || '')} height={300} preview="edit" />
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '1.25rem' }}>
          <button
            onClick={() => step > 0 ? setStep(s => s - 1) : navigate('/kb')}
            style={{
              padding: '0.625rem 1.25rem', fontSize: '0.875rem', fontWeight: 600,
              border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
              color: 'var(--text-2)', background: 'var(--card)', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.borderColor = 'var(--text-3)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-2)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>

          {!isLastStep ? (
            <button
              onClick={() => setStep(s => s + 1)} disabled={!canAdvance()}
              style={{
                padding: '0.625rem 1.25rem', fontSize: '0.875rem', fontWeight: 600,
                borderRadius: 'var(--r-lg)', color: '#fff', border: 'none',
                background: 'var(--text)', cursor: canAdvance() ? 'pointer' : 'not-allowed',
                opacity: canAdvance() ? 1 : 0.5,
              }}
            >
              Next →
            </button>
          ) : (
            <button
              onClick={handleCreate} disabled={saving || !form.id.trim()}
              style={{
                padding: '0.625rem 1.25rem', fontSize: '0.875rem', fontWeight: 600,
                borderRadius: 'var(--r-lg)', color: '#fff', border: 'none',
                background: 'var(--primary)', cursor: (saving || !form.id.trim()) ? 'not-allowed' : 'pointer',
                opacity: (saving || !form.id.trim()) ? 0.5 : 1,
                display: 'flex', alignItems: 'center', gap: '0.5rem',
              }}
            >
              {saving && (
                <span style={{
                  display: 'inline-block', width: '0.875rem', height: '0.875rem',
                  border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
                  borderRadius: '9999px', animation: 'spin 0.7s linear infinite',
                }} />
              )}
              {saving ? 'Creating…' : 'Create KB'}
            </button>
          )}
        </div>
      </main>
    </>
  );
}
