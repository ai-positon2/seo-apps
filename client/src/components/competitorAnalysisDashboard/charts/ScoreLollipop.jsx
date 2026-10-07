import { Badge } from '../../../ui/Badge';
import { seriesColor } from '../utils';

const TICKS = [0, 25, 50, 75, 100];

// Dot plot on a shared 0-100 axis — used for Authority Score once there are
// too many domains for gauge small multiples to stay legible (see
// ScoreCompare). A thin connector from 0 to the score plus an end-dot reads
// as a "lollipop," letting every domain share one axis instead of N separate
// gauges.
export function ScoreLollipop({ domains = [] }) {
  return (
    <div>
      {/* Shared axis ticks */}
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, marginBottom: 6 }}>
        <div />
        <div style={{ position: 'relative', height: 16 }}>
          {TICKS.map((t) => (
            <span key={t} style={{
              position: 'absolute', left: `${t}%`, transform: t === 100 ? 'translateX(-100%)' : t === 0 ? 'none' : 'translateX(-50%)',
              fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)',
            }}>
              {t}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {domains.map((d) => {
          const score = Math.max(0, Math.min(100, d.authorityScore || 0));
          const color = seriesColor(d.isClient);
          const label = d.label || d.domain;
          return (
            <div key={d.domain} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center' }} title={`${label}: ${Math.round(score)} / 100`}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
                fontSize: 13, fontWeight: d.isClient ? 700 : 400,
                color: d.isClient ? 'var(--text)' : 'var(--text-2)',
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                {d.isClient && <Badge variant="brand" style={{ flexShrink: 0 }}>Client</Badge>}
              </div>

              <div style={{ position: 'relative', height: 20 }}>
                {/* Gridlines */}
                {TICKS.map((t) => (
                  <div key={t} style={{ position: 'absolute', left: `${t}%`, top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
                ))}
                {/* Connector */}
                <div style={{ position: 'absolute', left: 0, top: '50%', width: `${score}%`, height: 2, background: color, transform: 'translateY(-50%)', opacity: d.isClient ? 1 : 0.6 }} />
                {/* Dot with surface ring */}
                <div style={{
                  position: 'absolute', left: `${score}%`, top: '50%',
                  width: d.isClient ? 14 : 10, height: d.isClient ? 14 : 10,
                  borderRadius: '50%', background: color,
                  border: '2px solid var(--card)',
                  transform: 'translate(-50%, -50%)',
                }} />
                <span style={{
                  position: 'absolute', left: `calc(${score}% + 12px)`, top: '50%', transform: 'translateY(-50%)',
                  fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: d.isClient ? 700 : 500,
                  color: d.isClient ? 'var(--text)' : 'var(--text-2)', whiteSpace: 'nowrap',
                }}>
                  {Math.round(score)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ScoreLollipop;
