import { useState, useEffect, useMemo, useRef } from 'react';
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

// ── Character count for every generated field ──────────────────────────────
// Sits on the field's label row, right-aligned. Characters are what the SEO
// team counts (and what the SERP truncates); a word count rides along for the
// fields whose limits are expressed in words — the paragraph cap and the FAQ
// answer cap are word-based, so chars alone would not tell a reviewer whether
// a field is over.
//
// `limit` is optional and is only ever passed from server-supplied numbers
// (see contentLimits), never hardcoded here: duplicating the SEO thresholds in
// the client is how the prompt and the QC gate drifted apart once already.
function CharCount({ value, words: showWords, limit, limitWords }) {
  const chars = String(value || '').length;
  const wordCount = (showWords || limitWords)
    ? String(value || '').trim().split(/\s+/).filter(Boolean).length
    : null;

  // Amber only against a real server-supplied threshold. Some fields have a
  // character range (the meta description), some a word cap (an FAQ answer),
  // most have neither and just show their count.
  const outOfRange = limit && (chars < limit.min || chars > limit.max);
  const overWords = limitWords && wordCount > limitWords;
  const color = (outOfRange || overWords) ? 'var(--warning,#B45309)' : 'var(--text-3)';

  return (
    <span style={{ fontWeight: 400, fontSize: '0.6875rem', color, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
      {chars} chars
      {wordCount != null ? ` \u00b7 ${wordCount} words` : ''}
      {limit ? ` \u00b7 target ${limit.min}-${limit.max}` : ''}
      {limitWords ? ` \u00b7 max ${limitWords}` : ''}
    </span>
  );
}

// A label that carries its count on the same row.
function FieldLabel({ children, value, words: showWords, limit }) {
  return (
    <label style={{ ...labelStyle, display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
      <span>{children}</span>
      <CharCount value={value} words={showWords} limit={limit} />
    </label>
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

// ── Educational-body outline provenance (read-only) ─────────────────────────
// The server grades the scraped competitor headings before writing anything
// (server/locationPageBuilder/dentalOutline.js) and decides per block whether
// the H2 came from a competitor page, the curated fallback ladder, or a blend
// of the two. Surfacing that tells the SEO reviewer WHY this stack exists.
const OUTLINE_QUALITY_LABELS = {
  good: { label: 'Competitor headings: good', color: 'var(--success, #15803d)' },
  partial: { label: 'Competitor headings: mixed', color: 'var(--warning, #b45309)' },
  poor: { label: 'Competitor headings: poor — used fallback', color: 'var(--warning, #b45309)' },
  unavailable: { label: 'Outline planner unavailable — used fallback', color: 'var(--text-3)' },
};

function OutlineNote({ meta }) {
  if (!meta?.competitorQuality) return null;
  const grade = OUTLINE_QUALITY_LABELS[meta.competitorQuality] || OUTLINE_QUALITY_LABELS.poor;
  return (
    <div style={{ marginBottom: '0.75rem', padding: '0.5rem 0.625rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)' }}>
      <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: grade.color }}>{grade.label}</span>
      {meta.rationale && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', margin: '0.25rem 0 0' }}>{meta.rationale}</p>}
    </div>
  );
}

const SOURCE_TAG_LABELS = { competitor: 'competitor', fallback: 'fallback', blend: 'blend' };

function SourceTag({ source }) {
  const label = SOURCE_TAG_LABELS[source];
  if (!label) return null;
  return (
    <span
      title="Where this heading came from: a competitor page's topic, the curated fallback ladder, or a blend"
      style={{
        fontSize: '0.625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
        color: 'var(--text-3)', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm,4px)', padding: '0.25rem 0.375rem', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ── Inline QC notices ───────────────────────────────────────────────────────
// QC failures used to be one list at the top of step 4 (plus a verdict pill on
// the dashboard). That told the reviewer the page was wrong, not WHERE. Every
// check now carries the field it belongs to (server/locationPageBuilder/
// qaEngine.js), so its notice renders against the control that has to change,
// and carries its own Recheck button — confirming one fix costs one check, not
// a full QC pass.
//
// Amber and neutral, never red: these are review notes on a draft, not errors,
// and a wall of red on a freshly generated page reads as breakage.
const QC_TONES = {
  Critical: { bg: 'var(--warning-soft,#FFFBEB)', bar: 'var(--warning,#B45309)', text: 'var(--warning,#B45309)' },
  Major: { bg: 'var(--warning-soft,#FFFBEB)', bar: 'var(--warning,#B45309)', text: 'var(--warning,#B45309)' },
  Minor: { bg: 'var(--surface)', bar: 'var(--border)', text: 'var(--text-2)' },
};
const QC_PASS_TONE = { bg: 'var(--success-soft,#ECFDF5)', bar: 'var(--success,#059669)', text: 'var(--success,#059669)' };

// Fields with a control on this page. Anything else — internal links, or a
// result stored before checks carried fields — falls back to the page-level
// strip so it can never go unseen. Keep this in step with the `field` values
// in server/locationPageBuilder/qaEngine.js.
const QC_INLINE_FIELDS = new Set(['hero.h1', 'hero.intro', 'meta.title', 'meta.metaDescription', 'educationalBody', 'faq', 'schema']);
const qcFieldOf = (check) => (QC_INLINE_FIELDS.has(check.field) ? check.field : 'page');
const qcKeyOf = (check) => check.id || check.name;

function QcNotice({ check, detail, busy, onRecheck }) {
  const tone = check.pass ? QC_PASS_TONE : (QC_TONES[check.severity] || QC_TONES.Minor);
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.625rem',
      margin: '0.375rem 0 0.625rem', padding: '0.5rem 0.625rem', fontSize: '0.75rem',
      background: tone.bg, borderLeft: `3px solid ${tone.bar}`, borderRadius: 'var(--r-md,6px)', color: tone.text,
    }}>
      <div>
        <span style={{ fontWeight: 700 }}>{check.pass ? '✓ ' : ''}{check.label || (check.name || '').replace(/_/g, ' ')}</span>
        <span style={{ fontSize: '0.625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', opacity: 0.7, marginLeft: '0.375rem' }}>
          {check.pass ? 'now passes' : check.severity}
        </span>
        <p style={{ margin: '0.1875rem 0 0', opacity: 0.9 }}>{detail || check.detail}</p>
        {!check.pass && check.fix && <p style={{ margin: '0.1875rem 0 0', opacity: 0.7 }}>{check.fix}</p>}
      </div>
      {!check.pass && onRecheck && (
        <button
          style={{ ...btnStyle(false), fontSize: '0.6875rem', padding: '0.25rem 0.5rem', color: tone.text, flexShrink: 0 }}
          disabled={busy}
          onClick={onRecheck}
          title="Re-run just this check against your current edits"
        >
          {busy ? 'Checking…' : '↻ Recheck'}
        </button>
      )}
    </div>
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
    <div style={{ height: '22rem', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', background: 'var(--surface)' }}>
      {groups.map(([label, items]) => (
        <div key={label}>
          <div style={{
            position: 'sticky', top: 0, zIndex: 1,
            display: 'flex', justifyContent: 'space-between', gap: '0.5rem',
            padding: '0.25rem 0.625rem', fontSize: '0.6875rem', fontWeight: 700,
            color: 'var(--text-3)', background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
            textTransform: 'uppercase', letterSpacing: '0.03em',
          }}>
            <span>{label}</span>
            <span style={{ fontWeight: 400 }}>{items.length}</span>
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
  // Set when the server's review pass rejected the discovered Primary picks
  // and fell back to the synthesized "{service} {city}" pair at zero volume.
  const [kwLowVolume, setKwLowVolume] = useState(false);
  const [kwReviewFailures, setKwReviewFailures] = useState([]);

  // Step 3
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  // Step 4
  const [page, setPage] = useState(null);
  // The saved page's id. Needed to persist edits, store QC verdicts and
  // delete — previously the id returned by /wizard/generate was discarded.
  const [pageId, setPageId] = useState(null);
  // Manual edits live in `page` until saved; `dirty` drives the Save button
  // and the navigate-away guard.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [qc, setQc] = useState(null);
  const [qcLoading, setQcLoading] = useState(false);
  const [qcError, setQcError] = useState('');
  const [rechecking, setRechecking] = useState({});
  // Timers that retire the "now passes" confirmations. Held so they can be
  // cancelled when the page (and its QC result) is replaced underneath them.
  const recheckTimers = useRef({});
  // The current QC result, readable by code that runs before the next render —
  // a queued recheck needs the list its predecessor produced, and React state
  // is not updated in time for that. Written only by commitQc.
  const qcRef = useRef(null);
  // Serializes QC requests: see recheck().
  const qcQueue = useRef(Promise.resolve());
  // Monotonic token for keyword research. Selecting a different service or
  // location while a request is in flight must invalidate that request: without
  // this, the stale response repopulates the keyword lists AFTER the new
  // selection has cleared them, and Generate then builds the new page from the
  // previous service's keywords.
  const kwRequestRef = useRef(0);
  // Checks that just went green, held for a few seconds so a fix is
  // acknowledged where it was made instead of the notice silently vanishing.
  const [recheckPassed, setRecheckPassed] = useState({});
  const [confirmed, setConfirmed] = useState(false);
  const [regenerating, setRegenerating] = useState({});
  const [regenError, setRegenError] = useState('');

  useEffect(() => { loadReferenceData(); }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => Object.values(recheckTimers.current).forEach(clearTimeout), []);

  // Edits are held locally until saved, so leaving with unsaved changes would
  // silently discard them.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

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
      setPageId(result.pageId || pageId);
      setPage(result.page);
      applyQc(result.page.qc);
      setDirty(false);
      setStep(3);
      refreshStaleQc(result.page, result.pageId || pageId);
      // Rehydrate the approved keywords too, so "← Edit keywords" opens a
      // populated step 2 instead of an empty one that re-runs billed research.
      hydrateKeywords({
        serviceId: result.serviceId, locationId: result.locationId, page: result.page,
      });
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
    kwRequestRef.current++; // discard any research still in flight for the old pair
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setKwLowVolume(false); setKwReviewFailures([]);
    setPage(null); applyQc(null); setExistingPage(null); setConfirmed(false); forgetSavedPage();
  }
  function selectService(id) {
    setServiceId(id);
    kwRequestRef.current++; // discard any research still in flight for the old pair
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setKwLowVolume(false); setKwReviewFailures([]);
    setPage(null); applyQc(null); setExistingPage(null); setConfirmed(false); forgetSavedPage();
  }

  // Switching tuple invalidates everything about the previously loaded page.
  // Without this the id outlives the page it belongs to, and `dirty` keeps the
  // unsaved-changes prompt armed for edits that are no longer on screen.
  function forgetSavedPage() {
    setPageId(null); setDirty(false); setSaveError('');
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
    // Without the id, Save stays disabled and a recheck can't persist — the
    // endpoint has always returned it, this just stopped throwing it away.
    setPageId(existingPage.pageId || null);
    applyQc(existingPage.page.qc);
    setStep(3);
    refreshStaleQc(existingPage.page, existingPage.pageId);
  }

  // A result stored before checks carried ids and fields can't be anchored to a
  // control or rechecked — every notice would land in the page-level strip with
  // no Recheck button. Refresh it when such a page is opened; runDentalQC is
  // offline and costs nothing but the round trip. Takes the page explicitly
  // because the caller has only just handed it to setPage.
  async function refreshStaleQc(target, id) {
    const checks = target?.qc?.checks;
    if (checks?.length && checks.every(c => c.id)) return;
    try { applyQc(await lpb.wizardQc(target, id || null)); }
    catch { /* leave whatever was stored on screen */ }
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

  // Load the saved approval for a tuple, falling back to the keyword strings
  // stored on the page itself for pages generated before selections were
  // persisted. Returns true when something was restored, so callers know not
  // to fire the billed research call.
  async function hydrateKeywords({ serviceId: svc, locationId: loc, page: pg }) {
    try {
      const saved = await lpb.wizardGetKeywords({ clientId: GD_CLIENT_ID, serviceId: svc, locationId: loc });
      if (saved.exists && (saved.primary.length || saved.secondary.length)) {
        setPrimaryList(saved.primary);
        setSecondaryList(saved.secondary);
        // Keep the pool a superset of the picks so the step-2 table can still
        // offer swaps without re-researching.
        const pool = saved.candidates.length ? saved.candidates : [...saved.primary, ...saved.secondary];
        setCandidates(pool);
        return true;
      }
    } catch { /* fall through to the page_object fallback */ }

    // Legacy pages: only bare strings were ever stored, so volume/difficulty
    // are unknown (0) until the user re-researches explicitly.
    const asCandidate = k => ({ keyword: k, volume: 0, difficulty: 0, intent: '', source: 'saved' });
    const savedPrimary = (pg?.primaryKeywords || (pg?.primaryKeyword ? [pg.primaryKeyword] : [])).map(asCandidate);
    const savedSecondary = (pg?.secondaryKeywords || []).map(asCandidate);
    if (savedPrimary.length || savedSecondary.length) {
      setPrimaryList(savedPrimary);
      setSecondaryList(savedSecondary);
      setCandidates([...savedPrimary, ...savedSecondary]);
      return true;
    }
    return false;
  }

  // Persist the approved picks. Fire-and-forget: failing to record an approval
  // must never block the user from generating.
  async function persistKeywords(primary, secondary, pool, approved = true) {
    if (!serviceId || !locationId || !primary.length) return;
    try {
      await lpb.wizardSaveKeywords({
        clientId: GD_CLIENT_ID, serviceId, locationId,
        primary, secondary, candidates: pool || candidates, approved,
      });
    } catch (e) { console.warn('Failed to save approved keywords (non-fatal):', e.message); }
  }

  async function runKeywordResearch() {
    const token = ++kwRequestRef.current;
    const isCurrent = () => token === kwRequestRef.current;
    setKwLoading(true); setKwError('');
    try {
      const res = await lpb.keywordCandidates({
        service: service.name, city: location.city, state: location.state_abbreviation, seedQuery: derived.seedQuery,
        // Lets Secondary legitimately name this office's own broader region
        // and state while every rival city stays blocked.
        stateName: location.state, region: location.region,
        clientId: GD_CLIENT_ID, serviceSlug: service.slug,
      });
      // A newer selection superseded this request while it was in flight --
      // drop the result rather than overwrite the current pair's state.
      if (!isCurrent()) return;
      // Default the arrays: the response shape is { candidates, primary,
      // secondary, ... }, and persistKeywords below reads primary.length, so a
      // missing field would surface as a TypeError in the catch instead of a
      // useful message.
      const results = res.candidates || [];
      const primary = res.primary || [];
      const secondary = res.secondary || [];
      const { lowVolume, reviewFailures } = res;
      setCandidates(results);
      // Server pre-selects Primary/Secondary: volume-sorted, then Claude
      // Sonnet-checked for location/topical relevance and swapped from the
      // extended pool when a top-volume pick doesn't hold up, then reviewed
      // by a second Claude pass.
      setPrimaryList(primary);
      setSecondaryList(secondary);
      setKwLowVolume(!!lowVolume);
      setKwReviewFailures(reviewFailures || []);
      persistKeywords(primary, secondary, results, false);
    } catch (e) {
      if (!isCurrent()) return;
      setKwError(e.message);
    } finally {
      if (isCurrent()) setKwLoading(false);
    }
  }

  // Entering step 2: restore the saved approval first and only fall back to the
  // billed research call when there is genuinely nothing stored for this tuple.
  useEffect(() => {
    if (step !== 1 || candidates.length || kwLoading || kwError || !service || !location) return;
    let cancelled = false;
    (async () => {
      setKwLoading(true);
      const restored = await hydrateKeywords({ serviceId, locationId, page });
      if (cancelled) return;
      setKwLoading(false);
      if (!restored) runKeywordResearch();
    })();
    return () => { cancelled = true; };
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
      setPageId(result.pageId || null);
      applyQc(result.page.qc);
      setDirty(false);
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

  // qcRef shadows the qc state so a queued request can read the result the
  // request before it produced. React state is not visible to code that runs
  // before the next render, and rechecks are chained — so every write to qc
  // goes through commitQc, which updates both.
  function commitQc(next) {
    qcRef.current = next || null;
    setQc(next || null);
  }

  // Every wholesale replacement of the QC result goes through here: a
  // confirmation or an in-flight recheck belongs to the result it was computed
  // from, and must not survive a regenerate, a reload, or a reset.
  function applyQc(next) {
    Object.values(recheckTimers.current).forEach(clearTimeout);
    recheckTimers.current = {};
    setRecheckPassed({});
    setRechecking({});
    setQcError('');
    commitQc(next);
  }

  // pageId is withheld while there are unsaved edits: the verdict would be
  // computed from content the store does not have, and persisting it would
  // leave the record claiming a result its own content does not produce.
  // Saving re-runs QC server-side over what it stored, so nothing is lost.
  //
  // Queued with the rechecks so a full pass and a single check can't land out
  // of order and overwrite each other.
  async function runQc() {
    setQcLoading(true);
    setQcError('');
    qcQueue.current = qcQueue.current.then(async () => {
      try { applyQc(await lpb.wizardQc(page, dirty ? null : pageId)); }
      catch (e) { setQcError(e.message); /* keep the prior result on screen */ }
    }, () => {});
    await qcQueue.current;
    setQcLoading(false);
  }

  // Re-run ONE check against the current (possibly unsaved) edits — the
  // per-notice Recheck button.
  //
  // Queued, not fired in parallel. Each recheck sends the check list the client
  // holds and gets back that list with one entry replaced; two in flight at
  // once would both send the SAME list, and whichever replied last would undo
  // the other's fix — the reviewer fixes two fields, rechecks both, and one
  // notice stubbornly stays. Chaining them means each sends what the previous
  // one produced.
  async function recheck(id) {
    if (!page || !id) return;
    setRechecking(prev => ({ ...prev, [id]: true }));
    setQcError('');
    // Retire any standing confirmation for this check before re-running it:
    // one that passes, is edited again and now fails would otherwise show its
    // failure and a stale "now passes" side by side.
    clearTimeout(recheckTimers.current[id]);
    delete recheckTimers.current[id];
    setRecheckPassed(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    qcQueue.current = qcQueue.current.then(() => sendRecheck(id), () => sendRecheck(id));
    await qcQueue.current;
  }

  async function sendRecheck(id) {
    try {
      // Same rule as runQc: never persist a verdict for unsaved content.
      // qcRef, not qc — a queued recheck must build on the list the one before
      // it produced, not the one captured when its button was clicked.
      const result = await lpb.wizardQcCheck(page, dirty ? null : pageId, id, qcRef.current?.checks || []);
      commitQc({ verdict: result.verdict, checks: result.checks });
      if (result.check?.pass) {
        setRecheckPassed(prev => ({ ...prev, [id]: result.check }));
        recheckTimers.current[id] = setTimeout(() => {
          delete recheckTimers.current[id];
          setRecheckPassed(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, 6000);
      }
    } catch (e) { setQcError(e.message); }
    setRechecking(prev => ({ ...prev, [id]: false }));
  }

  const qcFailuresByField = useMemo(() => {
    const map = {};
    for (const c of qc?.checks || []) {
      if (c.pass) continue;
      (map[qcFieldOf(c)] = map[qcFieldOf(c)] || []).push(c);
    }
    return map;
  }, [qc]);

  // Every notice belonging to one control: outstanding failures, plus anything
  // that just passed a recheck here. Checks carrying per-block detail
  // (readability) are left to qcBlockNotice so they land on the offending
  // block instead of the section header.
  function qcNotices(field) {
    const failures = (qcFailuresByField[field] || []).filter(c => !c.blocks);
    const passed = Object.values(recheckPassed).filter(c => qcFieldOf(c) === field);
    if (!failures.length && !passed.length) return null;
    return (
      <>
        {failures.map(c => (
          <QcNotice key={qcKeyOf(c)} check={c} busy={!!rechecking[c.id]} onRecheck={c.id ? () => recheck(c.id) : null} />
        ))}
        {passed.map(c => <QcNotice key={`ok:${qcKeyOf(c)}`} check={c} />)}
      </>
    );
  }

  // A readability failure names the blocks it found: show each finding under
  // the block that has to be rewritten.
  function qcBlockNotice(index) {
    const check = (qcFailuresByField.educationalBody || []).find(c => c.blocks && c.blocks[index] != null);
    if (!check) return null;
    return <QcNotice check={check} detail={check.blocks[index]} busy={!!rechecking[check.id]} onRecheck={() => recheck(check.id)} />;
  }

  function updateSection(mutate) {
    setPage(prev => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setDirty(true);
  }

  // Manual edits were previously held in React state only and lost the moment
  // the user navigated away — this is what actually persists them.
  async function saveContent() {
    if (!pageId || !page) return false;
    setSaving(true); setSaveError('');
    try {
      const result = await lpb.wizardSaveContent(pageId, page);
      // The server re-runs QC over what it stored, so adopt that verdict rather
      // than leaving a stale one on screen.
      if (result?.qc) applyQc(result.qc);
      setDirty(false);
      setSaving(false);
      return true;
    } catch (e) {
      setSaveError(e.message);
      setSaving(false);
      return false;
    }
  }

  // Confirm was a purely local flag; make it commit the edits first so a
  // confirmed page is a saved page.
  async function confirmPage() {
    if (dirty && pageId && !(await saveContent())) return;
    setConfirmed(true);
  }

  // "Option to regenerate every section" — one small targeted call per
  // section instead of re-running (and re-billing) the whole page. Always
  // updates the SAME saved page record (server enforces one-per-tuple).
  async function regenerate(section, blockIndex) {
    // The server regenerates from the page it has stored, so any unsaved edit
    // in this tab would be silently overwritten by the response. Commit first
    // and abort if that fails, rather than losing the user's work.
    if (dirty && pageId && !(await saveContent())) return;
    const key = blockIndex != null ? `${section}:${blockIndex}` : section;
    setRegenerating(prev => ({ ...prev, [key]: true }));
    setRegenError('');
    try {
      const result = await lpb.wizardRegenerate({ clientId: GD_CLIENT_ID, serviceId, locationId, section, blockIndex });
      setPage(result.page);
      setPageId(result.pageId || pageId);
      applyQc(result.page.qc);
      setDirty(false); // the server persisted this regeneration
    } catch (e) {
      setRegenError(e.message);
    }
    setRegenerating(prev => ({ ...prev, [key]: false }));
  }

  // The thresholds QC gates on, fetched once so a target shown next to a field
  // is the same number the check enforces. Empty until it resolves (and if it
  // fails), which just means counts render without a target.
  const [contentLimits, setContentLimits] = useState({});
  useEffect(() => {
    let live = true;
    lpb.contentLimits()
      .then(l => { if (live) setContentLimits(l || {}); })
      .catch(() => { /* counts still render, just without targets */ });
    return () => { live = false; };
  }, []);

  const [docxBusy, setDocxBusy] = useState(false);
  const [docxError, setDocxError] = useState('');

  // Exports what is ON SCREEN, including unsaved edits — the route takes the
  // page in the request body rather than reading it back by id.
  async function downloadDocx() {
    setDocxBusy(true); setDocxError('');
    try {
      const { blob, filename } = await lpb.wizardExportDocx(page);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setDocxError(e.message);
    }
    setDocxBusy(false);
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
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setKwLowVolume(false); setKwReviewFailures([]); setManualKeyword(''); setShowAllKeywords(false);
    setPage(null); setPageId(null); applyQc(null); setConfirmed(false); setGenError(''); setKwError(''); setExistingPage(null); setRegenError('');
    setDirty(false); setSaving(false); setSaveError('');
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
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                <span>Service</span>
                <span style={{ fontWeight: 400, fontSize: '0.6875rem', color: 'var(--text-3)', marginLeft: 'auto' }}>
                  {gdData.services.length} available
                </span>
                {/* The service list is reference data in the database, so a
                    taxonomy change in seed.js only appears after a re-seed.
                    This is safe to re-run: hand-entered NAP is preserved
                    (see seed.mergeLocation). */}
                <button
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: '0.6875rem', color: 'var(--primary)', cursor: seeding ? 'default' : 'pointer', textDecoration: 'underline' }}
                  disabled={seeding}
                  title="Re-import the service and location list. Addresses, phone numbers and hours you have entered are kept."
                  onClick={seedGentleDental}
                >
                  {seeding ? 'Syncing…' : 'Sync list'}
                </button>
              </label>
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

          {/* At least one Primary slot could not be filled from real research
              — either nothing qualified, or the review pass rejected what did
              — so it carries a service+location keyword at zero volume. Say
              which, and say it plainly, rather than letting a 0 pass unnoticed.
              The copy distinguishes "nothing was found" from "only some slots
              fell back", because claiming the former when a real keyword was
              found is simply false. */}
          {/* Driven by what is CURRENTLY in primaryList, not by the flag the
              server returned. The user can swap a synthesized keyword out for
              a real one right here; gating on the stale server verdict left the
              warning up afterwards, reading "0 of 1 Primary keywords have very
              low or no search volume". kwLowVolume is still the server's
              verdict and is kept for the research-time reasons list. */}
          {!kwLoading && (() => {
            const synth = primaryList.filter(k => k.source === 'synthesized');
            const allSynth = synth.length > 0 && synth.length === primaryList.length;
            if (!synth.length && !kwReviewFailures.length) return null;
            return (
              <div style={{
                background: 'var(--warning-soft,#FFFBEB)', color: 'var(--warning,#B45309)',
                padding: '0.875rem 1rem', borderRadius: 'var(--r-lg)', fontSize: '0.8125rem',
              }}>
                {!!synth.length && (
                  <>
                    <strong>
                      {allSynth
                        ? 'These keywords have very low or no search volume.'
                        : `${synth.length} of ${primaryList.length} Primary keywords have very low or no search volume.`}
                    </strong>{' '}
                    {allSynth
                      ? `No keyword combining “${service?.name}” with “${location?.city}” survived the SERP and keyword-database research, so Primary has been built from the service and location name instead.`
                      : `Research did not fill every Primary slot, so ${synth.length === 1 ? 'one has' : `${synth.length} have`} been built from the service and location name instead.`}
                    {' '}Keywords shown with “—” volume have no recorded searches — expect
                    little organic demand for those terms.
                  </>
                )}
                {!!kwReviewFailures.length && (
                  <>
                    <div style={{ marginTop: synth.length ? '0.5rem' : 0, fontWeight: 600 }}>
                      Rejected by the review pass:
                    </div>
                    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                      {kwReviewFailures.map((f, i) => (
                        <li key={i}>[{f.slot}] {f.keyword} — {f.reason}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            );
          })()}

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
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.volume > 0 ? kw.volume.toLocaleString() : '—'}</td>
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
            <button style={btnStyle(true)} disabled={!primaryList.length} onClick={() => { persistKeywords(primaryList, secondaryList); setStep(2); }}>Next →</button>
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
              <button style={btnStyle(dirty)} disabled={saving || !dirty || !pageId} onClick={saveContent}>
                {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
              <CopyButton label="Copy All (HTML)" getText={() => buildCopyAllHtml(page)} getHtml={() => buildCopyAllHtml(page)} />
              <button style={btnStyle(false)} disabled={docxBusy} onClick={downloadDocx}>
                {docxBusy ? 'Building DOCX…' : 'Download DOCX'}
              </button>
              <button style={btnStyle(false)} onClick={downloadJson}>Download JSON</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button style={btnStyle(false)} onClick={() => setStep(1)}>← Edit keywords</button>
              {!confirmed
                ? <button style={btnStyle(true)} disabled={saving} onClick={confirmPage}>Confirm</button>
                : <button style={btnStyle(true)} onClick={resetWizard}>Generate another →</button>}
            </div>
          </div>

          {saveError && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem', fontSize: '0.8125rem', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
              <span>Could not save your edits: {saveError}</span>
              <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }} onClick={() => setSaveError('')}>×</button>
            </div>
          )}

          {docxError && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem', fontSize: '0.8125rem', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
              <span>Could not build the DOCX: {docxError}</span>
              <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }} onClick={() => setDocxError('')}>×</button>
            </div>
          )}

          {regenError && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem', fontSize: '0.8125rem', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
              <span>{regenError}</span>
              <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }} onClick={() => setRegenError('')}>×</button>
            </div>
          )}

          {qcError && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem', fontSize: '0.8125rem', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>
              Could not re-run that check: {qcError}
            </div>
          )}

          {/* The findings themselves live next to the fields they came from —
              this only says how many there are and where to look. */}
          {qc && (() => {
            const open = (qc.checks || []).filter(c => !c.pass);
            return (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{
                  padding: '0.5rem 0.75rem', borderRadius: 'var(--r-lg)', fontSize: '0.75rem',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: open.length ? 'var(--warning,#B45309)' : 'var(--success,#059669)',
                }}>
                  {open.length
                    ? `QC flagged ${open.length} item${open.length === 1 ? '' : 's'} — each is marked below, next to the field it came from. Fix it, then hit Recheck on that notice.`
                    : 'QC — every check passes.'}
                </div>
                {qcNotices('page')}
              </div>
            );
          })()}

          <SectionCard title="SEO Metadata" note={page.meta.urlPath}
            actions={<>
              <RegenButton busy={!!regenerating.metaDescription} onClick={() => regenerate('metaDescription')} label="⟳ Regenerate description" />
              <CopyButton label="Copy" getText={() => sectionBuilders.meta(page).text} getHtml={() => sectionBuilders.meta(page).html} />
            </>}>
            <FieldLabel value={page.meta.title}>
              Title Tag <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>(deterministic — service + city + state)</span>
            </FieldLabel>
            <input style={{ ...inputStyle, marginBottom: '0.5rem' }} value={page.meta.title}
              onChange={e => updateSection(p => { p.meta.title = e.target.value; })} />
            {qcNotices('meta.title')}
            <FieldLabel value={page.meta.metaDescription} limit={contentLimits.metaDescription}>Meta Description</FieldLabel>
            <textarea style={inputStyle} rows={2} value={page.meta.metaDescription}
              onChange={e => updateSection(p => { p.meta.metaDescription = e.target.value; })} />
            {qcNotices('meta.metaDescription')}
          </SectionCard>

          <SectionCard title="Hero"
            actions={<>
              <RegenButton busy={!!regenerating.heroIntro} onClick={() => regenerate('heroIntro')} />
              <CopyButton label="Copy" getText={() => sectionBuilders.hero(page).text} getHtml={() => sectionBuilders.hero(page).html} />
            </>}>
            <FieldLabel value={page.sections.hero.h1}>H1 (deterministic)</FieldLabel>
            <div style={{ ...inputStyle, marginBottom: '0.5rem', background: 'var(--surface)', color: 'var(--text-2)' }}>{page.sections.hero.h1}</div>
            {qcNotices('hero.h1')}
            <FieldLabel value={page.sections.hero.intro} words>
              Intro <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>(below the H1 — commercial: patient outcome, then the next step)</span>
            </FieldLabel>
            <textarea style={inputStyle} rows={2} value={page.sections.hero.intro}
              onChange={e => updateSection(p => { p.sections.hero.intro = e.target.value; })} />
            {qcNotices('hero.intro')}
          </SectionCard>

          <SectionCard title="Educational Body"
            actions={<>
              <RegenButton busy={!!regenerating.educationalBody} onClick={() => regenerate('educationalBody')} label="⟳ Regenerate all" />
              <CopyButton label="Copy" getText={() => sectionBuilders.educationalBody(page).text} getHtml={() => sectionBuilders.educationalBody(page).html} />
            </>}>
            <OutlineNote meta={page.outlineMeta} />
            {qcNotices('educationalBody')}
            {page.sections.educationalBody.blocks.map((b, i) => (
              <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < page.sections.educationalBody.blocks.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem', alignItems: 'center' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={b.h2}
                    onChange={e => updateSection(p => { p.sections.educationalBody.blocks[i].h2 = e.target.value; })} />
                  <SourceTag source={page.outlineMeta?.sources?.[i]?.source} />
                  <RegenButton busy={!!regenerating[`educationalBlock:${i}`]} onClick={() => regenerate('educationalBlock', i)} label="⟳" />
                </div>
                <div style={{ display: 'flex', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.6875rem', color: 'var(--text-3)' }}>H2</span>
                  <CharCount value={b.h2} />
                </div>
                {/* Edited as clean plain text — no visible <p>/<ul> markup — and
                    reconstructed into semantic HTML on change. */}
                <textarea style={inputStyle} rows={4} value={htmlBlockToPlainText(b.html)}
                  onChange={e => updateSection(p => { p.sections.educationalBody.blocks[i].html = plainTextToHtmlBlock(e.target.value); })} />
                <div style={{ display: 'flex' }}><CharCount value={htmlBlockToPlainText(b.html)} words /></div>
                {qcBlockNotice(i)}
              </div>
            ))}
          </SectionCard>

          <SectionCard title="FAQ"
            actions={<>
              <RegenButton busy={!!regenerating.faqs} onClick={() => regenerate('faqs')} label="⟳ Regenerate all" />
              <CopyButton label="Copy" getText={() => sectionBuilders.faq(page).text} getHtml={() => sectionBuilders.faq(page).html} />
            </>}>
            {qcNotices('faq')}
            {page.sections.faq.items.map((f, i) => (
              <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < page.sections.faq.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={f.q}
                    onChange={e => updateSection(p => { p.sections.faq.items[i].q = e.target.value; })} />
                  <RegenButton busy={!!regenerating[`faqItem:${i}`]} onClick={() => regenerate('faqItem', i)} label="⟳" />
                </div>
                <div style={{ display: 'flex', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.6875rem', color: 'var(--text-3)' }}>Question</span>
                  <CharCount value={f.q} />
                </div>
                <textarea style={inputStyle} rows={2} value={f.a}
                  onChange={e => updateSection(p => { p.sections.faq.items[i].a = e.target.value; })} />
                <div style={{ display: 'flex' }}>
                  <CharCount value={f.a} words limitWords={contentLimits.faqAnswerMaxWords} />
                </div>
              </div>
            ))}
          </SectionCard>

          <SectionCard title="Schema (JSON-LD)" note="Deterministic + generated — 5 blocks">
            {qcNotices('schema')}
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
