import { useEffect, useState } from 'react';

// ── The client's own mark, next to their name ────────────────────────────────
//
// A dashboard about one company should look like it is about that company. The
// favicon does that for free and is the one piece of their brand the app can use
// without asking anyone for an asset.
//
// Fetched from the site itself rather than through a favicon service. A service
// would be more reliable, but it would also mean every client domain this agency
// works on is sent to a third party on every page load, which is not a trade the
// user agreed to for a 20-pixel image.
//
// Sites disagree about where the icon lives, so the candidates are tried in turn
// and the monogram is what shows when none of them answers. That is the common
// case, not the exception — a fallback that looked broken would be worse than no
// favicon at all.

const CANDIDATES = (origin) => [
  `${origin}/favicon.ico`,
  `${origin}/favicon.png`,
  `${origin}/apple-touch-icon.png`,
];

export default function SiteFavicon({ origin, name, size = 40 }) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);

  // A new client resets the search; without this the second project inherits the
  // first one's exhausted candidate list and never shows an icon.
  useEffect(() => {
    setIndex(0);
    setFailed(false);
  }, [origin]);

  const monogram = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  const candidates = origin ? CANDIDATES(origin) : [];
  const showMonogram = failed || !origin || index >= candidates.length;

  const frame = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
  };

  if (showMonogram) {
    return (
      <div style={{ ...frame, background: 'var(--accent-800)' }} aria-hidden="true">
        <span
          style={{
            fontSize: size * 0.42,
            fontWeight: 600,
            color: 'var(--accent-100)',
            lineHeight: 1,
            userSelect: 'none',
          }}
        >
          {monogram}
        </span>
      </div>
    );
  }

  return (
    <div style={frame}>
      <img
        src={candidates[index]}
        alt=""
        aria-hidden="true"
        width={size - 12}
        height={size - 12}
        style={{ objectFit: 'contain', display: 'block' }}
        // Try the next candidate, then give up and show the monogram.
        onError={() => {
          if (index + 1 < candidates.length) setIndex(index + 1);
          else setFailed(true);
        }}
      />
    </div>
  );
}
