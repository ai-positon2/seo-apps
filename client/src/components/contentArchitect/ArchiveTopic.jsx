// ── "Archive" on a topic row, and the archived topics list ──────────────────
//
// A brand may not want to target a topic at all. Archiving it takes it out of
// the Hub & Spoke score and every list for this client, including future
// analyses (lib/archivedTopics.js; applied by the server). The button asks
// first, since the score moves for everyone who reads it, and a reader who may
// not do it sees it disabled with why rather than not at all.

import { useState } from 'react';
import { Button, Modal } from '../../ui';
import { ARCHIVE_CONFIRM_TEXT, ARCHIVE_DENIED_TOOLTIP } from '../../lib/archivedTopics';

const quietButton = (disabled) => ({
  flexShrink: 0, whiteSpace: 'nowrap', cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 500,
  color: disabled ? 'var(--text-3)' : 'var(--text-2)', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px',
  opacity: disabled ? 0.7 : 1,
});

/**
 * @param {object}   props
 * @param {string}   props.name        the topic's name, for the confirm
 * @param {boolean}  props.canArchive  whether this reader may archive topics
 * @param {Function} props.onArchive   () => void, called once confirmed
 */
export function ArchiveTopicButton({ name, canArchive, onArchive }) {
  const [open, setOpen] = useState(false);
  // The row this sits on opens and closes on click and Enter/Space, and React
  // events bubble out of the dialog's portal too, so neither leaves here.
  const keep = (e) => e.stopPropagation();
  const keepKeys = (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); };
  return (
    <span style={{ display: 'inline-flex' }} onClick={keep} onKeyDown={keepKeys}>
      {/* The tooltip sits on a wrapper: a disabled button fires no pointer events. */}
      <span
        title={canArchive ? 'Leave this topic out of the Hub & Spoke score and lists for this client' : ARCHIVE_DENIED_TOOLTIP}
        style={{ display: 'inline-flex' }}
      >
        <button
          type="button"
          disabled={!canArchive}
          aria-label={`Archive topic: ${name}`}
          onClick={() => setOpen(true)}
          style={quietButton(!canArchive)}
        >
          Archive
        </button>
      </span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Archive “${name}”?`}
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setOpen(false); onArchive?.(); }}>Archive topic</Button>
          </>
        )}
      >
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-2)' }}>{ARCHIVE_CONFIRM_TEXT}</p>
        <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-3)' }}>
          You can restore it at any time from Archived topics.
        </p>
      </Modal>
    </span>
  );
}

function when(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : null;
}

/** The collapsed "Archived topics (N)" list, each with Restore. */
export function ArchivedTopicsSection({ topics = [], canArchive, onRestore }) {
  // Open by default: an archived topic should stay visible, marked as archived,
  // rather than seem to vanish when the button is pressed.
  const [open, setOpen] = useState(true);
  if (!topics.length) return null;
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--card)', border: '1px dashed var(--border-strong)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 18px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
          Archived topics ({topics.length})
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{open ? '▲' : '▾'}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
          Left out of the score and lists for this client
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 18px 16px' }}>
          {topics.map((t) => {
            const by = [t.archivedBy, when(t.archivedAt)].filter(Boolean).join(', ');
            return (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px dashed var(--border)', background: 'var(--surface)', flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 240px' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>{t.name || 'Unnamed topic'}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    {t.inAnalysis
                      ? `${t.spokeCount ?? 0} spoke${t.spokeCount === 1 ? '' : 's'}${Number.isFinite(t.health) ? ` · health ${t.health}` : ''}`
                      : 'Not in this analysis — still archived for future ones'}
                    {by ? ` · archived by ${by}` : ''}
                    {t.reason ? ` · ${t.reason}` : ''}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 6, whiteSpace: 'nowrap',
                    color: 'var(--text-3)', border: '1px solid var(--border)', background: 'var(--surface)',
                  }}
                >
                  Archived · not in score
                </span>
                <span title={canArchive ? undefined : ARCHIVE_DENIED_TOOLTIP} style={{ display: 'inline-flex' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canArchive || t.pending}
                    onClick={() => onRestore?.(t)}
                  >
                    {t.pending ? 'Archiving…' : 'Restore'}
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
