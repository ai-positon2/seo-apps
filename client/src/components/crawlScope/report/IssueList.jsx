import { useState } from 'react';
import { sevOf, AnalyzingNotice } from './reportPrimitives';

// ── Every problem found, one row per distinct check ─────────────────────────
//
// One row per rule that fired, severity-ordered, with the number of pages it
// touches and a link into its own page. What it replaced: a collapsible card per
// issue that carried its description, its recommendation and the first few
// affected URLs inline, so nine issues filled four screens and the shape of the
// list — which problems are big — was invisible.
//
// The row is a button rather than an anchor because the whole report is one
// route: opening an issue changes which view the page renders, not which URL it
// is at. That is a deliberate trade — an issue is not linkable — and the reason
// is that the crawl's results, findings and catalog are one fetch each for the
// whole screen; making every issue a route would refetch all three to render a
// panel the page already has the data for.

export default function IssueList({
  groups, catalogById, onOpen, provisional = false, crawled = null,
}) {
  // While the crawl runs, no issues at all — not a shortened list, not a
  // labelled one. The only rules that have run are the crawler's dozen live
  // status checks, and showing them here (even under a "partial" banner) put
  // "5 issues, 0 errors" on screen for a 1,700-page site that had not been
  // audited. There is no honest partial version of this list, so there is no
  // list until the real one exists.
  if (provisional) return <AnalyzingNotice crawled={crawled} />;

  if (!groups.length) {
    return (
      <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
        No problems of this kind were found in this crawl.
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {groups.map((g) => (
        <IssueRow
          key={g.id}
          group={g}
          entry={catalogById.get(g.id)}
          onOpen={() => onOpen(g.id)}
        />
      ))}
    </div>
  );
}

function IssueRow({ group, entry, onOpen }) {
  const [hover, setHover] = useState(false);
  const s = sevOf(group.severity);
  const priority = entry?.priority || null;

  return (
    <div style={{ borderRadius: 10, background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 14,
          padding: '16px 18px', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--font-sans)',
          background: hover ? 'var(--surface)' : 'transparent',
        }}
      >
        <span
          style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: s.dot,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 15, color: 'var(--text)' }}>
            {entry?.title || group.label || group.id}
          </span>
          {/* The design carries a plain-language restatement of the title here.
              The catalog has no such field for its 96 rules, so this is the
              category instead — the honest version of "what kind of problem is
              this" until those names are written. */}
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {entry?.category || 'Uncategorised'}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
          <span className="num" style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
            {group.pages}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {group.pages === 1 ? 'page' : 'pages'}
          </span>
        </div>
        {priority && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', fontSize: 11, padding: '3px 10px',
              borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0,
              background: s.chipBg, color: s.chipFg,
            }}
          >
            {priority}
          </span>
        )}
        <span
          style={{
            fontSize: 12.5, color: 'var(--primary-text)', flexShrink: 0, width: 54,
            textAlign: 'right',
          }}
        >
          View →
        </span>
      </button>
    </div>
  );
}
