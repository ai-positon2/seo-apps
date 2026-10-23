import { Panel, Eyebrow, AnalyzingNotice } from './reportPrimitives';
import { healthScoreBreakdown, HEALTH_WEIGHTS } from '../crawlHelpers';
import { InfoTip } from '../../seoGeo/report/reportKit';
import { scoreVerdict } from '../../../lib/scoreVerdict';

// ── The crawl report's Overview ─────────────────────────────────────────────
//
// Three things, and nothing else: the score, what it is made of, and what to do
// first. This replaced a two-column layout of eleven cards — executive summary,
// SEO snapshot quadrants, three charts, a count-reconciliation panel, a media
// library, an integrations inventory and a backlog trend — which between them
// answered every question except the one the reader arrived with.
//
// The score is the crawler's own (crawlHelpers.healthMetrics), and the bars
// beside it are its actual arithmetic, not a decorative breakdown: the points
// each severity cost (crawlHelpers HEALTH_WEIGHTS, per distinct rule per page,
// averaged over the audited pages). A client asked to trust a number is owed
// the formula, so the formula is on screen.

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
  reconciliation = null, coverage = null, comparison = null,
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
  // Same words and bands as the dashboard (lib/scoreVerdict: 80 / 60).
  const verdict = health === null ? null : scoreVerdict(health);


  const bySeverity = (s) => groups.filter((g) => g.severity === s);
  // Findings, not pages: one page can trip the same check twice.
  const occurrences = (s) => bySeverity(s).reduce((sum, g) => sum + (g.count || 0), 0);

  return (
    <div className="crawl-overview">
      <Panel pad="22px 22px 20px" elevation="md" style={{ gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Eyebrow>Site health</Eyebrow>
          {health !== null && (
            <InfoTip label="How the site health score is calculated" align="left">
              <HealthExplainer health={health} breakdown={breakdown} htmlCount={metrics.htmlCount} />
            </InfoTip>
          )}
        </div>

        {/* The score as a ring that also shows where the rest of the 100 went:
            the score in its band colour, then one slice per severity for the
            points it cost. The ring and the rows below are the same numbers. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <HealthRing health={health} color={healthColor} breakdown={breakdown} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            {verdict ? (
              <span
                style={{
                  alignSelf: 'flex-start', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                  color: healthColor, background: `color-mix(in srgb, ${healthColor} 14%, var(--card))`,
                }}
              >
                {verdict.label}
              </span>
            ) : null}
            <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              {health === null
                ? (provisional ? 'Scored when the crawl finishes.' : 'No HTML pages to score.')
                : `Average across ${metrics.htmlCount.toLocaleString()} audited page${metrics.htmlCount === 1 ? '' : 's'}.`}
            </span>
          </div>
        </div>

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-3)' }}>
              {lost ? `Where the ${lost} points went` : 'Nothing was deducted'}
            </span>
            {breakdown.map((b) => {
              const share = metrics.htmlCount ? b.pages / metrics.htmlCount : 0;
              return (
                <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: BAND_COLOR[b.label], flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{b.label}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        {b.pages.toLocaleString()} of {metrics.htmlCount.toLocaleString()} pages
                      </span>
                    </span>
                    <span
                      className="num"
                      style={{
                        fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 999, flexShrink: 0,
                        color: BAND_COLOR[b.label], background: `color-mix(in srgb, ${BAND_COLOR[b.label]} 12%, var(--card))`,
                      }}
                    >
                      −{b.points} pts
                    </span>
                  </div>
                  {/* The share of pages this band touches. */}
                  <div style={{ height: 6, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 999, background: BAND_COLOR[b.label], width: `${Math.max(share * 100, b.pages ? 1.5 : 0)}%` }} />
                  </div>
                </div>
              );
            })}
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Bars show the share of pages affected · tap <strong style={{ fontWeight: 600 }}>i</strong> for the formula
            </span>
          </div>
        )}
      </Panel>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="crawl-tiles">
          <StatTile
            icon="globe"
            // "Pages crawled" here counted every URL (images, scripts, files)
            // while the dashboard's "Pages crawled" counts HTML pages — two
            // different numbers under one name. This tile is the URL count.
            label="URLs fetched"
            value={counts.urlsFetched.toLocaleString()}
            sub={coverage?.limit
              ? `Pages, images and files · page limit ${coverage.limit.toLocaleString('en-US')}`
              : 'Pages, images and files'}
          />
          <StatTile
            icon="page"
            label="HTML pages"
            value={metrics.htmlCount.toLocaleString()}
            sub={metrics.refusedCount
              ? `The audit universe — ${metrics.refusedCount.toLocaleString()} URL${metrics.refusedCount === 1 ? '' : 's'} refused the crawler and ${metrics.refusedCount === 1 ? 'is' : 'are'} not counted`
              : 'The audit universe — the rest are files and feeds'}
          />
          <StatTile
            icon="search"
            label="Findable by Google"
            value={metrics.indexable.toLocaleString()}
            sub={`of ${metrics.htmlCount.toLocaleString()} HTML pages are indexable`}
            color="var(--primary)"
            share={metrics.htmlCount ? metrics.indexable / metrics.htmlCount : null}
          />
          {/* An em dash, not a zero. "0 pages with an error" is a claim, and
              while the crawl runs nothing has checked. */}
          <StatTile
            icon="error"
            label="Pages with an error"
            value={provisional ? '—' : metrics.affectedErrorPages.toLocaleString()}
            sub={provisional
              ? 'Not measured until the crawl finishes'
              : `${bySeverity('error').length} type${bySeverity('error').length === 1 ? '' : 's'} of problem · ${occurrences('error')} instances`}
            color={provisional ? 'var(--text-3)' : 'var(--viz-neg)'}
            share={!provisional && metrics.htmlCount ? metrics.affectedErrorPages / metrics.htmlCount : null}
          />
          <StatTile
            icon="warning"
            label="Pages with a warning"
            value={provisional ? '—' : metrics.affectedWarningPages.toLocaleString()}
            sub={provisional
              ? 'Not measured until the crawl finishes'
              : `${bySeverity('warning').length} type${bySeverity('warning').length === 1 ? '' : 's'} of problem · ${occurrences('warning')} instances`}
            color={provisional ? 'var(--text-3)' : 'var(--viz-warn)'}
            share={!provisional && metrics.htmlCount ? metrics.affectedWarningPages / metrics.htmlCount : null}
          />
          <StatTile
            icon="link"
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
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.5 }}>
              <NoticeIcon kind="warn" />
              This crawl did not reach the whole site, so every figure here describes the part it
              did reach.
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
              {coverage.reasons.join('; ')}.
              {coverage.limit && coverage.budgetReached
                ? ` Raise the page limit in the client’s settings — it is ${coverage.limit.toLocaleString('en-US')} — and crawl again.`
                : ''}
            </span>
          </div>
        )}

        {/* ── Against the previous crawl of the site ──────────────────────
            Issues are matched across crawls by rule, page and target, so a
            count that moved in a finding's wording is not a new issue. */}
        {comparison && (
          <div
            style={{
              padding: '12px 16px', borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
              <NoticeIcon kind="compare" />{comparison.sentence}
            </span>
          </div>
        )}

        {/* ── Checks this crawl could not run ─────────────────────────────
            A check that did not run found nothing, and nothing reads as a
            pass. The analyzer says which checks the crawl's settings or shape
            kept from running (coverage.notEvaluated) and which ran on part of
            the site (coverage.partial); this names them. */}
        {(coverage?.notEvaluated?.length > 0 || coverage?.partlyChecked?.length > 0
          || coverage?.pagesNotAudited?.length > 0) && (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px',
              borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--border)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.5 }}>
              <NoticeIcon kind="info" />
              Not every check could run on this crawl. These found nothing because they were not
              evaluated, not because they passed.
            </span>
            {coverage.notEvaluated.map(({ reason, titles }) => (
              <span key={`n-${reason}`} style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                <strong style={{ fontWeight: 600, color: 'var(--text)' }}>Not evaluated:</strong>
                {' '}{titles.join(', ')}. {reason}
              </span>
            ))}
            {coverage.partlyChecked.map(({ reason, titles }) => (
              <span key={`p-${reason}`} style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                <strong style={{ fontWeight: 600, color: 'var(--text)' }}>Partly checked:</strong>
                {' '}{titles.join(', ')}. {reason}
              </span>
            ))}
            {(coverage.pagesNotAudited || []).map((reason) => (
              <span key={`a-${reason}`} style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                <strong style={{ fontWeight: 600, color: 'var(--text)' }}>Not audited:</strong>
                {' '}{reason}
              </span>
            ))}
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
                display: 'flex', alignItems: 'flex-start', gap: 8,
                fontSize: 12.5,
                color: reconciliation.agrees ? 'var(--text-2)' : 'var(--viz-neg)',
                lineHeight: 1.5,
              }}
            >
              <NoticeIcon kind={reconciliation.agrees ? 'ok' : 'bad'} />
              <span>
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
                  : reconciliation.capped
                    // The report reads at most this many findings at once; the
                    // run itself holds them all.
                    ? `Partial: this crawl produced ${reconciliation.capped.total.toLocaleString()} findings `
                      + `and the report reads the first ${reconciliation.capped.shown.toLocaleString()}, its limit, `
                      + 'so every figure above covers those. The Excel export has the same limit.'
                    : `Incomplete: the analyser recorded ${reconciliation.analyser.toLocaleString()} `
                      + `findings and this page received ${reconciliation.shown.toLocaleString()}. `
                      + 'Every figure above understates the site — please report this.'}
              </span>
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
            What to fix first
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
            const sev = SEVERITY[g.severity] || SEVERITY.notice;
            return (
              <div
                key={g.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px', borderRadius: 12,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderLeft: `3px solid ${sev.color}`,
                }}
              >
                <span
                  className="num"
                  style={{
                    width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
                    color: sev.color, background: `color-mix(in srgb, ${sev.color} 14%, var(--card))`,
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
                    {entry?.title || g.label || g.id}
                  </span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Chip color={sev.color}>{sev.label}</Chip>
                    <Chip color="var(--text-2)">{g.pages.toLocaleString()} page{g.pages === 1 ? '' : 's'}</Chip>
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
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

const SEVERITY = {
  error: { label: 'Error', color: 'var(--viz-neg)' },
  warning: { label: 'Warning', color: 'var(--viz-warn)' },
  notice: { label: 'Notice', color: 'var(--text-3)' },
};

/**
 * The score as a ring: the score's own arc in its band colour, then one arc per
 * severity for the points it cost, so the whole circle is the 100 the score
 * started from. Small gaps between arcs keep adjacent slices readable.
 */
function HealthRing({ health, color, breakdown, size = 132 }) {
  const stroke = 12; const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const gap = 1.4; // in score points
  const arcs = health === null ? [] : [
    { value: health, color },
    ...breakdown.filter((b) => b.points > 0).map((b) => ({ value: b.points, color: BAND_COLOR[b.label], faded: true })),
  ];
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={health === null ? 'Not scored' : `Site health ${health} out of 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface)" strokeWidth={stroke} />
        {arcs.map((a, i) => {
          const len = Math.max(0, (a.value - gap) / 100) * c;
          const el = (
            <circle
              key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={a.color} strokeWidth={stroke} strokeLinecap="butt"
              strokeDasharray={`${len} ${c}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              opacity={a.faded ? 0.55 : 1}
            />
          );
          offset += (a.value / 100) * c;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span className="num" style={{ fontSize: 40, fontWeight: 700, lineHeight: 1, color }}>{health === null ? '—' : health}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{health === null ? 'not scored' : 'out of 100'}</span>
      </div>
    </div>
  );
}

/** The "i": the formula as steps, and this crawl's own arithmetic. */
function HealthExplainer({ health, breakdown, htmlCount }) {
  const step = (n, text) => (
    <span style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span className="num" style={{
        width: 18, height: 18, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 10.5, fontWeight: 700, background: 'var(--surface-2, var(--surface))',
        color: 'var(--text-2)', border: '1px solid var(--border)',
      }}>{n}</span>
      <span>{text}</span>
    </span>
  );
  const sum = `100 ${breakdown.map((b) => `− ${b.points}`).join(' ')} = ${health}`;
  return (
    <>
      <strong style={{ color: 'var(--text)', fontSize: 13.5 }}>How site health is scored</strong>
      <span>A measure of how many technical problems the crawl found, across every page it audited.</span>
      {step(1, 'Every audited page starts at 100.')}
      {step(2, `It loses ${HEALTH_WEIGHTS.error} points for each kind of error it has, ${HEALTH_WEIGHTS.warning} for each kind of warning and ${HEALTH_WEIGHTS.notice} for each kind of notice — never below 0.`)}
      {step(3, `The site score is the average across the ${htmlCount.toLocaleString()} HTML pages audited.`)}
      <span
        className="num"
        style={{
          padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2, var(--surface))',
          border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text)', fontWeight: 600,
        }}
      >
        This crawl: {sum}
      </span>
      <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5 }}>
        <span><span style={{ color: 'var(--primary)', fontWeight: 700 }}>80+</span> Good</span>
        <span><span style={{ color: 'var(--viz-warn)', fontWeight: 700 }}>60–79</span> Needs attention</span>
        <span><span style={{ color: 'var(--viz-neg)', fontWeight: 700 }}>&lt;60</span> At risk</span>
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        Not counted as pages: redirects, error pages, external pages and links checked past the crawl limit.
      </span>
    </>
  );
}

const ICONS = {
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  page: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  error: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
  warning: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17v.5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
};

/** A stat with an icon, and — where a share means something — a meter. */
function StatTile({ icon, label, value, sub, color = 'var(--text)', share = null }) {
  const accent = color === 'var(--text)' ? 'var(--text-2)' : color;
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 18px', borderRadius: 12,
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', color: accent, background: `color-mix(in srgb, ${accent} 12%, var(--card))`,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {ICONS[icon]}
          </svg>
        </span>
        <span style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-3)' }}>
          {label}
        </span>
      </div>
      <span className="num" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1, color }}>{value}</span>
      {share !== null && Number.isFinite(share) && (
        <div style={{ height: 5, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 999, background: accent, width: `${Math.max(Math.min(share, 1) * 100, share > 0 ? 1.5 : 0)}%` }} />
        </div>
      )}
      {sub && <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.4 }}>{sub}</span>}
    </div>
  );
}

function Chip({ children, color }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color,
      background: `color-mix(in srgb, ${color} 10%, var(--card))`, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
    }}>
      {children}
    </span>
  );
}

/** A small icon at the start of a notice: what kind of note it is, at a glance. */
function NoticeIcon({ kind }) {
  const tone = kind === 'warn' ? 'var(--viz-warn)' : kind === 'bad' ? 'var(--viz-neg)' : kind === 'ok' ? 'var(--primary)' : 'var(--text-3)';
  const path = {
    warn: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17v.5" /></>,
    bad: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
    ok: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.8 2.8L16.5 9.5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
    compare: <><path d="M7 7h11l-3-3M17 17H6l3 3" /></>,
  }[kind];
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
      {path}
    </svg>
  );
}
