import { Panel, Tile, Eyebrow, AnalyzingNotice } from './reportPrimitives';
import { healthScoreBreakdown } from '../crawlHelpers';

// ── The crawl report's Overview ─────────────────────────────────────────────
//
// Three things, and nothing else: the score, what it is made of, and what to do
// first. This replaced a two-column layout of eleven cards — executive summary,
// SEO snapshot quadrants, three charts, a count-reconciliation panel, a media
// library, an integrations inventory and a backlog trend — which between them
// answered every question except the one the reader arrived with.
//
// The score is the crawler's own (crawlHelpers.healthMetrics), and the bars
// beside it are its actual arithmetic, not a decorative breakdown: the same
// 45/22/8 weights, each scaled by the share of HTML pages it touches. A client
// asked to trust a number is owed the formula, so the formula is on screen.

/**
 * @param {object} props
 * @param {object} props.metrics   healthMetrics(pages, findings) — per-severity
 *   affected-page counts and the score
 * @param {object} props.counts    urlsFetched / htmlPages / occurrences / issueTypes
 * @param {Array}  props.groups    one row per rule that fired, page- and
 *   site-scoped merged, each carrying `count` (occurrences) and `pages`
 * @param {Map}    props.catalogById    rule id → catalog entry
 * @param {number} props.externalChecked
 * @param {boolean} props.provisional  a crawl is still running, so `findings` is
 *   empty and everything derived from it is not yet a measurement
 * @param {object?} props.reconciliation  the analyser's own finding totals
 *   against what this page received — see the note at its render below
 * @param {object?} props.coverage  { limit, partial, reasons } — the crawl's
 *   page budget and why it stopped short, if it did
 */
export default function OverviewPanel({
  metrics, counts, groups, catalogById, externalChecked, provisional = false, crawled = null,
  reconciliation = null, coverage = null,
}) {
  const breakdown = healthScoreBreakdown(metrics);
  const lost = breakdown.reduce((sum, b) => sum + b.points, 0);
  // Withheld while the crawl runs.
  //
  // The score divides affected pages by HTML pages, and until the crawl
  // reaches a terminal state the only findings are the crawler's dozen live
  // status checks — so the arithmetic returns something close to 100 and this
  // card prints a confident green score for a site nothing has audited. A
  // score that is wrong in the reassuring direction is the worst thing this
  // page can do (§16.11), so there is no score until there is a measurement.
  const health = provisional ? null : metrics.health;
  const healthColor = health === null
    ? 'var(--text-3)'
    : health >= 80 ? 'var(--primary)' : health >= 60 ? 'var(--viz-warn)' : 'var(--viz-neg)';

  // The widest bar is the biggest deduction, not a share of 100 — with a
  // healthy site every bar would otherwise be a sliver and the panel would say
  // nothing about which band cost the most.
  const worst = Math.max(1, ...breakdown.map((b) => b.points));

  const bySeverity = (s) => groups.filter((g) => g.severity === s);
  // Findings, not pages: one page can trip the same check twice.
  const occurrences = (s) => bySeverity(s).reduce((sum, g) => sum + (g.count || 0), 0);

  return (
    <div className="crawl-overview">
      <Panel pad="24px" elevation="md" style={{ gap: 16 }}>
        <Eyebrow>Site health</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <span
            className="num"
            style={{ fontSize: 64, fontWeight: 600, lineHeight: 0.9, color: healthColor }}
          >
            {health === null ? '—' : health}
          </span>
          <span style={{ fontSize: 16, color: 'var(--text-3)', paddingBottom: 6 }}>
            {health === null ? 'not scored' : 'out of 100'}
          </span>
        </div>

        <div style={{ height: 1, background: 'var(--border)' }} />

        {health === null ? (
          <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
            {provisional
              ? 'Not scored yet. The score comes from the full audit, which runs once '
                + 'the crawl reaches a terminal state — scoring the live status checks instead '
                + 'would print a near-perfect number for a site nothing has audited.'
              : 'No HTML pages were crawled, so there is nothing to score. A score of zero '
                + 'would describe a catastrophic site rather than an absent crawl.'}
          </span>
        ) : (
          <>
            <span
              style={{
                fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                fontWeight: 600, color: 'var(--text-3)',
              }}
            >
              {lost ? `How the ${lost} points were lost` : 'Nothing was deducted'}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {breakdown.map((b) => (
                <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                      {b.pages} of {metrics.htmlCount} page{b.pages === 1 ? '' : 's'}
                      {' '}
                      {b.label === 'Errors' ? 'have an error'
                        : b.label === 'Warnings' ? 'have a warning' : 'have a notice'}
                    </span>
                    <span
                      className="num"
                      style={{ fontSize: 13, fontWeight: 600, color: BAND_COLOR[b.label] }}
                    >
                      −{b.points}
                    </span>
                  </div>
                  <div style={{ height: 5, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%', borderRadius: 999, background: BAND_COLOR[b.label],
                        width: `${Math.round((b.points / worst) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {/* The weights, said out loud. Without them the bars are three
                numbers whose relative size looks arbitrary. */}
            <span style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
              Starting from 100, an error band costs up to 45 points, a warning 22 and a notice 8
              — each scaled by the share of the site’s {metrics.htmlCount} HTML pages it touches.
              External pages the crawler followed are excluded from both sides.
            </span>
          </>
        )}
      </Panel>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="crawl-tiles">
          <Tile
            label="Pages crawled"
            value={counts.urlsFetched.toLocaleString()}
            sub={coverage?.limit
              ? `Every URL the crawler fetched · budget ${coverage.limit.toLocaleString('en-US')} pages`
              : 'Every URL the crawler fetched'}
          />
          <Tile
            label="HTML pages"
            value={metrics.htmlCount.toLocaleString()}
            sub={metrics.refusedCount
              ? `The audit universe — ${metrics.refusedCount.toLocaleString()} URL${metrics.refusedCount === 1 ? '' : 's'} refused the crawler and ${metrics.refusedCount === 1 ? 'is' : 'are'} not counted`
              : 'The audit universe — the rest are files and feeds'}
          />
          <Tile
            label="Findable by Google"
            value={metrics.indexable.toLocaleString()}
            sub={`of ${metrics.htmlCount.toLocaleString()} HTML pages are indexable`}
            color="var(--primary)"
          />
          {/* An em dash, not a zero. "0 pages with an error" is a claim, and
              while the crawl runs nothing has checked. */}
          <Tile
            label="Pages with an error"
            value={provisional ? '—' : metrics.affectedErrorPages.toLocaleString()}
            sub={provisional
              ? 'Not measured until the crawl finishes'
              : `${bySeverity('error').length} distinct cause${bySeverity('error').length === 1 ? '' : 's'} · ${occurrences('error')} findings`}
            color={provisional ? 'var(--text-3)' : 'var(--viz-neg)'}
          />
          <Tile
            label="Pages with a warning"
            value={provisional ? '—' : metrics.affectedWarningPages.toLocaleString()}
            sub={provisional
              ? 'Not measured until the crawl finishes'
              : `${bySeverity('warning').length} distinct cause${bySeverity('warning').length === 1 ? '' : 's'} · ${occurrences('warning')} findings`}
            color={provisional ? 'var(--text-3)' : 'var(--viz-warn)'}
          />
          <Tile
            label="External links checked"
            value={externalChecked.toLocaleString()}
            sub="Outbound links fetched to verify they are live"
          />
        </div>

        {/* ── Did the crawl reach the whole site? ────────────────────────
            Every score on this page is a score of the pages the crawl saw. When
            it stopped short, that turns "your site scores 88" into "the part we
            reached scores 88" — a different claim, and one the reader cannot
            make for themselves because the reason is only in the stored
            summary. The crawler records why; this is where it gets said. */}
        {coverage?.partial && (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px',
              borderRadius: 10,
              background: 'color-mix(in srgb, var(--viz-warn) 12%, var(--card))',
              border: '1px solid color-mix(in srgb, var(--viz-warn) 45%, var(--border))',
            }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
              This crawl did not reach the whole site, so every figure here describes the part it
              did reach.
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
              {coverage.reasons.join('; ')}.
              {coverage.limit
                ? ` Raise the page budget in the client’s settings — it is ${coverage.limit.toLocaleString('en-US')} — and crawl again.`
                : ''}
            </span>
          </div>
        )}

        {/* ── Is this the whole audit? ───────────────────────────────────
            One line answering the question a reader cannot otherwise answer:
            does this page show everything the analyser found. The two figures
            come from different places — the analyser's own summary, written at
            crawl completion, and the findings this page was served — so
            agreement is meaningful and disagreement is a defect.

            The old report had a whole "Count reconciliation" card for this
            family of check. It was dropped in the redesign, correctly: four
            metric tiles reconciling units nobody had asked about. This is the
            one assertion in it that earns its place, at one line. */}
        {reconciliation && (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px',
              borderRadius: 10,
              background: reconciliation.agrees
                ? 'var(--surface)'
                : 'color-mix(in srgb, var(--viz-neg) 12%, var(--card))',
              border: `1px solid ${reconciliation.agrees
                ? 'var(--border)'
                : 'color-mix(in srgb, var(--viz-neg) 45%, var(--border))'}`,
            }}
          >
            <span
              style={{
                fontSize: 12.5,
                color: reconciliation.agrees ? 'var(--text-2)' : 'var(--viz-neg)',
                lineHeight: 1.5,
              }}
            >
              {reconciliation.agrees
                ? `Complete: the analyser recorded ${reconciliation.analyser.toLocaleString()} `
                  + 'findings and this page is showing all of them.'
                : reconciliation.notStored
                  // The audit ran and its output was not kept — the failure
                  // migration 0023 exists to end. Saying "this page received
                  // fewer" would point the reader at the screen, which is not
                  // where the problem is.
                  ? `The audit ran and its results were not saved: the crawl recorded `
                    + `${reconciliation.analyser.toLocaleString()} findings and the run holds none. `
                    + 'Nothing here can be fixed by reloading — the crawl needs re-running, and '
                    + 'this is worth reporting.'
                  : `Incomplete: the analyser recorded ${reconciliation.analyser.toLocaleString()} `
                    + `findings and this page received ${reconciliation.shown.toLocaleString()}. `
                    + 'Every figure above understates the site — please report this.'}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {reconciliation.rows
                .filter((r) => r.analyser || r.shown)
                .map((r) => `${r.sev} ${r.shown}/${r.analyser}`)
                .join('  ·  ')}
              {reconciliation.dismissed ? `  ·  ${reconciliation.dismissed} dismissed` : ''}
            </span>
            {/* Where the findings sit, shown only when the two sides disagree.
                A gap is far more often a population mismatch than lost data —
                naming the scopes makes it diagnosable rather than alarming. */}
            {!reconciliation.agrees && reconciliation.byScope && (
              <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                by scope: {Object.entries(reconciliation.byScope)
                  .map(([scope, n]) => `${scope} ${n}`)
                  .join('  ·  ')}
              </span>
            )}
          </div>
        )}

        <Panel style={{ gap: 12 }}>
          <span
            style={{
              fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
              fontWeight: 600, color: 'var(--text-3)',
            }}
          >
            What to do first
          </span>
          {/* Nothing while the crawl runs. This is the first three rows of the
              issue list, ranked by severity then reach — and until the full
              audit has run, the only candidates are the crawler's live status
              checks. "Fix these three redirects first" is bad advice offered
              with confidence, which is worse than no advice. */}
          {provisional && <AnalyzingNotice crawled={crawled} />}

          {/* The top three problems in the order the report already ranks them
              — severity, then how many pages they touch — with the catalog's own
              remediation under each. Nothing is composed here: this is the first
              three rows of the list on the next tab, so the two cannot disagree
              about what matters most. */}
          {!provisional && groups.slice(0, 3).map((g, i) => {
            const entry = catalogById.get(g.id);
            return (
              <div key={g.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <span
                  className="num"
                  style={{
                    fontSize: 13, fontWeight: 600, color: 'var(--text-3)', width: 18,
                    flexShrink: 0, paddingTop: 2,
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: 'var(--text)' }}>
                    {entry?.title || g.label || g.id}
                    {' — '}
                    {g.pages} page{g.pages === 1 ? '' : 's'}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.45 }}>
                    {entry?.recommendation || 'No remediation is recorded for this check.'}
                  </span>
                </div>
              </div>
            );
          })}
          {!groups.length && !provisional && (
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              Nothing outstanding — this crawl found no page-level problems.
            </span>
          )}
        </Panel>
      </div>
    </div>
  );
}

const BAND_COLOR = {
  Errors: 'var(--viz-neg)',
  Warnings: 'var(--viz-warn)',
  Notices: 'var(--text-3)',
};
