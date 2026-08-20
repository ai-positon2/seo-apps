import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { lpb, openStream } from '../lib/lpbApi';
import ModuleRuns from '../components/ModuleRuns';

const TABS = ['Keywords', 'Content', 'Schema', 'Approval', 'Export'];

function Spinner() {
  return (
    <>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <svg style={{ animation: 'spin 1s linear infinite', width: '1rem', height: '1rem', display: 'inline', verticalAlign: 'middle' }} viewBox="0 0 24 24" fill="none">
        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </>
  );
}

function StepList({ steps }) {
  const ids = Object.keys(steps);
  if (!ids.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', margin: '0.75rem 0' }}>
      {ids.map(id => {
        const s = steps[id];
        return (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
            <span>{s.status === 'done' ? '✅' : s.status === 'active' ? <Spinner /> : '·'}</span>
            <span style={{ color: s.status === 'done' ? 'var(--text)' : 'var(--text-2)' }}>{s.message}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Keywords tab ─────────────────────────────────────────────────────────────
const KW_BUCKETS = [
  ['primary', 'Primary', true, 2],
  ['secondary', 'Secondary', true, 10],
  ['local_modifier', 'Local modifier', true, null],
  ['semantic', 'Semantic', true, null],
  ['faq', 'FAQ', false, null],
  ['internal_linking', 'Internal linking', true, null],
  ['informational_low', 'Informational (low)', true, null],
  ['excluded', 'Excluded', false, null],
];

function KeywordsTab({ page, reload }) {
  const [steps, setSteps] = useState({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [ks, setKs] = useState(page.keyword_set);
  const [msg, setMsg] = useState('');
  const [adding, setAdding] = useState({});
  const esRef = useRef(null);
  const finalized = ['Keywords Finalized', 'Content Generated', 'SEO Review', 'SEO Approved', 'Clinical Review', 'Clinical Approved', 'Content Review', 'Content Approved', 'Client Review', 'Client Approved', 'Exported'].includes(page.status);

  useEffect(() => { setKs(page.keyword_set); }, [page.keyword_set]);
  useEffect(() => () => esRef.current?.close(), []);

  async function run() {
    setRunning(true); setSteps({}); setError(''); setMsg('');
    try {
      const { token } = await lpb.runKeywords(page.id);
      esRef.current = openStream(token, {
        step: d => setSteps(prev => ({ ...prev, [d.id]: d })),
        fail: d => setError(d.message),
        done: () => { esRef.current?.close(); setRunning(false); reload(); },
      });
    } catch (e) { setError(e.message); setRunning(false); }
  }

  const kwStr = (k) => (typeof k === 'string' ? k : k.keyword);
  const isLocked = (k) => (ks.locked_keywords || []).includes(kwStr(k));

  function mutate(next) { setKs(next); setMsg(''); }
  function removeFrom(bucket, idx) { mutate({ ...ks, [bucket]: ks[bucket].filter((_, i) => i !== idx) }); }
  function addTo(bucket, isObj) {
    const val = (adding[bucket] || '').trim();
    if (!val) return;
    const item = isObj ? { keyword: val, volume: 0, difficulty: 0 } : val;
    mutate({ ...ks, [bucket]: [...(ks[bucket] || []), item] });
    setAdding(a => ({ ...a, [bucket]: '' }));
  }
  function move(from, to, idx) {
    const item = ks[from][idx];
    mutate({ ...ks, [from]: ks[from].filter((_, i) => i !== idx), [to]: [...(ks[to] || []), item] });
  }
  function toggleLock(k) {
    const s = kwStr(k);
    const locked = ks.locked_keywords || [];
    mutate({ ...ks, locked_keywords: locked.includes(s) ? locked.filter(x => x !== s) : [...locked, s] });
  }

  async function save() {
    setError(''); setMsg('');
    try { const saved = await lpb.saveKeywords(page.id, ks); setKs(saved); setMsg('Saved ✓'); reload(); }
    catch (e) { setError(e.message); }
  }
  async function finalize() {
    setError(''); setMsg('');
    try { await lpb.saveKeywords(page.id, ks); await lpb.finalizeKeywords(page.id); setMsg('Keywords finalized ✓ — open the Content tab to generate.'); reload(); }
    catch (e) { setError(e.message); }
  }

  const bucketView = ([key, label, isObj, cap]) => {
    const arr = ks[key] || [];
    const over = cap && arr.length > cap;
    return (
      <div style={{ marginBottom: '1rem' }} key={key}>
        <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.375rem' }}>
          {label} <span style={{ color: over ? 'var(--danger,#EF4444)' : 'var(--text-3)' }}>({arr.length}{cap ? `/${cap}` : ''})</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', alignItems: 'center' }}>
          {arr.map((k, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', padding: '0.25rem 0.5rem', borderRadius: '0.25rem', background: isLocked(k) ? '#FFFBEB' : 'var(--surface)', color: isLocked(k) ? '#92400E' : 'var(--text)', border: isLocked(k) ? '1px solid #FDE68A' : '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>
              {isObj && <button title="lock/unlock" onClick={() => toggleLock(k)} style={{ opacity: 0.6, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{isLocked(k) ? '🔒' : '🔓'}</button>}
              <span>{kwStr(k)}{isObj && k.volume ? <span style={{ color: 'var(--text-3)' }}> · {k.volume}</span> : null}</span>
              {isObj && key === 'secondary' && <button title="promote" onClick={() => move('secondary', 'primary', i)} style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>↑</button>}
              {isObj && key === 'primary' && <button title="demote" onClick={() => move('primary', 'secondary', i)} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>↓</button>}
              <button title="remove" onClick={() => removeFrom(key, i)} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>
            </span>
          ))}
          {!arr.length && <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>—</span>}
          <input value={adding[key] || ''} onChange={e => setAdding(a => ({ ...a, [key]: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTo(key, isObj)} placeholder="+ add" style={{ fontSize: '0.75rem', border: '1px solid var(--border)', borderRadius: '0.25rem', padding: '0.25rem 0.375rem', width: '6rem', background: 'var(--card)', color: 'var(--text)' }} />
        </div>
      </div>
    );
  };

  const primaryBtnStyle = (disabled) => ({ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', background: 'var(--primary)', borderRadius: 'var(--r-md,6px)', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });
  const secondaryBtnStyle = { padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Stages 2–5: seeds → location-forced SERP → SEMrush → LLM prioritization.</p>
        <button onClick={run} disabled={running} style={primaryBtnStyle(running)}>{running ? 'Running…' : ks ? 'Re-run pipeline' : 'Run keyword pipeline'}</button>
      </div>
      {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.5rem' }}>{error}</p>}
      {msg && <p style={{ fontSize: '0.875rem', color: 'var(--success,#10B981)', marginBottom: '0.5rem' }}>{msg}</p>}
      <StepList steps={steps} />
      {ks && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.25rem', marginTop: '0.75rem' }}>
          {finalized && <div style={{ fontSize: '0.75rem', color: 'var(--success,#065F46)', background: 'var(--success-soft,#ECFDF5)', borderRadius: '0.25rem', padding: '0.5rem 0.75rem', marginBottom: '0.75rem' }}>✓ Keywords finalized (status: {page.status}). You can still edit and re-save.</div>}
          {KW_BUCKETS.map(bucketView)}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>🔒 locked keywords survive a pipeline re-run.</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={save} style={secondaryBtnStyle}>Save keywords</button>
              <button onClick={finalize} disabled={!(ks.primary || []).length} style={primaryBtnStyle(!(ks.primary || []).length)}>Save & finalize →</button>
            </div>
          </div>
        </div>
      )}
      {!!(page.competitor_analysis || []).length && (
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Competitor URLs (scored)</div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--text-2)', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}><th style={{ padding: '0.5rem 0.75rem' }}>Domain</th><th style={{ padding: '0.5rem 0.75rem' }}>Bucket</th><th style={{ padding: '0.5rem 0.75rem' }}>Score</th><th style={{ padding: '0.5rem 0.75rem' }}>Pos</th></tr></thead>
              <tbody>{page.competitor_analysis.map((u, i) => (<tr key={i} style={{ borderBottom: '1px solid var(--border)' }}><td style={{ padding: '0.5rem 0.75rem', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{u.domain}</td><td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-2)' }}>{u.bucket}</td><td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-2)' }}>{u.final_score}</td><td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-2)' }}>{u.average_position}</td></tr>))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Content tab ──────────────────────────────────────────────────────────────
const FAQ_TYPES = ['service', 'location', 'insurance', 'virtual', 'provider', 'appointment'];

// Module-scope constants (prevents remounting on keystrokes)
const inputStyle = { width: '100%', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box', fontFamily: 'inherit' };
const areaStyle = { width: '100%', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' };

const NAVY = '#0A2540';
const PRIMARY = '#635BFF';

const gbar = (w, h = 8) => ({ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px`, background: 'var(--border)', borderRadius: '3px', display: 'block' });
const dbar = (w, h = 8) => ({ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px`, background: 'rgba(255,255,255,0.18)', borderRadius: '3px', display: 'block' });

const sectionLbl = (text, color) => (
  <span style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color }}>{text}</span>
);

const GEN_CARD = { border: '2px solid rgba(220,38,38,0.28)', borderRadius: '8px', overflow: 'hidden' };
const TPL_CARD = { border: '2px solid rgba(109,40,217,0.18)', borderRadius: '8px', overflow: 'hidden' };
const GEN_HEAD = { background: 'rgba(220,38,38,0.05)', borderBottom: '1px solid rgba(220,38,38,0.12)', padding: '5px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const TPL_HEAD = { background: 'rgba(109,40,217,0.04)', borderBottom: '1px solid rgba(109,40,217,0.1)', padding: '5px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const GEN_BADGE = <span style={{ background: 'rgba(220,38,38,0.12)', color: '#DC2626', padding: '1px 6px', borderRadius: '3px', fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase' }}>Generated</span>;
const TPL_BADGE = <span style={{ background: 'rgba(109,40,217,0.09)', color: '#7C3AED', padding: '1px 6px', borderRadius: '3px', fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase' }}>Template</span>;
const MINI_LBL = { fontSize: '0.6rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' };

function FieldRegenBtn({ pageId, field, maxChars, context, onResult, darkBg }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  async function regen() {
    setLoading(true); setErr('');
    try {
      const { value } = await lpb.regenField(pageId, { field, maxChars, context: context || {} });
      onResult(value);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }
  const col = darkBg ? 'rgba(255,255,255,0.55)' : PRIMARY;
  const bg = darkBg ? 'rgba(255,255,255,0.08)' : 'rgba(99,91,255,0.07)';
  const bd = darkBg ? 'rgba(255,255,255,0.18)' : 'rgba(99,91,255,0.22)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      <button
        onClick={regen}
        disabled={loading}
        title={`Regenerate this field (max ${maxChars} chars)`}
        style={{ fontSize: '0.55rem', fontWeight: 600, color: col, background: bg, border: `1px solid ${bd}`, borderRadius: '3px', cursor: loading ? 'wait' : 'pointer', padding: '1px 6px', lineHeight: 1.5, opacity: loading ? 0.6 : 1 }}
      >
        {loading ? '…' : '⟳ regen'}
      </button>
      {err && <span title={err} style={{ fontSize: '0.5rem', color: '#EF4444' }}>!</span>}
    </span>
  );
}

function CharCounter({ value, max, darkBg }) {
  const len = (value || '').length;
  const over = len > max;
  const color = over
    ? (darkBg ? '#FCA5A5' : '#EF4444')
    : (darkBg ? 'rgba(255,255,255,0.32)' : 'var(--text-3)');
  return (
    <span style={{ fontSize: '0.58rem', color, fontWeight: over ? 700 : 400, letterSpacing: '0.02em' }}>
      {len}/{max}
    </span>
  );
}

function hasBullets(text) {
  return /^[\s]*[-•*]|^\s*\d+\./m.test(text || '');
}

const inlineDarkInput = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.08)', border: '1px dashed rgba(255,255,255,0.25)',
  borderRadius: '4px', color: '#fff', padding: '5px 10px', fontFamily: 'inherit', outline: 'none',
};
const inlineLightArea = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  background: 'rgba(99,91,255,0.04)', border: '1px dashed rgba(99,91,255,0.22)',
  borderRadius: '4px', color: 'var(--text-2)', padding: '5px 8px',
  fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.55,
};
const addBtn = { fontSize: '0.72rem', fontWeight: 500, color: PRIMARY, background: 'none', border: '1px dashed rgba(99,91,255,0.3)', borderRadius: '4px', cursor: 'pointer', padding: '3px 10px' };

function ContentTab({ page, reload }) {
  const [steps, setSteps] = useState({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(null);
  const esRef = useRef(null);
  const po = page.page_object;
  const finalized = ['Keywords Finalized', 'Content Generated', 'SEO Review', 'SEO Approved', 'Clinical Review', 'Clinical Approved', 'Content Review', 'Content Approved', 'Client Review', 'Client Approved', 'Exported'].includes(page.status);

  useEffect(() => {
    if (po) setDraft(JSON.parse(JSON.stringify({
      meta_title: po.page_data.meta_title, meta_description: po.page_data.meta_description,
      h1: po.page_data.h1, hero_intro: po.page_data.hero_intro,
      approach: po.page_data.approach, competitor_section: po.page_data.competitor_section || { blocks: [] },
      faqs: po.page_data.faqs || [],
    })));
  }, [po?.meta?.version_no, po?.page_data?.h1, page.updated_at]);

  async function run() {
    setRunning(true); setSteps({}); setError(''); setMsg('');
    try {
      const { token } = await lpb.runContent(page.id);
      esRef.current = openStream(token, {
        step: d => setSteps(prev => ({ ...prev, [d.id]: d })),
        fail: d => setError(d.message),
        done: () => { esRef.current?.close(); setRunning(false); reload(); },
      });
    } catch (e) { setError(e.message); setRunning(false); }
  }
  useEffect(() => () => esRef.current?.close(), []);

  async function saveAll() {
    setSaving(true); setError(''); setMsg('');
    try { const r = await lpb.saveContent(page.id, draft); setMsg(`Saved ✓ — QA: ${r.qa.blocking_failures} blocking. Cleared gates were reset.`); reload(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (!finalized && !po) return <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Finalize keywords first, then generate content.</p>;

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const blocks = draft?.competitor_section?.blocks || [];
  const setBlocks = (b) => set({ competitor_section: { ...draft.competitor_section, blocks: b } });
  const updBlock = (bi, patch) => setBlocks(blocks.map((b, i) => i === bi ? { ...b, ...patch } : b));
  const updH3 = (bi, hi, patch) => updBlock(bi, { h3s: blocks[bi].h3s.map((h, i) => i === hi ? { ...h, ...patch } : h) });

  const primaryBtnStyle = (disabled) => ({ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', background: PRIMARY, borderRadius: '6px', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Stage 7: layer-aware generation. Edit inline below; Save resets cleared gates &amp; re-runs QA.</p>
        <button onClick={run} disabled={running} style={primaryBtnStyle(running)}>{running ? 'Generating…' : po ? 'Regenerate content' : 'Generate content'}</button>
      </div>
      {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.5rem' }}>{error}</p>}
      {msg && <p style={{ fontSize: '0.875rem', color: 'var(--success,#10B981)', marginBottom: '0.5rem' }}>{msg}</p>}
      <StepList steps={steps} />

      {po && draft && (
        <>
          {page.qa_result && <QAPanel qa={page.qa_result} />}

          {/* Legend */}
          <div style={{ display: 'flex', gap: '1rem', margin: '0.75rem 0 0.375rem', fontSize: '0.65rem', color: 'var(--text-3)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#DC2626', display: 'inline-block' }} /> Generated — click any field to edit</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#7C3AED', display: 'inline-block' }} /> Template — content managed separately</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>

            {/* ══ 1. SEO METADATA ══ */}
            <div style={GEN_CARD}>
              <div style={GEN_HEAD}>{sectionLbl('SEO Metadata — not rendered on page', '#DC2626')}{GEN_BADGE}</div>
              <div style={{ padding: '0.875rem 1.125rem', background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <div>
                  <div style={MINI_LBL}>Title Tag</div>
                  <input style={{ ...inputStyle, fontWeight: 500 }} value={draft.meta_title || ''} onChange={e => set({ meta_title: e.target.value })} placeholder="Meta title…" />
                </div>
                <div>
                  <div style={MINI_LBL}>Meta Description</div>
                  <textarea rows={2} style={areaStyle} value={draft.meta_description || ''} onChange={e => set({ meta_description: e.target.value })} placeholder="Meta description…" />
                </div>
              </div>
            </div>

            {/* ══ 2. NAVIGATION ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Navigation', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: '#fff', borderBottom: '1px solid #E5E7EB', padding: '0.5rem 1.125rem', display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                <div style={{ width: '80px', height: '22px', background: `linear-gradient(90deg, ${PRIMARY} 0%, #818CF8 100%)`, borderRadius: '4px', flexShrink: 0 }} />
                <div style={{ display: 'flex', gap: '0.875rem', flex: 1 }}>
                  {['For Teens', 'For Adults', 'Telehealth', 'Conditions We Treat', 'Our Locations'].map((t, i) => (
                    <span key={i} style={{ fontSize: '0.62rem', color: '#374151', fontWeight: 500, whiteSpace: 'nowrap' }}>{t}</span>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.62rem', color: '#6B7280' }}>📞 (310) 997-1166</span>
                  <div style={{ background: PRIMARY, color: '#fff', fontSize: '0.62rem', fontWeight: 600, padding: '4px 12px', borderRadius: '4px' }}>Get Started</div>
                </div>
              </div>
            </div>

            {/* ══ 3. HERO BANNER ══ */}
            <div style={GEN_CARD}>
              <div style={GEN_HEAD}>{sectionLbl('Hero Banner', '#DC2626')}{GEN_BADGE}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.25fr', minHeight: '210px' }}>
                {/* Map / location image placeholder */}
                <div style={{ background: '#1B3A5C', position: 'relative', overflow: 'hidden', minHeight: '210px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)`, backgroundSize: '28px 28px' }} />
                  <div style={{ position: 'absolute', top: '38%', left: 0, right: 0, height: '3px', background: 'rgba(255,255,255,0.08)' }} />
                  <div style={{ position: 'absolute', top: '62%', left: 0, right: 0, height: '5px', background: 'rgba(255,255,255,0.06)' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: '35%', width: '3px', background: 'rgba(255,255,255,0.08)' }} />
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: '60%', width: '5px', background: 'rgba(255,255,255,0.06)' }} />
                  <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
                    <div style={{ width: '22px', height: '22px', borderRadius: '50% 50% 50% 0', background: '#EF4444', transform: 'rotate(-45deg)', margin: '0 auto 0.5rem', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }} />
                    <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em' }}>Location Map</div>
                  </div>
                </div>
                {/* Editable hero content */}
                <div style={{ background: NAVY, padding: '1.25rem', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.5)', marginBottom: '0.375rem', lineHeight: 1.4 }}>
                    Personalized care that meets you where you are, including in-person and virtual
                  </div>
                  <div style={{ display: 'flex', gap: '2px', marginBottom: '0.5rem' }}>
                    {[1,2,3,4,5].map(s => <span key={s} style={{ color: '#F59E0B', fontSize: '0.65rem' }}>★</span>)}
                    <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.6rem', marginLeft: '0.25rem' }}>4.9 · 200+ reviews</span>
                  </div>
                  <div style={{ marginBottom: '0.625rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                      <span style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>H1 · max 55 chars</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FieldRegenBtn pageId={page.id} field="h1" maxChars={55} onResult={v => set({ h1: v })} darkBg />
                        <CharCounter value={draft.h1} max={55} darkBg />
                      </span>
                    </div>
                    <input
                      style={{ ...inlineDarkInput, fontSize: '1.05rem', fontWeight: 800, lineHeight: 1.2 }}
                      value={draft.h1 || ''}
                      onChange={e => set({ h1: e.target.value })}
                      placeholder="H1 heading…"
                    />
                  </div>
                  <div style={{ marginBottom: '0.875rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                      <span style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Hero intro · max 160 chars</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FieldRegenBtn pageId={page.id} field="hero_intro" maxChars={160} onResult={v => set({ hero_intro: v })} darkBg />
                        <CharCounter value={draft.hero_intro} max={160} darkBg />
                      </span>
                    </div>
                    <textarea
                      rows={3}
                      style={{ ...inlineDarkInput, fontSize: '0.73rem', color: 'rgba(255,255,255,0.82)', lineHeight: 1.55, resize: 'vertical' }}
                      value={draft.hero_intro || ''}
                      onChange={e => set({ hero_intro: e.target.value })}
                      placeholder="Hero intro paragraph…"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <div style={{ background: '#22C55E', color: '#fff', fontSize: '0.65rem', fontWeight: 700, padding: '6px 14px', borderRadius: '5px' }}>Get Started</div>
                    <div style={{ border: '1px solid rgba(255,255,255,0.35)', color: 'rgba(255,255,255,0.85)', fontSize: '0.65rem', fontWeight: 500, padding: '6px 14px', borderRadius: '5px' }}>📞 Call Now</div>
                  </div>
                </div>
              </div>
            </div>

            {/* ══ 4. SUB NAVIGATION ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Sub Navigation', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: '#fff', borderBottom: '2px solid #E5E7EB', padding: '0 1.125rem', display: 'flex', gap: 0 }}>
                {['Our Approach', 'What Is It?', 'Benefits', 'Telehealth', 'Conditions', 'Treatment Plans', 'Resources', 'Contact'].map((t, i) => (
                  <div key={i} style={{ fontSize: '0.62rem', padding: '0.5rem 0.75rem', color: i === 0 ? PRIMARY : '#6B7280', fontWeight: i === 0 ? 700 : 500, borderBottom: i === 0 ? `2px solid ${PRIMARY}` : '2px solid transparent', marginBottom: '-2px', whiteSpace: 'nowrap' }}>{t}</div>
                ))}
              </div>
            </div>

            {/* ══ 5. APPROACH SECTION ══ */}
            <div style={GEN_CARD}>
              <div style={GEN_HEAD}>{sectionLbl('Approach Section', '#DC2626')}{GEN_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1.125rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.875rem', alignItems: 'start' }}>
                  <div style={{ border: `2px solid ${PRIMARY}`, borderRadius: '8px', padding: '0.875rem', background: `rgba(99,91,255,0.04)`, display: 'flex', alignItems: 'center', minHeight: '85px' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: PRIMARY, lineHeight: 1.35 }}>
                      {draft.approach.heading || <span style={{ color: 'var(--text-3)', fontStyle: 'italic', fontWeight: 400, fontSize: '0.75rem' }}>Approach H2 heading</span>}
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                      <span style={{ fontSize: '0.58rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Body copy · 2–3 paragraphs · max 1110 chars</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FieldRegenBtn pageId={page.id} field="approach.intro" maxChars={1110} onResult={v => set({ approach: { ...draft.approach, intro: v } })} />
                        <CharCounter value={draft.approach.intro} max={1110} />
                      </span>
                    </div>
                    <textarea
                      rows={8}
                      style={{ ...inlineLightArea, fontSize: '0.78rem' }}
                      value={draft.approach.intro || ''}
                      onChange={e => set({ approach: { ...draft.approach, intro: e.target.value } })}
                      placeholder={'Paragraph 1…\n\nParagraph 2…\n\nParagraph 3 (optional)…'}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* ══ 6. CONDITION / SERVICE SECTION ══ */}
            <div style={GEN_CARD}>
              <div style={GEN_HEAD}>
                {sectionLbl('Condition / Service Section', '#DC2626')}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <button onClick={() => setBlocks([...blocks, { h2: '', description: '', h3s: [{ heading: '', copy: '' }] }])} style={addBtn}>+ Add H2 block</button>
                  {GEN_BADGE}
                </div>
              </div>
              <div style={{ padding: '1rem 1.125rem', background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {blocks.length === 0 && (
                  <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', fontStyle: 'italic', textAlign: 'center', padding: '1.25rem 0' }}>No blocks yet — click "+ Add H2 block" above.</div>
                )}
                {blocks.map((b, bi) => (
                  <div key={bi} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                    {/* H2 heading row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', background: `rgba(99,91,255,0.04)`, borderBottom: `2px solid ${PRIMARY}` }}>
                      <input
                        style={{ flex: 1, fontSize: '0.9rem', fontWeight: 700, color: 'var(--text)', background: 'transparent', border: 'none', outline: 'none', fontFamily: 'inherit' }}
                        value={b.h2}
                        onChange={e => updBlock(bi, { h2: e.target.value })}
                        placeholder="H2 heading…"
                      />
                      <button onClick={() => setBlocks(blocks.filter((_, i) => i !== bi))} style={{ fontSize: '0.7rem', color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>× Remove</button>
                    </div>
                    {/* H2 description (450 chars) */}
                    <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', background: 'var(--card)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
                        <span style={{ fontSize: '0.58rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Section description · max 450 chars</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <FieldRegenBtn pageId={page.id} field="block.description" maxChars={450} context={{ h2: b.h2 }} onResult={v => updBlock(bi, { description: v })} />
                          <CharCounter value={b.description} max={450} />
                        </span>
                      </div>
                      <textarea
                        rows={2}
                        style={{ ...inlineLightArea, fontSize: '0.75rem' }}
                        value={b.description || ''}
                        onChange={e => updBlock(bi, { description: e.target.value })}
                        placeholder="Brief description below the H2 heading…"
                      />
                    </div>
                    {/* H3 sub-headings grid */}
                    <div style={{ padding: '0.625rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.375rem' }}>
                      {(b.h3s || []).map((h, hi) => {
                        const bulletDetected = hasBullets(h.copy);
                        const h3Max = bulletDetected ? 1400 : 1500;
                        return (
                          <div key={hi} style={{ background: 'var(--surface)', borderRadius: '6px', padding: '0.5rem 0.625rem', position: 'relative', border: '1px solid var(--border)' }}>
                            <button onClick={() => updBlock(bi, { h3s: b.h3s.filter((_, i) => i !== hi) })} style={{ position: 'absolute', top: '5px', right: '7px', color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', lineHeight: 1 }}>×</button>
                            <input
                              style={{ display: 'block', width: 'calc(100% - 1rem)', fontSize: '0.72rem', fontWeight: 700, color: PRIMARY, background: 'transparent', border: 'none', borderBottom: `1px dashed rgba(99,91,255,0.3)`, marginBottom: '0.3rem', padding: '2px 0', fontFamily: 'inherit', outline: 'none' }}
                              value={h.heading}
                              onChange={e => updH3(bi, hi, { heading: e.target.value })}
                              placeholder="H3 heading…"
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                              <span style={{ fontSize: '0.55rem', color: 'var(--text-3)' }}>
                                max {h3Max} chars{bulletDetected ? ' (−100 bullets)' : ''}
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <FieldRegenBtn pageId={page.id} field="h3.copy" maxChars={h3Max} context={{ h2: b.h2, heading: h.heading }} onResult={v => updH3(bi, hi, { copy: v })} />
                                <CharCounter value={h.copy} max={h3Max} />
                              </span>
                            </div>
                            <textarea
                              rows={3}
                              style={{ display: 'block', width: '100%', fontSize: '0.67rem', color: 'var(--text-2)', lineHeight: 1.45, background: 'transparent', border: 'none', resize: 'vertical', padding: 0, fontFamily: 'inherit', outline: 'none' }}
                              value={h.copy}
                              onChange={e => updH3(bi, hi, { copy: e.target.value })}
                              placeholder="Description…"
                            />
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ padding: '0.375rem 0.625rem', borderTop: '1px solid var(--border)' }}>
                      <button onClick={() => updBlock(bi, { h3s: [...(b.h3s || []), { heading: '', copy: '' }] })} style={addBtn}>+ Add H3</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ══ 7. WHY CHOOSE BRAND ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Why Choose the Brand', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>Why Choose {'{Brand Name}'}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>Our commitment to compassionate, evidence-based mental health care sets us apart.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                  {[
                    { icon: '🏥', title: 'Accessible Care', desc: 'In-person & virtual care across all our locations for flexible treatment options.' },
                    { icon: '🎯', title: 'Built for You', desc: 'Personalized treatment plans tailored to your unique needs and recovery goals.' },
                    { icon: '🤝', title: 'Connected to Community', desc: 'Rooted in local neighborhoods with trusted, compassionate provider networks.' },
                  ].map((item, i) => (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.875rem 0.75rem', textAlign: 'center', background: 'var(--surface)' }}>
                      <div style={{ fontSize: '1.35rem', marginBottom: '0.375rem' }}>{item.icon}</div>
                      <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>{item.title}</div>
                      <div style={{ fontSize: '0.63rem', color: 'var(--text-3)', lineHeight: 1.45 }}>{item.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 8. STATISTICS ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Statistics Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: NAVY, padding: '1.125rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                  {[{ n: '10+', l: 'Years of Service' }, { n: '92%', l: 'Seen within 24 Hours' }, { n: '16', l: 'Treatment Locations' }, { n: '50+', l: 'Care Providers' }].map(({ n, l }, i) => (
                    <div key={i} style={{ textAlign: 'center', padding: '0.375rem' }}>
                      <div style={{ fontSize: '2rem', fontWeight: 900, color: '#fff', lineHeight: 1.1, letterSpacing: '-0.02em' }}>{n}</div>
                      <div style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.2rem' }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 9. TREATMENT PROGRAMS ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Treatment Programs Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>Treatment Programs in {'{Location}'}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>Compassionate, evidence-based care at every level of need — residential, outpatient, and beyond.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                  {['Residential Mental Health Treatment', 'Outpatient Mental Health Treatment', 'Outpatient Teen Mental Health'].map((prog, i) => (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                      <div style={{ height: '75px', background: `linear-gradient(135deg, rgba(99,91,255,0.12) 0%, rgba(10,37,64,0.25) 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: '1.6rem', opacity: 0.55 }}>🏥</span>
                      </div>
                      <div style={{ padding: '0.5rem 0.625rem' }}>
                        <div style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>{prog}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 10. EXPERTS ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Experts Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>{'{Condition}'} Treatment Experts in {'{Location}'}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-2)', marginBottom: '0.75rem' }}>With expertise and empathy, our specialists guide you through personalized treatment for lasting recovery.</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                  {[{ name: 'Provider Name, MD', title: 'Medical Director', role: 'Program Director' }, { name: 'Provider Name, PhD', title: 'Licensed Psychologist', role: 'Clinical Therapist' }, { name: 'Provider Name, LMFT', title: 'Licensed Therapist', role: 'Care Coordinator' }].map((p, i) => (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.875rem 0.75rem', textAlign: 'center', background: 'var(--surface)' }}>
                      <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: `rgba(99,91,255,0.1)`, border: `2px solid rgba(99,91,255,0.2)`, margin: '0 auto 0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: '1.4rem', opacity: 0.45 }}>👤</span>
                      </div>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1.3 }}>{p.name}</div>
                      <div style={{ fontSize: '0.62rem', color: PRIMARY, marginTop: '0.125rem', fontWeight: 500 }}>{p.title}</div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-3)', marginTop: '0.125rem' }}>{p.role}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 11. INSURANCE ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Insurance Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem', display: 'grid', gridTemplateColumns: '1fr auto', gap: '1.5rem', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>Insurance accepted</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-2)', marginBottom: '0.5rem' }}>We accept a wide range of insurance plans. Let us help you navigate coverage so you can focus on care.</div>
                  <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                    {['Mental Health', 'Blue Cross', 'United Health', 'Ambetter', 'Aetna'].map((ins, i) => (
                      <div key={i} style={{ padding: '0.25rem 0.625rem', border: '1px solid var(--border)', borderRadius: '5px', fontSize: '0.63rem', fontWeight: 500, color: 'var(--text-2)', background: 'var(--surface)' }}>{ins}</div>
                    ))}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-2)', marginBottom: '0.5rem' }}>Let us help you through the maze.</div>
                  <div style={{ background: PRIMARY, color: '#fff', fontSize: '0.65rem', fontWeight: 600, padding: '6px 14px', borderRadius: '5px', display: 'inline-block' }}>Verify Insurance</div>
                </div>
              </div>
            </div>

            {/* ══ 12. TESTIMONIALS ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Testimonials', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.625rem' }}>Testimonials</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {[1, 2].map(n => (
                    <div key={n} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '0.875rem', background: 'var(--surface)' }}>
                      <div style={{ display: 'flex', gap: '2px', marginBottom: '0.375rem' }}>
                        {[1,2,3,4,5].map(s => <span key={s} style={{ color: '#F59E0B', fontSize: '0.65rem' }}>★</span>)}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.5rem' }}>
                        {[100, 95, 80, 60].map((w, j) => <div key={j} style={gbar(`${w}%`, 6)} />)}
                      </div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-3)', fontWeight: 600 }}>— Happy Client</div>
                      <div style={{ marginTop: '0.375rem' }}>
                        <span style={{ fontSize: '0.6rem', color: PRIMARY, border: `1px solid rgba(99,91,255,0.3)`, padding: '2px 7px', borderRadius: '3px', cursor: 'pointer' }}>Read more</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 13. RESOURCES ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Resources Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1rem 1.125rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>Resources</div>
                  <span style={{ fontSize: '0.65rem', color: PRIMARY, fontWeight: 500 }}>View All →</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                  {[1, 2, 3].map(n => (
                    <div key={n} style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                      <div style={{ height: '62px', background: `linear-gradient(135deg, rgba(99,91,255,0.1) 0%, rgba(10,37,64,0.18) 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: '1.2rem', opacity: 0.5 }}>📰</span>
                      </div>
                      <div style={{ padding: '0.5rem' }}>
                        <div style={{ ...gbar('90%', 7), marginBottom: '0.25rem' }} />
                        <div style={{ ...gbar('70%', 6), marginBottom: '0.25rem' }} />
                        <div style={{ ...gbar('50%', 5) }} />
                        <div style={{ marginTop: '0.375rem', display: 'flex', gap: '0.25rem' }}>
                          <div style={gbar('35%', 5)} />
                          <div style={gbar('25%', 5)} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ 14. CONTACT FORM ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Contact / Form Section', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: 'var(--card)', padding: '1.25rem 1.125rem' }}>
                <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>Let's Take the First Step Toward Healing Together</div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-2)' }}>Fill out this form and a team member will reach out to you shortly.</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.375rem', marginBottom: '0.375rem' }}>
                  {['Name', 'Email', 'Phone number', 'Insurance'].map((f, i) => (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '0.4rem 0.625rem', fontSize: '0.65rem', color: 'var(--text-3)', background: 'var(--surface)' }}>{f}</div>
                  ))}
                </div>
                {['Which program are you interested in?', 'How did you hear about us?'].map((f, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '0.4rem 0.625rem', fontSize: '0.65rem', color: 'var(--text-3)', background: 'var(--surface)', marginBottom: '0.375rem' }}>{f}</div>
                ))}
                <div style={{ fontSize: '0.58rem', color: 'var(--text-3)', marginBottom: '0.625rem' }}>
                  ☐ By submitting, you consent to receive SMS from {'{Brand}'}. Reply STOP to opt out.
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ background: PRIMARY, color: '#fff', fontSize: '0.72rem', fontWeight: 700, padding: '7px 28px', borderRadius: '6px', display: 'inline-block' }}>Submit</div>
                </div>
              </div>
            </div>

            {/* ══ 15. FAQ SECTION ══ */}
            <div style={GEN_CARD}>
              <div style={GEN_HEAD}>
                {sectionLbl(`FAQ Section (${draft.faqs.length} — target 7–11)`, '#DC2626')}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <button onClick={() => set({ faqs: [...draft.faqs, { question: '', answer: '', faq_type: 'service' }] })} style={addBtn}>+ Add FAQ</button>
                  {GEN_BADGE}
                </div>
              </div>
              {/* Section header matching template style */}
              <div style={{ padding: '0.875rem 1.125rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>Frequently Asked Questions</div>
                <div style={{ fontSize: '0.65rem', fontWeight: 600, background: `rgba(99,91,255,0.1)`, color: PRIMARY, padding: '2px 10px', borderRadius: '4px' }}>
                  FAQs ({draft.faqs.length} — Target 7-11)
                </div>
              </div>
              {/* Accordion items */}
              <div style={{ background: 'var(--card)' }}>
                {draft.faqs.length === 0 && (
                  <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', fontStyle: 'italic', textAlign: 'center', padding: '1.25rem 0' }}>No FAQs generated yet.</div>
                )}
                {draft.faqs.map((f, i) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '0.625rem 1.125rem' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
                      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: PRIMARY, minWidth: '1.25rem', paddingTop: '3px' }}>{i + 1}.</span>
                      <input
                        style={{ flex: 1, fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', background: 'transparent', border: 'none', borderBottom: '1px dashed var(--border)', padding: '2px 0', fontFamily: 'inherit', outline: 'none' }}
                        value={f.question}
                        onChange={e => set({ faqs: draft.faqs.map((x, j) => j === i ? { ...x, question: e.target.value } : x) })}
                        placeholder="Question…"
                      />
                      <select
                        style={{ fontSize: '0.62rem', border: '1px solid rgba(109,40,217,0.25)', borderRadius: '3px', background: 'rgba(109,40,217,0.07)', color: '#7C3AED', padding: '2px 5px', fontWeight: 600, flexShrink: 0 }}
                        value={f.faq_type}
                        onChange={e => set({ faqs: draft.faqs.map((x, j) => j === i ? { ...x, faq_type: e.target.value } : x) })}
                      >
                        {FAQ_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-3)', flexShrink: 0, paddingTop: '2px' }}>▾</span>
                      <button onClick={() => set({ faqs: draft.faqs.filter((_, j) => j !== i) })} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', flexShrink: 0 }}>×</button>
                    </div>
                    <div style={{ paddingLeft: '1.875rem', marginTop: '0.375rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                        <span style={{ fontSize: '0.55rem', color: 'var(--text-3)' }}>Answer · max 300 chars</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <FieldRegenBtn pageId={page.id} field="faq.answer" maxChars={300} context={{ question: f.question }} onResult={v => set({ faqs: draft.faqs.map((x, j) => j === i ? { ...x, answer: v } : x) })} />
                          <CharCounter value={f.answer} max={300} />
                        </span>
                      </div>
                      <textarea
                        rows={2}
                        style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: '0.73rem', color: 'var(--text-2)', lineHeight: 1.55, background: 'transparent', border: 'none', borderLeft: `3px solid rgba(99,91,255,0.2)`, paddingLeft: '0.5rem', resize: 'vertical', fontFamily: 'inherit', outline: 'none' }}
                        value={f.answer}
                        onChange={e => set({ faqs: draft.faqs.map((x, j) => j === i ? { ...x, answer: e.target.value } : x) })}
                        placeholder="Answer…"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ══ 16. FOOTER ══ */}
            <div style={TPL_CARD}>
              <div style={TPL_HEAD}>{sectionLbl('Footer', '#7C3AED')}{TPL_BADGE}</div>
              <div style={{ background: NAVY, padding: '1.125rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '1rem', marginBottom: '0.875rem' }}>
                  <div>
                    <div style={{ width: '80px', height: '20px', background: 'rgba(255,255,255,0.25)', borderRadius: '3px', marginBottom: '0.5rem' }} />
                    {[65, 55, 45, 70].map((w, i) => <div key={i} style={{ ...dbar(w), marginBottom: '0.22rem' }} />)}
                    <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.5rem' }}>
                      {[1,2,3].map(i => <div key={i} style={{ width: '18px', height: '18px', background: 'rgba(255,255,255,0.18)', borderRadius: '3px' }} />)}
                    </div>
                  </div>
                  {['Mental Health Programs', 'Our Locations', 'About'].map((col, ci) => (
                    <div key={ci}>
                      <div style={{ ...dbar('70%', 8), borderRadius: '2px', marginBottom: '0.4rem' }} />
                      {[55, 65, 45, 55, 40].map((w, li) => <div key={li} style={{ ...dbar(w), marginBottom: '0.22rem' }} />)}
                    </div>
                  ))}
                </div>
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {[80, 55, 60].map((w, i) => <div key={i} style={{ ...dbar(w, 6), opacity: 0.5 }} />)}
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                    {['NHCS', 'NAATP', 'JCAHO'].map((cert, i) => (
                      <div key={i} style={{ background: 'rgba(255,255,255,0.12)', borderRadius: '3px', padding: '2px 5px', fontSize: '0.45rem', color: 'rgba(255,255,255,0.7)', fontWeight: 700 }}>{cert}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ══ SAVE ══ */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
              <button onClick={saveAll} disabled={saving} style={primaryBtnStyle(saving)}>{saving ? 'Saving…' : 'Save content changes'}</button>
            </div>

          </div>
        </>
      )}
    </div>
  );
}

function QAPanel({ qa }) {
  const passing = !qa.blocking_failures;
  return (
    <div style={{ border: `1px solid ${passing ? 'var(--success,#10B981)' : 'var(--danger,#EF4444)'}`, borderRadius: 'var(--r-lg)', padding: '1rem', background: passing ? 'var(--success-soft,#ECFDF5)' : 'var(--danger-soft,#FEF2F2)' }}>
      <div style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text)' }}>
        {passing ? '✓ QA clean' : `⛔ ${qa.blocking_failures} blocking failure(s)`}{qa.warnings ? ` · ${qa.warnings} warning(s)` : ''}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {qa.checks.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', fontSize: '0.75rem' }}>
            <span>{c.passed ? '✓' : c.severity === 'block' ? '⛔' : '⚠'}</span>
            <span style={{ color: 'var(--text)' }}><span style={{ fontWeight: 500 }}>{c.key}</span> — {c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Schema tab ──────────────────────────────────────────────────────────────
function SchemaTab({ page }) {
  const schema = page.page_object?.page_data?.schema;
  if (!schema) return <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Generate content to produce schema.</p>;
  return (
    <pre style={{ background: '#1E1E1E', color: '#D4D4D4', fontSize: '0.75rem', borderRadius: 'var(--r-lg)', padding: '1rem', overflow: 'auto', maxHeight: '600px', fontFamily: 'var(--font-mono)' }}>
      {JSON.stringify(schema, null, 2)}
    </pre>
  );
}

// ── Approval tab ─────────────────────────────────────────────────────────────
const GATE_ROLE = { seo: 'seo', clinical: 'clinical', content: 'content', client: 'account_owner' };

function ApprovalTab({ page, reload }) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const gates = Object.keys(page.approval_status).filter(g => page.approval_status[g] !== 'n/a');

  async function act(gate, action) {
    setError('');
    try { await lpb.gate(page.id, { gate, action, role: GATE_ROLE[gate], comment }); setComment(''); reload(); }
    catch (e) { setError(e.message); }
  }

  const gateStatusColor = (st) => st === 'approved' ? 'var(--success,#10B981)' : st === 'rejected' ? 'var(--danger,#EF4444)' : 'var(--text-3)';

  return (
    <div>
      <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1rem' }}>Sequential gates with reject-back. SEO requires QA blocking_failures = 0. Editing content resets cleared gates.</p>
      {error && <p style={{ fontSize: '0.875rem', color: 'var(--danger,#EF4444)', marginBottom: '0.5rem' }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {gates.map(g => {
          const st = page.approval_status[g];
          return (
            <div key={g} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '0.75rem 1rem' }}>
              <div>
                <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text)', textTransform: 'capitalize' }}>{g}</span>
                <span style={{ fontSize: '0.75rem', marginLeft: '0.5rem', color: gateStatusColor(st) }}>● {st}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => act(g, 'approve')} style={{ padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 500, color: '#fff', background: PRIMARY, borderRadius: '6px', border: 'none', cursor: 'pointer' }}>Approve</button>
                <button onClick={() => act(g, 'reject')} style={{ padding: '0.375rem 0.75rem', fontSize: '0.75rem', fontWeight: 500, color: 'var(--danger,#EF4444)', border: '1px solid var(--danger,#FECACA)', borderRadius: '6px', background: 'var(--card)', cursor: 'pointer' }}>Reject</button>
              </div>
            </div>
          );
        })}
      </div>
      <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (attached to the approval action)…" rows={2} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.875rem', background: 'var(--card)', color: 'var(--text)', marginBottom: '1rem', boxSizing: 'border-box', resize: 'vertical' }} />
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Audit trail</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {(page.approval_records || []).slice().reverse().map(r => (
          <div key={r.id} style={{ fontSize: '0.75rem', color: 'var(--text-2)' }}>
            <span style={{ color: r.action === 'approve' ? 'var(--success,#10B981)' : 'var(--danger,#EF4444)' }}>{r.action}</span>
            {' · '}<span style={{ textTransform: 'capitalize' }}>{r.gate}</span>
            {' · '}{r.actor_id}
            {' · '}{new Date(r.created_at).toLocaleString()}
            {r.comment ? ` — "${r.comment}"` : ''}
          </div>
        ))}
        {!(page.approval_records || []).length && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>No actions yet.</p>}
      </div>
    </div>
  );
}

// ── Export tab ───────────────────────────────────────────────────────────────
function ExportTab({ page }) {
  if (!page.page_object) return <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Generate content first.</p>;
  const btn = (fmt, label) => (
    <a href={lpb.exportUrl(page.id, fmt)} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', background: PRIMARY, borderRadius: '6px', display: 'inline-block', textDecoration: 'none' }} download>{label}</a>
  );
  return (
    <div>
      <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', marginBottom: '1rem' }}>Exports the current page version and stamps it with the approval snapshot.</p>
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {btn('json', 'Download JSON')}{btn('markdown', 'Download Markdown')}{btn('docx', 'Download DOCX')}
      </div>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Version history</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        {(page.versions || []).slice().reverse().map(v => (
          <div key={v.id} style={{ fontSize: '0.75rem', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
            v{v.version_no} · {(v.exported_formats || []).join(', ') || 'snapshot'} · {new Date(v.created_at).toLocaleString()}
          </div>
        ))}
        {!(page.versions || []).length && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>No versions exported yet.</p>}
      </div>
    </div>
  );
}

export default function LocationPageDetailPage() {
  const { id } = useParams();
  const [page, setPage] = useState(null);
  const [tab, setTab] = useState('Keywords');
  const [error, setError] = useState('');

  async function reload() {
    try { setPage(await lpb.page(id)); } catch (e) { setError(e.message); }
  }
  useEffect(() => { reload(); }, [id]);

  if (error) return <div style={{ padding: '2rem', color: 'var(--danger,#EF4444)' }}>{error}</div>;
  if (!page) return <div style={{ padding: '2rem', color: 'var(--text-2)' }}>Loading…</div>;

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '1.5rem 2rem' }}>
      {!page.eligibility?.eligible && (
        <div style={{ background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', fontSize: '0.875rem', borderRadius: '6px', padding: '0.75rem', marginBottom: '1rem' }}>
          ⛔ {page.eligibility?.reason}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border)', marginBottom: '1.25rem' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, border: 'none', borderBottom: tab === t ? `2px solid ${PRIMARY}` : '2px solid transparent', marginBottom: '-1px', background: 'none', color: tab === t ? PRIMARY : 'var(--text-3)', cursor: 'pointer' }}>{t}</button>
        ))}
      </div>
      {tab === 'Keywords' && <KeywordsTab page={page} reload={reload} />}
      {tab === 'Content' && <ContentTab page={page} reload={reload} />}
      {tab === 'Schema' && <SchemaTab page={page} />}
      {tab === 'Approval' && <ApprovalTab page={page} reload={reload} />}
      {tab === 'Export' && <ExportTab page={page} />}

      {/* Scoped to this page: the run label the server records is `page <id>`. */}
      <ModuleRuns
        toolId="location-page-builder"
        title="Runs for this page"
        search={`page ${id}`}
        scopeNote="Keyword pipeline, content generation, QA and field regenerations for this page"
      />
    </main>
  );
}
