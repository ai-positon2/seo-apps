import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { DataTable } from '../../ui/DataTable';
import { fmtNum, domainLabel, unlessFailed } from './utils';
import { RankedBarChart } from './charts/RankedBarChart';
import { ScoreCompare } from './charts/ScoreCompare';
import { CompositionBar } from './charts/CompositionBar';
import { CollapsibleTable } from './charts/CollapsibleTable';

// Client's follow-ratio vs. whichever competitor has the most raw backlinks —
// usually the one whose sheer size looks most intimidating on the surface, so
// this is where a link-quality nuance (follow % vs. nofollow %) matters most.
function buildFollowInsight(domains) {
  const client = domains.find((d) => d.isClient);
  if (!client) return null;
  if ((client.fetchErrors || []).includes('backlinksOverview')) return null;
  const clientTotal = (client.backlinks?.followLinks || 0) + (client.backlinks?.nofollowLinks || 0);
  if (!clientTotal) return null;
  const clientPct = Math.round((client.backlinks.followLinks / clientTotal) * 100);

  // Only rivals whose backlinks were measured can be compared.
  const competitors = domains.filter((d) => !d.isClient && Number.isFinite(d.backlinks?.totalBacklinks) && !(d.fetchErrors || []).includes('backlinksOverview'));
  if (!competitors.length) return `${clientPct}% of your backlinks are "follow" (SEO-valuable).`;

  const biggest = [...competitors].sort((a, b) => b.backlinks.totalBacklinks - a.backlinks.totalBacklinks)[0];
  const bTotal = biggest.backlinks.followLinks + biggest.backlinks.nofollowLinks;
  if (!bTotal) return `${clientPct}% of your backlinks are "follow" (SEO-valuable).`;
  const bNofollowPct = 100 - Math.round((biggest.backlinks.followLinks / bTotal) * 100);
  const sizeNote = biggest.backlinks.totalBacklinks > client.backlinks.totalBacklinks
    ? `${domainLabel(biggest)} has far more links but`
    : `${domainLabel(biggest)} has fewer links, and`;

  return `${clientPct}% of your backlinks are "follow" (SEO-valuable). ${sizeNote} ${bNofollowPct}% are "nofollow".`;
}

export default function BacklinkTab({ snapshot }) {
  const domains = snapshot?.domains || [];

  const overviewRows = domains.map((d) => ({
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
    authorityScore: d.authorityScore,
    totalBacklinks: d.backlinks.totalBacklinks,
    referringDomains: d.backlinks.referringDomains,
    followLinks: d.backlinks.followLinks,
    nofollowLinks: d.backlinks.nofollowLinks,
  }));

  const overviewColumns = [
    { key: 'label', label: 'Domain', sortable: false },
    { key: 'authorityScore', label: 'Authority Score', align: 'right', mono: true, render: fmtNum },
    { key: 'totalBacklinks', label: 'Backlinks', align: 'right', mono: true, render: fmtNum },
    { key: 'referringDomains', label: 'Ref. Domains', align: 'right', mono: true, render: fmtNum },
    { key: 'followLinks', label: 'Follow', align: 'right', mono: true, render: fmtNum },
    { key: 'nofollowLinks', label: 'Nofollow', align: 'right', mono: true, render: fmtNum },
  ];

  if (!domains.length) {
    return <DataTable title="Authority" columns={overviewColumns} rows={overviewRows} emptyText="No data yet — run an analysis." />;
  }

  const insight = buildFollowInsight(domains);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card title="Authority Score">
        <ScoreCompare domains={domains} valueFn={unlessFailed('backlinksOverview', (d) => d.authorityScore)} />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
        <Card title="Backlinks">
          <RankedBarChart domains={domains} valueFn={unlessFailed('backlinksOverview', (d) => d.backlinks?.totalBacklinks)} />
        </Card>
        <Card title="Referring Domains">
          <RankedBarChart domains={domains} valueFn={unlessFailed('backlinksOverview', (d) => d.backlinks?.referringDomains)} />
        </Card>
      </div>

      <Card title="Follow vs. Nofollow — Link Quality">
        <CompositionBar
          domains={domains}
          segments={[
            { key: 'follow', label: 'Follow', color: 'var(--success)', valueFn: (d) => d.backlinks.followLinks },
            { key: 'nofollow', label: 'Nofollow', color: 'var(--text-3)', valueFn: (d) => d.backlinks.nofollowLinks },
          ]}
          rowEmptyText="No backlink data"
          rowNote={(d) => ((d.fetchErrors || []).includes('backlinksOverview') ? 'Not measured: the backlinks check failed' : null)}
        />
        {insight && (
          <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surface)', borderRadius: 'var(--r-md)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
            {insight}
          </div>
        )}
      </Card>

      <CollapsibleTable>
        <DataTable title="Authority" columns={overviewColumns} rows={overviewRows} emptyText="No data yet — run an analysis." />
      </CollapsibleTable>
    </div>
  );
}
