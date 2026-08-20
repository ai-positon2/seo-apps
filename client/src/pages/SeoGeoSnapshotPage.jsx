import { useSeoGeoAudit } from '../hooks/useSeoGeoAudit';
import AuditInputPanel from '../components/seoGeo/AuditInputPanel';
import ScoreDashboard, { AuditMetaBar } from '../components/seoGeo/ScoreDashboard';
import ModuleRuns from '../components/ModuleRuns';

// The server emits step {id:'ai', status:'error'} and then still emits `result`
// with ai: null — so `findings` can arrive without `ai` and most of the cards
// vanish. Say so instead of failing silently.
function AiUnavailableBanner() {
  return (
    <div style={{ background: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 'var(--r-lg)', padding: 20, marginBottom: 16 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>AI analysis unavailable</p>
      <p style={{ fontSize: 14, color: 'var(--warning)' }}>The GPT-4o mini analysis did not complete, so GEO readiness, E-E-A-T, quick wins and the keyword verdict are missing. Scores and GEO answerability are rule-based and remain accurate. Re-run to retry.</p>
    </div>
  );
}

export default function SeoGeoSnapshotPage() {
  const ctl = useSeoGeoAudit('seo-geo-snapshot');

  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px' }}>
      {!ctl.findings && !ctl.restoring && (
        <div style={{ maxWidth: 672, margin: '0 auto' }}>
          <AuditInputPanel
            ctl={ctl}
            title="SEO & GEO Snapshot"
            subtitle="Same 200+ check engine — scores only, on one screen."
            ctaLabel="Snapshot"
            ctaLabelHtml="Snapshot HTML"
          />
        </div>
      )}

      {ctl.findings && (
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}><AuditMetaBar findings={ctl.findings} /></div>
            <button
              onClick={ctl.reset}
              style={{
                padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
                color: '#fff', background: 'var(--primary)', border: 'none', cursor: 'pointer',
                flexShrink: 0, transition: 'opacity 150ms',
              }}
            >
              New snapshot
            </button>
          </div>

          {!ctl.ai && <AiUnavailableBanner />}

          <ScoreDashboard findings={ctl.findings} ai={ctl.ai} />
        </div>
      )}
      <ModuleRuns toolId="seo-geo-audit" title="Recent audits" />
    </main>
  );
}
