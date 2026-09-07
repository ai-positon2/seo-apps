// UNREFERENCED — kept for reference, mounted nowhere.
//
// This rendered a summary of a module's stored run above that module's own
// report: score, severity counts, findings table, run history. On a page that
// already shows the real report it duplicated it in a second visual language,
// and on Competitor Research it repeated the dashboard's own units, domains and
// keyword gap directly above them.
//
// What replaced it: the dashboard card links straight to the module's real
// report (client/src/lib/moduleReportRoute.js), and where that report renders
// from page state, ProjectReportLoader hands the stored run to it and prints one
// line saying whose report it is. The report is the report.
//
// Delete both files when you are sure the summary is not wanted anywhere.
import { Badge, DataTable, MetricCard } from '../../ui';

// ── Per-module detail, from the payload each runner already stores ────────────
//
// One renderer per module. Everything here reads a field that is genuinely in
// the stored payload — nothing is derived, averaged or inferred, so what a
// reader sees is what the run recorded.
//
// The shared rule: a value that was NOT measured renders as "not measured", not
// as 0 and not as blank. A capped crawl cannot say a page is an orphan; a page
// with no keyword cannot have its keyword placement checked. Those are the
// distinctions these sections exist to carry.

const NOT_MEASURED = 'not measured';

const row = { display: 'flex', gap: 12, flexWrap: 'wrap' };
const metrics = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 12,
};

/** A number, or an explicit "not measured" when it is null/undefined. */
function num(value, suffix = '') {
  if (value === null || value === undefined) return NOT_MEASURED;
  return `${Number(value).toLocaleString('en-US')}${suffix}`;
}

function Caveats({ items }) {
  if (!items?.length) return null;
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--r-md)',
        background: 'color-mix(in srgb, var(--warning) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: 'var(--text-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)' }}>
        What this run could not check
      </strong>
      {items.map((item, i) => <span key={i}>{item}</span>)}
    </div>
  );
}

// ── technical ───────────────────────────────────────────────────────────────
function TechnicalDetail({ payload, navigate }) {
  if (!payload) return null;
  const { pagesCrawled, externalChecked, resultCount, robotsStatus, crawlRunId } = payload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        {/* Two numbers, not one: maxUrlsPerCrawl caps the pages, external link
            checks are governed separately, and one combined figure made a
            working 50-URL cap look broken. */}
        <MetricCard label="Pages crawled" value={num(pagesCrawled)} sub="what the URL cap limits" />
        <MetricCard label="External links checked" value={num(externalChecked)} sub="capped separately" />
        <MetricCard label="Stored results" value={num(resultCount)} sub="pages + link checks" />
        <MetricCard label="robots.txt" value={robotsStatus || NOT_MEASURED} />
      </div>
      {crawlRunId && (
        <div style={row}>
          {/* One link, not two. "Review findings" pointed at a separate
              triage screen that has been folded into the report — the findings
              and the decisions about them are now the same page, so a second
              button beside this one went to the same place. */}
          <button
            type="button"
            onClick={() => navigate(`/crawl-scope/runs/${crawlRunId}`)}
            style={linkButton}
          >
            Open the full crawl run →
          </button>
        </div>
      )}
    </div>
  );
}

// ── on_page ─────────────────────────────────────────────────────────────────
function OnPageDetail({ payload, navigate }) {
  if (!payload) return null;
  const {
    pagesAudited, pagesFailed, pagesWithoutKeywords, keywordChecksStoodDown,
    pages = [], skippedPages = [], pageCap,
  } = payload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        <MetricCard label="Pages audited" value={num(pagesAudited)} sub={pageCap ? `cap ${pageCap}` : undefined} />
        <MetricCard label="Pages failed" value={num(pagesFailed)} />
        <MetricCard label="Without a keyword" value={num(pagesWithoutKeywords)} sub="keyword checks stood down" />
        <MetricCard label="Checks not run" value={num(keywordChecksStoodDown)} sub="needed a target keyword" />
      </div>

      {pagesWithoutKeywords > 0 && (
        <Caveats items={[
          `${pagesWithoutKeywords} page(s) have no target keyword, so ${keywordChecksStoodDown} `
          + 'keyword-placement check(s) did not run for them. They are not passing those checks — '
          + 'they were not checked. No keyword is guessed from a slug or heading, because every one '
          + 'of those checks would then be scored against a term nobody chose.',
        ]} />
      )}

      {pages.length > 0 && (
        <DataTable
          title="Per page"
          columns={[
            { key: 'url', label: 'URL', sortable: true },
            { key: 'keywords', label: 'Target keywords' },
            { key: 'pageType', label: 'Type', sortable: true },
            { key: 'findings', label: 'Findings', align: 'right', sortable: true },
          ]}
          rows={pages.map((p) => ({
            url: p.url,
            keywords: p.keywords?.length ? p.keywords.join(', ') : '— none set —',
            pageType: p.pageType || (p.error ? 'unreachable' : '—'),
            findings: p.error ? p.error : p.findings,
          }))}
          emptyText="No pages recorded for this run."
        />
      )}

      {skippedPages.length > 0 && (
        <Caveats items={[
          `${skippedPages.length} configured page(s) were not audited — the run stops at `
          + `${pageCap} pages: ${skippedPages.slice(0, 5).join(', ')}`,
        ]} />
      )}

      <div style={row}>
        <button type="button" onClick={() => navigate('/projects')} style={linkButton}>
          Set target keywords per page →
        </button>
      </div>
    </div>
  );
}

// ── seo_geo ─────────────────────────────────────────────────────────────────
function SeoGeoDetail({ payload }) {
  if (!payload) return null;
  const {
    scores = {}, bandBlurb, detectedSchemas = [], pageIntent, aiAnalysisPresent,
  } = payload;
  const breakdown = Array.isArray(scores.breakdown) ? scores.breakdown : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        <MetricCard label="Overall" value={num(scores.overall)} sub="after any blocker cap" />
        <MetricCard label="Uncapped composite" value={num(scores.composite)} sub="weighted mean" />
        <MetricCard label="Page intent" value={pageIntent || NOT_MEASURED} />
        <MetricCard label="Schemas found" value={num(detectedSchemas.length)} />
      </div>

      {bandBlurb && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>{bandBlurb}</p>
      )}

      {aiAnalysisPresent === false && (
        <Caveats items={[
          'The AI recommendation layer did not complete for this run, so the report opens with its '
          + 'recommendation sections empty. The checks and the score above are unaffected — they are '
          + 'measured, not written. Re-run to fill them in.',
        ]} />
      )}

      {/* The module's own cap: when a blocking issue holds the score down, the
          uncapped composite alone would overstate the page. */}
      {scores.cap?.applied && (
        <Caveats items={[
          `The score is capped at ${scores.cap.value ?? scores.overall} by a blocking issue`
          + `${scores.cap.reason ? `: ${scores.cap.reason}` : '.'} The uncapped composite was `
          + `${num(scores.composite)}.`,
        ]} />
      )}

      {breakdown.length > 0 && (
        <DataTable
          title="By bucket — worst first"
          columns={[
            { key: 'bucket', label: 'Bucket', sortable: true },
            { key: 'score', label: 'Score', align: 'right', sortable: true },
            { key: 'lost', label: 'Points lost', align: 'right', sortable: true },
            { key: 'counts', label: 'Checks' },
          ]}
          rows={breakdown.map((b) => ({
            bucket: b.bucket || b.id || b.name,
            // A bucket with no scored checks on this page is null, not 0 — the
            // module is explicit that it must not be commented on.
            score: b.score === null || b.score === undefined ? NOT_MEASURED : b.score,
            lost: b.points_lost ?? b.pointsLost ?? '—',
            counts: [
              b.errors ? `${b.errors} error` : null,
              b.warnings ? `${b.warnings} warning` : null,
              b.notices ? `${b.notices} notice` : null,
            ].filter(Boolean).join(' · ') || '—',
          }))}
        />
      )}
    </div>
  );
}

// ── agent_readiness ─────────────────────────────────────────────────────────
function AgentReadinessDetail({ payload }) {
  if (!payload) return null;
  const { site = {}, cats = [], httpScore, onPageScore } = payload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        <MetricCard label="Level" value={site.level || NOT_MEASURED} />
        <MetricCard label="HTTP checks" value={num(httpScore)} sub="weighted, out of 100" />
        <MetricCard
          label="On-page checks"
          value={onPageScore === null || onPageScore === undefined ? 'not run' : num(onPageScore)}
          sub={site.onPageMax ? `${site.onPageMax} points available` : undefined}
        />
        <MetricCard label="Categories" value={num(cats.length)} />
      </div>

      {cats.length > 0 && (
        <DataTable
          title="By category"
          columns={[
            { key: 'id', label: 'Category', sortable: true },
            { key: 'score', label: 'Score', align: 'right', sortable: true },
            { key: 'passed', label: 'Passed', align: 'right', sortable: true },
          ]}
          rows={cats.map((c) => ({
            id: c.id,
            score: num(c.score),
            passed: `${c.passed} of ${c.total}`,
          }))}
        />
      )}
    </div>
  );
}

// ── competitor ──────────────────────────────────────────────────────────────
function CompetitorDetail({ payload }) {
  if (!payload) return null;
  const {
    gapCounts = {}, usedUnits, capUnits, perDomainUnitCost, competitorCount,
    semrushDatabase, country, skipped = [], domains = [],
  } = payload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        <MetricCard label="Competitors compared" value={num(competitorCount)} />
        {/* Which market, spelled out: it is the one thing a reader cannot
            recover from the numbers afterwards. */}
        <MetricCard
          label="Market"
          value={semrushDatabase ? semrushDatabase.toUpperCase() : NOT_MEASURED}
          sub={country ? `project country ${country}` : undefined}
        />
        <MetricCard
          label="Units spent"
          value={num(usedUnits)}
          sub={perDomainUnitCost ? `${num(perDomainUnitCost)} per domain` : undefined}
        />
        <MetricCard label="Run budget" value={num(capUnits)} />
      </div>

      <DataTable
        title="Keyword gap"
        columns={[
          { key: 'kind', label: 'Gap' },
          { key: 'count', label: 'Keywords', align: 'right' },
          { key: 'meaning', label: 'What it means' },
        ]}
        rows={[
          {
            kind: 'Missing',
            count: num(gapCounts.missing),
            meaning: 'A competitor ranks; this site does not appear at all.',
          },
          {
            kind: 'Striking distance',
            count: num(gapCounts.strikingDistance),
            meaning: 'Ranks 11–50 with a competitor ahead — usually cheaper to improve than to build.',
          },
          {
            kind: 'Untapped',
            count: num(gapCounts.untapped),
            meaning: 'Ranks beyond 50 with a competitor ahead.',
          },
        ]}
      />

      {domains.length > 0 && (
        <DataTable
          title="Domains in this comparison"
          columns={[
            { key: 'domain', label: 'Domain', sortable: true },
            { key: 'role', label: 'Role' },
          ]}
          rows={domains.map((d) => ({
            domain: d.domain,
            role: d.isClient ? 'this project' : 'competitor',
          }))}
        />
      )}

      {skipped.length > 0 && (
        <Caveats items={[
          `${skipped.length} domain(s) were left out of this comparison, so it is not a comparison `
          + 'against all of them: '
          + skipped.map((s) => (typeof s === 'string' ? s : s.domain || 'unknown')).join(', '),
        ]} />
      )}
    </div>
  );
}

// ── hub_spoke ───────────────────────────────────────────────────────────────
function HubSpokeDetail({ payload, navigate }) {
  if (!payload) return null;
  const {
    clusterCount, gapHubCount, orphanCount, orphanDetectionWithheld, pagesWithNoInboundLink,
    unassignedCount, meanHealth, pagesAnalyzed, edgeCount, clusters = [],
    limitations = [], crawlRunId, contentArchitectProjectId,
  } = payload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={metrics}>
        <MetricCard label="Topic clusters" value={num(clusterCount)} />
        <MetricCard label="Clusters with no hub" value={num(gapHubCount)} sub="the clearest gaps" />
        {/* null, not 0: on a capped crawl this could not be determined, and a 0
            would claim there are none. */}
        <MetricCard
          label="Orphan pages"
          value={orphanDetectionWithheld ? 'withheld' : num(orphanCount)}
          sub={orphanDetectionWithheld ? `${num(pagesWithNoInboundLink)} had no inbound link` : undefined}
        />
        <MetricCard label="Unassigned pages" value={num(unassignedCount)} sub="met no similarity bar" />
        <MetricCard label="Pages analysed" value={num(pagesAnalyzed)} />
        <MetricCard label="Internal links used" value={num(edgeCount)} />
      </div>

      {clusters.length > 0 && (
        <DataTable
          title="Clusters"
          columns={[
            { key: 'name', label: 'Cluster', sortable: true },
            { key: 'spokes', label: 'Spokes', align: 'right', sortable: true },
            { key: 'health', label: 'Health', align: 'right', sortable: true },
            { key: 'hub', label: 'Hub' },
          ]}
          rows={clusters.map((c) => ({
            name: c.name,
            spokes: c.spokes,
            health: num(c.health),
            hub: c.isGap ? 'none — gap' : (c.hubConfidence === 'ambiguous' ? 'ambiguous' : 'selected'),
          }))}
        />
      )}

      <Caveats items={limitations} />

      <div style={row}>
        {contentArchitectProjectId && (
          <button
            type="button"
            onClick={() => navigate(`/content-architect/${contentArchitectProjectId}`)}
            style={linkButton}
          >
            Open in Content Architect →
          </button>
        )}
        {crawlRunId && (
          <button type="button" onClick={() => navigate(`/crawl-scope/runs/${crawlRunId}`)} style={linkButton}>
            The crawl this came from →
          </button>
        )}
      </div>
    </div>
  );
}

const linkButton = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 12.5,
  fontFamily: 'var(--font-sans)',
  color: 'var(--primary-text)',
};

const SECTIONS = {
  technical: TechnicalDetail,
  on_page: OnPageDetail,
  seo_geo: SeoGeoDetail,
  agent_readiness: AgentReadinessDetail,
  competitor: CompetitorDetail,
  hub_spoke: HubSpokeDetail,
};

/**
 * The detail block for one module, or null when there is nothing stored.
 *
 * A module with no renderer yet returns null rather than throwing — the panel
 * around it still shows the card, the findings and the history.
 */
export default function ModuleDetailSection({ moduleKey, payload, navigate }) {
  const Section = SECTIONS[moduleKey];
  if (!Section || !payload) return null;
  return <Section payload={payload} navigate={navigate} />;
}

export { Caveats, NOT_MEASURED };
