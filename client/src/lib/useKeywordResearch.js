// ── useKeywordResearch: one Keyword Research run, for any view ───────────────
//
// Owns the /api/keyword-research init + SSE stream and holds the run in the
// state machine from keywordResearchModel.js. The standalone page and the
// compact Content Architect panel both render from this, so a feature added to
// the pipeline shows up in both.
//
// State lives in a ref as well as in React state so that an action's next
// state is known synchronously — onResult and onSelectionChange receive exactly
// what will render, which is what a caller persisting it needs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshSemrushBalance } from './semrushBalanceStore';
import { notifyAgentRunStarted, notifyAgentRunFinished } from './agentRunSignal';
import { initialState, reduce, buildCopyTable, snapshot, selectionOf } from './keywordResearchModel';

const STREAM_EVENTS = ['step', 'seed', 'variants', 'urls', 'url_status', 'url_keywords', 'allKeywords', 'result', 'fail'];

/**
 * @param {object} opts
 * @param {string} [opts.initialKeyword]
 * @param {'commercial'|'informational'} [opts.initialIntent]
 * @param {string} [opts.client]          knowledge-base client slug, if any
 * @param {(snap: object, selection: object) => void} [opts.onResult]
 * @param {(selection: object) => void} [opts.onSelectionChange]
 */
export function useKeywordResearch({ initialKeyword = '', initialIntent = 'commercial', client = '', onResult, onSelectionChange } = {}) {
  const [state, setState] = useState(() => initialState({ keyword: initialKeyword, intent: initialIntent }));
  const stateRef = useRef(state);
  const esRef = useRef(null);
  const callbacks = useRef({ onResult, onSelectionChange });
  callbacks.current = { onResult, onSelectionChange };
  const [copied, setCopied] = useState(false);

  const apply = useCallback((action) => {
    stateRef.current = reduce(stateRef.current, action);
    setState(stateRef.current);
    return stateRef.current;
  }, []);

  const closeStream = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  useEffect(() => closeStream, [closeStream]);

  /**
   * Start a run. With `{ topic }` the server derives the seed keyword from the
   * topic first (Content Architect); otherwise the typed keyword is the seed.
   */
  const start = useCallback(async ({ topic } = {}) => {
    const cur = stateRef.current;
    if (cur.running || (!topic && !cur.keyword.trim())) return;
    closeStream();
    apply({ type: 'start' });
    notifyAgentRunStarted('keyword-research');

    try {
      const res = await fetch('/api/keyword-research/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...(topic ? { topic } : { keyword: cur.keyword.trim() }),
          intent: cur.intent,
          client: client || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start');
      }
      const { token } = await res.json();
      refreshSemrushBalance();

      const es = new EventSource(`/api/keyword-research/stream/${token}`);
      esRef.current = es;

      for (const type of STREAM_EVENTS) {
        es.addEventListener(type, (e) => {
          const next = apply({ type, data: JSON.parse(e.data) });
          if (type === 'result') {
            notifyAgentRunFinished('keyword-research', {
              keyword: next.keyword,
              intent: next.intent,
              client: client || '',
              primary: next.primary,
              secondary: next.secondary,
              warning: next.result?.warning || '',
            });
            callbacks.current.onResult?.(snapshot(next), selectionOf(next));
          }
        });
      }
      es.addEventListener('done', () => { closeStream(); apply({ type: 'done' }); });
      es.onerror = () => { closeStream(); apply({ type: 'connectionLost' }); };
    } catch (err) {
      apply({ type: 'error', message: err.message });
    }
  }, [apply, client, closeStream]);

  const reset = useCallback(() => { closeStream(); apply({ type: 'reset' }); }, [apply, closeStream]);

  // Editing actions report the new selection when it actually changed.
  const edit = useCallback((action) => {
    const before = stateRef.current;
    const next = apply(action);
    if (next.primary !== before.primary || next.secondary !== before.secondary) {
      callbacks.current.onSelectionChange?.(selectionOf(next));
    }
  }, [apply]);

  const copyTable = useCallback(async () => {
    const table = buildCopyTable(stateRef.current.primary, stateRef.current.secondary);
    if (!table) return;
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([table.tsv], { type: 'text/plain' }),
            'text/html': new Blob([table.html], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(table.tsv);
      }
      flash();
    } catch {
      try { await navigator.clipboard.writeText(table.tsv); flash(); } catch { /* clipboard unavailable */ }
    }
  }, []);

  return {
    state,
    copied,
    start,
    reset,
    copyTable,
    setKeyword: (value) => apply({ type: 'setKeyword', value }),
    setIntent: (value) => apply({ type: 'setIntent', value }),
    hydrate: (saved) => apply({ type: 'hydrate', saved }),
    removePrimary: (index) => edit({ type: 'removePrimary', index }),
    removeSecondary: (index) => edit({ type: 'removeSecondary', index }),
    addPrimary: (kw) => edit({ type: 'addPrimary', kw }),
    addSecondary: (kw) => edit({ type: 'addSecondary', kw }),
    toPrimary: (index) => edit({ type: 'toPrimary', index }),
    toSecondary: (index) => edit({ type: 'toSecondary', index }),
  };
}
