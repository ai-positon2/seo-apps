import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { muted } from './promptHelpers';

// ── One question ────────────────────────────────────────────────────────────
//
// Used by both lists on the screen. A question is a line of text and the page
// it is meant to win; everything else that used to sit on this row (slot
// badge, intent badge, source badge, demand volume, a "why this prompt"
// disclosure) described how the old generator built it, not anything a person
// decides about it.
//
// Editing is inline and SAFE: it no longer un-approves the question. That
// demotion used to happen silently, so a typo fix dropped the row out of the
// measured set and the next run skipped it with nothing on screen saying so.

/**
 * @param {object} props
 * @param {object} props.prompt
 * @param {Function} props.onEdit    (id, patch) => Promise
 * @param {Function} props.onRemove  (id) => Promise
 * @param {Function} [props.onApprove] (id) => Promise — waiting rows only
 * @param {boolean}  [props.busy]
 */
export function QuestionRow({
  prompt, onEdit, onRemove, onApprove, busy = false,
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(prompt.text);
  const ref = useRef(null);

  useEffect(() => { setText(prompt.text); }, [prompt.text]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  async function commit() {
    const next = text.trim();
    setEditing(false);
    if (!next || next === prompt.text) { setText(prompt.text); return; }
    await onEdit(prompt.id, { text: next });
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderTop: '1px solid var(--border)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <textarea
            ref={ref}
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setText(prompt.text); setEditing(false); }
            }}
            style={{
              width: '100%',
              font: 'inherit',
              fontSize: 13,
              color: 'var(--text)',
              background: 'var(--surface)',
              border: '1px solid var(--primary)',
              borderRadius: 6,
              padding: '6px 8px',
              resize: 'vertical',
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Click to edit"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              font: 'inherit',
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--text)',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'text',
            }}
          >
            {prompt.text}
          </button>
        )}

        {prompt.targetUrl && (
          <a
            href={prompt.targetUrl}
            target="_blank"
            rel="noreferrer"
            style={{ ...muted, display: 'inline-block', marginTop: 3, textDecoration: 'none' }}
          >
            {pathOf(prompt.targetUrl)}
          </a>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {onApprove && (
          <Button size="sm" disabled={busy} onClick={() => onApprove(prompt.id)}>
            Approve
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(prompt.id)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

/** The path alone. A full URL wraps and buries the part that identifies it. */
function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname === '/' ? '/ (homepage)' : u.pathname);
  } catch {
    return url;
  }
}

export default QuestionRow;
