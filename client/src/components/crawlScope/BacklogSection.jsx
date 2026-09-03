// Issues that have persisted across more than one scheduled crawl — the
// backlog a site quietly accumulates when a recurring problem never gets
// fixed. Only meaningful with real crawl history behind it, so this only
// ever renders for a project with a previous completed run (see buildBacklog
// in crawlHelpers.js); a one-off crawl has nothing to compare against and
// this section is simply absent for one.

import { Card, Badge } from '../../ui';
import { severityVariant } from './crawlHelpers';

// Matches IssueConcentrationChart's fixed badge column — a 1-digit and a
// 3-digit count sitting in the same spot keeps every row's label starting at
// the same x position instead of drifting with the count's digit width.
const BADGE_COL_WIDTH = 34;

function ChangeBadge({ changePercent }) {
  if (changePercent === null) {
    return <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>—</span>;
  }
  if (changePercent === 0) {
    return <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>±0%</span>;
  }
  // More occurrences than last crawl is worse (danger); fewer is progress
  // (success) — direction decides the color, not the raw magnitude, so a
  // steep drop still reads as good news.
  const up = changePercent > 0;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)',
      color: up ? 'var(--danger)' : 'var(--success)',
    }}
    >
      {up ? '▲' : '▼'} {Math.abs(changePercent)}%
    </span>
  );
}

function ageLabel(item) {
  const n = item.runsPresent;
  return `${n}${item.openEnded ? '+' : ''} crawl${n === 1 ? '' : 's'}`;
}

export default function BacklogSection({ backlog, loading }) {
  if (loading) {
    return (
      <Card title="Backlog — recurring issues">
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Comparing against crawl history…</div>
      </Card>
    );
  }
  if (!backlog?.items?.length) return null;

  const top = backlog.items.slice(0, 8);
  const rest = backlog.items.length - top.length;

  return (
    <Card title={`Backlog — ${backlog.items.length} issue${backlog.items.length === 1 ? '' : 's'} carried across crawls`}>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        Still open after appearing in a previous scheduled crawl, oldest-standing first. Change
        %{' '}compares this crawl&apos;s count to the immediately prior one.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {top.map((item, i) => (
          <div
            key={item.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <Badge variant={severityVariant(item.severity)} style={{ flexShrink: 0, width: BADGE_COL_WIDTH, justifyContent: 'center' }}>
              {item.count}
            </Badge>
            <span
              title={item.label}
              style={{
                flex: '1 1 auto', minWidth: 0, fontSize: 12.5, color: 'var(--text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </span>
            <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              {ageLabel(item)}
            </span>
            <span style={{ flexShrink: 0, width: 60, textAlign: 'right' }}>
              <ChangeBadge changePercent={item.changePercent} />
            </span>
          </div>
        ))}
      </div>
      {rest > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
          {rest} more recurring issue{rest === 1 ? '' : 's'} not shown.
        </div>
      )}
    </Card>
  );
}
