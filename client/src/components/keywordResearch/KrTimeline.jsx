// How a Keyword Research run got its keywords: the pipeline's steps, the query
// variants, the competitor pages it chose and the SEMrush keywords behind each.
//
// full    — the standalone page's step-by-step cards.
// compact — one progress line while running; afterwards a "Show sources"
//           disclosure holding the same variants, pages and per-page keywords
//           as dense rows.

import { useState } from 'react';
import { STEP_CONFIG, progressOf, hostOf, hostAndPath, shortVolume } from '../../lib/keywordResearchModel';
import { Spinner, StepBadge, PAGE_TYPE_STYLES, cardShadow } from './shared';

export default function KrTimeline({ density = 'full', kr }) {
  if (!kr.state.started) return null;
  return density === 'compact' ? <CompactTimeline state={kr.state} /> : <FullTimeline state={kr.state} />;
}

function VariantChips({ queries, small = false }) {
  const pad = small ? '3px 9px' : '6px 12px';
  const size = small ? 11 : 12;
  return queries.map((q, i) => (
    <span
      key={i}
      style={{
        fontSize: size, padding: pad, borderRadius: 99, fontWeight: 500,
        background: i === 0 ? 'var(--nav-bg-top)' : 'var(--surface)', color: i === 0 ? '#fff' : 'var(--text)',
      }}
    >
      {i === 0 ? '★ ' : ''}{q}
    </span>
  ));
}

function UrlStatusIcon({ status }) {
  if (status === 'done') return <span style={{ color: 'var(--success)', fontSize: 12, fontWeight: 700 }}>✓</span>;
  if (status === 'loading') return <Spinner size={12} color="var(--primary)" />;
  if (status === 'error') return <span style={{ color: 'var(--danger)', fontSize: 12 }}>✕</span>;
  return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>·</span>;
}

function KeywordChips({ keywords }) {
  return keywords.slice(0, 10).map((kw, ki) => (
    <span key={ki} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '2px 8px', borderRadius: 99, background: 'var(--surface)', color: 'var(--text)' }}>
      {kw.keyword}
      {kw.volume > 0 && <span style={{ color: 'var(--text-3)' }}>{shortVolume(kw.volume)}</span>}
    </span>
  ));
}

// ── full ────────────────────────────────────────────────────────────────────

function FullTimeline({ state }) {
  const { steps, queries, urls, urlData, totalQueries } = state;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {STEP_CONFIG.map((stepCfg, stepIndex) => {
        const s = steps[stepCfg.id] || {};
        if (!s.status) return null;
        const isActive = s.status === 'active';

        return (
          <div
            key={stepCfg.id}
            style={{
              background: 'var(--card)', border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
              borderRadius: 'var(--r-lg)', overflow: 'hidden', transition: 'border-color 0.2s', boxShadow: cardShadow,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: isActive ? 'var(--primary-soft)' : 'var(--surface)' }}>
              <StepBadge status={s.status} index={stepIndex} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{stepCfg.label}</span>
                  {isActive && (
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 99, fontWeight: 500, background: 'var(--primary-soft)', color: 'var(--primary)', animation: 'kr-pulse 2s infinite' }}>
                      In progress
                    </span>
                  )}
                  {s.status === 'done' && (
                    <span style={{ fontSize: 12, background: 'var(--surface)', color: 'var(--text-3)', padding: '2px 8px', borderRadius: 99, fontWeight: 500 }}>
                      Done
                    </span>
                  )}
                </div>
                {s.message && <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '2px 0 0' }}>{s.message}</p>}
              </div>
            </div>

            {stepCfg.id === 'variants' && s.status === 'done' && queries.length > 0 && (
              <div style={{ padding: '14px 20px', display: 'flex', flexWrap: 'wrap', gap: 8, borderTop: '1px solid var(--border)' }}>
                <VariantChips queries={queries} />
              </div>
            )}

            {stepCfg.id === 'url_scoring' && s.status === 'done' && urls.length > 0 && (
              <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, borderTop: '1px solid var(--border)' }}>
                {urls.map((u, idx) => {
                  const ptStyle = PAGE_TYPE_STYLES[u.pageType] || PAGE_TYPE_STYLES.page;
                  return (
                    <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--surface)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--primary)', color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
                          {idx + 1}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {hostOf(u.url)}
                        </span>
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--text-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4, margin: '0 0 8px' }}>
                        {u.title}
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: ptStyle.bg, color: ptStyle.text }}>{u.pageType}</span>
                        {u.queryCount > 1 && (
                          <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                            {u.queryCount}/{totalQueries || queries.length} queries
                          </span>
                        )}
                        <span style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, fontWeight: 500, background: 'var(--surface)', color: 'var(--text-2)', marginLeft: 'auto' }}>
                          {u.rubricScore?.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {stepCfg.id === 'semrush' && (s.status === 'active' || s.status === 'done') && urls.length > 0 && (
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, borderTop: '1px solid var(--border)' }}>
                {urls.map((u, idx) => {
                  const ud = urlData[u.url];
                  return (
                    <div key={idx}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <UrlStatusIcon status={ud?.status} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {hostAndPath(u.url)}
                        </span>
                        {ud?.keywords?.length > 0 && (
                          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>
                            {ud.keywords.length} keyword{ud.keywords.length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      {ud?.status === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)', marginLeft: 20, margin: 0 }}>{ud.error}</p>}
                      {ud?.keywords?.length > 0 && (
                        <div style={{ marginLeft: 20, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          <KeywordChips keywords={ud.keywords} />
                        </div>
                      )}
                      {ud?.status === 'loading' && (
                        <div style={{ marginLeft: 20, display: 'flex', gap: 6 }}>
                          {[...Array(5)].map((_, i) => (
                            <div key={i} style={{ height: 20, borderRadius: 99, background: 'var(--surface)', width: 50 + i * 15, animation: 'kr-pulse 1.5s infinite' }} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {stepCfg.id === 'analysis' && s.status === 'active' && (
              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: 'var(--text-2)' }}>
                  <Spinner color="var(--primary)" />
                  Deduplicating keywords and running the AI shortlist…
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── compact ─────────────────────────────────────────────────────────────────

function CompactTimeline({ state }) {
  const [open, setOpen] = useState(false);
  const [openUrl, setOpenUrl] = useState(null);
  const { running, queries, urls, urlData, totalQueries, allKeywords } = state;
  const progress = progressOf(state);
  const hasSources = queries.length > 0 || urls.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', minHeight: 20 }}>
        {running ? (
          <>
            <Spinner size={12} color="var(--primary)" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {progress
                ? <><strong style={{ fontWeight: 600, color: 'var(--text)' }}>Step {progress.index}/{progress.total} · {progress.label}</strong>{progress.message ? ` — ${progress.message}` : ''}</>
                : 'Starting…'}
            </span>
          </>
        ) : urls.length > 0 ? (
          <span>
            Researched from {urls.length} competitor page{urls.length === 1 ? '' : 's'} across {totalQueries || queries.length} searches
            {allKeywords.length > 0 ? ` · ${allKeywords.length} keywords scored` : ''}
          </span>
        ) : null}

        {hasSources && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11.5, color: 'var(--primary-text)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            {open ? 'Hide sources ▲' : 'Show sources ▾'}
          </button>
        )}
      </div>

      {open && hasSources && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--card)' }}>
          {queries.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 6 }}>SEARCHES</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}><VariantChips queries={queries} small /></div>
            </div>
          )}
          {urls.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: 4 }}>COMPETITOR PAGES</div>
              {urls.map((u, idx) => {
                const ud = urlData[u.url];
                const ptStyle = PAGE_TYPE_STYLES[u.pageType] || PAGE_TYPE_STYLES.page;
                const expanded = openUrl === u.url;
                const count = ud?.keywords?.length || 0;
                return (
                  <div key={u.url} style={{ borderTop: idx ? '1px solid var(--border)' : 'none' }}>
                    <button
                      type="button"
                      onClick={() => setOpenUrl(expanded ? null : u.url)}
                      disabled={!count && ud?.status !== 'error'}
                      title={u.title}
                      style={{
                        width: '100%', display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto auto 38px 56px', gap: 8, alignItems: 'center',
                        padding: '5px 2px', background: 'none', border: 'none', textAlign: 'left', cursor: count || ud?.status === 'error' ? 'pointer' : 'default',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{idx + 1}</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostAndPath(u.url)}</span>
                      <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 4, fontWeight: 500, background: ptStyle.bg, color: ptStyle.text }}>{u.pageType}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                        {u.queryCount > 1 ? `${u.queryCount}/${totalQueries || queries.length} searches` : ''}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{u.rubricScore?.toFixed(2)}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, fontSize: 11, color: 'var(--text-3)' }}>
                        {ud?.status === 'loading' || ud?.status === 'error' ? <UrlStatusIcon status={ud.status} /> : count ? `${count} kw ${expanded ? '▴' : '▸'}` : ''}
                      </span>
                    </button>
                    {expanded && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '2px 0 8px 26px' }}>
                        {ud?.status === 'error'
                          ? <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{ud.error}</span>
                          : <KeywordChips keywords={ud?.keywords || []} />}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
