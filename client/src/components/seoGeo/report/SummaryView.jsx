import {
  Panel, PanelTitle, Eyebrow, CountTile, Donut,
  bandColor, splitVerdict,
} from './reportKit';
import { InfoDot, Legend } from '../../explain';
import { resolveBreakdown } from '../primitives';
// The page picker's own label ("/ (home)", "/pricing"), so the report and the
// picker above it never name the same page two ways.
import { pathOf } from '../../../lib/pageReportPicker';
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
  const pageStatus = Number(findings?.meta?.http_status);
  const pageError = Number.isFinite(pageStatus) && pageStatus >= 400;
  // Pages the site average is actually over: an error page carries no score.
  const scoredCount = siteView ? (Number.isFinite(scope.scored) ? scope.scored : scope.count) : null;
  const unscoredCount = siteView ? Math.max(0, scope.count - scoredCount) : 0;
  // Each side for the site view: the average score, its bars averaged over the
  // same pages, and how many pages a cap held down. Every figure on the Summary
  // is then a site figure — one set of numbers, matching the dashboard card.
  const siteAxis = (score, detail) => (Number.isFinite(score) && detail ? {
    score,
    band: { label: ratingFor(score).label },
    buckets: detail.buckets || [],
    weakest: [...(detail.buckets || [])].filter((b) => b.score < 100)
      .sort((a, b) => b.weight * (100 - b.score) - a.weight * (100 - a.score))[0] || null,
    cap: detail.capped > 0 ? { applied: true, siteCount: detail.capped, reasons: detail.capReasons || [] } : null,
  } : null);
  const siteSeo = siteView ? siteAxis(scope.seo, scope.seoDetail) : null;
  const siteGeo = siteView ? siteAxis(scope.geo, scope.geoDetail) : null;
  const sideOf = (avg) => (Number.isFinite(avg) ? { score: avg, band: { label: ratingFor(avg).label } } : null);
  const hero = siteView
    ? { score: scope.average, ...ratingFor(scope.average), seo: sideOf(scope.seo), geo: sideOf(scope.geo) }
    : { score: overall, label: bandLabel, blurb: bandBlurb, seo: scores.seo, geo: scores.geo };

  // What the info icons and the legend quote: the figures this view prints. In
  // the site view the headline is the site average, not this page's score, so
  // the page-score example (and its cap) is left out rather than quoting a
  // number the screen does not show. The check counts stay this page's.
  const explainCtx = {
    overall: siteView ? null : overall,
    cap: siteView ? null : cap,
    checksApplied: counted.length,
    passed,
  };

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
        <Panel pad="24px 28px" elevation="md" style={{ flexDirection: 'row', alignItems: 'center', gap: 28, flexWrap: 'wrap' }} data-explain-box>
          <Donut score={hero.score} size={168} numberSize={42} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 240px', minWidth: 0 }}>
            <span className="explain-label-row">
              <Eyebrow>{siteView ? `Site average · ${scoredCount} page${scoredCount === 1 ? '' : 's'}` : 'Overall score'}</Eyebrow>
              <InfoDot
                explainKey="g_score"
                ctx={explainCtx}
                calcExtra={siteView
                  ? <SiteAverageExplainer title="Site average" score={scope.average} count={scoredCount} />
                  : <OverallExplainer breakdown={breakdown} cap={cap} composite={composite} overall={overall} bandLabel={bandLabel} seo={scores.seo} geo={scores.geo} />}
              />
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
                ? `The mean of the ${scoredCount} scored pages — the same figure as the dashboard card.`
                  + (unscoredCount ? ` ${unscoredCount} page${unscoredCount === 1 ? '' : 's'} returned an error and ${unscoredCount === 1 ? 'is' : 'are'} not scored.` : '')
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
                infoKey="g_seo"
                info={siteView
                  ? <SiteAverageExplainer title="SEO · site average" score={scope.seo} count={scoredCount} axis={siteSeo} />
                  : <AxisExplainer title="SEO score" axis={scores.seo} what="Can search engines like Google find, index and rank this page?" />}
              />
              <SideScore
                name="GEO" sub="AI answer engines" axis={hero.geo}
                infoKey="g_geo"
                info={siteView
                  ? <SiteAverageExplainer title="GEO · site average" score={scope.geo} count={scoredCount} axis={siteGeo} />
                  : <AxisExplainer title="GEO score" axis={scores.geo} engineTally={engineTally} what="Can AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Gemini) read, trust and cite this page?" />}
              />
            </div>
          )}
        </Panel>

        {/* Which page the page-level sections below (verdict, AI engines,
            findings) describe. No scores here: the Summary shows site figures
            only, and each page's own score is in the page list above. */}
        {siteView && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px',
              borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--text-2)',
            }}
          >
            <span>
              Verdict, AI engines and findings below are for <strong style={{ color: 'var(--text)' }}>{pathOf(scope.url)}</strong>
              {pageError ? ` — it returned HTTP ${pageStatus} when audited, so it is not scored` : ''}.
              {' '}Pick another page in the bar above.
            </span>
          </div>
        )}

        {/* ── SEO and GEO, separately ─────────────────────────────────────────
            The bars each side is made of, weakest first: the "why" behind the
            two numbers in the card above. Server-side calculateScores builds
            `scores.seo` / `scores.geo`; a report saved before that had them
            derived from its stored bars (withAxisScores) on the way here. */}
        {(siteView ? (siteSeo || siteGeo) : (scores.seo || scores.geo)) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <AxisCard title={siteView ? 'What drives the site’s SEO score' : 'What drives the SEO score'} axis={siteView ? siteSeo : scores.seo} sitePages={siteView ? scoredCount : null} />
            <AxisCard title={siteView ? 'What drives the site’s GEO score' : 'What drives the GEO score'} axis={siteView ? siteGeo : scores.geo} sitePages={siteView ? scoredCount : null} />
          </div>
        )}

        {/* ── Priority verdict ───────────────────────────────────────────────
            On the accent ground, which is the one place in either report that
            uses it. It earns that: this is the single sentence the whole audit
            exists to produce, and the three figures under it are what the
            sentence is worth. */}
        {summary?.priority_verdict ? (
          <div
            data-explain-box
            style={{
              display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14,
              padding: '22px 26px', borderRadius: 14, background: 'var(--primary)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <span className="explain-label-row">
              <span
                style={{
                  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.15em', textTransform: 'uppercase',
                  color: 'var(--text-on-primary)', opacity: 0.85,
                }}
              >
                Priority verdict
              </span>
              <InfoDot explainKey="g_verdict" ctx={explainCtx} tone="onAccent" />
            </span>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-on-primary)', lineHeight: 1.55 }}>
              {summary.priority_verdict}
            </p>

            {!siteView && (
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
              {cap?.applied && !siteView && (
                <OnAccent label="Blocking the score" value={cap.reason} />
              )}
              {/* Page-level figures: left out of the site view, which shows site numbers only. */}
              {weakest && !siteView && (
                <OnAccent label="Weakest bucket" value={`${weakest.label} — ${weakest.score}`} />
              )}
              {cap?.applied && composite !== null && !siteView && (
                <OnAccent label="Once fixed" value={`Score reaches ${composite}`} />
              )}
            </div>
            )}

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
          <Panel data-explain-box>
            <span className="explain-label-row">
              <Eyebrow>Priority verdict</Eyebrow>
              <InfoDot explainKey="g_verdict" ctx={explainCtx} />
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
              The AI analysis did not complete for this page, so there is no ranked verdict. The
              check results are all in “More Tech Details”.
            </span>
          </Panel>
        )}
      </div>

      {/* ── Will AI engines show this page? ──────────────────────────────── */}
      {engines.length > 0 && (
        <Panel pad="22px 24px" style={{ gap: 14 }} data-explain-box>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 620 }}>
              <span className="explain-label-row explain-label-row--title">
                <PanelTitle>Will AI engines show this page?</PanelTitle>
                <InfoDot explainKey="g_platforms" ctx={explainCtx} />
              </span>
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
          {scores.geo && !siteView && (
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
        <Panel pad="22px 24px" style={{ gap: 12 }} data-explain-box>
          <span className="explain-label-row explain-label-row--title">
            <PanelTitle>Quick wins</PanelTitle>
            <InfoDot explainKey="g_wins" ctx={explainCtx} />
          </span>
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
      {/* Labelled with how many checks apply, so the four counts read as parts
          of a whole rather than four unrelated numbers. */}
      <div data-explain-box style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 'var(--r-md)' }}>
        <span className="explain-label-row">
          <Eyebrow>Check results · {counted.length} {counted.length === 1 ? 'check applies' : 'checks apply'}</Eyebrow>
          <InfoDot explainKey="g_counts" ctx={explainCtx} />
        </span>
        <div className="geo-counts">
          <CountTile label="Passed" value={passed} color="var(--primary-text)" />
          <CountTile label="Errors" value={errors} color="var(--viz-neg)" />
          <CountTile label="Warnings" value={warnings} color="var(--viz-warn)" />
          <CountTile label="Notices" value={notices} color="var(--text-2)" />
        </div>
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
      <Legend screen="seogeo" ctx={explainCtx} />
    </div>
  );
}

/** A label/value pair drawn on the accent ground. */
// One side's score in the headline card: a compact ring, its name, and the "i"
// — whose popover carries this side's own bars and weights under the copy.
function SideScore({ name, sub, axis, info, infoKey }) {
  return (
    <div data-explain-box style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 'var(--r-md)' }}>
      <Donut score={axis?.score ?? null} size={88} numberSize={24} stroke={10} label={null} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{name}</span>
          <InfoDot explainKey={infoKey} calcExtra={info} />
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

// The "i" for a site-average figure: what it averages and, for a side, its bars
// and caps across the pages — site figures only, like the rest of the Summary.
function SiteAverageExplainer({ title, score, count, axis = null }) {
  const rows = axis ? [...axis.buckets].sort((a, b) => b.weight - a.weight) : [];
  return (
    <>
      <TipHeader title={title} score={score} band={Number.isFinite(score) ? ratingFor(score).label : null} />
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
        The mean across the {count} scored page{count === 1 ? '' : 's'} — the same number the
        dashboard card shows. Each page’s own score is in the page list above.
      </span>
      {rows.length > 0 && (
        <TipSection label="Averaged across the pages">
          <TipColumns />
          {rows.map((b) => <TipRow key={b.key} label={b.label} score={b.score} weight={b.weight} />)}
        </TipSection>
      )}
      {axis?.cap?.applied && (
        <TipCallout tone="warn" label={`Blocking cap on ${axis.cap.siteCount} of ${count} pages`}>
          {axis.cap.reasons.join(' ')}
        </TipCallout>
      )}
    </>
  );
}


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
function AxisCard({ title, axis, sitePages = null }) {
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
        {/* The cap as its own bar, so the bars add up to the score: three green
            categories beside a red 55 read as a contradiction until the thing
            holding it down is drawn too. */}
        {axis.cap?.applied && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 32px', alignItems: 'center', gap: 10, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: bandColor(axis.score), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sitePages ? `Blocking cap · ${axis.cap.siteCount} of ${sitePages} pages` : 'Blocking cap'}
            </span>
            <span style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, axis.score))}%`, background: bandColor(axis.score) }} />
            </span>
            <span className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: 'right', color: bandColor(axis.score) }}>{axis.score}</span>
          </div>
        )}
      </div>
      <span style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {axis.cap?.applied && sitePages
          ? `Held down by a blocking issue on ${axis.cap.siteCount} of ${sitePages} pages: ${axis.cap.reasons.join(' ')}`
          : axis.cap?.applied
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
