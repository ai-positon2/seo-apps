import { useEffect, useState } from 'react';
import { Badge, Drawer } from '../ui';
import { fetchRun, formatDuration, STATUS_VARIANT, toolLabel, actionLabel } from '../lib/runsApi';
import { useProjectNames, humanRunLabel } from '../lib/runLabel';
import { humanRunStatus, humanRunAction } from '../lib/humanRunLabel';
import { friendlyError, errorDetail } from '../lib/friendlyError';

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
        border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5,
        color: 'var(--text-2)', overflowX: 'auto', maxHeight: 320,
      }}>
        {JSON.stringify(value, null, 2)}
      </pre>
      {truncated && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
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
  const [error, setError] = useState(null);
  const projectNames = useProjectNames();

  useEffect(() => {
    if (!run) return;
    let live = true;
    setDetail(null);
    setError(null);
    fetchRun(run.id)
      .then(d => { if (live) setDetail(d.run); })
      .catch(e => { if (live) setError(e); });
    return () => { live = false; };
  }, [run?.id]);

  const action = run && actionLabel(run.action) ? humanRunAction(run.action) : '';
  const runErrorDetail = run?.error ? errorDetail(run.error) : null;

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
              <Badge variant={STATUS_VARIANT[run.status] || 'neutral'}>{humanRunStatus(run.status)}</Badge>
            </DetailRow>
            <DetailRow label="Ran on">{humanRunLabel(run.label, projectNames) || '—'}</DetailRow>
            <DetailRow label="Who">{run.actor_email || 'unknown'}</DetailRow>
            {workspaceName && <DetailRow label="Workspace">{workspaceName}</DetailRow>}
            <DetailRow label="Started">{new Date(run.created_at).toLocaleString()}</DetailRow>
            <DetailRow label="Finished">
              {run.completed_at ? new Date(run.completed_at).toLocaleString() : 'still running'}
            </DetailRow>
            <DetailRow label="Duration">{formatDuration(run.duration_ms)}</DetailRow>
            {run.error && (
              <DetailRow label="What went wrong">
                <span style={{ color: 'var(--danger)' }}>{friendlyError(run.error)}</span>
                {runErrorDetail && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-3)' }}>Show details</summary>
                    <div style={{ color: 'var(--text-3)', marginTop: 4 }}>{runErrorDetail}</div>
                  </details>
                )}
              </DetailRow>
            )}
          </div>

          {/* The raw request and response are for troubleshooting, not for
              reading, so they sit behind a disclosure instead of filling the
              drawer. A failed fetch says so rather than "Loading…" forever. */}
          <details>
            <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', cursor: 'pointer' }}>
              Technical details (for troubleshooting)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 12 }}>
              {error && (
                <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                  Could not load this run’s details. {friendlyError(error)}
                  {errorDetail(error) && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--text-3)' }}>Show details</summary>
                      <div style={{ color: 'var(--text-3)', marginTop: 4 }}>{errorDetail(error)}</div>
                    </details>
                  )}
                </div>
              )}
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Input</div>
                {detail
                  ? <JsonBlock value={detail.input} truncated={detail.input_truncated} emptyText="No input recorded." />
                  : !error && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Output</div>
                {detail
                  ? <JsonBlock value={detail.output} truncated={detail.output_truncated} emptyText="No output recorded." />
                  : !error && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
              </div>

              {(run.request_method || run.request_path) && (
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  Request: {run.request_method} {run.request_path}
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </Drawer>
  );
}
