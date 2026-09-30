// ── A suggested topic's work, in one rail ───────────────────────────────────
//
// A suggested hub or spoke goes Keywords → Brief → Draft, and each stage is
// made in a different tool. The rail shows all three at once — filled when
// done, with the numbers that matter (picks, sections, words) — and each stage
// opens its own panel right here: the keyword research, the brief's outline,
// the draft to read. The one action shown is the next step.
//
// The keyword panel stays mounted once opened, hidden rather than removed, so
// switching to another stage never cuts off a run that is still streaming.

import { useEffect, useState } from 'react';
import { ca } from '../../../lib/contentArchitectApi';
import { topicStages, currentPicks, timeAgo, articleHref } from '../../../lib/hubSpokeWork';
import { buildContentWriterUrl } from '../../../lib/keywordResearchModel';
import InlineKeywordResearch from '../InlineKeywordResearch';

/**
 * @param {object} props
 * @param {{ keywords, articles }} props.entry   this topic's work (lib/hubSpokeWork indexWork().forTopic)
 * @param {object|null} props.saved              the keyword panel's own saved record
 */
export default function TopicWork({ projectId, clusterId, topic, client, navigate, entry, saved: savedProp, onSaved, onWorkChanged, aside }) {
  // The caller's cache normally has this topic's saved keywords; when it does
  // not (work from an earlier analysis), it is fetched here on first open.
  const [ownSaved, setOwnSaved] = useState(null);
  const saved = savedProp || ownSaved;
  const remember = (record) => { setOwnSaved(record); onSaved?.(record); };
  const stages = topicStages(entry, saved);
  const anything = stages.some((s) => s.done) || entry.articles.length > 0;
  const [open, setOpen] = useState(anything ? null : 'keywords');
  const [mounted, setMounted] = useState(() => new Set(anything ? [] : ['keywords']));
  const [articleIdx, setArticleIdx] = useState(0);
  const article = entry.articles[Math.min(articleIdx, entry.articles.length - 1)] || null;

  const toggle = (id) => {
    setOpen((cur) => (cur === id ? null : id));
    setMounted((m) => (m.has(id) ? m : new Set(m).add(id)));
  };

  useEffect(() => {
    if (open !== 'keywords' || saved || !entry.keywords) return;
    let alive = true;
    ca.listKeywordResearch(projectId, clusterId)
      .then(({ items }) => {
        const mine = items.find((r) => r.topic === topic);
        if (alive && mine) setOwnSaved(mine);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, saved, entry.keywords, projectId, clusterId, topic]);

  const origin = { caProjectId: projectId, clusterId, topic };
  const { primary, secondary } = currentPicks(entry.keywords, saved);

  let next = null;
  if (article) {
    next = { label: stages[2].done ? 'Open in Content Writer' : 'Continue in Content Writer', go: () => navigate(articleHref(article)) };
  } else if (stages[0].done && primary.length) {
    next = { label: `Write article for "${primary[0].keyword}"`, go: () => navigate(buildContentWriterUrl({ primary, secondary, client, origin })) };
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Rail stages={stages} open={open} onPick={toggle} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {aside}
          {next && (
            <button
              type="button"
              onClick={next.go}
              style={{
                fontSize: 11.5, fontWeight: 600, padding: '5px 11px', borderRadius: 7, cursor: 'pointer',
                border: '1px solid var(--primary)', background: 'var(--primary)', color: 'var(--text-on-primary)',
                maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {next.label} →
            </button>
          )}
        </span>
      </div>

      {mounted.has('keywords') && (
        <div style={{ display: open === 'keywords' ? 'block' : 'none' }}>
          <InlineKeywordResearch
            projectId={projectId}
            clusterId={clusterId}
            topic={topic}
            client={client}
            navigate={navigate}
            saved={saved}
            onSaved={remember}
            onRunSaved={onWorkChanged}
          />
        </div>
      )}

      {(open === 'brief' || open === 'draft') && (
        article
          ? <ArticlePanel projectId={projectId} article={article} view={open} articles={entry.articles} index={articleIdx} onIndex={setArticleIdx} navigate={navigate} />
          : (
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '10px 12px', borderRadius: 'var(--r-md)', border: '1px dashed var(--border)' }}>
              {stages[0].done
                ? 'No article yet. "Write article" opens Content Writer with these keywords; the brief and draft appear here once saved.'
                : 'Research keywords first — the article is written for the primary keyword you pick.'}
            </div>
          )
      )}
    </div>
  );
}

// ── The rail ────────────────────────────────────────────────────────────────

function Rail({ stages, open, onPick }) {
  return (
    <div role="group" aria-label="Progress for this topic" style={{ display: 'flex', alignItems: 'center' }}>
      {stages.map((s, i) => {
        const active = open === s.id;
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <span aria-hidden="true" style={{ width: 22, height: 2, borderRadius: 2, background: s.done ? 'var(--primary)' : 'var(--border)' }} />
            )}
            <button
              type="button"
              onClick={() => onPick(s.id)}
              aria-expanded={active}
              title={`${s.label}: ${s.meta}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                padding: '4px 10px 4px 6px', borderRadius: 'var(--r-pill)',
                border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                background: active ? 'var(--primary-soft)' : 'var(--card)',
                boxShadow: active ? '0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent)' : 'none',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: s.done ? 'var(--primary)' : 'transparent',
                  border: s.done ? 'none' : '1.5px dashed var(--text-3)',
                }}
              >
                {s.done && (
                  <svg width="8" height="8" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                )}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15 }}>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: s.done ? 'var(--text)' : 'var(--text-2)' }}>{s.label}</span>
                <span style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{s.meta}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Brief / draft ───────────────────────────────────────────────────────────

function ArticlePanel({ projectId, article, view, articles, index, onIndex, navigate }) {
  const [full, setFull] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setFull(null); setError('');
    ca.getWorkArticle(projectId, article.id)
      .then((d) => { if (alive) setFull(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [projectId, article.id, article.updatedAt]);

  return (
    <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--card)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
          {article.title || article.keyword}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          for “{article.keyword}” · saved {timeAgo(article.updatedAt)}
          {article.linkedBy === 'keyword' ? ' · matched by keyword' : ''}
        </span>
        {articles.length > 1 && (
          <select
            value={index}
            onChange={(e) => onIndex(Number(e.target.value))}
            aria-label="Which article"
            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-2)' }}
          >
            {articles.map((a, i) => <option key={a.id} value={i}>Article {i + 1} of {articles.length} · {a.keyword}</option>)}
          </select>
        )}
        <button
          type="button"
          onClick={() => navigate(articleHref(article))}
          style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-2)', cursor: 'pointer' }}
        >
          Open in Content Writer ↗
        </button>
      </div>

      <div style={{ maxHeight: 440, overflowY: 'auto', padding: '10px 18px 16px' }}>
        {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
        {!full && !error && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>}
        {full && view === 'brief' && <BriefOutline article={full} />}
        {full && view === 'draft' && <DraftReader article={full} />}
      </div>
    </div>
  );
}

function BriefOutline({ article }) {
  const brief = article.brief;
  if (!brief?.sections?.length) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>The brief has not been built yet — open it in Content Writer to build it.</div>;
  }
  const secondary = String(article.secondaryKeywords || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>H1</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{brief.title}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        <span style={chip(true)}>{article.keyword}</span>
        {secondary.map((s) => <span key={s} style={chip(false)}>{s}</span>)}
      </div>
      {brief.intro && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>{brief.intro}</p>}
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {brief.sections.map((s) => {
          const depth = Math.max(0, Number(String(s.level).slice(1)) - 2);
          return (
            <li key={s.id} style={{ marginLeft: depth * 18, paddingLeft: 10, borderLeft: `2px solid ${depth ? 'var(--border)' : 'var(--primary)'}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{s.level}</span>
                <span style={{ fontSize: 13, fontWeight: depth ? 500 : 600, color: 'var(--text)' }}>{s.heading}</span>
              </div>
              {s.guidance && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {s.guidance}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function DraftReader({ article }) {
  if (!article.draftHtml) {
    return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No draft yet — write it from the brief in Content Writer.</div>;
  }
  return (
    <div
      className="ca-draft-reader"
      style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}
      // The server sanitizes draftHtml on every write and again on this read
      // (contentWriter/document.js cleanHtml): a fixed tag list, http(s) links only.
      dangerouslySetInnerHTML={{ __html: article.draftHtml }}
    />
  );
}

function chip(primary) {
  return {
    fontSize: 11, padding: '2px 8px', borderRadius: 99,
    background: primary ? 'var(--primary-soft)' : 'var(--surface)', color: primary ? 'var(--primary)' : 'var(--text-2)',
    fontWeight: primary ? 600 : 500,
  };
}
