import { useState } from 'react';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ScoreRing } from '../../ui/ScoreRing';

function statusVariant(status) {
  if (status === 'Pass') return 'success';
  if (status === 'Needs Minor Edits') return 'warning';
  return 'danger';
}

export default function QcResultView({ result, onExport, exporting, onCopy }) {
  const [showPassed, setShowPassed] = useState(false);
  const passed = result.passed_checks || [];
  const issues = result.issues_found || [];
  const fixes = result.recommended_fixes || [];
  const edited = (result.suggested_edited_version || '').trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
          <ScoreRing score={result.qc_score || 0} size={100} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <Badge variant={statusVariant(result.overall_status)} style={{ marginBottom: 8 }}>
              {result.overall_status}
            </Badge>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
              {(result.final_approval_recommendation || '').slice(0, 200)}
              {(result.final_approval_recommendation || '').length > 200 ? '…' : ''}
            </p>
          </div>
          <Button variant="secondary" onClick={onExport} loading={exporting}>Export Excel</Button>
        </div>
      </Card>

      {passed.length > 0 && (
        <Card>
          <button
            onClick={() => setShowPassed((s) => !s)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Passed Checks</span>
              <Badge variant="success">{passed.length}</Badge>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{showPassed ? 'Hide' : 'Show'}</span>
          </button>
          {showPassed && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {passed.map((check, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', gap: 8 }}>
                  <span style={{ color: 'var(--success)' }}>✓</span>{check}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {issues.length === 0 && result.overall_status === 'Pass' && (
        <div style={{ background: 'var(--success-soft)', border: '1px solid var(--success)', borderRadius: 'var(--r-lg)', padding: '14px 18px', fontSize: 13, color: 'var(--success)' }}>
          No issues found — post meets all brand guidelines.
        </div>
      )}

      {issues.length > 0 && (
        <Card title="Issues Found" actions={<Badge variant="danger">{issues.length}</Badge>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {issues.map((issue, i) => (
              <div
                key={i}
                style={{
                  background: issue.severity === 'major' ? 'var(--danger-soft)' : 'var(--warning-soft)',
                  borderLeft: `3px solid ${issue.severity === 'major' ? 'var(--danger)' : 'var(--warning)'}`,
                  borderRadius: 'var(--r-md)', padding: '12px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <Badge variant={issue.severity === 'major' ? 'danger' : 'warning'}>{issue.severity?.toUpperCase()}</Badge>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{issue.check}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{issue.issue}</div>
                    {issue.reason && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, fontStyle: 'italic' }}>
                        Guideline: {issue.reason}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {fixes.length > 0 && (
        <Card title="Recommended Fixes">
          <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
            {fixes.map((fix, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{
                  flexShrink: 0, width: 20, height: 20, background: 'var(--primary)', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff',
                }}>
                  {i + 1}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>{fix}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {edited && (
        <Card
          title="Suggested Edited Version"
          actions={<Button variant="ghost" size="sm" onClick={() => onCopy(edited)}>Copy</Button>}
        >
          <pre style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
            padding: 16, fontSize: 13, lineHeight: 1.7, color: 'var(--text-2)', whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0,
          }}>
            {edited}
          </pre>
        </Card>
      )}

      {result.final_approval_recommendation && (
        <div style={{
          background: statusVariant(result.overall_status) === 'success' ? 'var(--success-soft)' : statusVariant(result.overall_status) === 'warning' ? 'var(--warning-soft)' : 'var(--danger-soft)',
          border: `1px solid ${statusVariant(result.overall_status) === 'success' ? 'var(--success)' : statusVariant(result.overall_status) === 'warning' ? 'var(--warning)' : 'var(--danger)'}`,
          borderRadius: 'var(--r-lg)', padding: '16px 20px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Final Recommendation</div>
          <p style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>{result.final_approval_recommendation}</p>
        </div>
      )}
    </div>
  );
}
