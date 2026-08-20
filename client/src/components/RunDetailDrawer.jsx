import { useEffect, useState } from 'react';
import { Badge, Drawer } from '../ui';
import { fetchRun, formatDuration, STATUS_VARIANT, toolLabel, actionLabel } from '../lib/runsApi';

// One run, in full: the summary the list already had plus the sanitized input
// and output, fetched on open. Shared by /runs and the per-module run panels so
// a run reads the same wherever it was clicked.

function JsonBlock({ value, truncated, emptyText }) {
  if (value === null || value === undefined) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{emptyText}</div>;
  }
  return (
    <>
      <pre style={{
        margin: 0, padding: 12, borderRadius: 8, background: 'var(--surface)',
        border: '1px solid var(--border)', fontSize: 11, lineHeight: 1.5,
        color: 'var(--text-2)', overflowX: 'auto', maxHeight: 320,
      }}>
        {JSON.stringify(value, null, 2)}
      </pre>
      {truncated && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
          Shortened — large payloads are summarized rather than stored in full.
        </div>
      )}
    </>
  );
}

function DetailRow({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: 110, flexShrink: 0, fontSize: 12, color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text)', wordBreak: 'break-word', flex: 1 }}>{children}</div>
    </div>
  );
}

/**
 * RunDetailDrawer
 * @param {object|null} run — the list row that was clicked; null closes the drawer
 * @param {function} onClose
 * @param {string} workspaceName — shown as the run's workspace, when known
 */
export default function RunDetailDrawer({ run, onClose, workspaceName }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!run) return;
    let live = true;
    setDetail(null);
    setError('');
    fetchRun(run.id)
      .then(d => { if (live) setDetail(d.run); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [run?.id]);

  const action = run ? actionLabel(run.action) : '';

  return (
    <Drawer
      open={Boolean(run)}
      onClose={onClose}
      title={run ? `${toolLabel(run.tool_id)}${action ? ` · ${action}` : ''}` : ''}
      width={560}
    >
      {run && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <DetailRow label="Status">
              <Badge variant={STATUS_VARIANT[run.status] || 'neutral'}>{run.status}</Badge>
            </DetailRow>
            <DetailRow label="Ran on">{run.label || '—'}</DetailRow>
            <DetailRow label="Who">{run.actor_email || 'unknown'}</DetailRow>
            {workspaceName && <DetailRow label="Workspace">{workspaceName}</DetailRow>}
            <DetailRow label="Started">{new Date(run.created_at).toLocaleString()}</DetailRow>
            <DetailRow label="Finished">
              {run.completed_at ? new Date(run.completed_at).toLocaleString() : 'still running'}
            </DetailRow>
            <DetailRow label="Duration">{formatDuration(run.duration_ms)}</DetailRow>
            {run.error && (
              <DetailRow label="Error">
                <span style={{ color: 'var(--danger)' }}>{run.error}</span>
              </DetailRow>
            )}
          </div>

          {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Input</div>
            {detail
              ? <JsonBlock value={detail.input} truncated={detail.input_truncated} emptyText="No input recorded." />
              : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Output</div>
            {detail
              ? <JsonBlock value={detail.output} truncated={detail.output_truncated} emptyText="No output recorded." />
              : <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
          </div>

          {(run.request_method || run.request_path) && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Request: {run.request_method} {run.request_path}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
