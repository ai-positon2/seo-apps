import { useMemo, useState } from 'react';
import { EmptyMetric } from './reportPrimitives';

// ── The reports' table ──────────────────────────────────────────────────────
//
// Not `ui/DataTable`: these rows hold metric ENVELOPES, not scalars, so sorting
// has to read `.value` while rendering reads `.display`, and a null value must
// sort as "unknown" rather than as zero. DataTable sorts on the rendered cell,
// which would order an em-dash alphabetically among the numbers.
//
// Columns declare `sortValue` separately from `render` for exactly that reason.

function sortRows(rows, key, dir, columns) {
  const col = columns.find((c) => c.key === key);
  if (!col) return rows;
  const get = col.sortValue || ((r) => r[key]);

  return [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    // Nulls always sink, whichever way the column is sorted — "unknown" is not
    // a small value, and floating it to the top of a descending sort would put
    // the rows we know least about first.
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return dir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return dir === 'asc' ? av - bv : bv - av;
  });
}

/**
 * @param {Array} columns [{key, label, align, width, sortValue, render, title}]
 * @param {Array} rows
 * @param {string} [defaultSort]
 * @param {Function} [onRowClick]
 */
export function ReportTable({
  columns, rows, defaultSort, defaultDir = 'desc', onRowClick, minWidth = 720, emptyText = 'Nothing to show.',
}) {
  const [sortKey, setSortKey] = useState(defaultSort || null);
  const [sortDir, setSortDir] = useState(defaultDir);

  const sorted = useMemo(
    () => (sortKey ? sortRows(rows, sortKey, sortDir, columns) : rows),
    [rows, sortKey, sortDir, columns],
  );

  if (!rows.length) {
    return <div style={{ padding: '20px 0', fontSize: 12.5, color: 'var(--text-3)' }}>{emptyText}</div>;
  }

  function toggle(key) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  return (
    // Wide reports must scroll inside their own box; the page body must never
    // scroll horizontally.
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth, borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                onClick={() => c.sortable !== false && toggle(c.key)}
                style={{
                  textAlign: c.align || 'left',
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: sortKey === c.key ? 'var(--primary-text)' : 'var(--text-3)',
                  cursor: c.sortable === false ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                  width: c.width,
                  userSelect: 'none',
                }}
              >
                {c.label}
                {sortKey === c.key && <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={row.id || row.key || i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                borderBottom: '1px solid var(--border)',
                cursor: onRowClick ? 'pointer' : 'default',
              }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    padding: '9px 10px',
                    textAlign: c.align || 'left',
                    color: 'var(--text-2)',
                    verticalAlign: 'top',
                  }}
                >
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A metric envelope in a table cell: the display string, or `—` with a reason. */
export function MetricCell({ metric, mono = true }) {
  if (!metric || metric.value === null || metric.value === undefined) {
    return <EmptyMetric reason={metric?.note} />;
  }
  return <span className={mono ? 'num' : undefined}>{metric.display}</span>;
}

export default ReportTable;
