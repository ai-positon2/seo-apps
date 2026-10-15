// Shared by the popover and tooltip triggers, so the two modes draw the same
// "i" and treat a click on it the same way.

/** The trigger's class list. */
export function dotClass(tone) {
  return `explain-dot${tone === 'onAccent' ? ' explain-dot--on-accent' : ''}`;
}

/**
 * Keeps the click on the icon. Some icons sit on a card whose whole surface is
 * a link (ModuleCard) or inside a clickable header; without this, opening the
 * explanation would also navigate away from the thing being explained.
 */
export function keepClick(e) {
  e.preventDefault();
  e.stopPropagation();
}
