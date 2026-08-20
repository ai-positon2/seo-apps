import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SectionHeader, DataTable, Badge, Drawer, EmptyState, Button, MetricCard } from '../ui';
import { ALL_TOOLS } from '../toolsMeta';

// Run history for the active workspace. Every module records its runs through
// server/middleware/runTracking.js; this reads them back via /api/runs.
//
// Runs are workspace-scoped, and a workspace belongs to a primary user (its
// creator/owner) — so the header always says whose workspace is being shown,
// and switching workspaces (Workspaces page) switches what lands here.

// Tools that record runs but have no card in the tool grid, so no label there.
const EXTRA_TOOL_LABELS = {
  'content-enhancement': 'Content Enhancement',
  'robots-monitor': 'Robots.txt Monitor',
  'competitor-analysis-report': 'Competitor Analysis Report',
  'knowledge-base': 'Knowledge Base',
  'content-research': 'Content Research',
};

const STATUS_VARIANT = {
  completed: 'success',
  failed: 'danger',
  running: 'info',
  cancelled: 'warning',
};

const PAGE_SIZE = 50;

function toolLabel(toolId) {
  const tool = ALL_TOOLS.find(t => t.id === toolId);
  if (tool) return tool.label;
  if (EXTRA_TOOL_LABELS[toolId]) return EXTRA_TOOL_LABELS[toolId];
  return String(toolId || '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return then.toLocaleDateString();
}

async function req(path) {
  const res = await fetch(path, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const selectStyle = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 12,
};

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

export default function RunsPage() {
  const navigate = useNavigate();

  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [workspace, setWorkspace] = useState(null);
  const [trackedTools, setTrackedTools] = useState([]);
  const [viewerUserId, setViewerUserId] = useState(null);
  const [stats, setStats] = useState(null);

  const [toolId, setToolId] = useState('');
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [offset, setOffset] = useState(0);
  // Bumped by Refresh so a reload re-runs `load` instead of appending a page.
  const [reloadKey, setReloadKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (toolId) params.set('toolId', toolId);
    if (status) params.set('status', status);
    if (mine) params.set('mine', '1');
    if (search) params.set('q', search);
    return params.toString();
  }, [toolId, status, mine, search, offset]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await req(`/api/runs?${query}`);
      // Paging appends; a filter change resets `offset` to 0 and replaces.
      setRuns(prev => (offset === 0 ? data.runs || [] : [...prev, ...(data.runs || [])]));
      setTotal(data.total || 0);
      setWorkspace(data.workspace || null);
      setTrackedTools(data.trackedTools || []);
      setViewerUserId(data.viewerUserId || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query, offset, reloadKey]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    req('/api/runs/stats?days=30').then(setStats).catch(() => setStats(null));
  }, []);

  function changeFilter(setter) {
    return (value) => { setOffset(0); setter(value); };
  }

  function openRun(row) {
    setSelected(row);
    setDetail(null);
    setDetailError('');
    req(`/api/runs/${row.id}`)
      .then(d => setDetail(d.run))
      .catch(e => setDetailError(e.message));
  }

  const toolOptions = useMemo(() => {
    const ids = new Set([...(trackedTools || []), ...runs.map(r => r.tool_id)]);
    return [...ids].filter(Boolean).sort((a, b) => toolLabel(a).localeCompare(toolLabel(b)));
  }, [trackedTools, runs]);

  // DataTable calls render(value, row) — the row is the second argument.
  const columns = [
    {
      key: 'created_at', label: 'When', width: 96,
      render: (when) => <span title={when ? new Date(when).toLocaleString() : ''}>{formatWhen(when)}</span>,
    },
    { key: 'tool_id', label: 'Tool', width: 190, render: (id) => toolLabel(id) },
    {
      key: 'action', label: 'Action', width: 110,
      render: (action) => <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{action || 'run'}</span>,
    },
    {
      key: 'label', label: 'Ran on',
      render: (value) => (
        <span style={{ color: value ? 'var(--text)' : 'var(--text-3)' }}>{value || '—'}</span>
      ),
    },
    {
      key: 'actor_email', label: 'Who', width: 190,
      render: (email, row) => (
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {email || 'unknown'}
          {row.user_id && viewerUserId && row.user_id === viewerUserId ? ' (you)' : ''}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status', width: 100,
      render: (value) => <Badge variant={STATUS_VARIANT[value] || 'neutral'}>{value}</Badge>,
    },
    {
      key: 'duration_ms', label: 'Took', width: 80, align: 'right', mono: true,
      render: (ms) => formatDuration(ms),
    },
  ];

  const hasMore = runs.length < total;

  return (
    <div style={{ padding: '28px 32px 48px' }}>
      <SectionHeader
        title="Run history"
        subtitle={
          workspace
            ? `Every run recorded in ${workspace.name}${workspace.ownerEmail ? ` · owned by ${workspace.ownerEmail}` : ''}`
            : 'Every run recorded in your active workspace.'
        }
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => navigate('/workspaces')}>Switch workspace</Button>
            <Button variant="secondary" onClick={() => { setOffset(0); setReloadKey(k => k + 1); }}>Refresh</Button>
          </div>
        }
      />

      {error && (
        <div style={{
          fontSize: 12, color: 'var(--danger)', background: 'var(--danger-soft)',
          border: '1px solid var(--danger)', borderRadius: 8, padding: '8px 10px', marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {stats?.totals && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
          <MetricCard label="Runs (30 days)" value={stats.totals.total} />
          <MetricCard label="Completed" value={stats.totals.completed} />
          <MetricCard label="Failed" value={stats.totals.failed} />
          <MetricCard label="In flight" value={stats.totals.running} />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <select value={toolId} onChange={e => changeFilter(setToolId)(e.target.value)} style={selectStyle}>
          <option value="">All tools</option>
          {toolOptions.map(id => <option key={id} value={id}>{toolLabel(id)}</option>)}
        </select>

        <select value={status} onChange={e => changeFilter(setStatus)(e.target.value)} style={selectStyle}>
          <option value="">Any status</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <form
          onSubmit={e => { e.preventDefault(); changeFilter(setSearch)(searchDraft.trim()); }}
          style={{ display: 'flex', gap: 6 }}
        >
          <input
            value={searchDraft}
            onChange={e => setSearchDraft(e.target.value)}
            placeholder="Search what it ran on…"
            style={{ ...selectStyle, width: 210 }}
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearchDraft(''); changeFilter(setSearch)(''); }}
              style={{ ...selectStyle, cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
        </form>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
          <input type="checkbox" checked={mine} onChange={e => changeFilter(setMine)(e.target.checked)} />
          Only my runs
        </label>

        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
          {total} run{total === 1 ? '' : 's'}
        </div>
      </div>

      {!loading && !runs.length ? (
        <EmptyState
          title="No runs recorded yet"
          description={
            workspace
              ? `Nothing has been run in ${workspace.name} yet. Run any tool and it will show up here.`
              : 'Run any tool and it will show up here.'
          }
          action={<Button onClick={() => navigate('/')}>Browse tools</Button>}
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={runs}
            stickyHeader
            emptyText={loading ? 'Loading…' : 'No runs match these filters'}
            onRowClick={openRun}
          />
          {hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <Button variant="secondary" disabled={loading} onClick={() => setOffset(o => o + PAGE_SIZE)}>
                {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - runs.length)} more`}
              </Button>
            </div>
          )}
        </>
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${toolLabel(selected.tool_id)} · ${selected.action || 'run'}` : ''}
        width={560}
      >
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <DetailRow label="Status">
                <Badge variant={STATUS_VARIANT[selected.status] || 'neutral'}>{selected.status}</Badge>
              </DetailRow>
              <DetailRow label="Ran on">{selected.label || '—'}</DetailRow>
              <DetailRow label="Who">{selected.actor_email || 'unknown'}</DetailRow>
              <DetailRow label="Workspace">{workspace?.name || '—'}</DetailRow>
              <DetailRow label="Started">{new Date(selected.created_at).toLocaleString()}</DetailRow>
              <DetailRow label="Finished">
                {selected.completed_at ? new Date(selected.completed_at).toLocaleString() : 'still running'}
              </DetailRow>
              <DetailRow label="Duration">{formatDuration(selected.duration_ms)}</DetailRow>
              {selected.error && (
                <DetailRow label="Error">
                  <span style={{ color: 'var(--danger)' }}>{selected.error}</span>
                </DetailRow>
              )}
            </div>

            {detailError && (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>{detailError}</div>
            )}

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

            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Request: {selected.request_method} {selected.request_path}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
