import { useEffect, useMemo, useState } from 'react';
import { SectionHeader } from '../ui/SectionHeader';
import { ALL_TOOLS } from '../toolsMeta';

async function req(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

const TOOL_LABEL = Object.fromEntries(ALL_TOOLS.map(t => [t.id, t.label]));
// A few tools save runs under an id that isn't in toolsMeta.js (e.g. the
// "Enhance Existing Article" tool's internal id is article-enhancement,
// which IS in toolsMeta — this just future-proofs any id that drifts).
function toolLabel(id) {
  return TOOL_LABEL[id] || id;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// input/output shapes vary a lot per tool — this renders any long string
// value as a readable text block and falls back to raw JSON for the rest,
// rather than hand-building a bespoke viewer for each of the ten tools.
function ValueBlock({ label, value }) {
  if (value == null || value === '') return null;
  const isLongText = typeof value === 'string' && value.length > 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}
      </div>
      {isLongText ? (
        <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
          {value}
        </div>
      ) : (
        <pre style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, overflowX: 'auto', margin: 0 }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function RunOutput({ output }) {
  if (!output || typeof output !== 'object') return <ValueBlock label="Result" value={output} />;
  const textFields = ['brief', 'enhancedText', 'reportMarkdown', 'recommendations'];
  const shown = new Set();
  const blocks = [];
  for (const key of textFields) {
    if (typeof output[key] === 'string' && output[key].trim()) {
      blocks.push(<ValueBlock key={key} label={key.replace(/([A-Z])/g, ' $1')} value={output[key]} />);
      shown.add(key);
    }
  }
  // Look one level deeper for the same known text fields (e.g. output.enhanced.text-ish nesting).
  const rest = Object.fromEntries(Object.entries(output).filter(([k]) => !shown.has(k)));
  return (
    <>
      {blocks}
      <ValueBlock label="Full result (JSON)" value={rest} />
    </>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const toolOptions = useMemo(() => {
    const ids = Array.from(new Set(runs.map(r => r.tool_id)));
    return ids.sort((a, b) => toolLabel(a).localeCompare(toolLabel(b)));
  }, [runs]);

  function loadRuns() {
    setLoading(true);
    setError('');
    const qs = toolFilter ? `?tool=${encodeURIComponent(toolFilter)}` : '';
    return req(`/api/runs${qs}`)
      .then(d => setRuns(d.runs || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadRuns(); }, [toolFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  function openRun(id) {
    setSelectedId(id);
    setSelectedRun(null);
    setDetailLoading(true);
    req(`/api/runs/${id}`)
      .then(d => setSelectedRun(d.run))
      .catch(e => setError(e.message))
      .finally(() => setDetailLoading(false));
  }

  async function deleteRun(id, e) {
    e.stopPropagation();
    if (!window.confirm('Delete this run? This cannot be undone.')) return;
    try {
      await req(`/api/runs/${id}`, { method: 'DELETE' });
      setRuns(prev => prev.filter(r => r.id !== id));
      if (selectedId === id) { setSelectedId(null); setSelectedRun(null); }
    } catch (e) { setError(e.message); }
  }

  return (
    <div style={{ padding: '28px 32px 48px' }}>
      <SectionHeader title="My Runs" subtitle="Every completed run you've generated, saved to your account." />

      {error && (
        <div style={{ fontSize: 12, color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <select
          value={toolFilter}
          onChange={e => setToolFilter(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
        >
          <option value="">All tools</option>
          {toolOptions.map(id => <option key={id} value={id}>{toolLabel(id)}</option>)}
        </select>
        {!loading && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{runs.length} run{runs.length === 1 ? '' : 's'}</span>}
      </div>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {loading && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
          {!loading && !runs.length && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No runs saved yet. Run any tool and it'll show up here.</div>
          )}
          {runs.map(run => (
            <div
              key={run.id}
              onClick={() => openRun(run.id)}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${selectedId === run.id ? 'var(--primary)' : 'var(--border)'}`,
                background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 4,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  {toolLabel(run.tool_id)}
                </span>
                <button
                  onClick={e => deleteRun(run.id, e)}
                  title="Delete run"
                  style={{ fontSize: 11, color: '#f87171', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  Delete
                </button>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.title || 'Untitled run'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{formatDate(run.created_at)}</div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedId && (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Select a run on the left to see its full input and output.</div>
          )}
          {selectedId && detailLoading && <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading run…</div>}
          {selectedId && !detailLoading && selectedRun && (
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{selectedRun.title || 'Untitled run'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
                {toolLabel(selectedRun.tool_id)} · {formatDate(selectedRun.created_at)}
              </div>
              <ValueBlock label="Input" value={selectedRun.input} />
              <RunOutput output={selectedRun.output} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
