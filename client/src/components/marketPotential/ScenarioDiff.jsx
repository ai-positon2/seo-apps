// ── Scenario diff (V2 Phase 4) ────────────────────────────────────────────────
// Side-by-side Demand Index + Opportunity Score for two saved scenarios of the
// same service, joined on market, with delta arrows.

import { Modal } from '../../ui/Modal';

const arrow = (d) => (d == null ? '' : d > 0 ? '▲' : d < 0 ? '▼' : '▬');
const arrowColor = (d) => (d == null ? 'var(--text-3)' : d > 0 ? 'var(--success)' : d < 0 ? 'var(--danger)' : 'var(--text-3)');

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-3)', textAlign: 'right', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)' };

function DeltaCell({ a, b }) {
  const d = a == null || b == null ? null : b - a;
  return (
    <td style={td}>
      <span style={{ color: 'var(--text-3)' }}>{a ?? '—'}</span>
      <span style={{ color: 'var(--text-3)', margin: '0 4px' }}>→</span>
      <b>{b ?? '—'}</b>
      {d != null && d !== 0 && <span style={{ color: arrowColor(d), marginLeft: 6, fontSize: 11 }}>{arrow(d)} {Math.abs(d)}</span>}
    </td>
  );
}

export default function ScenarioDiff({ open, onClose, left, right }) {
  // left / right: { name, rows: scoredRows }
  const rowsBy = (rows) => new Map((rows || []).map((r) => [r.geoId, r]));
  const L = rowsBy(left?.rows), R = rowsBy(right?.rows);
  const ids = [...new Set([...(left?.rows || []), ...(right?.rows || [])].map((r) => r.geoId))];
  const merged = ids.map((id) => ({ id, a: L.get(id), b: R.get(id) }))
    .sort((x, y) => (y.b?.opportunityScore ?? y.a?.opportunityScore ?? -1) - (x.b?.opportunityScore ?? x.a?.opportunityScore ?? -1));

  return (
    <Modal open={open} onClose={onClose} size="lg"
      title={<span>Scenario comparison</span>}>
      <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>
        <span><b style={{ color: 'var(--text-3)' }}>A</b> {left?.name}</span>
        <span style={{ color: 'var(--text-3)' }}>→</span>
        <span><b>B</b> {right?.name}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              <th style={{ ...th, textAlign: 'left' }}>Market</th>
              <th style={th}>Demand Index (A → B)</th>
              <th style={th}>Opportunity (A → B)</th>
            </tr>
          </thead>
          <tbody>
            {merged.map(({ id, a, b }) => {
              const row = b || a;
              return (
                <tr key={id}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{row.region}{row.isHome ? ' · home' : ''}</td>
                  <DeltaCell a={a?.demandIndex} b={b?.demandIndex} />
                  <DeltaCell a={a?.isHome ? null : a?.opportunityScore} b={b?.isHome ? null : b?.opportunityScore} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.5 }}>
        Δ shows the change from scenario A to B. Markets present in only one scenario show a dash on the other side.
      </p>
    </Modal>
  );
}
