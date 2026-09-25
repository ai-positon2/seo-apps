// ── Template-driven Location + Service wizard (docs/ybh-ls-pages.md) ────────
// One component, driven entirely by the `clientId` it is handed, so each brand
// gets its own route without a second copy of this screen (see
// pages/ClearBehavioralHealthPage.jsx).
//
// Five steps, in the order the SEO team works:
//   0 Location + Service   pick the combination, see the URL it will live at
//   1 Keyword Research     billed SERP + SEMrush pull, edit the lists
//   2 Finalize Keywords    sign the list off; this is what gets persisted
//   3 Content Brief        the template's §15 deliverable, EDITABLE, then approved
//   4 Written Content      copy written from the approved brief, EDITABLE
//
// Steps 3 and 4 are the reason this is not the Gentle Dental wizard, where
// planning and writing are one call and the outline is never editable. Here
// the brief is a deliverable in its own right and approval is a real state
// transition — the copy is written from the APPROVED brief, so re-planning
// after copy exists leaves the copy in place and QC reports it as stale rather
// than silently overwriting reviewed work.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { lpb } from '../../lib/lpbApi';
import { lsPages, saveBlob } from '../../lib/lsPagesApi';
import { ProgressSteps } from '../../ui/ProgressSteps';
import ModuleRuns from '../ModuleRuns';

const STEPS = ['Location + Service', 'Keyword Research', 'Finalize Keywords', 'Content Brief', 'Written Content'];
const MAX_PRIMARY = 2;
const MAX_SECONDARY = 10;

// ── Small shared bits ───────────────────────────────────────────────────────
const btn = (primary, extra = {}) => ({
  padding: '0.5rem 0.9rem', fontSize: '0.8125rem', fontWeight: 600, borderRadius: 'var(--r-md,6px)',
  border: primary ? 'none' : '1px solid var(--border)', cursor: 'pointer',
  background: primary ? 'var(--primary)' : 'var(--card)', color: primary ? '#fff' : 'var(--text-2)',
  ...extra,
});
const inputStyle = {
  width: '100%', padding: '0.5rem 0.625rem', fontSize: '0.8125rem', borderRadius: 'var(--r-md,6px)',
  border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)',
  boxSizing: 'border-box', fontFamily: 'inherit',
};
const labelStyle = { display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.375rem' };
const cardStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '1.5rem' };
const removeBtn = {
  border: 'none', background: 'none', color: 'var(--text-3)', cursor: 'pointer',
  fontSize: '1rem', lineHeight: 1, padding: '0 0.25rem',
};

function Banner({ tone = 'danger', children, onDismiss }) {
  const palette = {
    danger: ['var(--danger-soft,#FEF2F2)', 'var(--danger,#EF4444)'],
    warning: ['var(--warning-soft,#FFFBEB)', 'var(--warning,#B45309)'],
    info: ['var(--surface)', 'var(--text-2)'],
    success: ['var(--success-soft,#ECFDF5)', 'var(--success,#059669)'],
  }[tone];
  return (
    <div style={{
      padding: '0.625rem 0.875rem', borderRadius: 'var(--r-lg)', marginBottom: '0.75rem',
      fontSize: '0.8125rem', background: palette[0], color: palette[1],
      display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start',
    }}>
      <div>{children}</div>
      {onDismiss && (
        <button style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontWeight: 700 }} onClick={onDismiss}>×</button>
      )}
    </div>
  );
}

function SectionCard({ title, note, actions, children }) {
  return (
    <div style={{ ...cardStyle, padding: '1.25rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.875rem' }}>
        <div>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h3>
          {note && <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: '0.125rem' }}>{note}</div>}
        </div>
        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>{actions}</div>
      </div>
      {children}
    </div>
  );
}

// Character / word counter that knows the target it will be JUDGED against —
// the limits come from the server (lsQa.lsLimits), never from a copy in this
// file, so a number shown here can never differ from the one QC gates on.
function Counter({ value, limit, words, limitWords }) {
  const raw = String(value || '');
  const count = words ? (raw.trim() ? raw.trim().split(/\s+/).length : 0) : raw.length;
  const min = words ? (limitWords?.min ?? limit?.minWords) : limit?.min;
  const max = words ? (limitWords?.max ?? limitWords ?? limit?.maxWords ?? limit?.max) : limit?.max;
  const ok = (min == null || count >= min) && (max == null || count <= max);
  return (
    <span style={{
      marginLeft: 'auto', fontSize: '0.6875rem', fontVariantNumeric: 'tabular-nums',
      color: (min == null && max == null) ? 'var(--text-3)' : ok ? 'var(--success,#059669)' : 'var(--warning,#B45309)',
    }}>
      {count}{max != null ? ` / ${min != null ? `${min}-${max}` : max}` : ''} {words ? 'words' : 'chars'}
    </span>
  );
}

function FieldLabel({ children, value, limit, words, limitWords }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)' }}>{children}</span>
      <Counter value={value} limit={limit} words={words} limitWords={limitWords} />
    </div>
  );
}

function RegenButton({ busy, onClick, label = '⟳ Regenerate' }) {
  return (
    <button style={btn(false, { fontSize: '0.6875rem', padding: '0.25rem 0.5rem', opacity: busy ? 0.6 : 1 })} disabled={busy} onClick={onClick}>
      {busy ? '…' : label}
    </button>
  );
}

function PickerList({ groups, selectedId, onSelect, emptyMessage }) {
  const flat = groups.flatMap(([, items]) => items);
  return (
    <div style={{ height: '20rem', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', background: 'var(--surface)' }}>
      {!flat.length && <p style={{ padding: '0.75rem', fontSize: '0.75rem', color: 'var(--text-3)', margin: 0 }}>{emptyMessage}</p>}
      {groups.map(([label, items]) => (
        <div key={label}>
          <div style={{
            position: 'sticky', top: 0, zIndex: 1, display: 'flex', justifyContent: 'space-between',
            padding: '0.25rem 0.625rem', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-3)',
            background: 'var(--surface)', borderBottom: '1px solid var(--border)',
            textTransform: 'uppercase', letterSpacing: '0.03em',
          }}>
            <span>{label}</span><span style={{ fontWeight: 400 }}>{items.length}</span>
          </div>
          {items.map((item) => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id} type="button" onClick={() => onSelect(item.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '0.375rem 0.625rem',
                  fontSize: '0.8125rem', border: 'none', cursor: 'pointer',
                  background: active ? 'var(--primary-soft)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text)', fontWeight: active ? 600 : 400,
                }}
              >
                {item.label}
                {item.sub && <span style={{ color: 'var(--text-3)', fontSize: '0.6875rem' }}> — {item.sub}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Provenance of one brief section: whether the topic came from a competitor,
// the fallback ladder, or a blend of both (template §7's grading).
function SourceTag({ source }) {
  if (!source) return null;
  const palette = {
    competitor: ['var(--info-soft)', 'var(--info)'],
    blend: ['var(--primary-soft)', 'var(--primary)'],
    fallback: ['var(--surface)', 'var(--text-3)'],
  }[source] || ['var(--surface)', 'var(--text-3)'];
  return (
    <span style={{
      fontSize: '0.625rem', fontWeight: 700, padding: '2px 6px', borderRadius: 99,
      background: palette[0], color: palette[1], textTransform: 'uppercase', letterSpacing: '0.03em',
      whiteSpace: 'nowrap',
    }}>{source}</span>
  );
}

// ── Body HTML <-> plain text ────────────────────────────────────────────────
// Section bodies store real HTML (<p>/<ul>/<li>) — the schema, the QC gates and
// the exports all need it. Showing raw markup in a textarea is noise, so these
// convert between the stored HTML and a clean editing view: blank-line
// separated paragraphs, "- " prefixed list items.
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function htmlToPlain(html) {
  let s = String(html || '');
  s = s.replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<p[^>]*>/gi, '').replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
function plainToHtml(value) {
  const out = [];
  let list = [];
  let para = [];
  const flushList = () => { if (list.length) { out.push(`<ul>${list.map(li => `<li>${escapeHtml(li)}</li>`).join('')}</ul>`); list = []; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${escapeHtml(para.join(' ').trim())}</p>`); para = []; } };
  for (const raw of String(value || '').split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }
    if (line.startsWith('- ')) { flushPara(); list.push(line.slice(2).trim()); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function copyToClipboard(text, html) {
  try {
    if (html && navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
}

function CopyButton({ label = 'Copy', getText, getHtml }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      style={btn(false, {
        fontSize: '0.6875rem', padding: '0.25rem 0.5rem',
        color: copied ? 'var(--success,#059669)' : 'var(--text-2)',
      })}
      onClick={async () => {
        const ok = await copyToClipboard(getText(), getHtml?.());
        if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
      }}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function pageAsText(page) {
  const s = page.sections;
  return [
    s.hero.h1, s.hero.oneLiner,
    ...s.body.blocks.map(b => `${b.h2}\n\n${stripHtml(b.html)}`),
    s.faq.heading, s.faq.intro,
    ...s.faq.items.map(f => `Q: ${f.q}\nA: ${f.a}`),
  ].filter(Boolean).join('\n\n');
}
function pageAsHtml(page) {
  const s = page.sections;
  return [
    `<h1>${escapeHtml(s.hero.h1)}</h1><p>${escapeHtml(s.hero.oneLiner)}</p>`,
    ...s.body.blocks.map(b => `<h2>${escapeHtml(b.h2)}</h2>${b.html}`),
    `<h2>${escapeHtml(s.faq.heading)}</h2>${s.faq.intro ? `<p>${escapeHtml(s.faq.intro)}</p>` : ''}${s.faq.items.map(f => `<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`).join('')}`,
  ].join('\n');
}

const keyOf = kw => String(kw?.keyword || '').trim().toLowerCase();

export default function LsWizard({
  clientId,
  title,
  subtitle,
  seed,             // () => Promise — re-imports this client's reference data
  seedLabel = 'Sync list',
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [step, setStep] = useState(0);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [limits, setLimits] = useState({});

  const [serviceId, setServiceId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [svcFilter, setSvcFilter] = useState('');
  const [locFilter, setLocFilter] = useState('');
  const [savedPages, setSavedPages] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [existing, setExisting] = useState(null);

  const [candidates, setCandidates] = useState([]);
  const [primaryList, setPrimaryList] = useState([]);
  const [secondaryList, setSecondaryList] = useState([]);
  const [reviewFailures, setReviewFailures] = useState([]);
  const [manualKeyword, setManualKeyword] = useState('');
  const [showAllKeywords, setShowAllKeywords] = useState(false);
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState('');

  const [page, setPage] = useState(null);
  const [pageId, setPageId] = useState(null);
  const [brief, setBrief] = useState(null);
  const [competitorUrls, setCompetitorUrls] = useState('');
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [regenerating, setRegenerating] = useState({});
  const [regenError, setRegenError] = useState('');

  const [qc, setQc] = useState(null);
  const [qcBusy, setQcBusy] = useState(false);
  const [qcError, setQcError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [exportBusy, setExportBusy] = useState('');

  const service = useMemo(() => data?.services.find(s => s.id === serviceId) || null, [data, serviceId]);
  const location = useMemo(() => data?.locations.find(l => l.id === locationId) || null, [data, locationId]);
  const tuple = useMemo(() => ({ clientId, serviceId, locationId }), [clientId, serviceId, locationId]);

  // ── Reference data ────────────────────────────────────────────────────────
  const loadClient = useCallback(async () => {
    setLoadError('');
    try {
      const [client, rows, lim] = await Promise.all([
        lpb.client(clientId),
        lsPages.pages(clientId).catch(() => []),
        lsPages.contentLimits(clientId).catch(() => ({})),
      ]);
      setData(client);
      setSavedPages(rows);
      setLimits(lim);
      if (!client.services.length || !client.locations.length) {
        setLoadError('This client has no services or locations yet. Run the sync to import the client list.');
      }
    } catch (e) {
      setLoadError(e.message);
    }
  }, [clientId]);

  useEffect(() => { loadClient(); }, [loadClient]);

  // The module's own delete route, which also drops the page's approved-keyword
  // record so nothing is orphaned behind it (see routes/locationPageBuilder.js).
  async function removePage(row) {
    const label = [row.service_name, row.location_name].filter(Boolean).join(' — ') || row.url_path || row.id;
    if (!window.confirm(`Permanently delete "${label}"? Its brief, content and approved keywords cannot be recovered.`)) return;
    setDeletingId(row.id);
    try {
      await lpb.deletePage(row.id);
      setSavedPages(await lsPages.pages(clientId));
    } catch (e) {
      setLoadError(e.message);
    }
    setDeletingId(null);
  }

  async function runSeed() {
    if (!seed) return;
    setSeeding(true);
    try {
      const result = await seed();
      await loadClient();
      if (result?.reference_data_missing) {
        setLoadError('The sync ran, but this client\'s reference-data file is still empty — paste the service and location list into it first.');
      }
    } catch (e) {
      setLoadError(e.message);
    }
    setSeeding(false);
  }

  // ── Opening a saved page ──────────────────────────────────────────────────
  // Deep-linked from the saved-pages table, so a reviewer can come back to a
  // page without walking the picker again. Jumps straight to the furthest step
  // the page has actually reached.
  const openPageId = searchParams.get('pageId');
  useEffect(() => {
    if (!openPageId || !data) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await lsPages.page(openPageId);
        if (cancelled) return;
        setServiceId(res.serviceId);
        setLocationId(res.locationId);
        setPageId(res.pageId);
        setPage(res.page);
        setBrief(res.page.brief || null);
        setQc(res.page.qc || null);
        setPrimaryList((res.page.primaryKeywords || []).map(k => (typeof k === 'string' ? { keyword: k } : k)));
        setSecondaryList((res.page.secondaryKeywords || []).map(k => (typeof k === 'string' ? { keyword: k } : k)));
        setCompetitorUrls((res.page.briefMeta?.competitorUrls || []).join('\n'));
        setStep((res.page.sections?.body?.blocks || []).length ? 4 : res.page.brief ? 3 : 0);
        setDirty(false);
      } catch (e) {
        setLoadError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [openPageId, data]);

  // ── Step 0 ────────────────────────────────────────────────────────────────
  const groupedServices = useMemo(() => {
    if (!data) return [];
    const q = svcFilter.trim().toLowerCase();
    const matched = data.services.filter(s => !q || `${s.name} ${s.category || ''}`.toLowerCase().includes(q));
    const byCategory = new Map();
    matched.forEach((s) => {
      const key = s.category || 'Services';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push({ id: s.id, label: s.name });
    });
    return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, svcFilter]);

  const groupedLocations = useMemo(() => {
    if (!data) return [];
    const q = locFilter.trim().toLowerCase();
    const matched = data.locations.filter(l => !q || `${l.location_name} ${l.city} ${l.region || ''} ${l.state || ''}`.toLowerCase().includes(q));
    const byRegion = new Map();
    matched.forEach((l) => {
      const key = l.region || l.state || 'Locations';
      if (!byRegion.has(key)) byRegion.set(key, []);
      byRegion.get(key).push({
        id: l.id,
        label: l.location_name || l.city,
        // The NAP gaps are shown at the point of CHOOSING a location, not only
        // once the page is generated: §6 makes them a data problem to solve
        // with the client, and knowing before you spend a billed research call
        // is strictly better.
        sub: (l.nap_todo || []).length ? `${l.nap_todo.length} data field(s) missing` : '',
      });
    });
    return [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, locFilter]);

  // Checks for a page already built for this combination, so step 0 can offer
  // to open it rather than letting the reviewer re-run a billed research call
  // and overwrite reviewed work.
  useEffect(() => {
    if (!serviceId || !locationId || openPageId) { setExisting(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await lsPages.existing(tuple);
        if (!cancelled) setExisting(res.exists ? res : null);
      } catch { /* a failed check must not block the step */ }
    })();
    return () => { cancelled = true; };
  }, [serviceId, locationId, tuple, openPageId]);

  // ── Step 1: keyword research ──────────────────────────────────────────────
  // Rehydrates a saved selection FIRST and only calls the billed endpoint when
  // there is nothing to restore — re-opening a page must never silently re-bill
  // SEMrush.
  const loadKeywords = useCallback(async ({ force } = {}) => {
    if (!service || !location) return;
    setKwError('');
    setKwLoading(true);
    try {
      if (!force) {
        const saved = await lsPages.getKeywords(tuple);
        if (saved.exists && (saved.primary.length || saved.candidates.length)) {
          setCandidates(saved.candidates || []);
          setPrimaryList(saved.primary || []);
          setSecondaryList(saved.secondary || []);
          setReviewFailures([]);
          setKwLoading(false);
          return;
        }
      }
      const res = await lsPages.keywordCandidates(tuple);
      setCandidates(res.candidates || []);
      setPrimaryList(res.primary || []);
      setSecondaryList((res.secondary || []).slice(0, MAX_SECONDARY));
      setReviewFailures(res.reviewFailures || []);
      // Saved unapproved: this is the pool, not a sign-off, and persisting it
      // is what stops a revisit from re-billing the research.
      await lsPages.saveKeywords({
        ...tuple, primary: res.primary || [], secondary: res.secondary || [],
        candidates: res.candidates || [], approved: false,
      }).catch(() => {});
    } catch (e) {
      setKwError(e.message);
    }
    setKwLoading(false);
  }, [service, location, tuple]);

  useEffect(() => {
    if (step === 1 && !candidates.length && !primaryList.length && !kwLoading && !kwError) loadKeywords();
  }, [step, candidates.length, primaryList.length, kwLoading, kwError, loadKeywords]);

  const availableKeywords = useMemo(() => {
    const taken = new Set([...primaryList, ...secondaryList].map(keyOf));
    return candidates.filter(c => !taken.has(keyOf(c)));
  }, [candidates, primaryList, secondaryList]);

  function addManualKeyword() {
    const value = manualKeyword.trim();
    if (!value) return;
    const row = { keyword: value, volume: 0, difficulty: 0, intent: 'commercial', source: 'manual' };
    if (!candidates.some(c => keyOf(c) === keyOf(row))) setCandidates(prev => [...prev, row]);
    if (primaryList.length < MAX_PRIMARY) setPrimaryList(prev => [...prev, row]);
    else if (secondaryList.length < MAX_SECONDARY) setSecondaryList(prev => [...prev, row]);
    setManualKeyword('');
  }

  async function finalizeKeywords() {
    setKwError('');
    try {
      await lsPages.saveKeywords({ ...tuple, primary: primaryList, secondary: secondaryList, candidates, approved: true });
      setStep(3);
      generateBrief();
    } catch (e) {
      setKwError(e.message);
    }
  }

  // ── Step 3: the brief ─────────────────────────────────────────────────────
  async function generateBrief() {
    setBriefError('');
    setBriefBusy(true);
    try {
      const urls = competitorUrls.split('\n').map(u => u.trim()).filter(Boolean);
      const res = await lsPages.generateBrief({
        ...tuple,
        primaryKeywords: primaryList.map(k => k.keyword),
        secondaryKeywords: secondaryList.map(k => k.keyword),
        competitorUrls: urls.length ? urls : null,
      });
      setPageId(res.pageId);
      setPage(res.page);
      setBrief(res.page.brief);
      setQc(res.page.qc || null);
      if (!urls.length) setCompetitorUrls((res.page.briefMeta?.competitorUrls || []).join('\n'));
    } catch (e) {
      setBriefError(e.message);
    }
    setBriefBusy(false);
  }

  function updateBrief(mutate) {
    setBrief((prev) => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
  }

  async function saveBriefEdits({ approve }) {
    setBriefError('');
    setBriefBusy(true);
    try {
      const res = await lsPages.saveBrief({ ...tuple, brief, approve });
      setPageId(res.pageId);
      setPage(res.page);
      setBrief(res.page.brief);
      setQc(res.page.qc || null);
      return true;
    } catch (e) {
      setBriefError(e.message);
      return false;
    } finally {
      setBriefBusy(false);
    }
  }

  // Approving and writing is one button because it is one decision: §15's
  // brief exists to be signed off before the expensive call runs.
  async function approveAndWrite() {
    if (!(await saveBriefEdits({ approve: true }))) return;
    setStep(4);
    await generateCopy();
  }

  // ── Step 4: the copy ──────────────────────────────────────────────────────
  async function generateCopy() {
    setCopyError('');
    setCopyBusy(true);
    try {
      const res = await lsPages.generateCopy(tuple);
      setPageId(res.pageId);
      setPage(res.page);
      setBrief(res.page.brief);
      setQc(res.page.qc || null);
      setDirty(false);
    } catch (e) {
      setCopyError(e.message);
    }
    setCopyBusy(false);
  }

  function updatePage(mutate) {
    setPage((prev) => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setDirty(true);
  }

  async function regenerate(field, index) {
    const key = index == null ? field : `${field}:${index}`;
    setRegenError('');
    setRegenerating(prev => ({ ...prev, [key]: true }));
    try {
      // Unsaved edits would be discarded by a server-side regeneration (it
      // works from the stored page), so they are flushed first rather than
      // silently lost.
      if (dirty && pageId) await persist();
      const res = await lsPages.regenerate({ ...tuple, field, index });
      setPage(res.page);
      setQc(res.page.qc || null);
      setDirty(false);
    } catch (e) {
      setRegenError(e.message);
    }
    setRegenerating(prev => ({ ...prev, [key]: false }));
  }

  async function persist() {
    if (!pageId || !page) return;
    setSaveError('');
    setSaving(true);
    try {
      const res = await lsPages.saveContent(pageId, page);
      setQc(res.qc || null);
      setDirty(false);
    } catch (e) {
      setSaveError(e.message);
    }
    setSaving(false);
  }

  async function runQc() {
    if (!page) return;
    setQcError('');
    setQcBusy(true);
    try {
      // The pageId is sent only when there is nothing unsaved: a verdict
      // computed from content the store does not have yet must not be written
      // against the content it does have.
      setQc(await lsPages.qc(page, dirty ? null : pageId, clientId));
    } catch (e) {
      setQcError(e.message);
    }
    setQcBusy(false);
  }

  async function recheck(id) {
    if (!page) return;
    setQcError('');
    try {
      const res = await lsPages.qcCheck(page, dirty ? null : pageId, clientId, id, qc?.checks || []);
      setQc({ verdict: res.verdict, checks: res.checks });
    } catch (e) {
      setQcError(e.message);
    }
  }

  async function download(format) {
    setExportBusy(format);
    try {
      saveBlob(await lsPages.download(format, page));
    } catch (e) {
      setSaveError(e.message);
    }
    setExportBusy('');
  }

  // QC failures are shown next to the field they came from, not in one list at
  // the top — a finding beside its control is a finding someone fixes.
  function qcNotices(field) {
    const open = (qc?.checks || []).filter(c => !c.pass && c.field === field);
    if (!open.length) return null;
    return open.map(c => (
      <div key={c.id} style={{
        marginTop: '0.375rem', padding: '0.5rem 0.625rem', borderRadius: 'var(--r-md,6px)',
        fontSize: '0.75rem', lineHeight: 1.5,
        background: c.severity === 'Critical' ? 'var(--danger-soft,#FEF2F2)' : c.severity === 'Major' ? 'var(--warning-soft,#FFFBEB)' : 'var(--surface)',
        color: c.severity === 'Critical' ? 'var(--danger,#EF4444)' : c.severity === 'Major' ? 'var(--warning,#B45309)' : 'var(--text-2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'baseline' }}>
          <strong>{c.severity}: {c.label}</strong>
          <button style={btn(false, { fontSize: '0.625rem', padding: '0.125rem 0.375rem' })} onClick={() => recheck(c.id)}>Recheck</button>
        </div>
        <div>{c.detail}</div>
        {c.fix && <div style={{ opacity: 0.85, marginTop: '0.125rem' }}>{c.fix}</div>}
      </div>
    ));
  }

  function qcBlockNotice(index) {
    const notes = (qc?.checks || [])
      .filter(c => !c.pass && c.blocks && c.blocks[index])
      .map(c => `${c.label}: ${c.blocks[index]}`);
    if (!notes.length) return null;
    return (
      <div style={{ marginTop: '0.25rem', fontSize: '0.6875rem', color: 'var(--warning,#B45309)' }}>
        {notes.map((n, i) => <div key={i}>{n}</div>)}
      </div>
    );
  }

  const derived = service && location ? {
    urlPath: `/locations/${location.location_slug || location.city}/${service.slug}`.toLowerCase().replace(/\s+/g, '-'),
    titleTag: `${service.name} in ${location.location_name || location.city} | ${data?.client?.name || ''}`,
  } : null;

  const progressSteps = STEPS.map((label, i) => ({
    label, status: i < step ? 'done' : i === step ? 'active' : 'pending', number: i + 1,
  }));

  function reset() {
    setStep(0); setServiceId(''); setLocationId('');
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setReviewFailures([]);
    setManualKeyword(''); setShowAllKeywords(false);
    setPage(null); setPageId(null); setBrief(null); setQc(null); setCompetitorUrls('');
    setDirty(false); setKwError(''); setBriefError(''); setCopyError(''); setRegenError(''); setSaveError('');
    setExisting(null);
    if (openPageId) setSearchParams({});
    loadClient();
  }

  return (
    <main style={{ maxWidth: '68rem', margin: '0 auto', padding: '2rem 1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>{title}</h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', marginTop: '0.25rem', margin: 0 }}>{subtitle}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {step > 0 && <button style={btn(false)} onClick={reset}>Start over</button>}
          <button style={btn(false)} onClick={() => navigate('/location-page-builder')}>← Module home</button>
        </div>
      </div>

      <div style={{ marginBottom: '1.5rem' }}><ProgressSteps steps={progressSteps} /></div>

      {loadError && (
        <Banner tone="warning">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>
              {/client not found/i.test(loadError)
                ? 'This client hasn’t been set up in the page builder yet. Set it up to load its services and locations; it takes a few seconds.'
                : loadError}
            </span>
            {seed && <button style={btn(true)} disabled={seeding} onClick={runSeed}>{seeding ? 'Setting up…' : seedLabel}</button>}
          </div>
        </Banner>
      )}

      {!data && !loadError && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}

      {/* ── Step 0: location + service ─────────────────────────────────── */}
      {data && step === 0 && (
        <div style={cardStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div>
              <label style={labelStyle}>Location</label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by city, region, state…" value={locFilter} onChange={e => setLocFilter(e.target.value)} />
              <PickerList groups={groupedLocations} selectedId={locationId} onSelect={setLocationId} emptyMessage="No locations match." />
              <div style={{ marginTop: '0.375rem', fontSize: '0.75rem', minHeight: '1.25rem' }}>
                {location
                  ? <span style={{ color: 'var(--success,#10B981)' }}>✓ <strong>{location.location_name || location.city}</strong></span>
                  : <span style={{ color: 'var(--text-3)' }}>No location selected</span>}
              </div>
            </div>
            <div>
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                <span>Service</span>
                <span style={{ fontWeight: 400, fontSize: '0.6875rem', color: 'var(--text-3)', marginLeft: 'auto' }}>{data.services.length} available</span>
                {seed && (
                  <button
                    style={{ background: 'none', border: 'none', padding: 0, fontSize: '0.6875rem', color: 'var(--primary)', cursor: seeding ? 'default' : 'pointer', textDecoration: 'underline' }}
                    disabled={seeding}
                    title="Re-import the service and location list. Addresses, phone numbers and hours you have entered are kept."
                    onClick={runSeed}
                  >
                    {seeding ? 'Syncing…' : seedLabel}
                  </button>
                )}
              </label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by service or category…" value={svcFilter} onChange={e => setSvcFilter(e.target.value)} />
              <PickerList groups={groupedServices} selectedId={serviceId} onSelect={setServiceId} emptyMessage="No services match." />
              <div style={{ marginTop: '0.375rem', fontSize: '0.75rem', minHeight: '1.25rem' }}>
                {service
                  ? <span style={{ color: 'var(--success,#10B981)' }}>✓ <strong>{service.name}</strong></span>
                  : <span style={{ color: 'var(--text-3)' }}>No service selected</span>}
              </div>
            </div>
          </div>

          {derived && (
            <div style={{ marginTop: '1.25rem', padding: '0.875rem 1rem', background: 'var(--surface)', borderRadius: 'var(--r-lg)', fontSize: '0.8125rem', color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div><strong style={{ color: 'var(--text)' }}>URL:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{derived.urlPath}</span></div>
              <div><strong style={{ color: 'var(--text)' }}>Title tag (fallback shape):</strong> {derived.titleTag}</div>
              {(location?.nap_todo || []).length > 0 && (
                <div style={{ color: 'var(--warning,#B45309)' }}>
                  <strong>Location data required from client:</strong> {location.nap_todo.join(', ')}. The page will flag these rather than invent them.
                </div>
              )}
            </div>
          )}

          {existing && (
            <Banner tone="warning">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span>
                  A page already exists for this combination{existing.updatedAt ? ` (updated ${new Date(existing.updatedAt).toLocaleDateString()})` : ''}
                  {existing.status ? ` — ${existing.status}` : ''}. Only one page per location + service is kept, so continuing will update it.
                </span>
                <button style={btn(true)} onClick={() => setSearchParams({ pageId: existing.pageId })}>Open existing →</button>
              </div>
            </Banner>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button style={btn(true)} disabled={!service || !location} onClick={() => setStep(1)}>Next: keyword research →</button>
          </div>

          {!!savedPages.length && (
            <div style={{ marginTop: '2rem' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.5rem' }}>Pages built for this client</h3>
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', overflow: 'hidden' }}>
                <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-2)', background: 'var(--surface)', fontSize: '0.75rem' }}>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }}>Service</th>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }}>Location</th>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }}>Stage</th>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }}>QC</th>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }}>Updated</th>
                      <th style={{ padding: '0.5rem 0.625rem', fontWeight: 500 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {savedPages.map(r => (
                      <tr
                        key={r.id}
                        style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                        onClick={() => setSearchParams({ pageId: r.id })}
                      >
                        <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text)', fontWeight: 500 }}>{r.service_name}</td>
                        <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{r.location_name}</td>
                        <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{r.status}</td>
                        <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{r.qc_verdict || '—'}</td>
                        <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-3)', fontSize: '0.75rem' }}>{new Date(r.updated_at).toLocaleDateString()}</td>
                        <td style={{ padding: '0.5rem 0.625rem', textAlign: 'right' }}>
                          {/* Pages are kept forever unless deleted, and this
                              table is the only place one can be. The row itself
                              opens the page, so the click must not do both. */}
                          <button
                            style={btn(false, { fontSize: '0.6875rem', padding: '0.125rem 0.375rem', color: 'var(--danger,#EF4444)' })}
                            disabled={deletingId === r.id}
                            onClick={e => { e.stopPropagation(); removePage(r); }}
                          >
                            {deletingId === r.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 1: keyword research ───────────────────────────────────── */}
      {data && step === 1 && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: 0 }}>
              Keywords for <strong>{service?.name}</strong> in <strong>{location?.city}</strong>, pulled from the live SERP and keyword database. Adjust the lists, then finalize.
            </p>
            <button style={btn(false)} disabled={kwLoading} onClick={() => loadKeywords({ force: true })}>{kwLoading ? 'Researching…' : 'Re-run research'}</button>
          </div>

          {kwError && <Banner onDismiss={() => setKwError('')}>{kwError}</Banner>}
          {kwLoading && <p style={{ color: 'var(--text-2)', fontSize: '0.8125rem' }}>Pulling competitor keyword data…</p>}

          {/* A Primary slot that research could not fill carries a keyword
              built from the service and location at zero volume. Say so
              plainly rather than letting a 0 pass unnoticed. */}
          {!kwLoading && (() => {
            const synth = primaryList.filter(k => k.source === 'synthesized');
            if (!synth.length && !reviewFailures.length) return null;
            const all = synth.length === primaryList.length;
            return (
              <Banner tone="warning">
                {!!synth.length && (
                  <>
                    <strong>
                      {all ? 'These keywords have very low or no search volume.'
                        : `${synth.length} of ${primaryList.length} primary keywords have very low or no search volume.`}
                    </strong>{' '}
                    {all
                      ? `No keyword combining “${service?.name}” with “${location?.city}” survived research, so the primary has been built from the service and location name instead.`
                      : `Research did not fill every primary slot, so ${synth.length === 1 ? 'one has' : `${synth.length} have`} been built from the service and location name.`}
                    {' '}Keywords shown with “—” volume have no recorded searches.
                  </>
                )}
                {!!reviewFailures.length && (
                  <>
                    <div style={{ marginTop: synth.length ? '0.5rem' : 0, fontWeight: 600 }}>Rejected by the review pass:</div>
                    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                      {reviewFailures.map((f, i) => <li key={i}>[{f.slot}] {f.keyword} — {f.reason}</li>)}
                    </ul>
                  </>
                )}
              </Banner>
            );
          })()}

          {!kwLoading && (
            <>
              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Primary keywords</h4>
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    background: primaryList.length ? 'var(--success-soft)' : 'var(--danger-soft,#FEF2F2)',
                    color: primaryList.length ? 'var(--success)' : 'var(--danger)',
                  }}>{primaryList.length} / {MAX_PRIMARY}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  {primaryList.map((kw, i) => (
                    <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)', borderRadius: 'var(--r-md,6px)', padding: '0.75rem', display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.8125rem' }}>{kw.keyword}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.25rem' }}>
                          Volume: {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}
                          {kw.source === 'synthesized' && <span style={{ color: 'var(--warning,#B45309)' }}> · built from service + location</span>}
                        </div>
                      </div>
                      <button style={removeBtn} title="Remove" onClick={() => setPrimaryList(prev => prev.filter((_, x) => x !== i))}>×</button>
                    </div>
                  ))}
                  {!primaryList.length && <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', gridColumn: '1 / -1' }}>No primary keyword selected — add one below.</p>}
                </div>
              </div>

              <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                  <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Secondary keywords</h4>
                  <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: 'var(--info-soft)', color: 'var(--info)' }}>
                    {secondaryList.length} / {MAX_SECONDARY}
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
                            <button style={removeBtn} title="Remove" onClick={() => setSecondaryList(prev => prev.filter((_, x) => x !== i))}>×</button>
                          </td>
                        </tr>
                      ))}
                      {!secondaryList.length && <tr><td colSpan={4} style={{ padding: '0.75rem', textAlign: 'center', color: 'var(--text-3)' }}>No secondary keywords selected.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <input style={inputStyle} placeholder="Add a keyword manually…" value={manualKeyword} onChange={e => setManualKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && addManualKeyword()} />
                <button style={btn(false)} onClick={addManualKeyword}>Add</button>
              </div>

              <button style={btn(false, { width: '100%' })} onClick={() => setShowAllKeywords(v => !v)}>
                {showAllKeywords ? 'Hide' : 'Show'} all candidate keywords ({availableKeywords.length})
              </button>
              {showAllKeywords && (
                <div style={{ marginTop: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', overflow: 'hidden', maxHeight: '24rem', overflowY: 'auto' }}>
                  <table style={{ width: '100%', fontSize: '0.8125rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-2)', background: 'var(--surface)', fontSize: '0.75rem' }}>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Keyword</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Volume</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Difficulty</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Intent</th>
                        <th style={{ padding: '0.5rem 0.625rem' }}>Source</th>
                        <th style={{ padding: '0.5rem 0.625rem' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {availableKeywords.map(kw => (
                        <tr key={kw.keyword} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text)' }}>{kw.keyword}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.volume > 0 ? kw.volume.toLocaleString() : '—'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.difficulty || 0}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-2)' }}>{kw.intent || '—'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', color: 'var(--text-3)', fontSize: '0.75rem' }}>{kw.source === 'universe' ? 'Universe' : kw.source === 'manual' ? 'Manual' : 'Live'}</td>
                          <td style={{ padding: '0.5rem 0.625rem', textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => setPrimaryList(prev => [...prev, kw])} disabled={primaryList.length >= MAX_PRIMARY}
                                style={btn(false, { fontSize: '0.6875rem', padding: '3px 8px', background: primaryList.length >= MAX_PRIMARY ? 'var(--surface)' : 'var(--primary-soft)', color: primaryList.length >= MAX_PRIMARY ? 'var(--text-3)' : 'var(--primary)', border: 'none' })}
                              >+ Primary</button>
                              <button
                                onClick={() => setSecondaryList(prev => [...prev, kw])} disabled={secondaryList.length >= MAX_SECONDARY}
                                style={btn(false, { fontSize: '0.6875rem', padding: '3px 8px', background: secondaryList.length >= MAX_SECONDARY ? 'var(--surface)' : 'var(--info-soft)', color: secondaryList.length >= MAX_SECONDARY ? 'var(--text-3)' : 'var(--info)', border: 'none' })}
                              >+ Secondary</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!availableKeywords.length && <tr><td colSpan={6} style={{ padding: '0.75rem', textAlign: 'center', color: 'var(--text-3)' }}>Every candidate has been selected.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem' }}>
            <button style={btn(false)} onClick={() => setStep(0)}>← Back</button>
            <button style={btn(true)} disabled={!primaryList.length || kwLoading} onClick={() => setStep(2)}>Next: finalize →</button>
          </div>
        </div>
      )}

      {/* ── Step 2: finalize keywords ──────────────────────────────────── */}
      {data && step === 2 && (
        <div style={cardStyle}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text)', margin: '0 0 0.25rem' }}>Finalize the keyword list</h3>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', marginTop: 0 }}>
            This is what the page will be built and judged against: the primary drives the title, meta description, H1 and hero one-liner, and the
            secondary keywords are mapped to the sections where they genuinely fit. Nothing is written until you approve it.
          </p>

          {kwError && <Banner onDismiss={() => setKwError('')}>{kwError}</Banner>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
            <div style={{ padding: '0.875rem 1rem', background: 'var(--surface)', borderRadius: 'var(--r-md,6px)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.5rem' }}>Primary</div>
              {primaryList.map((k, i) => (
                <div key={i} style={{ fontSize: '0.8125rem', color: 'var(--text)', marginBottom: '0.25rem' }}>
                  {i + 1}. {k.keyword} <span style={{ color: 'var(--text-3)' }}>({k.volume > 0 ? k.volume.toLocaleString() : 'no recorded volume'})</span>
                </div>
              ))}
            </div>
            <div style={{ padding: '0.875rem 1rem', background: 'var(--surface)', borderRadius: 'var(--r-md,6px)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.5rem' }}>Secondary</div>
              {secondaryList.map((k, i) => (
                <div key={i} style={{ fontSize: '0.8125rem', color: 'var(--text-2)', marginBottom: '0.125rem' }}>{k.keyword}</div>
              ))}
              {!secondaryList.length && <div style={{ fontSize: '0.8125rem', color: 'var(--text-3)' }}>None selected.</div>}
            </div>
          </div>

          <div style={{ marginTop: '1.25rem' }}>
            <label style={labelStyle}>Competitor URLs for the brief (optional — one per line)</label>
            <textarea
              style={{ ...inputStyle, minHeight: '5rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}
              placeholder="Leave empty to let the SERP pick the top competitors for the primary keyword."
              value={competitorUrls}
              onChange={e => setCompetitorUrls(e.target.value)}
            />
            <p style={{ fontSize: '0.6875rem', color: 'var(--text-3)', marginTop: '0.25rem' }}>
              Competitors decide which topics the page covers, not its wording. You can edit this list again on the brief step.
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1.25rem' }}>
            <button style={btn(false)} onClick={() => setStep(1)}>← Edit keywords</button>
            <button style={btn(true)} disabled={!primaryList.length} onClick={finalizeKeywords}>Approve keywords & build brief →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: the brief ──────────────────────────────────────────── */}
      {data && step === 3 && (
        <div>
          {briefError && <Banner onDismiss={() => setBriefError('')}>{briefError}</Banner>}

          {briefBusy && !brief && (
            <div style={{ ...cardStyle, padding: '2.5rem', textAlign: 'center' }}>
              <div style={{ width: '2rem', height: '2rem', margin: '0 auto 1rem', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '9999px', animation: 'lsspin 0.8s linear infinite' }} />
              <p style={{ color: 'var(--text-2)', fontSize: '0.875rem' }}>Reading competitor pages and planning the brief…</p>
              <style>{'@keyframes lsspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
            </div>
          )}

          {!briefBusy && !brief && !briefError && (
            <div style={{ ...cardStyle, textAlign: 'center' }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>No brief yet for this combination.</p>
              <button style={btn(true)} onClick={generateBrief}>Build the brief</button>
            </div>
          )}

          {brief && (
            <>
              <div style={{ ...cardStyle, padding: '1rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                  <strong style={{ color: 'var(--text)' }}>Competitor coverage: {brief.competitorQuality}</strong>
                  {brief.rationale && <span> — {brief.rationale}</span>}
                  {brief.approved && <span style={{ color: 'var(--success,#059669)' }}> · approved</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.375rem' }}>
                  <button style={btn(false)} disabled={briefBusy} onClick={generateBrief}>{briefBusy ? 'Working…' : '⟳ Re-plan from competitors'}</button>
                  <button style={btn(false)} disabled={briefBusy} onClick={() => saveBriefEdits({ approve: false })}>Save draft</button>
                </div>
              </div>

              {/* §10's research output — the evidence for why the page covers
                  what it covers, and the list the reviewer can correct. */}
              <SectionCard title="Competitor research" note={`${(brief.research?.competitors || []).length} pages read`}>
                <label style={labelStyle}>Competitor URLs (one per line — edit and re-plan to change the topics)</label>
                <textarea
                  style={{ ...inputStyle, minHeight: '4.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginBottom: '0.75rem' }}
                  value={competitorUrls} onChange={e => setCompetitorUrls(e.target.value)}
                />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  {[
                    ['Common topics', brief.research?.commonTopics],
                    ['Unique relevant topics', brief.research?.uniqueTopics],
                    ['FAQ topics found', brief.research?.faqTopics],
                    ['Content gaps', brief.research?.contentGaps],
                  ].map(([label, items]) => (
                    <div key={label} style={{ padding: '0.625rem 0.75rem', background: 'var(--surface)', borderRadius: 'var(--r-md,6px)' }}>
                      <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.25rem' }}>{label}</div>
                      {(items || []).length
                        ? <ul style={{ margin: 0, paddingLeft: '1rem', fontSize: '0.75rem', color: 'var(--text-2)' }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
                        : <div style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>None recorded.</div>}
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Sections" note={`${brief.sections.length} sections · ${limits.sectionChars ? `${limits.sectionChars.min}-${limits.sectionChars.max} characters each` : ''}`}>
                {brief.sections.map((s, i) => (
                  <div key={i} style={{ marginBottom: '0.875rem', paddingBottom: '0.875rem', borderBottom: i < brief.sections.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.375rem' }}>
                      <input
                        style={{ ...inputStyle, fontWeight: 600 }} value={s.h2}
                        onChange={e => updateBrief(b => { b.sections[i].h2 = e.target.value; })}
                      />
                      <SourceTag source={s.source} />
                      <button style={removeBtn} title="Remove section" onClick={() => updateBrief(b => { b.sections.splice(i, 1); })}>×</button>
                    </div>
                    <FieldLabel value={s.instructions}>Writing instructions</FieldLabel>
                    <textarea
                      style={{ ...inputStyle, minHeight: '3.5rem' }} value={s.instructions}
                      onChange={e => updateBrief(b => { b.sections[i].instructions = e.target.value; })}
                    />
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.375rem', flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-2)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        Paragraphs
                        <input
                          type="number" min={1} max={limits.paragraphsPerBlock?.max || 3}
                          style={{ ...inputStyle, width: '3.5rem', padding: '0.25rem 0.375rem' }}
                          value={s.paragraphs}
                          onChange={e => updateBrief(b => { b.sections[i].paragraphs = Number(e.target.value) || 1; })}
                        />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <input
                          type="checkbox" checked={!!s.localize}
                          onChange={e => updateBrief((b) => {
                            // Exactly one section carries the city, so ticking
                            // one unticks the rest — the writer prompt and the
                            // localization gate both assume a single owner.
                            b.sections.forEach((x, xi) => { x.localize = e.target.checked && xi === i; });
                          })}
                        />
                        Names the city
                      </label>
                      <span>Keywords: {(s.keywords || []).join(', ') || '—'}</span>
                    </div>
                  </div>
                ))}
                <button
                  style={btn(false)}
                  onClick={() => updateBrief(b => {
                    b.sections.push({
                      h2: '', instructions: '', paragraphs: 2, localize: false, source: 'fallback',
                      keywords: [], charLimit: limits.sectionChars || { min: 500, max: 700 },
                    });
                  })}
                >+ Add section</button>
              </SectionCard>

              <SectionCard title="FAQ questions" note={limits.faqs ? `${limits.faqs.min}-${limits.faqs.max} questions` : ''}>
                {brief.faqs.map((f, i) => (
                  <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < brief.faqs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                      <input
                        style={{ ...inputStyle, fontWeight: 600 }} value={f.question}
                        onChange={e => updateBrief(b => { b.faqs[i].question = e.target.value; })}
                      />
                      <button style={removeBtn} title="Remove question" onClick={() => updateBrief(b => { b.faqs.splice(i, 1); })}>×</button>
                    </div>
                    <input
                      style={inputStyle} placeholder="What the answer must establish (optional)"
                      value={f.intent || ''}
                      onChange={e => updateBrief(b => { b.faqs[i].intent = e.target.value; })}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.375rem' }}>
                      <input
                        type="checkbox" checked={!!f.localize}
                        onChange={e => updateBrief(b => { b.faqs[i].localize = e.target.checked; })}
                      />
                      The answer genuinely depends on the location
                    </label>
                  </div>
                ))}
                <button
                  style={btn(false)}
                  onClick={() => updateBrief(b => { b.faqs.push({ question: '', intent: '', localize: false, keywords: [] }); })}
                >+ Add question</button>
              </SectionCard>

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button style={btn(false)} onClick={() => setStep(2)}>← Keywords</button>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {page?.sections?.body?.blocks?.length > 0 && (
                    <button style={btn(false)} onClick={() => setStep(4)}>Skip to written content →</button>
                  )}
                  <button style={btn(true)} disabled={briefBusy || copyBusy} onClick={approveAndWrite}>
                    {briefBusy || copyBusy ? 'Working…' : 'Approve brief & write content →'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Step 4: written content ────────────────────────────────────── */}
      {data && step === 4 && (
        <div>
          {copyBusy && !page?.sections?.body?.blocks?.length && (
            <div style={{ ...cardStyle, padding: '2.5rem', textAlign: 'center' }}>
              <div style={{ width: '2rem', height: '2rem', margin: '0 auto 1rem', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '9999px', animation: 'lsspin 0.8s linear infinite' }} />
              <p style={{ color: 'var(--text-2)', fontSize: '0.875rem' }}>Writing the page from the approved brief…</p>
              <p style={{ color: 'var(--text-3)', fontSize: '0.75rem' }}>This can take up to a minute.</p>
              <style>{'@keyframes lsspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
            </div>
          )}

          {copyError && (
            <Banner onDismiss={() => setCopyError('')}>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{copyError}</span>
                <button style={btn(true)} onClick={generateCopy}>Retry</button>
              </div>
            </Banner>
          )}

          {page && !!page.sections.body.blocks.length && (
            <>
              <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)', paddingBottom: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button style={btn(false)} disabled={qcBusy} onClick={runQc}>{qcBusy ? 'Running QC…' : 'Run QC'}</button>
                  <button style={btn(dirty)} disabled={saving || !dirty || !pageId} onClick={persist}>
                    {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
                  </button>
                  <CopyButton label="Copy all" getText={() => pageAsText(page)} getHtml={() => pageAsHtml(page)} />
                  <button style={btn(false)} disabled={exportBusy === 'docx'} onClick={() => download('docx')}>{exportBusy === 'docx' ? 'Building…' : 'Download DOCX'}</button>
                  <button style={btn(false)} disabled={exportBusy === 'markdown'} onClick={() => download('markdown')}>Markdown</button>
                  <button style={btn(false)} disabled={exportBusy === 'json'} onClick={() => download('json')}>JSON</button>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button style={btn(false)} onClick={() => setStep(3)}>← Edit brief</button>
                  <button style={btn(false)} disabled={copyBusy} onClick={generateCopy}>{copyBusy ? 'Rewriting…' : '⟳ Rewrite all'}</button>
                </div>
              </div>

              {saveError && <Banner onDismiss={() => setSaveError('')}>{saveError}</Banner>}
              {regenError && <Banner onDismiss={() => setRegenError('')}>{regenError}</Banner>}
              {qcError && <Banner tone="info">Could not re-run that check: {qcError}</Banner>}

              {qc && (() => {
                const open = (qc.checks || []).filter(c => !c.pass);
                return (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{
                      padding: '0.5rem 0.75rem', borderRadius: 'var(--r-lg)', fontSize: '0.75rem',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: open.length ? 'var(--warning,#B45309)' : 'var(--success,#059669)',
                    }}>
                      <strong>QC: {qc.verdict}</strong>
                      {open.length
                        ? ` — ${open.length} item${open.length === 1 ? '' : 's'} flagged, each marked below next to the field it came from. Fix it, then hit Recheck on that notice.`
                        : ' — every check passes.'}
                    </div>
                    {qcNotices('brief')}
                    {qcNotices('locationInfo')}
                    {qcNotices('internalLinks')}
                  </div>
                );
              })()}

              <SectionCard
                title="SEO details" note={page.meta.urlPath}
                actions={<>
                  <RegenButton busy={!!regenerating.seoTitle} onClick={() => regenerate('seoTitle')} label="⟳ Title" />
                  <RegenButton busy={!!regenerating.metaDescription} onClick={() => regenerate('metaDescription')} label="⟳ Description" />
                  <CopyButton getText={() => `Title: ${page.meta.title}\nMeta Description: ${page.meta.metaDescription}`} />
                </>}
              >
                <FieldLabel value={page.meta.title} limit={limits.seoTitle}>SEO title</FieldLabel>
                <input style={inputStyle} value={page.meta.title} onChange={e => updatePage(p => { p.meta.title = e.target.value; })} />
                {qcNotices('meta.title')}
                <div style={{ height: '0.75rem' }} />
                <FieldLabel value={page.meta.metaDescription} limit={limits.metaDescription}>Meta description</FieldLabel>
                <textarea style={{ ...inputStyle, minHeight: '3.5rem' }} value={page.meta.metaDescription} onChange={e => updatePage(p => { p.meta.metaDescription = e.target.value; })} />
                {qcNotices('meta.metaDescription')}
              </SectionCard>

              <SectionCard
                title="Hero"
                actions={<>
                  <RegenButton busy={!!regenerating.h1} onClick={() => regenerate('h1')} label="⟳ H1" />
                  <RegenButton busy={!!regenerating.heroOneLiner} onClick={() => regenerate('heroOneLiner')} label="⟳ One-liner" />
                  <CopyButton getText={() => `${page.sections.hero.h1}\n\n${page.sections.hero.oneLiner}`} getHtml={() => `<h1>${escapeHtml(page.sections.hero.h1)}</h1><p>${escapeHtml(page.sections.hero.oneLiner)}</p>`} />
                </>}
              >
                <FieldLabel value={page.sections.hero.h1}>H1</FieldLabel>
                <input style={inputStyle} value={page.sections.hero.h1} onChange={e => updatePage(p => { p.sections.hero.h1 = e.target.value; })} />
                {qcNotices('hero.h1')}
                <div style={{ height: '0.75rem' }} />
                <FieldLabel value={page.sections.hero.oneLiner} words limitWords={limits.heroOneLiner}>Hero one-liner</FieldLabel>
                <textarea style={{ ...inputStyle, minHeight: '3rem' }} value={page.sections.hero.oneLiner} onChange={e => updatePage(p => { p.sections.hero.oneLiner = e.target.value; })} />
                {qcNotices('hero.oneLiner')}
              </SectionCard>

              {/* §6 — PULLED from the location record, never generated. Shown
                  read-only with its gaps named, because the fix is to get the
                  data from the client, not to type something here. */}
              <SectionCard title="Location details" note="Pulled from the location record">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.625rem', fontSize: '0.8125rem' }}>
                  {[
                    ['Address', page.sections.locationInfo.address],
                    ['Phone', page.sections.locationInfo.phone],
                    ['Directions / map', page.sections.locationInfo.mapUrl],
                    ['Serving areas', (page.sections.locationInfo.servingAreas || []).join(', ')],
                    ['Ages served', page.sections.locationInfo.agesServed],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
                      <div style={{ color: value ? 'var(--text)' : 'var(--warning,#B45309)' }}>{value || 'Required from client'}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard
                title="Page content" note={`${page.sections.body.blocks.length} sections`}
                actions={<CopyButton getText={() => page.sections.body.blocks.map(b => `${b.h2}\n\n${stripHtml(b.html)}`).join('\n\n')} getHtml={() => page.sections.body.blocks.map(b => `<h2>${escapeHtml(b.h2)}</h2>${b.html}`).join('\n')} />}
              >
                {qcNotices('body')}
                {page.sections.body.blocks.map((b, i) => (
                  <div key={i} style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: i < page.sections.body.blocks.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.375rem' }}>
                      <input style={{ ...inputStyle, fontWeight: 600 }} value={b.h2} onChange={e => updatePage(p => { p.sections.body.blocks[i].h2 = e.target.value; })} />
                      <SourceTag source={b.source} />
                      <RegenButton busy={!!regenerating[`section:${i}`]} onClick={() => regenerate('section', i)} label="⟳" />
                    </div>
                    {b.instructions && (
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-3)', marginBottom: '0.25rem' }}>
                        <strong>Brief:</strong> {b.instructions}
                        {(b.keywords || []).length ? ` · Keywords: ${b.keywords.join(', ')}` : ''}
                      </div>
                    )}
                    <textarea
                      style={{ ...inputStyle, minHeight: '7rem' }}
                      value={htmlToPlain(b.html)}
                      onChange={e => updatePage(p => { p.sections.body.blocks[i].html = plainToHtml(e.target.value); })}
                    />
                    <div style={{ display: 'flex' }}>
                      <Counter value={stripHtml(b.html)} limit={b.charLimit || limits.sectionChars} />
                    </div>
                    {qcBlockNotice(i)}
                  </div>
                ))}
              </SectionCard>

              <SectionCard
                title={page.sections.faq.heading}
                actions={<>
                  <RegenButton busy={!!regenerating.faqIntro} onClick={() => regenerate('faqIntro')} label="⟳ Intro" />
                  <CopyButton getText={() => [page.sections.faq.intro, ...page.sections.faq.items.map(f => `Q: ${f.q}\nA: ${f.a}`)].filter(Boolean).join('\n\n')} />
                </>}
              >
                {qcNotices('faq')}
                <FieldLabel value={page.sections.faq.intro} words limitWords={limits.faqIntro}>FAQ introduction</FieldLabel>
                <textarea style={{ ...inputStyle, minHeight: '3.5rem' }} value={page.sections.faq.intro} onChange={e => updatePage(p => { p.sections.faq.intro = e.target.value; })} />
                <div style={{ height: '0.875rem' }} />
                {page.sections.faq.items.map((f, i) => (
                  <div key={i} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: i < page.sections.faq.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                      <input style={{ ...inputStyle, fontWeight: 600 }} value={f.q} onChange={e => updatePage(p => { p.sections.faq.items[i].q = e.target.value; })} />
                      <RegenButton busy={!!regenerating[`faqItem:${i}`]} onClick={() => regenerate('faqItem', i)} label="⟳" />
                    </div>
                    <textarea style={{ ...inputStyle, minHeight: '3.5rem' }} value={f.a} onChange={e => updatePage(p => { p.sections.faq.items[i].a = e.target.value; })} />
                    <div style={{ display: 'flex' }}>
                      <Counter value={f.a} words limitWords={{ max: limits.faqAnswerMaxWords }} />
                    </div>
                  </div>
                ))}
              </SectionCard>

              <SectionCard title="Schema (JSON-LD)" note="Built server-side from the page above">
                {qcNotices('schema')}
                {Object.entries(page.schema || {}).map(([key, value]) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.375rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: '0.8125rem', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{key}</span>
                    <CopyButton label="Copy JSON-LD" getText={() => `<script type="application/ld+json">${value}</script>`} />
                  </div>
                ))}
              </SectionCard>

              <SectionCard title="Internal links" note={`${(page.sections.internalLinks || []).length} links`}>
                {(page.sections.internalLinks || []).map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.8125rem', padding: '0.25rem 0' }}>
                    <span style={{ color: 'var(--text)' }}>{l.anchor_text}</span>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{l.url}</span>
                  </div>
                ))}
              </SectionCard>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button style={btn(true)} onClick={reset}>Build another page →</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* No `action` filter: this engine records four separate actions
          (keywords, brief, content, regenerate) and the useful question here is
          "what has this module been doing lately?", not one of the four. */}
      <ModuleRuns
        toolId="location-page-builder"
        title="Recent runs"
        scopeNote="Every client in this module"
      />
    </main>
  );
}
