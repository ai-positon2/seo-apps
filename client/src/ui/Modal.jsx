import { Dialog } from '@base-ui/react/dialog';

/**
 * Modal / Dialog — built on base-ui's Dialog.
 *
 * The hand-built version closed on Escape but had no dialog role, no focus
 * trap, did not move focus into itself or give it back, and vanished with no
 * exit. base-ui handles role, focus management, Escape and outside-click
 * dismissal (docs/design-audit/01-audit.md, Appendix B; pick-ui-library:
 * dialogs → base-ui). Motion is in index.css (.ui-modal-*): 200ms in, 150ms
 * out, opacity + a 0.97 scale, centred — modals are exempt from
 * trigger-origin rules.
 *
 * Props unchanged, so callers did not change.
 * @param {boolean} open
 * @param {function} onClose
 * @param {string} title
 * @param {'sm'|'md'|'lg'} size
 * @param {React.ReactNode} footer
 * @param {React.ReactNode} children
 */
const WIDTHS = { sm: 420, md: 560, lg: 720 };

export function Modal({ open, onClose, title, size = 'md', footer, children }) {
  return (
    <Dialog.Root open={Boolean(open)} onOpenChange={(next) => { if (!next) onClose?.(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-modal-backdrop" />
        <Dialog.Popup className="ui-modal-popup" style={{ maxWidth: WIDTHS[size] || WIDTHS.md }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '18px 24px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
          }}
          >
            <Dialog.Title style={{
              margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em',
            }}
            >
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 6, border: 'none',
                background: 'none', cursor: 'pointer', color: 'var(--text-3)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </Dialog.Close>
          </div>

          <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
            {children}
          </div>

          {footer && (
            <div style={{
              padding: '14px 24px', borderTop: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexShrink: 0,
            }}
            >
              {footer}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default Modal;
