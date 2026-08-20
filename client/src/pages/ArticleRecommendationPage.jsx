import { useState, useRef } from 'react';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
import { notifyAgentRunStarted, notifyAgentRunFinished } from '../lib/agentRunSignal';
import ModuleRuns from '../components/ModuleRuns';

const STEPS = [
  { id: 'search',   label: 'Searching Google US',  icon: '🔍' },
  { id: 'scrape',   label: 'Scraping Pages',        icon: '📄' },
  { id: 'analysis', label: 'Analyzing Content',     icon: '🔬' },
  { id: 'brief',    label: 'Building Brief',         icon: '✍️' },
  { id: 'alignment', label: 'Alignment Check',       icon: '🎯' },
];

function StepBadge({ status, number }) {
  if (status === 'done') return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--success)', color: '#fff',
      fontSize: 12, fontWeight: 700, flexShrink: 0,
    }}>✓</span>
  );
  if (status === 'active') return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--primary)', flexShrink: 0,
    }}>
      <svg style={{ width: 14, height: 14, color: '#fff', animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
    </span>
  );
  return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--surface)', color: 'var(--text-3)',
      fontSize: 12, flexShrink: 0,
    }}>{number || '·'}</span>
  );
}

// Renders inline markdown (bold, plain)
function InlineText({ text }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**')
          ? <strong key={i} style={{ fontWeight: 600, color: 'var(--text)' }}>{part.slice(2, -2)}</strong>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

// Full markdown renderer with Visual Opportunity callout support
function BriefRenderer({ markdown }) {
  const lines = markdown.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (!t) {
      elements.push(<div key={i} style={{ height: 4 }} />);
      continue;
    }

    if (t.startsWith('# ')) {
      elements.push(
        <h1 key={i} style={{
          fontSize: '1.5rem', fontWeight: 700, color: 'var(--text)',
          marginTop: 8, marginBottom: 20, paddingBottom: 12,
          borderBottom: '2px solid var(--primary)',
        }}>
          {t.slice(2)}
        </h1>
      );
    } else if (t.startsWith('## ')) {
      elements.push(
        <h2 key={i} style={{
          fontSize: '1.125rem', fontWeight: 700, color: 'var(--text)',
          marginTop: 28, marginBottom: 8, paddingTop: 8,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            display: 'inline-block', width: 4, height: 20, borderRadius: 2,
            backgroundColor: 'var(--primary)', flexShrink: 0,
          }} />
          {t.slice(3)}
        </h2>
      );
    } else if (t.startsWith('### ')) {
      elements.push(
        <h3 key={i} style={{
          fontSize: '0.875rem', fontWeight: 700, color: 'var(--text)',
          marginTop: 16, marginBottom: 6, marginLeft: 12,
        }}>
          {t.slice(4)}
        </h3>
      );
    } else if (t.startsWith('#### ')) {
      elements.push(
        <h4 key={i} style={{
          fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-2)',
          marginTop: 12, marginBottom: 4, marginLeft: 20,
        }}>
          {t.slice(5)}
        </h4>
      );
    } else if (/^\*\*\[Visual Opportunity/i.test(t)) {
      // Amber callout box — kept as-is (amber is not in design tokens, intentional semantic color)
      const inner = t.replace(/^\*\*\[/, '').replace(/\]\*\*$/, '').replace(/^\*\*/, '').replace(/\*\*$/, '');
      const desc = inner.replace(/^Visual Opportunity:\s*/i, '');
      elements.push(
        <div key={i} style={{
          margin: '12px 0 12px 12px', display: 'flex', gap: 12,
          padding: '12px 16px', borderRadius: 8,
          border: '1px solid #FDE68A', backgroundColor: '#FFFBEB',
        }}>
          <span style={{ fontSize: '1rem', flexShrink: 0, marginTop: 2 }}>💡</span>
          <div>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#D97706' }}>
              Visual Opportunity
            </span>
            <p style={{ fontSize: '0.875rem', marginTop: 2, lineHeight: 1.6, color: '#92400E' }}>{desc}</p>
          </div>
        </div>
      );
    } else if (/^---+$/.test(t)) {
      elements.push(<hr key={i} style={{ margin: '20px 0', borderColor: 'var(--border)', borderTopWidth: 1, borderStyle: 'solid' }} />);
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      elements.push(
        <div key={i} style={{
          display: 'flex', gap: 8, fontSize: '0.875rem', color: 'var(--text)',
          margin: '2px 0', marginLeft: 16,
        }}>
          <span style={{
            flexShrink: 0, marginTop: 6, width: 6, height: 6,
            borderRadius: '50%', backgroundColor: 'var(--primary)',
          }} />
          <span><InlineText text={t.slice(2)} /></span>
        </div>
      );
    } else {
      elements.push(
        <p key={i} style={{
          fontSize: '0.875rem', color: 'var(--text)', margin: '4px 0',
          marginLeft: 4, lineHeight: 1.6,
        }}>
          <InlineText text={t} />
        </p>
      );
    }
  }

  return <div>{elements}</div>;
}

// Client-side .docx generator from markdown
async function downloadDocx(keyword, markdown) {
  const lines = markdown.split('\n');
  const children = [];

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    if (t.startsWith('# ')) {
      children.push(new Paragraph({ text: t.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (t.startsWith('## ')) {
      children.push(new Paragraph({ text: t.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (t.startsWith('### ')) {
      children.push(new Paragraph({ text: t.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (/^\*\*\[Visual Opportunity/i.test(t)) {
      const desc = t.replace(/^\*\*\[/, '').replace(/\]\*\*$/, '').replace(/^\*\*/, '').replace(/\*\*$/, '');
      children.push(new Paragraph({
        children: [new TextRun({ text: `💡 ${desc}`, bold: true, color: 'D97706', size: 20 })],
        shading: { fill: 'FFFBEB', type: 'clear', color: 'auto' },
        indent: { left: 400 },
      }));
    } else if (/^---+$/.test(t)) {
      children.push(new Paragraph({ text: '' }));
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      const text = t.slice(2).replace(/\*\*([^*]+)\*\*/g, '$1');
      children.push(new Paragraph({ text, bullet: { level: 0 } }));
    } else {
      const isBoldLine = t.startsWith('**') && t.endsWith('**');
      const text = t.replace(/\*\*([^*]+)\*\*/g, '$1');
      children.push(new Paragraph({ children: [new TextRun({ text, bold: isBoldLine, size: 20 })] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  const filename = `${keyword.replace(/[^a-zA-Z0-9]/g, '_')}_content_brief.docx`;
  saveAs(blob, filename);
}

export default function ArticleRecommendationPage() {
  const [keyword, setKeyword] = useState('');
  const [client, setClient] = useState('');
  const [feedbackKbIds, setFeedbackKbIds] = useState([]);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [steps, setSteps] = useState({});
  const [urls, setUrls] = useState([]);
  const [scrapeProgress, setScrapeProgress] = useState([]);
  const [warning, setWarning] = useState('');
  const [result, setResult] = useState(null);   // { brief, sourceUrls }
  const [error, setError] = useState('');
  const [showUrls, setShowUrls] = useState(false);
  const [copying, setCopying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const esRef = useRef(null);

  function reset() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setStarted(false);
    setRunning(false);
    setSteps({});
    setUrls([]);
    setScrapeProgress([]);
    setWarning('');
    setResult(null);
    setError('');
    setShowUrls(false);
  }

  async function startGeneration() {
    if (!keyword.trim() || running) return;
    reset();
    setStarted(true);
    setRunning(true);
    notifyAgentRunStarted('article-recommendation');

    try {
      const initRes = await fetch('/api/article-recommendation/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ keyword: keyword.trim(), client: client || undefined, feedbackKbIds: feedbackKbIds.length ? feedbackKbIds : undefined })
      });
      if (!initRes.ok) {
        const err = await initRes.json();
        throw new Error(err.error || 'Failed to start');
      }
      const { token } = await initRes.json();

      const es = new EventSource(`/api/article-recommendation/stream/${token}`);
      esRef.current = es;

      es.addEventListener('step', e => {
        const d = JSON.parse(e.data);
        setSteps(prev => ({ ...prev, [d.id]: { status: d.status, message: d.message } }));
      });

      es.addEventListener('urls', e => {
        setUrls(JSON.parse(e.data).urls);
      });

      es.addEventListener('scrape_progress', e => {
        const d = JSON.parse(e.data);
        setScrapeProgress(prev => {
          const next = [...prev];
          next[d.index] = { url: d.url, status: d.status, error: d.error };
          return next;
        });
      });

      es.addEventListener('warning', e => {
        setWarning(JSON.parse(e.data).message);
      });

      es.addEventListener('result', e => {
        const d = JSON.parse(e.data);
        setResult(d);
        notifyAgentRunFinished('article-recommendation', {
          keyword: keyword.trim(),
          client: client || '',
          brief: d.brief || '',
          sourceUrls: d.sourceUrls || [],
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

  async function copyBrief() {
    if (!result?.brief) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(result.brief);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = result.brief;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setTimeout(() => setCopying(false), 1500);
  }

  async function handleDownloadDocx() {
    if (!result?.brief) return;
    setDownloading(true);
    try {
      await downloadDocx(keyword, result.brief);
    } catch (err) {
      console.error('docx error', err);
    }
    setDownloading(false);
  }

  const canStart = keyword.trim() && !running;

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Input Card ───────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)', padding: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
      }}>
        <div style={{ maxWidth: 448 }}>
          <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            Primary Keyword
          </label>
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && canStart && startGeneration()}
            placeholder="e.g. dental implants"
            disabled={running}
            style={{
              width: '100%', padding: '10px 16px', borderRadius: 8,
              border: '1px solid var(--border)', fontSize: '0.875rem',
              color: 'var(--text)', background: running ? 'var(--surface)' : 'var(--card)',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={startGeneration}
            disabled={!canStart}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 24px', borderRadius: 8,
              fontSize: '0.875rem', fontWeight: 600, color: '#fff',
              background: 'var(--primary)', border: 'none', cursor: canStart ? 'pointer' : 'not-allowed',
              opacity: canStart ? 1 : 0.5, transition: 'opacity 0.15s',
            }}
          >
            {running ? (
              <>
                <svg style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                  <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Generating…
              </>
            ) : 'Generate Recommendations'}
          </button>
          {started && !running && (
            <button
              onClick={reset}
              style={{
                fontSize: '0.875rem', color: 'var(--text-2)', background: 'none',
                border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0,
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* ── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          padding: 16, background: '#FEF2F2', border: '1px solid #FECACA',
          borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <span style={{ color: '#EF4444', marginTop: 2, flexShrink: 0 }}>✕</span>
          <div style={{ flex: 1 }}>
            <p style={{ color: '#991B1B', fontSize: '0.875rem', fontWeight: 500, margin: 0 }}>{error}</p>
          </div>
          <button
            onClick={startGeneration}
            disabled={!keyword.trim()}
            style={{
              flexShrink: 0, fontSize: '0.75rem', fontWeight: 600,
              padding: '6px 12px', borderRadius: 8, color: '#fff',
              background: 'var(--primary)', border: 'none',
              cursor: keyword.trim() ? 'pointer' : 'not-allowed',
              opacity: keyword.trim() ? 1 : 0.5,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Warning ──────────────────────────────────────────────────── */}
      {warning && (
        <div style={{
          padding: 16, background: '#FFFBEB', border: '1px solid #FDE68A',
          borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <span style={{ color: '#D97706', marginTop: 2, flexShrink: 0 }}>⚠</span>
          <p style={{ fontSize: '0.875rem', color: '#92400E', margin: 0 }}>{warning}</p>
        </div>
      )}

      {/* ── Progress Steps ───────────────────────────────────────────── */}
      {started && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {STEPS.map((stepCfg, stepIdx) => {
            const s = steps[stepCfg.id] || {};
            const isActive = s.status === 'active';
            return (
              <div
                key={stepCfg.id}
                style={{
                  background: 'var(--card)',
                  border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--r-lg)', overflow: 'hidden',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.07)', transition: 'border-color 0.2s',
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '14px 20px',
                  background: isActive ? 'var(--primary-soft)' : 'var(--surface)',
                }}>
                  <StepBadge status={s.status} number={stepIdx + 1} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text)' }}>
                        {stepCfg.label}
                      </span>
                      {isActive && (
                        <span style={{
                          fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999,
                          fontWeight: 500, animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
                          background: 'var(--primary-soft)', color: 'var(--primary-text)',
                        }}>
                          In progress
                        </span>
                      )}
                      {s.status === 'done' && (
                        <span style={{
                          fontSize: '0.75rem', padding: '2px 8px', borderRadius: 999,
                          fontWeight: 500, background: 'var(--surface)', color: 'var(--text-2)',
                        }}>
                          Done
                        </span>
                      )}
                    </div>
                    {s.message && (
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginTop: 2, marginBottom: 0 }}>
                        {s.message}
                      </p>
                    )}
                  </div>
                </div>

                {/* Search — show URL list */}
                {stepCfg.id === 'search' && s.status === 'done' && urls.length > 0 && (
                  <div style={{
                    padding: '16px 20px',
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8,
                  }}>
                    {urls.map((u, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.75rem', color: 'var(--text-2)' }}>
                        <span style={{
                          width: 20, height: 20, borderRadius: '50%',
                          background: 'var(--primary)', color: '#fff',
                          fontSize: '0.75rem', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontWeight: 700, flexShrink: 0,
                        }}>
                          {idx + 1}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.displayUrl || (() => { try { return new URL(u.url).hostname; } catch { return u.url; } })()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Scrape — per-URL status */}
                {stepCfg.id === 'scrape' && (s.status === 'active' || s.status === 'done') && scrapeProgress.length > 0 && (
                  <div style={{
                    padding: '16px 20px',
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6,
                  }}>
                    {scrapeProgress.map((p, idx) => p ? (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.75rem' }}>
                        {p.status === 'done' ? (
                          <span style={{ color: 'var(--success)', fontWeight: 700, flexShrink: 0 }}>✓</span>
                        ) : p.status === 'error' ? (
                          <span style={{ color: '#F87171', flexShrink: 0 }}>✕</span>
                        ) : (
                          <svg style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--primary)', animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                            <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                          </svg>
                        )}
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: p.status === 'error' ? '#F87171' : 'var(--text-2)',
                        }}>
                          {(() => { try { return new URL(p.url).hostname; } catch { return p.url; } })()}
                        </span>
                      </div>
                    ) : null)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Result ───────────────────────────────────────────────────── */}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Action bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Content Brief</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={copyBrief}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: '0.875rem', fontWeight: 500, padding: '8px 16px',
                  borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--card)', color: 'var(--text)', cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                {copying ? (
                  <><span style={{ color: 'var(--success)' }}>✓</span> Copied!</>
                ) : (
                  <>
                    <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy Brief
                  </>
                )}
              </button>
              <button
                onClick={handleDownloadDocx}
                disabled={downloading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: '0.875rem', fontWeight: 600, padding: '8px 16px',
                  borderRadius: 8, border: 'none',
                  background: 'var(--primary)', color: '#fff',
                  cursor: downloading ? 'not-allowed' : 'pointer',
                  opacity: downloading ? 0.6 : 1, transition: 'opacity 0.15s',
                }}
              >
                {downloading ? (
                  <>
                    <svg style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                      <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Exporting…
                  </>
                ) : (
                  <>
                    <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    Download .docx
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Brief content */}
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)', padding: '28px 32px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
          }}>
            <BriefRenderer markdown={result.brief} />
          </div>

          {/* Reference URLs collapsible */}
          {result.sourceUrls?.length > 0 && (
            <div style={{
              background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-lg)', boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
              overflow: 'hidden',
            }}>
              <button
                onClick={() => setShowUrls(v => !v)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 20px', textAlign: 'left', background: 'none', border: 'none',
                  cursor: 'pointer', transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text)' }}>Reference URLs</span>
                  <span style={{
                    fontSize: '0.75rem', background: 'var(--surface)', color: 'var(--text-2)',
                    fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                  }}>
                    {result.sourceUrls.length}
                  </span>
                </div>
                <svg
                  style={{
                    width: 16, height: 16, color: 'var(--text-2)',
                    transition: 'transform 0.2s', transform: showUrls ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
              {showUrls && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.sourceUrls.map((u, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <span style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: 'var(--primary)', color: '#fff',
                        fontSize: '0.75rem', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontWeight: 700, flexShrink: 0, marginTop: 2,
                      }}>
                        {idx + 1}
                      </span>
                      <div>
                        <p style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text)', margin: '0 0 2px 0' }}>
                          {u.title}
                        </p>
                        <a
                          href={u.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: '0.75rem', color: 'var(--primary)', wordBreak: 'break-all' }}
                        >
                          {u.url}
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Keyframe injection ───────────────────────────────────────── */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
      <ModuleRuns toolId="article-recommendation" />
    </main>
  );
}
