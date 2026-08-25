// The crawl results table: five report tabs, quick filters, search, pagination.
//
// Hand-rolled rather than using the shared <DataTable>, because the column set
// changes per tab, several cells are custom renders (status badge, priority
// badge, redirect-or-why-not), and rows open a drawer on click. Sorting is not
// offered here for the same reason the desktop app didn't: the row order is
// crawl-discovery order, which is itself information.

import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState } from '../../ui';
import {
  COLUMN_SETS, TABLE_TABS, QUICK_FILTERS, PAGE_SIZE,
  filterResults, formatBytes, severityVariant, statusVariant, topSeverity,
  declarativeRefreshSummary, redirectLocationIssueSummary,
} from './crawlHelpers';

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
    case 'responseTime':
      return result.responseTime ? `${result.responseTime} ms` : '—';
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
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(
    () => filterResults(results, { tab, issueFilter, filter, query }),
    [results, tab, issueFilter, filter, query],
  );

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const start = (current - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);
  const columns = COLUMN_SETS[tab];

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
                  style={{
                    width, padding: '9px 10px', textAlign: align === 'numeric' ? 'right' : 'left',
                    fontSize: 11, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
                    color: 'var(--text-3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
                  }}
                >
                  {label}
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
          {filtered.length
            ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} URLs`
            : 'Showing 0 URLs'}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</Button>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Page {current} of {pages}</span>
          <Button variant="secondary" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}
