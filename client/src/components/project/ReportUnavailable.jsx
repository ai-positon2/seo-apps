import { pathOf } from '../../lib/pageReportPicker';
import { relativeTime } from '../../lib/projectsApi';

// ── In place of a report that cannot be shown ───────────────────────────────
//
// What a page draws when ProjectReportBar resolves 'page_failed' (this page's
// audit failed) or 'error' (a stored report exists but would not load). Before
// this, both were 'none': Agent Readiness kept the previous page's report on
// screen under the new page's name, and SEO & GEO swapped in a blank new-audit
// form beside a stored score. Neither page shows any other page's numbers here.
//
// 'page_pending' (the page is still queued or being audited) draws the same
// card in a neutral tone: the page has no report yet, and no other page's
// report may stand in for it.
//
// @param {'page_failed'|'page_pending'|'error'} state
// @param {object} info  { url, reason, detail, finishedAt, retry } from the bar
// @param {number} [maxWidth]

export default function ReportUnavailable({ state, info, maxWidth = 960 }) {
  const failed = state === 'page_failed';
  const pending = state === 'page_pending';
  const where = info?.url ? pathOf(info.url) : null;
  const at = where ? <> — <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15 }}>{where}</span></> : null;
  return (
    <div
      role={pending ? 'status' : 'alert'}
      style={{
        maxWidth, margin: '0 auto 24px', padding: '22px 24px', borderRadius: 14,
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: pending ? 'var(--text-3)' : 'var(--danger)' }}>
        {pending ? (info?.status === 'queued' ? 'Queued' : 'Auditing now') : failed ? 'Not audited' : 'Report unavailable'}
      </span>
      <p style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>
        {pending
          ? <>This page is still being audited{at}</>
          : failed
            ? <>This page couldn’t be audited{at}</>
            : <>This report couldn’t be opened{at}</>}
      </p>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)', lineHeight: 1.55 }}>
        {info?.reason || (pending ? 'Its report appears here when the audit finishes.' : failed ? 'This page couldn’t be audited.' : 'We couldn’t open this report just now.')}
        {failed && info?.finishedAt ? <> Tried {relativeTime(info.finishedAt)}.</> : null}
      </p>
      {info?.detail && info.detail !== info.reason && (
        <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
          {info.detail}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
        {info?.retry && (
          <button
            type="button"
            onClick={info.retry}
            style={{
              height: 34, padding: '0 14px', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600,
              color: 'var(--primary-text)', background: 'transparent', border: '1px solid var(--primary)',
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            Try again
          </button>
        )}
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {pending
            ? 'Pick another page in the bar above to read its report meanwhile.'
            : failed
              ? 'Pick another page in the bar above, or Re-run the audit once the site lets our checks in.'
              : 'Or pick another page in the bar above.'}
        </span>
      </div>
    </div>
  );
}
