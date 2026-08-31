import { useState } from 'react';

const VARIANTS = {
  primary: {
    base: {
      background: 'var(--primary)',
      color: '#FFFFFF',
      border: '1px solid transparent',
      boxShadow: 'var(--shadow-sm)',
    },
    hover: { background: 'var(--primary-hover)' },
    active: { background: 'var(--primary-press)' },
  },
  secondary: {
    base: {
      background: 'var(--card)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
    },
    hover: { background: 'var(--surface)', borderColor: 'rgba(99,91,255,0.4)' },
    active: { background: 'var(--surface-2)' },
  },
  ghost: {
    base: {
      background: 'transparent',
      color: 'var(--text-2)',
      border: '1px solid transparent',
    },
    hover: { background: 'var(--surface)', color: 'var(--text)' },
    active: { background: 'var(--surface-2)' },
  },
  danger: {
    base: {
      background: 'var(--danger)',
      color: '#FFFFFF',
      border: '1px solid transparent',
    },
    hover: { opacity: 0.88 },
    active: { opacity: 0.76 },
  },
  link: {
    base: {
      background: 'transparent',
      color: 'var(--primary-text)',
      border: '1px solid transparent',
      textDecoration: 'none',
    },
    hover: { textDecoration: 'underline' },
    active: {},
  },
};

const SIZES = {
  sm: { height: 32, paddingInline: 12, fontSize: 13 },
  md: { height: 36, paddingInline: 16, fontSize: 14 },
  lg: { height: 44, paddingInline: 20, fontSize: 14 },
};

const SpinnerIcon = () => (
  <svg
    width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={2.5}
    strokeLinecap="round"
    style={{ animation: 'spin 0.8s linear infinite' }}
  >
    <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
  </svg>
);

/**
 * Button
 * @param {'primary'|'secondary'|'ghost'|'danger'|'link'} variant
 * @param {'sm'|'md'|'lg'} size
 * @param {boolean} loading
 * @param {React.ReactNode} icon — leading icon (16px recommended)
 * @param {boolean} iconOnly — square icon-only button
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconOnly = false,
  disabled,
  children,
  onClick,
  type = 'button',
  style: extraStyle,
  ...rest
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = SIZES[size] || SIZES.md;

  const isDisabled = disabled || loading;

  const computedStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: s.height,
    paddingInline: iconOnly ? 0 : s.paddingInline,
    width: iconOnly ? s.height : undefined,
    fontSize: s.fontSize,
    fontWeight: 500,
    fontFamily: 'var(--font-sans)',
    borderRadius: 'var(--r-md)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    // Disabled used to be opacity 0.4 over the variant's own fill. On a solid
    // primary in dark theme that produced a smudge the same value as the card
    // behind it — the control read as ABSENT rather than unavailable, and a
    // form whose only action is invisible looks broken.
    //
    // A disabled button is still an affordance: it has to be legible, so the
    // reader knows what will become available and why nothing is happening.
    // So it drops the variant fill for a neutral surface and stays readable.
    opacity: isDisabled ? 0.75 : 1,
    outline: 'none',
    transition: `background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)`,
    userSelect: 'none',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    ...v.base,
    ...(hovered && !isDisabled ? v.hover : {}),
    ...(pressed && !isDisabled ? v.active : {}),
    // After the variant, so it wins over a solid fill. `loading` keeps the
    // variant's own look — a button mid-request should still read as the
    // button you pressed, not as one that has become unavailable.
    ...(disabled && !loading ? {
      background: 'var(--surface-2, var(--surface))',
      color: 'var(--text-3)',
      border: '1px solid var(--border)',
      boxShadow: 'none',
    } : {}),
    ...extraStyle,
  };

  return (
    <button
      type={type}
      disabled={isDisabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={computedStyle}
      {...rest}
    >
      {loading ? <SpinnerIcon /> : icon ? <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{icon}</span> : null}
      {!iconOnly && children}
    </button>
  );
}

export default Button;
