import { useState } from 'react';

/**
 * Card — solid surface, hairline border, optional hover lift
 * @param {boolean} interactive — hover shadow + tinted border
 * @param {string} title — optional header title (H3)
 * @param {React.ReactNode} actions — right-aligned header actions
 * @param {React.ReactNode} children
 */
export function Card({
  title,
  actions,
  interactive = false,
  onClick,
  padding = '20px',
  style: extraStyle,
  children,
  ...rest
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      {...rest}
      onClick={onClick}
      onMouseEnter={() => interactive && setHovered(true)}
      onMouseLeave={() => interactive && setHovered(false)}
      style={{
        background: 'var(--card)',
        border: `1px solid ${hovered && interactive ? 'rgba(99,91,255,0.30)' : 'var(--border)'}`,
        borderRadius: 'var(--r-lg)',
        boxShadow: hovered && interactive ? 'var(--shadow-sm)' : 'none',
        transition: 'box-shadow var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
        cursor: interactive && onClick ? 'pointer' : undefined,
        overflow: 'hidden',
        ...extraStyle,
      }}
    >
      {title !== undefined && (
        <>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 20px',
          }}>
            <h3 style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: '-0.01em',
            }}>
              {title}
            </h3>
            {actions && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {actions}
              </div>
            )}
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
        </>
      )}
      <div style={{ padding }}>
        {children}
      </div>
    </div>
  );
}

export default Card;
