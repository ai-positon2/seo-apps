// Work from an earlier analysis — saved keyword sets, drafts, spoke ideas and
// page enhancements whose topic this analysis no longer has.
//
// A re-run renumbers the clusters, and saved work used to follow the number:
// one topic's spoke ideas and drafts showed up under another (UX-159). The
// server now places each item on the topic it was made for
// (server/modules/contentArchitect/topicAnchors.js); what it cannot place is
// listed here, so nothing is silently hidden and nothing sits under the wrong
// topic.

import { useState } from 'react';
import { articleHref, timeAgo } from '../../../lib/hubSpokeWork';

const label = { fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' };
const card = { padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px dashed var(--border-strong)' };

export default function EarlierWork({ orphans, earlierSuggestions = [], navigate }) {
  const [open, setOpen] = useState(false);
  const topics = orphans?.topics || [];
  const enhancements = orphans?.enhancements || [];
  const total = topics.length + enhancements.length + earlierSuggestions.length;
  if (!total) return null;

  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--card)', border: '1px dashed var(--border-strong)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '14px 18px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
        }}
      >
        <span style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text)' }}>From an earlier analysis</span>
        <span style={{ fontSize: 13, color: 'var(--primary-text)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {total} item{total === 1 ? '' : 's'} {open ? '▲' : '▾'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
          Saved for topics or pages this analysis no longer has
        </span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 18px 16px', borderTop: '1px solid var(--border)' }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-3)', maxWidth: 640 }}>
            The site was re-analysed and these topics were regrouped, so this work is kept here rather
            than shown under a topic it was not made for.
          </p>

          {topics.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={label}>KEYWORDS AND ARTICLES · {topics.length}</span>
              {topics.map((t) => (
                <div key={`${t.clusterId}:${t.topic}`} style={card}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.topic}</div>
                  {t.keywords && (
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                      Keywords: {(t.keywords.primary || []).map((k) => k.keyword).slice(0, 4).join(', ') || t.keywords.seed || '—'}
                      {t.keywords.updatedAt ? ` · saved ${timeAgo(t.keywords.updatedAt)}` : ''}
                    </div>
                  )}
                  {(t.articles || []).map((a) => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
                      <span style={{ color: 'var(--text-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.title || a.keyword} · {a.stage}{a.updatedAt ? ` · ${timeAgo(a.updatedAt)}` : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => navigate(articleHref(a))}
                        style={{ fontSize: 12, color: 'var(--primary-text)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {earlierSuggestions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={label}>SPOKE IDEAS · {earlierSuggestions.length}</span>
              {earlierSuggestions.map((s) => (
                <div key={s.formerClusterId} style={card}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                    {s.topic ? `For “${s.topic}”` : 'For a topic from an earlier analysis'}
                    {s.generatedAt ? <span style={{ fontWeight: 400, color: 'var(--text-3)' }}> · {timeAgo(s.generatedAt)}</span> : null}
                  </div>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-2)' }}>
                    {(s.suggestions || []).slice(0, 8).map((x, i) => <li key={i}>{x.title || x.keyword}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {enhancements.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={label}>PAGE ENHANCEMENTS · {enhancements.length}</span>
              {enhancements.map((e) => (
                <div key={e.url} style={{ ...card, fontSize: 12.5, color: 'var(--text-2)' }}>
                  <a href={e.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>{e.url}</a>
                  {e.updatedAt ? ` · enhanced ${timeAgo(e.updatedAt)}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
