// Every image/video/audio/PDF the crawl found actually referenced on a page —
// not the site's full media library. See analyzer.js#buildMediaLibrary for
// why "unused" isn't answerable from a crawl alone.

import { useMemo, useState } from 'react';
import { Card, Badge, EmptyState } from '../../ui';
import { formatBytes } from './crawlHelpers';

const TYPE_VARIANT = { Image: 'info', Video: 'brand', Audio: 'neutral', Document: 'warning' };

function fileNameOf(url) {
  try {
    const { pathname } = new URL(url);
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || url);
  } catch {
    return url;
  }
}

export default function MediaLibrary({ mediaLibrary }) {
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');

  const items = mediaLibrary?.items || [];
  const types = useMemo(() => [...new Set(items.map((i) => i.type))].sort(), [items]);

  const filtered = useMemo(() => {
    let values = items;
    if (typeFilter) values = values.filter((i) => i.type === typeFilter);
    if (query) {
      const q = query.toLowerCase();
      values = values.filter((i) => i.url.toLowerCase().includes(q));
    }
    return values;
  }, [items, typeFilter, query]);

  if (!items.length) {
    return (
      <EmptyState
        title="No media found"
        description="No images, video, audio, or PDF files were found referenced on any crawled page."
      />
    );
  }

  return (
    <Card title={`Media library (${mediaLibrary.count.toLocaleString()} file${mediaLibrary.count === 1 ? '' : 's'}, ${formatBytes(mediaLibrary.totalBytes)})`}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {Object.entries(mediaLibrary.byType).map(([type, count]) => (
          <Badge key={type} variant={TYPE_VARIANT[type] || 'neutral'}>{type}: {count}</Badge>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search file name or URL…"
          style={{
            flex: '1 1 220px', minWidth: 180, height: 34, padding: '0 10px', fontSize: 13,
            background: 'var(--surface)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          }}
        />
        {types.length > 1 && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={{
              height: 34, padding: '0 8px', fontSize: 13, background: 'var(--surface)',
              color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
            }}
          >
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', maxHeight: 420, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: 'var(--surface)', position: 'sticky', top: 0 }}>
              {['Type', 'File', 'Size', 'Used on'].map((label, i) => (
                <th
                  key={label}
                  style={{
                    padding: '9px 10px', textAlign: i === 2 ? 'right' : 'left',
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
            {filtered.length ? filtered.map((item) => (
              <tr key={item.url} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 10px' }}>
                  <Badge variant={TYPE_VARIANT[item.type] || 'neutral'}>{item.type}</Badge>
                </td>
                <td style={{ padding: '8px 10px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <a href={item.url} target="_blank" rel="noreferrer" title={item.url} style={{ color: 'var(--primary-text, var(--primary))' }}>
                    {fileNameOf(item.url)}
                  </a>
                  {item.isExternal && (
                    <span
                      title="Hosted on a different domain than the site being crawled — linked from it, not served by it."
                      style={{
                        marginLeft: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--text-3)',
                        textTransform: 'uppercase', letterSpacing: 0.3,
                      }}
                    >
                      External
                    </span>
                  )}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                  {item.size ? formatBytes(item.size) : '—'}
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--text-2)' }} title={item.usedBy.join('\n')}>
                  {item.usedByCount} page{item.usedByCount === 1 ? '' : 's'}
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)' }}>
                  No files match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
        Only files the crawl found referenced on a page. A file sitting in the media library but
        never linked from anywhere won&apos;t appear here — spotting that needs a separate library
        index (e.g. a CMS media API), which this run didn&apos;t use.
      </div>
    </Card>
  );
}
