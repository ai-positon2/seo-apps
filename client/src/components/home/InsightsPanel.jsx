import { useCallback, useEffect, useState } from 'react';
import { projectsApi } from '../../lib/projectsApi';
import { Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner } from './primitives';

// ── The six modules, read together ───────────────────────────────────────────
//
// The dashboard used to open with six scores side by side and no answer to the
// only question a marketing team actually has: what do we do first, and what did
// it cost us not to. This panel is that answer, and it is assembled entirely from
// evidence the modules had already stored and nobody was reading.
//
// Four sections, in the order a person needs them:
//
//   1. the lead        one sentence, the highest-severity thing found across
//                      modules — the thing you would say out loud first
//   2. do this next    the ranked backlog, each item carrying the measured facts
//                      that put it where it is, and a way to turn it into an
//                      accountable recommendation
//   3. what changed    since the previous run, with what was NOT re-checked stated
//                      beside what was, because a fix count without that is a lie
//   4. not measured    the modules that failed, the insights withheld, the data
//                      not connected (§30: a capability gap is surfaced, never
//                      quietly absent)
//
// Nothing here is generated prose. Every number carries the basis it came from,
// and a check that could not run says so instead of returning a zero.

const SEVERITY_TONE = { error: 'neg', warning: 'warn', notice: 'muted', info: 'muted' };

export default function InsightsPanel({
  projectId, projectName, onChanged, data, loading, error, onReload,
}) {
  const [promoting, setPromoting] = useState(null);
  const [promoted, setPromoted] = useState({});
  const [showAll, setShowAll] = useState(false);

  // The takeaway at the top of the page and this panel are the same answer, so
  // they share one request rather than making two that could disagree.
  const load = useCallback(() => { if (onReload) onReload(); }, [onReload]);

  async function promote(item) {
    setPromoting(item.key);
    try {
      await projectsApi.promoteInsight(projectId, item.key);
      setPromoted((p) => ({ ...p, [item.key]: 'done' }));
      // The recommendations board is elsewhere on this page; it has to refresh or
      // the item appears to vanish into nothing.
      if (onChanged) onChanged();
    } catch (e) {
      setPromoted((p) => ({ ...p, [item.key]: e.message }));
    } finally {
      setPromoting(null);
    }
  }

  if (loading && !data) {
    return (
      <section style={{ marginTop: 24 }}>
        <SectionHead title="What the modules say together" />
        <Spinner label="Reading stored evidence across all six modules…" />
      </section>
    );
  }

  if (error) {
    return (
      <section style={{ marginTop: 24 }}>
        <SectionHead title="What the modules say together" />
        <Card style={{ padding: 18, gap: 8 }}>
          <Kicker tone="muted">Insights unavailable</Kicker>
          <Muted size={13}>{error.message}</Muted>
          <div><Btn onClick={load}>Try again</Btn></div>
        </Card>
      </section>
    );
  }

  if (!data) return null;

  const { lead, insights, backlog, changes, gaps } = data;
  const actions = backlog?.actions || [];
  const shown = showAll ? actions : actions.slice(0, 6);

  return (
    <section style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHead
        title={`What the modules say together — ${projectName}`}
        right={`${insights.length} cross-module insight${insights.length === 1 ? '' : 's'}`}
      />

      {/* ── 1. The lead ─────────────────────────────────────────────────── */}
      {lead ? (
        <Card elevation="md" style={{ padding: 20, gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Kicker>The headline</Kicker>
            <Tag tone={SEVERITY_TONE[lead.severity] || 'muted'}>{lead.severity}</Tag>
            <Muted>{lead.modules.join(' + ')}</Muted>
          </div>
          <p style={{ margin: 0, fontSize: 19, lineHeight: 1.35, color: 'var(--text)' }}>
            {lead.headline}
          </p>
          {lead.action && (
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)' }}>
              {lead.action}
            </p>
          )}
          {/* Traceability, not decoration: any figure above can be walked back to
              the stored field it came from. */}
          <Muted size={11}>Read from {lead.readFrom.join(', ')}</Muted>
        </Card>
      ) : (
        <Card style={{ padding: 18, gap: 6 }}>
          <Kicker tone="muted">Nothing correlated yet</Kicker>
          <Muted size={13}>
            No insight spans two modules yet. The section below says which modules have
            not produced the evidence one would need.
          </Muted>
        </Card>
      )}

      {/* ── 2. Do this next ─────────────────────────────────────────────── */}
      <Card id="do-this-next" style={{ padding: 18, gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <Kicker>Do this next</Kicker>
          <Muted>
            {backlog.totals.actions} item{backlog.totals.actions === 1 ? '' : 's'}
            {backlog.totals.templateWide
              ? ` · ${backlog.totals.templateWide} fixable in the template`
              : ''}
          </Muted>
        </div>

        {/* The ranking explains itself. A list somebody cannot argue with is a
            list somebody cannot trust. */}
        <Muted size={11.5} style={{ lineHeight: 1.5 }}>{backlog.ranking.basis}</Muted>

        {!actions.length && (
          <Muted size={13}>
            No actionable finding is stored yet. Run the modules listed under
            “Not measured” below.
          </Muted>
        )}

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {shown.map((item, i) => (
            <div key={item.key}>
              {i > 0 && <FadingRule />}
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)',
                    minWidth: 20, paddingTop: 2,
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, color: 'var(--text)' }}>{item.title}</span>
                    {item.scope === 'template' && <Tag tone="outline">template-wide</Tag>}
                  </div>
                  <Muted size={11.5}>{item.basisLine}</Muted>
                  {item.effortHint && <Muted size={11.5}>Effort: {item.effortHint}</Muted>}
                  {promoted[item.key] && promoted[item.key] !== 'done' && (
                    <Muted size={11.5} style={{ color: 'var(--viz-neg)' }}>{promoted[item.key]}</Muted>
                  )}
                </div>
                <div style={{ flexShrink: 0 }}>
                  {promoted[item.key] === 'done' ? (
                    <Muted size={11.5}>Drafted ✓</Muted>
                  ) : (
                    <Btn
                      onClick={() => promote(item)}
                      disabled={promoting === item.key}
                    >
                      {promoting === item.key ? 'Drafting…' : 'Draft a recommendation'}
                    </Btn>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {actions.length > 6 && (
          <div>
            <Btn onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${actions.length}`}
            </Btn>
          </div>
        )}

        {backlog.totals.pagesAffectedNote && (
          <Muted size={11.5} style={{ lineHeight: 1.5 }}>{backlog.totals.pagesAffectedNote}</Muted>
        )}

        {Boolean(backlog.needsReview?.length) && (
          <>
            <FadingRule />
            <Muted size={11.5} style={{ lineHeight: 1.5 }}>
              {backlog.needsReview.length} check{backlog.needsReview.length === 1 ? '' : 's'} could
              not be automated and need a person to look — they are kept out of this list because
              nobody can fix “data unavailable”.
            </Muted>
          </>
        )}
      </Card>

      {/* ── The other insights ──────────────────────────────────────────── */}
      {insights.length > 1 && (
        <Card style={{ padding: 18, gap: 4 }}>
          <Kicker>Everything else the modules agree on</Kicker>
          {insights.slice(1).map((ins, i) => (
            <div key={ins.id}>
              {i > 0 && <FadingRule />}
              <div style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Tag tone={SEVERITY_TONE[ins.severity] || 'muted'}>{ins.severity}</Tag>
                  <span style={{ fontSize: 14, color: 'var(--text)' }}>{ins.headline}</span>
                </div>
                {ins.action && (
                  <Muted size={12.5} style={{ lineHeight: 1.5 }}>{ins.action}</Muted>
                )}
                <Muted size={11}>{ins.modules.join(' + ')}</Muted>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* ── 3. What changed ─────────────────────────────────────────────── */}
      {changes && <ChangesCard changes={changes} />}

      {/* ── 4. Not measured ─────────────────────────────────────────────── */}
      {Boolean(gaps.length) && (
        <Card style={{ padding: 18, gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Kicker tone="muted">Not measured</Kicker>
            <Muted>{gaps.length}</Muted>
          </div>
          <Muted size={11.5} style={{ lineHeight: 1.5 }}>
            What this audit cannot see, and what would fix it. A gap named here is not a
            problem found — it is a question nobody has answered yet.
          </Muted>
          {gaps.map((gap, i) => (
            <div key={`${gap.kind}-${gap.id || gap.moduleKey}`}>
              {i > 0 && <FadingRule />}
              <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Tag tone="muted">{gap.kind}</Tag>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>
                    {gap.label || gap.id}
                  </span>
                </div>
                <Muted size={12} style={{ lineHeight: 1.5 }}>{gap.reason}</Muted>
                {gap.unblock && <Muted size={11.5}>→ {gap.unblock}</Muted>}
              </div>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/**
 * Run-over-run change, with the caveat inseparable from the number.
 *
 * The page audits work to a budget, so which pages get audited moves between
 * runs. A fix count without "and N pages were not re-checked" beside it tells a
 * client they fixed something nobody looked at.
 */
function ChangesCard({ changes }) {
  const rows = [...(changes.modules || [])];
  if (changes.crawl) rows.unshift(changes.crawl);
  if (!rows.length) return null;

  return (
    <Card style={{ padding: 18, gap: 8 }}>
      <Kicker>What changed since the previous run</Kicker>
      {rows.map((row, i) => (
        <div key={row.moduleKey}>
          {i > 0 && <FadingRule />}
          <div style={{ padding: '9px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{row.moduleLabel}</span>

              {row.state === 'first_run' && <Tag tone="muted">first run</Tag>}
              {row.state === 'not_comparable' && <Tag tone="muted">not comparable</Tag>}

              {row.score && row.score.delta !== null && (
                <Tag tone={row.score.direction === 'up' ? 'accent'
                  : row.score.direction === 'down' ? 'neg' : 'muted'}
                >
                  {row.score.previous} → {row.score.current}
                  {row.score.delta > 0 ? ` (+${row.score.delta})` : row.score.delta < 0 ? ` (${row.score.delta})` : ''}
                </Tag>
              )}

              {row.state === 'compared' && (
                <Muted size={12}>
                  {typeof row.fixed?.length === 'number' && `${row.fixed.length} fixed`}
                  {typeof row.appeared?.length === 'number' && ` · ${row.appeared.length} new`}
                  {typeof row.stillOpen?.length === 'number' && ` · ${row.stillOpen.length} still open`}
                </Muted>
              )}
            </div>

            {(row.reason || row.caveat) && (
              <Muted size={11.5} style={{ lineHeight: 1.5 }}>{row.reason || row.caveat}</Muted>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}
