/**
 * Spinner — an activity indicator with its label.
 *
 * Replaces the studio kit's text-only "Loading…" and the ~20 per-component
 * spinners, so loading looks the same on every screen. The rotation keyframes
 * live once in index.css (`spin`), which also stops them for reduced motion.
 *
 * @param {string} label  what is being waited for, in the reader's words
 * @param {'sm'|'md'} size
 * @param {boolean} inline  sit in a line of text instead of centring in a block
 */
export function Spinner({ label = 'Loading…', size = 'md', inline = false, style }) {
  const px = size === 'sm' ? 14 : 18;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: inline ? 'inline-flex' : 'flex',
        alignItems: 'center',
        justifyContent: inline ? 'flex-start' : 'center',
        gap: 10,
        padding: inline ? 0 : '24px 0',
        color: 'var(--text-2)',
        fontSize: size === 'sm' ? 'var(--fs-sm)' : 'var(--fs-base)',
        ...style,
      }}
    >
      <svg
        width={px} height={px} viewBox="0 0 24 24" fill="none" aria-hidden="true"
        style={{ flexShrink: 0, animation: 'spin 0.8s linear infinite' }}
      >
        <circle cx="12" cy="12" r="9" stroke="var(--border-strong)" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span>{label}</span>}
    </div>
  );
}

export default Spinner;
