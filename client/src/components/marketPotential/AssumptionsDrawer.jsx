// ── Assumptions drawer (V2 Phase 2) ───────────────────────────────────────────
// Editable inputs behind the directional dollar model. Persisted per service.

import { Drawer } from '../../ui/Drawer';
import { Button } from '../../ui/Button';
import { ASSUMPTION_DEFS, ASSUMPTION_DEFAULTS } from './assumptions';

export default function AssumptionsDrawer({ open, onClose, assumptions, onChange }) {
  const setKey = (key, value) => onChange({ ...assumptions, [key]: value });

  return (
    <Drawer open={open} onClose={onClose} title="Revenue assumptions" width={420}
      footer={<>
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...ASSUMPTION_DEFAULTS })}>Reset to defaults</Button>
        <Button size="sm" onClick={onClose}>Done</Button>
      </>}>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 0, marginBottom: 18 }}>
        These drive the <b>directional</b> dollar estimates in each market's detail. They count only searchers who typed
        the city name, so treat every figure as a comparative floor between markets — not a forecast.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {ASSUMPTION_DEFS.map((d) => {
          const isPct = d.kind === 'pct';
          const display = isPct ? Math.round((assumptions[d.key] ?? 0) * 100) : (assumptions[d.key] ?? 0);
          return (
            <div key={d.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{d.label}</label>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {!isPct && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>$</span>}
                  <input
                    type="number" min={0} step={isPct ? 1 : 100}
                    value={display}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      if (Number.isNaN(raw)) return;
                      setKey(d.key, isPct ? Math.max(0, Math.min(100, raw)) / 100 : Math.max(0, raw));
                    }}
                    style={{
                      width: isPct ? 62 : 96, textAlign: 'right', padding: '5px 8px', fontSize: 13,
                      border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)',
                      background: 'var(--card)', color: 'var(--text)', fontFamily: 'var(--font-mono)',
                    }}
                  />
                  {isPct && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>%</span>}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>{d.hint}</div>
            </div>
          );
        })}
      </div>
    </Drawer>
  );
}
