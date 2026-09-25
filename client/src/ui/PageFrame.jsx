/**
 * PageFrame — the one page frame every tool uses.
 *
 * The design audit found four content widths on the account screens alone,
 * tool pages with no title or explanation at all, and two tools that drew a
 * second breadcrumb bar under the app's own header. Every tool page now opens
 * the same way: its name (the same words as the menu), one plain sentence on
 * what it does and what you get, and at most one main action, top right.
 *
 * @param {string} title        the tool's name, as in the menu
 * @param {string} purpose      one sentence: what it does and what you get
 * @param {React.ReactNode} action  the page's single main action (optional)
 * @param {React.ReactNode} meta    small secondary controls beside the action (optional)
 * @param {'narrow'|'default'|'wide'} width  narrow for forms, wide for reports
 */
const WIDTHS = { narrow: 880, default: 1120, wide: 1280 };

export function PageFrame({ title, purpose, action, meta, width = 'default', children, style }) {
  return (
    <div style={{
      maxWidth: WIDTHS[width] || WIDTHS.default, margin: '0 auto', padding: '28px 32px 48px',
      boxSizing: 'content-box', ...style,
    }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 16, flexWrap: 'wrap', marginBottom: 24,
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 420px' }}>
          <h1 style={{
            margin: 0, fontSize: 'var(--fs-xl)', lineHeight: 1.25, fontWeight: 600,
            color: 'var(--text)', letterSpacing: '-0.01em',
          }}
          >
            {title}
          </h1>
          {purpose && (
            <p style={{
              margin: '6px 0 0', fontSize: 'var(--fs-base)', lineHeight: 1.5,
              color: 'var(--text-2)', maxWidth: '72ch',
            }}
            >
              {purpose}
            </p>
          )}
        </div>
        {(action || meta) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {meta}
            {action}
          </div>
        )}
      </header>
      {children}
    </div>
  );
}

export default PageFrame;
