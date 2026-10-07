// ── Opportunity-Score weight controls (V2 Phase 1) ────────────────────────────
// Preset chips + per-axis sliders. Sliders renormalize to sum = 1 on change and the
// board reorders instantly (no refetch). Chosen weights persist in localStorage.

import { WEIGHT_PRESETS, WEIGHT_KEYS, COMPONENT_LABELS, COMPONENT_HELP, matchPreset, normalizeWeights } from './scoring';

export default function WeightControls({ weights, onChange, compact = false }) {
  const active = matchPreset(weights);

  const applyPreset = (key) => onChange({ ...WEIGHT_PRESETS[key].weights });

  // Move one axis; hold the sum at 1 by renormalizing the others proportionally.
  const setAxis = (key, next) => {
    const others = WEIGHT_KEYS.filter((k) => k !== key);
    const otherSum = others.reduce((a, k) => a + weights[k], 0);
    const remain = 1 - next;
    const out = { [key]: next };
    if (otherSum <= 0) {
      const even = remain / others.length;
      others.forEach((k) => { out[k] = even; });
    } else {
      others.forEach((k) => { out[k] = (weights[k] / otherSum) * remain; });
    }
    onChange(normalizeWeights(out));
  };

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
      padding: compact ? '12px 14px' : '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>
          Priorities <span style={{ fontWeight: 400, color: 'var(--text-3)' }}>· how markets are scored</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(WEIGHT_PRESETS).map(([key, p]) => {
            const on = active === key;
            return (
              <button key={key} onClick={() => applyPreset(key)} title={p.hint}
                style={{
                  padding: '4px 11px', borderRadius: 'var(--r-pill)', fontSize: 12, cursor: 'pointer',
                  fontWeight: on ? 600 : 500, whiteSpace: 'nowrap',
                  border: `1px solid ${on ? 'var(--primary)' : 'var(--border-strong)'}`,
                  background: on ? 'var(--primary-soft)' : 'var(--card)',
                  color: on ? 'var(--primary-text)' : 'var(--text-2)',
                }}>
                {p.label}
              </button>
            );
          })}
          {active == null && (
            <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center' }}>Custom</span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: '10px 22px' }}>
        {WEIGHT_KEYS.map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span title={COMPONENT_HELP[k]} style={{ fontSize: 12, color: 'var(--text-2)', minWidth: 88, cursor: 'help' }}>
              {COMPONENT_LABELS[k]}
            </span>
            <input type="range" min={0} max={1} step={0.05} value={weights[k]}
              onChange={(e) => setAxis(k, Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--primary)' }} />
            <span className="num" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', minWidth: 34, textAlign: 'right' }}>
              {Math.round(weights[k] * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
