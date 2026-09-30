// The shortlist: 2 primary and 10 secondary keywords, editable.
//
// full    — primary cards with the AI's reason, a secondary table, × buttons
//           in edit mode, and the low-match warning.
// compact — one dense table (keyword · role · volume · KD, reason as a
//           tooltip). Always editable: move a keyword between primary and
//           secondary, or remove it back to the pool.

import { MAX_PRIMARY, MAX_SECONDARY } from '../../lib/keywordResearchModel';
import { RemoveButton, cardShadow } from './shared';

export default function KrPicks({ density = 'full', ...props }) {
  return density === 'compact' ? <CompactPicks {...props} /> : <FullPicks {...props} />;
}

export function KrWarning({ warning, density = 'full' }) {
  if (!warning) return null;
  if (density === 'compact') {
    return (
      <div style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--warning)', padding: '6px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--warning)', background: 'var(--warning-soft, #FFFBEB)' }}>
        <span aria-hidden="true">⚠</span><span>{warning}</span>
      </div>
    );
  }
  return (
    <div style={{ padding: 16, background: 'var(--warning-soft, #FFFBEB)', border: '1px solid var(--warning)', borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }}>⚠</span>
      <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--warning)', margin: 0 }}>{warning}</p>
    </div>
  );
}

function CountPill({ count, max, size = 12 }) {
  const full = count === max;
  return (
    <span style={{
      fontSize: size, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
      background: full ? 'var(--success-soft)' : 'var(--danger-soft, #FEF2F2)',
      color: full ? 'var(--success)' : 'var(--danger)',
    }}>
      {count} / {max} selected
    </span>
  );
}

const volumeText = (v) => (v > 0 ? v.toLocaleString() : '—');

// ── full ────────────────────────────────────────────────────────────────────

function FullPicks({ kr, editMode }) {
  const { primary, secondary } = kr.state;
  const th = { textAlign: 'left', color: '#fff', fontWeight: 600, padding: '12px 16px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' };

  return (
    <>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Primary Keywords</h2>
          <CountPill count={primary.length} max={MAX_PRIMARY} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {primary.map((kw, i) => (
            <div key={i} style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', padding: 20, border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)', boxShadow: cardShadow }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                <h3 style={{ fontWeight: 700, color: 'var(--text)', fontSize: 15, lineHeight: 1.3, margin: 0 }}>{kw.keyword}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 4, background: 'var(--primary-soft)', color: 'var(--primary)' }}>PRIMARY</span>
                  {editMode && <RemoveButton onClick={() => kr.removePrimary(i)} title="Remove from Primary" />}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>Search Volume</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{volumeText(kw.volume)}</div>
              </div>
              {kw.reason && (
                <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 12, margin: 0 }}>{kw.reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Secondary Keywords</h2>
          <CountPill count={secondary.length} max={MAX_SECONDARY} />
        </div>
        <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', boxShadow: cardShadow, overflow: 'hidden' }}>
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--nav-bg-top)' }}>
                <th style={th}>#</th>
                <th style={th}>Keyword</th>
                <th style={th}>Volume</th>
                {editMode && <th style={{ padding: '12px 16px', width: 48 }}></th>}
              </tr>
            </thead>
            <tbody>
              {secondary.map((kw, i) => (
                <tr
                  key={i}
                  style={{ borderTop: '1px solid var(--border)', transition: 'background 0.1s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '12px 16px', color: 'var(--text-3)', fontSize: 12 }}>{i + 1}</td>
                  <td style={{ padding: '12px 16px', fontWeight: 500, color: 'var(--text)' }}>{kw.keyword}</td>
                  <td style={{ padding: '12px 16px', color: 'var(--text-2)' }}>{volumeText(kw.volume)}</td>
                  {editMode && (
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      <RemoveButton onClick={() => kr.removeSecondary(i)} title="Remove from Secondary" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── compact ─────────────────────────────────────────────────────────────────

export const COMPACT_COLUMNS = 'minmax(0,1fr) 64px 34px 150px';

export function CompactHeader({ cells }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COMPACT_COLUMNS, gap: 8, padding: '5px 10px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 1 }}>
      {cells.map((h, i) => (
        <span key={i} style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)', textAlign: i === 0 ? 'left' : 'right' }}>{h}</span>
      ))}
    </div>
  );
}

export function CompactRow({ kw, lead, actions }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COMPACT_COLUMNS, gap: 8, alignItems: 'center', padding: '5px 10px', borderBottom: '1px solid var(--border)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {lead}
        <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kw.keyword}</span>
        {kw.reason && (
          <span title={kw.reason} aria-label={`Why: ${kw.reason}`} style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-3)', cursor: 'help' }}>ⓘ</span>
        )}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{volumeText(kw.volume)}</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', textAlign: 'right' }} title="Keyword difficulty (SEMrush)">{kw.difficulty || '—'}</span>
      <span style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5 }}>{actions}</span>
    </div>
  );
}

function RoleTag({ role }) {
  const primary = role === 'primary';
  return (
    <span style={{
      flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: '.04em', padding: '1px 5px', borderRadius: 4,
      background: primary ? 'var(--primary-soft)' : 'var(--info-soft)', color: primary ? 'var(--primary)' : 'var(--info)',
    }}>
      {primary ? 'P' : 'S'}
    </span>
  );
}

function MoveButton({ label, title, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 6, border: '1px solid var(--border)', whiteSpace: 'nowrap',
        background: 'var(--card)', color: disabled ? 'var(--text-3)' : 'var(--text-2)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

function GroupLabel({ label, count, max }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 4px' }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text-3)' }}>{label}</span>
      <CountPill count={count} max={max} size={10.5} />
    </div>
  );
}

function CompactPicks({ kr }) {
  const { primary, secondary } = kr.state;
  const primaryFull = primary.length >= MAX_PRIMARY;
  const secondaryFull = secondary.length >= MAX_SECONDARY;

  return (
    <div>
      <CompactHeader cells={['KEYWORD', 'VOLUME', 'KD', '']} />
      <GroupLabel label="PRIMARY" count={primary.length} max={MAX_PRIMARY} />
      {primary.length === 0 && <div style={{ padding: '4px 10px 8px', fontSize: 11.5, color: 'var(--text-3)' }}>No primary keyword — promote a secondary or add one from the pool.</div>}
      {primary.map((kw, i) => (
        <CompactRow
          key={`p-${kw.keyword}`}
          kw={kw}
          lead={<RoleTag role="primary" />}
          actions={<>
            <MoveButton label="→ Secondary" title={secondaryFull ? `Secondary is full (${MAX_SECONDARY}/${MAX_SECONDARY})` : 'Make this a secondary keyword'} disabled={secondaryFull} onClick={() => kr.toSecondary(i)} />
            <RemoveButton size={18} onClick={() => kr.removePrimary(i)} title="Remove from Primary" />
          </>}
        />
      ))}
      <GroupLabel label="SECONDARY" count={secondary.length} max={MAX_SECONDARY} />
      {secondary.map((kw, i) => (
        <CompactRow
          key={`s-${kw.keyword}`}
          kw={kw}
          lead={<RoleTag role="secondary" />}
          actions={<>
            <MoveButton label="→ Primary" title={primaryFull ? `Primary is full (${MAX_PRIMARY}/${MAX_PRIMARY}) — move one down first` : 'Make this a primary keyword'} disabled={primaryFull} onClick={() => kr.toPrimary(i)} />
            <RemoveButton size={18} onClick={() => kr.removeSecondary(i)} title="Remove from Secondary" />
          </>}
        />
      ))}
    </div>
  );
}
