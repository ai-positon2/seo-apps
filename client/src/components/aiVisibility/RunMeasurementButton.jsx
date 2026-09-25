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

// A run that has not reached a terminal state yet. `queued` belongs here: the
// server puts this module on the worker queue rather than running it inside the
// request, so the run this click creates is `queued` until a worker claims it —
// seconds later, or longer if one is busy. Treating that as finished is exactly
// what made a click report "Measuring finished" the instant it landed.
const IN_FLIGHT = ['queued', 'running'];

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
  const [state, setState] = useState('idle'); // idle | starting | running | stale
  const [elapsed, setElapsed] = useState(0); // whole minutes since the click
  const cancelled = useRef(false);

  // Cleared on the way IN as well as set on the way out.
  //
  // React StrictMode mounts, unmounts and remounts every component once in
  // development, so the cleanup latched this to true before anybody could click
  // and nothing ever cleared it. The poll loop below is guarded on it, so it fell
  // out on its first check and the button sat disabled on “Measuring…” for good:
  // the run started and finished normally on the server, but nothing here ever
  // saw it finish, re-enabled the button, or reloaded the questions.
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // What this click actually costs, stated before it is clicked. Two surfaces
  // run in parallel, so wall clock is roughly one capture per prompt, plus
  // Gemini's rest after every fifth.
  const measured = Math.min(approvedCount, budget || approvedCount);
  const captures = measured * 2;
  const geminiRests = Math.floor(measured / 5) * 2;
  const minutes = Math.max(1, Math.round((measured * 26 + geminiRests * 60) / 60));

  // Follows a run until the module stops reporting queued/running. Shared by a
  // click and by arriving on the screen while a run is already going.
  async function follow(startedAt) {
    setState('running');
    setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 60000)));
    const deadline = startedAt + DEADLINE_MS;
    while (Date.now() < deadline && !cancelled.current) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      if (cancelled.current) return;
      // The only render between the click and the finish. Without it the line
      // beside the button reads “just started” for the whole run.
      setElapsed(Math.round((Date.now() - startedAt) / 60000));
      let overview;
      try {
        // eslint-disable-next-line no-await-in-loop
        overview = await projectsApi.overview(project.id);
      } catch {
        continue; // a dropped poll is not a failed run
      }
      const still = (overview.modules || [])
        .some((m) => m.key === 'ai_visibility' && IN_FLIGHT.includes(m.status));
      if (!still) {
        if (!cancelled.current) {
          toast.add({ title: 'Measuring finished', variant: 'success' });
          setState('idle');
          await onFinished?.();
        }
        return;
      }
    }
    // Past the deadline the run is still reported in flight: say so rather than
    // silently offering "Measure" again as if nothing were running.
    if (!cancelled.current) setState('stale');
  }

  // The run lives on the server, not in this button. Leaving the screen and
  // coming back used to show "Measure" again while a run of up to 40 minutes
  // was still going — inviting a second, paid run. Ask the server on arrival.
  useEffect(() => {
    if (!project?.id) return;
    let alive = true;
    (async () => {
      try {
        const overview = await projectsApi.overview(project.id);
        const mod = (overview.modules || []).find((m) => m.key === 'ai_visibility');
        if (!alive || cancelled.current || !mod || !IN_FLIGHT.includes(mod.status)) return;
        const since = Date.parse(mod.lastRun?.startedAt || mod.lastRun?.createdAt || mod.updatedAt || '');
        follow(Number.isFinite(since) ? since : Date.now());
      } catch { /* the button still works; it just cannot say a run is going */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  async function run() {
    setState('starting');
    try {
      const { run: started } = await projectsApi.runModule(project.id, 'ai_visibility');
      if (!IN_FLIGHT.includes(started?.status)) {
        toast.add({ title: 'Measuring finished', variant: 'success' });
        setState('idle');
        await onFinished?.();
        return;
      }
      toast.add({
        title: `Measuring ${measured} question${measured === 1 ? '' : 's'}`,
        description: `About ${minutes} minute(s). You can leave this screen — it keeps going.`,
        variant: 'success',
      });
      await follow(Date.now());
    } catch (e) {
      toast.add({ title: 'Could not start measuring', description: e.message, variant: 'danger' });
      setState('idle');
    }
  }

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
            : state === 'stale'
              ? 'The last measurement is taking longer than expected. Check Run history before starting another.'
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
        loading={state === 'starting' || state === 'running'}
        disabled={state === 'starting' || state === 'running'}
        onClick={run}
      >
        {state === 'running' ? 'Measuring…' : `Measure ${measured} question${measured === 1 ? '' : 's'}`}
      </Button>
    </div>
  );
}

export default RunMeasurementButton;
