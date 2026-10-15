import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { DataTable } from '../../ui/DataTable';
import { fmtNum, domainLabel, computeClientStat } from './utils';
import { KpiScorecard } from './charts/KpiScorecard';
import { RankedBarChart } from './charts/RankedBarChart';
import { ScoreCompare } from './charts/ScoreCompare';
import { CompositionBar } from './charts/CompositionBar';
import { CollapsibleTable } from './charts/CollapsibleTable';
import { InfoDot, Legend, competitiveScoreSentence } from '../explain';
import { scoreBandColor } from '../../lib/scoreVerdict';

// ── The module's own score, first ───────────────────────────────────────────
//
// The same 0-100 the dashboard card shows for this module, computed by the
// server with the card's own function (competitorAnalysis/trafficScore.js) —
// so a reader arriving from the card sees the number they clicked on. A
// snapshot with nothing to compare against shows a dash, never 0.
function CompetitiveScoreCard({ trafficScore, ctx }) {
  const score = trafficScore?.score;
  const has = Number.isFinite(score);
  const color = has ? scoreBandColor(score) : 'var(--text-3)';
  return (
    <div
      data-explain-box
      style={{
        display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
        padding: '20px 24px', borderRadius: 'var(--r-lg)', background: 'var(--card)',
        border: '1px solid var(--border)',
        // The band colour as a rule across the top, as on the dashboard card.
        // Declared after the shorthand or the shorthand would overwrite it.
        borderTop: `3px solid ${color}`,
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="explain-label-row">
          <span className="eyebrow">Competitive score</span>
          <InfoDot explainKey="c_score" ctx={ctx} />
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="num" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1, color }}>
            {has ? score : '—'}
          </span>
          {has && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>/ 100</span>}
        </div>
      </div>
      <span style={{ flex: '1 1 300px', fontSize: 14, lineHeight: 1.55, color: 'var(--text-2)' }}>
        {competitiveScoreSentence(trafficScore)}
      </span>
    </div>
  );
}

export default function OverviewTab({ snapshot }) {
  const domains = snapshot?.domains || [];
  const hasAio = domains.some((d) => (d.aioKeywordCount || 0) > 0);

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
    authorityScore: d.authorityScore,
    totalBacklinks: d.backlinks.totalBacklinks,
    referringDomains: d.backlinks.referringDomains,
    aioKeywordCount: d.aioKeywordCount,
    brandedKeywordCount: d.brandedKeywordCount,
    nonBrandedKeywordCount: d.nonBrandedKeywordCount,
  }));

  const columns = [
    { key: 'label', label: 'Domain', sortable: false },
    { key: 'organicKeywords', label: 'Organic Keywords', align: 'right', mono: true, render: fmtNum },
    { key: 'organicTraffic', label: 'Organic Traffic', align: 'right', mono: true, render: fmtNum },
    { key: 'authorityScore', label: 'Authority Score', align: 'right', mono: true },
    { key: 'totalBacklinks', label: 'Backlinks', align: 'right', mono: true, render: fmtNum },
    { key: 'referringDomains', label: 'Ref. Domains', align: 'right', mono: true, render: fmtNum },
    { key: 'aioKeywordCount', label: 'AIO Kw', align: 'right', mono: true, render: fmtNum },
    { key: 'brandedKeywordCount', label: 'Branded Kw', align: 'right', mono: true, render: fmtNum },
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
      <CompetitiveScoreCard trafficScore={explainCtx.trafficScore} ctx={explainCtx} />

      {/* KPI scorecard strip — where do we stand, at a glance */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <KpiScorecard label="Organic Traffic" info="c_traffic" infoCtx={explainCtx} stat={computeClientStat(domains, (d) => d.domainRank.organicTraffic)} />
        <KpiScorecard label="Organic Keywords" info="c_keywords" infoCtx={explainCtx} stat={computeClientStat(domains, (d) => d.domainRank.organicKeywords)} />
        <KpiScorecard label="Authority Score" info="c_authority" infoCtx={explainCtx} stat={computeClientStat(domains, (d) => d.authorityScore)} />
        <KpiScorecard label="Backlinks" info="c_backlinks" infoCtx={explainCtx} stat={computeClientStat(domains, (d) => d.backlinks.totalBacklinks)} />
      </div>

      {/* Magnitude metrics — ranked bars, small multiples 2x2 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <Card title={titled('Organic Traffic', 'c_traffic')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={(d) => d.domainRank.organicTraffic} />
        </Card>
        <Card title={titled('Organic Keywords', 'c_keywords')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={(d) => d.domainRank.organicKeywords} />
        </Card>
        <Card title={titled('Backlinks', 'c_backlinks')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={(d) => d.backlinks.totalBacklinks} />
        </Card>
        <Card title={titled('Referring Domains', 'c_backlinks')} data-explain-box>
          <RankedBarChart domains={domains} valueFn={(d) => d.backlinks.referringDomains} />
        </Card>
      </div>

      {/* Authority Score — bounded 0-100, gauge/lollipop not a bar */}
      <Card title={titled('Authority Score', 'c_authority')} data-explain-box>
        <ScoreCompare domains={domains} />
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
        />
      </Card>

      <CollapsibleTable>
        <DataTable title="Domain Comparison" columns={columns} rows={rows} emptyText="No data yet — run an analysis." />
      </CollapsibleTable>
      <Legend screen="comp" ctx={explainCtx} />
    </div>
  );
}
