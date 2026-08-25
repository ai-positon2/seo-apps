import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { LLM_MODEL_OPTIONS, DEFAULT_LLM_MODEL } from '../llmModels';
import { EMBED_MODE } from '../components/MacWindow';
import { notifyAgentRunStarted, notifyAgentRunFinished } from '../lib/agentRunSignal';
import ModuleRuns from '../components/ModuleRuns';

const MODELS = [
  'gpt-4o-mini',
  'gpt-5.4-mini',
  'gpt-4o-mini-search-preview',
  'gpt-4.1-mini',
];

const STEPS = [
  { id: 'crawl',      label: 'Crawl Article' },
  { id: 'theme',      label: 'Theme & Query' },
  { id: 'llm_fanout', label: `Model Queries (${MODELS.length} calls)` },
  { id: 'synthesis',  label: 'Concept Synthesis' },
  { id: 'serp',       label: 'SERP Competitor Research' },
  { id: 'kb',         label: 'Load KB' },
  { id: 'recommend',  label: 'Generate Recommendations' },
  { id: 'enhance',    label: 'Enhance Article' },
];

function PageHeader({ navigate }) {
  return (
    <header style={{ background: 'var(--card)', borderBottom: '1px solid var(--border)', height: '56px', display: 'flex', alignItems: 'center', padding: '0 24px' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => navigate('/')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-2)', fontSize: '14px', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
          >
            <svg style={{ width: '16px', height: '16px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            All tools
          </button>
          <span style={{ color: 'var(--border)' }}>/</span>
          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Enhance Existing Article</span>
        </div>
      </div>
    </header>
  );
}

function StepIndicator({ stepStates }) {
  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px' }}>Pipeline Progress</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {STEPS.map(step => {
          const state = stepStates[step.id];
          const isDone = state?.status === 'done';
          const isActive = state?.status === 'active';
          const isError = state?.status === 'error';
          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '2px 0' }}>
              <div style={{
                width: '16px', height: '16px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '2px',
                backgroundColor: isDone ? 'var(--success)' : isActive ? 'var(--primary)' : isError ? 'var(--danger)' : 'var(--surface)',
              }}>
                {isDone ? (
                  <svg style={{ width: '10px', height: '10px', color: '#fff' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : isActive ? (
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#fff', animation: 'pulse 1.5s ease-in-out infinite' }} />
                ) : isError ? (
                  <svg style={{ width: '10px', height: '10px', color: '#fff' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : null}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 500, color: isDone ? 'var(--success)' : isActive ? 'var(--primary)' : isError ? 'var(--danger)' : 'var(--text-3)' }}>
                  {step.label}
                </span>
                {state?.message && (
                  <p style={{ fontSize: '12px', color: isError ? 'var(--danger)' : 'var(--text-2)', marginTop: '2px', wordBreak: 'break-word', whiteSpace: 'normal' }}>
                    {state.message}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LLMResultPanel({ llmResults }) {
  const [expanded, setExpanded] = useState(null);

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
      {MODELS.map((model, mi) => {
        const result = llmResults.find(r => r.model === model || r.modelIndex === mi);
        const isOpen = expanded === mi;
        return (
          <div key={mi} style={{ borderBottom: mi < MODELS.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <button
              onClick={() => result?.text ? setExpanded(isOpen ? null : mi) : undefined}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', textAlign: 'left', background: 'none', border: 'none', cursor: result?.text ? 'pointer' : 'default', transition: 'background 0.15s' }}
              onMouseEnter={e => { if (result?.text) e.currentTarget.style.background = 'var(--surface)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <span style={{ fontSize: '13px', fontFamily: 'monospace', color: 'var(--text)' }}>{model}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {!result && <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>pending</span>}
                {result && (
                  result.success
                    ? <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 7px', borderRadius: '4px', background: 'var(--success-soft)', color: 'var(--success)' }}>Done</span>
                    : <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 7px', borderRadius: '4px', background: 'var(--danger-soft)', color: 'var(--danger)' }}>Failed</span>
                )}
                {result?.text && (
                  <svg style={{ width: '14px', height: '14px', color: 'var(--text-2)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                )}
              </div>
            </button>
            {isOpen && result?.text && (
              <div style={{ padding: '12px 16px', background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
                <pre style={{ fontSize: '12px', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: 'sans-serif', margin: 0 }}>{result.text}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Shared markdown rendering (Fix 5) ──────────────────────────────────────────
// One renderer for both the Recommendations and Enhanced Article tabs. Handles
// headings, **bold**, ---, ordered/unordered lists, blockquotes, pipe tables,
// and [NEW]…[/NEW] highlight markers.
function parseInline(str) {
  const parts = str.split(/(\[NEW\][\s\S]*?\[\/NEW\]|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('[NEW]') && part.endsWith('[/NEW]')) {
      return (
        <mark key={i} style={{ backgroundColor: 'var(--success-soft)', borderRadius: '2px', padding: '0 2px', color: 'var(--success)' }}>
          {part.slice(5, -6)}
        </mark>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
function parseTableLine(raw) {
  const stripped = raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  return stripped.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}
function isTableRow(raw) {
  const s = raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  return s.startsWith('|') && s.endsWith('|');
}
function isSeparatorRow(raw) {
  return /^\|?[\s\-|:]+\|?$/.test(raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim());
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { elements.push(<div key={i} style={{ height: '0.6rem' }} />); continue; }

    // Markdown table — collect all consecutive table rows
    if (isTableRow(trimmed)) {
      const tableLines = [];
      while (i < lines.length && (isTableRow(lines[i].trim()) || isSeparatorRow(lines[i].trim()))) {
        tableLines.push(lines[i].trim());
        i++;
      }
      i--; // outer loop will increment
      const nonSep = tableLines.filter(l => !isSeparatorRow(l));
      const isNew = tableLines.some(l => l.startsWith('[NEW]'));
      const headerCells = parseTableLine(nonSep[0] || '');
      const bodyRows = nonSep.slice(1);
      elements.push(
        <div key={i} style={{ overflowX: 'auto', margin: '12px 0', ...(isNew ? { backgroundColor: 'var(--success-soft)', borderRadius: '4px', padding: '4px' } : {}) }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', fontFamily: 'inherit' }}>
            <thead>
              <tr>
                {headerCells.map((cell, ci) => (
                  <th key={ci} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {parseInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid var(--border)', background: ri % 2 === 1 ? 'var(--surface)' : 'transparent' }}>
                  {parseTableLine(row).map((cell, ci) => (
                    <td key={ci} style={{ padding: '7px 12px', color: 'var(--text)', verticalAlign: 'top' }}>
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const isNewLine = trimmed.startsWith('[NEW]') && trimmed.endsWith('[/NEW]');
    const content = isNewLine ? trimmed.slice(5, -6).trim() : trimmed;
    const wrapStyle = isNewLine ? { backgroundColor: 'var(--success-soft)', borderRadius: '3px', display: 'block', padding: '0 4px' } : {};

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(content)) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />);
      continue;
    }

    // Ordered list — group consecutive numbered items into a single <ol>
    if (/^\d+[.)]\s+/.test(content)) {
      const items = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        const inner = (lt.startsWith('[NEW]') && lt.endsWith('[/NEW]')) ? lt.slice(5, -6).trim() : lt;
        if (!/^\d+[.)]\s+/.test(inner)) break;
        items.push(inner.replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      i--;
      elements.push(
        <ol key={i} style={{ paddingLeft: '1.4rem', margin: '8px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {items.map((li, idx) => (
            <li key={idx} style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6 }}>{parseInline(li)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (content.startsWith('# ')) {
      elements.push(<h1 key={i} style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text)', marginTop: '24px', marginBottom: '8px', ...wrapStyle }}>{parseInline(content.slice(2))}</h1>);
    } else if (content.startsWith('## ')) {
      elements.push(<h2 key={i} style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)', marginTop: '20px', marginBottom: '6px', ...wrapStyle }}>{parseInline(content.slice(3))}</h2>);
    } else if (content.startsWith('### ')) {
      elements.push(<h3 key={i} style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginTop: '16px', marginBottom: '4px', ...wrapStyle }}>{parseInline(content.slice(4))}</h3>);
    } else if (content.startsWith('#### ')) {
      elements.push(<h4 key={i} style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginTop: '12px', marginBottom: '4px', ...wrapStyle }}>{parseInline(content.slice(5))}</h4>);
    } else if (content.startsWith('- ') || content.startsWith('* ')) {
      elements.push(
        <div key={i} style={{ display: 'flex', gap: '8px', margin: '2px 0', ...wrapStyle }}>
          <span style={{ color: 'var(--text-2)', flexShrink: 0, marginTop: '2px' }}>·</span>
          <span style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6 }}>{parseInline(content.slice(2))}</span>
        </div>
      );
    } else if (content.startsWith('> ')) {
      elements.push(<blockquote key={i} style={{ borderLeft: '4px solid var(--border)', paddingLeft: '12px', fontStyle: 'italic', fontSize: '14px', color: 'var(--text-2)', margin: '8px 0', ...wrapStyle }}>{parseInline(content.slice(2))}</blockquote>);
    } else {
      elements.push(<p key={i} style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6, margin: '6px 0', ...wrapStyle }}>{parseInline(content)}</p>);
    }
  }

  return elements;
}

function RecommendationsPanel({ recommendations }) {
  if (!recommendations) return null;
  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
      <div>{renderMarkdown(recommendations)}</div>
    </div>
  );
}

function EnhancedArticlePanel({ text }) {
  if (!text) return null;
  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>New content is</span>
        <mark style={{ backgroundColor: 'var(--success-soft)', borderRadius: '3px', padding: '1px 7px', fontSize: '11px', fontWeight: 600, color: 'var(--success)' }}>highlighted in green</mark>
      </div>
      <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: '1.75' }}>
        {renderMarkdown(text)}
      </div>
    </div>
  );
}

function CrawlFailedPanel({ manualContent, setManualContent, onContinue }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ background: 'var(--danger-soft, #FEF2F2)', border: '1px solid var(--danger-border, #FECACA)', borderRadius: 'var(--r-lg)', padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <svg style={{ width: '18px', height: '18px', color: 'var(--danger)', flexShrink: 0, marginTop: '1px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div>
            <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--danger)', marginBottom: '4px' }}>Article could not be crawled</p>
            <p style={{ fontSize: '13px', color: 'var(--danger)', lineHeight: 1.5 }}>
              Very little content was extracted. The page may require JavaScript, block crawlers, or use a login wall.
              Paste the article text below to continue.
            </p>
          </div>
        </div>
      </div>
      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Paste article content</label>
        <textarea
          value={manualContent}
          onChange={e => setManualContent(e.target.value)}
          placeholder="Paste the full article text here. Use ## for H2 headings, # for the title."
          rows={16}
          style={{
            width: '100%', padding: '10px 12px', fontSize: '13px', lineHeight: 1.6,
            border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
            background: 'var(--surface)', color: 'var(--text)',
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
            fontFamily: 'var(--font-mono)',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--primary)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
        <button
          onClick={onContinue}
          disabled={!manualContent.trim()}
          style={{
            marginTop: '12px', width: '100%', padding: '10px 16px', fontSize: '14px',
            fontWeight: 600, borderRadius: 'var(--r-lg)', border: 'none', color: '#fff',
            background: manualContent.trim() ? 'var(--primary)' : 'var(--text-3)',
            cursor: manualContent.trim() ? 'pointer' : 'not-allowed', transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => { if (manualContent.trim()) e.currentTarget.style.opacity = '0.88'; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
        >
          Continue with pasted content
        </button>
      </div>
    </div>
  );
}

export default function ArticleEnhancementPage() {
  const navigate = useNavigate();
  // Prefill from whoever sent you here — today that is the Hub and Spoke report's
  // Enhance button, which knows the page's URL and whether it is a hub or a
  // spoke. Read once, as INITIAL state: everything stays editable afterwards,
  // and re-reading the query string on every render would fight the user's own
  // typing.
  //
  // contentType is validated against the options this page actually offers. A
  // hand-edited ?contentType=anything falls back to 'article' rather than
  // putting the select into a state it cannot display.
  const prefill = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const raw = (q.get('contentType') || '').toLowerCase();
    return {
      url: q.get('url') || '',
      contentType: ['article', 'hub', 'thin-content'].includes(raw) ? raw : 'article',
    };
  }, []);

  const [url, setUrl] = useState(prefill.url);
  const [urlError, setUrlError] = useState('');
  const [contentType, setContentType] = useState(prefill.contentType);
  const [selectedModels, setSelectedModels] = useState([DEFAULT_LLM_MODEL]);
  const [kbs, setKbs] = useState([]);
  const [selectedKbId, setSelectedKbId] = useState('seo-geo-article-enhancement-knowledge-base');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState('');
  const [downloading, setDownloading] = useState(false);

  const [stepStates, setStepStates] = useState({});

  const [articleMeta, setArticleMeta] = useState(null);
  const [themeData, setThemeData] = useState(null);
  const [llmResults, setLlmResults] = useState([]);
  const [synthResults, setSynthResults] = useState([]);
  const [serpResults, setSerpResults] = useState([]);
  const [competitorData, setCompetitorData] = useState({ totalCompetitors: 0, concepts: [] });
  const [recommendations, setRecommendations] = useState('');
  const [enhancedText, setEnhancedText] = useState('');
  const [coverage, setCoverage] = useState(null);
  const [crawlFailed, setCrawlFailed] = useState(false);
  const [manualContent, setManualContent] = useState('');

  const [activeTab, setActiveTab] = useState('recommendations');
  const esRef = useRef(null);
  const crawlFailedRef = useRef(false);
  // The full run output is assembled from several separate SSE events, then
  // read back inside the 'done' handler below. That handler closure is
  // created once per run and would otherwise see stale state (the classic
  // React closure problem) -- refs give it a live view, same trick as
  // crawlFailedRef above.
  const articleMetaRef = useRef(null);
  const recommendationsRef = useRef('');
  const enhancedTextRef = useRef('');
  const coverageRef = useRef(null);

  useEffect(() => {
    fetch('/api/kb', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const list = (d.knowledge_bases || []).filter(kb => kb.active);
        setKbs(list);
      })
      .catch(() => {});
  }, []);

  function validateUrl(val) {
    try { new URL(val); return true; } catch { return false; }
  }

  async function run() {
    if (!url.trim()) { setUrlError('Please enter an article URL'); return; }
    if (!validateUrl(url.trim())) { setUrlError('Please enter a valid URL (include https://)'); return; }
    setUrlError('');
    setRunning(true);
    notifyAgentRunStarted('article-enhancement');
    setDone(false);
    setFailed('');
    setStepStates({});
    setArticleMeta(null);
    setThemeData(null);
    setLlmResults([]);
    setSynthResults([]);
    setSerpResults([]);
    setCompetitorData({ totalCompetitors: 0, concepts: [] });
    setRecommendations('');
    setEnhancedText('');
    setCoverage(null);
    setCrawlFailed(false);
    crawlFailedRef.current = false;
    articleMetaRef.current = null;
    recommendationsRef.current = '';
    enhancedTextRef.current = '';
    coverageRef.current = null;

    let token;
    try {
      const res = await fetch('/api/article-enhancement/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: url.trim(), kbId: selectedKbId, contentType, models: selectedModels, manualContent: manualContent || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start');
      token = data.token;
    } catch (err) {
      setFailed(err.message);
      setRunning(false);
      return;
    }

    const es = new EventSource(`/api/article-enhancement/stream/${token}`);
    esRef.current = es;

    es.addEventListener('step', e => {
      const d = JSON.parse(e.data);
      setStepStates(prev => ({ ...prev, [d.id]: { status: d.status, message: d.message } }));
    });
    es.addEventListener('article_meta', e => {
      const d = JSON.parse(e.data);
      setArticleMeta(d);
      articleMetaRef.current = d;
    });
    es.addEventListener('theme_query', e => {
      setThemeData(JSON.parse(e.data));
      setActiveTab('analysis');
    });
    es.addEventListener('llm_result', e => {
      const d = JSON.parse(e.data);
      setLlmResults(prev => {
        const i = prev.findIndex(r => r.modelIndex === d.modelIndex);
        if (i >= 0) { const next = [...prev]; next[i] = { ...next[i], ...d }; return next; }
        return [...prev, d];
      });
    });
    es.addEventListener('llm_results', e => {
      const d = JSON.parse(e.data);
      setLlmResults(prev => {
        const merged = [...prev];
        for (const r of d.results) {
          const i = merged.findIndex(x => x.modelIndex === r.modelIndex);
          if (i >= 0) merged[i] = { ...merged[i], ...r }; else merged.push(r);
        }
        return merged;
      });
    });
    es.addEventListener('synthesis_result', e => {
      const d = JSON.parse(e.data);
      setSynthResults(prev => {
        const i = prev.findIndex(r => r.model === d.model);
        if (i >= 0) { const next = [...prev]; next[i] = d; return next; }
        return [...prev, d];
      });
    });
    es.addEventListener('serp_results', e => setSerpResults(JSON.parse(e.data).results || []));
    es.addEventListener('competitor_concepts', e => setCompetitorData(JSON.parse(e.data)));
    es.addEventListener('recommendations', e => {
      const d = JSON.parse(e.data).recommendations || '';
      setRecommendations(d);
      recommendationsRef.current = d;
      setActiveTab('recommendations');
    });
    es.addEventListener('coverage', e => {
      const d = JSON.parse(e.data);
      setCoverage(d);
      coverageRef.current = d;
    });
    es.addEventListener('enhanced', e => {
      const d = JSON.parse(e.data).text || '';
      setEnhancedText(d);
      enhancedTextRef.current = d;
      setActiveTab('enhanced');
    });
    es.addEventListener('crawl_failed', () => {
      crawlFailedRef.current = true;
      setCrawlFailed(true);
      setRunning(false);
      es.close();
    });
    es.addEventListener('fail', e => {
      setFailed(JSON.parse(e.data).message);
      setRunning(false);
      es.close();
    });
    es.addEventListener('done', () => {
      if (crawlFailedRef.current) return;
      setDone(true);
      setRunning(false);
      es.close();
      notifyAgentRunFinished('article-enhancement', {
        url: url.trim(),
        articleMeta: articleMetaRef.current,
        recommendations: recommendationsRef.current,
        enhancedText: enhancedTextRef.current,
        coverage: coverageRef.current,
      });
    });
    es.onerror = () => {
      setFailed('Connection lost. Please try again.');
      setRunning(false);
      es.close();
    };
  }

  function stop() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setRunning(false);
  }

  function toggleModel(id) {
    setSelectedModels(prev => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // keep at least one selected
        return prev.filter(m => m !== id);
      }
      return [...prev, id];
    });
  }

  async function downloadDocx() {
    if (!recommendations) return;
    setDownloading(true);
    try {
      const res = await fetch('/api/article-enhancement/export/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ articleMeta, themeData, llmResults, recommendations, enhancedText }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Export failed');
      }
      const blob = await res.blob();
      const burl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = (articleMeta?.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
      a.href = burl;
      a.download = `${slug}-enhancement.docx`;
      a.click();
      URL.revokeObjectURL(burl);
    } catch (err) {
      alert(err.message);
    } finally {
      setDownloading(false);
    }
  }

  const tabs = [
    { id: 'enhanced',        label: 'Enhanced Article', show: !!enhancedText },
    { id: 'analysis',        label: 'Analysis',         show: !!themeData },
    { id: 'recommendations', label: 'Recommendations',  show: !!recommendations },
    { id: 'coverage',        label: 'Coverage',         show: !!(coverage && coverage.reportMarkdown) },
  ].filter(t => t.show);

  // Deduplicated concepts from all synthesis results
  const allConceptsDisplay = (() => {
    const seen = new Set();
    const result = [];
    for (const s of synthResults) {
      for (const c of (s.concepts || [])) {
        const key = c.toLowerCase().trim().slice(0, 80);
        if (!seen.has(key)) { seen.add(key); result.push(c); }
      }
    }
    return result;
  })();

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
      <PageHeader navigate={navigate} />
      <main style={{ maxWidth: '1280px', margin: '0 auto', padding: '28px 32px' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--text)' }}>Enhance Existing Article</h1>
          <p style={{ fontSize: '14px', color: 'var(--text-2)', marginTop: '4px' }}>
            Crawl a live article, extract theme &amp; query, run {MODELS.length} parallel model calls, synthesize concepts, and generate enhancement recommendations.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '24px' }}>
          {/* Left: input + progress */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '16px' }}>Configuration</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* URL */}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>Article URL</label>
                  <input
                    type="url"
                    value={url}
                    onChange={e => { setUrl(e.target.value); setUrlError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter' && !running) run(); }}
                    placeholder="https://example.com/article"
                    disabled={running}
                    style={{
                      width: '100%', padding: '10px 12px', fontSize: '14px',
                      border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
                      background: running ? 'var(--surface)' : 'var(--card)',
                      color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--primary)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  {urlError && <p style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '6px' }}>{urlError}</p>}
                </div>

                {/* Content type (user-selected) */}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>Content Type</label>
                  <select
                    value={contentType}
                    onChange={e => setContentType(e.target.value)}
                    disabled={running}
                    style={{
                      width: '100%', padding: '10px 12px', fontSize: '14px',
                      border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
                      background: running ? 'var(--surface)' : 'var(--card)',
                      color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                    }}
                  >
                    <option value="article">Article (long-form, single topic)</option>
                    <option value="hub">Hub / Resource Page (links &amp; navigation)</option>
                    <option value="thin-content">Thin Content (needs expansion)</option>
                  </select>
                </div>

                {/* Analysis & Recommendation Models — the internal multi-model
                    research fan-out above always uses OpenAI regardless of this
                    selection, and content creation always uses GPT-5.4 mini. */}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>Analysis &amp; Recommendation Models</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', background: running ? 'var(--surface)' : 'var(--card)' }}>
                    {LLM_MODEL_OPTIONS.map(opt => (
                      <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text)', cursor: running ? 'not-allowed' : 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(opt.id)}
                          onChange={() => toggleModel(opt.id)}
                          disabled={running}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                  <p style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '6px' }}>
                    Selecting more than one synthesizes their recommendations into one. Article content is always written with GPT-5.4 mini.
                  </p>
                </div>

                {/* KB selector — locked to the single default KB in embed mode (public
                    intelligence.position2.com /app agent); internal /p2/seo keeps the
                    full picker since staff may work across multiple clients' KBs. */}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>Knowledge Base</label>
                  {EMBED_MODE ? (
                    <div
                      title="This agent always uses its own knowledge base"
                      style={{
                        width: '100%', padding: '10px 12px', fontSize: '14px',
                        border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
                        background: 'var(--surface)', color: 'var(--text-2)',
                        boxSizing: 'border-box', overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap', cursor: 'default',
                      }}
                    >
                      {selectedKbId}
                    </div>
                  ) : (
                    <select
                      value={selectedKbId}
                      onChange={e => setSelectedKbId(e.target.value)}
                      disabled={running}
                      style={{
                        width: '100%', padding: '10px 12px', fontSize: '14px',
                        border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
                        background: running ? 'var(--surface)' : 'var(--card)',
                        color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                      }}
                    >
                      {kbs.length === 0 && (
                        <option value="seo-geo-article-enhancement-knowledge-base">seo-geo-article-enhancement-knowledge-base</option>
                      )}
                      {kbs.map(kb => (
                        <option key={kb.id} value={kb.id}>{kb.id}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {running ? (
                    <button
                      onClick={stop}
                      style={{ width: '100%', padding: '10px 16px', fontSize: '14px', fontWeight: 600, borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', color: 'var(--text-2)', background: 'var(--card)', cursor: 'pointer', transition: 'color 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--text)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-2)'}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={run}
                      style={{ width: '100%', padding: '10px 16px', fontSize: '14px', fontWeight: 600, borderRadius: 'var(--r-lg)', border: 'none', color: '#fff', background: 'var(--primary)', cursor: 'pointer', transition: 'opacity 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                    >
                      Run Enhancement
                    </button>
                  )}

                  {done && (recommendations || enhancedText) && (
                    <button
                      onClick={downloadDocx}
                      disabled={downloading}
                      style={{ width: '100%', padding: '10px 16px', fontSize: '14px', fontWeight: 600, borderRadius: 'var(--r-lg)', border: 'none', color: '#fff', background: 'var(--primary)', cursor: downloading ? 'not-allowed' : 'pointer', opacity: downloading ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', transition: 'opacity 0.15s' }}
                    >
                      <svg style={{ width: '16px', height: '16px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      {downloading ? 'Generating…' : 'Download .docx'}
                    </button>
                  )}
                </div>

                {failed && (
                  <div style={{ padding: '12px', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-lg)', fontSize: '12px', color: 'var(--danger)' }}>{failed}</div>
                )}
                {done && !failed && (
                  <div style={{ padding: '12px', background: 'var(--success-soft)', border: '1px solid var(--success)', borderRadius: 'var(--r-lg)', fontSize: '12px', fontWeight: 600, color: 'var(--success)' }}>
                    Enhancement complete
                  </div>
                )}
              </div>
            </div>

            {/* Article meta */}
            {articleMeta && (
              <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '12px' }}>Article</h3>
                <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px', lineHeight: 1.3 }}>{articleMeta.title}</p>
                <p style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '12px', wordBreak: 'break-all' }}>{articleMeta.url}</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ textAlign: 'center', padding: '8px', background: 'var(--surface)', borderRadius: 'var(--r-lg)' }}>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{articleMeta.wordCount?.toLocaleString()}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>words</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '8px', background: 'var(--surface)', borderRadius: 'var(--r-lg)' }}>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{articleMeta.h2s?.length}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>H2 sections</div>
                  </div>
                </div>
                {/* Coverage summary badge (Fix 6) */}
                {coverage && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, padding: '3px 9px', borderRadius: '999px', background: 'var(--success-soft)', color: 'var(--success)' }}>
                      ✅ {coverage.checked}/{coverage.total} covered
                    </span>
                  </div>
                )}
                {articleMeta.h2s?.length > 0 && (
                  <div style={{ marginTop: '12px' }}>
                    <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', marginBottom: '6px' }}>H2 Headings</p>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {articleMeta.h2s.slice(0, 6).map((h, i) => (
                        <li key={i} style={{ fontSize: '12px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {h}</li>
                      ))}
                      {articleMeta.h2s.length > 6 && (
                        <li style={{ fontSize: '12px', color: 'var(--text-3)' }}>+{articleMeta.h2s.length - 6} more…</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Pipeline progress */}
            {Object.keys(stepStates).length > 0 && (
              <StepIndicator stepStates={stepStates} />
            )}
          </div>

          {/* Right: results */}
          <div>
            {crawlFailed ? (
              <CrawlFailedPanel
                manualContent={manualContent}
                setManualContent={setManualContent}
                onContinue={run}
              />
            ) : tabs.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px', background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', color: 'var(--text-3)', fontSize: '14px' }}>
                {running ? 'Running analysis…' : 'Enter an article URL and click Run Enhancement'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      style={activeTab === tab.id
                        ? { padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 500, border: '1px solid var(--primary)', background: 'var(--primary)', color: '#fff', cursor: 'pointer', transition: 'all 0.15s' }
                        : { padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 500, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-2)', cursor: 'pointer', transition: 'all 0.15s' }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Analysis tab */}
                {activeTab === 'analysis' && themeData && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {/* Theme & Query */}
                    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div>
                        <p style={{ fontSize: '12px', color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Article Theme</p>
                        <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{themeData.theme}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: '12px', color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>Search Query</p>
                        <div style={{ padding: '10px 12px', background: 'var(--info-soft)', borderRadius: 'var(--r-lg)', fontSize: '13px', fontWeight: 500, color: 'var(--info)' }}>
                          {themeData.query}
                        </div>
                      </div>
                    </div>

                    {/* Synthesized concepts */}
                    {allConceptsDisplay.length > 0 && (
                      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                        <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
                          Synthesized Concepts ({allConceptsDisplay.length})
                        </p>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {allConceptsDisplay.map((c, i) => (
                            <li key={i} style={{ fontSize: '13px', color: 'var(--text)', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.5 }}>
                              <span style={{ color: 'var(--info)', flexShrink: 0, marginTop: '3px' }}>·</span>{c}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* SERP competitors */}
                    {serpResults.length > 0 && (
                      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                        <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
                          SERP Competitors ({serpResults.length})
                        </p>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {serpResults.map((r, i) => (
                            <li key={i} style={{ fontSize: '13px', color: 'var(--text)', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.4 }}>
                              <span style={{ color: 'var(--text-3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>#{r.rank}</span>
                              <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title || r.url}</a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Competitor topic coverage */}
                    {competitorData.concepts.length > 0 && (
                      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                        <p style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '10px' }}>
                          Competitor Topic Coverage ({competitorData.concepts.length})
                        </p>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {competitorData.concepts.map((c, i) => (
                            <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text)' }}>
                              <span style={{
                                fontSize: '11px', fontWeight: 600, padding: '1px 7px', borderRadius: '999px', flexShrink: 0,
                                background: c.coveredByArticle ? 'var(--success-soft)' : 'var(--danger-soft)',
                                color: c.coveredByArticle ? 'var(--success)' : 'var(--danger)',
                              }}>
                                {c.coveredByArticle ? 'Covered' : 'Gap'}
                              </span>
                              <span style={{ flex: 1 }}>{c.topic}</span>
                              <span style={{ color: 'var(--text-3)', fontSize: '12px', flexShrink: 0 }}>{c.frequency}/{competitorData.totalCompetitors}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'enhanced' && <EnhancedArticlePanel text={enhancedText} />}
                {activeTab === 'recommendations' && <RecommendationsPanel recommendations={recommendations} />}
                {activeTab === 'coverage' && coverage?.reportMarkdown && <RecommendationsPanel recommendations={coverage.reportMarkdown} />}
              </div>
            )}
          </div>
        </div>
        <ModuleRuns toolId="article-enhancement" />
      </main>
    </>
  );
}
