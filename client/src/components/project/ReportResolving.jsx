// ── While we work out which screen this module should show ───────────────────
//
// SEO & GEO, On-Page and Agent Readiness render their report out of page state,
// so on mount they knew nothing and drew their "audit a URL" form. A moment
// later ProjectReportBar finished loading the client's stored run and replaced
// it with a report. Anyone opening a client that already had one saw the form
// flash first, which reads as the app forgetting what it knew.
//
// This holds that moment instead. It is deliberately generic — a title block and
// a few content bars — because the three reports look nothing alike and a
// skeleton that mimicked one of them would be wrong on the other two. What it
// does match is their width and top offset, so the swap does not jump.
//
// @param {number} [maxWidth] the report's own column width, so this occupies it

export function ReportResolving({ maxWidth = 960 }) {
  const bar = (w, h = 12) => ({
    width: w,
    height: h,
    borderRadius: 6,
    background: 'color-mix(in srgb, var(--text-3) 16%, transparent)',
    animation: 'reportResolve 1.4s ease-in-out infinite',
  });

  return (
    <div
      style={{ width: '100%', maxWidth, margin: '0 auto', padding: '24px 16px' }}
      aria-busy="true"
      aria-label="Opening the stored report"
    >
      <style>{'@keyframes reportResolve { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }'}</style>

      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ ...bar(72, 72), borderRadius: '50%' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div style={bar('45%', 18)} />
            <div style={bar('70%', 11)} />
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--border)' }} />

        {['92%', '78%', '86%', '64%'].map((w) => (
          <div key={w} style={bar(w, 11)} />
        ))}
      </div>
    </div>
  );
}

export default ReportResolving;
