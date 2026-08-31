// ── The report rail ─────────────────────────────────────────────────────────
//
// Deliberately NOT `ui/Tabs`. Tabs has no overflow handling and nine items do
// not fit its underline variant at any realistic width. The app already has the
// right pattern for a long single-select list — CrawlScopeReviewPage's rule
// rail — so this copies it: a scrolling Card of full-width buttons, active row
// marked with `--primary` border and `--primary-soft` background.
//
// The design handoff puts the rail horizontally across the top. It is vertical
// here because this app already owns a global left sidebar and a second
// horizontal band under it would read as a third navigation layer. The grouping
// and order are the handoff's, unchanged.

const GROUP_ORDER = ['REPORTS', 'SET UP'];

/**
 * @param {Array} items  [{id, label, group, stat, badge, disabled}]
 * @param {string} activeId
 * @param {Function} onSelect
 */
export function ReportRail({ items, activeId, onSelect }) {
  const byGroup = new Map();
  for (const item of items) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  // Known groups first, in order; anything else after, rather than vanishing.
  // Filtering by this list alone once dropped every report from the rail when
  // the group names changed — a silent empty nav that no build could catch.
  const groups = [
    ...GROUP_ORDER.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <nav
      aria-label="AI Visibility reports"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: 8,
        position: 'sticky',
        top: 16,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
    >
      {groups.map((group, gi) => (
        <div key={group} style={{ marginTop: gi ? 14 : 2 }}>
          <div
            className="eyebrow"
            style={{
              fontSize: 9.5,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '.18em',
              color: 'var(--text-3)',
              padding: '0 10px 6px',
            }}
          >
            {group}
          </div>

          {byGroup.get(group).map((item) => {
            const active = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => !item.disabled && onSelect(item.id)}
                disabled={item.disabled}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  marginBottom: 2,
                  cursor: item.disabled ? 'default' : 'pointer',
                  borderRadius: 'var(--r-md)',
                  border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
                  background: active ? 'var(--primary-soft)' : 'transparent',
                  opacity: item.disabled ? 0.45 : 1,
                }}
              >
                <span style={{
                  fontSize: 12.5,
                  color: active ? 'var(--primary-text)' : 'var(--text-2)',
                  fontWeight: active ? 600 : 400,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {item.label}
                </span>

                {/* The rail's headline stat. `—` is a real answer here, so the
                    slot is never blank just because a number is unknown. */}
                {item.badge || (item.stat !== undefined && item.stat !== null && (
                  <span
                    className="num"
                    style={{
                      fontSize: 11,
                      color: active ? 'var(--primary-text)' : 'var(--text-3)',
                      flexShrink: 0,
                    }}
                  >
                    {item.stat}
                  </span>
                ))}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default ReportRail;
