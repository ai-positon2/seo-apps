import { useEffect, useRef, useState } from 'react';
import { Button, useToast } from '../../ui';
import { projectsApi } from '../../lib/projectsApi';
import { muted } from './promptHelpers';

// ── Measure the questions ───────────────────────────────────────────────────
//
// Sits beside the questions because that is where the decision is made:
// somebody has just finished approving and the next thing they want is to
// measure. Sending them to the dashboard to find a card is a detour through a
// screen that answers a different question.
//
// The word is MEASURE, here and in every toast this fires. The dashboard cards
// say "Run" because that is the dashboard's word for every module; inside this
// module one action has one name.
//
// The run is DETACHED on the server — a real measurement is minutes, not
// seconds — so this starts it, then polls the overview until the module stops
// reporting `running`, the same shape HomePage uses. Without the poll the
// button would go quiet and look broken while the work was still going.

const POLL_MS = 8_000;
const DEADLINE_MS = 40 * 60 * 1000;

/**
 * @param {object} props
 * @param {object} props.project
 * @param {number} props.approvedCount
 * @param {number} props.budget
 * @param {Function} [props.onFinished]
 */
export function RunMeasurementButton({
  project, approvedCount, draftCount = 0, budget, onFinished,
}) {
  const toast = useToast();
  const [state, setState] = useState('idle'); // idle | starting | running
  const [startedAt, setStartedAt] = useState(null);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  // What this click actually costs, stated before it is clicked. Two surfaces
  // run in parallel, so wall clock is roughly one capture per prompt, plus
  // Gemini's rest after every fifth.
  const measured = Math.min(approvedCount, budget || approvedCount);
  const captures = measured * 2;
  const geminiRests = Math.floor(measured / 5) * 2;
  const minutes = Math.max(1, Math.round((measured * 26 + geminiRests * 60) / 60));

  async function run() {
    setState('starting');
    try {
      const { run: started } = await projectsApi.runModule(project.id, 'ai_visibility');
      if (started?.status !== 'running') {
        toast.add({ title: 'Measuring finished', variant: 'success' });
        setState('idle');
        await onFinished?.();
        return;
      }

      setState('running');
      setStartedAt(Date.now());
      toast.add({
        title: `Measuring ${measured} question${measured === 1 ? '' : 's'}`,
        description: `About ${minutes} minute(s). You can leave this screen — it keeps going.`,
        variant: 'success',
      });

      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline && !cancelled.current) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, POLL_MS); });
        let overview;
        try {
          // eslint-disable-next-line no-await-in-loop
          overview = await projectsApi.overview(project.id);
        } catch {
          continue; // a dropped poll is not a failed run
        }
        const still = (overview.modules || [])
          .some((m) => m.key === 'ai_visibility' && m.status === 'running');
        if (!still) {
          if (!cancelled.current) {
            toast.add({ title: 'Measuring finished', variant: 'success' });
            setState('idle');
            await onFinished?.();
          }
          return;
        }
      }
      if (!cancelled.current) setState('idle');
    } catch (e) {
      toast.add({ title: 'Could not start measuring', description: e.message, variant: 'danger' });
      setState('idle');
    }
  }

  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 60000) : 0;

  if (!approvedCount) {
    return (
      <span style={{ ...muted }}>
        {draftCount
          ? `Approve a question above to measure it.`
          : 'Add a question below to get started.'}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
        <span style={muted}>
          {state === 'running'
            ? `Measuring… ${elapsed ? `${elapsed} min so far` : 'just started'}`
            : `${captures} captures across ChatGPT and Gemini · about ${minutes} min`}
        </span>
{/* The commonest confusion on this screen: questions awaiting approval sit
            right above a button that measures only the approved ones, and the
            result comes back looking like it ignored the new ones. Say it here,
            where the click happens. */}
        {draftCount > 0 && state === 'idle' && (
          <span style={{ ...muted, color: 'var(--warning)' }}>
            {draftCount} waiting above {draftCount === 1 ? 'is' : 'are'} not included — approve
            {draftCount === 1 ? ' it' : ' them'} first
          </span>
        )}
      </span>
      <Button
        size="sm"
        loading={state !== 'idle'}
        disabled={state !== 'idle'}
        onClick={run}
      >
        {state === 'running' ? 'Measuring…' : `Measure ${measured} question${measured === 1 ? '' : 's'}`}
      </Button>
    </div>
  );
}

export default RunMeasurementButton;
