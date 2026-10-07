// Shared presentational primitives for the SEO & GEO tools (full Audit page and
// the Snapshot page). Moved verbatim out of SeoGeoAuditPage.jsx so both pages
// render the same scoring UI from one implementation.

export const STEPS = [
  { id: 'fetch',     label: 'Fetch Page' },
  { id: 'checks',    label: 'Run Checks' },
  { id: 'structure', label: 'Structure Findings' },
  { id: 'ai',        label: 'AI Analysis' },
];

export const GEO_BADGE = {
  ready:      { bg: 'var(--success-soft)', text: 'var(--success)', label: 'AI-Ready' },
  needs_work: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: 'Partly AI-Ready' },
  not_ready:  { bg: 'var(--danger-soft)',  text: 'var(--danger)',  label: 'Not AI-Ready' },
};

// Derived from the RULE-BASED answerability score rather than ai.summary.geo_readiness.
// Two reasons: it survives an AI failure (the badge used to vanish with it), and it can
// never disagree with the rubric card printed directly beneath it — previously the badge
// came from the model and the panel came from the rule engine, so they could contradict.
// Thresholds mirror the rubric documented in the GPT prompt: >=7 ready, 4-6 partial, <4 not.
export function answerabilityVerdict(geo) {
  const score = geo?.answerability_score ?? geo?.csqaf_score;
  if (!Number.isFinite(score)) return null;
  return score >= 7 ? 'ready' : score >= 4 ? 'needs_work' : 'not_ready';
}

// Only a noindex/meta-refresh page is actually unrankable. The other blocker groups cap
// the score (canonical conflict, invalid JSON-LD, no H1/viewport) but the page still ranks,
// so calling every cap "blocked" would trade one false signal for a louder one.
const HARD_BLOCK_GROUPS = new Set(['noindex', 'meta_refresh']);
export function capIsHardBlock(cap) {
  return !!(cap?.applied && (cap.groups || []).some(g => HARD_BLOCK_GROUPS.has(g.id)));
}

// A segmented meter, deliberately NOT a ring. Track B is a small-integer rubric (5 criteria
// x 2 points), not a percentage, and drawing it as a second ring next to the /100 ring is a
// visual claim that the two are the same kind of measurement — the reader then silently
// rescales 1/10 into "10 out of 100" and reads the two numbers as contradicting each other.
// One pip per rubric criterion, half-filled when the criterion scored 1 of 2.
export function PipMeter({ parts }) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {parts.map(p => {
        const ratio = p.max > 0 ? p.points / p.max : 0;
        const color = ratio >= 1 ? 'var(--success)' : ratio > 0 ? 'var(--warning)' : 'var(--danger)';
        // A zero pip has no fill to draw, so the track itself has to carry the signal —
        // tinting it danger-soft. Plain --surface is the same colour as the well behind
        // the meter, which rendered every zeroed criterion as blank space.
        return (
          <div key={p.key} title={`${p.key} — ${p.label}: ${p.points}/${p.max}`}
            style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              height: 6, borderRadius: 999, overflow: 'hidden',
              background: ratio > 0 ? 'var(--border)' : 'var(--danger-soft)',
            }}>
              <div style={{ height: '100%', width: `${Math.round(ratio * 100)}%`, background: color, borderRadius: 999 }} />
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color, textAlign: 'center', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
              {p.key}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const EEAT_BADGE = {
  strong:   { bg: 'var(--success-soft)', text: 'var(--success)' },
  moderate: { bg: 'var(--warning-soft)', text: 'var(--warning)' },
  weak:     { bg: 'var(--danger-soft)',  text: 'var(--danger)' },
};

export function scoreColor(score) {
  return score >= 70 ? 'var(--success)' : score >= 45 ? 'var(--warning)' : 'var(--danger)';
}

// The model's JSON is untrusted in SHAPE as well as in content, and nothing server-side
// validates it. Observed in real runs: `corrected_json_ld` and `starter_template` come back
// as parsed JSON-LD OBJECTS rather than strings, and rendering an object as a React child
// throws "Objects are not valid as a React child", which unmounts the whole card — the
// schema panels only crashed on click because those fields sit inside the collapsed body.
// Never interpolate an ai.* value into JSX without passing it through here.
export function asText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return ''; }
}

// Canonical bar order + labels. Used only to reconstruct a `breakdown` for runs
// persisted before the scoring redesign (which carry the flat keys but no
// `breakdown` array). Live runs always render `scores.breakdown` as-is.
export const BUCKET_ORDER = [
  ['title_meta',        'Title & Meta'],
  ['content_structure', 'Content & Structure'],
  ['indexability',      'Indexability'],
  ['schema',            'Schema'],
  ['geo_signals',       'GEO Signals'],
  ['eeat',              'E-E-A-T'],
  ['technical',         'Technical & Performance'],
  ['links_media',       'Links & Media'],
  ['keyword',           'Keyword Targeting'],
];

// Back-compat: prefer the server-supplied breakdown (which carries checks_scored,
// effective_weight and points_lost); fall back to the flat keys for older runs so
// the bars still render instead of showing "undefined".
export function resolveBreakdown(scores) {
  if (!scores) return [];
  if (Array.isArray(scores.breakdown) && scores.breakdown.length > 0) return scores.breakdown;
  return BUCKET_ORDER
    .filter(([key]) => scores[key] !== null && scores[key] !== undefined)
    .map(([key, label]) => ({ key, label, score: scores[key] }));
}

export function ScoreRing({ score, size = 80 }) {
  const r = (size / 2) - 8;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  const color = scoreColor(score);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth="7" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="7"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2+1} textAnchor="middle" dominantBaseline="middle"
        fontSize="16" fontWeight="700" fill={color} fontFamily="var(--font-mono)">{score}</text>
    </svg>
  );
}

export function StepBar({ steps }) {
  return (
    <>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {STEPS.map(s => {
          const st = steps[s.id];
          const isDone = st?.status === 'done';
          const isActive = st?.status === 'active';
          const isError = st?.status === 'error';
          const dotBg = isDone ? 'var(--success)' : isActive ? 'var(--primary)' : isError ? 'var(--danger)' : 'var(--border)';
          const dotColor = (isDone || isActive || isError) ? '#fff' : 'var(--text-3)';
          const labelColor = isDone ? 'var(--success)' : isActive ? 'var(--primary)' : isError ? 'var(--danger)' : 'var(--text-3)';
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, backgroundColor: dotBg, color: dotColor, fontSize: 11,
              }}>
                {isDone ? '✓' : isActive ? (
                  <svg style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                    <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                ) : isError ? '✕' : '·'}
              </span>
              <span style={{ color: labelColor, fontWeight: isActive ? 600 : 400 }}>
                {st?.message || s.label}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// A bar renders nothing for a nullish score: a bucket with no scored checks is
// dropped from the model (never awarded 100), and a run persisted before the
// scoring redesign has no value for the newer bars at all.
export function ScoreBar({ label, score, checksScored, effectiveWeight, onClick, active }) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return null;
  const color = scoreColor(score);
  const meta = [];
  if (Number.isFinite(checksScored)) meta.push(`${checksScored} check${checksScored === 1 ? '' : 's'}`);
  if (Number.isFinite(effectiveWeight)) meta.push(`${Math.round(effectiveWeight * 100)}% of score`);
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        ...(clickable ? {
          cursor: 'pointer', borderRadius: 6, padding: '4px 6px', margin: '-4px -6px',
          background: active ? 'var(--surface)' : 'transparent',
        } : null),
      }}
    >
      <div style={{ width: 132, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {clickable && <span style={{ color: 'var(--text-3)', marginRight: 4 }}>{active ? '▾' : '▸'}</span>}
          {label}
        </span>
        {meta.length > 0 && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginTop: 1 }}>{meta.join(' · ')}</span>
        )}
      </div>
      <div style={{ flex: 1, height: 8, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 999, transition: 'width 500ms', width: `${score}%`, backgroundColor: color }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, width: 32, textAlign: 'right', color, fontFamily: 'var(--font-mono)' }}>{score}</span>
    </div>
  );
}
