// Site health, with its derivation always visible rather than hidden behind
// a hover tooltip — a score with a hidden formula isn't credible to a client.
// Matches MetricCard's visual layout (eyebrow / big mono value / sub line)
// plus an expandable panel listing every weighted input and its contribution.

import { useState } from 'react';
import { healthScoreBreakdown } from './crawlHelpers';

// Same status colors SeverityCompositionBar and severityVariant() use
// everywhere else on this page — one color meaning across the whole run
// page, not a second one invented just for this bar.
const TIER_COLOR = { Errors: 'var(--danger)', Warnings: 'var(--warning)', Notices: 'var(--info)' };

export default function SiteHealthCard({ metrics }) {
  const [expanded, setExpanded] = useState(false);
  const breakdown = healthScoreBreakdown(metrics);

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
      padding: 16, display: 'flex', flexDirection: 'column', gap: 6,
    }}
    >
      <div style={{
        fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--text-3)',
      }}
      >
        Site health
      </div>
      <div style={{
        fontSize: 28, fontFamily: 'var(--font-mono)', fontWeight: 700, lineHeight: 1,
        color: 'var(--text)', letterSpacing: '-0.02em',
      }}
      >
        {metrics.health === null ? '—' : `${metrics.health}%`}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.4 }}>
        {metrics.health === null
          ? 'Run a crawl to calculate site health.'
          : `computed over ${metrics.htmlCount.toLocaleString()} HTML page${metrics.htmlCount === 1 ? '' : 's'}`}
      </div>

      {breakdown.length > 0 && (
        <>
          {/* The "budget consumed" view — 100 points, spent by tier, with
              whatever's left being the score. Primary read now; the exact
              numbers are still one click away below for whoever wants them. */}
          <div
            role="img"
            aria-label={`Site health ${metrics.health}%. ${breakdown
              .filter((row) => row.points)
              .map((row) => `${row.label} cost ${row.points} points`)
              .join(', ') || 'No points lost.'}`}
            style={{
              display: 'flex', height: 8, borderRadius: 'var(--r-pill)', overflow: 'hidden',
              background: 'var(--surface)', marginTop: 2,
            }}
          >
            <div style={{ width: `${metrics.health}%`, background: 'var(--success)' }} />
            {breakdown.map((row) => (row.points ? (
              <div
                key={row.label}
                title={`${row.label}: −${row.points} points (${row.pages} page${row.pages === 1 ? '' : 's'})`}
                style={{ width: `${row.points}%`, background: TIER_COLOR[row.label], borderLeft: '2px solid var(--card)' }}
              />
            ) : null))}
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, marginTop: 2,
              cursor: 'pointer', fontSize: 11.5, color: 'var(--primary-text, var(--primary))',
            }}
          >
            {expanded ? 'Hide breakdown ▲' : 'Show breakdown ▾'}
          </button>
          {expanded && (
            <div style={{
              marginTop: 4, display: 'flex', flexDirection: 'column', gap: 5,
              borderTop: '1px solid var(--border)', paddingTop: 8,
            }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Starting from 100, each tier costs its weight × (affected pages ÷ HTML pages):
              </div>
              {breakdown.map((row) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, color: 'var(--text-2)' }}>
                  <span>{row.label} — {row.pages} page{row.pages === 1 ? '' : 's'} × weight {row.weight}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', flexShrink: 0, color: row.points ? 'var(--danger)' : 'var(--text-3)' }}>
                    {row.points ? `−${row.points}` : '0'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
