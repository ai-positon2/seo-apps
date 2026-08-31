import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card, Button, Badge, useToast,
} from '../../ui';
import { aiVisibilityApi } from '../../lib/aiVisibilityApi';
import { muted } from './promptHelpers';

// ── Choose pages, get questions ─────────────────────────────────────────────
//
// The main way questions get written. One row per crawled URL, selectable;
// each page picked becomes one question that page should win. That anchoring
// is what makes a miss actionable — "you have a root canal page and no engine
// names you for root canal questions" is a sentence someone can act on.
//
// Reading the list is free. Only writing questions spends, and the button
// says so.
//
// This WAITS for the work to finish before telling the caller to reload. It
// used to fire the request and reload immediately, which raced the background
// job every time: the questions were not written yet, the list came back
// unchanged, and the whole feature looked broken.

const GROUP_ORDER = [
  'Treatments & services', 'Conditions & advice', 'Homepage',
  'Locations & offers', 'Our dentists', 'About & press', 'Other pages',
];

const GROUP_NOTE = {
  'Treatments & services': 'Billable work — a miss here costs money directly.',
  'Conditions & advice': 'Symptom-led questions, where people arrive before they know what they need.',
  'Our dentists': 'Rarely how a stranger searches, but a real answer to “who would I see”.',
  'About & press': 'Credibility signals. Worth measuring only if reputation is the question.',
};

const POLL_MS = 2_500;
const POLL_DEADLINE_MS = 5 * 60 * 1000;

/**
 * Waits for the detached generation run to reach a terminal state.
 *
 * Returns 'done' | 'failed' | 'timeout'. A dropped poll is not a failed run —
 * the network blipping should not make a person think their questions were
 * lost — so a rejected request simply tries again until the deadline.
 */
async function waitForGeneration(projectId) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, POLL_MS); });
    let run = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const body = await aiVisibilityApi.generation(projectId);
      run = body?.run || null;
    } catch {
      continue;
    }
    if (!run || run.status === 'running' || run.status === 'queued') continue;
    return run.status === 'failed' ? 'failed' : 'done';
  }
  return 'timeout';
}

const pathOf = (url) => {
  try { return new URL(url).pathname; } catch { return url; }
};

export function CrawledPagePicker({ project, budget = 20, onGenerated }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [chosen, setChosen] = useState(() => new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ loading: false, error: null, data: await aiVisibilityApi.topics(project.id) });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const topics = state.data?.topics || [];
    const byGroup = new Map();
    for (const t of topics) {
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group).push(t);
    }
    const order = GROUP_ORDER.filter((g) => byGroup.has(g))
      .concat([...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)));
    return order.map((g) => [g, byGroup.get(g)]);
  }, [state.data]);

  function toggle(url) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < budget) next.add(url);
      return next;
    });
  }

  async function generate() {
    const count = chosen.size;
    setBusy(true);
    try {
      await aiVisibilityApi.generate(project.id, { urls: [...chosen] });
      toast.add({
        title: `Writing ${count} question${count === 1 ? '' : 's'}…`,
        description: 'One per page chosen. This takes a few seconds per page.',
        variant: 'success',
      });
      setChosen(new Set());

      // The job is detached on the server, so the 202 means "started", not
      // "finished". Reloading here would show the list exactly as it was.
      const outcome = await waitForGeneration(project.id);
      if (outcome === 'timeout') {
        toast.add({
          title: 'Still writing',
          description: 'This is taking longer than usual. Reload in a moment to see them.',
          variant: 'warning',
        });
      } else if (outcome === 'failed') {
        toast.add({
          title: 'Could not write the questions',
          description: 'The run did not finish. Nothing was changed.',
          variant: 'danger',
        });
      }
      await load();
      onGenerated?.();
    } catch (e) {
      toast.add({ title: 'Could not start', description: e.message, variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  if (state.loading && !state.data) {
    return <Card title="From your pages"><div style={muted}>Reading the crawl…</div></Card>;
  }
  if (state.error) {
    return (
      <Card title="From your pages">
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{state.error.message}</div>
      </Card>
    );
  }

  const { total = 0, coveredCount = 0 } = state.data || {};
  if (!total) {
    return (
      <Card title="From your pages">
        <div style={muted}>
          No crawled pages for this client yet. Run a crawl and they appear here to
          choose from.
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="From your pages"
      actions={(
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {chosen.size > 0 && (
            <span className="num" style={{ fontSize: 12, color: 'var(--primary-text)' }}>
              {chosen.size} chosen
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide pages' : 'Choose pages'}
          </Button>
          {chosen.size > 0 && (
            <Button size="sm" loading={busy} onClick={generate}>
              {busy ? 'Writing…' : `Write ${chosen.size} question${chosen.size === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      )}
      style={{ marginTop: 16 }}
    >
      <div style={muted}>
        {total} page{total === 1 ? '' : 's'} crawled.
        {coveredCount > 0 && ` ${coveredCount} already ${coveredCount === 1 ? 'has' : 'have'} a question.`}
        {' '}Pick the pages worth measuring and each becomes one question — tied to that page,
        so a miss tells you which page is losing.
      </div>

      {open && (
        <div style={{ marginTop: 16, maxHeight: 460, overflowY: 'auto', paddingRight: 4 }}>
          {grouped.map(([group, rows]) => (
            <div key={group} style={{ marginBottom: 18 }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 8,
                borderBottom: '1px solid var(--border)', paddingBottom: 5, marginBottom: 6,
              }}
              >
                <span
                  className="eyebrow"
                  style={{
                    fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.16em',
                    color: 'var(--text-3)', textTransform: 'uppercase', flex: 1,
                  }}
                >
                  {group}
                </span>
                <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{rows.length}</span>
              </div>

              {GROUP_NOTE[group] && (
                <div style={{ ...muted, marginBottom: 6 }}>{GROUP_NOTE[group]}</div>
              )}

              {rows.map((t) => {
                const on = chosen.has(t.targetUrl);
                const atLimit = !on && chosen.size >= budget;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(t.targetUrl)}
                    disabled={atLimit}
                    aria-pressed={on}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                      textAlign: 'left', padding: '7px 9px', marginBottom: 2,
                      borderRadius: 'var(--r-md)',
                      border: `1px solid ${on ? 'var(--primary)' : 'transparent'}`,
                      background: on ? 'var(--primary-soft)' : 'transparent',
                      cursor: atLimit ? 'not-allowed' : 'pointer',
                      opacity: atLimit ? 0.45 : 1,
                    }}
                  >
                    <span style={{
                      flex: 'none', width: 15, height: 15, borderRadius: 4,
                      border: `1.5px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                      background: on ? 'var(--primary)' : 'transparent',
                    }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        display: 'block', fontSize: 13, color: 'var(--text)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                      >
                        {t.label}
                      </span>
                      <span
                        className="num"
                        style={{
                          display: 'block', fontSize: 11, color: 'var(--text-3)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {pathOf(t.targetUrl)}
                      </span>
                    </span>
                    {t.covered && <Badge variant="neutral">has a question</Badge>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {open && chosen.size >= budget && (
        <div style={{ ...muted, marginTop: 8, color: 'var(--warning)' }}>
          That is all the room left under this client&apos;s question limit. Remove one to
          choose a different page.
        </div>
      )}
    </Card>
  );
}

export default CrawledPagePicker;
