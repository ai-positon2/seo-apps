import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';

export default function AllLocationsView({ gen, allResults, clientName, postType, onDownload, exporting, onCopy }) {
  const entries = Object.entries(allResults);
  const withinCount = entries.filter(([, r]) => r.within_limit).length;
  const overCount = entries.filter(([, r]) => !r.within_limit).length;
  const pct = gen.total > 0 ? Math.round((gen.progress / gen.total) * 100) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Generating All Locations</div>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)' }}>{gen.progress} / {gen.total}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14 }}>
          {(clientName || '').split('(')[0].trim()} — {postType}
        </div>
        <div style={{ height: 6, background: 'var(--surface)', borderRadius: 100, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--primary)', borderRadius: 100, transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, flexWrap: 'wrap', gap: 10 }}>
          {gen.inProgress && (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
              Generating: <strong style={{ color: 'var(--text)' }}>{gen.currentLocation}</strong>
            </div>
          )}
          {gen.done && !gen.inProgress && (
            <div style={{ fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>
              All {gen.total} locations generated!
            </div>
          )}
          {gen.done && (
            <Button variant="secondary" onClick={onDownload} loading={exporting}>Download All Locations Excel</Button>
          )}
        </div>
      </Card>

      {gen.done && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <Card style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--primary-text)' }}>{gen.total}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Total Locations</div>
          </Card>
          <Card style={{ textAlign: 'center', background: 'var(--success-soft)' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{withinCount}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Within Limit</div>
          </Card>
          <Card style={{ textAlign: 'center', background: 'var(--warning-soft)' }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--warning)' }}>{overCount}</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Over Limit</div>
          </Card>
        </div>
      )}

      {entries.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Generated Posts <span style={{ fontStyle: 'italic', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(click to copy)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entries.map(([loc, res]) => (
              <div
                key={loc}
                onClick={() => onCopy(res.full_post)}
                style={{
                  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
                  overflow: 'hidden', cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{loc}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Badge variant={res.within_limit ? 'success' : 'danger'}>{res.character_count} chars</Badge>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Click to copy</span>
                  </div>
                </div>
                <div style={{ padding: '10px 14px', maxHeight: 60, overflow: 'hidden' }}>
                  <pre style={{ fontSize: 11.5, color: 'var(--text-3)', whiteSpace: 'pre-wrap', fontFamily: 'inherit', lineHeight: 1.5, margin: 0 }}>
                    {(res.full_post || '').slice(0, 200)}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
