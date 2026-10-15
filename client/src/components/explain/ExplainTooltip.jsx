import { useId, useRef, useState } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { dotClass, keepClick } from './dotTrigger';

// ── The quick summary (Guided mode off) ─────────────────────────────────────
//
// Title and one line, nothing else: someone who turned Guided mode off wants a
// reminder, not a page. Opens on hover and keyboard focus. base-ui tooltips
// ignore touch, so a tap toggles it here — otherwise a phone gets no
// explanation at all.

export default function ExplainTooltip({ explainer: e, tone }) {
  const [open, setOpen] = useState(false);
  const pointerType = useRef('mouse');
  const tipId = useId();

  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger
        className={dotClass(tone)}
        aria-label={`About ${e.t}`}
        aria-describedby={open ? tipId : undefined}
        delay={0}
        closeDelay={60}
        onPointerDown={(ev) => { pointerType.current = ev.pointerType; }}
        onClick={(ev) => {
          keepClick(ev);
          if (pointerType.current === 'touch') setOpen((o) => !o);
        }}
        render={<button type="button" />}
      >
        i
      </Tooltip.Trigger>
      <Tooltip.Portal>
        {/* Flips below an icon near the top of the screen, and keeps a
            280px-wide tip on screen near either edge. */}
        <Tooltip.Positioner
          className="explain-positioner explain-positioner--tip"
          side="top"
          sideOffset={8}
          collisionPadding={{ top: 90, right: 12, bottom: 12, left: 12 }}
        >
          <Tooltip.Popup id={tipId} className="explain-tooltip">
            <span className="explain-tooltip__title">{e.t}</span>
            <span className="explain-tooltip__line">{e.s}</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
