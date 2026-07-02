import { useState } from 'react';
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, Tooltip, CartesianGrid, ZAxis } from 'recharts';
import { DataTable, Card, MetricCard, Tabs } from '../../ui';
import { InsightCallout } from './InsightCallout';
import { domainLabel, fmtNum } from './utils';

const GAP_TABS = [
  { key: 'strikingDistance', label: 'Striking Distance' },
  { key: 'untapped', label: 'Untapped' },
  { key: 'missing', label: 'Missing' },
];

function gapColumns(key) {
  const base = [
    { key: 'keyword', label: 'Keyword' },
    { key: 'searchVolume', label: 'Volume', align: 'right', mono: true },
  ];
  if (key === 'strikingDistance') {
    return [...base,
      { key: 'clientPosition', label: 'Client Pos.', align: 'right', mono: true },
      { key: 'bestCompetitorPosition', label: 'Best Competitor Pos.', align: 'right', mono: true },
      { key: 'bestCompetitorDomain', label: 'Competitor' },
    ];
  }
  if (key === 'untapped') {
    return [...base,
      { key: 'clientPosition', label: 'Client Pos.', align: 'right', mono: true },
      { key: 'bestCompetitorPosition', label: 'Best Competitor Pos.', align: 'right', mono: true },
      { key: 'bestCompetitorDomain', label: 'Competitor' },
    ];
  }
  return [...base,
    { key: 'bestCompetitorPosition', label: 'Competitor Pos.', align: 'right', mono: true },
    { key: 'bestCompetitorDomain', label: 'Competitor' },
  ];
}

export function KeywordRankingTab({ snapshot, insight }) {
  const [gapTab, setGapTab] = useState('strikingDistance');
  const domains = snapshot?.domains || [];
  const keywordGap = snapshot?.keywordGap || { strikingDistance: [], untapped: [], missing: [] };
  const detailTable = snapshot?.keywordDetailTable || [];

  const bucketRows = domains.map(d => ({
    id: d.domain,
    domain: domainLabel(d) + (d.isClient ? ' (Client)' : ''),
    page1: fmtNum(d.keywordBuckets?.page1),
    page2: fmtNum(d.keywordBuckets?.page2),
    page3to5: fmtNum(d.keywordBuckets?.page3to5),
    page6to10: fmtNum(d.keywordBuckets?.page6to10),
    total: fmtNum(d.keywordBuckets?.total),
  }));

  const gapRows = (keywordGap[gapTab] || []).map((k, i) => ({
    id: i,
    keyword: k.keyword,
    searchVolume: fmtNum(k.searchVolume),
    clientPosition: k.clientPosition ?? 'Not Ranking',
    bestCompetitorPosition: k.bestCompetitorPosition,
    bestCompetitorDomain: k.bestCompetitorDomain,
  }));

  const detailColumns = [
    { key: 'keyword', label: 'Keyword', maxWidth: 260, wrap: true },
    { key: 'searchVolume', label: 'Volume', align: 'right', mono: true },
    ...domains.map(d => ({
      key: d.domain,
      label: domainLabel(d),
      align: 'right',
      mono: true,
      render: (v) => v ?? <span style={{ color: 'var(--text-3)' }}>Not Ranking</span>,
    })),
  ];
  const detailRows = detailTable.map((row, i) => ({
    id: i,
    keyword: row.keyword,
    searchVolume: fmtNum(row.searchVolume),
    ...row.positions,
  }));

  const clientDomain = domains.find(d => d.isClient);
  const scatterData = (clientDomain?.keywords || []).slice(0, 150).map(k => ({ volume: k.volume, cpc: k.cpc, position: k.position, keyword: k.keyword }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InsightCallout insight={insight} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <MetricCard label="Striking Distance" value={keywordGap.strikingDistance.length} sub="Client ranks 11-50, competitor in top 10" />
        <MetricCard label="Untapped" value={keywordGap.untapped.length} sub="Competitor ranks top 10, client weak/absent" />
        <MetricCard label="Missing" value={keywordGap.missing.length} sub="Competitor ranks, client doesn't at all" />
      </div>

      <DataTable
        title="Keyword Position Distribution"
        columns={[
          { key: 'domain', label: 'Domain' },
          { key: 'page1', label: 'Page 1', align: 'right', mono: true },
          { key: 'page2', label: 'Page 2', align: 'right', mono: true },
          { key: 'page3to5', label: 'Page 3-5', align: 'right', mono: true },
          { key: 'page6to10', label: 'Page 6-10', align: 'right', mono: true },
          { key: 'total', label: 'Total', align: 'right', mono: true },
        ]}
        rows={bucketRows}
      />

      <Card title="Keyword Gap Detail" padding="0">
        <div style={{ padding: '4px 20px 0' }}>
          <Tabs variant="segmented" tabs={GAP_TABS} active={gapTab} onChange={setGapTab} />
        </div>
        <div style={{ padding: 16 }}>
          <DataTable columns={gapColumns(gapTab)} rows={gapRows} emptyText="No keywords in this category" />
        </div>
      </Card>

      {scatterData.length > 0 && (
        <Card title="Client Keyword Opportunity Matrix (Volume vs. CPC)">
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 12px' }}>
            CPC is used as a rough competitiveness proxy — true keyword difficulty would require an additional per-keyword SEMrush call.
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" dataKey="volume" name="Search Volume" stroke="var(--text-3)" fontSize={12} />
              <YAxis type="number" dataKey="cpc" name="CPC" stroke="var(--text-3)" fontSize={12} />
              <ZAxis range={[40, 40]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                formatter={(value, name) => [value, name]}
                labelFormatter={() => ''}
              />
              <Scatter data={scatterData} fill="var(--primary)" />
            </ScatterChart>
          </ResponsiveContainer>
        </Card>
      )}

      <DataTable
        title="Competitor Top Keywords (Top 100 by Volume)"
        columns={detailColumns}
        rows={detailRows}
        stickyHeader
      />
    </div>
  );
}

export default KeywordRankingTab;
