// ── Analysis in progress ─────────────────────────────────────────────────────
//
// A new project starts its modules on its own — the crawl, the homepage audits,
// Competitor Research, AI Visibility — and for the first several minutes the
// dashboard had nothing to say about that. This answers "is anything happening,
// what, and how long" as one picture: the modules as stations on a single line
// that fills as each finishes. Finished modules sit first, so the filled part of
// the line IS the progress — there is no second bar to reconcile with it.
//
// Everything here is read from the overview the dashboard already loads; it
// adds no request. It renders nothing once no module is queued or running.

import ModuleIcon from './moduleIcons';

const DONE = new Set(['completed', 'completed_with_errors']);

/**
 * One module's step: what it is doing now, in a word the line can draw.
 *
 * `crawlLive`: a module that needs a completed crawl (`dependsOn`, overview.js)
 * and has nothing yet is WAITING while the crawl runs — not done. Hub and Spoke
 * runs once before the crawl finishes, records "insufficient data", and runs
 * again by itself when the crawl completes; that first result read as "Done".
 */
export function stepState(module, { crawlLive = false } = {}) {
  if (crawlLive && module.dependsOn && ['insufficient_data', 'not_run'].includes(module.status)) {
    return 'waiting';
  }
  if (module.status === 'running') {
    // A page audit following a crawl that has not started yet is waiting, not
    // working (overview.evidenceCard words it this way).
    return /^Waiting for the crawl/i.test(module.headline || '') ? 'waiting' : 'running';
  }
  if (module.status === 'queued') return 'queued';
  if (DONE.has(module.status)) return 'done';
  // Ran, found nothing to measure: finished, but not a result.
  if (module.status === 'insufficient_data') return 'nodata';
  if (module.status === 'failed') return 'failed';
  if (module.status === 'needs_setup') return 'action';
  return 'idle';
}

const STEP = {
  done: { label: 'Done', color: 'var(--primary-text, var(--primary))' },
  nodata: { label: 'No data', color: 'var(--text-3)' },
  running: { label: 'Analyzing', color: 'var(--primary-text, var(--primary))' },
  queued: { label: 'Queued', color: 'var(--text-3)' },
  waiting: { label: 'After the crawl', color: 'var(--viz-warn)' },
  failed: { label: 'Failed', color: 'var(--viz-neg)' },
  action: { label: 'Needs input', color: 'var(--viz-warn)' },
  idle: { label: 'Not started', color: 'var(--text-3)' },
};

// Finished first, then what is working, then what is still in line — so the
// line fills left to right however the modules happen to finish.
const ORDER = { done: 0, nodata: 1, action: 2, failed: 3, running: 4, queued: 5, waiting: 6, idle: 7 };
const FINISHED = new Set(['done', 'nodata', 'action', 'failed']);

const isNewProject = (createdAt) => {
  const t = Date.parse(createdAt || '');
  return Number.isFinite(t) && Date.now() - t < 6 * 60 * 60 * 1000;
};

export default function AnalysisProgress({ modules = [], projectName, createdAt, crawlLive = false }) {
  const steps = modules
    .map((m, i) => ({ module: m, state: stepState(m, { crawlLive }), i }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.i - b.i);
  const active = steps.some((s) => ['running', 'queued', 'waiting'].includes(s.state)) || crawlLive;
  if (!active) return null;

  // Modules that are part of this analysis; one that will not run on its own
  // ("Not started") would otherwise hold the count short forever.
  const counted = steps.filter((s) => s.state !== 'idle');
  const finished = counted.filter((s) => FINISHED.has(s.state)).length;
  const total = counted.length || steps.length;
  const fresh = isNewProject(createdAt);
  const n = steps.length;
  // The fill reaches the last finished station, and half-way on to the next
  // one when something is working — the line is visibly moving toward it.
  const working = steps[finished] && steps[finished].state === 'running';
  const fillTo = n > 1 ? Math.max(0, Math.min(1, (finished - 1 + (working ? 0.5 : 0)) / (n - 1))) : 0;

  return (
    <section
      aria-label="Analysis progress"
      style={{
        position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 22,
        padding: '22px 26px 20px', borderRadius: 16,
        border: '1px solid color-mix(in srgb, var(--primary) 22%, var(--border))',
        background: 'linear-gradient(120deg, color-mix(in srgb, var(--primary) 9%, var(--card)) 0%, var(--card) 55%)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* Heading: what is happening and how long, with the count on the right. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 380px' }}>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 10.5, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--primary-text, var(--primary))',
            }}
          >
            <span className="ap-live-dot" aria-hidden="true" />
            {fresh ? 'Setting up' : 'Updating'}
          </span>
          <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
            {fresh ? `Analyzing ${projectName || 'your project'}` : 'Analysis in progress'}
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            {fresh
              ? 'Usually 5–15 minutes, longer for a large site · results fill in on their own — feel free to leave this page'
              : 'Cards update on their own as each module finishes'}
          </span>
        </div>
        <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
          <span className="num" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1, color: 'var(--text)' }}>{finished}</span>
          <span className="num" style={{ fontSize: 15, color: 'var(--text-3)' }}>/{total}</span>
          <span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 4 }}>finished</span>
        </span>
      </div>

      {/* The line: stations on one track. */}
      {/* Horizontal on a wide screen; on a narrow one index.css turns the same
          markup into a vertical line, one module per row. */}
      <div className="ap-line" style={{ position: 'relative' }}>
        <div className="ap-track" aria-hidden="true" style={{ position: 'absolute', left: `${50 / n}%`, right: `${50 / n}%`, top: 21, height: 4, borderRadius: 999, background: 'var(--border)' }}>
          <div className="ap-track-fill" style={{ height: '100%', width: `${fillTo * 100}%`, borderRadius: 999 }} />
        </div>
        <ol className="ap-stations" style={{ position: 'relative', listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gap: 6 }}>
          {steps.map(({ module, state }, idx) => (
            <li key={module.key} className={`ap-station${idx < finished ? ' ap-station-done' : ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0, textAlign: 'center' }}>
              <Station state={state} moduleKey={module.key} />
              <span className="ap-station-text" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, maxWidth: '100%' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {module.label}
                </span>
                <span style={{ fontSize: 11.5, color: STEP[state].color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {state === 'running' && module.key === 'technical' && /\d[\d,]*\s+pages?/i.test(module.headline || '')
                    ? `${module.headline.match(/\d[\d,]*\s+pages?/i)[0]} crawled`
                    : STEP[state].label}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A ring that turns: work in progress. Used by the module cards' status tags. */
export function Spinner({ size = 16, color = 'var(--primary)' }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      style={{ flexShrink: 0, animation: 'spin 0.9s linear infinite' }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--border)" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// One station: the module's own mark, dressed by its state, with a small badge
// for the states a glance should catch.
function Station({ state, moduleKey }) {
  const done = state === 'done';
  const running = state === 'running';
  const waiting = state === 'waiting';
  const muted = ['queued', 'idle', 'nodata'].includes(state);
  const tone = state === 'failed' ? 'var(--viz-neg)' : state === 'action' ? 'var(--viz-warn)' : 'var(--primary)';

  return (
    <span style={{ position: 'relative', width: 46, height: 46, flexShrink: 0 }}>
      {running && <span className="ap-orbit" aria-hidden="true" />}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 3, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: done ? 'var(--primary)' : running ? 'var(--card)' : 'var(--surface-2)',
          color: done ? 'var(--text-on-primary)' : running ? 'var(--primary)' : waiting ? 'var(--viz-warn)' : muted ? 'var(--text-3)' : tone,
          border: waiting ? '1.5px dashed var(--viz-warn)' : (done || running) ? 'none' : '1px solid var(--border)',
          boxShadow: done ? '0 4px 12px color-mix(in srgb, var(--primary) 35%, transparent)' : 'none',
          opacity: state === 'idle' ? 0.55 : 1,
        }}
      >
        <span style={{ display: 'inline-flex', transform: 'scale(0.85)' }}><ModuleIcon moduleKey={moduleKey} /></span>
      </span>
      <Badge state={state} />
    </span>
  );
}

function Badge({ state }) {
  const base = {
    position: 'absolute', right: -1, bottom: -1, width: 18, height: 18, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800,
    border: '2px solid var(--card)', lineHeight: 1, boxSizing: 'border-box',
  };
  if (state === 'done') return <span aria-hidden="true" style={{ ...base, background: 'var(--card)', color: 'var(--primary)', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>✓</span>;
  if (state === 'failed') return <span aria-hidden="true" style={{ ...base, background: 'var(--viz-neg)', color: '#fff' }}>!</span>;
  if (state === 'action') return <span aria-hidden="true" style={{ ...base, background: 'var(--viz-warn)', color: '#fff' }}>!</span>;
  if (state === 'nodata') return <span aria-hidden="true" style={{ ...base, background: 'var(--text-3)', color: 'var(--card)' }}>–</span>;
  if (state === 'queued') {
    return (
      <span aria-hidden="true" style={{ ...base, background: 'var(--surface-2)', color: 'var(--text-3)' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </span>
    );
  }
  if (state === 'waiting') {
    return (
      <span aria-hidden="true" style={{ ...base, background: 'var(--viz-warn)', color: '#fff' }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9" /></svg>
      </span>
    );
  }
  return null;
}
