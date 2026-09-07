import { useState } from 'react';
import { MiniStat, UnderlineTabs, bandColor } from './reportKit';
import IssuesPanel from './IssuesPanel';
import GeoPanel from './GeoPanel';
import ScoreDashboard from '../ScoreDashboard';
import OnPageTabPanel from '../../onPageAudit/OnPageTabPanel';

// ── More Tech Details ───────────────────────────────────────────────────────
//
// Four figures, the cap if there is one, then the four panels the page has
// always had. This view is the working-out; the answer is on the Summary tab.
//
// The four figures at the top are here rather than repeated inside each panel:
// the score, what it would be without the cap, what kind of page the audit
// decided this is, and how much markup it found. Whichever panel you are in,
// those four are the context for it.

const PANELS = [
  { id: 'dashboard', label: 'Score Dashboard' },
  { id: 'issues', label: 'Issues' },
  { id: 'geo', label: 'GEO & Content' },
  { id: 'onpage', label: 'On-Page Audit' },
];

export default function DetailsView({ findings, ai, onPage, auditedUrl }) {
  const [panel, setPanel] = useState('dashboard');

  const scores = findings?.scores || {};
  const cap = scores.cap || null;
  const overall = Number.isFinite(scores.overall) ? scores.overall : null;
  const composite = Number.isFinite(scores.composite) ? scores.composite : null;
  const intent = findings?.meta?.page_intent || null;
  const schemaCount = (findings?.detectedSchemas || []).length
    || (ai?.schema_analysis?.detected || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

      <div className="geo-ministats">
        <MiniStat
          label={cap?.applied ? 'Overall (after cap)' : 'Overall'}
          value={overall === null ? '—' : overall}
          color={bandColor(overall)}
        />
        <MiniStat
          label="Uncapped composite"
          value={composite === null ? '—' : composite}
        />
        <MiniStat
          label="Page intent"
          value={intent
            ? `${intent}${findings.meta?.page_intent_source === 'detected' ? ' (auto)' : ''}`
            : '—'}
        />
        <MiniStat label="Schemas found" value={schemaCount} />
      </div>

      {/* The cap, said once, here. It is the single most consequential fact
          about a capped score and it used to be stated inside the composition
          card, three scrolls down, in the same weight as a bucket label. */}
      {cap?.applied && (
        <div
          style={{
            padding: '14px 18px', borderRadius: 10,
            background: 'color-mix(in srgb, var(--viz-neg) 12%, var(--card))',
            border: '1px solid color-mix(in srgb, var(--viz-neg) 40%, var(--border))',
            fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5,
          }}
        >
          Capped at {cap.value} by a blocking issue: {cap.reason}.
          {composite !== null && ` Uncapped composite is ${composite}.`}
        </div>
      )}

      <UnderlineTabs tabs={PANELS} active={panel} onSelect={setPanel} />

      {panel === 'dashboard' && <ScoreDashboard findings={findings} ai={ai} />}
      {panel === 'issues' && <IssuesPanel findings={findings} ai={ai} />}
      {panel === 'geo' && <GeoPanel findings={findings} ai={ai} />}
      {panel === 'onpage' && <OnPageTabPanel ctl={onPage} url={auditedUrl} />}
    </div>
  );
}
