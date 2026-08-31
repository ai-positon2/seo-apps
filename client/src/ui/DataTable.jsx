import { useState } from 'react';

/**
 * DataTable — Signal-discipline workhorse table
 * @param {Array} columns — [{ key, label, width, align:'right', mono, render }]
 * @param {Array} rows — array of row objects (must have unique `id` or use index)
 * @param {string} title — optional navy header banner
 * @param {React.ReactNode} actions — header right-side actions
 * @param {boolean} striped — alternate row tint
 * @param {boolean} stickyHeader
 * @param {string} emptyText
 */
export function DataTable({
  columns = [],
  rows = [],
  title,
  actions,
  striped = false,
  stickyHeader = false,
  emptyText = 'No data',
  onRowClick,
  // Without this a dense table squeezes its columns instead of scrolling, and
  // the wrapper's overflow-x never engages.
  minWidth,
  style: extraStyle,
}) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  let sortedRows = [...rows];
  if (sortKey) {
    sortedRows.sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      const cmp = typeof av === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
      ...extraStyle,
    }}>
      {/* Title banner */}
      {title && (
        <div style={{
          background: 'var(--nav-bg-top)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            // Was hardcoded #FFFFFF over --nav-bg-top, which is near-white in
            // light theme — the title was invisible. The token pairs with the
            // banner background in both themes (--text inverts with it).
            color: 'var(--text)',
            letterSpacing: '-0.01em',
          }}>
            {title}
          </span>
          {actions && (
            <div style={{ display: 'flex', gap: 8 }}>
              {actions}
            </div>
          )}
        </div>
      )}
      {!title && actions && (
        <div style={{
          background: 'var(--surface)',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
        }}>
          {actions}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          minWidth,
          borderCollapse: 'collapse',
          fontSize: 13,
        }}>
          <thead>
            <tr style={{
              background: 'var(--surface)',
              ...(stickyHeader ? { position: 'sticky', top: 0, zIndex: 1 } : {}),
            }}>
              {columns.map(col => (
                <th
                  key={col.key}
                  onClick={col.sortable !== false ? () => handleSort(col.key) : undefined}
                  style={{
                    padding: '10px 16px',
                    textAlign: col.align || 'left',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--text-2)',
                    borderBottom: '1px solid var(--border)',
                    whiteSpace: 'nowrap',
                    width: col.width,
                    cursor: col.sortable !== false ? 'pointer' : 'default',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {col.label}
                    {col.sortable !== false && sortKey === col.key && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                        {sortDir === 'asc'
                          ? <path d="M5 15l7-7 7 7" />
                          : <path d="M19 9l-7 7-7-7" />
                        }
                      </svg>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    textAlign: 'center',
                    padding: '40px 16px',
                    color: 'var(--text-3)',
                    fontSize: 13,
                  }}
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => (
                <TableRow
                  key={row.id ?? i}
                  row={row}
                  columns={columns}
                  index={i}
                  striped={striped}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableRow({ row, columns, index, striped, onClick }) {
  const [hovered, setHovered] = useState(false);

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered
          ? 'var(--surface)'
          : striped && index % 2 === 1
          ? 'var(--surface-2)'
          : 'transparent',
        transition: 'background var(--dur-fast) var(--ease)',
        cursor: onClick ? 'pointer' : 'default',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {columns.map((col, ci) => {
        const value = row[col.key];
        const rendered = col.render ? col.render(value, row, index) : value;
        return (
          <td
            key={col.key}
            style={{
              padding: '10px 16px',
              textAlign: col.align || 'left',
              color: ci === 0 ? 'var(--text)' : 'var(--text-2)',
              fontWeight: ci === 0 ? 500 : 400,
              fontFamily: col.mono ? 'var(--font-mono)' : 'var(--font-sans)',
              fontSize: 13,
              lineHeight: '18px',
              whiteSpace: col.wrap ? 'normal' : 'nowrap',
              maxWidth: col.maxWidth,
              overflow: col.maxWidth ? 'hidden' : undefined,
              textOverflow: col.maxWidth ? 'ellipsis' : undefined,
            }}
          >
            {rendered ?? '—'}
          </td>
        );
      })}
    </tr>
  );
}

export default DataTable;
