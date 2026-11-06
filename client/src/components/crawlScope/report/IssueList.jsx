import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sevOf, AnalyzingNotice } from './reportPrimitives';
import { ruleTrend } from '../crawlHelpers';
import { HideCheckButton, UnhideCheckButton } from './HideCheck';

// ── Every problem found, one row per distinct check ─────────────────────────
//
// One row per rule that fired, severity-ordered, with the number of pages it
// touches and a link into its own page. What it replaced: a collapsible card per
// issue that carried its description, its recommendation and the first few
// affected URLs inline, so nine issues filled four screens and the shape of the
// list — which problems are big — was invisible.
//
// The row is a link: an open problem is in the report's address (?issue=), so
// it can be opened in a new tab, copied, and reached again with Back. It is a
// search-parameter change on the same route, so the page keeps the data it
// already has rather than refetching it. Without `hrefFor` it is a button.
//
// With `onHide`, each row also carries "Hide check" (Semrush's "Exclude check",
// ../hiddenChecks.js), beside the link rather than inside it. Without it — a
// standalone crawl, which has no client to keep the choice on — there is none.
//
// A hidden check stays in the list it belongs to, after the counted ones,
// greyed and marked "Hidden", with the toggle flipped to Unhide — so hiding one
// does not look like nothing happened while the next row moves up into its
// place. `hiddenRows` are hiddenChecks.hiddenCheckRows() entries for this tab.

export default function IssueList({
  groups, catalogById, onOpen, hrefFor = null, provisional = false, crawled = null, comparison = null,
  onHide = null, canHide = false, hiding = null, hiddenRows = [], onUnhide = null,
}) {
  // While the crawl runs, no issues at all — not a shortened list, not a
  // labelled one. The only rules that have run are the crawler's dozen live
  // status checks, and showing them here (even under a "partial" banner) put
  // "5 issues, 0 errors" on screen for a 1,700-page site that had not been
  // audited. There is no honest partial version of this list, so there is no
  // list until the real one exists.
  if (provisional) return <AnalyzingNotice crawled={crawled} />;

  if (!groups.length && !hiddenRows.length) {
    return (
      <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
        No problems of this kind were found in this crawl.
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!groups.length && (
        <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
          No counted problems of this kind in this crawl.
        </span>
      )}
      {groups.map((g) => (
        <IssueRow
          key={`${g.id}|${g.scope || 'page'}`}
          group={g}
          entry={catalogById.get(g.id)}
          trend={ruleTrend(comparison, g.id)}
          onOpen={() => onOpen(g.id)}
          href={hrefFor ? hrefFor(g.id) : null}
          onHide={onHide ? () => onHide(g.id) : null}
          canHide={canHide}
          hiding={Boolean(hiding?.has?.(g.id))}
        />
      ))}
      {hiddenRows.map((row) => (
        <HiddenIssueRow
          key={`hidden|${row.ruleId}`}
          row={row}
          entry={catalogById.get(row.ruleId)}
          canHide={canHide}
          busy={Boolean(hiding?.has?.(row.ruleId))}
          onUnhide={onUnhide ? () => onUnhide(row.ruleId) : null}
        />
      ))}
    </div>
  );
}

// A hidden check, shown where it would be listed: not a link (its findings are
// out of the report), greyed, and with Unhide where Hide check was.
function HiddenIssueRow({ row, entry, canHide = false, busy = false, onUnhide = null }) {
  const title = entry?.title || row.title || row.ruleId;
  return (
    <div
      style={{
        borderRadius: 10, background: 'var(--surface)', border: '1px dashed var(--border)',
        display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px 12px 18px',
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: 'var(--text-3)', opacity: 0.5 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0, opacity: 0.65 }}>
        <span style={{ fontSize: 15, color: 'var(--text-2)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {entry?.category || 'Uncategorised'}
          {` · on ${row.pages.toLocaleString()} ${row.pages === 1 ? 'page' : 'pages'} in this crawl`}
        </span>
      </div>
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', fontSize: 11, padding: '3px 10px', borderRadius: 6,
          whiteSpace: 'nowrap', flexShrink: 0, background: 'var(--card)', color: 'var(--text-3)',
          border: '1px solid var(--border)',
        }}
      >
        Hidden · not in score
      </span>
      {onUnhide && (
        <UnhideCheckButton title={title} canHide={canHide} busy={busy} onUnhide={onUnhide} style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}

function IssueRow({
  group, entry, trend = null, onOpen, href = null, onHide = null, canHide = false, hiding = false,
}) {
  const [hover, setHover] = useState(false);
  const s = sevOf(group.severity);
  const priority = entry?.priority || null;
  const rowStyle = {
    width: '100%', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14,
    padding: '16px 18px', border: 'none', cursor: 'pointer', textAlign: 'left',
    fontFamily: 'var(--font-sans)', color: 'inherit', textDecoration: 'none',
    boxSizing: 'border-box',
    background: hover ? 'var(--surface)' : 'transparent',
  };
  const Row = href ? Link : 'button';
  const rowProps = href
    ? { to: href, state: { inReport: true } }
    : { type: 'button', onClick: onOpen };

  return (
    <div
      style={{
        borderRadius: 10, background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden',
        display: 'flex', alignItems: 'center',
      }}
    >
      <Row
        {...rowProps}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={rowStyle}
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
              The catalog has no such field for its rules, so this is the
              category instead — the honest version of "what kind of problem is
              this" until those names are written. */}
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {entry?.category || 'Uncategorised'}
            {/* How this rule moved against the previous crawl of the site. */}
            {trend && <span style={{ color: 'var(--text-2)' }}>{` · ${trend}`}</span>}
          </span>
          {/* Why it is where it is in the list (the run's ordering). */}
          {group.reason && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{group.reason}</span>
          )}
          {/* A very large crawl: the report loads a limited number of findings,
              most serious first, and this rule has more than it loaded. */}
          {group.partial && (
            <span style={{ fontSize: 12, color: 'var(--viz-warn)' }}>
              Listing {(group.loaded || 0).toLocaleString()} of {(group.count || 0).toLocaleString()} findings
            </span>
          )}
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
      </Row>
      {onHide && (
        <HideCheckButton
          title={entry?.title || group.label || group.id}
          canHide={canHide}
          busy={hiding}
          onHide={onHide}
          style={{ paddingRight: 14, flexShrink: 0 }}
        />
      )}
    </div>
  );
}
