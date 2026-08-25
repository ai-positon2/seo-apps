import { useEffect, useRef, useState } from 'react';

function getBandColor(score) {
  if (score >= 70) return 'var(--success)';
  if (score >= 45) return 'var(--warning)';
  return 'var(--danger)';
}

/**
 * ScoreRing — SVG donut with animated fill
 *
 * A score of null/undefined draws the empty track with an em dash rather than a
 * zero. Some modules have no 0-100 rubric at all — CrawlScope reports severity
 * counts, on-page reports pass/fail checks — and a ring pinned at 0 reads as a
 * catastrophic result rather than as "not scored". Callers that pass a number
 * are unaffected.
 *
 * @param {number|null} score — 0-100, or null when the module does not score
 * @param {64|80|120} size
 * @param {string} label — optional small label below number
 */
export function ScoreRing({ score, size = 80, label }) {
  const scored = Number.isFinite(Number(score));
  const value = scored ? Number(score) : 0;

  const [animated, setAnimated] = useState(0);
  const ref = useRef(null);

  const strokeWidth = size <= 64 ? 6 : 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const color = scored ? getBandColor(value) : 'var(--text-3)';

  useEffect(() => {
    // Nothing to animate when there is no score: the track stays empty.
    const timeout = setTimeout(() => setAnimated(scored ? value : 0), 50);
    return () => clearTimeout(timeout);
  }, [scored, value]);

  const offset = circumference - (animated / 100) * circumference;

  return (
    <div style={{
      display: 'inline-flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
    }}>
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)' }}
      >
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 600ms var(--ease)' }}
        />
        {/* Center text — undo rotation */}
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            transform: `rotate(90deg)`,
            transformOrigin: `${size / 2}px ${size / 2}px`,
            fontSize: size <= 64 ? 16 : size <= 80 ? 20 : 28,
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fill: color,
          }}
        >
          {scored ? Math.round(value) : '—'}
        </text>
      </svg>
      {label && (
        <span style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-3)',
        }}>
          {label}
        </span>
      )}
    </div>
  );
}

export default ScoreRing;
