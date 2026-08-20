import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { lpb } from '../lib/lpbApi';
import { ProgressSteps } from '../ui/ProgressSteps';
import ModuleRuns from '../components/ModuleRuns';

// Matches server/locationPageBuilder/seed.js GD_CLIENT_ID — this wizard is
// scoped to a single client (Gentle Dental), so it's fixed, not selected.
const GD_CLIENT_ID = 'client_gentle_dental';
const CATEGORY_ORDER = ['Cosmetic', 'Restorative', 'Oral Surgery', 'Orthodontics', 'Preventive', 'Specialty'];
const MAX_PRIMARY = 2;
const MAX_SECONDARY = 10;

const STEPS = ['Select Location + Service', 'Keyword Research', 'Generate All Sections', 'Review & Confirm'];

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function keyOf(kw) {
  return (kw.keyword || '').trim().toLowerCase();
}

// educationalBody blocks store real HTML (<p>/<ul>/<li>) — Copy-as-HTML and
// the schema/QC pipeline need that. But showing raw markup in an editable
// textarea is noisy ("no need to show <p> in the filled content"). These two
// convert between the stored HTML and a clean plain-text editing view:
// blank-line-separated paragraphs, "- " prefixed list items.
function htmlBlockToPlainText(html) {
  let s = String(html || '');
  s = s.replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
function plainTextToHtmlBlock(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let listBuf = [];
  let paraBuf = [];
  const flushList = () => { if (listBuf.length) { out.push(`<ul>${listBuf.map(li => `<li>${escapeHtml(li)}</li>`).join('')}</ul>`); listBuf = []; } };
  const flushPara = () => { if (paraBuf.length) { out.push(`<p>${escapeHtml(paraBuf.join(' ').trim())}</p>`); paraBuf = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }
    if (line.startsWith('- ')) { flushPara(); listBuf.push(line.slice(2).trim()); }
    else { flushList(); paraBuf.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

async function copyToClipboard(text, html) {
  try {
    if (html && navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
}

// ── Per-section Text/HTML builders (Build Brief §5) ─────────────────────────
// Breadcrumb / Office Info / Services-in-City are no longer shown as review
// cards (still composed server-side for schema.org + QC), so no builders for
// those here.
const sectionBuilders = {
  meta: (p) => ({
    text: `Title: ${p.meta.title}\nMeta Description: ${p.meta.metaDescription}`,
    html: `<dl><dt>Title</dt><dd>${escapeHtml(p.meta.title)}</dd><dt>Meta Description</dt><dd>${escapeHtml(p.meta.metaDescription)}</dd></dl>`,
  }),
  hero: (p) => ({
    text: `${p.sections.hero.h1}\n\n${p.sections.hero.intro}`,
    html: `<h1>${escapeHtml(p.sections.hero.h1)}</h1>\n<p>${escapeHtml(p.sections.hero.intro)}</p>`,
  }),
  educationalBody: (p) => {
    const blocks = p.sections.educationalBody.blocks;
    return {
      text: blocks.map(b => `${b.h2}\n\n${stripHtml(b.html)}`).join('\n\n'),
      html: blocks.map(b => `<h2>${escapeHtml(b.h2)}</h2>${b.html}`).join('\n'),
    };
  },
  faq: (p) => {
    const f = p.sections.faq;
    return {
      text: f.items.map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n'),
      html: `<h2>${escapeHtml(f.heading)}</h2>${f.items.map(x => `<h3>${escapeHtml(x.q)}</h3><p>${escapeHtml(x.a)}</p>`).join('\n')}`,
    };
  },
};

function buildCopyAllHtml(p) {
  const hero = `<h1>${escapeHtml(p.sections.hero.h1)}</h1><p>${escapeHtml(p.sections.hero.intro)}</p>`;
  const body = p.sections.educationalBody.blocks.map(b => `<h2>${escapeHtml(b.h2)}</h2>${b.html}`).join('\n');
  const faq = `<h2>${escapeHtml(p.sections.faq.heading)}</h2>${p.sections.faq.items.map(f => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('\n')}`;
  return [hero, body, faq].join('\n');
}

// ── Small shared bits ────────────────────────────────────────────────────────
const btnStyle = (primary) => ({
  padding: '0.5rem 0.9rem', fontSize: '0.8125rem', fontWeight: 600, borderRadius: 'var(--r-md,6px)',
  border: primary ? 'none' : '1px solid var(--border)', cursor: 'pointer',
  background: primary ? 'var(--primary)' : 'var(--card)', color: primary ? '#fff' : 'var(--text-2)',
});

function CopyButton({ label, getText, getHtml }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      style={{ ...btnStyle(false), fontSize: '0.75rem', padding: '0.375rem 0.625rem' }}
      onClick={async () => { const ok = await copyToClipboard(getText(), getHtml ? getHtml() : null); if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function RegenButton({ busy, onClick, label }) {
  return (
    <button
      style={{ ...btnStyle(false), fontSize: '0.75rem', padding: '0.375rem 0.625rem', opacity: busy ? 0.6 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}
      disabled={busy}
      onClick={onClick}
    >
      {busy ? 'Regenerating…' : (label || '⟳ Regenerate')}
    </button>
  );
}

function SectionCard({ title, note, children, actions }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.25rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h3>
          {note && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', margin: '0.125rem 0 0' }}>{note}</p>}
        </div>
        <div style={{ display: 'flex', gap: '0.375rem' }}>{actions}</div>
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '0.5rem 0.625rem', borderRadius: 'var(--r-md,6px)', border: '1px solid var(--border)',
  fontSize: '0.8125rem', color: 'var(--text)', background: 'var(--surface)', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.25rem' };

// Custom clickable list — replaces a native <select size> listbox for
// Location/Service. Native listboxes here were unreliable (intermittent
// missed clicks, and the selected row visually fades to near-invisible once
// focus moves to the OTHER list). A plain onClick per row is 100%
// deterministic and lets the selected state stay visible regardless of focus.
function PickerList({ groups, selectedId, onSelect, emptyMessage }) {
  return (
    <div style={{ height: '12rem', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', background: 'var(--surface)' }}>
      {groups.map(([label, items]) => (
        <div key={label}>
          <div style={{ padding: '0.25rem 0.625rem', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-3)', background: 'var(--surface)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            {label}
          </div>
          {items.map(item => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '0.375rem 0.625rem',
                  fontSize: '0.8125rem', border: 'none', cursor: 'pointer',
                  background: active ? 'var(--primary-soft)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text)',
                  fontWeight: active ? 600 : 400,
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--card)'; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                {active ? '✓ ' : ''}{item.label}
              </button>
            );
          })}
        </div>
      ))}
      {!groups.length && <div style={{ padding: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-3)' }}>{emptyMessage || 'No results.'}</div>}
    </div>
  );
}

const removeBtnStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 20, height: 20, borderRadius: '50%', border: 'none',
  background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)',
  cursor: 'pointer', fontSize: 13, fontWeight: 700, lineHeight: 1, padding: 0, flexShrink: 0,
};

export default function LocationServiceWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(0);

  // Reference data
  const [gdData, setGdData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [seeding, setSeeding] = useState(false);

  // Step 1
  const [serviceId, setServiceId] = useState(searchParams.get('serviceId') || '');
  const [locationId, setLocationId] = useState(searchParams.get('locationId') || '');
  const [locFilter, setLocFilter] = useState('');
  const [svcFilter, setSvcFilter] = useState('');
  const [existingPage, setExistingPage] = useState(null);
  const [checkingExisting, setCheckingExisting] = useState(false);

  // Step 2 — mirrors KeywordResearchPage's Primary(2)/Secondary(10) model
  const [candidates, setCandidates] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState('');
  const [primaryList, setPrimaryList] = useState([]);
  const [secondaryList, setSecondaryList] = useState([]);
  const [showAllKeywords, setShowAllKeywords] = useState(false);
  const [manualKeyword, setManualKeyword] = useState('');

  // Step 3
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  // Step 4
  const [page, setPage] = useState(null);
  const [qc, setQc] = useState(null);
  const [qcLoading, setQcLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [regenerating, setRegenerating] = useState({});
  const [regenError, setRegenError] = useState('');

  useEffect(() => { loadReferenceData(); }, []);

  // Direct link from the Gentle Dental Pages dashboard — jump straight to
  // Step 4 with the saved page loaded, instead of making the user reselect
  // the location+service to trigger the existing-page banner.
  useEffect(() => {
    const pageId = searchParams.get('pageId');
    if (pageId) loadPageDirectly(pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPageDirectly(pageId) {
    try {
      const result = await lpb.wizardPage(pageId);
      setServiceId(result.serviceId);
      setLocationId(result.locationId);
      setPage(result.page);
      setQc(result.page.qc || null);
      setStep(3);
    } catch (e) { setLoadError(e.message); }
  }

  async function loadReferenceData() {
    setLoadError('');
    try {
      const data = await lpb.client(GD_CLIENT_ID);
      setGdData(data);
    } catch (e) { setLoadError(e.message); }
  }

  async function seedGentleDental() {
    setSeeding(true); setLoadError('');
    try { await lpb.seedGentleDental(); await loadReferenceData(); }
    catch (e) { setLoadError(e.message); }
    setSeeding(false);
  }

  const service = gdData?.services.find(s => s.id === serviceId) || null;
  const location = gdData?.locations.find(l => l.id === locationId) || null;

  function selectLocation(id) {
    setLocationId(id);
    setCandidates([]); setPrimaryList([]); setSecondaryList([]);
    setPage(null); setQc(null); setExistingPage(null); setConfirmed(false);
  }
  function selectService(id) {
    setServiceId(id);
    setCandidates([]); setPrimaryList([]); setSecondaryList([]);
    setPage(null); setQc(null); setExistingPage(null); setConfirmed(false);
  }

  const derived = useMemo(() => {
    if (!service || !location) return null;
    return {
      urlPath: `${location.location_page_url}/${service.slug}`,
      titleTag: `${service.name} in ${location.city}, ${location.state_abbreviation} | Gentle Dental`,
      seedQuery: `${service.name} ${location.city} ${location.state_abbreviation}`,
    };
  }, [service, location]);

  // "Only one page per location+service combination" — check whether one
  // already exists so the user can open/regenerate it instead of unknowingly
  // duplicating work (the server enforces one-per-tuple regardless; this is
  // just visibility into that before spending another generation call).
  useEffect(() => {
    if (service && location) checkExisting(); else setExistingPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, locationId]);

  async function checkExisting() {
    setCheckingExisting(true);
    try {
      const result = await lpb.wizardExisting({ clientId: GD_CLIENT_ID, serviceId, locationId });
      setExistingPage(result.exists ? result : null);
    } catch { setExistingPage(null); }
    setCheckingExisting(false);
  }

  function openExisting() {
    setPage(existingPage.page);
    setQc(existingPage.page.qc || null);
    setStep(3);
  }

  const groupedLocations = useMemo(() => {
    if (!gdData) return [];
    const filtered = gdData.locations.filter(l => !locFilter || `${l.city} ${l.region} ${l.state_abbreviation}`.toLowerCase().includes(locFilter.toLowerCase()));
    const sorted = [...filtered].sort((a, b) => (a.state_abbreviation + a.region + a.city).localeCompare(b.state_abbreviation + b.region + b.city));
    const groups = new Map();
    for (const l of sorted) {
      const key = `${l.state_abbreviation} · ${l.region}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id: l.id, label: l.city });
    }
    return [...groups.entries()];
  }, [gdData, locFilter]);

  const groupedServices = useMemo(() => {
    if (!gdData) return [];
    const filtered = gdData.services.filter(s => !svcFilter || `${s.name} ${s.category}`.toLowerCase().includes(svcFilter.toLowerCase()));
    const groups = new Map();
    for (const cat of CATEGORY_ORDER) groups.set(cat, []);
    for (const s of filtered) {
      if (!groups.has(s.category)) groups.set(s.category, []);
      groups.get(s.category).push({ id: s.id, label: s.name });
    }
    return [...groups.entries()].filter(([, items]) => items.length);
  }, [gdData, svcFilter]);

  async function runKeywordResearch() {
    setKwLoading(true); setKwError('');
    try {
      const results = await lpb.keywordCandidates({
        service: service.name, city: location.city, state: location.state_abbreviation, seedQuery: derived.seedQuery,
        clientId: GD_CLIENT_ID, serviceSlug: service.slug,
      });
      setCandidates(results);
      // Pre-select like the keyword-research module: top 2 by volume as
      // Primary, next 10 as Secondary — user can still add/remove freely.
      const sorted = [...results].sort((a, b) => (b.volume || 0) - (a.volume || 0));
      setPrimaryList(sorted.slice(0, MAX_PRIMARY));
      setSecondaryList(sorted.slice(MAX_PRIMARY, MAX_PRIMARY + MAX_SECONDARY));
    } catch (e) { setKwError(e.message); }
    setKwLoading(false);
  }

  useEffect(() => {
    if (step === 1 && candidates.length === 0 && !kwLoading && !kwError && service && location) runKeywordResearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const selectedKeys = useMemo(() => new Set([...primaryList, ...secondaryList].map(keyOf)), [primaryList, secondaryList]);
  const availableKeywords = useMemo(
    () => candidates.filter(c => !selectedKeys.has(keyOf(c))).sort((a, b) => (b.volume || 0) - (a.volume || 0)),
    [candidates, selectedKeys]
  );

  function addAsPrimary(kw) { setPrimaryList(prev => prev.length >= MAX_PRIMARY ? prev : [...prev, kw]); }
  function addAsSecondary(kw) { setSecondaryList(prev => prev.length >= MAX_SECONDARY ? prev : [...prev, kw]); }
  function removeFromPrimary(idx) { setPrimaryList(prev => prev.filter((_, i) => i !== idx)); }
  function removeFromSecondary(idx) { setSecondaryList(prev => prev.filter((_, i) => i !== idx)); }

  function addManualKeyword() {
    const kw = manualKeyword.trim();
    if (!kw) return;
    if (!candidates.some(c => keyOf(c) === kw.toLowerCase())) {
      const entry = { keyword: kw, volume: 0, difficulty: 0, intent: 'manual', source: 'manual' };
      setCandidates(prev => [...prev, entry]);
      addAsSecondary(entry);
    }
    setManualKeyword('');
  }

  async function generate(isRetry) {
    setGenerating(true); setGenError('');
    try {
      const result = await lpb.wizardGenerate({
        clientId: GD_CLIENT_ID, serviceId, locationId,
        primaryKeywords: primaryList.map(k => k.keyword),
        secondaryKeywords: secondaryList.map(k => k.keyword),
      });
      setPage(result.page);
      setQc(result.page.qc || null);
      setGenerating(false);
      setStep(3);
    } catch (e) {
      if (!isRetry) return generate(true);
      setGenError(e.message);
      setGenerating(false);
    }
  }

  useEffect(() => {
    if (step === 2 && !page && !generating && !genError) generate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function runQc() {
    setQcLoading(true);
    try { setQc(await lpb.wizardQc(page)); }
    catch { /* keep prior qc on failure */ }
    setQcLoading(false);
  }

  function updateSection(mutate) {
    setPage(prev => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
  }

  // "Option to regenerate every section" — one small targeted call per
  // section instead of re-running (and re-billing) the whole page. Always
  // updates the SAME saved page record (server enforces one-per-tuple).
  async function regenerate(section, blockIndex) {
    const key = blockIndex != null ? `${section}:${blockIndex}` : section;
    setRegenerating(prev => ({ ...prev, [key]: true }));
    setRegenError('');
    try {
      const result = await lpb.wizardRegenerate({ clientId: GD_CLIENT_ID, serviceId, locationId, section, blockIndex });
      setPage(result.page);
      setQc(result.page.qc || null);
    } catch (e) {
      setRegenError(e.message);
    }
    setRegenerating(prev => ({ ...prev, [key]: false }));
  }

  function downloadJson() {
    // Derived from page.meta.urlPath (always available once `page` is set)
    // rather than the separately-looked-up location/service objects, so
    // downloading works even when the page was loaded directly by pageId
    // before the reference-data (gdData) fetch resolves.
    const parts = (page.meta.urlPath || '').split('/').filter(Boolean);
    const filename = `${parts[1] || 'xx'}_${parts.slice(2, -1).join('_') || 'location'}_${parts[parts.length - 1] || 'page'}.json`;
    const blob = new Blob([JSON.stringify(page, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function resetWizard() {
    setStep(0); setServiceId(''); setLocationId('');
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setManualKeyword(''); setShowAllKeywords(false);
    setPage(null); setQc(null); setConfirmed(false); setGenError(''); setKwError(''); setExistingPage(null); setRegenError('');
  }

  const progressSteps = STEPS.map((label, i) => ({
    label, status: i < step ? 'done' : i === step ? 'active' : 'pending', number: i + 1,
  }));

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Gentle Dental — Location + Service Content Wizard</h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>Generate a copy-paste-ready content package for a location + service combo page.</p>
        </div>
        <button style={btnStyle(false)} onClick={() => navigate('/location-page-builder/gentle-dental-pages')}>← All Gentle Dental Pages</button>
      </div>

      <div style={{ marginBottom: '1.5rem' }}><ProgressSteps steps={progressSteps} /></div>

      {loadError && (
        <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--r-lg)', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', fontSize: '0.8125rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <span>{loadError}</span>
          <button style={btnStyle(true)} disabled={seeding} onClick={seedGentleDental}>{seeding ? 'Seeding…' : 'Seed Gentle Dental data'}</button>
        </div>
      )}

      {!gdData && !loadError && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}

      {gdData && step === 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div>
              <label style={labelStyle}>Location</label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by city, region, state…" value={locFilter} onChange={e => setLocFilter(e.target.value)} />
              <PickerList groups={groupedLocations} selectedId={locationId} onSelect={selectLocation} emptyMessage="No locations match." />
              <div style={{ marginTop: '0.375rem', fontSize: '0.75rem', minHeight: '1.25rem' }}>
                {location
                  ? <span style={{ color: 'var(--success,#10B981)' }}>✓ Selected: <strong>{location.city}</strong></span>
                  : <span style={{ color: 'var(--text-3)' }}>No location selected</span>}
              </div>
            </div>
            <div>
              <label style={labelStyle}>Service</label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by service or category…" value={svcFilter} onChange={e => setSvcFilter(e.target.value)} />
              <PickerList groups={groupedServices} selectedId={serviceId} onSelect={selectService} emptyMessage="No services match." />
              <div style={{ marginTop: '0.375rem', fontSize: '0.75rem', minHeight: '1.25rem' }}>
                {service
                  ? <span style={{ color: 'var(--success,#10B981)' }}>✓ Selected: <strong>{service.name}</strong></span>
                  : <span style={{ color: 'var(--text-3)' }}>No service selected</span>}
              </div>
            </div>
          </div>

          {derived && (
            <div style={{ marginTop: '1.25rem', padding: '0.875rem 1rem', background: 'var(--surface)', borderRadius: 'var(--r-lg)', fontSize: '0.8125rem', color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div><strong style={{ color: 'var(--text)' }}>URL:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{derived.urlPath}</span></div>
              <div><strong style={{ color: 'var(--text)' }}>Title tag:</strong> {derived.titleTag}</div>
              <div><strong style={{ color: 'var(--text)' }}>Seed query:</strong> {derived.seedQuery}</div>
            </div>
          )}

          {checkingExisting && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginTop: '0.75rem' }}>Checking for an existing page…</p>}
          {existingPage && (
            <div style={{ marginTop: '0.75rem', padding: '0.875rem 1rem', background: 'var(--warning-soft,#FFFBEB)', borderRadius: 'var(--r-lg)', fontSize: '0.8125rem', color: 'var(--warning,#B45309)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span>A page already exists for this combination{existingPage.updatedAt ? ` (updated ${new Date(existingPage.updatedAt).toLocaleDateString()})` : ''}. Only one page per location + service is kept — generating again will update it, not duplicate it.</span>
              <button style={btnStyle(true)} onClick={openExisting}>Open existing →</button>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button style={btnStyle(true)} disabled={!service || !location} onClick={() => setStep(1)}>Next →</button>
          </div>
        </div>
      )}

      {gdData && step === 1 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: 0 }}>
              Primary and secondary keywords for <strong>{service?.name}</strong> in <strong>{location?.city}</strong> are pre-selected below — adjust as needed.
            </p>
            <button style={btnStyle(false)} disabled={kwLoading} onClick={runKeywordResearch}>{kwLoading ? 'Researching…' : 'Re-run research'}</button>
          </div>

          {kwError && <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.8125rem' }}>{kwError}</p>}
          {kwLoading && <p style={{ color: 'var(--text-2)', fontSize: '0.8125rem' }}>Pulling competitor keyword data…</p>}

          {!kwLoading && (
            <>
              {/* Primary Keywords — card grid, mirrors KeywordResearchPage */}
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Primary Keywords</h4>
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    background: primaryList.length === MAX_PRIMARY ? 'var(--success-soft)' : 'var(--danger-soft,#FEF2F2)',
                    color: primaryList.length === MAX_PRIMARY ? 'var(--success)' : 'var(--danger)',
                  }}>
                    {primaryList.length} / {MAX_PRIMARY} selected
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  {primaryList.map((kw, i) => (
                    <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)', borderRadius: 'var(--r-md,6px)', padding: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.8125rem' }}>{kw.keyword}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>Volume: {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}</div>
                        </div>
                        <button style={removeBtnStyle} title="Remove from Primary" onClick={() => removeFromPrimary(i)}>×</button>
                      </div>
                    </div>
                  ))}
                  {!primaryList.length && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', gridColumn: '1 / -1' }}>No primary keywords selected — add one below.</p>}
                </div>
              </div>

              {/* Secondary Keywords — table, mirrors KeywordResearchPage */}
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Secondary Keywords</h4>
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    background: secondaryList.length === MAX_SECONDARY ? 'var(--success-soft)' : 'var(--info-soft)',
                    color: secondaryList.length === MAX_SECONDARY ? 'var(--success)' : 'var(--info)',
                  }}>
                    {secondaryList.length} / {MAX_SECONDARY} selected
                  </span>
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', overflow: 'hidden' }}>
                  <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                    <tbody>
                      {secondaryList.map((kw, i) => (
                        <tr key={i} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-3)', width: '1.5rem' }}>{i + 1}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text)' }}>{kw.keyword}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)', textAlign: 'right' }}>{kw.volume > 0 ? kw.volume.toLocaleString() : '—'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', textAlign: 'right', width: '2rem' }}>
                            <button style={removeBtnStyle} title="Remove from Secondary" onClick={() => removeFromSecondary(i)}>×</button>
                          </td>
                        </tr>
                      ))}
                      {!secondaryList.length && (
                        <tr><td colSpan={4} style={{ padding: '0.75rem', textAlign: 'center', color: 'var(--text-3)' }}>No secondary keywords selected.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <input style={inputStyle} placeholder="Add a keyword manually…" value={manualKeyword} onChange={e => setManualKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && addManualKeyword()} />
                <button style={btnStyle(false)} onClick={addManualKeyword}>Add</button>
              </div>

              <button style={{ ...btnStyle(false), width: '100%' }} onClick={() => setShowAllKeywords(v => !v)}>
                {showAllKeywords ? 'Hide' : 'Show'} all candidate keywords ({availableKeywords.length})
              </button>
              {showAllKeywords && (
                <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', overflow: 'hidden' }}>
                  <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-2)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Keyword</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Volume</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Difficulty</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Intent</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Source</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {availableKeywords.map(kw => (
                        <tr key={kw.keyword} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text)' }}>{kw.keyword}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.volume || 0}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.difficulty || 0}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.intent || '—'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-3)', fontSize: '0.75rem' }}>{kw.source === 'universe' ? 'Universe' : kw.source === 'manual' ? 'Manual' : 'Live'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => addAsPrimary(kw)} disabled={primaryList.length >= MAX_PRIMARY}
                                title={primaryList.length >= MAX_PRIMARY ? `Primary is full (${MAX_PRIMARY}/${MAX_PRIMARY})` : 'Add as Primary'}
                                style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none', background: primaryList.length >= MAX_PRIMARY ? 'var(--surface)' : 'var(--primary-soft)', color: primaryList.length >= MAX_PRIMARY ? 'var(--text-3)' : 'var(--primary)', cursor: primaryList.length >= MAX_PRIMARY ? 'not-allowed' : 'pointer' }}
                              >
                                + Primary
                              </button>
                              <button
                                onClick={() => addAsSecondary(kw)} disabled={secondaryList.length >= MAX_SECONDARY}
                                title={secondaryList.length >= MAX_SECONDARY ? `Secondary is full (${MAX_SECONDARY}/${MAX_SECONDARY})` : 'Add as Secondary'}
                                style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none', background: secondaryList.length >= MAX_SECONDARY ? 'var(--surface)' : 'var(--info-soft)', color: secondaryList.length >= MAX_SECONDARY ? 'var(--text-3)' : 'var(--info)', cursor: secondaryList.length >= MAX_SECONDARY ? 'not-allowed' : 'pointer' }}
                              >
                                + Secondary
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!availableKeywords.length && (
                        <tr><td colSpan={5} style={{ padding: '0.75rem', textAlign: 'center', color: 'var(--text-3)' }}>All candidates have been selected as Primary or Secondary.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem' }}>
            <button style={btnStyle(false)} onClick={() => setStep(0)}>← Back</button>
            <button style={btnStyle(true)} disabled={!primaryList.length} onClick={() => setStep(2)}>Next →</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '2.5rem', textAlign: 'center' }}>
          {generating && (
            <>
              <div style={{ width: '2rem', height: '2rem', margin: '0 auto 1rem', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '9999px', animation: 'spin 0.8s linear infinite' }} />
              <p style={{ color: 'var(--text-2)', fontSize: '0.875rem' }}>Researching competitor pages and writing localized content…</p>
              <p style={{ color: 'var(--text-3)', fontSize: '0.75rem', marginTop: '0.25rem' }}>This can take up to a minute.</p>
            </>
          )}
          {!generating && genError && (
            <>
              <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.875rem', marginBottom: '1rem' }}>{genError}</p>
              <button style={btnStyle(true)} onClick={() => generate(false)}>Retry</button>
              <button style={{ ...btnStyle(false), marginLeft: '0.5rem' }} onClick={() => setStep(1)}>← Back</button>
            </>
          )}
          <style>{'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
        </div>
      )}

      {step === 3 && page && (
        <div>
          <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)', paddingBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle(false)} disabled={qcLoading} onClick={runQc}>{qcLoading ? 'Running QC…' : 'Run QC'}</button>
              <CopyButton label="Copy All (HTML)" getText={() => buildCopyAllHtml(page)} getHtml={() => buildCopyAllHtml(page)} />
              <button style={btnStyle(false)} onClick={downloadJson}>Download JSON</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle(false)} onClick={() => setStep(1)}>← Edit keywords</button>
              {!confirmed
                ? <button style={btnStyle(true)} onClick={() => setConfirmed(true)}>Confirm</button>
                : <button style={btnStyle(true)} onClick={resetWizard}>Generate another →</button>}
            </div>
          </div>

          {regenError && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem', fontSize: '0.8125rem', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
              <span>{regenError}</span>
              <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }} onClick={() => setRegenError('')}>×</button>
            </div>
          )}

          {qc && (
            <div style={{
              padding: '0.875rem 1rem', borderRadius: 'var(--r-lg)', marginBottom: '1rem', fontSize: '0.8125rem',
              background: qc.verdict === 'PASS' ? 'var(--success-soft,#ECFDF5)' : qc.verdict === 'FAIL' ? 'var(--danger-soft,#FEF2F2)' : 'var(--warning-soft,#FFFBEB)',
              color: qc.verdict === 'PASS' ? 'var(--success,#059669)' : qc.verdict === 'FAIL' ? 'var(--danger,#EF4444)' : 'var(--warning,#B45309)',
            }}>
              <strong>QC: {qc.verdict}</strong>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                {qc.checks.filter(c => !c.pass).map(c => (
                  <li key={c.name}><strong>[{c.severity}]</strong> {c.name.replace(/_/g, ' ')} — {c.detail}</li>
                ))}
                {qc.checks.every(c => c.pass) && <li>All checks passed.</li>}
              </ul>
            </div>
          )}

          <SectionCard title="SEO Metadata" note={page.meta.urlPath}
            actions={<>
              <RegenButton busy={!!regenerating.metaDescription} onClick={() => regenerate('metaDescription')} label="⟳ Regenerate description" />
              <CopyButton label="Copy" getText={() => sectionBuilders.meta(page).text} getHtml={() => sectionBuilders.meta(page).html} />
            </>}>
            <label style={labelStyle}>Title Tag <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>(deterministic — service + city + state)</span></label>
            <input style={{ ...inputStyle, marginBottom: '0.5rem' }} value={page.meta.title}
              onChange={e => updateSection(p => { p.meta.title = e.target.value; })} />
            <label style={labelStyle}>Meta Description ({page.meta.metaDescription.length} chars)</label>
            <textarea style={inputStyle} rows={2} value={page.meta.metaDescription}
              onChange={e => updateSection(p => { p.meta.metaDescription = e.target.value; })} />
          </SectionCard>

          <SectionCard title="Hero"
            actions={<>
              <RegenButton busy={!!regenerating.heroIntro} onClick={() => regenerate('heroIntro')} />
              <CopyButton label="Copy" getText={() => sectionBuilders.hero(page).text} getHtml={() => sectionBuilders.hero(page).html} />
            </>}>
            <label style={labelStyle}>H1 (deterministic)</label>
            <div style={{ ...inputStyle, marginBottom: '0.5rem', background: 'var(--surface)', color: 'var(--text-2)' }}>{page.sections.hero.h1}</div>
            <label style={labelStyle}>Intro <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>(short description below the H1, keyword-optimized)</span></label>
            <textarea style={inputStyle} rows={2} value={page.sections.hero.intro}
              onChange={e => updateSection(p => { p.sections.hero.intro = e.target.value; })} />
          </SectionCard>

          <SectionCard title="Educational Body"
            actions={<>
              <RegenButton busy={!!regenerating.educationalBody} onClick={() => regenerate('educationalBody')} label="⟳ Regenerate all" />
              <CopyButton label="Copy" getText={() => sectionBuilders.educationalBody(page).text} getHtml={() => sectionBuilders.educationalBody(page).html} />
            </>}>
            {page.sections.educationalBody.blocks.map((b, i) => (
              <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < page.sections.educationalBody.blocks.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={b.h2}
                    onChange={e => updateSection(p => { p.sections.educationalBody.blocks[i].h2 = e.target.value; })} />
                  <RegenButton busy={!!regenerating[`educationalBlock:${i}`]} onClick={() => regenerate('educationalBlock', i)} label="⟳" />
                </div>
                {/* Edited as clean plain text — no visible <p>/<ul> markup — and
                    reconstructed into semantic HTML on change. */}
                <textarea style={inputStyle} rows={4} value={htmlBlockToPlainText(b.html)}
                  onChange={e => updateSection(p => { p.sections.educationalBody.blocks[i].html = plainTextToHtmlBlock(e.target.value); })} />
              </div>
            ))}
          </SectionCard>

          <SectionCard title="FAQ"
            actions={<>
              <RegenButton busy={!!regenerating.faqs} onClick={() => regenerate('faqs')} label="⟳ Regenerate all" />
              <CopyButton label="Copy" getText={() => sectionBuilders.faq(page).text} getHtml={() => sectionBuilders.faq(page).html} />
            </>}>
            {page.sections.faq.items.map((f, i) => (
              <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < page.sections.faq.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={f.q}
                    onChange={e => updateSection(p => { p.sections.faq.items[i].q = e.target.value; })} />
                  <RegenButton busy={!!regenerating[`faqItem:${i}`]} onClick={() => regenerate('faqItem', i)} label="⟳" />
                </div>
                <textarea style={inputStyle} rows={2} value={f.a}
                  onChange={e => updateSection(p => { p.sections.faq.items[i].a = e.target.value; })} />
              </div>
            ))}
          </SectionCard>

          <SectionCard title="Schema (JSON-LD)" note="Deterministic + generated — 5 blocks">
            {Object.entries(page.schema).map(([key, value]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '0.8125rem', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{key}</span>
                <CopyButton label="Copy JSON-LD" getText={() => `<script type="application/ld+json">${value}</script>`} />
              </div>
            ))}
          </SectionCard>
        </div>
      )}

      <ModuleRuns
        toolId="location-page-builder"
        action="wizard"
        title="Recent wizard runs"
        scopeNote="Pages generated through this wizard"
      />
    </main>
  );
}
