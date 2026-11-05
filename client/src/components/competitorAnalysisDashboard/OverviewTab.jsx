import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { DataTable } from '../../ui/DataTable';
import { fmtNum, domainLabel, computeClientStat, unlessFailed, brandedCountText, hasBrandedShare } from './utils';
import { KpiScorecard } from './charts/KpiScorecard';
import { RankedBarChart } from './charts/RankedBarChart';
import { ScoreCompare } from './charts/ScoreCompare';
import { CompositionBar } from './charts/CompositionBar';
import { CollapsibleTable } from './charts/CollapsibleTable';
import { InfoDot, Legend, competitiveScoreSentence } from '../explain';
import { compWorking } from '../chat/screenWorking';

// ── Market position: context, not a grade ──────────────────────────────────
//
// This was a 0–100 "Competitive score" — your traffic ÷ the strongest rival's,
// capped at 100. It measured company size: a local practice against a national
// chain, or a firm against IBM, scored near 0 (13 of 18 clients scored 0–14),
// and leads were hidden (Nike's 906% showed as 100). It is shown as what it is:
// a share of the leader's traffic, uncapped, beside the median rival's, dated.
const pctOf = (ratio) => {
  const pct = ratio * 100;
  return `${pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct).toLocaleString()}%`;
};

function MarketPositionCard({ trafficScore, ctx, domains = [], capturedAt = null }) {
  const has = Number.isFinite(trafficScore?.ratio);
  const rivals = domains
    .filter((d) => !d.isClient && Number(d.domainRank?.organicTraffic) > 0)
    .map((d) => Number(d.domainRank.organicTraffic))
    .sort((a, b) => a - b);
  const median = rivals.length
    ? (rivals.length % 2 ? rivals[(rivals.length - 1) / 2] : (rivals[rivals.length / 2 - 1] + rivals[rivals.length / 2]) / 2)
    : null;
  const vsMedian = has && median ? trafficScore.clientTraffic / median : null;
  const date = capturedAt ? new Date(capturedAt) : null;
  return (
    <div
      data-explain-box
      style={{
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
        padding: '20px 24px', borderRadius: 'var(--r-lg)', background: 'var(--card)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="explain-label-row">
          <span className="eyebrow">Market position</span>
          <InfoDot explainKey="c_score" ctx={ctx} />
        </span>
        <span className="num" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1, color: 'var(--text)' }}>
          {has ? pctOf(trafficScore.ratio) : '—'}
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {has ? `of ${trafficScore.strongestDomain}’s search traffic` : 'not measured'}
        </span>
      </div>
      <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text-2)' }}>
          {competitiveScoreSentence(trafficScore)}
        </span>
        {vsMedian !== null && rivals.length > 1 && (
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Against the median of the {rivals.length} rivals tracked: {pctOf(vsMedian)} of their traffic.
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Semrush monthly estimates{date && Number.isFinite(date.getTime()) ? `, taken ${date.toLocaleDateString()}` : ''}.
          Context for where the site stands, not a grade.
        </span>
      </div>
    </div>
  );
}

// What a Keyword Mix row says instead of a bar it cannot honestly draw.
function brandedShareNote(d) {
  if (d.brandedKeywordCountCapped) return `${brandedCountText(d)} branded keywords · share not measured (count capped)`;
  return 'Branded count not measured';
}

export default function OverviewTab({ snapshot }) {
  const domains = snapshot?.domains || [];
  const hasAio = domains.some((d) => (d.aioKeywordCount || 0) > 0);
  // A figure whose Semrush call failed is unknown, not 0 (older snapshots
  // stored 0 there and named the failed call in fetchErrors).
  const traffic = unlessFailed('domainRank', (d) => d.domainRank?.organicTraffic);
  const authority = unlessFailed('backlinksOverview', (d) => d.authorityScore);
  const backlinks = unlessFailed('backlinksOverview', (d) => d.backlinks?.totalBacklinks);
  const refDomains = unlessFailed('backlinksOverview', (d) => d.backlinks?.referringDomains);
  const brandedCapped = domains.some((d) => d.brandedKeywordCountCapped);
  // Runs before per-domain brand terms stored none (brandTerm is new).
  const legacyBrand = domains.some((d) => !d.isClient) && !domains.some((d) => d.brandTerm);

  const rows = domains.map((d) => ({
    id: d.domain,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {domainLabel(d)}
        {d.isClient && <Badge variant="brand">Client</Badge>}
        {d.fetchErrors?.length > 0 && (
          <span title={`Fetch failed for: ${d.fetchErrors.join(', ')} — numbers below are unverified, not confirmed zero`}>
            <Badge variant="warning">Data incomplete</Badge>
          </span>
        )}
      </span>
    ),
    organicKeywords: d.domainRank.organicKeywords,
    organicTraffic: d.domainRank.organicTraffic,
    authorityScore: authority(d),
    totalBacklinks: backlinks(d),
    referringDomains: refDomains(d),
    aioKeywordCount: d.aioKeywordCount,
    brandedKeywordCount: brandedCountText(d),
    nonBrandedKeywordCount: hasBrandedShare(d) ? d.nonBrandedKeywordCount : null,
  }));

  const columns = [
    { key: 'label', label: 'Domain', sortable: false },
    { key: 'organicKeywords', label: 'Organic Keywords', align: 'right', mono: true, render: fmtNum },
    { key: 'organicTraffic', label: 'Organic Traffic', align: 'right', mono: true, render: fmtNum },
    { key: 'authorityScore', label: 'Authority Score', align: 'right', mono: true, render: fmtNum },
    { key: 'totalBacklinks', label: 'Backlinks', align: 'right', mono: true, render: fmtNum },
    { key: 'referringDomains', label: 'Ref. Domains', align: 'right', mono: true, render: fmtNum },
    { key: 'aioKeywordCount', label: 'AIO Kw', align: 'right', mono: true, render: fmtNum },
    { key: 'brandedKeywordCount', label: 'Branded Kw', align: 'right', mono: true },
    { key: 'nonBrandedKeywordCount', label: 'Non-Branded Kw', align: 'right', mono: true, render: fmtNum },
  ];

  if (!domains.length) {
    return <DataTable title="Domain Comparison" columns={columns} rows={rows} emptyText="No data yet — run an analysis." />;
  }

  // What the info icons and the legend quote. A snapshot served before the
  // score was attached reads as "not measured", not as 0.
  const explainCtx = {
    trafficScore: snapshot?.trafficScore ?? null,
    competitorCount: domains.filter((d) => !d.isClient).length,
  };
  const titled = (text, key) => (
    <span className="explain-label-row explain-label-row--title">
      {text}
      <InfoDot explainKey={key} ctx={explainCtx} />
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <MarketPositionCard trafficScore={explainCtx.trafficScore} ctx={explainCtx} domains={domains} capturedAt={snapshot?.capturedAt || null} />

      {/* KPI scorecard strip — where do we stand, at a glance */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <KpiScorecard label="Organic Traffic" info="c_traffic" infoCtx={explainCtx} stat={computeClientStat(domains, traffic)} />
        <KpiScorecard label="Organic Keywords" info="c_keywords" infoCtx={explainCtx} stat={computeClientStat(domains, (d) => d.domainRank.organicKeywords)} />
        <KpiScorecard label="Authority Score" info="c_authority" infoCtx={explainCtx} stat={computeClientStat(domains, authority)} />
        <KpiScorecard label="Backlinks" info="c_backlinks" infoCtx={explainCtx} stat={computeClientStat(domains, backlinks)} />
      </div>

      {/* Magnitude metrics — ranked bars, small multiples 2x2 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <Card title={titled('Organic Traffic', 'c_traffic')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={traffic} />
        </Card>
        <Card title={titled('Organic Keywords', 'c_keywords')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={(d) => d.domainRank.organicKeywords} />
        </Card>
        <Card title={titled('Backlinks', 'c_backlinks')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={backlinks} />
        </Card>
        <Card title={titled('Referring Domains', 'c_backlinks')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={refDomains} />
        </Card>
      </div>

      {/* Authority Score — bounded 0-100, gauge/lollipop not a bar */}
      <Card title={titled('Authority Score', 'c_authority')} data-explain-box>
        <ScoreCompare domains={domains} valueFn={authority} />
      </Card>

      {/* Keyword mix — composition, not magnitude */}
      <Card
        title={titled('Keyword Mix — Branded vs. Non-Branded', 'c_mix')}
        data-explain-box
        actions={hasAio ? <Badge variant="info">AI Overview keywords present</Badge> : null}
      >
        <CompositionBar
          domains={domains}
          segments={[
            { key: 'branded', label: 'Branded', color: 'var(--primary)', valueFn: (d) => d.brandedKeywordCount },
            { key: 'nonBranded', label: 'Non-Branded', color: 'var(--text-3)', valueFn: (d) => d.nonBrandedKeywordCount },
          ]}
          rowEmptyText="No keyword data"
          rowNote={(d) => (hasBrandedShare(d) ? null : brandedShareNote(d))}
        />
        {/* The branded figure is a count of at most 40 rows, so a full page is
            "40 or more" and the share cannot be drawn. It used to be drawn
            anyway: four identical "100% non-branded" bars. */}
        {(brandedCapped || legacyBrand) && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
            {brandedCapped && 'Branded share not measured where the count reached its 40-keyword limit; those rows show “40+”. '}
            {legacyBrand
              ? 'This run counted every competitor against the client’s brand name; run the analysis again to count each against its own.'
              : 'Each site is counted against its own brand name.'}
          </div>
        )}
      </Card>

      <CollapsibleTable>
        <DataTable title="Domain Comparison" columns={columns} rows={rows} emptyText="No data yet — run an analysis." />
      </CollapsibleTable>
      <Legend screen="comp" ctx={explainCtx} working={() => compWorking({ snapshot })} />
    </div>
  );
}
