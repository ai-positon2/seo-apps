// Hub and Spoke — the status-first read of a Content Architect analysis.
//
// Every topic works best with one strong hub page linking out to a set of
// specific spoke pages. This report answers one question in one screen: where
// is that pattern working, and where does a topic have spokes but no hub.
//
// It replaced a master/detail cluster browser. The browser made you click a
// cluster to learn whether it had a hub, which is the one fact you want about
// every cluster at once — so the hub state is now on the row, the rows are
// split into the two groups that matter, and the detail that used to fill the
// right-hand pane is what a row expands into. Nothing the pane carried was
// dropped: the suggested hub title for a gap, the hub page and its word count,
// and each spoke's word count and status are all still here.
//
// Everything reads a field that is genuinely in the stored analysis. Health,
// hub selection, ambiguity and the per-page flags are all the analysis's own
// output; none of it is re-derived here.

import { useState, useEffect, useRef } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ca } from '../../lib/contentArchitectApi';

/** Health bands, shared with the page's donut so the two cannot disagree. */
export function healthVariant(score) {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'danger';
}

// A cluster is in one of three hub states, and the whole report is colour-coded
// by it: the dot, the status word, the health figure and the action chip all
// take this one colour so a row reads as a single verdict.
function hubState(cluster) {
  if (cluster.isGap) {
    return { key: 'gap', color: 'var(--danger)', status: 'Hub missing', action: 'Create hub' };
  }
  if (cluster.ambiguous) {
    return { key: 'ambiguous', color: 'var(--warning)', status: 'Hub unclear', action: 'Review' };
  }
  return { key: 'selected', color: 'var(--primary)', status: 'Hub found', action: 'Established' };
}

function spokeStatusFor(page) {
  const flags = page.flags || [];
  if (flags.includes('orphan')) return { label: 'Orphaned', variant: 'danger', fix: 'no inbound links — add links from the hub or sibling spokes' };
  if (flags.includes('thin-or-stale')) return { label: 'Thin', variant: 'warning', fix: 'thin content — expand or refresh' };
  if (flags.includes('buried')) return { label: 'Buried', variant: 'neutral', fix: 'buried deep — reduce clicks from the homepage' };
  return { label: 'Healthy', variant: 'success', fix: null };
}

// ── Enhance ─────────────────────────────────────────────────────────────────
//
// Hub and Spoke identifies the pages; Enhance Existing Article is what you do
// about them. They were two tools with no path between them: you read a spoke
// URL here, went to the sidebar, found the enhancer, and pasted the URL back in.
//
// The content type carries over because it changes what the enhancer does — a
// hub is a navigational page judged on how well it covers and links a topic, a
// spoke is long-form judged on depth. Sending every page over as "article" would
// have the enhancer rewrite a hub as if it were one.
//
// Both values land as ordinary initial state on the other side, so they stay
// editable: this is a prefill, not a lock.
function enhanceHref(url, contentType) {
  return `/article-enhancement?url=${encodeURIComponent(url)}&contentType=${contentType}`;
}

function EnhanceButton({ url, contentType, navigate, label = 'Enhance', outlined = false }) {
  if (!url) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate(enhanceHref(url, contentType)); }}
      title={`Open this ${contentType === 'hub' ? 'hub' : 'page'} in Enhance Existing Article`}
      style={{
        flexShrink: 0, whiteSpace: 'nowrap', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', fontSize: outlined ? 12 : 11.5, fontWeight: outlined ? 500 : 600,
        color: outlined ? 'var(--primary-text)' : 'var(--text-2)',
        background: outlined ? 'transparent' : 'var(--surface)',
        border: `1px solid ${outlined ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: outlined ? 'var(--r-pill)' : 6,
        padding: outlined ? '5px 12px' : '4px 10px',
      }}
    >
      {label}
    </button>
  );
}

// ── Summary tiles ───────────────────────────────────────────────────────────

const ClustersIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="2.5" /><circle cx="12" cy="4" r="1.8" /><circle cx="20" cy="9" r="1.8" />
    <circle cx="17" cy="19" r="1.8" /><circle cx="7" cy="19" r="1.8" /><circle cx="4" cy="9" r="1.8" />
    <path d="M12 6.5v3M18.3 10l-4 1.5M15.8 17.3l-2.5-4M8.2 17.3l2.5-4M5.7 10l4 1.5" />
  </svg>
);

const CheckIcon = ({ size = 20, width = 3 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 13l4 4L19 7" />
  </svg>
);

const DashedIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" strokeDasharray="3,3" />
  </svg>
);

function SummaryTile({ label, value, color, iconBg, icon }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: 18,
        borderRadius: 'var(--r-lg)', background: 'var(--card)',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}
    >
      <span
        style={{
          width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', background: iconBg,
        }}
      >
        {icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 600, lineHeight: 1, color }}>
          {value}
        </span>
      </span>
    </div>
  );
}

// ── Inline keyword research ─────────────────────────────────────────────────
//
// Content Architect only ever hands off a TOPIC (an AI-suggested title, not a
// researched keyword) — never straight to Article Recommendation. Instead of
// navigating away to the standalone Keyword Research page, this runs that
// same backend pipeline (POST /init + SSE /stream, unchanged) inline and
// expands the topic card in place: research it here, approve which keywords
// actually fit, THEN write a brief for one of THOSE — not the raw suggestion.
//
// Deliberately a lighter consumer of the SSE stream than KeywordResearchPage
// itself: it only reads `step` (one status line, not the full 6-badge
// timeline), `result`, and `fail` — the per-URL/per-query detail events exist
// for the full page's own UI and have no compact equivalent here.
function keyOf(kw) { return (kw.keyword || '').trim().toLowerCase(); }
const MAX_APPROVED = 2;

function InlineKeywordResearch({ topic, client, navigate }) {
  const [phase, setPhase] = useState('idle'); // idle | running | done | error
  const [statusMessage, setStatusMessage] = useState('');
  const [candidates, setCandidates] = useState([]); // [{keyword, volume, ...}]
  const [approved, setApproved] = useState(new Set()); // keyOf(kw) -> approved
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const esRef = useRef(null);

  useEffect(() => () => esRef.current?.close(), []);

  function run() {
    setPhase('running');
    setError('');
    setStatusMessage('Starting…');
    fetch('/api/keyword-research/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ keyword: topic, client: client || undefined }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to start');
        return res.json();
      })
      .then(({ token }) => {
        const es = new EventSource(`/api/keyword-research/stream/${token}`);
        esRef.current = es;
        es.addEventListener('step', (e) => setStatusMessage(JSON.parse(e.data).message || ''));
        es.addEventListener('result', (e) => {
          const d = JSON.parse(e.data);
          const primary = d.primary || [];
          const secondary = d.secondary || [];
          const merged = [...primary, ...secondary].filter((kw, i, arr) => arr.findIndex((k) => keyOf(k) === keyOf(kw)) === i);
          setCandidates(merged);
          // Primary keywords are already the AI's top pick — pre-approved,
          // still editable (a checkbox, not a lock).
          setApproved(new Set(primary.map(keyOf)));
          setWarning(d.warning || '');
        });
        // The server always emits 'done' after 'fail' too (its SSE handler's
        // outer finally), so 'done' must not blindly flip phase to 'done' —
        // it only wins if nothing has already marked this run as failed.
        es.addEventListener('fail', (e) => { setPhase('error'); setError(JSON.parse(e.data).message || 'Research failed.'); });
        es.addEventListener('done', () => { es.close(); esRef.current = null; setPhase((p) => (p === 'error' ? p : 'done')); });
        es.onerror = () => { es.close(); esRef.current = null; setPhase('error'); setError((prev) => prev || 'Connection lost. Please try again.'); };
      })
      .catch((e) => { setPhase('error'); setError(e.message); });
  }

  // Same 2-primary-keyword cap the standalone Keyword Research page already
  // enforces (KeywordResearchPage.jsx's primaryList) — one brief targets a
  // primary keyword pair, not an open-ended list. Unchecking is never
  // blocked, only adding a 3rd.
  function toggle(kw) {
    setApproved((prev) => {
      const k = keyOf(kw);
      if (prev.has(k)) {
        const next = new Set(prev);
        next.delete(k);
        return next;
      }
      if (prev.size >= MAX_APPROVED) return prev;
      return new Set(prev).add(k);
    });
  }

  if (phase === 'idle') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); run(); }}
          title="Research keywords for this topic, right here — approve which ones fit, then write a brief for one"
          style={{
            fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px',
            cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
          }}
        >
          Keyword Research
        </button>
      </div>
    );
  }

  const approvedKeywords = candidates.filter((kw) => approved.has(keyOf(kw)));
  // Highest-volume approved keyword drives the brief — Article Recommendation
  // targets one seed keyword, not a list; the others stay visible as
  // approved context but aren't lost, just not the one a brief gets written
  // for right now.
  const topApproved = approvedKeywords.length
    ? [...approvedKeywords].sort((a, b) => (b.volume || 0) - (a.volume || 0))[0]
    : null;

  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--surface)' }}>
      {phase === 'running' && (
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Researching keywords for "{topic}"… {statusMessage}</div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {error}
          <button type="button" onClick={(e) => { e.stopPropagation(); run(); }} style={{ fontSize: 11, color: 'var(--text-2)', background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>Retry</button>
        </div>
      )}
      {phase === 'done' && (
        <>
          {warning && <div style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 8 }}>{warning}</div>}
          {candidates.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No keywords came back for this topic.</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Approve up to {MAX_APPROVED} primary keywords for now</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                  background: approved.size === MAX_APPROVED ? 'var(--success-soft)' : 'var(--danger-soft, #FEF2F2)',
                  color: approved.size === MAX_APPROVED ? 'var(--success)' : 'var(--danger)',
                }}>
                  {approved.size} / {MAX_APPROVED} selected
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {candidates.map((kw) => {
                const checked = approved.has(keyOf(kw));
                const atCap = !checked && approved.size >= MAX_APPROVED;
                return (
                <label
                  key={keyOf(kw)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: atCap ? 'not-allowed' : 'pointer', opacity: atCap ? 0.5 : 1 }}
                  title={atCap ? `Primary is full (${MAX_APPROVED}/${MAX_APPROVED}) — remove one first` : undefined}
                >
                  <input type="checkbox" checked={checked} disabled={atCap} onChange={(e) => { e.stopPropagation(); toggle(kw); }} onClick={(e) => e.stopPropagation()} />
                  <span style={{ fontSize: 12.5, color: 'var(--text)', flex: 1 }}>{kw.keyword}</span>
                  {kw.volume ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{kw.volume.toLocaleString('en-US')}/mo</span> : null}
                </label>
                );
              })}
              </div>
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              type="button"
              disabled={!topApproved}
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/article-recommendation?keyword=${encodeURIComponent(topApproved.keyword)}${client ? `&client=${encodeURIComponent(client)}` : ''}`);
              }}
              title={topApproved ? `Write a content brief for "${topApproved.keyword}"` : 'Approve a keyword above first'}
              style={{
                fontSize: 12, fontWeight: 600, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--primary)',
                background: topApproved ? 'var(--primary)' : 'var(--surface)', color: topApproved ? '#fff' : 'var(--text-3)',
                cursor: topApproved ? 'pointer' : 'not-allowed', opacity: topApproved ? 1 : 0.6,
              }}
            >
              Recommend Article{topApproved ? ` for "${topApproved.keyword}"` : ''}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Where a suggestion's rationale came from — kept short, since the rationale
// sentence itself already says the specific number/quote.
const SUGGESTION_SOURCE_LABEL = {
  keyword_volume: 'Search volume',
  people_also_ask: 'Real question',
  competitor_gap: 'Competitor gap',
  reasoning: 'AI judgment',
};

function SuggestedSpokesPanel({ cluster, projectId, siteName, suggestions, onSuggestions, navigate }) {
  const isGap = cluster.isGap;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const result = await ca.suggestSpokes(projectId, cluster.id);
      onSuggestions(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' }}>
          {isGap ? 'SUPPORTING TOPICS' : 'SUGGESTED SPOKES'}{suggestions ? ` · ${suggestions.suggestions.length}` : ''}
        </span>
        <Button variant="secondary" size="sm" onClick={run} disabled={loading}>
          {loading ? 'Finding topics…' : suggestions ? 'Re-suggest' : (isGap ? 'Suggest supporting topics' : 'Suggest new spokes')}
        </Button>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--text-3)' }}>
        {isGap
          ? "Keyword and question research for this topic — use it to plan the hub above and its spokes together, since neither is written yet."
          : "Topics this hub doesn't cover yet — not pages that exist and need linking, new content ideas."}
      </p>

      {error && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

      {suggestions && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {suggestions.suggestions.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No confident gaps found for this topic.</div>
          )}
          {suggestions.suggestions.map((s, i) => (
            <div key={i} style={{ padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{s.title}</span>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {(s.basedOn?.length ? s.basedOn : ['reasoning']).map((b) => (
                    <Badge key={b} variant="neutral">{SUGGESTION_SOURCE_LABEL[b] || b}</Badge>
                  ))}
                </div>
              </div>
              {s.rationale && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-3)' }}>{s.rationale}</p>}
              <div style={{ marginTop: 8 }}>
                <InlineKeywordResearch topic={s.title} client={siteName} navigate={navigate} />
              </div>
            </div>
          ))}
          {!suggestions.signals.llmAvailable && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>ANTHROPIC_API_KEY not configured — showing keyword ideas as-is rather than AI-shaped topics. Use Keyword Research on any of these to take it further.</div>
          )}
          {!suggestions.signals.semrushAvailable && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>SEMRUSH_API_KEY not configured — no real search-volume signal was available.</div>
          )}
          {!suggestions.signals.paaIsReal && suggestions.signals.paaQuestionCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>No "People also ask" data for this search — questions shown are AI-inferred, not real search behavior.</div>
          )}
          {suggestions.signals.competitorsQueried?.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Checked against {suggestions.signals.competitorsQueried.join(', ')} for competitor keyword gaps
              {suggestions.signals.competitorGapCandidateCount === 0 ? ' — none relevant to this specific topic.' : '.'}
            </div>
          )}
          {!suggestions.signals.competitorsQueried?.length && suggestions.signals.competitorDomains?.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>No competitor domains set for this project — add some above to include competitor keyword gaps here.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── One cluster ─────────────────────────────────────────────────────────────

function SpokeTable({ spokes, navigate }) {
  const columns = 'minmax(0,1fr) 90px 100px 92px';
  return (
    <div>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' }}>
        SPOKES · {spokes.length}
      </span>
      {spokes.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>No spoke pages in this cluster.</div>
      ) : (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--border)', overflow: 'hidden', marginTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 12, padding: '8px 14px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
            {['SPOKE PAGE', 'WORDS', 'STATUS', 'ACTION'].map((h) => (
              <span key={h} style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>{h}</span>
            ))}
          </div>
          {spokes.map((s, i) => {
            const st = spokeStatusFor(s);
            return (
              <div
                key={s.id}
                style={{
                  display: 'grid', gridTemplateColumns: columns, gap: 12, padding: '10px 14px',
                  alignItems: 'center',
                  borderBottom: i < spokes.length - 1 ? '1px solid var(--border)' : 'none',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 13, color: 'var(--text)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.title || s.url}
                  </a>
                  {/* The URL is shown in mono under the title: on a site of
                      near-identical location pages the title is not enough to
                      tell two spokes apart. */}
                  <div
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {s.url}
                  </div>
                  {st.fix && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>{st.fix}</div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>
                  {s.wordCount ? s.wordCount.toLocaleString() : '—'}
                </span>
                <Badge variant={st.variant}>{st.label}</Badge>
                {/* A spoke is long-form, so it goes over as an article — and
                    the label says so, to pair with "Enhance hub" above. */}
                <EnhanceButton url={s.url} contentType="article" navigate={navigate} label="Enhance article" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ClusterRow({ cluster, pageById, navigate, projectId, siteName, suggestions, onSuggestions }) {
  const [open, setOpen] = useState(false);
  const state = hubState(cluster);
  const healthy = state.key === 'selected';
  const hub = cluster.hubPageId ? pageById.get(cluster.hubPageId) : null;
  const spokes = cluster.spokeIds.map((id) => pageById.get(id)).filter(Boolean);
  const scored = Number.isFinite(cluster.health);
  const health = scored ? cluster.health : null;

  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', flexWrap: 'wrap', cursor: 'pointer' }}
      >
        {/* A solid, ticked circle for an established hub; a dashed outline for
            one that is missing or unclear — the shape says "not settled yet"
            before any of the words are read. */}
        {healthy ? (
          <span
            aria-hidden="true"
            style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <CheckIcon size={13} />
          </span>
        ) : (
          <span
            aria-hidden="true"
            style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, border: `2px dashed ${state.color}`, boxSizing: 'border-box' }}
          />
        )}

        <span style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text)', width: 190, flexShrink: 0 }}>
          {cluster.name}
        </span>

        <span style={{ fontSize: 13, color: state.color, width: 100, flexShrink: 0 }}>{state.status}</span>

        <span
          style={{
            fontSize: 13, color: 'var(--primary-text)', width: 90, flexShrink: 0,
            textDecoration: 'underline', textUnderlineOffset: 2,
          }}
        >
          {spokes.length} spoke{spokes.length === 1 ? '' : 's'} {open ? '▲' : '▾'}
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: 140, flexShrink: 0 }}>
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600, color: scored ? state.color : 'var(--text-3)', width: 24 }}
            title={scored ? undefined : 'Health was not measured for this cluster'}
          >
            {scored ? health : '—'}
          </span>
          <span style={{ flex: 1, height: 5, borderRadius: 999, background: 'var(--surface)', overflow: 'hidden' }}>
            {scored && (
              <span
                style={{ display: 'block', height: '100%', borderRadius: 999, width: `${Math.max(2, Math.min(100, health))}%`, background: state.color }}
              />
            )}
          </span>
        </span>

        {/* An established hub offers the action; a missing or unclear one states
            the verdict, because "create hub" is not something this screen can
            do for you. */}
        <span style={{ marginLeft: 'auto' }}>
          {healthy && hub ? (
            <EnhanceButton url={hub.url} contentType="hub" navigate={navigate} label="Enhance hub" outlined />
          ) : (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', fontSize: 12, padding: '5px 12px',
                borderRadius: 'var(--r-pill)', border: `1px solid ${state.color}`, color: state.color,
                whiteSpace: 'nowrap',
              }}
            >
              {state.action}
            </span>
          )}
        </span>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 18px 16px 62px', borderTop: '1px solid var(--border)' }}>
          {cluster.description && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3)', maxWidth: 640 }}>{cluster.description}</p>
          )}

          {cluster.isGap ? (
            <div style={{ padding: 14, borderRadius: 'var(--r-md)', border: '1px solid var(--danger)', background: 'var(--danger-soft)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', color: 'var(--text-3)' }}>SUGGESTED NEW PAGE</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginTop: 4 }}>
                {cluster.gapSuggestion?.title || cluster.name}
              </div>
              {cluster.gapSuggestion?.slug && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                  {cluster.gapSuggestion.slug}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
                Would tie together {spokes.length} existing page{spokes.length === 1 ? '' : 's'} below.
              </div>
              {cluster.gapSuggestion?.title && (
                <InlineKeywordResearch topic={cluster.gapSuggestion.title} client={siteName} navigate={navigate} />
              )}
            </div>
          ) : hub && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Badge variant={cluster.ambiguous ? 'warning' : 'success'}>HUB</Badge>
              <a
                href={hub.url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {hub.title || hub.url}
              </a>
              <span style={{ marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                {hub.wordCount ? `${hub.wordCount.toLocaleString()} words` : '—'}
              </span>
            </div>
          )}

          <SpokeTable spokes={spokes} navigate={navigate} />

          <SuggestedSpokesPanel
            cluster={cluster}
            projectId={projectId}
            siteName={siteName}
            suggestions={suggestions}
            onSuggestions={onSuggestions}
            navigate={navigate}
          />
        </div>
      )}
    </div>
  );
}

// Unassigned pages are not a cluster, but they answer the same question the
// rows above do — "what is not tied into anything" — so they get the same
// shape rather than a section of their own.
function UnassignedRow({ pages }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--card)', border: '1px dashed var(--border-strong)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', flexWrap: 'wrap' }}>
        <span
          aria-hidden="true"
          style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, border: '2px dashed var(--text-3)', boxSizing: 'border-box' }}
        />
        <span style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text)', width: 190, flexShrink: 0 }}>
          Unassigned pages
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-3)', width: 100, flexShrink: 0 }}>No cluster</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            fontSize: 13, color: 'var(--primary-text)', width: 90, flexShrink: 0,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
            textDecoration: 'underline', textUnderlineOffset: 2, fontFamily: 'var(--font-sans)',
          }}
        >
          {pages.length} page{pages.length === 1 ? '' : 's'} {open ? '▲' : '▾'}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>
          Did not clear the similarity bar for any cluster
        </span>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 18px 16px 62px', borderTop: '1px solid var(--border)', maxHeight: 420, overflowY: 'auto' }}>
          {pages.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {p.title || p.url}
              </a>
              {/* The cluster it came closest to joining. An unassigned page with
                  no explanation just looks like a mistake. */}
              {p.nearestCluster && (
                <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                  closest: {p.nearestCluster.clusterName} ({Math.round(p.nearestCluster.similarity * 100)}%)
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SectionLabel = ({ children, color }) => (
  <h6 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color }}>
    {children}
  </h6>
);

// ── The report ──────────────────────────────────────────────────────────────

export default function HubSpokeReport({ analysis, pageById, navigate, projectId, siteName, onSuggestions }) {
  const clusters = analysis.clusters || [];
  const unassigned = analysis.unassignedPages || [];
  const spokeSuggestionsByCluster = analysis.spokeSuggestionsByCluster || {};

  const gaps = clusters.filter((c) => c.isGap);
  const unclear = clusters.filter((c) => !c.isGap && c.ambiguous);
  const established = clusters.filter((c) => !c.isGap && !c.ambiguous);

  // Needs attention first, worst health first — the same ordering the old
  // browser used for its list, kept so the top of this screen is still the
  // thing to look at first.
  const needsAttention = [...gaps, ...unclear].sort((a, b) => (a.health || 0) - (b.health || 0));
  const healthy = [...established].sort((a, b) => (b.health || 0) - (a.health || 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--primary-text)' }}>
          Hub and Spoke
        </span>
        <h2 style={{ margin: 0, fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          How the site&rsquo;s topics are organized
        </h2>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--text-2)', maxWidth: '70ch' }}>
          Every topic works best with one strong hub page linking out to a set of specific spoke
          pages. Here&rsquo;s where that pattern is working, and where a topic has spokes but no hub
          to tie them together.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
        <SummaryTile
          label="Topic clusters"
          value={clusters.length}
          color="var(--text)"
          iconBg="var(--primary)"
          icon={<ClustersIcon />}
        />
        <SummaryTile
          label="Healthy hubs"
          value={established.length}
          color="var(--primary-text)"
          iconBg="var(--primary)"
          icon={<CheckIcon />}
        />
        <SummaryTile
          label="Missing hubs"
          value={gaps.length}
          color="var(--danger)"
          iconBg="var(--danger)"
          icon={<DashedIcon />}
        />
        <SummaryTile
          label="Unclear hub"
          value={unclear.length}
          color="var(--warning)"
          iconBg="var(--warning)"
          icon={<span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-on-primary)' }}>?</span>}
        />
      </div>

      {gaps.length > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 16, padding: '18px 22px',
            borderRadius: 'var(--r-lg)',
            background: 'color-mix(in srgb, var(--danger) 12%, var(--card))',
            border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center', background: 'var(--danger)',
              color: 'var(--text-on-primary)', fontSize: 18, fontWeight: 700,
            }}
          >
            !
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--text)' }}>
              {gaps.length} of {clusters.length} topic cluster{clusters.length === 1 ? '' : 's'} currently
              {gaps.length === 1 ? ' has' : ' have'} no hub page.
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
              Priority action: create hub pages for{' '}
              {gaps.slice(0, 2).map((c) => c.name).join(' and ')}
              {gaps.length > 2 ? `, and ${gaps.length - 2} more` : ''}.
            </span>
          </div>
        </div>
      )}

      {(needsAttention.length > 0 || unassigned.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionLabel color="var(--danger)">Needs attention</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {needsAttention.map((c) => (
              <ClusterRow
                key={c.id}
                cluster={c}
                pageById={pageById}
                navigate={navigate}
                projectId={projectId}
                siteName={siteName}
                suggestions={spokeSuggestionsByCluster[c.id] || null}
                onSuggestions={(result) => onSuggestions(c.id, result)}
              />
            ))}
            {unassigned.length > 0 && <UnassignedRow pages={unassigned} />}
          </div>
        </div>
      )}

      {healthy.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionLabel color="var(--primary-text)">Healthy / established</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {healthy.map((c) => (
              <ClusterRow
                key={c.id}
                cluster={c}
                pageById={pageById}
                navigate={navigate}
                projectId={projectId}
                siteName={siteName}
                suggestions={spokeSuggestionsByCluster[c.id] || null}
                onSuggestions={(result) => onSuggestions(c.id, result)}
              />
            ))}
          </div>
        </div>
      )}

      {clusters.length === 0 && (
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-3)' }}>
          No clusters were found for this selection.
        </p>
      )}
    </div>
  );
}
