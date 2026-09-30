// "All source keywords": every candidate the competitor pages rank for that is
// not currently picked, in Core / Relevant / Discovery tiers.
//
// full    — a collapsible panel of tier tables; + Primary / + Secondary in
//           edit mode.
// compact — tier filter chips over one dense list, always addable.

import { useState } from 'react';
import { MAX_PRIMARY, MAX_SECONDARY, availableKeywords, poolByTier } from '../../lib/keywordResearchModel';
import { AddButton, cardShadow } from './shared';
import { CompactHeader, CompactRow } from './KrPicks';

export default function KrSourcePool({ density = 'full', ...props }) {
  return density === 'compact' ? <CompactPool {...props} /> : <FullPool {...props} />;
}

function AddButtons({ kr, kw }) {
  const { primary, secondary } = kr.state;
  return (
    <>
      <AddButton
        tone="primary" label="+ Primary" onClick={() => kr.addPrimary(kw)}
        full={primary.length >= MAX_PRIMARY} fullTitle={`Primary is full (${MAX_PRIMARY}/${MAX_PRIMARY}) — remove one first`}
      />
      <AddButton
        tone="secondary" label="+ Secondary" onClick={() => kr.addSecondary(kw)}
        full={secondary.length >= MAX_SECONDARY} fullTitle={`Secondary is full (${MAX_SECONDARY}/${MAX_SECONDARY}) — remove one first`}
      />
    </>
  );
}

// ── full ────────────────────────────────────────────────────────────────────

function FullPool({ kr, editMode, open, onToggle }) {
  const { allKeywords } = kr.state;
  if (!allKeywords.length) return null;
  const available = availableKeywords(kr.state);
  const tiers = poolByTier(kr.state);

  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', boxShadow: cardShadow }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', textAlign: 'left', background: 'none', border: 'none', borderRadius: 'var(--r-lg)', cursor: 'pointer', transition: 'background 0.1s' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>All source keywords</span>
          <span style={{ fontSize: 12, background: 'var(--surface)', color: 'var(--text-2)', fontWeight: 600, padding: '2px 8px', borderRadius: 99 }}>
            {available.length} available
          </span>
        </div>
        <svg style={{ width: 16, height: 16, color: 'var(--text-2)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', borderRadius: '0 0 var(--r-lg) var(--r-lg)', overflow: 'hidden' }}>
          {available.length === 0 && (
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-2)' }}>
              All candidate keywords have been selected as Primary or Secondary.
            </div>
          )}
          {tiers.map((tier) => (
            <div key={tier.id} style={{ borderTop: '1px solid var(--border)' }}>
              <div style={{ padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, background: tier.headerBg }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: tier.color }}>{tier.label}</span>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{tier.desc}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: tier.color }}>{tier.keywords.length}</span>
              </div>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                <tbody>
                  {tier.keywords.map((kw, i) => (
                    <tr
                      key={i}
                      style={{ borderTop: '1px solid var(--border)', transition: 'background 0.1s' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ padding: '10px 20px', color: 'var(--text)', fontWeight: 500, fontSize: 12 }}>{kw.keyword}</td>
                      <td style={{ padding: '10px 20px', color: 'var(--text-2)', fontSize: 12, textAlign: 'right', width: 96 }}>
                        {kw.volume > 0 ? kw.volume.toLocaleString() : '—'}
                      </td>
                      {editMode && (
                        <td style={{ padding: '10px 20px', textAlign: 'right', width: 160 }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><AddButtons kr={kr} kw={kw} /></div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── compact ─────────────────────────────────────────────────────────────────

function CompactPool({ kr }) {
  const [tierId, setTierId] = useState('all');
  const tiers = poolByTier(kr.state);
  const available = availableKeywords(kr.state);
  const active = tiers.find((t) => t.id === tierId);
  const rows = active
    ? active.keywords
    : [...available].sort((a, b) => (b.urlFrequency || 0) - (a.urlFrequency || 0) || (b.volume || 0) - (a.volume || 0));

  const chip = (id, label, count, color) => {
    const on = tierId === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setTierId(id)}
        style={{
          fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 99, cursor: 'pointer',
          border: `1px solid ${on ? color : 'var(--border)'}`, background: on ? 'var(--card)' : 'transparent', color: on ? color : 'var(--text-2)',
        }}
      >
        {label} · {count}
      </button>
    );
  };

  if (!kr.state.allKeywords.length) {
    return <div style={{ padding: 10, fontSize: 11.5, color: 'var(--text-3)' }}>No source keywords for this run.</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px' }}>
        {chip('all', 'All', available.length, 'var(--text)')}
        {tiers.map((t) => chip(t.id, t.label, t.keywords.length, t.color))}
      </div>
      {active && <div style={{ padding: '0 10px 6px', fontSize: 11, color: 'var(--text-3)' }}>{active.desc}</div>}
      <CompactHeader cells={['KEYWORD', 'VOLUME', 'KD', '']} />
      {rows.length === 0 && (
        <div style={{ padding: 10, fontSize: 11.5, color: 'var(--text-3)' }}>All candidate keywords have been selected as Primary or Secondary.</div>
      )}
      {rows.map((kw) => (
        <CompactRow
          key={kw.keyword}
          kw={kw}
          lead={
            <span title={`Ranks on ${kw.urlFrequency || 1} competitor page${(kw.urlFrequency || 1) === 1 ? '' : 's'}`} style={{ flexShrink: 0, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', width: 16 }}>
              ×{kw.urlFrequency || 1}
            </span>
          }
          actions={<AddButtons kr={kr} kw={kw} />}
        />
      ))}
    </div>
  );
}
