import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SectionHeader, DataTable, Badge, EmptyState, Button, MetricCard } from '../ui';
import RunDetailDrawer from '../components/RunDetailDrawer';
import { useProjectNames, humanRunLabel } from '../lib/runLabel';
import {
  fetchRuns, fetchRunStats, toolLabel, formatDuration, formatWhen, STATUS_VARIANT,
} from '../lib/runsApi';

// Run history for the active workspace. Every module records its runs through
// server/middleware/runTracking.js; this reads them back via /api/runs.
//
// Runs are workspace-scoped, and a workspace belongs to a primary user (its
// creator/owner) — so the header always says whose workspace is being shown,
// and switching workspaces (Workspaces page) switches what lands here.
//
// Each module's page shows the same runs filtered to that tool (see
// components/ModuleRuns.jsx); its "View all" link arrives here with ?tool= (and
// optionally ?q= / ?mine=1) so the filters open on the same set of runs.

const PAGE_SIZE = 50;

const selectStyle = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 12,
};

export default function RunsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [workspace, setWorkspace] = useState(null);
  const [trackedTools, setTrackedTools] = useState([]);
  const [viewerUserId, setViewerUserId] = useState(null);
  const [stats, setStats] = useState(null);

  // Initial filters come from the URL, so a module's "View all" link opens
  // pre-filtered to that tool.
  const [toolId, setToolId] = useState(params.get('tool') || '');
  const [status, setStatus] = useState(params.get('status') || '');
  const [mine, setMine] = useState(params.get('mine') === '1');
  const [search, setSearch] = useState(params.get('q') || '');
  const [searchDraft, setSearchDraft] = useState(params.get('q') || '');
  const [offset, setOffset] = useState(0);
  // Bumped by Refresh so a reload re-runs `load` instead of appending a page.
  const [reloadKey, setReloadKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A direct link to one run (e.g. Content Architect's "View Recommendation")
  // opens straight to its drawer — RunDetailDrawer fetches the full row itself
  // from just an id, so nothing here needs the row to already be in `runs`.
  const [selected, setSelected] = useState(() => (params.get('runId') ? { id: params.get('runId') } : null));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchRuns({ toolId, status, mine, search, limit: PAGE_SIZE, offset });
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
  }, [toolId, status, mine, search, offset, reloadKey]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetchRunStats({ days: 30 }).then(setStats).catch(() => setStats(null));
  }, []);

  function changeFilter(setter) {
    return (value) => { setOffset(0); setter(value); };
  }

  const toolOptions = useMemo(() => {
    const ids = new Set([...(trackedTools || []), ...runs.map(r => r.tool_id)]);
    return [...ids].filter(Boolean).sort((a, b) => toolLabel(a).localeCompare(toolLabel(b)));
  }, [trackedTools, runs]);

  const projectNames = useProjectNames();

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
        <span title={value || undefined} style={{ color: value ? 'var(--text)' : 'var(--text-3)' }}>
          {humanRunLabel(value, projectNames) || '—'}
        </span>
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
            onRowClick={setSelected}
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

      <RunDetailDrawer
        run={selected}
        onClose={() => setSelected(null)}
        workspaceName={workspace?.name}
      />
    </div>
  );
}
