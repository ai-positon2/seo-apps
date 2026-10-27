import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover } from '@base-ui/react/popover';
import { useGuidedMode } from './GuidedModeContext';
import { SCREENS, nextRoute } from './explainScreens';
import { dotClass, keepClick } from './dotTrigger';

// ── The full explanation (Guided mode on) ───────────────────────────────────
//
// base-ui does the dialog semantics, focus in and back out, Esc and outside
// press. What it cannot know about, and is done here:
//   • one popover app-wide — the open id lives in GuidedModeContext;
//   • closing on scroll — a fixed panel left hovering while the box it
//     explains scrolls away reads as an explanation of something else;
//   • the outline on the box being explained, so it is clear what the
//     popover is about once it covers part of the screen.

const FACT_ICONS = {
  why: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>,
  good: <><circle cx="12" cy="12" r="8.5" /><path d="M8 12.5l2.7 2.7L16.5 9.5" /></>,
};

/** One short labelled fact with an icon — "Why it matters", "Good looks like". */
function Fact({ icon, label, children }) {
  return (
    <div className={`explain-fact explain-fact--${icon}`}>
      <svg className="explain-fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        {FACT_ICONS[icon]}
      </svg>
      <div className="explain-fact__text">
        <span className="explain-label">{label}</span>
        <span className="explain-value">{children}</span>
      </div>
    </div>
  );
}

/**
 * The calculation as short steps rather than a paragraph: one sentence per
 * line, the first three shown and the rest a click away.
 */
export function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const STEPS_SHOWN = 3;

function Steps({ text }) {
  const [all, setAll] = useState(false);
  if (typeof text !== 'string') return <span className="explain-value">{text}</span>;
  const steps = splitSentences(text);
  if (steps.length <= 1) return <span className="explain-value">{text}</span>;
  const shown = all ? steps : steps.slice(0, STEPS_SHOWN);
  return (
    <>
      <ol className="explain-steps">
        {shown.map((t) => <li key={t}>{t}</li>)}
      </ol>
      {steps.length > STEPS_SHOWN && (
        <button type="button" className="explain-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `${steps.length - STEPS_SHOWN} more`}
        </button>
      )}
    </>
  );
}

/**
 * What this run measured. A live breakdown (a React node) is shown as it is —
 * it is the visual part. A sentence ("This run: …") mostly restates the
 * calculation in the server's words, so it is folded away.
 */
function RunDetails({ children }) {
  if (typeof children !== 'string') return <div className="explain-calc__extra">{children}</div>;
  const text = children.replace(/^This run:\s*/, '');
  return (
    <details className="explain-run">
      <summary>This run’s details</summary>
      <span>{text.charAt(0).toUpperCase() + text.slice(1)}</span>
    </details>
  );
}

export default function ExplainPopover({ explainer: e, ctx, tone, calcExtra }) {
  const { openKey, setOpenKey } = useGuidedMode();
  const id = useId();
  const open = openKey === id;
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const box = triggerRef.current?.closest('[data-explain-box]');
    box?.classList.add('explain-box--active');
    return () => box?.classList.remove('explain-box--active');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onScroll = (ev) => {
      if (popupRef.current && ev.target instanceof Node && popupRef.current.contains(ev.target)) return;
      setOpenKey((cur) => (cur === id ? null : cur));
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [open, id, setOpenKey]);

  const linkPath = e.next.screen ? nextRoute(e.next.screen, ctx || {}) : null;

  return (
    <Popover.Root
      open={open}
      // Opening another icon closes this one through the context; this only has
      // to release the id when base-ui closes it (Esc, ×, outside press).
      onOpenChange={(next) => setOpenKey((cur) => (next ? id : (cur === id ? null : cur)))}
    >
      <Popover.Trigger
        ref={triggerRef}
        className={dotClass(tone)}
        aria-label={`About ${e.t}`}
        onClick={keepClick}
      >
        i
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="explain-positioner"
          side="bottom"
          align="start"
          alignOffset={-18}
          sideOffset={10}
          collisionPadding={12}
        >
          <Popover.Popup ref={popupRef} className="explain-popover" initialFocus={closeRef}>
            <div className="explain-popover__head">
              <div className="explain-popover__row">
                <span className="explain-kicker">{SCREENS[e.screen]}</span>
                <Popover.Close ref={closeRef} className="explain-close" aria-label="Close">×</Popover.Close>
              </div>
              <Popover.Title className="explain-popover__title">{e.t}</Popover.Title>
              <Popover.Description className="explain-popover__lead">{e.s}</Popover.Description>
            </div>

            <div className="explain-popover__body">
              <div className="explain-facts">
                <Fact icon="why" label="Why it matters">{e.why}</Fact>
                <Fact icon="good" label="What good looks like">{e.good}</Fact>
              </div>
              <div className="explain-calc">
                <span className="explain-label">How it’s calculated</span>
                <Steps text={e.calc} />
                {calcExtra && <RunDetails>{calcExtra}</RunDetails>}
              </div>
            </div>

            {/* The next step is the way out: a link when it has somewhere to go. */}
            <div className="explain-popover__foot">
              {linkPath ? (
                <Link to={linkPath} className="explain-next" onClick={() => setOpenKey(null)}>
                  <span>{e.next.label}</span>
                  <span aria-hidden="true" className="explain-next__arrow">→</span>
                </Link>
              ) : (
                <span className="explain-next explain-next--static">{e.next.label}</span>
              )}
              {e.src && <span className="explain-src">Source · {e.src}</span>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
