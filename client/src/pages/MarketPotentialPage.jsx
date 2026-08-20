import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SectionHeader } from '../ui/SectionHeader';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Field } from '../ui/Field';
import { useToast } from '../ui/Toast';
import { mp } from '../lib/marketPotentialApi';
import { refreshSemrushBalance } from '../lib/semrushBalanceStore';
import USMetroMap from '../components/USMetroMap';
import DecisionBoard, { topMarket } from '../components/marketPotential/DecisionBoard';
import ScenarioDiff from '../components/marketPotential/ScenarioDiff';
import { scoreRows, WEIGHT_PRESETS } from '../components/marketPotential/scoring';
import { loadAssumptions, saveAssumptions } from '../components/marketPotential/assumptions';
import ModuleRuns from '../components/ModuleRuns';

/* ── Step machine: setup → signals → regions → results ── */
const STEPS = [
  { id: 'setup',   label: 'Home & Service' },
  { id: 'basket',  label: 'Search Demand Signals' },   // renamed (Item 7)
  { id: 'regions', label: 'Candidate Regions' },
  { id: 'results', label: 'Compare & Rank' },
];

const INTENT_META = {
  'commercial-local':   { label: 'Local',   variant: 'success' },
  'commercial-cost':    { label: 'Cost',    variant: 'warning' },
  'commercial-general': { label: 'General', variant: 'info' },
};

const SAVED_KEY = 'marketPotential_savedAnalyses';
const WEIGHTS_KEY = 'marketPotential_weights';

/* ── Small helpers ── */
const shortName = (name) => name.split(',')[0].split('–')[0].trim();

function radiusLabel(mi) {
  if (mi < 200) return 'Regional cluster · same-day drive market';
  if (mi <= 400) return 'Multi-state region · short-haul flight territory';
  return 'National expansion scope';
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; }
}

function loadWeights() {
  try {
    const w = JSON.parse(localStorage.getItem(WEIGHTS_KEY) || 'null');
    if (w && typeof w === 'object') return w;
  } catch { /* ignore */ }
  return { ...WEIGHT_PRESETS.balanced.weights };
}

/* ── Geo picker with debounced candidate search ── */
function GeoPicker({ onPick, placeholder }) {
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!q.trim()) { setCandidates([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { candidates } = await mp.searchGeo(q);
        setCandidates(candidates);
        setOpen(true);
      } catch { /* ignore */ }
    }, 220);
    return () => clearTimeout(timer.current);
  }, [q]);

  return (
    <div style={{ position: 'relative' }}>
      <Field
        as="input"
        placeholder={placeholder || 'Type a metro… e.g. Phoenix'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => candidates.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && candidates.length > 0 && (
        <div style={{
          position: 'absolute', top: 40, left: 0, right: 0, zIndex: 20,
          background: 'var(--card)', border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)', maxHeight: 240, overflowY: 'auto',
        }}>
          {candidates.map((c) => (
            <button
              key={c.id}
              onMouseDown={() => { onPick(c); setQ(''); setCandidates([]); setOpen(false); }}
              style={{
                display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left',
                padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, color: 'var(--text)', borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <span>{c.displayName}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{(c.population / 1e6).toFixed(1)}M</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Region chip ── */
function RegionChip({ region, onRemove, tone = 'neutral', meta }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 10px',
      borderRadius: 'var(--r-pill)', fontSize: 12, background: tone === 'home' ? 'var(--primary-soft)' : 'var(--surface)',
      color: tone === 'home' ? 'var(--primary-text)' : 'var(--text)', border: '1px solid var(--border)',
    }}>
      {region.displayName}
      {meta && <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{meta}</span>}
      {onRemove && (
        <button onClick={onRemove} style={{ display: 'flex', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.6, padding: 0 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      )}
    </span>
  );
}

export default function MarketPotentialPage() {
  const toastCtx = useToast();
  // Toast wrapper (Item 1): useToast() exposes { add, remove }, NOT .error/.success.
  const toast = {
    error: (m) => toastCtx.add({ title: m, variant: 'danger' }),
    success: (m) => toastCtx.add({ title: m, variant: 'success' }),
    info: (m) => toastCtx.add({ title: m, variant: 'info' }),
  };

  const [step, setStep] = useState('setup');
  const [meta, setMeta] = useState(null);

  // setup
  const [serviceName, setServiceName] = useState('');
  const [homeRegions, setHomeRegions] = useState([]);
  const [ownDomain, setOwnDomain] = useState(''); // optional "your domain" (Phase 2)

  // basket / signals
  const [service, setService] = useState(null);
  const [basket, setBasket] = useState(null);
  const [basketState, setBasketState] = useState(null); // 'draft' | 'active'
  const [proposalSource, setProposalSource] = useState(null);
  const [newTerm, setNewTerm] = useState('');

  // regions
  const [suggestions, setSuggestions] = useState([]);
  const [radius, setRadius] = useState(350);
  const [compared, setCompared] = useState([]);

  // results
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [weights, setWeights] = useState(loadWeights); // Opportunity-Score weights (persisted)

  // saved scenarios (Phase 4 — server-backed, replaces localStorage analyses)
  const [scenarios, setScenarios] = useState([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [diffSel, setDiffSel] = useState([]);   // scenario ids checked for comparison
  const [diff, setDiff] = useState(null);        // { left, right } once both loaded

  // all metros (for the interactive selection map)
  const [allMetros, setAllMetros] = useState([]);

  const radiusTimer = useRef(null);

  useEffect(() => { mp.meta().then(setMeta).catch(() => {}); }, []);
  useEffect(() => { mp.allGeo().then((d) => setAllMetros(d.regions || [])).catch(() => {}); }, []);
  useEffect(() => { try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights)); } catch { /* ignore */ } }, [weights]);

  // Rows carrying opportunityScore + tier for the current weights (reorders w/o refetch).
  const scoredRows = useMemo(() => (result ? scoreRows(result.rows, weights) : []), [result, weights]);

  const maxRegions = meta?.maxCompareRegions || 10;

  // Toggle a metro in/out of the comparison (home stays fixed). Enforces the cap.
  const toggleCompared = (m) => {
    if (homeRegions.find((r) => r.id === m.id)) return;
    if (compared.find((r) => r.id === m.id)) {
      setCompared((prev) => prev.filter((r) => r.id !== m.id));
      return;
    }
    if (compared.length >= maxRegions) {
      toast.error(`You can compare at most ${maxRegions} regions — remove one first.`);
      return;
    }
    setCompared((prev) => [...prev, m]);
  };

  const isDemo = meta?.dataSource === 'demo';
  const units = meta?.units?.enabled ? meta.units : null;
  const densityCfg = meta?.density?.enabled ? meta.density : null;
  const lowCredits = units && units.dailyRemaining < units.dailyCap * 0.1;

  // Upper-bound per-run estimate incl. competitor density (Item 3).
  const rankableCount = basket ? basket.terms.filter((t) => !t.isGeoTemplate).length : 0;
  const pendingRegions = homeRegions.length + compared.length;
  const perRegionLines = rankableCount + (densityCfg ? densityCfg.terms * densityCfg.topN : 0);
  const estUnits = units ? pendingRegions * perRegionLines * units.rate : 0;
  const overRun = units && estUnits > units.perRunCap;
  const overDay = units && estUnits > units.dailyRemaining;

  /* ── Step 1 → resolve service + basket ── */
  const startAnalysis = async () => {
    if (!serviceName.trim()) return toast.error('Enter a service.');
    if (!homeRegions.length) return toast.error('Add at least one home market.');
    setBusy(true);
    try {
      const r = await mp.resolveService(serviceName.trim(), ownDomain.trim() || undefined);
      setService(r.service);
      setBasket(r.basket);
      setBasketState(r.basketState);
      setProposalSource(r.proposalSource || null);
      setStep('basket');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const regenerateBasket = async () => {
    setBusy(true);
    try {
      const r = await mp.proposeBasket(service.id);
      setBasket(r.basket);
      setProposalSource(r.proposalSource);
      toast.success('Fresh signals proposed.');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const removeTerm = (termId) => setBasket((b) => ({ ...b, terms: b.terms.filter((t) => t.id !== termId) }));
  const addTerm = () => {
    const t = newTerm.trim().toLowerCase();
    if (!t) return;
    setBasket((b) => ({ ...b, terms: [...b.terms, { id: `tmp_${Date.now()}`, term: t, intentTag: 'commercial-general', isGeoTemplate: false }] }));
    setNewTerm('');
  };

  const fetchSuggestions = useCallback(async (radiusVal) => {
    const { suggestions } = await mp.adjacency(homeRegions.map((r) => r.id), { radiusMiles: radiusVal, limit: 8 });
    setSuggestions(suggestions);
    return suggestions;
  }, [homeRegions]);

  const approveBasket = async () => {
    setBusy(true);
    try {
      if (basketState === 'draft') {
        await mp.saveDraft(service.id, basket.terms.map((t) => ({ term: t.term, intentTag: t.intentTag, isGeoTemplate: t.isGeoTemplate })));
        const frozen = await mp.freezeBasket(service.id);
        setBasket(frozen.basket);
        setBasketState('active');
        toast.success(`Signals confirmed (v${frozen.basket.version}).`);
      }
      const s = await fetchSuggestions(radius);
      setCompared(s.slice(0, maxRegions)); // default: approve suggestions up to the cap
      setStep('regions');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  // Live-update the suggested metros as the radius slider moves (Item 9, debounced).
  useEffect(() => {
    if (step !== 'regions' || !homeRegions.length) return;
    clearTimeout(radiusTimer.current);
    radiusTimer.current = setTimeout(() => { fetchSuggestions(radius).catch(() => {}); }, 300);
    return () => clearTimeout(radiusTimer.current);
  }, [radius, step, homeRegions, fetchSuggestions]);

  // Run a comparison for explicit ids (used by the wizard and scenario reload).
  const runCompareWith = async (svcId, homeIds, comparedIds) => {
    setBusy(true);
    try {
      const r = await mp.compare({ serviceId: svcId, homeGeoIds: homeIds, comparedGeoIds: comparedIds });
      setResult(r);
      if (r.usage) setMeta((m) => (m ? { ...m, units: { ...m.units, ...r.usage } } : m));
      setStep('results');
      refreshSemrushBalance();
      return r;
    } catch (e) { toast.error(e.message); throw e; } finally { setBusy(false); }
  };

  const runCompare = () => runCompareWith(service.id, homeRegions.map((r) => r.id), compared.map((r) => r.id)).catch(() => {});

  /* ── Scenarios (Phase 4 — server-backed) ── */
  const refreshScenarios = async () => {
    try { const d = await mp.scenarios(); setScenarios(d.scenarios || []); } catch { /* ignore */ }
  };

  const regionsFromIds = (ids) => {
    const byId = new Map(allMetros.map((m) => [m.id, m]));
    return (ids || []).map((id) => byId.get(id)).filter(Boolean);
  };

  const saveAnalysis = async () => {
    if (!service || !result) return;
    const dflt = `${service.name} — ${shortName(homeRegions[0]?.displayName || homeName)} — ${new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
    const name = window.prompt('Name this scenario', dflt);
    if (!name) return;
    try {
      await mp.saveScenario({
        name, serviceId: service.id, serviceName: service.name,
        basketVersion: result.basketVersion,
        homeGeoIds: homeRegions.map((r) => r.id), comparedGeoIds: compared.map((r) => r.id),
        weightsUsed: weights, assumptions: loadAssumptions(service.id), yearMonth: result.yearMonth,
      });
      await refreshScenarios();
      toast.success('Scenario saved to your account.');
    } catch (e) { toast.error(e.message); }
  };

  // Cold-reload unit estimate (§8 formula). Needs the basket size → resolve service.
  const estimateScenarioUnits = async (scn, regionCount) => {
    if (!units || !scn.serviceName) return null;
    try {
      const resolved = await mp.resolveService(scn.serviceName);
      const rc = (resolved.basket?.terms || []).filter((t) => !t.isGeoTemplate).length;
      const perRegion = rc + (densityCfg ? densityCfg.terms * densityCfg.topN : 0);
      return regionCount * perRegion * units.rate;
    } catch { return null; }
  };

  const loadScenario = async (scn) => {
    setSavedOpen(false);
    const homeR = regionsFromIds(scn.homeGeoIds);
    const comparedR = regionsFromIds(scn.comparedGeoIds);
    setService({ id: scn.serviceId, name: scn.serviceName || 'Saved service' });
    setHomeRegions(homeR);
    setCompared(comparedR);
    if (scn.weightsUsed) setWeights(scn.weightsUsed);
    if (scn.assumptions && scn.serviceId) saveAssumptions(scn.serviceId, scn.assumptions);

    // Month-change guard: a new month means a cold fetch → confirm cost first (§5.3).
    const curMonth = meta?.yearMonth;
    if (scn.yearMonth && curMonth && scn.yearMonth !== curMonth) {
      const est = await estimateScenarioUnits(scn, homeR.length + comparedR.length);
      const msg = est != null
        ? `Saved in ${scn.yearMonth}; reloading in ${curMonth} needs a live re-fetch of up to ~${est.toLocaleString()} SEMrush units. Refresh with live data?`
        : `Saved in ${scn.yearMonth}; reloading in ${curMonth} may spend SEMrush units. Refresh with live data?`;
      if (!window.confirm(msg)) {
        setStep('regions');
        toast.info('Scenario loaded — review regions, then run when ready.');
        return;
      }
    }
    try { await runCompareWith(scn.serviceId, scn.homeGeoIds || [], scn.comparedGeoIds || []); }
    catch { setStep('regions'); }
  };

  const deleteScenario = async (id) => {
    try {
      await mp.deleteScenario(id);
      setScenarios((prev) => prev.filter((s) => s.id !== id));
      setDiffSel((prev) => prev.filter((x) => x !== id));
    } catch (e) { toast.error(e.message); }
  };

  const migrateLocalScenarios = async () => {
    const local = loadSaved();
    if (!local.length) return;
    if (window.confirm(`Import ${local.length} saved ${local.length === 1 ? 'analysis' : 'analyses'} from this browser into your account?`)) {
      let n = 0;
      for (const e of local) {
        const serviceId = e.results?.service?.id;
        if (!serviceId) continue;
        try {
          await mp.saveScenario({
            name: e.name, serviceId, serviceName: e.service,
            basketVersion: e.results?.basketVersion,
            homeGeoIds: (e.homeMarkets || []).map((r) => r.id), comparedGeoIds: (e.candidateRegions || []).map((r) => r.id),
            weightsUsed: null, assumptions: null, yearMonth: e.results?.yearMonth,
          });
          n++;
        } catch { /* skip unresolved */ }
      }
      if (n) toast.success(`Imported ${n} saved ${n === 1 ? 'analysis' : 'analyses'}.`);
      await refreshScenarios();
    }
    localStorage.removeItem(SAVED_KEY); // ask only once
  };

  // Load server scenarios + one-time-migrate any V1 localStorage analyses (§5.2).
  useEffect(() => { refreshScenarios(); migrateLocalScenarios(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Diff: pick two scenarios of the same service (same month → cache-first, §5.4).
  const toggleDiffSel = (id) => {
    setDiffSel((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [prev[1], id] : [...prev, id]);
  };

  const runDiff = async () => {
    const [aId, bId] = diffSel;
    const a = scenarios.find((s) => s.id === aId), b = scenarios.find((s) => s.id === bId);
    if (!a || !b) return;
    if (a.serviceId !== b.serviceId) return toast.error('Pick two scenarios of the same service.');
    const curMonth = meta?.yearMonth;
    if (a.yearMonth !== curMonth || b.yearMonth !== curMonth) {
      return toast.info('Both scenarios must be from the current month to compare without a live re-fetch.');
    }
    setSavedOpen(false); setBusy(true);
    try {
      const side = async (scn) => {
        const r = await mp.compare({ serviceId: scn.serviceId, homeGeoIds: scn.homeGeoIds || [], comparedGeoIds: scn.comparedGeoIds || [] });
        return { name: scn.name, rows: scoreRows(r.rows, scn.weightsUsed || weights) };
      };
      const left = await side(a), right = await side(b);
      setDiff({ left, right });
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const exportCsv = () => {
    if (!result) return;
    // Reproducible export: score with the BALANCED preset regardless of on-screen
    // weights, and print the weights used (spec §2.2). Dollar figures stay out of
    // the CSV — they're assumption-dependent (the one-pager carries them, §3.4).
    const bw = WEIGHT_PRESETS.balanced.weights;
    const rows = scoreRows(result.rows, bw).sort((a, b) => (b.opportunityScore ?? -1) - (a.opportunityScore ?? -1));
    const pick = topMarket(rows);
    const summary = pick
      ? `Top market (Balanced weighting): ${pick.region} — Opportunity Score ${pick.opportunityScore}${pick.demandIndex != null ? `, Demand Index ${pick.demandIndex}` : ''}${pick.yoyPct != null ? `, ${pick.yoyPct > 0 ? '+' : ''}${pick.yoyPct}% YoY` : ''}, ${pick.competitorDensity != null ? pick.competitorDensity : 'n/a'} competitors in top 10`
      : 'No standout market in this run';
    const weightsNote = `Score weights (Balanced): demand ${Math.round(bw.demand * 100)}%, openness ${Math.round(bw.competition * 100)}%, growth ${Math.round(bw.trend * 100)}%, cost ${Math.round(bw.cost * 100)}%`;
    const header = ['Market', 'Opportunity Score (Balanced)', 'Tier', 'Confidence', 'Demand Index (home=100)', 'Est. searches/mo', 'Competitors in top 10', 'Providers', 'Directories', 'You rank here', 'Trend 12mo', 'CPC', 'Population'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const toLine = (arr) => arr.map(esc).join(',');
    const lines = [toLine([summary]), toLine([weightsNote]), toLine(header)];
    for (const r of rows) {
      const cb = r.competitorBreakdown;
      lines.push(toLine([
        r.region,
        r.isHome ? 'home' : (r.opportunityScore ?? ''),
        r.isHome ? 'Home' : (r.tier || ''),
        r.confidence || '',
        r.demandIndex ?? '',
        r.estMonthlySearches ?? '',
        r.competitorDensity ?? '',
        cb ? cb.providers : '',
        cb ? cb.directories : '',
        cb ? (cb.youRankHere ? 'yes' : 'no') : '',
        r.yoyPct == null ? '' : `${r.yoyPct}%`,
        r.medianCpc,
        r.population ?? '',
      ]));
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `market-potential-${(service.name || 'analysis').replace(/\s+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setStep('setup'); setService(null); setBasket(null); setBasketState(null);
    setSuggestions([]); setCompared([]); setResult(null);
  };

  const homeName = result?.rows.find((r) => r.isHome)?.region || homeRegions[0]?.displayName || 'your home market';

  /* ── Render ── */
  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1080, margin: '0 auto' }}>
      <SectionHeader
        eyebrow="Market Intelligence"
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          Healthcare Market Potential
          <Badge variant="info">Beta</Badge>
          {meta && (
            <span
              title={`${meta.method === 'templated' ? 'Live via SEMrush · templated [service] [city] method' : 'Live via ' + meta.dataSource} · ${meta.metroCount} metros · bucket ${meta.yearMonth}`}
              style={{ fontSize: 12, color: 'var(--text-3)', cursor: 'help', border: '1px solid var(--border)', borderRadius: '50%', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >i</span>
          )}
        </span>}
        subtitle="Live via SEMrush · Beta — compare commercial search demand for a service across the metros you operate in and adjacent metros you might expand into."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {units && (
              <Badge variant={lowCredits ? 'warning' : 'info'}>SEMrush: {units.dailyRemaining.toLocaleString()} credits</Badge>
            )}
            {scenarios.length > 0 && (
              <div style={{ position: 'relative' }}>
                <Button variant="ghost" size="sm" onClick={() => setSavedOpen((v) => !v)}>Saved ({scenarios.length})</Button>
                {savedOpen && (
                  <div style={{ position: 'absolute', right: 0, top: 36, zIndex: 30, width: 328, background: 'var(--card)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)', maxHeight: 380, overflowY: 'auto' }}>
                    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{diffSel.length ? `${diffSel.length} selected to compare` : 'Tick 2 to compare'}</span>
                      {diffSel.length === 2 && <Button size="sm" onClick={runDiff}>Compare →</Button>}
                    </div>
                    {scenarios.map((s) => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                        <input type="checkbox" checked={diffSel.includes(s.id)} onChange={() => toggleDiffSel(s.id)} title="Select for comparison" style={{ accentColor: 'var(--primary)' }} />
                        <button onClick={() => loadScenario(s)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 12 }}>
                          <div style={{ fontWeight: 600 }}>{s.name}</div>
                          <div style={{ color: 'var(--text-3)', fontSize: 11 }}>{s.serviceName || ''}{s.yearMonth ? ` · ${s.yearMonth}` : ''}</div>
                        </button>
                        <button onClick={() => deleteScenario(s.id)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex' }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {step !== 'setup' && <Button variant="ghost" size="sm" onClick={reset}>Start over</Button>}
          </div>
        }
      />

      {/* Warning banners only — demo mode or low credits (Item 12) */}
      {isDemo && (
        <div style={{ marginBottom: 20, padding: '8px 12px', borderRadius: 'var(--r-md)', fontSize: 12, background: 'var(--warning-soft)', color: 'var(--warning)' }}>
          <b>Demo data</b> — no provider key configured. Volumes are deterministic placeholders.
        </div>
      )}
      {lowCredits && (
        <div style={{ marginBottom: 20, padding: '8px 12px', borderRadius: 'var(--r-md)', fontSize: 12, background: 'var(--warning-soft)', color: 'var(--warning)' }}>
          <b>Low SEMrush credits</b> — only {units.dailyRemaining.toLocaleString()} of {units.dailyCap.toLocaleString()} units left today (resets 00:00 UTC).
        </div>
      )}

      {/* Stepper */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 28, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => {
          const active = s.id === step;
          const done = STEPS.findIndex((x) => x.id === step) > i;
          return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 'var(--r-pill)',
              fontSize: 12, fontWeight: active ? 600 : 500,
              background: active ? 'var(--primary-soft)' : done ? 'var(--success-soft)' : 'var(--surface)',
              color: active ? 'var(--primary-text)' : done ? 'var(--success)' : 'var(--text-3)',
              border: '1px solid var(--border)',
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, background: active ? 'var(--primary)' : done ? 'var(--success)' : 'var(--border)',
                color: active || done ? '#fff' : 'var(--text-3)',
              }}>{done ? '✓' : i + 1}</span>
              {s.label}
            </div>
          );
        })}
      </div>

      {/* ── STEP 1: setup ── */}
      {step === 'setup' && (
        <div style={{ display: 'grid', gap: 24, maxWidth: 620 }}>
          <div>
            <label style={labelStyle}>Service</label>
            <Field
              as="input"
              placeholder="e.g. dental implants, behavioral health, physical therapy"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              helper="One service per comparison. A fixed set of search terms is measured across all regions."
            />
          </div>
          <div>
            <label style={labelStyle}>Home market(s)</label>
            <GeoPicker onPick={(c) => setHomeRegions((prev) => prev.find((r) => r.id === c.id) ? prev : [...prev, c])} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              {homeRegions.length === 0
                ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No home markets yet — search and confirm the exact metro.</span>
                : homeRegions.map((r) => (
                  <RegionChip key={r.id} region={r} tone="home" onRemove={() => setHomeRegions((prev) => prev.filter((x) => x.id !== r.id))} />
                ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Your domain <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>· optional</span></label>
            <Field
              as="input"
              placeholder="e.g. yourclinic.com"
              value={ownDomain}
              onChange={(e) => setOwnDomain(e.target.value)}
              helper="If set, we flag the markets where your site already ranks in the top 10 (“you rank here”)."
            />
          </div>
          <div>
            <Button onClick={startAnalysis} loading={busy} disabled={!serviceName.trim() || !homeRegions.length}>
              Continue →
            </Button>
          </div>

          {/* What you'll get (Item 10) */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '16px 18px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 10 }}>What you'll get</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[
                'A ranked table of up to 10 metros by per-capita search demand',
                'Competitor density and 12-month growth trend per market',
                'A US bubble map visualising relative demand by metro',
                'An exportable summary to share with your team',
              ].map((t, i) => (
                <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-2)' }}>
                  <span style={{ color: 'var(--success)' }}>✓</span>{t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── STEP 2: signals ── */}
      {step === 'basket' && basket && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 720 }}>
              {basketState === 'active'
                ? <>These <b>{rankableCount}</b> service terms represent how patients look for this service. Each is measured as <code>[term] [city]</code> in every market — SEMrush is national, so the city in the query supplies the local signal.</>
                : <>Proposed service terms{proposalSource ? ` (${proposalSource})` : ''}. Each is combined with a city (<code>[term] [city]</code>) to measure local demand. Review, edit, then confirm.</>}
            </div>
            {basketState === 'draft' && <Button variant="secondary" size="sm" onClick={regenerateBasket} loading={busy}>Regenerate</Button>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {basket.terms.map((t) => {
              const im = INTENT_META[t.intentTag] || INTENT_META['commercial-general'];
              return (
                <div key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
                }}>
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--text)' }}>
                    {t.term} <span style={{ color: 'var(--text-3)' }}>+ [city]</span>
                  </span>
                  <Badge variant={im.variant}>{im.label}</Badge>
                  {basketState === 'draft' && (
                    <button onClick={() => removeTerm(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {basketState === 'draft' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 20, maxWidth: 460 }}>
              <div style={{ flex: 1 }}>
                <Field as="input" placeholder="Add a service term (city is added automatically)…" value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTerm()} />
              </div>
              <Button variant="secondary" onClick={addTerm}>Add</Button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="ghost" onClick={() => setStep('setup')}>← Back</Button>
            <Button onClick={approveBasket} loading={busy}>Confirm signals &amp; continue →</Button>
          </div>
        </div>
      )}

      {/* ── STEP 3: regions ── */}
      {step === 'regions' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Adjacency radius</span>
              <input type="range" min={100} max={800} step={50} value={radius}
                onChange={(e) => setRadius(Number(e.target.value))} style={{ width: 220 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{radius} mi</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {suggestions.length} metros in range</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--primary-text)', marginTop: 4 }}>{radiusLabel(radius)}</div>
          </div>

          {/* Interactive US map — click a metro to add/remove it from the comparison */}
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Pick regions on the map</label>
            <USMetroMap
              mode="select"
              metros={allMetros}
              homeIds={homeRegions.map((r) => r.id)}
              selectedIds={compared.map((r) => r.id)}
              onToggle={toggleCompared}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Home markets</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {homeRegions.map((r) => <RegionChip key={r.id} region={r} tone="home" />)}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>
              Candidate regions to compare ({compared.length} / {maxRegions})
              {compared.length >= maxRegions && <span style={{ color: 'var(--warning)', fontWeight: 500 }}> · limit reached</span>}
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {compared.length === 0
                ? <span style={{ fontSize: 12, color: 'var(--text-3)' }}>None selected.</span>
                : compared.map((r) => (
                  <RegionChip key={r.id} region={r} meta={r.distanceMiles != null ? `${r.distanceMiles} mi` : undefined}
                    onRemove={() => setCompared((prev) => prev.filter((x) => x.id !== r.id))} />
                ))}
            </div>
            <div style={{ maxWidth: 360 }}>
              <GeoPicker placeholder="Add another metro to compare…"
                onPick={(c) => {
                  if (homeRegions.find((r) => r.id === c.id)) return toast.error('That is a home market.');
                  if (compared.find((r) => r.id === c.id)) return;
                  if (compared.length >= maxRegions) return toast.error(`You can compare at most ${maxRegions} regions.`);
                  setCompared((prev) => [...prev, c]);
                }} />
            </div>
          </div>

          {suggestions.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Suggested (nearest metros within {radius} mi)</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {suggestions.map((s) => {
                  const on = compared.find((r) => r.id === s.id);
                  return (
                    <button key={s.id}
                      onClick={() => toggleCompared(s)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer',
                        borderRadius: 'var(--r-pill)', fontSize: 12, border: '1px solid var(--border)',
                        background: on ? 'var(--success-soft)' : 'var(--card)', color: on ? 'var(--success)' : 'var(--text-2)',
                      }}>
                      {on ? '✓ ' : '+ '}{s.displayName}
                      <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{s.distanceMiles} mi</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {units && pendingRegions > 0 && (
            <div style={{
              marginBottom: 16, padding: '10px 12px', borderRadius: 'var(--r-md)', fontSize: 12,
              background: (overRun || overDay) ? 'var(--danger-soft)' : 'var(--surface)',
              color: (overRun || overDay) ? 'var(--danger)' : 'var(--text-2)',
              border: '1px solid var(--border)',
            }}>
              Est. cost this run: <b>up to ~{estUnits.toLocaleString()} units</b> ({pendingRegions} regions × {perRegionLines} lines × {units.rate})
              {densityCfg && <> · includes competitor density ({densityCfg.terms} term × top {densityCfg.topN})</>}
              {' · '}per-run cap {units.perRunCap.toLocaleString()} · {units.dailyRemaining.toLocaleString()} left today
              {overRun && <div style={{ marginTop: 4 }}><b>Over the per-run cap</b> — remove regions or basket terms to proceed.</div>}
              {!overRun && overDay && <div style={{ marginTop: 4 }}><b>Not enough daily budget left</b> — wait for the 00:00 UTC reset or reduce the run.</div>}
              <div style={{ marginTop: 4, opacity: 0.8 }}>Cached regions cost 0 — the actual bill is usually lower.</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="ghost" onClick={() => setStep('basket')}>← Back</Button>
            <Button onClick={runCompare} loading={busy} disabled={!compared.length || overRun || overDay}>
              Fetch volume &amp; rank →
            </Button>
          </div>
        </div>
      )}

      {/* ── STEP 4: results — the Decision Board ── */}
      {step === 'results' && result && (
        <DecisionBoard
          result={result}
          scoredRows={scoredRows}
          weights={weights}
          onWeightsChange={setWeights}
          homeName={homeName}
          units={units}
          onExport={exportCsv}
          onSave={saveAnalysis}
          onBack={() => setStep('regions')}
        />
      )}

      <ModuleRuns toolId="market-potential" />

      <ScenarioDiff open={!!diff} onClose={() => setDiff(null)} left={diff?.left} right={diff?.right} />
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 };
