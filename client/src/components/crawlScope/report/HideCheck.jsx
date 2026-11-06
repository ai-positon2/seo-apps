import { useState } from 'react';
import { Button, Modal } from '../../../ui';
import { sevOf } from './reportPrimitives';
import { hideConfirmText, HIDE_DENIED_TOOLTIP } from '../hiddenChecks';

// ── "Hide check" and the list of hidden checks ──────────────────────────────
//
// Semrush calls it "Exclude check": a check that does not apply to this client
// is taken out of its score on every crawl (../hiddenChecks.js). The button asks
// first, because the score moves for everyone who reads it; a reader without
// the right to do it sees it disabled, with why, rather than not at all.

function EyeOffIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

function EyeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const quietButton = (disabled) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
  fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap',
  color: disabled ? 'var(--text-3)' : 'var(--text-2)', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 8,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.7 : 1,
});

/**
 * @param {object}   props
 * @param {string}   props.title    the check's name, for the confirm
 * @param {boolean}  props.canHide  whether this reader may hide checks
 * @param {Function} props.onHide   () => Promise; the confirm closes when it settles
 * @param {boolean} [props.busy]
 */
export function HideCheckButton({ title, canHide, onHide, busy = false, style }) {
  const [open, setOpen] = useState(false);
  const disabled = !canHide || busy;
  return (
    <>
      {/* The tooltip sits on a wrapper: a disabled button fires no pointer events. */}
      <span title={canHide ? 'Remove this check from the score for this client' : HIDE_DENIED_TOOLTIP} style={{ display: 'inline-flex', ...style }}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Hide check: ${title}`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
          style={quietButton(disabled)}
        >
          <EyeOffIcon />
          {busy ? 'Hiding…' : 'Hide check'}
        </button>
      </span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Hide this check?"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => { setOpen(false); onHide?.(); }}
            >
              Hide check
            </Button>
          </>
        )}
      >
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
          {hideConfirmText(title)}
        </p>
      </Modal>
    </>
  );
}

/**
 * The toggle's other state, on a hidden check's row in the issue list: one
 * click counts it again (no confirm — nothing is lost by restoring).
 */
export function UnhideCheckButton({ title, canHide, onUnhide, busy = false, style }) {
  const disabled = !canHide || busy;
  return (
    <span title={canHide ? 'Count this check in the score again' : HIDE_DENIED_TOOLTIP} style={{ display: 'inline-flex', ...style }}>
      <button
        type="button"
        disabled={disabled}
        aria-label={`Unhide check: ${title}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onUnhide?.(); }}
        style={quietButton(disabled)}
      >
        <EyeIcon />
        {busy ? 'Restoring…' : 'Unhide'}
      </button>
    </span>
  );
}

/**
 * The "Hidden checks" view: each hidden check, how often it fired in this
 * crawl, who hid it, and Restore.
 *
 * @param {Array}    props.rows      hiddenCheckRows()
 * @param {boolean}  props.canHide
 * @param {Function} props.onRestore (ruleId) => void
 * @param {Set}     [props.busy]     rule ids with a request in flight
 */
export function HiddenChecksList({ rows, canHide, onRestore, busy = new Set() }) {
  if (!rows.length) {
    return (
      <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
        No checks are hidden for this client. Every check counts in the score.
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        These checks are hidden for this client on every crawl. They cost no points and are left out
        of every count, the fix list and the downloads. Restore one to count it again.
      </span>
      {rows.map((row) => {
        const s = sevOf(row.severity);
        const working = busy.has(row.ruleId);
        return (
          <div
            key={row.ruleId}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderRadius: 10,
              background: 'var(--card)', border: '1px solid var(--border)', opacity: 0.92,
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: s.dot }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 15, color: 'var(--text)' }}>{row.title}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {row.count
                  ? `Fired ${row.count.toLocaleString()} time${row.count === 1 ? '' : 's'} on ${row.pages.toLocaleString()} URL${row.pages === 1 ? '' : 's'} in this crawl`
                  : 'Not found in this crawl'}
                {row.hiddenBy ? ` · hidden by ${row.hiddenBy}` : ''}
                {row.hiddenAt ? ` on ${new Date(row.hiddenAt).toLocaleDateString()}` : ''}
              </span>
              {row.reason && <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{row.reason}</span>}
            </div>
            <span title={canHide ? 'Count this check in the score again' : HIDE_DENIED_TOOLTIP} style={{ display: 'inline-flex' }}>
              <button
                type="button"
                disabled={!canHide || working}
                onClick={() => onRestore(row.ruleId)}
                style={quietButton(!canHide || working)}
              >
                <EyeIcon />
                {working ? 'Restoring…' : 'Restore'}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
