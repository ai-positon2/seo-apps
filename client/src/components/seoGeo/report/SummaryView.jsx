import {
  Panel, PanelTitle, Eyebrow, CountTile, Donut, InfoTip,
  bandColor, splitVerdict,
} from './reportKit';
import { resolveBreakdown } from '../primitives';
import logoGoogleAio from '../../../assets/ai-engines/google_aio.png';
import logoChatgpt from '../../../assets/ai-engines/chatgpt.png';
import logoPerplexity from '../../../assets/ai-engines/perplexity.png';
import logoClaude from '../../../assets/ai-engines/claude.png';
import logoGemini from '../../../assets/ai-engines/gemini.png';
import logoCopilot from '../../../assets/ai-engines/copilot.png';

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
  ['Google AI Overviews', 'google_aio', logoGoogleAio],
  ['ChatGPT', 'chatgpt', logoChatgpt],
  ['Perplexity', 'perplexity', logoPerplexity],
  ['Claude', 'claude_ai', logoClaude],
  ['Gemini', 'gemini', logoGemini],
  ['Copilot', 'copilot', logoCopilot],
];

// Statuses that are not a judgement on the page: excluded from scoring
// server-side, and not counted as passes or failures here either.
const UNSCORED = new Set(['skipped', 'na', 'informational']);

export default function SummaryView({ findings, ai, onOpenDetails, scope = null }) {
  const scores = findings?.scores || {};
  const summary = ai?.summary || null;
  const geo = ai?.geo_analysis || null;

  // The AI analysis's per-engine read, computed once: the engines panel lists it
  // and the GEO popover quotes its tally, so the two can be read against each other.
  const engines = geo?.platform_readiness
    ? PLATFORMS
      .map(([name, key, logo]) => ({ name, key, logo, ...splitVerdict(geo.platform_readiness[key]) }))
      .filter((e) => e.status || e.reason)
    : [];
  const engineTally = ['ready', 'partial', 'not_ready']
    .map((st) => [st, engines.filter((e) => (e.status || 'partial') === st).length])
    .filter(([, n]) => n > 0);

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

  // What the headline card shows: the site average on one page of a multi-page
  // run (matching the dashboard card), otherwise this report's own scores.
  const siteView = Boolean(scope && Number.isFinite(scope.average));
  const sideOf = (avg) => (Number.isFinite(avg) ? { score: avg, band: { label: ratingFor(avg).label } } : null);
  const hero = siteView
    ? { score: scope.average, ...ratingFor(scope.average), seo: sideOf(scope.seo), geo: sideOf(scope.geo) }
    : { score: overall, label: bandLabel, blurb: bandBlurb, seo: scores.seo, geo: scores.geo };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* The score, at the size the design gives it — with the two sides it
            blends beside it, so "which is working" is answered in the first
            card rather than further down.

            On one page of a multi-page run the headline is the SITE AVERAGE — the
            same three numbers the dashboard card shows, from the same server
            function — and this page's own scores sit in the strip below it. Leading
            with the page made the report and the card read as two different
            results for one audit. */}
        <Panel pad="24px 28px" elevation="md" style={{ flexDirection: 'row', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
          <Donut score={hero.score} size={168} numberSize={42} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 240px', minWidth: 0 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Eyebrow>{siteView ? `Site average · ${scope.count} pages` : 'Overall score'}</Eyebrow>
              <InfoTip label="How the overall score works">
                {siteView
                  ? <SiteAverageExplainer title="Site average" score={scope.average} count={scope.count} pageScore={overall} pageUrl={scope.url} />
                  : <OverallExplainer breakdown={breakdown} cap={cap} composite={composite} overall={overall} bandLabel={bandLabel} seo={scores.seo} geo={scores.geo} />}
              </InfoTip>
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
              {hero.label || 'Not scored'}
            </span>
            {hero.blurb && (
              <span style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, maxWidth: 460 }}>
                {hero.blurb}
              </span>
            )}
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5, maxWidth: 460 }}>
              {siteView
                ? `The mean of the ${scope.count} audited pages’ scores — the same figure as the dashboard card.`
                : capNote}
            </span>
          </div>
          {(hero.seo || hero.geo) && (
            <div
              style={{
                display: 'flex', gap: 22, flexWrap: 'wrap', paddingLeft: 24,
                borderLeft: '1px solid var(--border)',
              }}
            >
              <SideScore
                name="SEO" sub="Search engines" axis={hero.seo}
                infoLabel="How the SEO score works"
                info={siteView
                  ? <SiteAverageExplainer title="SEO · site average" score={scope.seo} count={scope.count} pageScore={scores.seo?.score} pageUrl={scope.url} />
                  : <AxisExplainer title="SEO score" axis={scores.seo} what="Can search engines like Google find, index and rank this page?" />}
              />
              <SideScore
                name="GEO" sub="AI answer engines" axis={hero.geo}
                infoLabel="How the GEO score works"
                info={siteView
                  ? <SiteAverageExplainer title="GEO · site average" score={scope.geo} count={scope.count} pageScore={scores.geo?.score} pageUrl={scope.url} engineTally={engineTally} />
                  : <AxisExplainer title="GEO score" axis={scores.geo} engineTally={engineTally} what="Can AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Gemini) read, trust and cite this page?" />}
              />
            </div>
          )}
        </Panel>

        {/* This page, within the run: its own three scores, introducing the
            page-level detail that follows. */}
        {siteView && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '12px 16px',
              borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 260px' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                This page · {scope.number} of {scope.count} — the detail below is for this page
              </span>
              <span style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pathOf(scope.url)}
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 13, color: 'var(--text-2)' }}>
              <span>Overall <strong className="num" style={{ color: bandColor(overall) }}>{overall ?? '—'}</strong></span>
              {scores.seo && <span>SEO <strong className="num" style={{ color: bandColor(scores.seo.score) }}>{scores.seo.score}</strong></span>}
              {scores.geo && <span>GEO <strong className="num" style={{ color: bandColor(scores.geo.score) }}>{scores.geo.score}</strong></span>}
            </span>
          </div>
        )}

        {/* ── SEO and GEO, separately ─────────────────────────────────────────
            The bars each side is made of, weakest first: the "why" behind the
            two numbers in the card above. Server-side calculateScores builds
            `scores.seo` / `scores.geo`; a report saved before that had them
            derived from its stored bars (withAxisScores) on the way here. */}
        {(scores.seo || scores.geo) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <AxisCard title={siteView ? 'What drives this page’s SEO score' : 'What drives the SEO score'} axis={scores.seo} />
            <AxisCard title={siteView ? 'What drives this page’s GEO score' : 'What drives the GEO score'} axis={scores.geo} />
          </div>
        )}

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
      {engines.length > 0 && (
        <Panel pad="22px 24px" style={{ gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 620 }}>
              <PanelTitle>Will AI engines show this page?</PanelTitle>
              <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                Whether each answer engine has what it needs to cite or recommend this page, as read
                by the AI analysis.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {engineTally.map(([st, n]) => (
                <StatusPill key={st} status={st} count={n} />
              ))}
            </div>
          </div>
          {/* The GEO score and this panel measure the same thing two ways — rule
              checks and the AI's read. Said here so the two are read together. */}
          {scores.geo && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 14px',
                borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>GEO score</span>
                <span className="num" style={{ fontSize: 15, fontWeight: 700, color: bandColor(scores.geo.score) }}>
                  {scores.geo.score}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: bandColor(scores.geo.score) }}>
                  {scores.geo.band?.label}
                </span>
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, flex: '1 1 280px' }}>
                {scores.geo.cap?.applied
                  ? `${scores.geo.cap.reasons.join(' ')} That is the gap these engines report, so the GEO score is held at ${scores.geo.cap.value} until it is fixed.`
                  : 'Measured from the page’s GEO checks; the engine reads below are the AI analysis of the same page.'}
              </span>
            </div>
          )}
          <div className="geo-platforms">
            {engines.map((e) => <EngineCard key={e.key} engine={e} />)}
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
// One side's score in the headline card: a compact ring, its name, and the "i".
function SideScore({ name, sub, axis, info, infoLabel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Donut score={axis?.score ?? null} size={88} numberSize={24} stroke={10} label={null} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{name}</span>
          <InfoTip label={infoLabel} align="right">{info}</InfoTip>
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{sub}</span>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: bandColor(axis?.score) }}>
          {axis?.band?.label || 'Not scored'}
        </span>
      </div>
    </div>
  );
}

const pct = (w) => `${Math.round(w * 100)}%`;

// The rating label for a 0–100 score: SCORE_BANDS in server/checks/seoGeoChecks.js,
// for a figure the server did not label itself (an average across pages).
const RATINGS = [
  { min: 90, label: 'Excellent', blurb: 'No blocking issues. What remains is refinement.' },
  { min: 75, label: 'Good', blurb: 'Technically sound, with a few real gaps worth fixing.' },
  { min: 60, label: 'Needs work', blurb: 'Several real defects are limiting search and AI visibility.' },
  { min: 40, label: 'Poor', blurb: 'Significant defects across multiple areas.' },
  { min: 0, label: 'Critical', blurb: 'Blocking problems — fix these before anything else.' },
];
const ratingFor = (score) => {
  const r = RATINGS.find((b) => (score ?? 0) >= b.min) || RATINGS[RATINGS.length - 1];
  return { label: r.label, blurb: r.blurb };
};

// The "i" for a site-average figure: what it averages, and where this page sits.
function SiteAverageExplainer({ title, score, count, pageScore, pageUrl, engineTally }) {
  return (
    <>
      <TipHeader title={title} score={score} band={Number.isFinite(score) ? ratingFor(score).label : null} />
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        The mean across the {count} audited pages — the same number the dashboard card shows. Each
        page is scored on its own; pick one in the bar above to see it.
      </span>
      {Number.isFinite(pageScore) && (
        <TipCallout label="This page">
          {pathOf(pageUrl)} scores <strong>{pageScore}</strong>. The breakdown below is for this page.
        </TipCallout>
      )}
      {engineTally?.length > 0 && (
        <TipSection label="AI engines on this page">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {engineTally.map(([st, n]) => <StatusPill key={st} status={st} count={n} />)}
          </div>
        </TipSection>
      )}
    </>
  );
}

// "/features" from a full URL; the homepage reads "/ (homepage)".
const pathOf = (url) => {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return p ? p : '/ (homepage)';
  } catch { return url || ''; }
};

// ── Explainer popovers ──────────────────────────────────────────────────────
// Laid out to be scanned, not read: a header with the number, one plain
// sentence, the bars as a small table, and the one action as a callout. Every
// figure comes from this run's own scores, so the popover always agrees with the
// numbers on the page.

const TIP_MUTED = { fontSize: 11.5, color: 'var(--text-3)' };

function TipHeader({ title, score, band }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
      {Number.isFinite(score) && (
        <span
          style={{
            display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px',
            borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}
        >
          <span className="num" style={{ fontSize: 14, fontWeight: 700, color: bandColor(score) }}>{score}</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: bandColor(score) }}>{band}</span>
        </span>
      )}
    </div>
  );
}

function TipSection({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <span
        style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--text-3)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

// One bar as a table row: name, meter, score, and its weight within the total.
function TipRow({ label, score, weight }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 56px 26px 34px', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, score))}%`, background: bandColor(score) }} />
      </span>
      <span className="num" style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', color: 'var(--text)' }}>{score}</span>
      <span className="num" style={{ ...TIP_MUTED, textAlign: 'right' }}>{pct(weight)}</span>
    </div>
  );
}

function TipColumns() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 56px 26px 34px', gap: 8 }}>
      <span style={TIP_MUTED}>Category</span>
      <span />
      <span style={{ ...TIP_MUTED, textAlign: 'right' }}>Score</span>
      <span style={{ ...TIP_MUTED, textAlign: 'right' }}>Weight</span>
    </div>
  );
}

function TipCallout({ tone = 'accent', label, children }) {
  const warn = tone === 'warn';
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 11px', borderRadius: 8,
        background: warn ? 'color-mix(in srgb, var(--viz-warn) 12%, var(--card))' : 'var(--primary-soft)',
        borderLeft: `3px solid ${warn ? 'var(--viz-warn)' : 'var(--primary)'}`,
      }}
    >
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-2)' }}>
        {label}
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

// The five rating bands as one strip of equal, labelled segments, with the band
// this score is in highlighted, so the thresholds are seen rather than read.
const BANDS = [
  { min: 0, max: 39, label: 'Critical', color: 'var(--viz-neg)' },
  { min: 40, max: 59, label: 'Poor', color: 'var(--viz-neg)' },
  { min: 60, max: 74, label: 'Needs work', color: 'var(--viz-warn)' },
  { min: 75, max: 89, label: 'Good', color: 'var(--primary)' },
  { min: 90, max: 100, label: 'Excellent', color: 'var(--primary)' },
];
function BandScale({ score }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 3 }}>
      {BANDS.map((b) => {
        const here = Number.isFinite(score) && score >= b.min && score <= b.max;
        return (
          <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ height: here ? 8 : 5, marginTop: here ? 0 : 3, borderRadius: 3, background: b.color, opacity: here ? 1 : 0.3 }} />
            <span
              style={{
                fontSize: 10.5, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontWeight: here ? 700 : 500, color: here ? 'var(--text)' : 'var(--text-3)',
              }}
            >
              {b.label}
            </span>
            <span className="num" style={{ fontSize: 10, color: 'var(--text-3)' }}>
              {b.min === 0 ? `< ${b.max + 1}` : `${b.min}+`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// The "i" for the headline: the bars grouped under the side they count toward.
function OverallExplainer({ breakdown, cap, composite, overall, bandLabel, seo, geo }) {
  const bars = breakdown.filter((b) => Number.isFinite(b.score));
  const side = (axis) => {
    const keys = new Set((axis?.buckets || []).map((b) => b.key));
    return bars.filter((b) => keys.has(b.key)).sort((a, b) => (b.effective_weight ?? b.weight) - (a.effective_weight ?? a.weight));
  };
  const groups = [['SEO · search engines', side(seo)], ['GEO · AI answer engines', side(geo)]]
    .filter(([, rows]) => rows.length);
  const grouped = new Set(groups.flatMap(([, rows]) => rows.map((r) => r.key)));
  const rest = bars.filter((b) => !grouped.has(b.key));
  return (
    <>
      <TipHeader title="Overall score" score={overall} band={bandLabel} />
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        One number for the whole page: a weighted average of {bars.length} category scores. SEO and
        GEO beside it split the same categories into search and AI.
      </span>
      <TipSection label="What it is made of">
        <TipColumns />
        {groups.map(([label, rows]) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{label}</span>
            {rows.map((b) => <TipRow key={b.key} label={b.label} score={b.score} weight={b.effective_weight ?? b.weight} />)}
          </div>
        ))}
        {rest.map((b) => <TipRow key={b.key} label={b.label} score={b.score} weight={b.effective_weight ?? b.weight} />)}
      </TipSection>
      <TipSection label="Rating">
        <BandScale score={overall} />
      </TipSection>
      {cap?.applied && composite !== null ? (
        <TipCallout tone="warn" label="Capped by a blocking issue">
          Without it this page would score {composite}.
        </TipCallout>
      ) : (
        <span style={TIP_MUTED}>
          A blocking issue (noindex, no title, no H1, thin content) would cap this score regardless of the rest.
        </span>
      )}
    </>
  );
}

// The "i" for one side, from that side's own bars and weights.
function AxisExplainer({ title, axis, what, engineTally }) {
  if (!axis) {
    return (
      <>
        <TipHeader title={title} />
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Not scored: none of this side’s checks ran on this page.</span>
      </>
    );
  }
  const rows = [...axis.buckets].sort((a, b) => b.weight - a.weight);
  return (
    <>
      <TipHeader title={title} score={axis.score} band={axis.band?.label} />
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{what}</span>
      <TipSection label="What it is made of">
        <TipColumns />
        {rows.map((b) => <TipRow key={b.key} label={b.label} score={b.score} weight={b.weight} />)}
      </TipSection>
      {engineTally?.length > 0 && (
        <TipSection label="AI engines on this page">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {engineTally.map(([st, n]) => <StatusPill key={st} status={st} count={n} />)}
          </div>
        </TipSection>
      )}
      {axis.cap?.applied ? (
        <TipCallout tone="warn" label={`Capped at ${axis.cap.value}`}>
          {axis.cap.reasons.join(' ')} Without it: {axis.composite}.
        </TipCallout>
      ) : axis.weakest ? (
        <TipCallout label="Biggest gain">
          Fix <strong>{axis.weakest.label}</strong> ({axis.weakest.score}): it loses this score the most points.
        </TipCallout>
      ) : (
        <TipCallout label="Nothing to fix">No category on this side is losing points.</TipCallout>
      )}
    </>
  );
}

// One side of the split: the bars it is made of, weakest first, so "why" is on
// the page rather than a tab away.
function AxisCard({ title, axis }) {
  if (!axis) {
    return (
      <Panel pad="20px 22px" style={{ gap: 8 }}>
        <Eyebrow>{title}</Eyebrow>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Not scored: no checks on this side ran.</span>
      </Panel>
    );
  }
  const bars = [...(axis.buckets || [])].sort((a, b) => a.score - b.score);
  return (
    <Panel pad="20px 22px" style={{ gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <Eyebrow>{title}</Eyebrow>
        <span className="num" style={{ fontSize: 13, fontWeight: 600, color: bandColor(axis.score) }}>
          {axis.score}/100
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bars.map((b) => (
          <div key={b.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 32px', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.label}
            </span>
            <span style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, b.score))}%`, background: bandColor(b.score) }} />
            </span>
            <span className="num" style={{ fontSize: 12.5, textAlign: 'right', color: 'var(--text)' }}>{b.score}</span>
          </div>
        ))}
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {axis.cap?.applied
          ? `Capped at ${axis.cap.value}: ${axis.cap.reasons.join(' ')} Without it this side scores ${axis.composite}.`
          : axis.weakest
            ? `Losing the most points: ${axis.weakest.label} (${axis.weakest.score}). Fixing it lifts this score the most.`
            : 'Nothing on this side is losing points.'}
      </span>
    </Panel>
  );
}

// ── Answer-engine readiness ─────────────────────────────────────────────────

const ENGINE_STATUS = {
  ready: { label: 'Ready', color: 'var(--primary)' },
  partial: { label: 'Partial', color: 'var(--viz-warn)' },
  not_ready: { label: 'Not ready', color: 'var(--viz-neg)' },
};

function StatusPill({ status, count }) {
  const st = ENGINE_STATUS[status] || ENGINE_STATUS.partial;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
        background: `color-mix(in srgb, ${st.color} 12%, var(--card))`,
        border: `1px solid color-mix(in srgb, ${st.color} 30%, transparent)`,
        fontSize: 12, fontWeight: 600, color: st.color, whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color }} />
      {count !== undefined && <span className="num">{count}</span>}
      {st.label}
    </span>
  );
}

const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

// The model writes most verdicts as "<what helps>, but <what limits it>". Shown as
// two labelled lines when it does; as one paragraph when it does not — the text
// is never rewritten, only split at that one word.
function splitReason(reason) {
  const m = reason.match(/^(.*?),?\s+but\s+(.*)$/is);
  if (!m || m[1].length < 8 || m[2].length < 8) return null;
  return { works: capitalize(m[1].trim()), limits: capitalize(m[2].trim().replace(/\.$/, '')) + '.' };
}

function ReasonLine({ tone, label, children }) {
  const color = tone === 'good' ? 'var(--primary)' : 'var(--viz-warn)';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
      <span
        aria-hidden="true"
        style={{
          width: 18, height: 18, borderRadius: '50%', marginTop: 1,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${color} 15%, var(--card))`, color, fontSize: 11, fontWeight: 800,
        }}
      >
        {tone === 'good' ? '✓' : '!'}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color }}>
          {label}
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{children}</span>
      </div>
    </div>
  );
}

function EngineCard({ engine }) {
  const st = ENGINE_STATUS[engine.status] || ENGINE_STATUS.partial;
  const parts = engine.reason ? splitReason(engine.reason) : null;
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px 16px', borderRadius: 12,
        background: 'var(--card)', border: '1px solid var(--border)',
        boxShadow: `inset 0 3px 0 ${st.color}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Always a white tile: several marks (ChatGPT's black knot) are drawn for
            a light ground and disappear on a dark one. */}
        <span
          style={{
            width: 36, height: 36, flexShrink: 0, borderRadius: 9, background: '#fff',
            border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <img src={engine.logo} alt="" width={24} height={24} style={{ display: 'block', objectFit: 'contain' }} />
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', flex: 1, minWidth: 0 }}>{engine.name}</span>
        <StatusPill status={engine.status || 'partial'} />
      </div>
      {parts ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ReasonLine tone="good" label="Working">{parts.works}</ReasonLine>
          <ReasonLine tone="warn" label="Holding it back">{parts.limits}</ReasonLine>
        </div>
      ) : engine.reason ? (
        // Unsplit: a Ready verdict is about what works, anything else about what limits it.
        engine.status === 'ready'
          ? <ReasonLine tone="good" label="Working">{capitalize(engine.reason)}</ReasonLine>
          : <ReasonLine tone="warn" label="Holding it back">{capitalize(engine.reason)}</ReasonLine>
      ) : null}
    </div>
  );
}

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
