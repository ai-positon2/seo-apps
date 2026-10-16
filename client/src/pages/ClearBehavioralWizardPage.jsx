import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { lpb } from '../lib/lpbApi';
import { ProgressSteps } from '../ui/ProgressSteps';
import { btnStyle, inputStyle, labelStyle, PickerList, SectionCard, CharCount, SourceTag, RegenButton } from '../ui/wizardKit';

// Matches server/locationPageBuilder/seed.js CBH_CLIENT_ID. Scoped to one
// client, like the Gentle Dental wizard it borrows its first two steps from.
const CBH_CLIENT_ID = 'client_clear_behavioral_health';

// The step this flow exists for. Gentle Dental goes keywords -> [research,
// plan and write in one call] -> review, and nobody ever sees the plan. Here
// the plan is a BRIEF: drafted, edited, saved, and then written from.
const STEPS = ['Select Location + Service', 'Keyword Research', 'Content Brief', 'Generated Page'];

// Program families, in the order the SEO team thinks about them. The label is
// what the picker groups under; a service can belong to more than one, and is
// listed under the first that matches so it appears exactly once.
const GROUP_LABELS = [
  ['mh-residential', 'Residential Mental Health'],
  ['mh-outpatient', 'Outpatient Mental Health'],
  ['addiction-residential', 'Addiction — Residential'],
  ['addiction-outpatient', 'Addiction — Outpatient'],
  ['teen', 'Teen Programs'],
];

// This contract's own vocabulary for where a section came from. `fallback` here
// means "written from a named clinical authority", not "standard".
const CBH_SOURCE_LABELS = {
  competitor: { label: 'from competitors', bg: 'var(--info-soft,#EFF6FF)', fg: 'var(--info,#2563EB)' },
  fallback: { label: 'from source', bg: 'var(--success-soft,#F0FDF4)', fg: 'var(--success,#16A34A)' },
};

const MAX_PRIMARY = 2;
const MAX_SECONDARY = 10;

function keyOf(kw) {
  return String(kw || '').toLowerCase().trim();
}

// Character counter against a contract window. Shown live beside every capped
// field, because this contract has ten of them and the writer misses one now
// and then -- a reviewer needs to see which without running QC.
function Count({ value, min, max }) {
  const n = String(value || '').replace(/\s+/g, ' ').trim().length;
  const ok = n > 0 && n <= max && (!min || n >= min);
  return (
    <span style={{
      fontSize: '0.6875rem', fontWeight: 600, whiteSpace: 'nowrap',
      color: n === 0 ? 'var(--text-3)' : ok ? 'var(--success,#16A34A)' : 'var(--warning,#B45309)',
    }}>{n}/{min ? `${min}-${max}` : max}</span>
  );
}

// A paragraph list edited as one textarea, blank line separated. The contract
// counts paragraphs, so they stay an array in the page object -- this is only
// how they are typed.
function Paragraphs({ value, onChange, rows = 3, placeholder }) {
  return (
    <textarea
      rows={rows}
      style={{ ...inputStyle, resize: 'vertical' }}
      placeholder={placeholder}
      value={(value || []).join('\n\n')}
      onChange={e => onChange(e.target.value.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean))}
    />
  );
}

// The table renders the POOL, and a synthesized Primary is not in it: the
// server returns it in `primary` because nothing in the research qualified, so
// there is by definition no pool row for it. Merged in here, or the wizard
// announces "Primary was built from the service and location name" and then
// shows a table with nothing selected and no such keyword anywhere in it.
function mergePool(pool, primary, secondary) {
  const byKey = new Map();
  [...(primary || []), ...(secondary || []), ...(pool || [])].forEach((c) => {
    const k = keyOf(c.keyword);
    // First writer wins: a selected entry carries the volume/source the server
    // resolved, and the pool copy of the same keyword is the same row anyway.
    if (k && !byKey.has(k)) byKey.set(k, c);
  });
  return [...byKey.values()];
}

// Volume of 0 means "no recorded searches", which is not the same as "we did
// not look" — show it as an em dash so a real zero cannot be misread as data.
function volumeLabel(v) {
  return v > 0 ? v.toLocaleString() : '—';
}

export default function ClearBehavioralWizardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState(0);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [seeding, setSeeding] = useState(false);
  // Fetched rather than hardcoded: a limit shown in the UI that differs from
  // the one QC gates on is worse than showing no limit at all.
  const [limits, setLimits] = useState(null);
  // Saved pages, so generated content is reachable again after you navigate
  // away. Without this a page exists only in the database.
  const [savedPages, setSavedPages] = useState([]);
  const [deletingId, setDeletingId] = useState('');

  // Step 0
  const [serviceId, setServiceId] = useState(searchParams.get('serviceId') || '');
  const [locationId, setLocationId] = useState(searchParams.get('locationId') || '');
  const [svcFilter, setSvcFilter] = useState('');
  const [locFilter, setLocFilter] = useState('');

  // Step 1
  const [candidates, setCandidates] = useState([]);
  const [primaryList, setPrimaryList] = useState([]);
  const [secondaryList, setSecondaryList] = useState([]);
  const [kwLoading, setKwLoading] = useState(false);
  const [kwError, setKwError] = useState('');
  const [kwReviewFailures, setKwReviewFailures] = useState([]);
  const [manualKeyword, setManualKeyword] = useState('');
  const kwRequestRef = useRef(0);

  // Step 2
  const [brief, setBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [briefDirty, setBriefDirty] = useState(false);
  const [savingBrief, setSavingBrief] = useState(false);

  // Step 3
  const [page, setPage] = useState(null);
  const [pageId, setPageId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  // Edits live in `page` until saved. `pageDirty` drives the Save button and
  // marks the QC verdict stale, because the verdict describes what is STORED.
  const [pageDirty, setPageDirty] = useState(false);
  const [savingPage, setSavingPage] = useState(false);
  const [pageError, setPageError] = useState('');
  const [exporting, setExporting] = useState(false);
  // Which field is regenerating, so only that button shows a spinner. Keyed by
  // field + index, because the same field key repeats across H3s and FAQs.
  const [regenBusy, setRegenBusy] = useState('');
  // What a regenerated value still breaks in the client's feedback rules.
  const [regenNote, setRegenNote] = useState('');

  // Client feedback rules: the counts for the header link, the brief's
  // warnings (computed server-side on every read and save), and the re-check.
  const [feedbackSummary, setFeedbackSummary] = useState(null);
  const [briefWarnings, setBriefWarnings] = useState([]);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => { loadReferenceData(); }, []);
  useEffect(() => {
    lpb.cbhLimits().then(r => setLimits(r.limits)).catch(() => { /* counters degrade to none */ });
    Promise.all([lpb.feedbackRules(CBH_CLIENT_ID), lpb.feedbackBatches(CBH_CLIENT_ID)])
      .then(([rules, batches]) => setFeedbackSummary({
        active: rules.filter(r => r.status === 'active').length,
        open: batches.reduce((n, b) => n + (b.action_items || []).filter(a => a.status !== 'done').length, 0),
      }))
      .catch(() => { /* the link still works without its counts */ });
  }, []);
  useEffect(() => { refreshSavedPages(); }, []);

  function refreshSavedPages() {
    lpb.cbhPages(CBH_CLIENT_ID).then(setSavedPages).catch(() => { /* list is a convenience */ });
  }

  // Deleting a page is the only destructive action in this wizard, so it
  // confirms first and says what survives: the brief is kept, because it cost a
  // billed research call and is usually hand-edited.
  async function deleteSavedPage(pg) {
    const label = `${pg.serviceName} in ${pg.locationName}`;
    if (!window.confirm(
      `Delete the generated page for ${label}?\n\n`
      + 'The written content cannot be recovered. The approved brief and keywords are kept, '
      + 'so you can generate it again without redoing the research.')) return;
    setDeletingId(pg.id);
    setLoadError('');
    try {
      await lpb.cbhDeletePage(pg.id);
      // If the page being edited is the one just deleted, the editor is now
      // showing something that no longer exists. Back to the start.
      if (pageId === pg.id) { setPage(null); setPageId(''); setPageDirty(false); setStep(0); }
      refreshSavedPages();
    } catch (e) { setLoadError(e.message); }
    setDeletingId('');
  }

  // Open a saved page straight into the editor, without re-running anything.
  async function openSavedPage(id) {
    setPageError(''); setGenError('');
    try {
      const r = await lpb.cbhPage(id);
      setServiceId(r.serviceId); setLocationId(r.locationId);
      setPage(r.page); setPageId(r.pageId);
      setPageDirty(false);
      // Restore the approved keywords too. Jumping straight to the editor left
      // steps 1 and 2 with no keyword state at all, so going back to either of
      // them behaved as though none had ever been approved.
      try {
        const saved = await lpb.wizardGetKeywords({ clientId: CBH_CLIENT_ID, serviceId: r.serviceId, locationId: r.locationId });
        if (saved?.primary?.length) {
          setPrimaryList(saved.primary);
          setSecondaryList(saved.secondary || []);
          setCandidates(mergePool(saved.candidates, saved.primary, saved.secondary));
        }
      } catch { /* the editor works without them; a rebuild falls back to the brief */ }
      setStep(3);
    } catch (e) { setLoadError(e.message); }
  }

  async function loadReferenceData() {
    setLoadError('');
    try {
      setData(await lpb.client(CBH_CLIENT_ID));
    } catch (e) {
      setLoadError(`${e.message} — if the reference data is missing, sync it.`);
    }
  }

  // The service and location lists are reference data in the DATABASE, so a
  // taxonomy change in seed.js reaches this picker only after a re-seed. Safe
  // to re-run: it is scoped to this client, and hand-entered NAP is preserved
  // (see seed.mergeLocation). Services are replaced outright, so an edit made
  // directly to a service row does not survive.
  async function syncList() {
    setSeeding(true); setLoadError('');
    try { await lpb.seedClearBehavioral(); await loadReferenceData(); }
    catch (e) { setLoadError(e.message); }
    setSeeding(false);
  }

  const service = data?.services.find(s => s.id === serviceId) || null;
  const location = data?.locations.find(l => l.id === locationId) || null;

  // Only services this office actually runs. The same guardrail the server
  // enforces (a page for a service not offered here is a doorway page), applied
  // in the picker so the choice never presents itself.
  const availableServices = useMemo(() => {
    if (!data) return [];
    if (!location) return data.services;
    const allowed = new Set(location.services_available_ids || []);
    return data.services.filter(s => allowed.has(s.id));
  }, [data, location]);

  const groupedServices = useMemo(() => {
    const q = svcFilter.toLowerCase().trim();
    const match = s => !q || s.name.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q);
    const claimed = new Set();
    const groups = GROUP_LABELS.map(([key, label]) => {
      const items = availableServices
        .filter(s => !claimed.has(s.id) && (s.groups || []).includes(key) && match(s))
        .map(s => { claimed.add(s.id); return { id: s.id, label: s.name }; });
      return [label, items];
    });
    // Anything with no group at all still has to be reachable.
    const rest = availableServices.filter(s => !claimed.has(s.id) && match(s)).map(s => ({ id: s.id, label: s.name }));
    return rest.length ? [...groups, ['Other', rest]] : groups;
  }, [availableServices, svcFilter]);

  const groupedLocations = useMemo(() => {
    if (!data) return [];
    const q = locFilter.toLowerCase().trim();
    const items = data.locations
      .filter(l => !q || l.location_name.toLowerCase().includes(q) || (l.city || '').toLowerCase().includes(q))
      .map(l => ({ id: l.id, label: l.location_name }));
    return [['Locations', items]];
  }, [data, locFilter]);

  // Changing the office can invalidate the chosen service (not every office
  // runs every program), and any keyword or brief work already done belongs to
  // the old pair — clear it rather than carrying it onto a different page.
  function selectLocation(id) {
    setLocationId(id);
    const loc = data?.locations.find(l => l.id === id);
    if (serviceId && loc && !(loc.services_available_ids || []).includes(serviceId)) setServiceId('');
    resetDownstream();
  }
  function selectService(id) { setServiceId(id); resetDownstream(); }

  function resetDownstream() {
    setCandidates([]); setPrimaryList([]); setSecondaryList([]); setKwReviewFailures([]); setKwError('');
    setBrief(null); setBriefError(''); setBriefDirty(false);
    setPage(null); setPageId(null); setGenError(''); setPageError(''); setPageDirty(false);
  }

  // ── Step 1: keywords ──────────────────────────────────────────────────────
  async function runKeywordResearch() {
    const token = ++kwRequestRef.current;
    const isCurrent = () => token === kwRequestRef.current;
    setKwLoading(true); setKwError('');
    try {
      const res = await lpb.keywordCandidates({
        service: service.name,
        city: location.city,
        state: location.state_abbreviation,
        stateName: location.state,
        region: location.region,
        clientId: CBH_CLIENT_ID,
        serviceSlug: service.slug,
      });
      if (!isCurrent()) return;
      setCandidates(mergePool(res.candidates, res.primary, res.secondary));
      setPrimaryList(res.primary || []);
      setSecondaryList(res.secondary || []);
      setKwReviewFailures(res.reviewFailures || []);
      persistKeywords(res.primary || [], res.secondary || [], res.candidates || [], false);
    } catch (e) {
      if (isCurrent()) setKwError(e.message);
    } finally {
      if (isCurrent()) setKwLoading(false);
    }
  }

  async function persistKeywords(primary, secondary, pool, approved) {
    if (!serviceId || !locationId || !primary.length) return;
    try {
      await lpb.wizardSaveKeywords({
        clientId: CBH_CLIENT_ID, serviceId, locationId,
        primary, secondary, candidates: pool ?? candidates, approved,
      });
    } catch (e) { console.warn('Failed to save keywords (non-fatal):', e.message); }
  }

  // Entering step 1: restore an approved selection before spending the billed
  // research call. Revisiting the step must not re-bill.
  useEffect(() => {
    if (step !== 1 || !serviceId || !locationId) return;
    if (primaryList.length || kwLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await lpb.wizardGetKeywords({ clientId: CBH_CLIENT_ID, serviceId, locationId });
        if (cancelled) return;
        if (saved?.primary?.length) {
          setPrimaryList(saved.primary);
          setSecondaryList(saved.secondary || []);
          setCandidates(mergePool(saved.candidates, saved.primary, saved.secondary));
          return;
        }
      } catch { /* no saved selection — research it */ }
      if (!cancelled) runKeywordResearch();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, locationId]);

  function togglePrimary(entry) {
    const k = keyOf(entry.keyword);
    setPrimaryList((prev) => {
      if (prev.some(p => keyOf(p.keyword) === k)) return prev.filter(p => keyOf(p.keyword) !== k);
      if (prev.length >= MAX_PRIMARY) return prev;
      setSecondaryList(s => s.filter(x => keyOf(x.keyword) !== k));
      return [...prev, entry];
    });
  }
  function toggleSecondary(entry) {
    const k = keyOf(entry.keyword);
    setSecondaryList((prev) => {
      if (prev.some(p => keyOf(p.keyword) === k)) return prev.filter(p => keyOf(p.keyword) !== k);
      if (prev.length >= MAX_SECONDARY) return prev;
      setPrimaryList(p => p.filter(x => keyOf(x.keyword) !== k));
      return [...prev, entry];
    });
  }

  function addManualKeyword() {
    const kw = manualKeyword.trim();
    if (!kw) return;
    if (candidates.some(c => keyOf(c.keyword) === keyOf(kw))) { setManualKeyword(''); return; }
    const entry = { keyword: kw, volume: 0, difficulty: 0, intent: 'manual', source: 'manual' };
    setCandidates(prev => [...prev, entry]);
    toggleSecondary(entry);
    setManualKeyword('');
  }

  // ── Step 2: the brief ─────────────────────────────────────────────────────
  // Entering the step: show the SAVED brief if one exists. Only build a fresh
  // one when there is nothing to show — building is the billed call, and
  // silently overwriting an approved brief with a new draft would throw away
  // the edits this step exists to capture.
  useEffect(() => {
    if (step !== 2 || !serviceId || !locationId || brief || briefLoading) return;
    let cancelled = false;
    (async () => {
      setBriefLoading(true); setBriefError('');
      try {
        const saved = await lpb.cbhBrief({ clientId: CBH_CLIENT_ID, serviceId, locationId });
        if (cancelled) return;
        if (saved?.brief?.educational?.h3s?.length) {
          setBrief(saved.brief); setBriefDirty(false);
          setBriefWarnings(saved.feedbackWarnings || []);
          return;
        }
        if (!primaryList.length) {
          // Nothing approved in this session and nothing saved to fall back on.
          // Building from no keywords would spend a research call to produce a
          // brief for the wrong thing.
          if (!cancelled) setBriefError('No approved keywords for this page yet — go back to Keyword Research first.');
          return;
        }
        const fresh = await lpb.cbhBriefBuild({
          clientId: CBH_CLIENT_ID, serviceId, locationId,
          primaryKeywords: primaryList.map(k => k.keyword),
          secondaryKeywords: secondaryList.map(k => k.keyword),
        });
        if (!cancelled) { setBrief(fresh); setBriefDirty(true); setBriefWarnings(fresh.feedbackWarnings || []); }
      } catch (e) {
        if (!cancelled) setBriefError(e.message);
      } finally {
        if (!cancelled) setBriefLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, serviceId, locationId]);

  // The keywords a rebuild should research with. Prefer what step 1 loaded,
  // but fall back to the ones the BRIEF already carries: step 2 is reachable
  // from the editor ("Edit brief") on a page opened from the saved list, and
  // that route never runs step 1, so primaryList is empty and a rebuild was
  // posting an empty array -- "primaryKeywords (array, at least 1) is required".
  function keywordsForRebuild() {
    const primary = primaryList.length
      ? primaryList.map(k => k.keyword)
      : (brief?.primaryKeywords?.length ? brief.primaryKeywords : [brief?.primaryKeyword].filter(Boolean));
    const secondary = secondaryList.length
      ? secondaryList.map(k => k.keyword)
      : (brief?.secondaryKeywords || []);
    return { primary: primary.filter(Boolean), secondary };
  }

  async function rebuildBrief() {
    const { primary, secondary } = keywordsForRebuild();
    if (!primary.length) {
      setBriefError('No approved keywords for this page yet — go back to Keyword Research first.');
      return;
    }
    if (!window.confirm('Rebuild the brief from fresh research? Your edits to this brief will be lost.')) return;
    setBriefLoading(true); setBriefError('');
    try {
      const fresh = await lpb.cbhBriefBuild({
        clientId: CBH_CLIENT_ID, serviceId, locationId,
        primaryKeywords: primary, secondaryKeywords: secondary,
      });
      setBrief(fresh); setBriefDirty(true);
      setBriefWarnings(fresh.feedbackWarnings || []);
    } catch (e) { setBriefError(e.message); }
    setBriefLoading(false);
  }

  async function saveBrief(approved) {
    setSavingBrief(true); setBriefError('');
    try {
      const saved = await lpb.cbhBriefSave({ clientId: CBH_CLIENT_ID, serviceId, locationId, brief, approved });
      // The server normalizes (clamps paragraph counts, drops empty headings),
      // so adopt what it stored rather than the local copy — otherwise the
      // screen shows values the page will not actually be written from.
      setBrief(saved.brief); setBriefDirty(false);
      setBriefWarnings(saved.feedbackWarnings || []);
      return true;
    } catch (e) { setBriefError(e.message); return false; }
    finally { setSavingBrief(false); }
  }

  // Every edit goes through here so `dirty` cannot drift from the content.
  function editBrief(mutate) {
    setBrief(prev => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setBriefDirty(true);
  }

  const moveH3 = (i, delta) => editBrief(b => {
    const j = i + delta;
    const list = b.educational.h3s;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  });

  // ── Step 3: generate ──────────────────────────────────────────────────────
  async function generate() {
    setGenerating(true); setGenError('');
    try {
      // Save first, always. The page must be written from what is stored, so
      // that reopening it shows the brief it actually came from.
      const ok = await saveBrief(true);
      if (!ok) { setGenerating(false); return; }
      const result = await lpb.cbhGenerate({ clientId: CBH_CLIENT_ID, serviceId, locationId });
      setPage(result.page);
      setPageId(result.pageId || null);
      setPageDirty(false); setPageError('');
      setStep(3);
      refreshSavedPages();
    } catch (e) { setGenError(e.message); }
    setGenerating(false);
  }

  // ── Step 3: edit, save, export ────────────────────────────────────────────
  // Every edit goes through here so `pageDirty` cannot drift from the content.
  function editPage(mutate) {
    setPage((prev) => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setPageDirty(true);
  }

  async function savePage() {
    if (!pageId) { setPageError('This page has no id yet — regenerate before saving.'); return; }
    setSavingPage(true); setPageError('');
    try {
      // The server re-runs QC over what it stores, so adopt the verdict it
      // returns rather than keeping the pre-edit one on screen.
      const res = await lpb.cbhSavePage(pageId, page);
      if (res?.qc) setPage(prev => ({ ...prev, qc: res.qc, feedbackReview: res.page?.feedbackReview ?? prev.feedbackReview }));
      setPageDirty(false);
      refreshSavedPages();
    } catch (e) { setPageError(e.message); }
    setSavingPage(false);
  }

  // BILLED: one review call. Saves first when there are edits, so the review
  // is of what is on screen, then adopts the re-checked page.
  async function recheckFeedback() {
    if (!pageId) return;
    setRechecking(true); setPageError('');
    try {
      if (pageDirty) {
        const saved = await lpb.cbhSavePage(pageId, page);
        setPageDirty(false);
        if (saved?.page) setPage(saved.page);
      }
      const res = await lpb.cbhFeedbackReview(pageId);
      setPage(prev => ({ ...prev, qc: res.qc, feedback: res.page.feedback, feedbackReview: res.page.feedbackReview }));
      refreshSavedPages();
    } catch (e) { setPageError(e.message); }
    setRechecking(false);
  }

  // Both exports send what is ON SCREEN, saved or not: a reviewer who exports
  // after editing must get the document they are looking at.
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportDocx() {
    setExporting(true); setPageError('');
    try {
      const { blob, filename } = await lpb.cbhExportDocx(page);
      saveBlob(blob, filename);
    } catch (e) { setPageError(e.message); }
    setExporting(false);
  }

  // The CMS ingest shape, built server-side -- it needs the service and
  // location rows for the slugs and the service_type, which the page object
  // does not carry. This replaced a dump of the raw page object, which was our
  // internal structure and not something the CMS could read.
  async function downloadJson() {
    setPageError('');
    setExporting(true);
    try {
      const { filename, json } = await lpb.cbhExportJson(page);
      saveBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), filename);
    } catch (e) { setPageError(e.message); }
    setExporting(false);
  }

  // ── Regenerate one field ──────────────────────────────────────────────────
  // Applies the result straight into whichever structure owns the field and
  // marks it dirty, so the change follows the same save path as a hand edit.
  async function regenField(field, index, apply, lineIndex) {
    const key = `${field}:${index ?? ''}:${lineIndex ?? ''}`;
    setRegenBusy(key);
    setPageError(''); setBriefError(''); setRegenNote('');
    try {
      const r = await lpb.cbhRegenField({
        clientId: CBH_CLIENT_ID, serviceId, locationId, field, index, lineIndex,
        // Only the structure the field belongs to is sent.
        page: field.startsWith('brief.') ? undefined : page,
        brief: field.startsWith('brief.') ? brief : undefined,
      });
      apply(r.value);
      if (r.feedbackHits?.length) {
        setRegenNote(`The new value still breaks a client feedback rule: ${r.feedbackHits.map(h => `${h.title} (${h.detail})`).join('; ')}`);
      }
    } catch (e) {
      if (field.startsWith('brief.')) setBriefError(e.message); else setPageError(e.message);
    }
    setRegenBusy('');
  }
  const regenKey = (field, index, lineIndex) => `${field}:${index ?? ''}:${lineIndex ?? ''}`;

  const progressSteps = STEPS.map((label, i) => ({
    label, state: i === step ? 'active' : i < step ? 'done' : 'todo',
  }));

  const selectedKeys = new Set([...primaryList, ...secondaryList].map(k => keyOf(k.keyword)));
  // Selected first. A zero-volume synthesized Primary sorts last by volume,
  // which put the one keyword the page is actually targeting at the bottom of
  // a 400-row table.
  // Every body gets the same allowance -- lineMultiplier x the number of H3s --
  // and they do not share it. Mirrors cbhContract.linesUsed exactly, bullets
  // and mandatory breaks included: a number shown here that differs from the
  // one QC gates on is worse than none. The bullet pattern comes over the wire
  // from the contract rather than being written out a second time.
  const eduLineLimits = limits?.educational;
  const eduBulletRe = useMemo(
    () => (eduLineLimits?.bulletPattern ? new RegExp(eduLineLimits.bulletPattern) : null),
    [eduLineLimits?.bulletPattern]);
  // The read-only half of the URL: everything up to the service slug. Taken
  // from the canonical the server computed, so the two cannot disagree -- and
  // falling back to urlPath when a page has no canonical yet.
  const urlPrefix = (() => {
    const full = page?.meta?.canonical || page?.meta?.urlPath || '';
    const slug = page?.meta?.serviceSlug || '';
    if (!full) return '';
    const cut = slug ? full.lastIndexOf(`/${slug}/`) : -1;
    return cut >= 0 ? full.slice(0, cut + 1) : full.replace(/[^/]*\/?$/, '');
  })();

  // Mirrors urlBuilder.slugify. Applied on blur rather than on every keystroke,
  // so typing "teen anxiety" is not fought character by character.
  const slugifyInput = (v) => String(v || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // One entry's cost, mirroring cbhContract.lineCount.
  const eduCostOf = (l) => {
    // Mirrors cbhContract.stripInlineMarkup: a bold sub-label's asterisks are
    // markup, and a counter that charged for them would disagree with the gate.
    const s = String(l || '').replace(/\*\*/g, '').trim();
    if (!s) return 0;
    return Math.ceil(s.length / (eduLineLimits?.lineMaxChars || 85))
      + (eduBulletRe && eduBulletRe.test(s) ? (eduLineLimits?.bulletExtraLines || 0) : 0);
  };
  const eduLinesIn = (h) => {
    const content = (h?.lines || []).reduce((n, l) => n + eduCostOf(l), 0);
    const every = eduLineLimits?.linesBeforeBreak || 3;
    return content + (content > 0 ? Math.floor((content - 1) / every) : 0);
  };
  const eduLineCap = (eduLineLimits?.lineMultiplier || 0)
    * (page?.sections?.educational?.h3s || []).length;

  const orderedCandidates = [
    ...candidates.filter(c => selectedKeys.has(keyOf(c.keyword))),
    ...candidates.filter(c => !selectedKeys.has(keyOf(c.keyword))),
  ];

  return (
    <main style={{ maxWidth: '64rem', margin: '0 auto', padding: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.375rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>
            Clear Behavioral Health — Page Builder
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-2)', margin: '0.25rem 0 0' }}>
            Pick a location and service, approve the keywords, edit the brief, then generate the page from it.
          </p>
        </div>
        <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button style={btnStyle(false)} onClick={() => navigate('/location-page-builder/clear-behavioral/feedback-rules')}>
            Client feedback rules{feedbackSummary
              ? ` (${feedbackSummary.active} active${feedbackSummary.open ? ` · ${feedbackSummary.open} open code change${feedbackSummary.open === 1 ? '' : 's'}` : ''})`
              : ''}
          </button>
          <button style={btnStyle(false)} onClick={() => navigate('/location-page-builder')}>← All Clients</button>
        </span>
      </div>

      <div style={{ marginBottom: '1.5rem' }}><ProgressSteps steps={progressSteps} /></div>

      {loadError && (
        <div style={{ padding: '0.75rem 1rem', borderRadius: 'var(--r-lg)', background: 'var(--danger-soft,#FEF2F2)', color: 'var(--danger,#EF4444)', fontSize: '0.8125rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <span>{loadError}</span>
          <button style={btnStyle(true)} disabled={seeding} onClick={syncList}>{seeding ? 'Syncing…' : 'Sync list'}</button>
        </div>
      )}
      {!data && !loadError && <p style={{ fontSize: '0.875rem', color: 'var(--text-2)' }}>Loading…</p>}

      {/* ── Step 0 ───────────────────────────────────────────────────────── */}
      {data && step === 0 && (
        <SectionCard title="Location + Service" note="Every office offers the full service list.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem' }}>
            <div>
              <label style={labelStyle}>Location <span style={{ fontWeight: 400 }}>({data.locations.length})</span></label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by office or city…" value={locFilter} onChange={e => setLocFilter(e.target.value)} />
              <PickerList groups={groupedLocations} selectedId={locationId} onSelect={selectLocation} emptyMessage="No locations match." />
            </div>
            <div>
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                <span>Service <span style={{ fontWeight: 400 }}>({availableServices.length} available{location ? ` at ${location.location_name}` : ''})</span></span>
                <button
                  style={{ background: 'none', border: 'none', padding: 0, marginLeft: 'auto', fontSize: '0.6875rem', color: 'var(--primary)', cursor: seeding ? 'default' : 'pointer', textDecoration: 'underline' }}
                  disabled={seeding}
                  title="Re-import the service and location list. Addresses, phone numbers and hours you have entered are kept."
                  onClick={syncList}
                >
                  {seeding ? 'Syncing…' : 'Sync list'}
                </button>
              </label>
              <input style={{ ...inputStyle, marginBottom: '0.5rem' }} placeholder="Filter by service…" value={svcFilter} onChange={e => setSvcFilter(e.target.value)} />
              <PickerList groups={groupedServices} selectedId={serviceId} onSelect={selectService} emptyMessage="No services match." />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-2)' }}>
              {service && location
                ? <><strong>{service.name}</strong> in <strong>{location.city}</strong></>
                : 'Select a location and a service to continue.'}
            </span>
            <button style={btnStyle(true)} disabled={!service || !location} onClick={() => setStep(1)}>Next →</button>
          </div>
        </SectionCard>
      )}

      {data && step === 0 && savedPages.length > 0 && (
        <SectionCard title={`Saved pages (${savedPages.length})`} note="Already generated — open one to edit or export it.">
          <div style={{ maxHeight: '16rem', overflowY: 'auto' }}>
            {savedPages.map(pg => (
              <div
                key={pg.id}
                style={{
                  display: 'flex', gap: '0.375rem', alignItems: 'stretch', marginBottom: '0.25rem',
                  opacity: deletingId === pg.id ? 0.5 : 1,
                }}
              >
                <button
                  type="button"
                  onClick={() => openSavedPage(pg.id)}
                  disabled={!!deletingId}
                  style={{
                    display: 'flex', flex: 1, minWidth: 0, gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between',
                    textAlign: 'left', padding: '0.5rem 0.625rem', cursor: 'pointer',
                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)',
                    fontSize: '0.8125rem', color: 'var(--text)',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <strong>{pg.serviceName}</strong> in {pg.locationName}
                    <span style={{ color: 'var(--text-3)' }}> · {pg.urlPath}</span>
                  </span>
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 700, padding: '1px 6px', borderRadius: '9999px', whiteSpace: 'nowrap',
                    background: pg.verdict === 'PASS' ? 'var(--success-soft,#F0FDF4)' : 'var(--warning-soft,#FFFBEB)',
                    color: pg.verdict === 'PASS' ? 'var(--success,#16A34A)' : 'var(--warning,#B45309)',
                  }}>{pg.verdict || '—'}</span>
                </button>
                <button
                  type="button"
                  title={`Delete the page for ${pg.serviceName} in ${pg.locationName}`}
                  aria-label={`Delete the page for ${pg.serviceName} in ${pg.locationName}`}
                  disabled={!!deletingId}
                  onClick={() => deleteSavedPage(pg)}
                  style={{
                    padding: '0.25rem 0.625rem', fontSize: '0.8125rem', fontWeight: 600, whiteSpace: 'nowrap',
                    color: 'var(--danger,#EF4444)', background: 'var(--surface)',
                    border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)',
                    cursor: deletingId ? 'default' : 'pointer',
                  }}
                >
                  {deletingId === pg.id ? '…' : '×'}
                </button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* ── Step 1 ───────────────────────────────────────────────────────── */}
      {data && step === 1 && (
        <SectionCard
          title="Keyword Research"
          note={service && location ? `${service.name} in ${location.city}` : ''}
          actions={<button style={btnStyle(false)} disabled={kwLoading} onClick={runKeywordResearch}>{kwLoading ? 'Researching…' : 'Re-run research'}</button>}
        >
          {kwError && <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.8125rem' }}>{kwError}</p>}
          {kwLoading && <p style={{ color: 'var(--text-2)', fontSize: '0.8125rem' }}>Pulling competitor keyword data…</p>}

          {/* A synthesized Primary is a keyword nothing in the research
              supported. Say so plainly rather than letting a 0 volume pass as
              if it were a finding. */}
          {!kwLoading && (() => {
            const synth = primaryList.filter(k => k.source === 'synthesized');
            if (!synth.length && !kwReviewFailures.length) return null;
            const all = synth.length === primaryList.length;
            return (
              <div style={{ background: 'var(--warning-soft,#FFFBEB)', color: 'var(--warning,#B45309)', padding: '0.875rem 1rem', borderRadius: 'var(--r-lg)', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
                {!!synth.length && (
                  <><strong>
                    {all ? 'These keywords have very low or no search volume.'
                      : `${synth.length} of ${primaryList.length} Primary keywords have very low or no search volume.`}
                  </strong>{' '}
                  {all
                    ? `No keyword combining “${service?.name}” with “${location?.city}” survived research, so Primary was built from the service and location name.`
                    : `Research did not fill every Primary slot, so ${synth.length === 1 ? 'one was' : `${synth.length} were`} built from the service and location name.`}</>
                )}
                {!!kwReviewFailures.length && (
                  <>
                    <div style={{ marginTop: synth.length ? '0.5rem' : 0, fontWeight: 600 }}>Rejected by the review pass:</div>
                    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
                      {kwReviewFailures.map((f, i) => <li key={i}>[{f.slot}] {f.keyword} — {f.reason}</li>)}
                    </ul>
                  </>
                )}
              </div>
            );
          })()}

          {!kwLoading && !!candidates.length && (
            <div style={{ maxHeight: '24rem', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                    {['Keyword', 'Volume', 'KD', 'Primary', 'Secondary'].map(h => (
                      <th key={h} style={{ textAlign: h === 'Keyword' ? 'left' : 'center', padding: '0.375rem 0.625rem', fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderedCandidates.map((c) => {
                    const k = keyOf(c.keyword);
                    const isP = primaryList.some(p => keyOf(p.keyword) === k);
                    const isS = secondaryList.some(p => keyOf(p.keyword) === k);
                    return (
                      <tr key={k} style={{ background: selectedKeys.has(k) ? 'var(--primary-soft)' : 'transparent' }}>
                        <td style={{ padding: '0.3125rem 0.625rem', color: 'var(--text)' }}>
                          {c.keyword}
                          {c.source === 'synthesized' && <span style={{ marginLeft: '0.375rem', fontSize: '0.6875rem', color: 'var(--warning,#B45309)' }}>built, not found</span>}
                        </td>
                        <td style={{ textAlign: 'center', color: 'var(--text-2)' }}>{volumeLabel(c.volume)}</td>
                        <td style={{ textAlign: 'center', color: 'var(--text-3)' }}>{c.difficulty || '—'}</td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={isP} onChange={() => togglePrimary(c)} disabled={!isP && primaryList.length >= MAX_PRIMARY} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={isS} onChange={() => toggleSecondary(c)} disabled={!isS && secondaryList.length >= MAX_SECONDARY} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <input
              style={{ ...inputStyle, flex: '1 1 16rem' }}
              placeholder="Add a keyword by hand…"
              value={manualKeyword}
              onChange={e => setManualKeyword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManualKeyword(); } }}
            />
            <button style={btnStyle(false)} onClick={addManualKeyword}>Add</button>
          </div>

          <p style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginTop: '0.5rem' }}>
            Primary {primaryList.length}/{MAX_PRIMARY} · Secondary {secondaryList.length}/{MAX_SECONDARY}
          </p>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
            <button style={btnStyle(false)} onClick={() => setStep(0)}>← Back</button>
            <button
              style={btnStyle(true)}
              disabled={!primaryList.length}
              onClick={() => { persistKeywords(primaryList, secondaryList, candidates, true); setStep(2); }}
            >Next: build the brief →</button>
          </div>
        </SectionCard>
      )}

      {/* ── Step 2: the brief ────────────────────────────────────────────── */}
      {data && step === 2 && (
        <>
          {briefLoading && (
            <SectionCard title="Building the brief">
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: 0 }}>
                Reading the top competitor pages for “{primaryList[0]?.keyword}”, planning the section stack,
                and looking up an authoritative source for anything the competitors don’t cover…
              </p>
            </SectionCard>
          )}
          {briefError && (
            <SectionCard title="Brief">
              <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.8125rem', margin: 0 }}>{briefError}</p>
            </SectionCard>
          )}

          {brief && !briefLoading && limits && (
            <>
              <SectionCard
                title="Search targets"
                note="What the page is written to rank for."
                actions={<button style={btnStyle(false)} disabled={briefLoading} onClick={rebuildBrief}>Rebuild from research</button>}
              >
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)', margin: '0 0 0.75rem' }}>
                  <strong>Primary:</strong> {brief.primaryKeyword}
                  {brief.secondaryKeywords.length > 0 && (
                    <><br /><strong>Secondary:</strong> {brief.secondaryKeywords.join(' · ')}</>
                  )}
                </p>

                <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Meta title</span>
                  <Count value={brief.meta.title} min={limits.metaTitle.min} max={limits.metaTitle.max} />
                </label>
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                  <input style={inputStyle} value={brief.meta.title}
                    onChange={e => editBrief(b => { b.meta.title = e.target.value; })} />
                  <RegenButton busy={regenBusy === regenKey('brief.meta.title')}
                    onClick={() => regenField('brief.meta.title', null, v => editBrief(b => { b.meta.title = v; }))} />
                </div>
                {/* The window excludes the suffix, so show what actually ships. */}
                <p style={{ fontSize: '0.6875rem', color: 'var(--text-3)', margin: '0.25rem 0 0.75rem' }}>
                  Ships as: {brief.meta.title || '…'} | Clear Behavioral Health
                </p>

                <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Meta description</span>
                  <Count value={brief.meta.description} min={limits.metaDescription.min} max={limits.metaDescription.max} />
                </label>
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
                  <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} value={brief.meta.description}
                    onChange={e => editBrief(b => { b.meta.description = e.target.value; })} />
                  <RegenButton busy={regenBusy === regenKey('brief.meta.description')}
                    onClick={() => regenField('brief.meta.description', null, v => editBrief(b => { b.meta.description = v; }))} />
                </div>
              </SectionCard>

              {(briefWarnings.length > 0 || (regenNote && step === 2)) && (
                <SectionCard
                  title="Client feedback"
                  note={briefDirty
                    ? 'From the last save. Save the brief to re-check your edits.'
                    : 'A planned question or subsection breaks a rule from the client’s feedback. Edit it before generating.'}
                >
                  {regenNote && step === 2 && <p style={{ fontSize: '0.8125rem', color: 'var(--warning,#B45309)', margin: '0 0 0.375rem' }}>{regenNote}</p>}
                  <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8125rem', color: 'var(--warning,#B45309)' }}>
                    {briefWarnings.map((w, i) => <li key={i}>[{w.severity}] {w.title}: {w.detail}</li>)}
                  </ul>
                </SectionCard>
              )}

              <SectionCard
                title={`Educational subsections (${brief.educational.h3s.length})`}
                note={`${limits.educational.h3Count.min}-${limits.educational.h3Count.max} H3s under “What is …”. Each is written from competitor research, or from a named source where the competitors leave a gap.`}
                actions={<button style={btnStyle(false)}
                  disabled={brief.educational.h3s.length >= limits.educational.h3Count.max}
                  onClick={() => editBrief(b => b.educational.h3s.push({ heading: '', intent: '', source: 'fallback', sourceUrl: '' }))}>+ Add H3</button>}
              >
                {(brief.educational.h3s.length < limits.educational.h3Count.min
                  || brief.educational.h3s.length > limits.educational.h3Count.max) && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--warning,#B45309)', margin: '0 0 0.5rem' }}>
                    The guidelines require {limits.educational.h3Count.min}-{limits.educational.h3Count.max} H3s; generating will be refused with {brief.educational.h3s.length}.
                  </p>
                )}
                {brief.educational.h3s.map((h, i) => (
                  <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.625rem', marginBottom: '0.5rem', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.375rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-3)', minWidth: '1.25rem' }}>{i + 1}.</span>
                      <input style={{ ...inputStyle, fontWeight: 600 }} value={h.heading} placeholder="H3 heading"
                        onChange={e => editBrief(b => { b.educational.h3s[i].heading = e.target.value; })} />
                      <Count value={h.heading} max={limits.educational.h3HeadingMaxChars} />
                      <RegenButton busy={regenBusy === regenKey('brief.h3.heading', i)}
                        onClick={() => regenField('brief.h3.heading', i, v => editBrief(b => { b.educational.h3s[i].heading = v; }))} />
                      <SourceTag source={h.source === 'competitor' ? 'competitor' : 'fallback'} labels={CBH_SOURCE_LABELS} />
                    </div>
                    <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start', marginBottom: '0.375rem' }}>
                      <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }}
                        placeholder="What this subsection must cover…" value={h.intent}
                        onChange={e => editBrief(b => { b.educational.h3s[i].intent = e.target.value; })} />
                      <RegenButton busy={regenBusy === regenKey('brief.h3.intent', i)}
                        onClick={() => regenField('brief.h3.intent', i, v => editBrief(b => { b.educational.h3s[i].intent = v; }))} />
                    </div>
                    {/* A fallback section with no source fails QC: an
                        unattributed fallback is indistinguishable from an
                        invented one, which the guidelines forbid. */}
                    {h.source === 'fallback' && (
                      h.sourceUrl
                        ? <p style={{ fontSize: '0.6875rem', margin: '0 0 0.375rem' }}>
                            Source: <a href={h.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>{h.sourceUrl}</a>
                          </p>
                        : <p style={{ fontSize: '0.6875rem', color: 'var(--warning,#B45309)', margin: '0 0 0.375rem' }}>
                            No source found — this section will fail QC until one is added.
                          </p>
                    )}
                    <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                      <button style={{ ...btnStyle(false), padding: '0.125rem 0.5rem' }} onClick={() => moveH3(i, -1)} disabled={i === 0}>↑</button>
                      <button style={{ ...btnStyle(false), padding: '0.125rem 0.5rem' }} onClick={() => moveH3(i, 1)} disabled={i === brief.educational.h3s.length - 1}>↓</button>
                      <button style={{ ...btnStyle(false), padding: '0.125rem 0.5rem', color: 'var(--danger,#EF4444)' }}
                        onClick={() => editBrief(b => b.educational.h3s.splice(i, 1))}>Remove</button>
                    </div>
                  </div>
                ))}
              </SectionCard>

              <SectionCard
                title={`FAQ questions (${brief.faqs.length})`}
                note="Answered verbatim, in this order. Mix location, brand and user-intent questions."
                actions={<button style={btnStyle(false)} disabled={brief.faqs.length >= limits.faqs.count.max}
                  onClick={() => editBrief(b => b.faqs.push({ q: '', type: 'intent' }))}>+ Add question</button>}
              >
                {(brief.faqs.length < limits.faqs.count.min || brief.faqs.length > limits.faqs.count.max) && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--warning,#B45309)', margin: '0 0 0.5rem' }}>
                    The guidelines require {limits.faqs.count.min}-{limits.faqs.count.max} FAQs; {brief.faqs.length} will fail QC.
                  </p>
                )}
                {brief.faqs.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.375rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-3)', minWidth: '1.25rem' }}>{i + 1}.</span>
                    <input style={inputStyle} value={f.q} placeholder="A question a client would actually ask…"
                      onChange={e => editBrief(b => { b.faqs[i].q = e.target.value; })} />
                    <RegenButton busy={regenBusy === regenKey('brief.faq.q', i)}
                      onClick={() => regenField('brief.faq.q', i, v => editBrief(b => { b.faqs[i].q = v; }))} />
                    <select style={{ ...inputStyle, width: '7rem' }} value={f.type}
                      onChange={e => editBrief(b => { b.faqs[i].type = e.target.value; })}>
                      {limits.faqs.types.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button style={{ ...btnStyle(false), padding: '0.25rem 0.5rem', color: 'var(--danger,#EF4444)' }}
                      onClick={() => editBrief(b => b.faqs.splice(i, 1))}>×</button>
                  </div>
                ))}
              </SectionCard>

              <SectionCard title="Fixed sections" note="Set by the client's guidelines — shown so you can see the whole page, not because they are editable.">
                <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                  <li>Hero — H1 and description, written to the keyword</li>
                  <li>Our approach to … — plus “Our philosophy of compassionate care” and “Clinical therapies offered”</li>
                  <li>Insurance accepted</li>
                  <li>What is … — the subsections above</li>
                  <li>Why Choose Clear Behavioral Health?</li>
                  <li>{service?.name} in {location?.city}</li>
                  <li>{service?.name} experts at Clear Behavioral Health, {location?.city}</li>
                </ul>
              </SectionCard>

              {generating && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-2)' }}>
                  Writing all ten sections to their character limits, then re-checking them against QC.
                  This usually takes one to two minutes — longer the first time for a location, while the
                  competitor and source lookups are still cold. Leave the tab open.
                </p>
              )}
              {genError && <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.8125rem' }}>{genError}</p>}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button style={btnStyle(false)} onClick={() => setStep(1)}>← Back to keywords</button>
                <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  {briefDirty && <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>unsaved changes</span>}
                  <button style={btnStyle(false)} disabled={savingBrief || !briefDirty} onClick={() => saveBrief(false)}>
                    {savingBrief ? 'Saving…' : 'Save brief'}
                  </button>
                  <button style={btnStyle(true)} disabled={generating || !brief.educational.h3s.length} onClick={generate}>
                    {generating ? 'Writing the page…' : 'Approve & generate →'}
                  </button>
                </span>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Step 3: the generated page, editable ─────────────────────────── */}
      {step === 3 && page && limits && (
        <>
          <SectionCard
            title="Generated page"
            actions={<>
              <button style={btnStyle(false)} onClick={() => setStep(2)}>← Edit brief</button>
              <button style={btnStyle(false)} disabled={exporting} onClick={exportDocx}>
                {exporting ? 'Exporting…' : 'Export .docx'}
              </button>
              <button style={btnStyle(false)} onClick={downloadJson}>Download JSON</button>
              <button style={btnStyle(true)} disabled={savingPage || !pageDirty} onClick={savePage}>
                {savingPage ? 'Saving…' : pageDirty ? 'Save changes' : 'Saved'}
              </button>
            </>}
          >
            {pageError && <p style={{ color: 'var(--danger,#EF4444)', fontSize: '0.8125rem', marginTop: 0 }}>{pageError}</p>}
            {regenNote && step === 3 && <p style={{ color: 'var(--warning,#B45309)', fontSize: '0.8125rem', marginTop: 0 }}>{regenNote}</p>}

            {/* The page URL, with only the service slug editable. The location
                half comes from the location record and is not this page's to
                change; showing it read-only is what makes the editable part
                unambiguous. urlPath/canonical are recomputed server-side from
                the slug on save, so what is typed here is the only source. */}
            <label style={labelStyle}>Page URL</label>
            <div style={{
              display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.125rem',
              padding: '0.5rem 0.625rem', marginBottom: '0.75rem', fontSize: '0.8125rem',
              fontFamily: 'var(--font-mono)', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)',
            }}>
              <span style={{ color: 'var(--text-3)', wordBreak: 'break-all' }}>{urlPrefix}</span>
              <input
                value={page.meta?.serviceSlug || ''}
                onChange={e => editPage(p => { p.meta.serviceSlug = e.target.value; })}
                onBlur={e => editPage(p => { p.meta.serviceSlug = slugifyInput(e.target.value); })}
                spellCheck={false}
                placeholder="service-slug"
                style={{
                  flex: '1 1 12rem', minWidth: '8rem', padding: '0.125rem 0.375rem',
                  fontSize: '0.8125rem', fontFamily: 'var(--font-mono)', fontWeight: 600,
                  color: 'var(--text)', background: 'var(--card)',
                  border: '1px solid var(--primary)', borderRadius: '4px',
                }}
              />
              <span style={{ color: 'var(--text-3)' }}>/</span>
            </div>

            {/* QC describes what is SAVED. An edit can fix or break a check, so
                a green PASS beside unsaved copy would be a lie. */}
            {page.qc && (
              <div style={{
                padding: '0.625rem 0.875rem', borderRadius: 'var(--r-md,6px)', fontSize: '0.8125rem', marginBottom: '0.75rem',
                background: pageDirty ? 'var(--surface)' : page.qc.verdict === 'PASS' ? 'var(--success-soft,#F0FDF4)' : 'var(--warning-soft,#FFFBEB)',
                color: pageDirty ? 'var(--text-3)' : page.qc.verdict === 'PASS' ? 'var(--success,#16A34A)' : 'var(--warning,#B45309)',
              }}>
                <strong>QC: {page.qc.verdict}</strong>
                {pageDirty && ' — from the last save; edit then Save to re-check.'}
                {(page.qc.checks || []).filter(c => !c.pass && c.group !== 'feedback').length > 0 && (
                  <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
                    {page.qc.checks.filter(c => !c.pass && c.group !== 'feedback').map(c => (
                      <li key={c.id}>[{c.severity}] {c.name} — {c.detail}</li>
                    ))}
                  </ul>
                )}

                {/* The client's feedback rules. Only a page generated under
                    them is checked; an older page says so and is left alone. */}
                <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                  {page.feedback ? (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span>
                          <strong>Client feedback:</strong>{' '}
                          {(page.qc.checks || []).filter(c => c.group === 'feedback' && !c.pass).length
                            ? `${(page.qc.checks || []).filter(c => c.group === 'feedback' && !c.pass).length} issue(s)`
                            : `all ${(page.qc.checks || []).filter(c => c.group === 'feedback').length} checks pass`}
                          <span style={{ color: 'var(--text-3)' }}>
                            {' · '}AI review {page.feedbackReview?.reviewedAt
                              ? `run ${new Date(page.feedbackReview.reviewedAt).toLocaleString()}`
                              : 'not run'}
                          </span>
                        </span>
                        <button style={btnStyle(false)} disabled={rechecking || savingPage || !pageId} onClick={recheckFeedback}
                          title="Saves your edits, then re-runs the AI review against the client feedback rules (one billed call).">
                          {rechecking ? 'Re-checking…' : 'Re-check client feedback'}
                        </button>
                      </div>
                      {(page.qc.checks || []).filter(c => c.group === 'feedback' && !c.pass).length > 0 && (
                        <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
                          {page.qc.checks.filter(c => c.group === 'feedback' && !c.pass).map(c => (
                            <li key={c.id}>[{c.severity}] {c.name.replace(/^Client feedback( \(AI review\))?: /, '')}{c.id.endsWith('_review') ? ' (AI review)' : ''}: {c.detail}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-3)' }}>
                      Generated before the client feedback rules, so it is not checked against them. Regenerate it to bring it under the rules.
                    </span>
                  )}
                </div>
              </div>
            )}

            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Meta title <span style={{ fontWeight: 400 }}>(excluding the brand suffix)</span></span>
              <Count value={page.meta?.title} min={limits.metaTitle.min} max={limits.metaTitle.max} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
              <input style={inputStyle} value={page.meta?.title || ''}
                onChange={e => editPage(p => { p.meta.title = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('meta.title')}
                onClick={() => regenField('meta.title', null, v => editPage(p => { p.meta.title = v; }))} />
            </div>
            <p style={{ fontSize: '0.6875rem', color: 'var(--text-3)', margin: '0.25rem 0 0.75rem' }}>
              Ships as: {page.meta?.title || '…'} | Clear Behavioral Health
            </p>

            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Meta description</span>
              <Count value={page.meta?.metaDescription} min={limits.metaDescription.min} max={limits.metaDescription.max} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} value={page.meta?.metaDescription || ''}
                onChange={e => editPage(p => { p.meta.metaDescription = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('meta.metaDescription')}
                onClick={() => regenField('meta.metaDescription', null, v => editPage(p => { p.meta.metaDescription = v; }))} />
            </div>
          </SectionCard>

          <SectionCard title="Hero">
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>H1</span><Count value={page.sections?.hero?.h1} max={limits.hero.h1MaxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <input style={inputStyle} value={page.sections?.hero?.h1 || ''}
                onChange={e => editPage(p => { p.sections.hero.h1 = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('hero.h1')}
                onClick={() => regenField('hero.h1', null, v => editPage(p => { p.sections.hero.h1 = v; }))} />
            </div>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Description</span><Count value={page.sections?.hero?.description} max={limits.hero.descriptionMaxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} value={page.sections?.hero?.description || ''}
                onChange={e => editPage(p => { p.sections.hero.description = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('hero.description')}
                onClick={() => regenField('hero.description', null, v => editPage(p => { p.sections.hero.description = v; }))} />
            </div>
          </SectionCard>

          <SectionCard
            title={page.sections?.approach?.heading}
            note={`Whole section at most ${limits.approach.sectionMaxChars} characters; each paragraph at most ${limits.approach.paragraphMaxChars}. Separate paragraphs with a blank line.`}
          >
            {[['paragraphs', page.sections?.approach?.heading],
              ['philosophy', page.sections?.approach?.philosophy?.heading],
              ['therapies', page.sections?.approach?.therapies?.heading]].map(([key, heading]) => {
              const paras = key === 'paragraphs'
                ? page.sections?.approach?.paragraphs
                : page.sections?.approach?.[key]?.paragraphs;
              return (
                <div key={key} style={{ marginBottom: '0.75rem' }}>
                  <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                    <span>{heading}</span>
                    <span style={{ fontSize: '0.6875rem', color: 'var(--text-3)' }}>{(paras || []).length} para</span>
                  </label>
                  <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
                    <Paragraphs value={paras} rows={4}
                      onChange={next => editPage(p => {
                        if (key === 'paragraphs') p.sections.approach.paragraphs = next;
                        else p.sections.approach[key].paragraphs = next;
                      })} />
                    <RegenButton busy={regenBusy === regenKey(`approach.${key}`)}
                      onClick={() => regenField(`approach.${key}`, null, v => editPage(p => {
                        if (key === 'paragraphs') p.sections.approach.paragraphs = v;
                        else p.sections.approach[key].paragraphs = v;
                      }))} />
                  </div>
                </div>
              );
            })}
          </SectionCard>

          <SectionCard title={page.sections?.insurance?.heading}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Paragraph</span><Count value={page.sections?.insurance?.paragraph} max={limits.insurance.maxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }} value={page.sections?.insurance?.paragraph || ''}
                onChange={e => editPage(p => { p.sections.insurance.paragraph = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('insurance.paragraph')}
                onClick={() => regenField('insurance.paragraph', null, v => editPage(p => { p.sections.insurance.paragraph = v; }))} />
            </div>
          </SectionCard>

          {/* Each body is counted against its own cap, so the count is shown
              per H3 rather than once for the card. */}
          <SectionCard
            title={page.sections?.educational?.heading}
            note={`Intro at most ${limits.educational.introMaxChars} characters. Every H3 body may take up to ${eduLineCap} lines (${limits.educational.lineMultiplier} per H3). One row is one entry: prose wraps a line every ${limits.educational.lineMaxChars} characters, a row starting “- ” counts as ${1 + (limits.educational.bulletExtraLines || 0)}, and a break after every ${limits.educational.linesBeforeBreak} lines counts as 1. Mix paragraphs and bullets; a row may open with a bold label written **like this**.`}
          >
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Intro</span>
              <Count value={(page.sections?.educational?.paragraphs || []).join(' ')} max={limits.educational.introMaxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <Paragraphs value={page.sections?.educational?.paragraphs} rows={3}
                onChange={next => editPage(p => { p.sections.educational.paragraphs = next; })} />
              <RegenButton busy={regenBusy === regenKey('educational.paragraphs')}
                onClick={() => regenField('educational.paragraphs', null, v => editPage(p => { p.sections.educational.paragraphs = v; }))} />
            </div>

            {(page.sections?.educational?.h3s || []).map((h, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.625rem', margin: '0.5rem 0 0', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.375rem' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={h.heading || ''}
                    onChange={e => editPage(p => { p.sections.educational.h3s[i].heading = e.target.value; })} />
                  <Count value={h.heading} max={limits.educational.h3HeadingMaxChars} />
                  <RegenButton busy={regenBusy === regenKey('educational.h3.heading', i)}
                    onClick={() => regenField('educational.h3.heading', i, v => editPage(p => { p.sections.educational.h3s[i].heading = v; }))} />
                  <SourceTag source={h.source === 'competitor' ? 'competitor' : 'fallback'} labels={CBH_SOURCE_LABELS} />
                </div>
                {h.source === 'fallback' && h.sourceUrl && (
                  <p style={{ fontSize: '0.6875rem', margin: '0 0 0.375rem' }}>
                    Source: <a href={h.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>{h.sourceUrl}</a>
                  </p>
                )}
                {(h.lines || []).map((line, j) => (
                  <div key={j} style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                    {/* A textarea, not an input: an entry is a paragraph as
                        often as it is a bullet, and a single-line box taught
                        the reviewer to keep every entry to one sentence. */}
                    <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }} value={line}
                      onChange={e => editPage(p => { p.sections.educational.h3s[i].lines[j] = e.target.value; })} />
                    {/* What this entry COSTS, not how close it is to 85 -- the
                        85 is where a line wraps, not a limit on the entry. */}
                    <span style={{ fontSize: '0.6875rem', fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--text-3)' }}>
                      {eduCostOf(line)}L · {String(line || '').trim().length}
                    </span>
                    {/* Rewrites this line in place, so it cannot change how
                        many lines the section spends. */}
                    <RegenButton busy={regenBusy === regenKey('educational.h3.line', i, j)}
                      title="Regenerate this line"
                      onClick={() => regenField('educational.h3.line', i,
                        v => editPage(p => { p.sections.educational.h3s[i].lines[j] = v; }), j)} />
                    <button style={{ ...btnStyle(false), padding: '0.125rem 0.5rem', color: 'var(--danger,#EF4444)' }}
                      onClick={() => editPage(p => p.sections.educational.h3s[i].lines.splice(j, 1))}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6875rem', color: eduLinesIn(h) > eduLineCap ? 'var(--warning,#B45309)' : 'var(--text-3)' }}>
                    {eduLinesIn(h)}/{eduLineCap} lines
                  </span>
                  {eduLinesIn(h) < eduLineCap && (
                    <button style={{ ...btnStyle(false), padding: '0.125rem 0.5rem', fontSize: '0.6875rem' }}
                      onClick={() => editPage(p => p.sections.educational.h3s[i].lines.push(''))}>+ line</button>
                  )}
                  {/* The whole body regenerates together, so the rewrite can
                      spend the body's allowance as a whole rather than being
                      pinned to the line count it happens to have now. */}
                  <RegenButton busy={regenBusy === regenKey('educational.h3.lines', i)}
                    title="Regenerate this section's body"
                    onClick={() => regenField('educational.h3.lines', i, v => editPage(p => { p.sections.educational.h3s[i].lines = v; }))} />
                </div>
              </div>
            ))}
          </SectionCard>

          <SectionCard title={page.sections?.uvp?.heading}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Paragraph</span><Count value={page.sections?.uvp?.paragraph} max={limits.uvp.maxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} value={page.sections?.uvp?.paragraph || ''}
                onChange={e => editPage(p => { p.sections.uvp.paragraph = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('uvp.paragraph')}
                onClick={() => regenField('uvp.paragraph', null, v => editPage(p => { p.sections.uvp.paragraph = v; }))} />
            </div>
          </SectionCard>

          <SectionCard title={page.sections?.service?.heading}>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Paragraph</span><Count value={page.sections?.service?.paragraph} max={limits.service.maxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }} value={page.sections?.service?.paragraph || ''}
                onChange={e => editPage(p => { p.sections.service.paragraph = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('service.paragraph')}
                onClick={() => regenField('service.paragraph', null, v => editPage(p => { p.sections.service.paragraph = v; }))} />
            </div>
          </SectionCard>

          {/* On a page generated now this H2 is built by code ("<Service>
              experts at Clear Behavioral Health, <City>") and shown like the
              other fixed headings. A page generated before that keeps the
              heading its writer composed, and it stays editable there. */}
          <SectionCard title={page.meta?.fixedExpertsHeading ? page.sections?.treatment?.heading : 'Treatment'}
            note={page.meta?.fixedExpertsHeading ? undefined : 'The H2 here is written, not fixed — it should name the team, the service and the city.'}>
            {!page.meta?.fixedExpertsHeading && (<>
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>H2</span><Count value={page.sections?.treatment?.heading} max={limits.treatment.headingMaxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <input style={{ ...inputStyle, fontWeight: 600 }} value={page.sections?.treatment?.heading || ''}
                onChange={e => editPage(p => { p.sections.treatment.heading = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('treatment.heading')}
                onClick={() => regenField('treatment.heading', null, v => editPage(p => { p.sections.treatment.heading = v; }))} />
            </div>
            </>)}
            <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
              <span>Paragraph</span><Count value={page.sections?.treatment?.paragraph} max={limits.treatment.maxChars} />
            </label>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
              <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} value={page.sections?.treatment?.paragraph || ''}
                onChange={e => editPage(p => { p.sections.treatment.paragraph = e.target.value; })} />
              <RegenButton busy={regenBusy === regenKey('treatment.paragraph')}
                onClick={() => regenField('treatment.paragraph', null, v => editPage(p => { p.sections.treatment.paragraph = v; }))} />
            </div>
          </SectionCard>

          <SectionCard
            title={`${page.sections?.faq?.heading} (${(page.sections?.faq?.items || []).length})`}
            actions={<button style={btnStyle(false)}
              disabled={(page.sections?.faq?.items || []).length >= limits.faqs.count.max}
              onClick={() => editPage(p => p.sections.faq.items.push({ q: '', a: '', type: 'intent' }))}>+ Add FAQ</button>}
          >
            {(page.sections?.faq?.items || []).map((f, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md,6px)', padding: '0.625rem', marginBottom: '0.5rem', background: 'var(--surface)' }}>
                <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '0.375rem' }}>
                  <input style={{ ...inputStyle, fontWeight: 600 }} value={f.q || ''} placeholder="Question"
                    onChange={e => editPage(p => { p.sections.faq.items[i].q = e.target.value; })} />
                  <RegenButton busy={regenBusy === regenKey('faq.q', i)}
                    onClick={() => regenField('faq.q', i, v => editPage(p => { p.sections.faq.items[i].q = v; }))} />
                  <select style={{ ...inputStyle, width: '7rem' }} value={f.type || 'intent'}
                    onChange={e => editPage(p => { p.sections.faq.items[i].type = e.target.value; })}>
                    {limits.faqs.types.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button style={{ ...btnStyle(false), padding: '0.25rem 0.5rem', color: 'var(--danger,#EF4444)' }}
                    onClick={() => editPage(p => p.sections.faq.items.splice(i, 1))}>×</button>
                </div>
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start' }}>
                  <textarea rows={2} style={{ ...inputStyle, resize: 'vertical' }} value={f.a || ''} placeholder="Answer"
                    onChange={e => editPage(p => { p.sections.faq.items[i].a = e.target.value; })} />
                  <Count value={f.a} max={limits.faqs.answerMaxChars} />
                  <RegenButton busy={regenBusy === regenKey('faq.a', i)}
                    onClick={() => regenField('faq.a', i, v => editPage(p => { p.sections.faq.items[i].a = v; }))} />
                </div>
              </div>
            ))}
          </SectionCard>
        </>
      )}
    </main>
  );
}
