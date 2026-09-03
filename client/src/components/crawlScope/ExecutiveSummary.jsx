// A short, structured recap of this crawl, collapsed by default — "Read
// now," next to the title, is the only way in. Once open, a row of pills
// picks which format is showing in the box below (the plain summary, or one
// of the three share formats), and one "Copy" button copies whatever is
// currently showing — not four separate copy-on-click buttons, so nothing
// gets copied by accident and what you copy is always exactly what you just
// read. See buildExecutiveSummaryText / buildEmailShareText /
// buildChannelShareText / buildTaskTableTsv in crawlHelpers.js for what each
// option actually produces.

import { useState } from 'react';
import { Card, Button } from '../../ui';
import {
  buildExecutiveSummaryText, buildEmailShareText, buildChannelShareText, buildTaskTableTsv,
} from './crawlHelpers';

// navigator.clipboard needs a secure context; this falls back to the
// execCommand('copy') + hidden-textarea trick already proven elsewhere in
// this app (see ExportButtons.jsx) rather than silently failing on an older
// browser or a plain-HTTP deployment.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

const OPTIONS = [
  { key: 'summary', label: 'Plain summary', build: buildExecutiveSummaryText },
  { key: 'email', label: 'Email to dev', build: buildEmailShareText },
  { key: 'channel', label: 'Message for a channel', build: buildChannelShareText },
  { key: 'table', label: 'Task table', build: buildTaskTableTsv },
];

function OptionPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 12px',
        fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-pill)', cursor: 'pointer',
        whiteSpace: 'nowrap',
        background: active ? 'var(--primary-soft)' : 'var(--surface)',
        color: active ? 'var(--primary-text, var(--primary))' : 'var(--text-2)',
        border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
      }}
    >
      {label}
    </button>
  );
}

export default function ExecutiveSummary({ ctx }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('summary');
  const [copied, setCopied] = useState(false);

  const summaryText = buildExecutiveSummaryText(ctx);
  if (!summaryText) return null;

  const { metrics, counts } = ctx;
  const teaser = `Site health: ${metrics.health ?? '—'}/100 · ${metrics.errors} errors, `
    + `${metrics.warnings} warnings · ${counts.htmlPages} pages audited`;

  const active = OPTIONS.find((o) => o.key === selected) || OPTIONS[0];
  const activeText = active.key === 'summary' ? summaryText : active.build(ctx);
  // The task table is tab-separated on purpose (see buildTaskTableTsv) — it
  // needs its columns preserved to read as a table at all, so it keeps its
  // tabs and scrolls sideways instead of wrapping like the three prose
  // formats do.
  const isTable = active.key === 'table';

  async function handleCopy() {
    if (!activeText) return;
    const ok = await copyText(activeText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Card
      title="Quick summary"
      actions={(
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Read now'}
        </Button>
      )}
    >
      {!expanded ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{teaser}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {OPTIONS.map((option) => (
              <OptionPill
                key={option.key}
                label={option.label}
                active={selected === option.key}
                onClick={() => setSelected(option.key)}
              />
            ))}
          </div>

          <div
            style={{
              fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6,
              fontFamily: 'var(--font-mono)',
              whiteSpace: isTable ? 'pre' : 'pre-wrap',
              overflowX: isTable ? 'auto' : undefined,
              maxHeight: 360, overflowY: 'auto',
              padding: 12, background: 'var(--surface)', borderRadius: 'var(--r-md)',
            }}
          >
            {activeText || 'Nothing to show for this option.'}
          </div>

          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
