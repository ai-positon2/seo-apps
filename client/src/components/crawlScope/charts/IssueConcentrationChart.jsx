// Horizontal bars of the top issue types by occurrence count, with a
// cumulative-share annotation per row — "5 checks are 69% of all findings."
// Single crawl only, buildable without any trend history: it justifies
// root-cause grouping visually before that's ever built. Deliberately not a
// classic dual-axis Pareto (bars + a second cumulative-% scale) — this app's
// design system forbids a second geometric axis, so the cumulative share is
// read as text per row instead of a plotted line.
//
// Each row is two lines, not one: the issue name gets the full row width on
// its own line (nothing truncated), and the bar + share numbers sit on the
// line below it, indented to start under the name. Cramming a long check
// name, a bar, and two numbers onto one line was forcing the name to ellipsis
// — readable in a tooltip, not on the page.

import { Card, Badge } from '../../../ui';
import { severityVariant } from '../crawlHelpers';

const TOP_N = 8;
const BAR_COLOR = 'var(--viz-1)'; // magnitude only — severity is the Badge's job, not the bar's
const BADGE_COL_WIDTH = 34; // fixed, so a 1-digit and a 3-digit count don't shift the row's start
const NUMBERS_WIDTH = 110;

export default function IssueConcentrationChart({ groups, totalOccurrences }) {
  if (!groups.length || !totalOccurrences) return null;

  const byCount = [...groups].sort((a, b) => b.urls.length - a.urls.length);
  const top = byCount.slice(0, TOP_N);
  const max = top[0]?.urls.length || 1;

  let cumulative = 0;
  const rows = top.map((g) => {
    cumulative += g.urls.length;
    return { ...g, share: g.urls.length / totalOccurrences, cumulativeShare: cumulative / totalOccurrences };
  });

  const topShare = Math.round((cumulative / totalOccurrences) * 100);
  const restCount = byCount.length - top.length;

  return (
    <Card title={`Issue concentration — top ${top.length} of ${byCount.length} issue types`}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((g, i) => (
          <div
            key={g.id}
            style={{ padding: '10px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}
          >
            {/* Line 1 — the full issue name, never truncated. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge variant={severityVariant(g.severity)} style={{ flexShrink: 0, width: BADGE_COL_WIDTH, justifyContent: 'center' }}>
                {g.urls.length}
              </Badge>
              <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.35 }}>{g.label}</span>
            </div>
            {/* Line 2 — the bar and its numbers, indented to start under the name. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, paddingLeft: BADGE_COL_WIDTH + 10 }}>
              <div style={{ flex: 1, height: 12, background: 'var(--surface)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                <div
                  title={`${g.label}: ${g.urls.length.toLocaleString()} occurrences (${Math.round(g.share * 100)}% of total)`}
                  style={{ width: `${(g.urls.length / max) * 100}%`, height: '100%', background: BAR_COLOR, borderRadius: 'var(--r-sm)' }}
                />
              </div>
              <span style={{ flexShrink: 0, width: NUMBERS_WIDTH, display: 'flex', justifyContent: 'flex-end', gap: 6, fontFamily: 'var(--font-mono)' }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>{Math.round(g.share * 100)}%</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· cum {Math.round(g.cumulativeShare * 100)}%</span>
              </span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.4 }}>
        These {top.length} check{top.length === 1 ? '' : 's'} account for {topShare}% of all{' '}
        {totalOccurrences.toLocaleString()} page-level occurrences
        {restCount > 0 ? `; ${restCount} more issue type${restCount === 1 ? '' : 's'} make up the rest.` : '.'}
      </div>
    </Card>
  );
}
