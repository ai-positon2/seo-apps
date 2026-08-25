// ── Audit profile radar ──────────────────────────────────────────────────────
//
// Six modules, six axes. What makes this version different from the one it
// replaces, in the order the problems mattered:
//
//   1. Real names. The old labels had to fit an axis so they were four characters
//      — "COMP 7", "PAGE 69" — which only somebody who already knew the six
//      modules could expand. Two-line labels give the full name room, and the
//      score sits under it at a readable size instead of jammed alongside.
//
//   2. A scale you can read. Four unlabelled rings meant the polygon had no
//      reference; 60 and 85 looked much the same. The rings are now labelled once
//      on the vertical, so a vertex can be read against a number.
//
//   3. A vertex knows how it is doing. One flat accent colour said nothing about
//      whether a point was good. Each vertex now takes the same green/amber/red
//      band the rest of the dashboard uses, so a weak axis is visible without
//      reading its number.
//
//   4. An unscored axis does not become a zero. The old chart drew nothing at all
//      unless EVERY axis scored, so one unscored module hid the whole shape. This
//      draws the polygon through the axes that did score and marks the others with
//      a hollow ring and an em dash. Pulling an unmeasured axis to the centre
//      would draw a spike that reads as catastrophic — the exact §16.11 mistake in
//      visual form.
//
// The honest caveat this chart cannot express, and which the caption beneath it
// carries instead: these six scores are each on their own module's scale, so the
// polygon's SHAPE is not a statement about balance. It is six numbers arranged in
// a circle.

const BAND = [
  { min: 80, color: 'var(--primary)' },
  { min: 60, color: 'var(--viz-warn)' },
  { min: 0, color: 'var(--viz-neg)' },
];

const bandColor = (score) => (BAND.find((b) => score >= b.min) || BAND[2]).color;

// Longest module name is "Competitor Research", which at 10.5px overruns the plot
// in the 340px column this card lives in. Wrapping on a word keeps the real name
// — abbreviating is how the previous chart ended up with "COMP 7".
// Wraps earlier than the label strictly needs, because the binding constraint on
// how large the plot can be is how far the left and right labels reach. Shorter
// lines buy plot diameter: at 11 the widest label is "Competitor" rather than
// "Competitor Research", and the circle grows from 50% of the box to 66%.
const WRAP_AT = 11;

function wrapLabel(label) {
  if (label.length <= WRAP_AT) return [label];
  const words = label.split(' ');
  if (words.length === 1) return [label];
  // Break at the point that leaves the two lines most even.
  let best = 1;
  let bestDelta = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    if (Math.abs(a - b) < bestDelta) { bestDelta = Math.abs(a - b); best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

// Rings at quarters, unlabelled.
//
// They were labelled 25/50/75/100 up the vertical, which stacked four figures
// directly beneath the "Tech Audit 82" label and read as clutter. They were also
// redundant: every axis already prints its exact score beside its name, so a
// reader never needs to measure a vertex against a ring. The rings stay as a
// sense of distance from the centre; the numbers go.
const RINGS = [0.25, 0.5, 0.75, 1];

export default function AuditRadar({ modules = [], size = 258 }) {
  const axes = modules.map((m) => ({
    key: m.key,
    label: m.label,
    score: m.scored && Number.isFinite(m.score) ? m.score : null,
    basis: m.scoreBasis || null,
  }));

  const count = axes.length;
  if (!count) return null;

  const center = size / 2;
  const maxRadius = center - 10;
  // The box is padded rather than the plot shrunk: the left and right labels
  // extend past the circle, and shrinking the polygon to fit them would make the
  // chart smaller to solve a text problem.
  //
  // These are the largest values that leave every label inside the viewBox,
  // checked against the six real module names. The plot is 312 units across in a
  // 476-unit box — 66% — where the previous geometry gave it 50% and left the
  // card looking mostly empty.
  //
  // The numbers are chosen for RENDERED pixel size, not viewBox units, which is
  // the mistake the earlier passes made: a 12.5-unit font in a 476-unit box
  // rendered into a ~350px card is 9px on screen. Shrinking the box relative to
  // the text is what makes the text legible — a 406-unit box puts a 17-unit label
  // on screen at about 15px, which is body-copy size.
  //
  // The circle gets smaller as a result (about 173px rendered rather than 228).
  // That is the trade: the labels take a fixed pixel budget whichever way round
  // it is, and an unreadable label makes the chart useless in a way a slightly
  // smaller circle does not.
  const padX = 74;
  const padY = 46;

  const point = (index, ratio) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return [
      center + Math.cos(angle) * maxRadius * ratio,
      center + Math.sin(angle) * maxRadius * ratio,
    ];
  };

  const scored = axes.filter((a) => a.score !== null);

  // Through the scored axes only. With three or more of them that is a polygon;
  // with two it is a line, which is honest — there is no shape to show.
  const polygon = scored.length >= 3
    ? axes
      .filter((a) => a.score !== null)
      .map((a) => point(axes.indexOf(a), Math.max(0.04, a.score / 100)).join(','))
      .join(' ')
    : null;

  return (
    <svg
      width="100%"
      height={size + padY * 2}
      viewBox={`${-padX} ${-padY} ${size + padX * 2} ${size + padY * 2}`}
      role="img"
      aria-label={axes
        .map((a) => `${a.label}: ${a.score === null ? 'not scored' : a.score}`)
        .join('. ')}
      style={{ maxWidth: size + padX * 2, display: 'block', margin: '0 auto' }}
    >
      {/* Grid */}
      <g fill="none" stroke="var(--border)">
        {RINGS.map((r) => (
          <circle
            key={r}
            cx={center}
            cy={center}
            r={maxRadius * r}
            strokeDasharray={r === 1 ? undefined : '2 4'}
            opacity={r === 1 ? 1 : 0.8}
          />
        ))}
        {axes.map((axis, i) => {
          const [x, y] = point(i, 1);
          return <line key={axis.key} x1={center} y1={center} x2={x} y2={y} opacity={0.7} />;
        })}
      </g>

      {polygon && (
        <polygon
          points={polygon}
          fill="color-mix(in srgb, var(--primary) 22%, transparent)"
          stroke="var(--primary)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
      )}

      {/* Vertices, banded by their own score. */}
      {axes.map((axis, i) => {
        if (axis.score === null) {
          // A hollow marker on the rim, not a point at the centre. Zero would be
          // a spike; this is an absence.
          const [x, y] = point(i, 1);
          return (
            <circle
              key={axis.key}
              cx={x}
              cy={y}
              r={3.5}
              fill="var(--card)"
              stroke="var(--text-3)"
              strokeWidth={1.25}
              strokeDasharray="1.5 1.5"
            />
          );
        }
        const [x, y] = point(i, Math.max(0.04, axis.score / 100));
        return (
          <g key={axis.key}>
            <circle cx={x} cy={y} r={6} fill="var(--card)" />
            <circle cx={x} cy={y} r={4} fill={bandColor(axis.score)} />
          </g>
        );
      })}

      {/* Labels outside the plot, always.
          
          The block grows AWAY from the circle rather than being centred on the
          axis point: centred, the top axis put its name above the rim and its
          score below it, which dropped the score inside the outer ring. Anything
          overlapping the grid is unreadable against it and makes the chart look
          like a mistake.

          So a label above the centre hangs its bottom edge off the rim, one below
          rests its top edge on it, and the two side labels — which clear the plot
          horizontally anyway — stay vertically centred. */}
      {axes.map((axis, i) => {
        const [x, y] = point(i, 1.04);
        const anchor = x < center - 8 ? 'end' : x > center + 8 ? 'start' : 'middle';
        const lines = wrapLabel(axis.label);

        const lineGap = 16;
        const scoreSize = 21;
        const blockHeight = lines.length * lineGap + scoreSize;

        // Which side of the plot this axis is on decides which way the text grows.
        const above = y < center - maxRadius * 0.3;
        const below = y > center + maxRadius * 0.3;
        const top = above
          ? y - blockHeight - 2
          : below
            ? y + 2
            : y - blockHeight / 2;

        return (
          <g key={axis.key}>
            <title>{axis.basis || axis.label}</title>
            {lines.map((line, n) => (
              <text
                key={line}
                x={x}
                y={top + lineGap * (n + 0.5)}
                textAnchor={anchor}
                dominantBaseline="middle"
                fontSize={15}
                fontFamily="var(--font-sans)"
                fill="var(--text-2)"
              >
                {line}
              </text>
            ))}
            <text
              x={x}
              y={top + lines.length * lineGap + scoreSize * 0.5}
              textAnchor={anchor}
              dominantBaseline="middle"
              fontSize={scoreSize}
              fontWeight={600}
              fontFamily="var(--font-mono)"
              fill={axis.score === null ? 'var(--text-3)' : bandColor(axis.score)}
            >
              {axis.score === null ? '—' : axis.score}
            </text>
          </g>
        );
      })}

    </svg>
  );
}
