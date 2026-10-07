// ── One glyph per audit module ───────────────────────────────────────────────
//
// The dashboard cards used to be identified by their label alone, in a grid of
// six otherwise identical rectangles. A mark per module gives the grid something
// scannable: after a week with the page you find AI Visibility by its target
// rather than by reading three labels.
//
// Deliberately drawn from the same 24×24, 1.6-stroke family as the sidebar's
// tool icons, so a module on this page and the same module in the nav are
// recognisably the same thing. The stroke takes `currentColor`, which is set by
// the card from the module's status tone — so the mark carries the state too.

const PATHS = {
  technical: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  seo_geo: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c3 3.2 3 13.8 0 17" />
    </>
  ),
  agent_readiness: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3.5" />
      <path d="M12 3.5V7" />
      <circle cx="9" cy="13" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  ai_visibility: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  // The API module carries the card on the dashboard, so it needs the same
  // icon: it is the same concentric-rings mark because it answers the same
  // question. Without an entry under its own key the card renders blank.
  ai_visibility_lite: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
    </>
  ),
  hub_spoke: (
    <>
      <path d="M6.5 6.5h11M6.5 6.5 12 17.5 17.5 6.5" />
      <circle cx="6.5" cy="6.5" r="2.2" />
      <circle cx="17.5" cy="6.5" r="2.2" />
      <circle cx="12" cy="17.5" r="2.2" />
    </>
  ),
  competitor: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M6.5 20.5V13M12 20.5V6.5M17.5 20.5V10" />
    </>
  ),
};

// A module key this file has never heard of still gets a mark rather than an
// empty tile: a new module should look unfamiliar, not broken.
const FALLBACK = (
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M8 12h8" />
  </>
);

// ── What each module checks, in the reader's words ──────────────────────────
//
// The module labels ("Hub and Spoke", "AI Visibility (scraped)") are product
// names, which is right on the card that links to that tool and wrong in a
// sentence written to an executive: "AI Visibility (scraped) not run yet" names
// an implementation, "AI search check not run yet" names what is missing. Kept
// beside the icons because both are keyed the same way and both are how Home
// presents a module rather than what the module is.
const PLAIN_NAME = {
  technical: 'Site health',
  hub_spoke: 'Content structure',
  competitor: 'Competitor comparison',
  seo_geo: 'Search readiness',
  on_page: 'Page content',
  // Two modules, one question — so one name, and a list built from both says it once.
  ai_visibility: 'AI search',
  ai_visibility_lite: 'AI search',
  agent_readiness: 'AI agent access',
};

/** "Content structure" for hub_spoke; the module's own label for anything unmapped. */
export function plainModuleName(module) {
  return PLAIN_NAME[module?.key] || module?.label || 'This';
}

export default function ModuleIcon({ moduleKey, size = 24 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {PATHS[moduleKey] || FALLBACK}
    </svg>
  );
}
