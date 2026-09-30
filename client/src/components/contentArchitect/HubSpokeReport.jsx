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

import { useState, useEffect, useMemo } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ca } from '../../lib/contentArchitectApi';
import { indexWork } from '../../lib/hubSpokeWork';
import TopicWork from './work/TopicWork';
import WorkTally from './work/WorkTally';
import { EnhancementBadge, EnhancementPanel } from './work/PageEnhancement';

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
  if (cluster.referenceIndexUrl) {
    // Glossary entries: the glossary's own index page is their hub.
    return { key: 'reference', color: 'var(--primary)', status: 'Glossary', action: 'Index is hub' };
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
//
// The project and cluster ride along too, so the finished enhancement is saved
// against this page and shows up here beside it (enhancementsStore.js).
function enhanceHref(url, contentType, origin) {
  const params = new URLSearchParams({ url, contentType });
  if (origin?.caProjectId) {
    params.set('caProject', origin.caProjectId);
    if (origin.clusterId) params.set('cluster', origin.clusterId);
  }
  return `/article-enhancement?${params}`;
}

function actionButtonStyle(outlined) {
  return {
    flexShrink: 0, whiteSpace: 'nowrap', cursor: 'pointer',
    fontFamily: 'var(--font-sans)', fontSize: outlined ? 12 : 11.5, fontWeight: outlined ? 500 : 600,
    color: outlined ? 'var(--primary-text)' : 'var(--text-2)',
    background: outlined ? 'transparent' : 'var(--surface)',
    border: `1px solid ${outlined ? 'var(--primary)' : 'var(--border)'}`,
    borderRadius: outlined ? 'var(--r-pill)' : 6,
    padding: outlined ? '5px 12px' : '4px 10px',
  };
}

// A run already exists for this exact page/topic (runStore.findCompletedRunsByLabel,
// read via ca.getActionStatus) — offer to view it instead of inviting a duplicate.
// Opens /runs, which already knows how to fetch and display one run by id
// (RunDetailDrawer) — no new viewer built for this.
function ViewRecommendationButton({ runId, navigate, outlined = false }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate(`/runs?runId=${runId}`); }}
      title="Already created — view the run that produced it"
      style={actionButtonStyle(outlined)}
    >
      View Recommendation
    </button>
  );
}

// A page with a saved enhancement shows it through its badge (PageEnhancement),
// so the action becomes "Re-enhance". The older run-history link is kept only
// for pages enhanced before results were saved.
function EnhanceButton({ url, contentType, navigate, label = 'Enhance', outlined = false, viewRunId = null, origin = null, saved = false }) {
  if (!url) return null;
  if (viewRunId && !saved) return <ViewRecommendationButton runId={viewRunId} navigate={navigate} outlined={outlined} />;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigate(enhanceHref(url, contentType, origin)); }}
      title={saved
        ? 'Run the enhancement again — the saved result is replaced when it finishes'
        : `Open this ${contentType === 'hub' ? 'hub' : 'page'} in Enhance Existing Article`}
      style={actionButtonStyle(outlined)}
    >
      {saved ? (contentType === 'hub' ? 'Re-enhance hub' : 'Re-enhance') : label}
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

// Where a suggestion's rationale came from — kept short, since the rationale
// sentence itself already says the specific number/quote.
const SUGGESTION_SOURCE_LABEL = {
  keyword_volume: 'Search volume',
  people_also_ask: 'Real question',
  competitor_gap: 'Competitor gap',
  reasoning: 'AI judgment',
};

// The Keywords → Brief → Draft rail for one suggested topic, wired to this
// cluster's saved keyword research and the project's work index.
function TopicWorkFor({ topic, cluster, projectId, kbClient, navigate, keywordResearch, workIndex, onWorkChanged, recommendedTopics }) {
  return (
    <TopicWork
      key={topic}
      projectId={projectId}
      clusterId={cluster.id}
      topic={topic}
      client={kbClient}
      navigate={navigate}
      entry={workIndex.forTopic(cluster.id, topic)}
      saved={keywordResearch.byTopic[topic] || null}
      onSaved={keywordResearch.remember}
      onWorkChanged={onWorkChanged}
      aside={recommendedTopics[topic]?.runId
        ? <ViewRecommendationButton runId={recommendedTopics[topic].runId} navigate={navigate} />
        : null}
    />
  );
}

function SuggestedSpokesPanel({ cluster, projectId, kbClient, suggestions, onSuggestions, navigate, recommendedTopics = {}, keywordResearch, workIndex, onWorkChanged }) {
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
              <div style={{ marginTop: 10 }}>
                <TopicWorkFor
                  topic={s.title} cluster={cluster} projectId={projectId} kbClient={kbClient} navigate={navigate}
                  keywordResearch={keywordResearch} workIndex={workIndex} onWorkChanged={onWorkChanged}
                  recommendedTopics={recommendedTopics}
                />
              </div>
            </div>
          ))}
          {!suggestions.signals.llmAvailable && (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>OPENAI_API_KEY not configured — showing keyword ideas as-is rather than AI-shaped topics. Use Keyword Research on any of these to take it further.</div>
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

function SpokeTable({ spokes, navigate, enhancedUrls = {}, workIndex, origin }) {
  const columns = 'minmax(0,1fr) 90px 100px 92px';
  const [openUrl, setOpenUrl] = useState(null);
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
            const enhancement = workIndex.forPage(s.url);
            const expanded = openUrl === s.url && enhancement;
            return (
              <div key={s.id} style={{ borderBottom: i < spokes.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div
                style={{
                  display: 'grid', gridTemplateColumns: columns, gap: 12, padding: '10px 14px',
                  alignItems: 'center',
                  background: expanded ? 'color-mix(in srgb, var(--success) 5%, transparent)' : 'transparent',
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
                  {enhancement && (
                    <div style={{ marginTop: 5 }}>
                      <EnhancementBadge enhancement={enhancement} open={Boolean(expanded)} onToggle={() => setOpenUrl(expanded ? null : s.url)} />
                    </div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>
                  {s.wordCount ? s.wordCount.toLocaleString() : '—'}
                </span>
                <Badge variant={st.variant}>{st.label}</Badge>
                {/* A spoke is long-form, so it goes over as an article — and
                    the label says so, to pair with "Enhance hub" above. */}
                <EnhanceButton
                  url={s.url} contentType="article" navigate={navigate} label="Enhance article"
                  viewRunId={enhancedUrls[s.url]?.runId || null}
                  origin={origin} saved={Boolean(enhancement)}
                />
              </div>
              {expanded && (
                <div style={{ padding: '0 14px 12px' }}>
                  <EnhancementPanel
                    projectId={origin.caProjectId}
                    url={enhancement.url}
                    onReEnhance={() => navigate(enhanceHref(s.url, 'article', origin))}
                  />
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// This cluster's saved inline keyword research, by topic — fetched the first
// time the row opens, and kept here (above the panels) so collapsing the row
// does not lose a run that finished while it was open.
function useClusterKeywordResearch(projectId, clusterId, open) {
  const [byTopic, setByTopic] = useState({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open || loaded || !projectId) return;
    let alive = true;
    setLoaded(true);
    ca.listKeywordResearch(projectId, clusterId)
      .then(({ items }) => {
        if (!alive) return;
        // A run that finished before this load answered wins over the stored copy.
        setByTopic((prev) => ({ ...Object.fromEntries(items.map((r) => [r.topic, r])), ...prev }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, loaded, projectId, clusterId]);
  const remember = (record) => setByTopic((prev) => ({ ...prev, [record.topic]: record }));
  return { byTopic, remember };
}

function ClusterRow({ cluster, pageById, navigate, projectId, kbClient, suggestions, onSuggestions, actionStatus, workIndex, onWorkChanged }) {
  const { enhancedUrls = {}, recommendedTopics = {} } = actionStatus || {};
  const [open, setOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const keywordResearch = useClusterKeywordResearch(projectId, cluster.id, open);
  const origin = { caProjectId: projectId, clusterId: cluster.id };
  const tally = workIndex.tally(cluster, pageById);
  // Topics with saved work that this row does not otherwise show — a
  // suggestion replaced by Re-suggest keeps its keywords and drafts here.
  const shownTopics = [
    ...(cluster.isGap && cluster.gapSuggestion?.title ? [cluster.gapSuggestion.title] : []),
    ...((suggestions?.suggestions || []).map((s) => s.title)),
  ];
  const earlier = open ? workIndex.earlierTopics(cluster.id, shownTopics) : [];
  const topicProps = { cluster, projectId, kbClient, navigate, keywordResearch, workIndex, onWorkChanged, recommendedTopics };
  const state = hubState(cluster);
  const healthy = state.key === 'selected' || state.key === 'reference';
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
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <WorkTally tally={tally} />
          {healthy && hub ? (
            <EnhanceButton
              url={hub.url} contentType="hub" navigate={navigate} label="Enhance hub" outlined
              viewRunId={enhancedUrls[hub.url]?.runId || null}
              origin={origin} saved={Boolean(workIndex.forPage(hub.url))}
            />
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
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)' }}>
                  <TopicWorkFor topic={cluster.gapSuggestion.title} {...topicProps} />
                </div>
              )}
            </div>
          ) : hub && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <EnhancementBadge enhancement={workIndex.forPage(hub.url)} open={hubOpen} onToggle={() => setHubOpen((v) => !v)} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                    {hub.wordCount ? `${hub.wordCount.toLocaleString()} words` : '—'}
                  </span>
                </span>
              </div>
              {hubOpen && workIndex.forPage(hub.url) && (
                <EnhancementPanel
                  projectId={projectId}
                  url={workIndex.forPage(hub.url).url}
                  onReEnhance={() => navigate(enhanceHref(hub.url, 'hub', origin))}
                />
              )}
            </div>
          )}
          {!hub && cluster.referenceIndexUrl && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)', background: 'var(--surface)' }}>
              <Badge variant="success">HUB</Badge>
              <a
                href={cluster.referenceIndexUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                Glossary index — {cluster.referenceIndexUrl.replace(/^https?:\/\//, '')}
              </a>
            </div>
          )}

          <SpokeTable spokes={spokes} navigate={navigate} enhancedUrls={enhancedUrls} workIndex={workIndex} origin={origin} />

          <SuggestedSpokesPanel
            cluster={cluster}
            projectId={projectId}
            kbClient={kbClient}
            suggestions={suggestions}
            onSuggestions={onSuggestions}
            navigate={navigate}
            recommendedTopics={recommendedTopics}
            keywordResearch={keywordResearch}
            workIndex={workIndex}
            onWorkChanged={onWorkChanged}
          />

          {earlier.length > 0 && (
            <div>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', color: 'var(--text-3)' }}>
                EARLIER TOPICS · {earlier.length}
              </span>
              <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--text-3)' }}>
                Topics no longer in the suggestions above, kept because work was saved for them.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {earlier.map((e) => (
                  <div key={e.topic} style={{ padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px dashed var(--border-strong)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{e.topic}</div>
                    <TopicWorkFor topic={e.topic} {...topicProps} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Work saved against clusters or pages this analysis no longer has — made
// before a re-run regrouped the site. Read-only here: the topics' rails still
// open their keywords, brief and draft, and enhancements still open.
function EarlierWorkRow({ orphans, projectId, kbClient, navigate, workIndex, onWorkChanged }) {
  const [open, setOpen] = useState(false);
  const [openUrl, setOpenUrl] = useState(null);
  const count = orphans.topics.length + orphans.enhancements.length;
  return (
    <div style={{ borderRadius: 'var(--r-lg)', background: 'var(--card)', border: '1px dashed var(--border-strong)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)' }}
      >
        <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, border: '2px dashed var(--text-3)', boxSizing: 'border-box' }} />
        <span style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text)' }}>Work from an earlier analysis</span>
        <span style={{ fontSize: 13, color: 'var(--primary-text)', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          {count} item{count === 1 ? '' : 's'} {open ? '▲' : '▾'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-3)' }}>Saved for clusters or pages this run no longer lists</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 18px 16px 62px', borderTop: '1px solid var(--border)' }}>
          {orphans.topics.map((e) => (
            <div key={`${e.clusterId}:${e.topic}`} style={{ padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{e.topic}</div>
              <TopicWork
                projectId={projectId} clusterId={e.clusterId} topic={e.topic} client={kbClient} navigate={navigate}
                entry={workIndex.forTopic(e.clusterId, e.topic)} saved={null} onWorkChanged={onWorkChanged}
              />
            </div>
          ))}
          {orphans.enhancements.map((en) => (
            <div key={en.url} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{en.title || en.url}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <EnhancementBadge enhancement={en} open={openUrl === en.url} onToggle={() => setOpenUrl(openUrl === en.url ? null : en.url)} />
                </span>
              </div>
              {openUrl === en.url && (
                <EnhancementPanel projectId={projectId} url={en.url} onReEnhance={() => navigate(enhanceHref(en.url, en.contentType || 'article', { caProjectId: projectId }))} />
              )}
            </div>
          ))}
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

// `kbClient` is the knowledge-base client slug for this site, or '' — sent to
// Keyword Research and Content Writer only when the site really is one.
// `work` is everything made from this report (GET /work); `onWorkChanged`
// reloads it after a panel here saves something new.
export default function HubSpokeReport({ analysis, pageById, navigate, projectId, kbClient = '', onSuggestions, actionStatus, work = null, onWorkChanged }) {
  const workIndex = useMemo(() => indexWork(work), [work]);
  const orphans = useMemo(() => workIndex.orphans(
    (analysis.clusters || []).map((c) => c.id),
    (analysis.clusters || []).flatMap((c) => [c.hubPageId, ...(c.spokeIds || [])]).map((id) => pageById.get(id)?.url).filter(Boolean),
  ), [workIndex, analysis.clusters, pageById]);
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
                kbClient={kbClient}
                suggestions={spokeSuggestionsByCluster[c.id] || null}
                onSuggestions={(result) => onSuggestions(c.id, result)}
                actionStatus={actionStatus}
                workIndex={workIndex}
                onWorkChanged={onWorkChanged}
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
                kbClient={kbClient}
                suggestions={spokeSuggestionsByCluster[c.id] || null}
                onSuggestions={(result) => onSuggestions(c.id, result)}
                actionStatus={actionStatus}
                workIndex={workIndex}
                onWorkChanged={onWorkChanged}
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

      {orphans.topics.length + orphans.enhancements.length > 0 && (
        <EarlierWorkRow
          orphans={orphans} projectId={projectId} kbClient={kbClient} navigate={navigate}
          workIndex={workIndex} onWorkChanged={onWorkChanged}
        />
      )}
    </div>
  );
}
