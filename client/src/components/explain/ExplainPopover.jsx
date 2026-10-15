import { useEffect, useId, useRef } from 'react';
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

function Block({ label, children }) {
  return (
    <div className="explain-block">
      <span className="explain-label">{label}</span>
      <span className="explain-value">{children}</span>
    </div>
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
              <Block label="Why it matters">{e.why}</Block>
              <Block label="What good looks like">{e.good}</Block>
              <div className="explain-block explain-calc">
                <span className="explain-label">How it’s calculated</span>
                <span className="explain-value">{e.calc}</span>
                {calcExtra && <div className="explain-calc__extra">{calcExtra}</div>}
              </div>
              <Block label="Suggested next step">{e.next.label}</Block>
            </div>

            <div className="explain-popover__foot">
              <span className="explain-src">{e.src}</span>
              {linkPath && (
                <Link to={linkPath} className="explain-next" onClick={() => setOpenKey(null)}>
                  Open {SCREENS[e.next.screen]} →
                </Link>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
