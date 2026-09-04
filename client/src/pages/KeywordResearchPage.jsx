import { useState, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { refreshSemrushBalance } from '../lib/semrushBalanceStore';
import { notifyAgentRunStarted, notifyAgentRunFinished } from '../lib/agentRunSignal';
import ModuleRuns from '../components/ModuleRuns';

const STEP_CONFIG = [
  { id: 'variants',    label: 'Query Variants',   desc: 'Expanding across intent variants' },
  { id: 'search',      label: 'SERP Analysis',    desc: 'Fetching top pages for all queries' },
  { id: 'url_scoring', label: 'URL Scoring',      desc: 'Selecting best competitor pages' },
  { id: 'semrush',     label: 'SEMrush Keywords', desc: 'Pulling competitor rankings' },
  { id: 'analysis',    label: 'AI Shortlisting',  desc: 'Filtering & ranking keywords' },
  { id: 'validation',  label: 'Quality Check',    desc: 'Verifying primary & secondary keyword match quality' },
];

function StepBadge({ status, index }) {
  const baseStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: '50%',
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
  };

  if (status === 'done') return (
    <span style={{ ...baseStyle, background: 'var(--success)', color: '#fff' }}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  );

  if (status === 'active') return (
    <span style={{ ...baseStyle, background: 'var(--primary)', color: '#fff' }}>
      <svg
        style={{ animation: 'spin 1s linear infinite', width: 14, height: 14 }}
        viewBox="0 0 24 24" fill="none"
      >
        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
    </span>
  );

  return (
    <span style={{ ...baseStyle, background: 'var(--surface)', color: 'var(--text-3)', border: '1px solid var(--border)' }}>
      {index + 1}
    </span>
  );
}

function DifficultyBar({ value }) {
  const pct = Math.min(100, Math.max(0, value || 0));
  const color = pct >= 70 ? 'var(--danger)' : pct >= 40 ? 'var(--warning)' : 'var(--success)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 99, transition: 'width 0.3s', width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-2)', width: 24, textAlign: 'right' }}>{value || '—'}</span>
    </div>
  );
}

const PAGE_TYPE_STYLES = {
  page:      { bg: 'var(--success-soft)', text: 'var(--success)' },
  article:   { bg: 'var(--info-soft)',    text: 'var(--info)' },
  directory: { bg: 'var(--surface)',      text: 'var(--text-3)' },
};

const cardShadow = '0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04)';

// Same prefill-not-lock convention as ArticleRecommendationPage/
// ArticleEnhancementPage: read once via useMemo, land as ordinary initial
// state so it stays editable. Lets Content Architect hand off a hub/spoke
// topic here as the research step ahead of Article Recommendation.
function usePrefill() {
  return useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return { keyword: q.get('keyword') || '', client: q.get('client') || '' };
  }, []);
}

export default function KeywordResearchPage() {
  const navigate = useNavigate();
  const prefill = usePrefill();
  const [keyword, setKeyword] = useState(prefill.keyword);
  const [intent, setIntent] = useState('commercial');
  const [client, setClient] = useState(prefill.client);
  const [feedbackKbIds, setFeedbackKbIds] = useState([]);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [steps, setSteps] = useState({});
  const [queries, setQueries] = useState([]);
  const [urls, setUrls] = useState([]);
  const [totalQueries, setTotalQueries] = useState(0);
  const [urlData, setUrlData] = useState({});
  const [result, setResult] = useState(null);
  const [primaryList, setPrimaryList] = useState([]);
  const [secondaryList, setSecondaryList] = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [allKeywords, setAllKeywords] = useState([]);
  const [showAllKeywords, setShowAllKeywords] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const esRef = useRef(null);

  function reset() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setStarted(false);
    setRunning(false);
    setSteps({});
    setQueries([]);
    setUrls([]);
    setTotalQueries(0);
    setUrlData({});
    setResult(null);
    setPrimaryList([]);
    setSecondaryList([]);
    setEditMode(false);
    setAllKeywords([]);
    setShowAllKeywords(false);
    setError('');
  }

  async function startResearch() {
    if (!keyword.trim() || running) return;
    reset();
    setStarted(true);
    setRunning(true);
    notifyAgentRunStarted('keyword-research');

    try {
      const initRes = await fetch('/api/keyword-research/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          keyword: keyword.trim(),
          intent,
          client: client || undefined,
          feedbackKbIds: feedbackKbIds.length ? feedbackKbIds : undefined,
        })
      });
      if (!initRes.ok) {
        const err = await initRes.json();
        throw new Error(err.error || 'Failed to start');
      }
      const { token } = await initRes.json();
      refreshSemrushBalance();

      const es = new EventSource(`/api/keyword-research/stream/${token}`);
      esRef.current = es;

      es.addEventListener('step', e => {
        const d = JSON.parse(e.data);
        setSteps(prev => ({ ...prev, [d.id]: { status: d.status, message: d.message } }));
      });

      es.addEventListener('variants', e => {
        setQueries(JSON.parse(e.data).queries || []);
      });

      es.addEventListener('urls', e => {
        const d = JSON.parse(e.data);
        setUrls(d.urls || []);
        setTotalQueries(d.totalQueries || 0);
      });

      es.addEventListener('url_status', e => {
        const d = JSON.parse(e.data);
        setUrlData(prev => ({ ...prev, [d.url]: { status: 'loading', keywords: [], title: d.title } }));
      });

      es.addEventListener('url_keywords', e => {
        const d = JSON.parse(e.data);
        setUrlData(prev => ({
          ...prev,
          [d.url]: { status: d.status, keywords: d.keywords || [], title: d.title, error: d.error }
        }));
      });

      es.addEventListener('allKeywords', e => {
        setAllKeywords(JSON.parse(e.data).keywords || []);
      });

      es.addEventListener('result', e => {
        const d = JSON.parse(e.data);
        setResult(d);
        setPrimaryList(d.primary || []);
        setSecondaryList(d.secondary || []);
        notifyAgentRunFinished('keyword-research', {
          keyword: keyword.trim(),
          intent,
          client: client || '',
          primary: d.primary || [],
          secondary: d.secondary || [],
          warning: d.warning || '',
        });
      });

      es.addEventListener('fail', e => {
        setError(JSON.parse(e.data).message);
      });

      es.addEventListener('done', () => {
        es.close();
        esRef.current = null;
        setRunning(false);
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setRunning(false);
        setError(prev => prev || 'Connection lost. Please try again.');
      };

    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  }

  const canStart = keyword.trim() && !running;

  function keyOf(kw) {
    return (kw.keyword || '').trim().toLowerCase();
  }

  function removeFromPrimary(idx) {
    setPrimaryList(prev => prev.filter((_, i) => i !== idx));
  }

  function removeFromSecondary(idx) {
    setSecondaryList(prev => prev.filter((_, i) => i !== idx));
  }

  function addAsPrimary(kw) {
    setPrimaryList(prev => (prev.length >= 2 ? prev : [...prev, kw]));
  }

  function addAsSecondary(kw) {
    setSecondaryList(prev => (prev.length >= 10 ? prev : [...prev, kw]));
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Copies the current (possibly edited) Primary + Secondary lists as a table.
  // Writes both a tab-separated plain-text version (pastes as columns in
  // Excel/Sheets) and an HTML <table> (pastes as a real bordered table in
  // Word/Docs/email) so the table renders correctly wherever it lands.
  async function copyKeywordsTable() {
    const rows = [
      ...primaryList.map(kw => ({ type: 'Primary', keyword: kw.keyword, volume: kw.volume || 0 })),
      ...secondaryList.map(kw => ({ type: 'Secondary', keyword: kw.keyword, volume: kw.volume || 0 })),
    ];
    if (!rows.length) return;

    const header = ['Type', 'Keyword', 'Volume'];
    const tsv = [header.join('\t'), ...rows.map(r => [r.type, r.keyword, r.volume].join('\t'))].join('\n');
    const html = `<table><thead><tr>${header.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
      rows.map(r => `<tr><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.keyword)}</td><td>${r.volume}</td></tr>`).join('')
    }</tbody></table>`;

    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(tsv);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(tsv);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* clipboard unavailable — silently no-op */ }
    }
  }

  // Source pool for the "All source keywords" panel: the full candidate list,
  // plus a safety net for any selected keyword the LLM phrased slightly
  // differently from its candidate-list entry. Selected keywords (primary or
  // secondary) are excluded here — removing one makes it reappear below.
  const selectedKeys = new Set([...primaryList, ...secondaryList].map(keyOf));
  const sourcePoolMap = new Map();
  for (const k of allKeywords) sourcePoolMap.set(keyOf(k), k);
  for (const k of [...primaryList, ...secondaryList]) {
    if (!sourcePoolMap.has(keyOf(k))) sourcePoolMap.set(keyOf(k), k);
  }
  const availableKeywords = [...sourcePoolMap.values()].filter(k => !selectedKeys.has(keyOf(k)));

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Input Card ───────────────────────────────────────────────── */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 24, boxShadow: cardShadow }}>
        <div style={{ maxWidth: 448 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            Seed Keyword
          </label>
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && canStart && startResearch()}
            placeholder="e.g. dental implants"
            disabled={running}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              fontSize: 14,
              color: 'var(--text)',
              background: running ? 'var(--surface)' : 'var(--card)',
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
            onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
          />
        </div>

        {/* Intent toggle */}
        <div style={{ marginTop: 16 }}>
          <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
            Page Intent
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            {[
              { value: 'commercial',   label: 'Commercial / Transactional', desc: 'Service pages, pricing, booking' },
              { value: 'informational', label: 'Informational / Educational', desc: 'Guides, FAQs, how-to content' },
            ].map(opt => {
              const isSelected = intent === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={running}
                  onClick={() => setIntent(opt.value)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    padding: '12px 16px',
                    borderRadius: 8,
                    border: `2px solid ${isSelected ? 'var(--nav-bg-top)' : 'var(--border)'}`,
                    background: isSelected ? 'var(--nav-bg-top)' : 'var(--card)',
                    cursor: running ? 'not-allowed' : 'pointer',
                    opacity: running ? 0.5 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: isSelected ? '#fff' : 'var(--text)' }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2, color: isSelected ? 'rgba(255,255,255,0.65)' : 'var(--text-2)' }}>
                    {opt.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={startResearch}
            disabled={!canStart}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 24px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--nav-bg-top)',
              border: 'none',
              cursor: canStart ? 'pointer' : 'not-allowed',
              opacity: canStart ? 1 : 0.5,
              transition: 'opacity 0.15s',
            }}
          >
            {running ? (
              <>
                <svg style={{ animation: 'spin 1s linear infinite', width: 16, height: 16 }} viewBox="0 0 24 24" fill="none">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Running…
              </>
            ) : 'Start Research'}
          </button>
          {started && !running && (
            <button
              onClick={reset}
              style={{ fontSize: 14, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          padding: 16,
          background: 'var(--danger-soft, #FEF2F2)',
          border: '1px solid var(--danger)',
          borderRadius: 'var(--r-lg)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}>
          <span style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }}>✕</span>
          <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* ── Progress Journey ─────────────────────────────────────────── */}
      {started && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {STEP_CONFIG.map((stepCfg, stepIndex) => {
            const s = steps[stepCfg.id] || {};
            if (!s.status) return null;

            const isActive = s.status === 'active';

            return (
              <div
                key={stepCfg.id}
                style={{
                  background: 'var(--card)',
                  border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--r-lg)',
                  overflow: 'hidden',
                  transition: 'border-color 0.2s',
                  boxShadow: cardShadow,
                }}
              >
                {/* Step header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 20px',
                  background: isActive ? 'var(--primary-soft)' : 'var(--surface)',
                }}>
                  <StepBadge status={s.status} index={stepIndex} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{stepCfg.label}</span>
                      {isActive && (
                        <span style={{
                          fontSize: 12,
                          padding: '2px 8px',
                          borderRadius: 99,
                          fontWeight: 500,
                          background: 'var(--primary-soft)',
                          color: 'var(--primary)',
                          animation: 'pulse 2s infinite',
                        }}>
                          In progress
                        </span>
                      )}
                      {s.status === 'done' && (
                        <span style={{
                          fontSize: 12,
                          background: 'var(--surface)',
                          color: 'var(--text-3)',
                          padding: '2px 8px',
                          borderRadius: 99,
                          fontWeight: 500,
                        }}>
                          Done
                        </span>
                      )}
                    </div>
                    {s.message && (
                      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '2px 0 0' }}>{s.message}</p>
                    )}
                  </div>
                </div>

                {/* Variants step — show query chips */}
                {stepCfg.id === 'variants' && s.status === 'done' && queries.length > 0 && (
                  <div style={{
                    padding: '14px 20px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    borderTop: '1px solid var(--border)',
                  }}>
                    {queries.map((q, i) => (
                      <span
                        key={i}
                        style={i === 0
                          ? { fontSize: 12, padding: '6px 12px', borderRadius: 99, fontWeight: 500, background: 'var(--nav-bg-top)', color: '#fff' }
                          : { fontSize: 12, padding: '6px 12px', borderRadius: 99, fontWeight: 500, background: 'var(--surface)', color: 'var(--text)' }
                        }
                      >
                        {i === 0 ? '★ ' : ''}{q}
                      </span>
                    ))}
                  </div>
                )}

                {/* URL scoring step — show scored URL cards */}
                {stepCfg.id === 'url_scoring' && s.status === 'done' && urls.length > 0 && (
                  <div style={{
                    padding: '16px 20px',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                    gap: 12,
                    borderTop: '1px solid var(--border)',
                  }}>
                    {urls.map((u, idx) => {
                      const ptStyle = PAGE_TYPE_STYLES[u.pageType] || PAGE_TYPE_STYLES.page;
                      return (
                        <div key={idx} style={{
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: 12,
                          background: 'var(--surface)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              background: 'var(--primary)',
                              color: '#fff',
                              fontSize: 11,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                              flexShrink: 0,
                            }}>
                              {idx + 1}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                              {(() => { try { return new URL(u.url).hostname; } catch { return u.url; } })()}
                            </span>
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--text-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4, margin: '0 0 8px' }}>
                            {u.title}
                          </p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: ptStyle.bg, color: ptStyle.text }}>
                              {u.pageType}
                            </span>
                            {u.queryCount > 1 && (
                              <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                                {u.queryCount}/{totalQueries || queries.length} queries
                              </span>
                            )}
                            <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: 'var(--surface)', color: 'var(--text-2)', marginLeft: 'auto' }}>
                              {u.rubricScore?.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* SEMrush step — keywords per URL */}
                {stepCfg.id === 'semrush' && (s.status === 'active' || s.status === 'done') && urls.length > 0 && (
                  <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, borderTop: '1px solid var(--border)' }}>
                    {urls.map((u, idx) => {
                      const ud = urlData[u.url];
                      return (
                        <div key={idx}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            {ud?.status === 'done' ? (
                              <span style={{ color: 'var(--success)', fontSize: 12, fontWeight: 700 }}>✓</span>
                            ) : ud?.status === 'loading' ? (
                              <svg style={{ animation: 'spin 1s linear infinite', width: 12, height: 12, color: 'var(--primary)' }} viewBox="0 0 24 24" fill="none">
                                <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                              </svg>
                            ) : ud?.status === 'error' ? (
                              <span style={{ color: 'var(--danger)', fontSize: 12 }}>✕</span>
                            ) : (
                              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>·</span>
                            )}
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                              {(() => { try { const p = new URL(u.url); return p.hostname + (p.pathname !== '/' ? p.pathname : ''); } catch { return u.url; } })()}
                            </span>
                            {ud?.keywords?.length > 0 && (
                              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>
                                {ud.keywords.length} keyword{ud.keywords.length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>

                          {ud?.status === 'error' && (
                            <p style={{ fontSize: 12, color: 'var(--danger)', marginLeft: 20, margin: 0 }}>{ud.error}</p>
                          )}

                          {ud?.keywords?.length > 0 && (
                            <div style={{ marginLeft: 20, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {ud.keywords.slice(0, 10).map((kw, ki) => (
                                <span key={ki} style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  fontSize: 12,
                                  padding: '2px 8px',
                                  borderRadius: 99,
                                  background: 'var(--surface)',
                                  color: 'var(--text)',
                                }}>
                                  {kw.keyword}
                                  {kw.volume > 0 && (
                                    <span style={{ color: 'var(--text-3)' }}>
                                      {(kw.volume / 1000).toFixed(kw.volume >= 1000 ? 1 : 0)}{kw.volume >= 1000 ? 'k' : ''}
                                    </span>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}

                          {ud?.status === 'loading' && (
                            <div style={{ marginLeft: 20, display: 'flex', gap: 6 }}>
                              {[...Array(5)].map((_, i) => (
                                <div key={i} style={{
                                  height: 20,
                                  borderRadius: 99,
                                  background: 'var(--surface)',
                                  width: 50 + i * 15,
                                  animation: 'pulse 1.5s infinite',
                                }} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Analysis step — in progress spinner */}
                {stepCfg.id === 'analysis' && s.status === 'active' && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: 'var(--text-2)' }}>
                      <svg style={{ animation: 'spin 1s linear infinite', width: 16, height: 16, color: 'var(--primary)' }} viewBox="0 0 24 24" fill="none">
                        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                      Deduplicating keywords and running GPT-4o analysis…
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────── */}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Recommend Article — the step AFTER keyword research, using the
              keyword research actually settled on (the chosen Primary), not
              whatever seed keyword or AI-suggested topic started this run. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => navigate(`/article-recommendation?keyword=${encodeURIComponent(primaryList[0]?.keyword || keyword)}${client ? `&client=${encodeURIComponent(client)}` : ''}`)}
              disabled={!primaryList.length}
              title={primaryList.length ? `Write a content brief for "${primaryList[0].keyword}"` : 'Pick a Primary keyword below first'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600,
                padding: '8px 14px', borderRadius: 8, border: '1px solid var(--primary)',
                background: primaryList.length ? 'var(--primary)' : 'var(--surface)',
                color: primaryList.length ? '#fff' : 'var(--text-3)',
                cursor: primaryList.length ? 'pointer' : 'not-allowed',
                opacity: primaryList.length ? 1 : 0.6,
              }}
            >
              Recommend Article{primaryList.length ? ` for "${primaryList[0].keyword}"` : ''}
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={copyKeywordsTable}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                padding: '8px 14px',
                borderRadius: 8,
                border: `1px solid ${copied ? 'var(--success)' : 'var(--border)'}`,
                background: copied ? 'var(--success-soft)' : 'var(--card)',
                color: copied ? 'var(--success)' : 'var(--text)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {copied ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                  </svg>
                  Copy as Table
                </>
              )}
            </button>
            <button
              onClick={() => setEditMode(v => {
                const next = !v;
                if (next) setShowAllKeywords(true);
                return next;
              })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                padding: '8px 14px',
                borderRadius: 8,
                border: `1px solid ${editMode ? 'var(--primary)' : 'var(--border)'}`,
                background: editMode ? 'var(--primary)' : 'var(--card)',
                color: editMode ? '#fff' : 'var(--text)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {editMode ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  Done Editing
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                  </svg>
                  Edit Keywords
                </>
              )}
            </button>
            </div>
          </div>

          {/* Low-match warning */}
          {result.warning && (
            <div style={{
              padding: 16,
              background: 'var(--warning-soft, #FFFBEB)',
              border: '1px solid var(--warning)',
              borderRadius: 'var(--r-lg)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}>
              <span style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }}>⚠</span>
              <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--warning)', margin: 0 }}>{result.warning}</p>
            </div>
          )}

          {/* Primary Keywords */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Primary Keywords</h2>
              <span style={{
                fontSize: 12,
                background: primaryList.length === 2 ? 'var(--success-soft)' : 'var(--danger-soft, #FEF2F2)',
                color: primaryList.length === 2 ? 'var(--success)' : 'var(--danger)',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 99,
              }}>
                {primaryList.length} / 2 selected
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              {primaryList.map((kw, i) => (
                <div
                  key={i}
                  style={{
                    background: 'var(--card)',
                    borderRadius: 'var(--r-lg)',
                    padding: 20,
                    border: '1px solid var(--border)',
                    borderLeft: '4px solid var(--primary)',
                    boxShadow: cardShadow,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                    <h3 style={{ fontWeight: 700, color: 'var(--text)', fontSize: 15, lineHeight: 1.3, margin: 0 }}>{kw.keyword}</h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <span style={{
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '2px 10px',
                        borderRadius: 4,
                        background: 'var(--primary-soft)',
                        color: 'var(--primary)',
                      }}>
                        PRIMARY
                      </span>
                      {editMode && (
                        <button
                          onClick={() => removeFromPrimary(i)}
                          title="Remove from Primary"
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 20, height: 20, borderRadius: '50%', border: 'none',
                            background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)',
                            cursor: 'pointer', fontSize: 13, fontWeight: 700, lineHeight: 1, padding: 0,
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>Search Volume</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
                      {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}
                    </div>
                  </div>
                  {kw.reason && (
                    <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 12, margin: 0 }}>
                      {kw.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Secondary Keywords */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Secondary Keywords</h2>
              <span style={{
                fontSize: 12,
                background: secondaryList.length === 10 ? 'var(--success-soft)' : 'var(--danger-soft, #FEF2F2)',
                color: secondaryList.length === 10 ? 'var(--success)' : 'var(--danger)',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 99,
              }}>
                {secondaryList.length} / 10 selected
              </span>
            </div>
            <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', boxShadow: cardShadow, overflow: 'hidden' }}>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--nav-bg-top)' }}>
                    <th style={{ textAlign: 'left', color: '#fff', fontWeight: 600, padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>#</th>
                    <th style={{ textAlign: 'left', color: '#fff', fontWeight: 600, padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Keyword</th>
                    <th style={{ textAlign: 'left', color: '#fff', fontWeight: 600, padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Volume</th>
                    {editMode && <th style={{ padding: '12px 16px', width: 48 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {secondaryList.map((kw, i) => (
                    <tr
                      key={i}
                      style={{ borderTop: '1px solid var(--border)', transition: 'background 0.1s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ padding: '12px 16px', color: 'var(--text-3)', fontSize: 12 }}>{i + 1}</td>
                      <td style={{ padding: '12px 16px', fontWeight: 500, color: 'var(--text)' }}>{kw.keyword}</td>
                      <td style={{ padding: '12px 16px', color: 'var(--text-2)' }}>
                        {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}
                      </td>
                      {editMode && (
                        <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                          <button
                            onClick={() => removeFromSecondary(i)}
                            title="Remove from Secondary"
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              width: 20, height: 20, borderRadius: '50%', border: 'none',
                              background: 'var(--danger-soft, #FEF2F2)', color: 'var(--danger)',
                              cursor: 'pointer', fontSize: 13, fontWeight: 700, lineHeight: 1, padding: 0,
                            }}
                          >
                            ×
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* All source keywords toggle */}
          {allKeywords.length > 0 && (
            <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', boxShadow: cardShadow }}>
              <button
                onClick={() => setShowAllKeywords(v => !v)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '14px 20px',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  borderRadius: 'var(--r-lg)',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>All source keywords</span>
                  <span style={{ fontSize: 12, background: 'var(--surface)', color: 'var(--text-2)', fontWeight: 600, padding: '2px 8px', borderRadius: 99 }}>
                    {availableKeywords.length} available
                  </span>
                </div>
                <svg
                  style={{ width: 16, height: 16, color: 'var(--text-2)', transform: showAllKeywords ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {showAllKeywords && (
                <div style={{ borderTop: '1px solid var(--border)', borderRadius: '0 0 var(--r-lg) var(--r-lg)', overflow: 'hidden' }}>
                  {availableKeywords.length === 0 && (
                    <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-2)' }}>
                      All candidate keywords have been selected as Primary or Secondary.
                    </div>
                  )}
                  {[
                    { label: 'Core',      desc: 'Appears across 3+ competitor pages', color: 'var(--primary)',  headerBg: 'var(--primary-soft)',  filter: k => (k.urlFrequency || 0) >= 3 },
                    { label: 'Relevant',  desc: 'Appears across 2 competitor pages',  color: 'var(--info)',     headerBg: 'var(--info-soft)',     filter: k => (k.urlFrequency || 0) === 2 },
                    { label: 'Discovery', desc: 'Unique to a single competitor page', color: 'var(--text-3)',   headerBg: 'var(--surface)',       filter: k => (k.urlFrequency || 0) <= 1 },
                  ].map(tier => {
                    const tierKws = availableKeywords
                      .filter(tier.filter)
                      .sort((a, b) => (b.volume || 0) - (a.volume || 0));
                    if (tierKws.length === 0) return null;
                    return (
                      <div key={tier.label} style={{ borderTop: '1px solid var(--border)' }}>
                        <div style={{
                          padding: '10px 20px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          background: tier.headerBg,
                        }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: tier.color }}>{tier.label}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{tier.desc}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: tier.color }}>{tierKws.length}</span>
                        </div>
                        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                          <tbody>
                            {tierKws.map((kw, i) => (
                              <tr
                                key={i}
                                style={{ borderTop: '1px solid var(--border)', transition: 'background 0.1s' }}
                                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                              >
                                <td style={{ padding: '10px 20px', color: 'var(--text)', fontWeight: 500, fontSize: 12 }}>{kw.keyword}</td>
                                <td style={{ padding: '10px 20px', color: 'var(--text-2)', fontSize: 12, textAlign: 'right', width: 96 }}>
                                  {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}
                                </td>
                                {editMode && (
                                  <td style={{ padding: '10px 20px', textAlign: 'right', width: 160 }}>
                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                      <button
                                        onClick={() => addAsPrimary(kw)}
                                        disabled={primaryList.length >= 2}
                                        title={primaryList.length >= 2 ? 'Primary is full (2/2) — remove one first' : 'Add as Primary'}
                                        style={{
                                          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none',
                                          background: primaryList.length >= 2 ? 'var(--surface)' : 'var(--primary-soft)',
                                          color: primaryList.length >= 2 ? 'var(--text-3)' : 'var(--primary)',
                                          cursor: primaryList.length >= 2 ? 'not-allowed' : 'pointer',
                                        }}
                                      >
                                        + Primary
                                      </button>
                                      <button
                                        onClick={() => addAsSecondary(kw)}
                                        disabled={secondaryList.length >= 10}
                                        title={secondaryList.length >= 10 ? 'Secondary is full (10/10) — remove one first' : 'Add as Secondary'}
                                        style={{
                                          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: 'none',
                                          background: secondaryList.length >= 10 ? 'var(--surface)' : 'var(--info-soft)',
                                          color: secondaryList.length >= 10 ? 'var(--text-3)' : 'var(--info)',
                                          cursor: secondaryList.length >= 10 ? 'not-allowed' : 'pointer',
                                        }}
                                      >
                                        + Secondary
                                      </button>
                                    </div>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.5; }
        }
      `}</style>
      <ModuleRuns toolId="keyword-research" />
    </main>
  );
}
