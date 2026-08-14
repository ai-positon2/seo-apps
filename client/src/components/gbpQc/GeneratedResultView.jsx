import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';

export default function GeneratedResultView({ result, location, onExport, exporting, onCopy }) {
  const sections = result.sections_included || [];
  const notes = result.customization_notes || [];
  const fullPost = result.full_post || '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Generated Post</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>Location: {location}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Badge variant={result.within_limit ? 'success' : 'danger'}>
              {result.character_count} chars {result.within_limit ? '— OK' : '— OVER LIMIT'}
            </Badge>
            <Button variant="secondary" onClick={onExport} loading={exporting}>Export Excel</Button>
          </div>
        </div>
      </Card>

      {sections.length > 0 && (
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: 4 }}>Sections:</span>
            {sections.map((s) => <Badge key={s} variant="info">{s}</Badge>)}
          </div>
        </Card>
      )}

      <Card
        title="Generated Post — Ready to Use"
        actions={<Button variant="ghost" size="sm" onClick={() => onCopy(fullPost)}>Copy Post</Button>}
      >
        <pre style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          padding: 16, fontSize: 13, lineHeight: 1.7, color: 'var(--text-2)', whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0,
        }}>
          {fullPost}
        </pre>
      </Card>

      {notes.length > 0 && (
        <Card title="Customization Notes">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {notes.map((note, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-3)' }}>
                <span>—</span>{note}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
