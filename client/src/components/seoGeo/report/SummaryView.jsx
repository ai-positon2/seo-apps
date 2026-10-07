import {
  Panel, PanelTitle, Eyebrow, Chip, CountTile, Donut,
  PLATFORM_TONE, bandColor, splitVerdict,
} from './reportKit';
import { resolveBreakdown } from '../primitives';

// ── The answer, before the audit ────────────────────────────────────────────
//
// New in this design, and the reason it exists: the report opened on a
// nine-bucket composition chart, a points-lost waterfall and a 250-row check
// table. All of that is the working-out. None of it says "fix the canonical
// first, and here is what the score becomes when you do".
//
// So this view says exactly that, in five blocks, and everything that was here
// before is one tab across under "More Tech Details".
//
// Every figure is a stored one. `priority_verdict`, `quick_wins`,
// `platform_readiness` and `top_geo_fix` are the model's own fields from the
// audit's stored AI analysis (see the response schema in
// server/routes/seoGeoAudit.js) — this composes nothing and estimates nothing.
// Where the AI analysis did not run, each block says so rather than filling in.

const PLATFORMS = [
  ['Google AIO', 'google_aio'],
  ['ChatGPT', 'chatgpt'],
  ['Perplexity', 'perplexity'],
  ['Claude', 'claude_ai'],
  ['Gemini', 'gemini'],
  ['Copilot', 'copilot'],
];

// Statuses that are not a judgement on the page: excluded from scoring
// server-side, and not counted as passes or failures here either.
const UNSCORED = new Set(['skipped', 'na', 'informational']);

export default function SummaryView({ findings, ai, onOpenDetails }) {
  const scores = findings?.scores || {};
  const summary = ai?.summary || null;
  const geo = ai?.geo_analysis || null;

  const overall = Number.isFinite(scores.overall) ? scores.overall : null;
  const composite = Number.isFinite(scores.composite) ? scores.composite : null;
  const cap = scores.cap || null;
  const breakdown = resolveBreakdown(scores);

  // The weakest bucket, which is where the recoverable points are.
  const weakest = breakdown
    .filter((b) => Number.isFinite(b.score))
    .sort((a, b) => a.score - b.score)[0] || null;

  const checks = findings?.checks || [];
  const counted = checks.filter((c) => !UNSCORED.has(c.status));
  const passed = counted.filter((c) => c.status === 'pass').length;
  const errors = counted.filter((c) => c.status === 'fail' || c.severity === 'error').length;
  const warnings = counted.filter((c) => c.status === 'warning'
    || (c.status !== 'pass' && c.status !== 'fail' && c.severity === 'warning')).length;
  const notices = counted.filter((c) => c.status === 'notice'
    || (c.status !== 'pass' && c.status !== 'fail' && c.status !== 'warning' && c.severity === 'notice')).length;

  // ── The score's band ──────────────────────────────────────────────────────
  //
  // `scores.band` is an OBJECT — seoGeoChecks.js builds it as
  // `{ label, blurb }`, one of five rungs from Excellent to Critical. This
  // rendered it directly as a React child, which throws "Objects are not valid
  // as a React child" and takes the whole page down with it: the report resolves,
  // Summary is the default tab, and the reader gets a blank screen.
  //
  // The rest of the codebase already knew. moduleRunners.js flattens it before
  // storing it in a text column, overview.js guards against printing raw JSON on
  // a card, and ScoreDashboard reads `scores.band?.label`. This one view was
  // never updated.
  //
  // The string branch is not defensive padding: a run stored before the band
  // became an object still has one, and so does anything that read it back out
  // of that text column.
  const bandLabel = typeof scores.band === 'string' ? scores.band : scores.band?.label || null;
  // Written to be read — the one line explaining what the number means — and
  // discarded until now, because the object it lives on was never unpacked.
  const bandBlurb = typeof scores.band === 'object' ? scores.band?.blurb || null : null;

  const capNote = cap?.applied
    ? `Capped at ${cap.value} by a blocking issue: ${cap.reason}.`
      + (composite !== null ? ` Uncapped composite is ${composite}.` : '')
    : 'No blocking cap applied.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* The score, at the size the design gives it. */}
        <Panel pad="24px 28px" elevation="md" style={{ flexDirection: 'row', alignItems: 'center', gap: 28 }}>
          <Donut score={overall} size={168} numberSize={42} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
              {bandLabel || 'Not scored'}
            </span>
            {bandBlurb && (
              <span style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, maxWidth: 460 }}>
                {bandBlurb}
              </span>
            )}
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5, maxWidth: 460 }}>
              {capNote}
            </span>
          </div>
        </Panel>

        {/* ── Priority verdict ───────────────────────────────────────────────
            On the accent ground, which is the one place in either report that
            uses it. It earns that: this is the single sentence the whole audit
            exists to produce, and the three figures under it are what the
            sentence is worth. */}
        {summary?.priority_verdict ? (
          <div
            style={{
              display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14,
              padding: '22px 26px', borderRadius: 14, background: 'var(--primary)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <span
              style={{
                fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.15em', textTransform: 'uppercase',
                color: 'var(--text-on-primary)', opacity: 0.85,
              }}
            >
              Priority verdict
            </span>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-on-primary)', lineHeight: 1.55 }}>
              {summary.priority_verdict}
            </p>

            <div
              style={{
                display: 'flex', gap: 24, flexWrap: 'wrap', paddingTop: 6,
                borderTop: '1px solid color-mix(in srgb, var(--text-on-primary) 25%, transparent)',
              }}
            >
              {/* Only shown when a cap is actually applied. The design prints
                  "Blocking the score — Canonical mismatch" unconditionally; on a
                  page with no cap there is nothing blocking it, and inventing a
                  blocker to fill the slot is the opposite of what this card is
                  for. */}
              {cap?.applied && (
                <OnAccent label="Blocking the score" value={cap.reason} />
              )}
              {weakest && (
                <OnAccent label="Weakest bucket" value={`${weakest.label} — ${weakest.score}`} />
              )}
              {cap?.applied && composite !== null && (
                <OnAccent label="Once fixed" value={`Score reaches ${composite}`} />
              )}
            </div>

            {geo?.top_geo_fix && (
              <div
                style={{
                  paddingTop: 10,
                  borderTop: '1px solid color-mix(in srgb, var(--text-on-primary) 25%, transparent)',
                }}
              >
                <span
                  style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: 'var(--text-on-primary)', opacity: 0.75,
                  }}
                >
                  Top GEO fix
                </span>
                <p
                  style={{
                    margin: '4px 0 0', fontSize: 13, color: 'var(--text-on-primary)',
                    lineHeight: 1.55,
                  }}
                >
                  {asText(geo.top_geo_fix)}
                </p>
              </div>
            )}
          </div>
        ) : (
          <Panel>
            <Eyebrow>Priority verdict</Eyebrow>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
              The AI analysis did not complete for this page, so there is no ranked verdict. The
              check results are all in “More Tech Details”.
            </span>
          </Panel>
        )}
      </div>

      {/* ── Will AI engines show this page? ──────────────────────────────── */}
      {geo?.platform_readiness && (
        <Panel pad="22px 24px" style={{ gap: 12 }}>
          <PanelTitle>Will AI engines show this page?</PanelTitle>
          <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Platform readiness — whether each answer engine currently has what it needs to cite or
            recommend this page. The model’s read, per engine.
          </span>
          <div className="geo-platforms">
            {PLATFORMS.map(([name, key]) => {
              const { status, reason } = splitVerdict(geo.platform_readiness[key]);
              if (!status && !reason) return null;
              const tone = PLATFORM_TONE[status] || PLATFORM_TONE.partial;
              return (
                <div
                  key={key}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px',
                    borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)',
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>{name}</span>
                  <span style={{ alignSelf: 'flex-start' }}>
                    <Chip bg={tone.bg} fg={tone.fg} mono>{tone.label}</Chip>
                  </span>
                  {/* The reason, which the design's chip-only tile drops. It is
                      the whole content of the field — without it the six tiles
                      say "partial" five times and give nobody anything to do. */}
                  {reason && (
                    <span style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
                      {reason}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ── Quick wins ───────────────────────────────────────────────────── */}
      {summary?.quick_wins?.length > 0 && (
        <Panel pad="22px 24px" style={{ gap: 12 }}>
          <PanelTitle>Quick wins</PanelTitle>
          {summary.quick_wins.map((w, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0',
                borderTop: '1px solid var(--border)',
              }}
            >
              <span
                style={{
                  flexShrink: 0, width: 20, height: 20, borderRadius: '50%',
                  background: 'color-mix(in srgb, var(--primary) 20%, transparent)',
                  color: 'var(--primary-text)', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
                }}
              >
                {i + 1}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>{asText(w)}</span>
            </div>
          ))}
        </Panel>
      )}

      {/* ── The check counts ─────────────────────────────────────────────── */}
      <div className="geo-counts">
        <CountTile label="Passed" value={passed} color="var(--primary-text)" />
        <CountTile label="Errors" value={errors} color="var(--viz-neg)" />
        <CountTile label="Warnings" value={warnings} color="var(--viz-warn)" />
        <CountTile label="Notices" value={notices} color="var(--text-2)" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onOpenDetails}
          style={{
            height: 38, padding: '0 18px', fontFamily: 'var(--font-sans)', fontSize: 13,
            fontWeight: 600, color: 'var(--primary-text)', background: 'transparent',
            border: '1px solid var(--primary)', borderRadius: 8, cursor: 'pointer',
          }}
        >
          See the technical detail →
        </button>
      </div>
    </div>
  );
}

/** A label/value pair drawn on the accent ground. */
const OnAccent = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
    <span
      style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--text-on-primary)', opacity: 0.75,
      }}
    >
      {label}
    </span>
    <span style={{ fontSize: 13, color: 'var(--text-on-primary)', fontWeight: 600 }}>{value}</span>
  </div>
);

// The model returns some of these fields as a string and some as a list,
// depending on the page. Same helper the existing panels use, inlined here so
// this view does not depend on the page module.
function asText(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (v && typeof v === 'object') return Object.values(v).join('\n');
  return v ?? '';
}

export { bandColor };
