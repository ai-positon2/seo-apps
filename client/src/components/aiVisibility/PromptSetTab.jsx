import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, useToast } from '../../ui';
import { aiVisibilityApi } from '../../lib/aiVisibilityApi';
import { CrawledPagePicker } from './CrawledPagePicker';
import { RunMeasurementButton } from './RunMeasurementButton';
import { QuestionRow } from './QuestionRow';
import { card, muted } from './promptHelpers';

// ── The questions this client is measured on ────────────────────────────────
//
// Three sections, ordered by what needs attention: what is waiting for you,
// what is being measured, and how to add more. Nothing else.
//
// It used to be five cards: a topic x intent coverage matrix, an evidence
// panel reporting what generation would ground on, a bare add form, the draft
// queue, and an "active set" that silently included removed questions whenever
// a checkbox was ticked. Four different controls created a question and two of
// them called the same endpoint without saying so. All of that is gone.

const SECTION_TITLE = {
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  margin: 0,
  fontWeight: 600,
};

export function PromptSetTab({ project }) {
  const toast = useToast();
  const [showRemoved, setShowRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async () => {
    if (!project) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const status = showRemoved
        ? ['draft', 'approved', 'retired']
        : ['draft', 'approved'];
      const data = await aiVisibilityApi.prompts(project.id, { status });
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [project?.id, showRemoved]);

  useEffect(() => { load(); }, [load]);

  /** Every write goes through here: no optimism, one place to report failure. */
  const act = useCallback(async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.add({ title: ok, variant: 'success' });
      await load();
    } catch (e) {
      toast.add({ title: 'That did not work', description: e.message, variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [load, toast]);

  if (!project) return null;
  if (state.loading && !state.data) {
    return <div style={{ ...card, marginTop: 16 }}><div style={muted}>Loading…</div></div>;
  }
  if (state.error) {
    return (
      <div style={{ ...card, marginTop: 16, borderColor: 'var(--danger)' }}>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{state.error.message}</div>
      </div>
    );
  }

  const { data } = state;
  const prompts = data.prompts || [];
  const waiting = prompts.filter((p) => p.status === 'draft');
  const asking = prompts.filter((p) => p.status === 'approved');
  const removed = prompts.filter((p) => p.status === 'retired');
  const limit = data.coverage?.limit ?? data.coverage?.quota ?? 20;
  const removedCount = data.counts?.retired ?? 0;

  const edit = (id, patch) => act(
    () => aiVisibilityApi.updatePrompt(project.id, id, patch),
    'Updated — still being measured.',
  );

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── 1. Waiting for you ─────────────────────────────────────────── */}
      {waiting.length > 0 && (
        <div style={{ ...card, borderColor: 'var(--warning)' }}>
          <Header
            title="Waiting for you"
            right={(
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act(
                  () => aiVisibilityApi.approveMany(project.id, {
                    promptIds: waiting.map((p) => p.id),
                  }),
                  `${waiting.length} question${waiting.length === 1 ? '' : 's'} approved`,
                )}
              >
                Approve all {waiting.length}
              </Button>
            )}
          />
          <div style={{ ...muted, marginBottom: 4 }}>
            {waiting.length} question{waiting.length === 1 ? '' : 's'} written from the pages
            you picked. Nothing is measured until you approve.
          </div>
          {waiting.map((p) => (
            <QuestionRow
              key={p.id}
              prompt={p}
              busy={busy}
              onEdit={edit}
              onApprove={(id) => act(
                () => aiVisibilityApi.setStatus(project.id, id, 'approved'),
                'Approved',
              )}
              onRemove={(id) => act(
                () => aiVisibilityApi.setStatus(
                  project.id, id, 'rejected', 'Removed from the review list.',
                ),
                'Removed',
              )}
            />
          ))}
        </div>
      )}

      {/* ── 2. Questions we ask ────────────────────────────────────────── */}
      <div style={card}>
        <Header
          title="Questions we ask"
          right={(
            <RunMeasurementButton
              project={project}
              approvedCount={asking.length}
              draftCount={waiting.length}
              budget={limit}
              onFinished={load}
            />
          )}
        />
        {asking.length > 0 && (
          <div style={{ ...muted, marginBottom: 4 }}>
            {asking.length} of {limit} · asked on ChatGPT and Gemini every time you measure.
          </div>
        )}

        {!asking.length ? (
          <EmptyState
            title="No questions yet"
            description={waiting.length
              ? 'Approve the questions above to start measuring them.'
              : 'Add questions below — pick the pages you want to be found for, and each one gets a question it should win.'}
          />
        ) : asking.map((p) => (
          <QuestionRow
            key={p.id}
            prompt={p}
            busy={busy}
            onEdit={edit}
            onRemove={(id) => act(
              () => aiVisibilityApi.retire(project.id, id),
              'Removed — it will not appear in your reports.',
            )}
          />
        ))}
      </div>

      {/* ── 3. Add questions ───────────────────────────────────────────── */}
      <div style={card}>
        <Header title="Add questions" />
        <CrawledPagePicker
          project={project}
          budget={Math.max(0, limit - asking.length)}
          onGenerated={load}
        />
        <AddByHand
          busy={busy}
          onAdd={(text) => act(
            () => aiVisibilityApi.addPrompts(project.id, [{ text }]),
            'Added — it is waiting for you above.',
          )}
        />
      </div>

      {/* ── Removed, out of the way ────────────────────────────────────── */}
      {removedCount > 0 && (
        <div style={card}>
          <button
            type="button"
            onClick={() => setShowRemoved((v) => !v)}
            style={{
              ...muted,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {showRemoved ? 'Hide' : 'Show'} {removedCount} removed question
            {removedCount === 1 ? '' : 's'}
          </button>
          {showRemoved && (
            <div style={{ marginTop: 8 }}>
              <div style={{ ...muted, marginBottom: 4 }}>
                These are not measured and do not appear in any report.
              </div>
              {removed.map((p) => (
                <QuestionRow
                  key={p.id}
                  prompt={p}
                  busy={busy}
                  onEdit={edit}
                  onRemove={(id) => act(
                    () => aiVisibilityApi.restore(project.id, id),
                    'Put back — it will be measured again.',
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ title, right = null }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 8,
    }}
    >
      <h3 style={SECTION_TITLE}>{title}</h3>
      {right}
    </div>
  );
}

/**
 * The second way in, for a question no page covers. Deliberately one field:
 * the old form also asked for a slot and a topic, which are things the system
 * should work out, not things a person should have to answer in order to type
 * a sentence.
 */
function AddByHand({ onAdd, busy }) {
  const [text, setText] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    onAdd(t);
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Or write one yourself — e.g. best emergency dentist in boston"
        style={{
          flex: 1,
          font: 'inherit',
          fontSize: 13,
          color: 'var(--text)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '7px 10px',
        }}
      />
      <Button size="sm" variant="ghost" type="submit" disabled={busy || !text.trim()}>
        Add
      </Button>
    </form>
  );
}

export default PromptSetTab;
