import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../ui';
import RunDetailDrawer from './RunDetailDrawer';
import { EMBED_MODE } from './MacWindow';
import { useProjectNames, humanRunLabel } from '../lib/runLabel';
import {
  fetchRuns, fetchRunStats, runsPageHref, groupRunsByDay,
  formatClock, formatDuration, actionLabel, STATUS_VARIANT,
} from '../lib/runsApi';

// ── This module's runs, on the module's own page ─────────────────────────────
// The /runs page answers "what has this workspace been doing?"; this panel
// answers the question you actually have while standing in a tool: "what did we
// last run here, on what, and did it work?" Same data (/api/runs), scoped to one
// tool and shown newest-first grouped by day.
//
// Notes on the shape of this thing:
//   • It never becomes a fault. With no run history configured at all (no
//     Supabase → 503) the panel removes itself rather than putting an error box
//     in the middle of a working tool; a workspace with nothing recorded yet
//     gets one line saying so, so the panel is discoverable before the first run.
//   • It refreshes itself, so a run the user just started shows up without a
//     reload and lands here even when the work finishes elsewhere (several
//     modules return before their work is done — on-page audit, robots monitor,
//     competitor tracker — and their rows sit at 'running' for minutes). Polled
//     every 5s while a run is in flight, 15s otherwise, and whenever the tab
//     comes back to the foreground. Nothing in the module has to notify it.
//   • Embeds see nothing: platform-embed sessions share one synthetic workspace,
//     so a public embed must not list other people's runs.

const POLL_IDLE_MS = 15_000;
const POLL_ACTIVE_MS = 5_000;

// Collapsed-or-not is remembered per panel, not per tool: a tool can carry two
// panels (the Location Page Builder list and one page's own runs) and folding
// one away shouldn't fold the other.
function collapseKey(toolId, action, scoped) {
  return `moduleRuns.collapsed.${toolId}${action ? `:${action}` : ''}${scoped ? ':scoped' : ''}`;
}

function readCollapsed(key) {
  try { return window.localStorage.getItem(key) === '1'; } catch (e) { return false; }
}

function writeCollapsed(key, collapsed) {
  try { window.localStorage.setItem(key, collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
}

const Chevron = ({ open }) => (
  <svg
    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s var(--ease)' }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

function SegButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11, fontWeight: 600, padding: '4px 9px', cursor: 'pointer',
        border: 'none', background: active ? 'var(--card)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-3)',
        boxShadow: active ? 'var(--shadow-sm)' : 'none',
        borderRadius: 6,
      }}
    >
      {children}
    </button>
  );
}

function StatsLine({ stats, days }) {
  if (!stats || !stats.total) return null;
  const bits = [
    `${stats.total} run${stats.total === 1 ? '' : 's'} in the last ${days} days`,
  ];
  if (stats.completed) bits.push(`${stats.completed} completed`);
  if (stats.failed) bits.push(`${stats.failed} failed`);
  if (stats.cancelled) bits.push(`${stats.cancelled} cancelled`);
  if (Number.isFinite(stats.avgDurationMs)) bits.push(`avg ${formatDuration(stats.avgDurationMs)}`);
  return (
    <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '0 16px 10px' }}>
      {bits.join(' · ')}
    </div>
  );
}

function RunRow({ run, isMine, scoped, hideActionPill, onOpen }) {
  const [hovered, setHovered] = useState(false);
  const action = actionLabel(run.action);
  const projectNames = useProjectNames();
  // On a panel already scoped to one thing (a location page, a tracked client)
  // every row carries the same label, so what the run *was* becomes the useful
  // primary text and the label is dropped from the row.
  const primary = scoped ? (action || 'run') : humanRunLabel(run.label, projectNames);
  const showActionPill = Boolean(action) && !scoped && !hideActionPill;
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={run.error || run.label || ''}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(52px, auto) minmax(0, 1fr) minmax(0, auto) 92px 66px',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '9px 16px',
        border: 'none',
        borderTop: '1px solid var(--border)',
        background: hovered ? 'var(--surface)' : 'transparent',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
        {formatClock(run.created_at)}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 12.5, color: primary ? 'var(--text)' : 'var(--text-3)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {primary || 'no input recorded'}
          </span>
          {showActionPill && (
            <span style={{
              flexShrink: 0, fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.04em', padding: '1px 6px', borderRadius: 4,
              background: 'var(--surface-2)', color: 'var(--text-3)',
            }}>
              {action}
            </span>
          )}
        </span>
        {/* Why it failed, without having to open the run first. */}
        {run.status === 'failed' && run.error && (
          <span style={{
            fontSize: 11, color: 'var(--danger)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {run.error}
          </span>
        )}
      </span>

      <span style={{
        fontSize: 11, color: 'var(--text-3)', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {isMine ? 'you' : (run.actor_email || 'unknown')}
      </span>

      <span>
        <Badge variant={STATUS_VARIANT[run.status] || 'neutral'}>{run.status}</Badge>
      </span>

      <span style={{
        fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', textAlign: 'right',
      }}>
        {run.status === 'running' ? '…' : formatDuration(run.duration_ms)}
      </span>
    </button>
  );
}

/**
 * ModuleRuns — run history for one tool, shown on that tool's page.
 *
 * @param {string} toolId      tool id as recorded in tool_runs (server/config/runTracking.js)
 * @param {string} title       panel heading (default 'Recent runs')
 * @param {string} search      optional label filter, for pages scoped to one
 *                             thing (a location page, a tracked client) — the
 *                             run label is matched, e.g. `page <id>`
 * @param {string} scopeNote   short line explaining a scoped panel
 * @param {string} action      optional action filter ('export', 'run', …)
 * @param {number} pageSize    rows per page (default 6)
 * @param {object} style       extra styles for the panel wrapper
 */
export default function ModuleRuns({
  toolId,
  title = 'Recent runs',
  search = '',
  scopeNote = '',
  action = '',
  pageSize = 6,
  style: extraStyle,
}) {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [workspace, setWorkspace] = useState(null);
  const [viewerUserId, setViewerUserId] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsDays, setStatsDays] = useState(30);

  const [mine, setMine] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  const collapseStorageKey = collapseKey(toolId, action, Boolean(search));
  const [collapsed, setCollapsed] = useState(() => readCollapsed(collapseStorageKey));

  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  // Kept in a ref so the poll interval doesn't have to be torn down and rebuilt
  // every time a fetch lands.
  const loadRef = useRef(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const data = await fetchRuns({ toolId, search, action, mine, limit, offset: 0 });
      setRuns(data.runs || []);
      setTotal(data.total || 0);
      setWorkspace(data.workspace || null);
      setViewerUserId(data.viewerUserId || null);
      setUnavailable(false);
      setError('');
    } catch (e) {
      // A tool page is not the place to surface an infrastructure problem —
      // 503 (no Supabase) hides the panel, anything else shows one quiet line.
      if (e.unavailable) setUnavailable(true);
      else setError(e.message);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [toolId, search, action, mine, limit]);

  loadRef.current = load;

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // The rollup counts every run of the tool, so it would contradict a panel
    // scoped to one page/client — only shown when the panel shows the whole tool.
    if (collapsed || search) return;
    let live = true;
    fetchRunStats({ days: 30, toolId })
      .then(data => {
        if (!live) return;
        setStatsDays(data.days || 30);
        setStats((data.tools || []).find(t => t.toolId === toolId) || null);
      })
      .catch(() => { if (live) setStats(null); });
    return () => { live = false; };
  }, [toolId, search, collapsed, runs.length]);

  const hasRunning = useMemo(() => runs.some(r => r.status === 'running'), [runs]);

  // Poll while visible: fast when something is in flight, slow otherwise.
  useEffect(() => {
    if (collapsed || unavailable) return;
    const period = hasRunning ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadRef.current?.({ quiet: true });
    }, period);
    return () => clearInterval(id);
  }, [collapsed, unavailable, hasRunning]);

  // Coming back to the tab after a run finished elsewhere should show it,
  // without waiting out the poll interval.
  useEffect(() => {
    if (collapsed || unavailable) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') loadRef.current?.({ quiet: true });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [collapsed, unavailable]);

  function toggleCollapsed() {
    setCollapsed(c => { writeCollapsed(collapseStorageKey, !c); return !c; });
  }

  // Public embeds share one synthetic workspace — never list runs there.
  if (EMBED_MODE || unavailable) return null;
  // Before the first response, render nothing rather than a box that flashes
  // empty and then fills in.
  if (!loaded) return null;

  const groups = groupRunsByDay(runs);
  const hasMore = runs.length < total;
  const runningCount = runs.filter(r => r.status === 'running').length;

  return (
    <section style={{
      marginTop: 32,
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
      ...extraStyle,
    }}>
      <style>{`@keyframes moduleRunsPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px',
      }}>
        <button
          type="button"
          onClick={toggleCollapsed}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, background: 'none',
            border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)',
          }}
        >
          <span style={{ color: 'var(--text-3)', display: 'flex' }}><Chevron open={!collapsed} /></span>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
          {total > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-3)',
              background: 'var(--surface)', borderRadius: 'var(--r-pill)', padding: '1px 7px',
            }}>
              {total}
            </span>
          )}
        </button>

        {runningCount > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
            color: 'var(--info)', animation: 'moduleRunsPulse 1.6s var(--ease) infinite',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--info)' }} />
            {runningCount} running
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {!collapsed && (
            <div style={{
              display: 'flex', gap: 2, padding: 2, borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--border)',
            }}>
              <SegButton active={!mine} onClick={() => { setMine(false); setLimit(pageSize); }}>Everyone</SegButton>
              <SegButton active={mine} onClick={() => { setMine(true); setLimit(pageSize); }}>Just me</SegButton>
            </div>
          )}
          {!collapsed && (
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              style={{
                fontSize: 11, fontWeight: 600, color: 'var(--text-2)', background: 'none',
                border: '1px solid var(--border)', borderRadius: 6, padding: '4px 9px',
                cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          <Link
            to={runsPageHref({ toolId, search, mine })}
            style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary-text)', textDecoration: 'none' }}
          >
            View all →
          </Link>
        </div>
      </div>

      {!collapsed && (
        <>
          {(workspace?.name || scopeNote) && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '0 16px 8px' }}>
              {scopeNote && <span>{scopeNote}</span>}
              {scopeNote && workspace?.name && <span> · </span>}
              {workspace?.name && <span>Workspace: {workspace.name}</span>}
            </div>
          )}

          <StatsLine stats={stats} days={statsDays} />

          {error && (
            <div style={{ fontSize: 11, color: 'var(--danger)', padding: '0 16px 10px' }}>{error}</div>
          )}

          {!runs.length ? (
            // An error already said why the list is empty — don't follow it with
            // "nothing has been run yet", which would be a different claim.
            !error && (
              <div style={{
                fontSize: 12, color: 'var(--text-3)', padding: '14px 16px',
                borderTop: '1px solid var(--border)',
              }}>
                {loading
                  ? 'Loading…'
                  : mine
                    ? 'You haven’t run this tool yet — your runs will show up here.'
                    : 'No runs recorded yet. Run this tool and it will show up here.'}
              </div>
            )
          ) : (
            groups.map(group => (
              <div key={group.heading}>
                <div style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-3)',
                  background: 'var(--surface)', padding: '5px 16px',
                  borderTop: '1px solid var(--border)',
                }}>
                  {group.heading}
                </div>
                {group.runs.map(run => (
                  <RunRow
                    key={run.id}
                    run={run}
                    isMine={Boolean(viewerUserId && run.user_id === viewerUserId)}
                    scoped={Boolean(search)}
                    hideActionPill={Boolean(action)}
                    onOpen={setSelected}
                  />
                ))}
              </div>
            ))
          )}

          {hasMore && (
            <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', textAlign: 'center' }}>
              <button
                type="button"
                onClick={() => setLimit(l => l + pageSize)}
                disabled={loading}
                style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--text-2)', background: 'none',
                  border: '1px solid var(--border)', borderRadius: 6, padding: '5px 12px',
                  cursor: 'pointer',
                }}
              >
                Show {Math.min(pageSize, total - runs.length)} more
              </button>
            </div>
          )}
        </>
      )}

      <RunDetailDrawer
        run={selected}
        onClose={() => setSelected(null)}
        workspaceName={workspace?.name}
      />
    </section>
  );
}
