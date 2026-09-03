// The crawl results table: five report tabs, quick filters, search, pagination.
//
// Hand-rolled rather than using the shared <DataTable>, because the column set
// changes per tab, several cells are custom renders (status badge, priority
// badge, redirect-or-why-not), and rows open a drawer on click. Discovery
// order is the default and stays the default for the same reason the desktop
// app never sorted rows — it's itself information — but "Sort by slowest" is
// offered as an explicit, off-by-default override for the one column where
// people actually want a ranked view.

import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState } from '../../ui';
import {
  COLUMN_SETS, TABLE_TABS, QUICK_FILTERS, PAGE_SIZE, PAGE_SIZE_OPTIONS,
  filterResults, formatBytes, severityVariant, statusVariant, topSeverity,
  declarativeRefreshSummary, redirectLocationIssueSummary,
} from './crawlHelpers';

// Mirrors analyzer.js's own "slow-page" check (result.responseTime > 1000) —
// this is the check's real threshold, not an arbitrary display choice.
const SLOW_PAGE_THRESHOLD_MS = 1000;
const APPROACHING_SLOW_MS = 600;

function Cell({ colKey, result }) {
  switch (colKey) {
    case 'status':
      return <Badge variant={statusVariant(result.status)}>{result.status || '—'}</Badge>;
    case 'severity': {
      const top = topSeverity(result);
      return top ? <Badge variant={severityVariant(top.severity)}>{top.severity}</Badge> : <span style={{ color: 'var(--text-3)' }}>—</span>;
    }
    case 'topIssue':
      return <span title={topSeverity(result)?.label || ''}>{topSeverity(result)?.label || '—'}</span>;
    case 'issues':
      return result.issues?.length
        ? <span style={{ fontWeight: 600 }}>{result.issues.length}</span>
        : <span style={{ color: 'var(--text-3)' }}>0</span>;
    case 'indexability':
      return (
        <span style={{ fontSize: 11.5, color: result.indexability === 'Indexable' ? 'var(--success)' : 'var(--text-3)' }}>
          {result.indexability || 'Unknown'}
        </span>
      );
    case 'size':
      return formatBytes(result.size);
    case 'responseTime': {
      if (!result.responseTime) return <span style={{ color: 'var(--text-3)' }}>—</span>;
      const ms = result.responseTime;
      const color = ms > SLOW_PAGE_THRESHOLD_MS
        ? 'var(--danger)'
        : ms >= APPROACHING_SLOW_MS ? 'var(--warning)' : undefined;
      return <span style={color ? { color, fontWeight: 600 } : undefined}>{ms.toLocaleString()} ms</span>;
    }
    case 'declarativeRefresh': {
      const value = declarativeRefreshSummary(result);
      return value ? <span title={value}>{value}</span> : <span style={{ color: 'var(--text-3)' }}>—</span>;
    }
    case 'redirectUrl': {
      const value = result.redirectUrl || redirectLocationIssueSummary(result);
      return value ? <span title={value}>{value}</span> : <span style={{ color: 'var(--text-3)' }}>—</span>;
    }
    default: {
      const value = result[colKey];
      if (value === null || value === undefined || value === '') {
        return <span style={{ color: 'var(--text-3)' }}>—</span>;
      }
      return <span title={String(value)}>{String(value)}</span>;
    }
  }
}

export default function ResultsTable({ results, issueFilter, onClearIssueFilter, onRowClick, onExportCsv }) {
  const [tab, setTab] = useState('all');
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // How many rows show at once — a long crawl otherwise turns "Pages on this
  // site" into a page-length scroll of its own.
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // Of 150 rows, most were theme .js files and images — this table now
  // defaults to the audit universe (HTML pages) rather than everything the
  // crawler fetched, with a one-click way back to the unfiltered set.
  const [htmlOnly, setHtmlOnly] = useState(true);
  // Off by default — see the file header comment on why discovery order
  // stays the default everywhere else.
  const [sortSlowest, setSortSlowest] = useState(false);

  const assetCount = useMemo(
    () => results.filter((r) => !r.contentType?.includes('text/html')).length,
    [results],
  );
  const scoped = useMemo(
    () => (htmlOnly ? results.filter((r) => r.contentType?.includes('text/html')) : results),
    [results, htmlOnly],
  );

  // Built from whatever categories are actually present, not a fixed list —
  // the categorizer's output vocabulary can grow, and a hardcoded dropdown
  // would silently go stale against it.
  const categoryOptions = useMemo(() => {
    const set = new Set(results.map((r) => r.pageCategory).filter(Boolean));
    return [...set].sort();
  }, [results]);

  const filtered = useMemo(
    () => filterResults(scoped, { tab, issueFilter, filter, category, query }),
    [scoped, tab, issueFilter, filter, category, query],
  );

  const columns = COLUMN_SETS[tab];
  const hasTimeColumn = columns.some(([key]) => key === 'responseTime');

  const sorted = useMemo(() => {
    if (!sortSlowest || !hasTimeColumn) return filtered;
    return [...filtered].sort((a, b) => (b.responseTime || 0) - (a.responseTime || 0));
  }, [filtered, sortSlowest, hasTimeColumn]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  // Any filter change invalidates the page number.
  const reset = (fn) => (value) => { fn(value); setPage(1); };

  if (!results.length) {
    return <EmptyState title="No URLs yet" description="Results appear here as the crawl discovers them." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {TABLE_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => reset(setTab)(t.id)}
            style={{
              padding: '8px 14px', fontSize: 13, cursor: 'pointer', background: 'none', border: 'none',
              color: tab === t.id ? 'var(--text)' : 'var(--text-3)',
              fontWeight: tab === t.id ? 600 : 400,
              borderBottom: `2px solid ${tab === t.id ? 'var(--primary)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => reset(setQuery)(e.target.value)}
          placeholder="Search URL, title, meta, H1, issue…"
          style={{
            flex: '1 1 260px', minWidth: 200, height: 34, padding: '0 10px', fontSize: 13,
            background: 'var(--surface)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          }}
        />
        <select
          value={filter}
          onChange={(e) => reset(setFilter)(e.target.value)}
          style={{
            height: 34, padding: '0 8px', fontSize: 13, background: 'var(--surface)',
            color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          }}
        >
          {QUICK_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        {categoryOptions.length > 0 && (
          <select
            value={category}
            onChange={(e) => reset(setCategory)(e.target.value)}
            style={{
              height: 34, padding: '0 8px', fontSize: 13, background: 'var(--surface)',
              color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
            }}
          >
            <option value="">All categories</option>
            {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {assetCount > 0 && (
          <button
            type="button"
            onClick={() => reset(setHtmlOnly)(!htmlOnly)}
            title={htmlOnly
              ? `${assetCount} non-HTML file${assetCount === 1 ? '' : 's'} (images, scripts, stylesheets, etc.) are hidden.`
              : 'Showing every content type the crawl fetched.'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px',
              fontSize: 12.5, fontWeight: 500, borderRadius: 'var(--r-md)', cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: htmlOnly ? 'var(--warning-soft)' : 'var(--surface)',
              color: htmlOnly ? 'var(--warning)' : 'var(--text-2)',
              border: `1px solid ${htmlOnly ? 'transparent' : 'var(--border)'}`,
            }}
          >
            {htmlOnly
              ? `${assetCount} non-HTML file${assetCount === 1 ? '' : 's'} hidden — show`
              : 'Show HTML only'}
          </button>
        )}
        {hasTimeColumn && (
          <button
            type="button"
            onClick={() => reset(setSortSlowest)(!sortSlowest)}
            title="Rows are normally in crawl-discovery order, which is itself information — this temporarily overrides that to rank by response time instead."
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px',
              fontSize: 12.5, fontWeight: 500, borderRadius: 'var(--r-md)', cursor: 'pointer',
              whiteSpace: 'nowrap',
              background: sortSlowest ? 'var(--primary-soft)' : 'var(--surface)',
              color: sortSlowest ? 'var(--primary-text, var(--primary))' : 'var(--text-2)',
              border: `1px solid ${sortSlowest ? 'var(--primary)' : 'var(--border)'}`,
            }}
          >
            {sortSlowest ? '✓ Sorted by slowest' : 'Sort by slowest'}
          </button>
        )}
        <Button variant="secondary" size="sm" onClick={onExportCsv}>Export CSV</Button>
      </div>

      {issueFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}>
          <span>Filtered to one issue.</span>
          <Button variant="ghost" size="sm" onClick={onClearIssueFilter}>Clear</Button>
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              {columns.map(([key, label, width, align]) => (
                <th
                  key={key}
                  title={key === 'responseTime'
                    ? `The Slow pages check flags anything over ${SLOW_PAGE_THRESHOLD_MS.toLocaleString()} ms.`
                    : undefined}
                  style={{
                    width, padding: '9px 10px', textAlign: align === 'numeric' ? 'right' : 'left',
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
                    color: 'var(--text-3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                  }}
                >
                  {key === 'responseTime' ? `${label} (>1s slow)` : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length ? pageRows.map((result) => (
              <tr
                key={result.url}
                onClick={() => onRowClick(result)}
                style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
              >
                {columns.map(([key, , , align]) => (
                  <td
                    key={key}
                    style={{
                      padding: '8px 10px', textAlign: align === 'numeric' ? 'right' : 'left',
                      color: 'var(--text-2)', maxWidth: 340, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    <Cell colKey={key} result={result} />
                  </td>
                ))}
              </tr>
            )) : (
              <tr>
                <td colSpan={columns.length} style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
                  No URLs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {sorted.length
            ? `Showing ${start + 1}–${Math.min(start + pageSize, sorted.length)} of ${sorted.length.toLocaleString()} URLs`
            : 'Showing 0 URLs'}
        </span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-3)' }}>
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => reset(setPageSize)(Number(e.target.value))}
              style={{
                height: 30, padding: '0 6px', fontSize: 12, background: 'var(--surface)',
                color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
              }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="secondary" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</Button>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Page {current} of {pages}</span>
            <Button variant="secondary" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
