import { useMemo, useState } from 'react';
import {
  TableFrame, Th, Pager, SearchField,
} from './reportPrimitives';

// ── Every HTML page crawled ─────────────────────────────────────────────────
//
// Four columns: the URL, its title, how the server answered, and how many
// problems are on it.
//
// HTML pages only — the caller filters with crawlHelpers.isHtmlPage before
// this sees them. The files a site serves (images, stylesheets, scripts, PDFs,
// feeds) are fetched by the crawler and stored, but no check in the analyzer
// runs on them, so they can never carry a finding and listing them padded the
// table with a few hundred rows nobody can act on. The page's footnote counts
// them so the total still reconciles against "N crawled".
//
// What it replaced: a table with five switchable column sets — 34 columns in
// total, covering response headers, metadata lengths and the internal link
// graph — which is a spreadsheet rendered in a browser. The spreadsheet is the
// right medium for that and the report already produces one; the button for it
// is at the top of this page.
//
// Search and paging are kept. A real crawl is hundreds of pages, and a table
// with no way to find a URL in it is a list you scroll past.

const PAGE_SIZE = 25;

const statusColor = (status) => {
  const s = String(status || '');
  if (s.startsWith('2')) return 'var(--primary)';
  if (s.startsWith('4') || s.startsWith('5')) return 'var(--viz-neg)';
  return 'var(--text-2)';
};

export default function UrlsTable({ pages, onOpen }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (p) => (p.url || '').toLowerCase().includes(q)
        || (p.title || '').toLowerCase().includes(q),
    );
  }, [pages, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // A search that shrinks the list below the current page would otherwise show
  // an empty table with "Page 7 of 2" under it.
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <SearchField
          value={query}
          onChange={(v) => { setQuery(v); setPage(1); }}
          placeholder="Search these URLs"
        />
      </div>

      <TableFrame>
        <thead>
          <tr style={{ background: 'var(--surface)' }}>
            <Th>Page URL</Th>
            <Th>Title</Th>
            <Th nowrap>Status</Th>
            <Th align="right" nowrap>Issues</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => {
            // The audit's findings for this page, not the crawl-time
            // quickIssues() list the row arrived with: withEffectiveIssues()
            // replaces `.issues` with the page-scoped findings once they exist,
            // so this column counts real findings and reads 0 while a crawl is
            // still running — which is what the provisional gate is for.
            const count = (p.issues || []).length;
            return (
              <tr key={p.url} style={{ borderBottom: '1px solid var(--border)' }}>
                <td
                  style={{
                    padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: 12.5,
                    color: 'var(--text)', maxWidth: 320, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {p.url}
                </td>
                <td
                  style={{
                    padding: '12px 14px', color: 'var(--text-2)', maxWidth: 280,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {p.title || '—'}
                </td>
                <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', color: statusColor(p.status) }}>
                  {p.status ?? '—'}
                  {p.statusText && (
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)', fontSize: 12 }}>
                      {' '}{p.statusText}
                    </span>
                  )}
                </td>
                <td style={{ padding: '12px 14px', textAlign: 'right' }}>
                  {/* Only a page that has something to show is a link. A zero
                      that opens an empty detail view is a dead end dressed as
                      an action. */}
                  {count === 0 ? (
                    <span className="num" style={{ fontSize: 13, color: 'var(--text-3)' }}>0</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(p.url)}
                      style={{
                        fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600,
                        color: count >= 3 ? 'var(--viz-neg)' : 'var(--viz-warn)',
                        background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                        textDecoration: 'underline', textUnderlineOffset: 2,
                      }}
                    >
                      {count}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!shown.length && (
            <tr>
              <td colSpan={4} style={{ padding: '18px 14px', color: 'var(--text-3)', fontSize: 13 }}>
                {pages.length
                  ? 'No page matches that search.'
                  : 'No HTML pages have been crawled yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </TableFrame>

      <Pager
        page={current}
        pageCount={pageCount}
        onPage={setPage}
        note={filtered.length
          ? `Showing ${start + 1}–${start + shown.length} of ${filtered.length.toLocaleString()}`
            + `${query.trim() ? ` matching page${filtered.length === 1 ? '' : 's'}` : ` HTML page${filtered.length === 1 ? '' : 's'}`}`
            + ' · every column, and the files this site serves, are in the Excel audit'
          : 'Nothing to show'}
      />
    </div>
  );
}
