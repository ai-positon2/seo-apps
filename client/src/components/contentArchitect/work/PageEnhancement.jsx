// A saved enhancement of an existing hub or spoke page, shown where the page is
// listed: a badge that says it exists and how it scored, opening a panel with
// the enhanced article ([NEW] additions highlighted), the recommendations and
// the coverage report — the same three tabs the Enhance tool shows.

import { useEffect, useState } from 'react';
import { ca } from '../../../lib/contentArchitectApi';
import { timeAgo } from '../../../lib/hubSpokeWork';
import { renderMarkdown } from '../../articleEnhancement/renderMarkdown';
import { SparkIcon } from './WorkTally';

export function EnhancementBadge({ enhancement, open, onToggle }) {
  if (!enhancement) return null;
  const cov = enhancement.coverage;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-expanded={open}
      title={`Enhanced ${new Date(enhancement.updatedAt).toLocaleString()}${enhancement.createdBy ? ` by ${enhancement.createdBy}` : ''}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer',
        fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--r-pill)',
        border: `1px solid ${open ? 'var(--success)' : 'color-mix(in srgb, var(--success) 45%, var(--border))'}`,
        background: open ? 'var(--success-soft)' : 'transparent', color: 'var(--success)', whiteSpace: 'nowrap',
      }}
    >
      <SparkIcon size={11} />
      Enhanced {timeAgo(enhancement.updatedAt)}
      {cov && <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-2)' }}>{cov.covered}/{cov.total}</span>}
      {enhancement.additions > 0 && <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>+{enhancement.additions} new</span>}
      <span aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
  );
}

const TABS = [
  { id: 'enhanced', label: 'Enhanced article' },
  { id: 'recommendations', label: 'Recommendations' },
  { id: 'coverage', label: 'Coverage' },
];

export function EnhancementPanel({ projectId, url, onReEnhance }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('enhanced');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    ca.getWorkEnhancement(projectId, url)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [projectId, url]);

  const r = data?.result || {};
  const text = tab === 'enhanced' ? r.enhancedText : tab === 'recommendations' ? r.recommendations : r.coverage?.reportMarkdown;

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(r.enhancedText || '').replace(/\[\/?NEW\]/g, ''));
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ borderRadius: 'var(--r-md)', border: '1px solid color-mix(in srgb, var(--success) 35%, var(--border))', background: 'var(--card)', overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexWrap: 'wrap' }}>
        <div role="tablist" style={{ display: 'flex', gap: 14 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{
                fontSize: 12, fontWeight: 600, padding: '4px 0', background: 'none', border: 'none', cursor: 'pointer',
                color: tab === t.id ? 'var(--text)' : 'var(--text-3)', borderBottom: `2px solid ${tab === t.id ? 'var(--success)' : 'transparent'}`,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {data && (
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {r.articleMeta?.wordCount ? `${r.articleMeta.wordCount.toLocaleString('en-US')} words originally · ` : ''}
            {data.contentType === 'hub' ? 'enhanced as a hub' : 'enhanced as an article'}
            {data.createdBy ? ` · by ${data.createdBy}` : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {r.enhancedText && (
            <button type="button" onClick={copy} style={miniButton(copied)}>{copied ? 'Copied' : 'Copy text'}</button>
          )}
          <button type="button" onClick={onReEnhance} style={miniButton(false)} title="Run the enhancement again — replaces this saved result">Re-enhance</button>
        </span>
      </div>

      <div style={{ maxHeight: 440, overflowY: 'auto', padding: '6px 18px 14px' }}>
        {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '8px 0' }}>{error}</div>}
        {!data && !error && <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>Loading the saved enhancement…</div>}
        {data && tab === 'enhanced' && r.enhancedText && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '6px 0 2px' }}>
            New content is <mark style={{ background: 'var(--success-soft)', color: 'var(--success)', padding: '0 5px', borderRadius: 3 }}>highlighted in green</mark>
          </div>
        )}
        {data && (text
          ? <div style={{ fontFamily: tab === 'enhanced' ? 'Georgia, "Times New Roman", serif' : undefined, lineHeight: 1.7 }}>{renderMarkdown(text)}</div>
          : <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0' }}>Nothing saved for this tab.</div>)}
      </div>
    </div>
  );
}

function miniButton(active) {
  return {
    fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${active ? 'var(--success)' : 'var(--border)'}`,
    background: active ? 'var(--success-soft)' : 'var(--card)', color: active ? 'var(--success)' : 'var(--text-2)',
  };
}
