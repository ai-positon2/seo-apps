import {
  Panel, Eyebrow, Chip, BackLink, RuledHead, sevOf,
} from './reportPrimitives';

// ── One crawled page's own view ─────────────────────────────────────────────
//
// What is wrong with this page, why each check exists, and what to do — with a
// way through to every other page carrying the same problem. This replaced a
// slide-over drawer (UrlDrawer) that carried the same issues plus the page's
// full response headers, metadata lengths, link counts and an on-demand
// PageSpeed lookup, in a panel narrower than the text it held.
//
// A view rather than a drawer for one reason: the issues on a page are the
// reason you opened it, and a drawer puts them in a 420px column over the top
// of the table you were reading. The measurements it also carried are columns of
// the Excel audit, which is one button away at the top of the report.

export default function UrlDetail({
  page, issues, onBack, onOpenIssue, loading = false, error = null,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <BackLink onClick={onBack}>All pages</BackLink>
        <Eyebrow tone="accent">Page detail</Eyebrow>
        <h1
          style={{
            margin: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em',
            color: 'var(--text)', lineHeight: 1.3, fontFamily: 'var(--font-mono)',
            wordBreak: 'break-all',
          }}
        >
          {page.url}
        </h1>
        <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
          {page.title || 'No title'} · status {page.status ?? '—'}
          {page.indexability ? ` · ${page.indexability}` : ''}
        </span>
        <div>
          <a
            href={page.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: 12.5, color: 'var(--primary-text)' }}
          >
            Open the live page →
          </a>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <RuledHead
          title="Issues on this page"
          note={loading ? 'reading…' : error ? 'could not be read' : `${issues.length} found`}
        />

        {issues.map((i) => {
          const s = sevOf(i.severity);
          return (
            <Panel key={i.key || i.id} pad="18px 20px" style={{ gap: 10, borderRadius: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <span
                  style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: s.dot }}
                />
                <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--text)' }}>
                  {i.title}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <Chip bg={s.chipBg} fg={s.chipFg}>{s.label}</Chip>
                </span>
              </div>

              {/* What was actually found HERE, before the general description of
                  the check. The design does not carry this line; without it the
                  page says which rule fired but never what it saw, which is the
                  first thing anyone fixing it needs. */}
              {i.detected && (
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
                  <strong style={{ fontWeight: 600, color: 'var(--text)' }}>On this page:</strong>
                  {' '}{i.detected}
                  {i.found && (
                    <span style={{ display: 'block', fontSize: 12.5, fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
                      {i.found}
                    </span>
                  )}
                </p>
              )}
              {i.truncated && (
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-3)' }}>
                  Counted on the first 5 MB of this page, which is larger: the true figure may be higher.
                </p>
              )}

              {/* What the finding points at — the broken link's target, the
                  canonical, the redirect destination — is the thing to go and
                  change, so it is shown with the finding rather than dropped. */}
              {i.targetUrl && (
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-2)', wordBreak: 'break-all' }}>
                  <strong style={{ fontWeight: 600, color: 'var(--text)' }}>Points to:</strong>
                  {' '}<span style={{ fontFamily: 'var(--font-mono)' }}>{i.targetUrl}</span>
                </p>
              )}

              {i.suggestion && (
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text)' }}>
                  <strong style={{ fontWeight: 600 }}>Suggested:</strong> {i.suggestion}
                </p>
              )}

              {i.description && (
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)', textWrap: 'pretty' }}>
                  {i.description}
                </p>
              )}

              {i.recommendation && (
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text)', textWrap: 'pretty' }}>
                  <strong style={{ fontWeight: 600 }}>The fix:</strong> {i.recommendation}
                </p>
              )}

              {i.pages > 1 && (
                <button
                  type="button"
                  onClick={() => onOpenIssue(i.id)}
                  style={{
                    alignSelf: 'flex-start', padding: 0, marginTop: 2, background: 'none',
                    border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    fontSize: 12.5, color: 'var(--primary-text)',
                  }}
                >
                  See all {i.pages} pages with this problem →
                </button>
              )}
            </Panel>
          );
        })}

        {/* Loading, failed and genuinely-clean are three different answers and
            only one of them is "no issues found on this page". This view's
            findings are fetched when it opens — see the note above — so an
            empty array means nothing until the fetch has resolved. */}
        {loading && !issues.length && (
          <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
            Reading this page’s findings…
          </span>
        )}
        {error && !issues.length && (
          <span style={{ fontSize: 13.5, color: 'var(--viz-neg)', lineHeight: 1.5 }}>
            This page’s findings could not be read: {error}. The page itself was crawled — what
            failed is reading the audit for it.
          </span>
        )}
        {!loading && !error && !issues.length && (
          <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
            No issues found on this page.
          </span>
        )}
      </div>
    </div>
  );
}
