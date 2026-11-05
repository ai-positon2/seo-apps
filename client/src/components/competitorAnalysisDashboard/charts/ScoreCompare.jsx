import { ScoreRing } from '../../../ui/ScoreRing';
import { Badge } from '../../../ui/Badge';
import { domainLabel, isUnmeasured } from '../utils';
import { ScoreLollipop } from './ScoreLollipop';

// Authority Score is a bounded 0-100 index, so it gets a gauge, not a bar.
// Gauge small multiples work up to a handful of domains; past that they
// crowd, so this auto-switches to a shared-axis lollipop. Single source of
// truth for both the Overview and Authority tabs.
const LOLLIPOP_THRESHOLD = 5;

// A domain with no Authority Score (its backlinks call failed) shows an empty
// ring and "not measured", never a 0.
export function ScoreCompare({ domains = [], valueFn = (d) => d.authorityScore }) {
  if (!domains.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>No data yet.</div>;
  }

  if (domains.length >= LOLLIPOP_THRESHOLD) {
    return <ScoreLollipop domains={domains} valueFn={valueFn} />;
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, justifyContent: domains.length <= 1 ? 'flex-start' : 'space-around' }}>
      {domains.map((d) => (
        <div key={d.domain} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ padding: 4, borderRadius: '50%', boxShadow: d.isClient ? '0 0 0 2px var(--primary)' : 'none' }}>
            <ScoreRing score={isUnmeasured(valueFn(d)) ? undefined : Number(valueFn(d))} size={80} />
          </div>
          {isUnmeasured(valueFn(d)) && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>not measured</span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: 150 }}>
            <span style={{
              fontSize: 12, fontWeight: d.isClient ? 700 : 400,
              color: d.isClient ? 'var(--text)' : 'var(--text-2)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {domainLabel(d)}
            </span>
            {d.isClient && <Badge variant="brand" style={{ flexShrink: 0 }}>Client</Badge>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default ScoreCompare;
