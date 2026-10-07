// ── Keyword research inside a Hub & Spoke topic card ────────────────────────
//
// Content Architect hands off a TOPIC (a suggested hub or spoke title), not a
// keyword. This is the standalone Keyword Research tool, whole, in the space of
// a card: the same hook and the same pieces (components/keywordResearch) at
// compact density. There is no seed input: "Generate keywords" sends the topic
// and the server derives the seed keyword from it (services/topicSeed.js).
//
// A finished run and the picks made from it are saved per topic
// (PUT /api/content-architect/projects/:id/clusters/:clusterId/keyword-research),
// so collapsing the row or reloading the page brings them back instead of
// asking for a second paid run.

import { useEffect, useRef, useState } from 'react';
import { useKeywordResearch } from '../../lib/useKeywordResearch';
import { ca } from '../../lib/contentArchitectApi';
import KrInputBar from '../keywordResearch/KrInputBar';
import KrTimeline from '../keywordResearch/KrTimeline';
import KrPicks, { KrWarning } from '../keywordResearch/KrPicks';
import KrSourcePool from '../keywordResearch/KrSourcePool';
import KrToolbar from '../keywordResearch/KrToolbar';
import { availableKeywords } from '../../lib/keywordResearchModel';

const SELECTION_SAVE_DELAY_MS = 600;

function savedAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * @param {object} props
 * @param {string} props.projectId
 * @param {string} props.clusterId
 * @param {string} props.topic           the suggested page title
 * @param {string} [props.client]        knowledge-base client slug, when the site matches one
 * @param {(to: string) => void} props.navigate
 * @param {object|null} [props.saved]    this topic's saved record, if any
 * @param {(record: object) => void} [props.onSaved]     every change, as it happens
 * @param {() => void} [props.onRunSaved]                a new run reached the server
 * @param {React.ReactNode} [props.aside] extra right-aligned actions (e.g. View Recommendation)
 */
export default function InlineKeywordResearch({ projectId, clusterId, topic, client = '', navigate, saved = null, onSaved, onRunSaved, aside = null }) {
  const [tab, setTab] = useState('picks');
  const [saveError, setSaveError] = useState('');
  const selectionTimer = useRef(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  function persist(body, record) {
    onSaved?.(record);
    ca.saveKeywordResearch(projectId, clusterId, body)
      .then((r) => {
        const failed = r?.saved === false && r.reason !== 'not_configured';
        setSaveError(failed ? 'Could not save this result — it will be lost on reload.' : '');
        if (!failed) onRunSaved?.();
      })
      .catch(() => setSaveError('Could not save this result — it will be lost on reload.'));
  }

  const kr = useKeywordResearch({
    initialIntent: saved?.intent || 'informational',
    client,
    onResult: (snap, selection) => {
      clearTimeout(selectionTimer.current);
      persist(
        { topic, intent: snap.intent, result: snap, selection },
        { clusterId, topic, intent: snap.intent, result: snap, selection, updatedAt: new Date().toISOString() },
      );
    },
    onSelectionChange: (selection) => {
      const current = savedRef.current;
      if (current) onSaved?.({ ...current, selection, updatedAt: new Date().toISOString() });
      clearTimeout(selectionTimer.current);
      selectionTimer.current = setTimeout(() => {
        ca.saveKeywordResearch(projectId, clusterId, { topic, selection }).catch(() => {});
      }, SELECTION_SAVE_DELAY_MS);
    },
  });
  const { state } = kr;

  // Bring back a saved run — when the panel mounts with one, or when the
  // cluster's saved runs finish loading after it mounted.
  useEffect(() => {
    if (saved?.result && !state.started) kr.hydrate(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  useEffect(() => () => clearTimeout(selectionTimer.current), []);

  const generate = () => { setTab('picks'); setSaveError(''); kr.start({ topic }); };

  const asideNode = (
    <>
      {saved?.updatedAt && !state.running && state.result && (
        <span style={{ fontSize: 12, color: 'var(--text-3)' }} title={new Date(saved.updatedAt).toLocaleString()}>
          Saved {savedAgo(saved.updatedAt)}
        </span>
      )}
      {aside}
    </>
  );

  if (!state.started) {
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <KrInputBar density="compact" kr={kr} onGenerate={generate} aside={aside} />
      </div>
    );
  }

  const poolCount = state.result ? availableKeywords(state).length : 0;
  const tabButton = (id, label) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        fontSize: 12, fontWeight: 600, padding: '6px 2px', marginRight: 14, background: 'none', border: 'none', cursor: 'pointer',
        color: tab === id ? 'var(--text)' : 'var(--text-3)',
        borderBottom: `2px solid ${tab === id ? 'var(--primary)' : 'transparent'}`,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ padding: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <KrInputBar density="compact" kr={kr} onGenerate={generate} aside={asideNode} />
      <KrTimeline density="compact" kr={kr} />

      {state.error && (
        <div style={{ fontSize: 12, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {state.error}
          {!state.running && (
            <button type="button" onClick={generate} style={{ fontSize: 12, color: 'var(--text-2)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
              Retry
            </button>
          )}
        </div>
      )}

      {state.result && (
        <>
          <KrWarning density="compact" warning={state.result.warning} />
          <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--card)', overflow: 'hidden' }}>
            <div role="tablist" style={{ display: 'flex', padding: '0 10px', borderBottom: '1px solid var(--border)' }}>
              {tabButton('picks', `Picks · ${state.primary.length + state.secondary.length}`)}
              {tabButton('pool', `Pool · ${poolCount}`)}
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {tab === 'picks' ? <KrPicks density="compact" kr={kr} /> : <KrSourcePool density="compact" kr={kr} />}
            </div>
          </div>
          <KrToolbar density="compact" kr={kr} client={client} navigate={navigate} origin={{ caProjectId: projectId, clusterId, topic }} />
          {saveError && <div style={{ fontSize: 12, color: 'var(--warning)' }}>{saveError}</div>}
        </>
      )}
    </div>
  );
}
