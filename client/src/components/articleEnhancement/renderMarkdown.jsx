// ── Shared markdown rendering (Fix 5) ──────────────────────────────────────────
// One renderer for the Article Enhancement page's Recommendations and Enhanced
// Article tabs, and for the saved enhancements shown in Content Architect's
// Hub & Spoke report. Handles
// headings, **bold**, ---, ordered/unordered lists, blockquotes, pipe tables,
// and [NEW]…[/NEW] highlight markers.
function parseInline(str) {
  const parts = str.split(/(\[NEW\][\s\S]*?\[\/NEW\]|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith('[NEW]') && part.endsWith('[/NEW]')) {
      return (
        <mark key={i} style={{ backgroundColor: 'var(--success-soft)', borderRadius: '2px', padding: '0 2px', color: 'var(--success)' }}>
          {part.slice(5, -6)}
        </mark>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} style={{ fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
function parseTableLine(raw) {
  const stripped = raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  return stripped.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}
function isTableRow(raw) {
  const s = raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  return s.startsWith('|') && s.endsWith('|');
}
function isSeparatorRow(raw) {
  return /^\|?[\s\-|:]+\|?$/.test(raw.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim());
}

export function renderMarkdown(text) {
  const lines = text.split('\n');
  const elements = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { elements.push(<div key={i} style={{ height: '0.6rem' }} />); continue; }

    // Markdown table — collect all consecutive table rows
    if (isTableRow(trimmed)) {
      const tableLines = [];
      while (i < lines.length && (isTableRow(lines[i].trim()) || isSeparatorRow(lines[i].trim()))) {
        tableLines.push(lines[i].trim());
        i++;
      }
      i--; // outer loop will increment
      const nonSep = tableLines.filter(l => !isSeparatorRow(l));
      const isNew = tableLines.some(l => l.startsWith('[NEW]'));
      const headerCells = parseTableLine(nonSep[0] || '');
      const bodyRows = nonSep.slice(1);
      elements.push(
        <div key={i} style={{ overflowX: 'auto', margin: '12px 0', ...(isNew ? { backgroundColor: 'var(--success-soft)', borderRadius: '4px', padding: '4px' } : {}) }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', fontFamily: 'inherit' }}>
            <thead>
              <tr>
                {headerCells.map((cell, ci) => (
                  <th key={ci} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {parseInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid var(--border)', background: ri % 2 === 1 ? 'var(--surface)' : 'transparent' }}>
                  {parseTableLine(row).map((cell, ci) => (
                    <td key={ci} style={{ padding: '7px 12px', color: 'var(--text)', verticalAlign: 'top' }}>
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const isNewLine = trimmed.startsWith('[NEW]') && trimmed.endsWith('[/NEW]');
    const content = isNewLine ? trimmed.slice(5, -6).trim() : trimmed;
    const wrapStyle = isNewLine ? { backgroundColor: 'var(--success-soft)', borderRadius: '3px', display: 'block', padding: '0 4px' } : {};

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(content)) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />);
      continue;
    }

    // Ordered list — group consecutive numbered items into a single <ol>
    if (/^\d+[.)]\s+/.test(content)) {
      const items = [];
      while (i < lines.length) {
        const lt = lines[i].trim();
        const inner = (lt.startsWith('[NEW]') && lt.endsWith('[/NEW]')) ? lt.slice(5, -6).trim() : lt;
        if (!/^\d+[.)]\s+/.test(inner)) break;
        items.push(inner.replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      i--;
      elements.push(
        <ol key={i} style={{ paddingLeft: '1.4rem', margin: '8px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {items.map((li, idx) => (
            <li key={idx} style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6 }}>{parseInline(li)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (content.startsWith('# ')) {
      elements.push(<h1 key={i} style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text)', marginTop: '24px', marginBottom: '8px', ...wrapStyle }}>{parseInline(content.slice(2))}</h1>);
    } else if (content.startsWith('## ')) {
      elements.push(<h2 key={i} style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text)', marginTop: '20px', marginBottom: '6px', ...wrapStyle }}>{parseInline(content.slice(3))}</h2>);
    } else if (content.startsWith('### ')) {
      elements.push(<h3 key={i} style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginTop: '16px', marginBottom: '4px', ...wrapStyle }}>{parseInline(content.slice(4))}</h3>);
    } else if (content.startsWith('#### ')) {
      elements.push(<h4 key={i} style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginTop: '12px', marginBottom: '4px', ...wrapStyle }}>{parseInline(content.slice(5))}</h4>);
    } else if (content.startsWith('- ') || content.startsWith('* ')) {
      elements.push(
        <div key={i} style={{ display: 'flex', gap: '8px', margin: '2px 0', ...wrapStyle }}>
          <span style={{ color: 'var(--text-2)', flexShrink: 0, marginTop: '2px' }}>·</span>
          <span style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6 }}>{parseInline(content.slice(2))}</span>
        </div>
      );
    } else if (content.startsWith('> ')) {
      elements.push(<blockquote key={i} style={{ borderLeft: '4px solid var(--border)', paddingLeft: '12px', fontStyle: 'italic', fontSize: '14px', color: 'var(--text-2)', margin: '8px 0', ...wrapStyle }}>{parseInline(content.slice(2))}</blockquote>);
    } else {
      elements.push(<p key={i} style={{ fontSize: '14px', color: 'var(--text)', lineHeight: 1.6, margin: '6px 0', ...wrapStyle }}>{parseInline(content)}</p>);
    }
  }

  return elements;
}
