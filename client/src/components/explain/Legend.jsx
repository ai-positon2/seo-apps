import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { LEGEND_SHARED, resolveLegend } from './explainCopy';
import { SCREENS } from './explainScreens';

// ── The floating legend ─────────────────────────────────────────────────────
//
// Rendered by each report itself, so it is on screen exactly when the numbers
// it explains are — not over an empty form or a tool picker. Portalled to the
// body because report containers carry transforms and overflow that would trap
// a fixed element.
//
// Deliberately NOT closed by a click outside: the point is to keep it open
// while scanning the page it describes.

function SharedVisual({ kind }) {
  if (kind === 'bands') {
    return (
      <span className="explain-legend__swatches">
        <span style={{ background: 'var(--primary)' }} />
        <span style={{ background: 'var(--viz-warn)' }} />
        <span style={{ background: 'var(--viz-neg)' }} />
      </span>
    );
  }
  if (kind === 'dash') return <span className="explain-legend__dash">—</span>;
  if (kind === 'trend') {
    return (
      <span className="explain-legend__arrows">
        <span style={{ color: 'var(--primary)' }}>▲</span>
        <span style={{ color: 'var(--viz-neg)' }}>▼</span>
        <span style={{ color: 'var(--text-3)' }}>—</span>
      </span>
    );
  }
  return (
    <span className="explain-legend__dots">
      <span style={{ background: 'var(--viz-neg)' }} />
      <span style={{ background: 'var(--viz-warn)' }} />
      <span style={{ background: 'var(--neutral-500)' }} />
    </span>
  );
}

export default function Legend({ screen, ctx }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { pathname } = useLocation();

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const rows = resolveLegend(screen, ctx);
  const name = SCREENS[screen] || 'this screen';

  return createPortal(
    <>
      {open && (
        <div id={panelId} role="dialog" aria-label="Legend" className="explain-legend">
          <div className="explain-legend__head">
            <div className="explain-legend__heading">
              <span className="explain-kicker">Legend</span>
              <span className="explain-legend__title">How to read {name}</span>
            </div>
            <button type="button" className="explain-close explain-close--lg" aria-label="Close legend" onClick={() => setOpen(false)}>×</button>
          </div>

          <div className="explain-legend__section">
            <span className="eyebrow">Colours and symbols, everywhere</span>
            <div className="explain-legend__grid">
              {LEGEND_SHARED.map((row) => (
                <div key={row.key} className="explain-legend__shared-row">
                  <SharedVisual kind={row.key} />
                  <span><b>{row.term}.</b> {row.line}</span>
                </div>
              ))}
            </div>
          </div>

          {rows.length > 0 && (
            <div className="explain-legend__section explain-legend__section--screen">
              <span className="eyebrow">The numbers on this screen</span>
              {rows.map((row) => (
                <div key={row.term} className="explain-legend__card">
                  <span className="explain-legend__term">{row.term}</span>
                  <span className="explain-legend__line">{row.line}</span>
                  {row.ex && <span className="explain-legend__ex">{row.ex}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="explain-legend-btn"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="explain-legend-btn__mark" aria-hidden="true">
          <span style={{ background: '#5FAF97' }} />
          <span style={{ background: '#D3A45E' }} />
          <span style={{ background: '#E9998C' }} />
        </span>
        {open ? 'Close legend' : 'Legend'}
      </button>
    </>,
    document.body,
  );
}
