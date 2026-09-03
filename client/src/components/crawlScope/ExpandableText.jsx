// A line-clamped block of text that never traps content a reader can't get
// to: it always carries the full text as a hover title, AND — when the text
// is long enough that a 2-line clamp would plausibly cut it — a "Show more"
// toggle that expands it in place. Reused everywhere a catalog description
// gets clamped (issue cards, site-level findings, the SEO snapshot's quadrant
// items), so all three read the same way and none of them silently hide text
// with no way to read the rest.
//
// The length check is a proxy, not a real overflow measurement (that needs a
// ref + ResizeObserver for zero payoff here) — catalog descriptions are
// short prose, and a card is a few hundred px wide, so anything past ~100
// characters is a safe bet to actually be clamping at 2 lines.
import { useState } from 'react';

const LIKELY_CLAMPED_LENGTH = 100;

export default function ExpandableText({ text, lines = 2, style }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const mightClamp = text.length > LIKELY_CLAMPED_LENGTH;

  return (
    <div style={style}>
      <div
        title={!expanded && mightClamp ? text : undefined}
        style={expanded ? undefined : {
          display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {text}
      </div>
      {mightClamp && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          style={{
            marginTop: 2, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 11, fontWeight: 600, color: 'var(--primary-text, var(--primary))',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
