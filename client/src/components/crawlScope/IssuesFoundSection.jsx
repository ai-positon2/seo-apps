// "Issues found" — one card per rule that fired. A row of category pills
// (Technical, Indexability, Metadata, ...) picks which set of issue cards is
// showing below, "All" included — rather than either scrolling one long flat
// list or scrolling every category's section at once. Same cards, same
// click-to-filter behavior either way; this only changes which set is on
// screen.

import { useMemo, useState } from 'react';
import { Card, Badge } from '../../ui';
import { severityVariant, groupsByCategory } from './crawlHelpers';
import ExpandableText from './ExpandableText';

// Mirrors Badge.jsx's STATUS foreground colors — a plain color dot on a pill
// button, not a full Badge, since the pill's own selected/unselected state
// already carries a background+border pair.
const SEVERITY_DOT = {
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  neutral: 'var(--text-3)',
};

function CategoryPill({ label, active, dotColor, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
        fontSize: 12.5, fontWeight: 600, borderRadius: 'var(--r-pill)', cursor: 'pointer',
        whiteSpace: 'nowrap',
        background: active ? 'var(--primary-soft)' : 'var(--surface)',
        color: active ? 'var(--primary-text, var(--primary))' : 'var(--text-2)',
        border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      }}
    >
      {dotColor && (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      )}
      {label}
    </button>
  );
}

function IssueCard({ g, meta, active, showCategory, onClick }) {
  return (
    <Card
      interactive
      padding="12px 14px"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
        background: active ? 'var(--primary-soft)' : 'var(--card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Badge variant={severityVariant(g.severity)}>{g.severity}</Badge>
          {showCategory && meta?.category && (
            <span style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
              {meta.category}
            </span>
          )}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {g.urls.length} URL{g.urls.length === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
        {g.label}
      </div>
      <ExpandableText
        text={meta?.description}
        style={{ marginTop: 4, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.4 }}
      />
    </Card>
  );
}

const CARD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 };

export default function IssuesFoundSection({ groups, catalogById, issueFilter, onToggleIssueFilter }) {
  const [category, setCategory] = useState('');
  const sections = useMemo(() => groupsByCategory(groups, catalogById), [groups, catalogById]);

  if (!groups.length) return null;

  const selected = sections.find((s) => s.category === category);
  const visible = selected ? selected.items : groups;

  return (
    <Card title={`Issues found (${groups.length})`}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <CategoryPill label={`All (${groups.length})`} active={!category} onClick={() => setCategory('')} />
        {sections.map((s) => (
          <CategoryPill
            key={s.category}
            label={`${s.category} (${s.items.length})`}
            active={category === s.category}
            dotColor={SEVERITY_DOT[severityVariant(s.worstSeverity)]}
            onClick={() => setCategory(s.category)}
          />
        ))}
      </div>

      <div style={{ maxHeight: 640, overflowY: 'auto', paddingRight: 2 }}>
        <div style={CARD_GRID}>
          {visible.map((g) => (
            <IssueCard
              key={g.id}
              g={g}
              meta={catalogById.get(g.id)}
              active={issueFilter === g.id}
              showCategory={!category}
              onClick={() => onToggleIssueFilter(g.id)}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}
