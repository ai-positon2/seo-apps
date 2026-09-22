// ── The nine report bodies ───────────────────────────────────────────────────
//
// Every number here arrives pre-formatted from the server as
// {value, display, delta, deltaDisplay, direction} and this file renders
// `display`. Nothing in here divides, rounds, or decides what an empty state
// means — metrics/format.js already did, and the moment a component does its
// own arithmetic the spec stops being the single source of truth.
//
// Where a value is null the server has already decided it renders an em-dash,
// and usually attached the reason. An unexplained dash reads as a bug; an
// explained one reads as an answer.
//
// Colour comes from the app's own tokens, not from the reference design's
// hexes — its README says to map onto an existing design system rather than
// hard-code, which is also what makes light mode work for free.

import { useState } from 'react';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead,
} from '../studio/primitives';
import {
  FilledLabelBar, TypeChip, ShowMore,
} from '../aiVisibility/reportPrimitives';
import { LineChart } from '../aiVisibility/reportCharts';
import {
  SOURCE_TYPE_LABELS, PAGE_TYPE_LABELS, METRIC_INFO, engineLabel,
} from './reportRegistry';

// ── Shared pieces ──────────────────────────────────────────────────────────

/** A caption that has to travel with a number, not float beside it. */
function Basis({ children }) {
  if (!children) return null;
  return <Muted size={11} style={{ display: 'block', marginTop: 6 }}>{children}</Muted>;
}

/** An empty state that says WHY, so it cannot be mistaken for a broken page. */
function Empty({ title, detail }) {
  return (
    <Card style={{ padding: 20 }}>
      <Kicker tone="muted">{title}</Kicker>
      <Muted size={12} style={{ display: 'block', marginTop: 6 }}>{detail}</Muted>
    </Card>
  );
}

function Table({ head, children }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 560 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: head.cols,
          gap: 12,
          padding: '0 0 8px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
        }}
        >
          {head.labels.map((l, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{l}</span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

function Row({ cols, cells, strong = false, note = null }) {
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--neutral-800)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center' }}>
        {cells.map((c, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            style={{
              fontSize: 13,
              fontWeight: strong && i === 0 ? 600 : 400,
              textAlign: i === 0 ? 'left' : 'right',
              fontFamily: i === 0 ? 'inherit' : 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {c}
          </span>
        ))}
      </div>
      {note ? <Muted size={11}>{note}</Muted> : null}
    </div>
  );
}

/** Named / not named / not measured — three states that must not collapse. */
function OutcomeTag({ mentioned, status }) {
  if (status === 'failed' || mentioned === null || mentioned === undefined) {
    return <Tag tone="muted">not measured</Tag>;
  }
  return <Tag tone={mentioned ? 'accent' : 'neg'}>{mentioned ? 'named' : 'not named'}</Tag>;
}

// ── Expandable metric tiles ─────────────────────────────────────────────────
//
// A KPI strip where every number is a door: click one and it opens onto the
// real evidence behind it — the per-engine split, the competitor comparison,
// the run history — instead of a one-line definition. Only one tile is open
// at a time per strip, directly below the row it belongs to.

const DL_ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '4px 0' };

function DetailRow({ left, right, muted }) {
  return (
    <div style={DL_ROW}>
      <span style={muted ? { color: 'var(--text-3)' } : undefined}>{left}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: muted ? 'var(--text-3)' : undefined }}>{right}</span>
    </div>
  );
}

/** A thin proportional bar — used for the score's four weighted factors. */
function WeightBar({ pct, dim }) {
  return (
    <div style={{ height: 5, borderRadius: 3, background: 'var(--neutral-800)', overflow: 'hidden', marginTop: 3 }}>
      <div style={{
        height: '100%',
        width: `${Math.max(0, Math.min(100, pct))}%`,
        background: dim ? 'var(--text-3)' : 'var(--primary)',
      }}
      />
    </div>
  );
}

/**
 * The real data behind one metric tile. Every branch reads fields already on
 * `report` — nothing here computes a number the server didn't already hand
 * over, this only decides how to lay it out.
 */
function metricDetail(key, report) {
  switch (key) {
    case 'score': {
      const rows = report.headline.scoreBreakdown || [];
      return (
        <div>
          {rows.map((r) => (
            <div key={r.key} style={{ padding: '6px 0' }}>
              <div style={DL_ROW}>
                <span>{r.label} <span style={{ color: 'var(--text-3)' }}>({r.weight}% weight)</span></span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{r.included ? r.display : 'not counted'}</span>
              </div>
              <WeightBar pct={r.included ? r.value : 0} dim={!r.included} />
            </div>
          ))}
          {report.headline.score.note && (
            <Muted size={11} style={{ display: 'block', marginTop: 8 }}>{report.headline.score.note}</Muted>
          )}
        </div>
      );
    }
    case 'avgScore': {
      const runs = [...(report.trendAllRuns || [])].reverse().slice(0, 8);
      if (!runs.length) return <Muted size={12}>No completed run has a score yet.</Muted>;
      return (
        <div>
          {runs.map((r) => (
            <DetailRow key={r.runId} left={new Date(r.at).toLocaleDateString()} right={r.score.display} />
          ))}
        </div>
      );
    }
    case 'namedRate':
    case 'groundedRate': {
      const rows = report.byEngine || [];
      if (!rows.length) return <Muted size={12}>Nothing measured in this period.</Muted>;
      return (
        <div>
          {rows.map((e) => (
            <DetailRow
              key={e.engine}
              left={engineLabel(e.engine)}
              right={key === 'namedRate' ? e.namedRate.display : e.groundedRate.display}
            />
          ))}
        </div>
      );
    }
    case 'shareOfMentions':
    case 'mentionRank': {
      const brands = [...(report.brands || [])]
        .sort((a, b) => (key === 'mentionRank'
          ? (a.mentionRank.value ?? 99) - (b.mentionRank.value ?? 99)
          : (b.shareOfMentions.value ?? -1) - (a.shareOfMentions.value ?? -1)));
      if (!brands.length) return <Muted size={12}>Nothing measured in this period.</Muted>;
      return (
        <div>
          {brands.map((b) => (
            <DetailRow
              key={b.name}
              left={b.isClient ? `${b.name} (you)` : b.name}
              right={key === 'mentionRank' ? b.mentionRank.display : b.shareOfMentions.display}
            />
          ))}
        </div>
      );
    }
    case 'citationRate': {
      const domains = (report.sources?.domains || []).slice(0, 8);
      if (!domains.length) return <Muted size={12}>No citations recorded in this period.</Muted>;
      return (
        <div>
          {domains.map((d) => (
            <DetailRow key={d.domain} left={d.domain} right={`${d.citations} citation${d.citations === 1 ? '' : 's'}`} />
          ))}
        </div>
      );
    }
    case 'coverage': {
      const rows = report.byEngine || [];
      return (
        <div>
          <DetailRow left="Answers attempted" right={report.meta.answers} />
          <DetailRow left="Answers we could measure" right={report.meta.answersMeasured} />
          {rows.length > 0 && <div style={{ height: 1, background: 'var(--neutral-800)', margin: '6px 0' }} />}
          {rows.map((e) => (
            <DetailRow key={e.engine} left={engineLabel(e.engine)} right={`${e.measured} of ${e.answers}`} muted />
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

/** One clickable KPI tile — visually a MetricCard, but a toggle button. */
function ExpandableTile({ tileKey, label, metric, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tileKey)}
      style={{
        textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
        background: 'var(--card)',
        border: selected ? '1px solid var(--primary)' : '1px solid var(--border)',
        borderRadius: 'var(--r-lg)', padding: 16,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500,
          textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)',
        }}
        >
          {label}
        </span>
        <span style={{ fontSize: 10, color: selected ? 'var(--primary)' : 'var(--text-3)' }}>
          {selected ? '▲' : '▾'}
        </span>
      </div>
      <span style={{
        fontSize: 28, fontFamily: 'var(--font-mono)', fontWeight: 700,
        lineHeight: 1, color: 'var(--text)', letterSpacing: '-0.02em',
      }}
      >
        {metric ? metric.display : '—'}
      </span>
      {metric?.note && (
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.35 }}>{metric.note}</span>
      )}
    </button>
  );
}

/**
 * A KPI strip whose tiles expand into the evidence behind them. `tiles` is
 * `[{ key, label, metric }]` — `key` selects both the METRIC_INFO one-liner
 * and the metricDetail() branch, so adding a tile to a strip is one line as
 * long as `report` already carries what that key's detail needs.
 */
function ExpandableMetricStrip({ tiles, report, min = 190 }) {
  const [selected, setSelected] = useState(null);
  const active = tiles.find((t) => t.key === selected);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 }}>
        {tiles.map((t) => (
          <ExpandableTile
            key={t.key}
            tileKey={t.key}
            label={t.label}
            metric={t.metric}
            selected={selected === t.key}
            onSelect={(k) => setSelected((cur) => (cur === k ? null : k))}
          />
        ))}
      </div>
      {active && (
        <div style={{
          marginTop: 10, padding: 16, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
        }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{active.label}</div>
          {METRIC_INFO[active.key] && (
            <Muted size={11.5} style={{ display: 'block', marginTop: 3, marginBottom: 8 }}>
              {METRIC_INFO[active.key]}
            </Muted>
          )}
          {metricDetail(active.key, report)}
        </div>
      )}
    </div>
  );
}

// ── 1. Executive overview ──────────────────────────────────────────────────

// Plain-English bands for the 0-100 score, so a reader who has never seen a
// GEO/AI-visibility number before still knows whether 47 is good or bad
// without learning the scale first. Ranges match the width used elsewhere in
// this app's own maturity ladders (five 20-point bands).
const SCORE_STAGES = [
  { max: 20, label: 'Barely visible', color: 'var(--viz-neg)', blurb: 'AI almost never brings you up.' },
  { max: 40, label: 'Starting to show up', color: 'var(--viz-neg)', blurb: 'AI mentions you sometimes, but not often.' },
  { max: 60, label: 'Getting noticed', color: 'var(--viz-warn)', blurb: 'AI mentions you about as often as it doesn’t.' },
  { max: 80, label: 'Well known', color: 'var(--primary)', blurb: 'AI regularly includes you in its answers.' },
  { max: Infinity, label: 'Leading the conversation', color: 'var(--primary)', blurb: 'AI treats you as one of the top answers.' },
];
const stageFor = (score) => (
  typeof score === 'number' ? SCORE_STAGES.find((s) => score <= s.max) : null
);

/** A plain checklist row: does this engine mention you at all, and how often. */
function EngineChecklist({ byEngine }) {
  if (!byEngine.length) return null;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {byEngine.map((e) => {
        const present = e.namedRate.value !== null && e.namedRate.value > 0;
        return (
          <div key={e.engine} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 18, height: 18, borderRadius: '50%', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
              color: 'var(--card)', background: present ? 'var(--primary)' : 'var(--viz-neg)',
              flexShrink: 0,
            }}
            >
              {present ? '✓' : '✗'}
            </span>
            <span style={{ fontSize: 13, width: 90 }}>{engineLabel(e.engine)}</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
              {e.namedRate.display}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function OverviewReport({ report }) {
  const brands = (report.brands || []).filter((b) => b.namedRate.value !== null);
  const ranked = [...brands].sort((a, b) => b.namedRate.value - a.namedRate.value);
  const clientRow = ranked.find((b) => b.isClient) || null;
  const rank = ranked.findIndex((b) => b.isClient) + 1;

  // The verdict is gated on having something to compare against. With one
  // tracked brand the client is always rank 1 of 1, and a WINNING pill off
  // that is a claim nobody measured.
  const comparable = ranked.length >= 2 && report.headline.namedRate.value !== null;
  const verdict = !comparable ? null
    : (rank === 1 ? 'LEADING' : (rank <= Math.ceil(ranked.length / 2) ? 'HOLDING' : 'BEHIND'));

  const runnerUp = ranked.find((b) => !b.isClient) || null;
  const weakest = [...(report.byQuestion || [])]
    .filter((q) => q.state !== 'not_measured')
    .sort((a, b) => (a.namedRate.value ?? 1) - (b.namedRate.value ?? 1))
    .slice(0, 5);

  const stage = stageFor(report.headline.score.value);
  const brandName = clientRow?.name || 'You';

  // The one plain sentence a non-technical reader needs first: does AI bring
  // this brand up, and how does that compare to before. Everything else on
  // this card is that same claim broken into its parts.
  const summary = report.headline.namedRate.value === null
    ? 'We haven’t measured any AI answers for this project yet.'
    : `When people ask AI assistants questions like the ones this project tracks, `
      + `${brandName} comes up in ${report.headline.namedRate.display} of the answers.`;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 22 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {verdict ? <Tag tone={verdict === 'BEHIND' ? 'neg' : 'accent'}>{verdict}</Tag> : null}
          <Muted size={11} style={{ fontFamily: 'var(--font-mono)', letterSpacing: '.1em' }}>
            {report.meta.answersMeasured} ANSWERS MEASURED
            {report.meta.answers !== report.meta.answersMeasured
              ? ` OF ${report.meta.answers} ATTEMPTED` : ''}
          </Muted>
        </div>

        {/* The one number a first-time reader needs, in plain words: not "47"
            but "Getting noticed" — the number is still there for anyone who
            wants it, just no longer the FIRST thing that has to be decoded. */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <div style={{
            fontSize: 48, fontWeight: 700, lineHeight: 1,
            fontFamily: 'var(--font-mono)', letterSpacing: '-.02em',
            color: stage ? stage.color : 'var(--text)',
          }}
          >
            {report.headline.score.display}
            <span style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-3)' }}>/100</span>
          </div>
          {stage && (
            <div>
              <div style={{ fontSize: 18, fontWeight: 600, color: stage.color }}>{stage.label}</div>
              <Muted size={12.5}>{stage.blurb}</Muted>
            </div>
          )}
        </div>

        <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-.01em', marginTop: 16, lineHeight: 1.4 }}>
          {summary}
        </div>

        <Muted size={13} style={{ display: 'block', marginTop: 6 }}>
          {comparable && runnerUp
            ? `Out of the ${ranked.length} brands this project tracks, ${brandName} ranks #${rank}. `
              + `The next one, ${runnerUp.name}, comes up in ${runnerUp.namedRate.display} of answers.`
            : 'This project isn’t tracking any competitors yet, so there’s nothing to compare against — '
              + 'add one or two to see how you stack up.'}
        </Muted>

        {report.headline.avgScore.value !== null && (
          <Muted size={12} style={{ display: 'block', marginTop: 4 }}>
            Usually around {report.headline.avgScore.display}/100 across every check this project has run.
          </Muted>
        )}

        <FadingRule style={{ margin: '16px 0' }} />

        <Kicker>Which AI tools mention you</Kicker>
        <div style={{ marginTop: 10 }}>
          <EngineChecklist byEngine={report.byEngine} />
        </div>

        <FadingRule style={{ margin: '16px 0' }} />

        <Kicker>The details behind the score — click a number to see the evidence</Kicker>
        <div style={{ marginTop: 10 }}>
          <ExpandableMetricStrip
            report={report}
            tiles={[
              { key: 'namedRate', label: 'Shows up in AI answers', metric: report.headline.namedRate },
              { key: 'shareOfMentions', label: 'Share of the spotlight', metric: report.headline.shareOfMentions },
              { key: 'citationRate', label: 'Trusted as a source', metric: report.headline.citationRate },
              { key: 'mentionRank', label: 'Typical spot when named', metric: report.headline.mentionRank },
              { key: 'groundedRate', label: 'Based on a live search', metric: report.headline.groundedRate },
            ]}
          />
        </div>

        <Basis>{report.meta.basis}</Basis>
        {report.headline.score.note ? <Basis>{report.headline.score.note}</Basis> : null}
      </Card>

      {ranked.length >= 2 ? (
        <Card style={{ padding: 18 }}>
          <SectionHead title="Against the brands this project tracks" />
          <Muted size={11}>
            Counted in answers, not occurrences. Bars are relative to the brand named most.
          </Muted>
          <div style={{ marginTop: 12 }}>
            {ranked.map((b) => (
              <FilledLabelBar
                key={b.name}
                label={b.isClient ? `${b.name} — this client` : b.name}
                value={b.named}
                max={Math.max(...ranked.map((x) => x.named), 1)}
                display={`${b.namedRate.display}  ·  ${b.named}/${b.answers}`}
                highlight={b.isClient}
              />
            ))}
          </div>
        </Card>
      ) : null}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <Card style={{ padding: 18 }}>
          <SectionHead title="Questions where you are least visible" />
          <Muted size={11}>
            Ranked by how often the models named you. Facts only — no recommendation.
          </Muted>
          <div style={{ marginTop: 10 }}>
            {weakest.length ? weakest.map((q) => (
              <div key={q.promptId || q.text} style={{ padding: '9px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                <div style={{ fontSize: 13 }}>{q.text}</div>
                <Muted size={11}>
                  named in {q.named} of {q.measured} answers
                  {q.competitors.length ? ` · models named ${q.competitors.slice(0, 3).join(', ')} instead` : ''}
                </Muted>
              </div>
            )) : <Muted size={12}>Nothing measured in this period.</Muted>}
          </div>
        </Card>

        <Card style={{ padding: 18 }}>
          <SectionHead title="Sources feeding competitors" right={<Muted size={11}>{report.gaps.total} total</Muted>} />
          <Muted size={11}>
            Sites the models read for answers that named a competitor and not you.
          </Muted>
          <div style={{ marginTop: 10 }}>
            {report.gaps.rows.length ? report.gaps.rows.slice(0, 5).map((g) => (
              <div key={g.domain} style={{ padding: '9px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontSize: 13 }}>{g.domain}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                    priority {g.gapScore}
                  </span>
                </div>
                <Muted size={11}>
                  {SOURCE_TYPE_LABELS[g.sourceType] || g.sourceType}
                  {' · named a competitor in '}{g.namedCompetitor} of {g.answers} answers that used it
                  {' · named you in '}{g.namedYou}
                </Muted>
              </div>
            )) : (
              <Muted size={12}>
                No gaps found — no answer in this period named a tracked competitor, so there is
                nothing to compare against.
              </Muted>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── 2. Insights ────────────────────────────────────────────────────────────

export function InsightsReport({ report }) {
  const trend = report.trend?.length > 1 ? report.trend : report.trendAllRuns;
  const scoped = report.trend?.length > 1;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 20 }}>
        <SectionHead title="Headline" right={<Muted size={11}>click a number for the evidence</Muted>} />
        <ExpandableMetricStrip
          report={report}
          tiles={[
            { key: 'score', label: 'Score, this run', metric: report.headline.score },
            { key: 'avgScore', label: 'Avg score, all runs', metric: report.headline.avgScore },
            { key: 'namedRate', label: 'Named in answers', metric: report.headline.namedRate },
            { key: 'shareOfMentions', label: 'Share of mentions', metric: report.headline.shareOfMentions },
            { key: 'mentionRank', label: 'Mention order', metric: report.headline.mentionRank },
            { key: 'groundedRate', label: 'Answers that searched', metric: report.headline.groundedRate },
            { key: 'coverage', label: 'Answers captured', metric: report.meta.coverage },
          ]}
        />
        <Basis>{report.meta.basis}</Basis>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead
          title="By model"
          right={report.modelStrength.strongest ? (
            <Muted size={11}>
              strongest {engineLabel(report.modelStrength.strongest.engine)}
              {' · weakest '}{engineLabel(report.modelStrength.weakest.engine)}
            </Muted>
          ) : null}
        />
        <Muted size={11}>
          {report.modelStrength.note
            || 'The same questions, asked of each model.'}
        </Muted>
        <div style={{ marginTop: 12 }}>
          {report.byEngine.map((e) => (
            <FilledLabelBar
              key={e.engine}
              label={engineLabel(e.engine)}
              value={e.namedRate.value ?? 0}
              max={Math.max(...report.byEngine.map((x) => x.namedRate.value ?? 0), 0.01)}
              display={`${e.namedRate.display}  ·  ${e.named}/${e.measured}  ·  searched ${e.groundedRate.display}`}
            />
          ))}
        </div>
      </Card>

      {trend?.length > 1 ? (
        <Card style={{ padding: 18 }}>
          <SectionHead title="Across runs" />
          <Muted size={11}>
            One point per measurement run — the unit that asked the whole question set at one
            moment. {scoped ? '' : 'Showing every run, including runs outside the selected period.'}
          </Muted>
          <div style={{ marginTop: 12 }}>
            <LineChart
              buckets={trend.map((t) => ({ label: new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }))}
              series={[{
                key: 'named',
                label: 'Named in answers',
                points: trend.map((t) => ({ value: t.namedRate.value })),
              }]}
            />
          </div>
        </Card>
      ) : (
        <Empty
          title="No trend yet"
          detail="A trend needs at least two measurement runs. Runs are manual on this project, so
                  this fills in as you measure again."
        />
      )}
    </div>
  );
}

// ── 3. Perception ──────────────────────────────────────────────────────────

export function PerceptionReport({ described, describedAt }) {
  if (!described?.attributes?.length) {
    return (
      <Empty
        title="Nothing to describe yet"
        detail="This reads the answers that named the brand. Until at least three answers name it,
                there is nothing to characterise — and inventing something would be worse than
                saying so."
      />
    );
  }

  const max = Math.max(...described.attributes.map((a) => a.answers), 1);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {described.sentiment ? (
        <Card style={{ padding: 20 }}>
          <SectionHead title="How warmly the models speak about it" />
          <div style={{ display: 'flex', gap: 20, alignItems: 'baseline', marginTop: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 38, fontWeight: 500, letterSpacing: '-.03em' }}>
              {described.sentiment.score}
              <span style={{ fontSize: 16, color: 'var(--text-3)' }}>/100</span>
            </div>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontSize: 13 }}>{described.sentiment.rationale}</div>
              <Muted size={11}>
                Over {described.sentiment.basis} answers that named the brand. 50 is a neutral
                listing; above 60 is genuine praise.
              </Muted>
            </div>
          </div>
          <FadingRule style={{ margin: '14px 0 10px' }} />
          {described.sentiment.quotes.map((q) => (
            <Muted key={q} size={12} style={{ display: 'block', fontStyle: 'italic' }}>“{q}”</Muted>
          ))}
        </Card>
      ) : null}

      <Card style={{ padding: 18 }}>
        <SectionHead title="What they say it is" />
        <Muted size={11}>
          Taken from the {described.basis} answers that named the brand. Every line is backed by a
          verbatim quote — hover to read it.
        </Muted>
        <div style={{ marginTop: 12 }}>
          {described.attributes.map((a) => (
            <div key={a.label} title={a.quotes.join('\n\n')}>
              <FilledLabelBar
                label={a.label}
                value={a.answers}
                max={max}
                display={`${a.answers} of ${described.basis}`}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title="Their exact words" />
        <Muted size={11}>
          Copied from the answers, not paraphrased. A description whose quote was not a literal
          span of some answer was discarded before it reached this page.
        </Muted>
        <div style={{ marginTop: 10 }}>
          {described.attributes.flatMap((a) => a.quotes.map((q) => (
            <div key={`${a.label}:${q}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--neutral-800)' }}>
              <div style={{ fontSize: 13 }}>“{q}”</div>
              <Muted size={11}>{a.label}</Muted>
            </div>
          )))}
        </div>
        <Basis>
          {described.discarded
            ? `${described.discarded} suggested description${described.discarded === 1 ? ' was' : 's were'} dropped for having no quote in the answers. `
            : ''}
          {describedAt ? `From the run of ${new Date(describedAt).toLocaleString()}. ` : ''}
          This panel is a snapshot of one run, so it does not follow the period filter.
        </Basis>
      </Card>
    </div>
  );
}

// ── 4. Questions ───────────────────────────────────────────────────────────

export function QuestionsReport({ report }) {
  const cols = '1fr 92px 92px 108px';
  return (
    <Card style={{ padding: 18 }}>
      <SectionHead
        title={`Every question (${report.byQuestion.length})`}
        right={<Muted size={11}>{report.headline.namedRate.display} overall</Muted>}
      />
      <Muted size={11}>
        Each question is asked of all three models, so a rate here is over at most three answers —
        the count beside it is the denominator.
      </Muted>
      <div style={{ marginTop: 12 }}>
        <Table head={{ cols, labels: ['Question', 'Named', 'Searched', 'Models'] }}>
          <ShowMore
            items={report.byQuestion}
            initial={10}
            noun="more questions"
            render={(q) => (
              <div key={q.promptId || q.text} style={{ padding: '10px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 13 }}>{q.text}</span>
                  <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                    {q.state === 'not_measured' ? '—' : `${q.namedRate.display}`}
                  </span>
                  <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-2)' }}>
                    {q.groundedRate.display}
                  </span>
                  <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {q.byEngine.map((e) => (
                      <Tag
                        key={e.engine}
                        tone={e.mentioned === null ? 'muted' : (e.mentioned ? 'accent' : 'neg')}
                      >
                        {engineLabel(e.engine).slice(0, 6)}
                      </Tag>
                    ))}
                  </span>
                </div>
                <Muted size={11}>
                  {q.state === 'not_measured'
                    ? 'Not measured in this period.'
                    : `named in ${q.named} of ${q.measured} answers`}
                  {q.intent ? ` · ${q.intent}` : ''}
                  {q.competitors.length ? ` · also named ${q.competitors.slice(0, 3).join(', ')}` : ''}
                </Muted>
              </div>
            )}
          />
        </Table>
      </div>
    </Card>
  );
}

// ── 5. Gap analysis ────────────────────────────────────────────────────────

export function GapsReport({ report }) {
  const { gaps } = report;
  if (!gaps.rows.length) {
    return (
      <Empty
        title="No gaps in this period"
        detail="A gap is a source the models read for an answer that named a competitor and not you.
                No answer in this period named a tracked competitor, so there is nothing to rank.
                Adding competitors to the project widens what this can see."
      />
    );
  }

  const cols = '1fr 130px 92px 92px 84px';
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 20 }}>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 40, fontWeight: 500, lineHeight: 1, color: 'var(--viz-neg)' }}>
            {gaps.total}
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 15 }}>
              sources fed answers that named a competitor and not you.
            </div>
            <Muted size={12}>
              The largest is <strong>{gaps.biggest.domain}</strong> — used in {gaps.biggest.answers} answers,
              naming a competitor in {gaps.biggest.namedCompetitor} of them and you in {gaps.biggest.namedYou}.
            </Muted>
          </div>
        </div>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title="Ranked by gap score" />
        <Muted size={11}>
          Gap score weights how often a source is read against how much of a gap it represents, and
          by what kind of site it is — a directory you can get listed in counts for more than a
          competitor&apos;s own site. This ranks facts; it does not recommend.
        </Muted>
        <div style={{ marginTop: 12 }}>
          <Table head={{ cols, labels: ['Source', 'Kind', 'Competitor', 'You', 'Score'] }}>
            <ShowMore
              items={gaps.rows}
              initial={10}
              noun="more sources"
              render={(g) => (
                <Row
                  key={g.domain}
                  cols={cols}
                  cells={[
                    g.domain,
                    SOURCE_TYPE_LABELS[g.sourceType] || g.sourceType,
                    `${g.namedCompetitor}/${g.answers}`,
                    `${g.namedYou}/${g.answers}`,
                    String(g.gapScore),
                  ]}
                />
              )}
            />
          </Table>
        </div>
      </Card>
    </div>
  );
}

// ── 6. Sources (domains) ───────────────────────────────────────────────────

export function DomainsReport({ report }) {
  const { sources } = report;
  if (!sources.totalCitations) {
    return (
      <Empty
        title="No sources cited yet"
        detail="The models did not return any citations for these answers in this period."
      />
    );
  }

  const cols = '1fr 130px 92px 92px';
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 18 }}>
        <SectionHead title="What kind of sites the models read" />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {sources.byType.map((t) => (
            <span key={t.type} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TypeChip type={SOURCE_TYPE_LABELS[t.type] || t.type} title={`${t.citations} citations`} />
              <Muted size={11}>{t.share.display}</Muted>
            </span>
          ))}
        </div>
        <Basis>
          {sources.totalCitations} citations across {report.meta.answersMeasured} measured answers.
          {sources.unattributed
            ? ` ${sources.unattributed} more came back without an identifiable publisher and are excluded.`
            : ''}
        </Basis>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title="Every source" />
        <div style={{ marginTop: 12 }}>
          <Table head={{ cols, labels: ['Source', 'Kind', 'Citations', 'Answers'] }}>
            <ShowMore
              items={sources.domains}
              initial={12}
              noun="more sources"
              render={(s) => (
                <Row
                  key={s.domain}
                  strong={s.sourceType === 'you'}
                  cols={cols}
                  cells={[
                    s.domain,
                    SOURCE_TYPE_LABELS[s.sourceType] || s.sourceType,
                    String(s.citations),
                    String(s.answers),
                  ]}
                />
              )}
            />
          </Table>
        </div>
      </Card>
    </div>
  );
}

// ── 7. Pages (urls) ────────────────────────────────────────────────────────

export function UrlsReport({ report }) {
  const { urls } = report;
  if (!urls.rows.length) {
    return (
      <Empty
        title="No pages to list"
        detail={urls.basis.why || 'No citations with a usable page URL in this period.'}
      />
    );
  }

  const cols = '1fr 110px 92px 92px';
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 18 }}>
        <SectionHead title="What kind of pages" />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {urls.byType.map((t) => (
            <span key={t.type} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TypeChip type={PAGE_TYPE_LABELS[t.type] || t.type} title={`${t.citations} citations`} />
              <Muted size={11}>{t.share.display}</Muted>
            </span>
          ))}
        </div>
        <Basis>{urls.basis.why}</Basis>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title={`Pages pulled into answers (${urls.rows.length})`} />
        <div style={{ marginTop: 12 }}>
          <Table head={{ cols, labels: ['Page', 'Type', 'Citations', 'Models'] }}>
            <ShowMore
              items={urls.rows}
              initial={12}
              noun="more pages"
              render={(u) => (
                <div key={u.url} style={{ padding: '9px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {/* No synthesised title — a fabricated one on a page a
                          client will click through to discredits the table. */}
                      {u.title || u.url}
                    </span>
                    <span style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {PAGE_TYPE_LABELS[u.pageType] || u.pageType}
                    </span>
                    <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{u.citations}</span>
                    <span style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {u.engines.map(engineLabel).join(', ')}
                    </span>
                  </div>
                  {u.title ? <Muted size={11}>{u.url}</Muted> : null}
                </div>
              )}
            />
          </Table>
        </div>
      </Card>
    </div>
  );
}

// ── 8. Answers ─────────────────────────────────────────────────────────────

/** The verbatim answer, collapsed by default — some run past a thousand words. */
function AnswerToggle({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 11.5, color: 'var(--primary)', fontFamily: 'var(--font-mono)',
        }}
      >
        {open ? 'Hide answer' : 'Show answer'}
      </button>
      {open && (
        <div style={{
          marginTop: 6, padding: 10, background: 'var(--surface)', borderRadius: 'var(--r-md)',
          fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
        }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** One engine's citations for one answer — a domain and, if there is one, its title, linked out. */
function CitationList({ citations }) {
  if (!citations.length) return null;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {citations.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <a
          key={`${c.url || c.domain}-${i}`}
          href={c.url || undefined}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-2)',
            textDecoration: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)',
            padding: '2px 8px', pointerEvents: c.url ? 'auto' : 'none',
          }}
          title={c.title || c.url || c.domain}
        >
          {c.domain || c.title || 'source'}
        </a>
      ))}
    </div>
  );
}

export function AnswersReport({ report }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 20 }}>
        <ExpandableMetricStrip
          report={report}
          min={180}
          tiles={[
            { key: 'coverage', label: 'Answers measured', metric: report.meta.coverage },
            { key: 'namedRate', label: 'Named in answers', metric: report.headline.namedRate },
            { key: 'groundedRate', label: 'Answers that searched', metric: report.headline.groundedRate },
            { key: 'citationRate', label: 'Cited as a source', metric: report.headline.citationRate },
          ]}
        />
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title="Every question, every model" />
        <Muted size={11}>
          One block per question and model: whether it named you, who else it named instead, what it
          cited, and the answer itself. Answers we could not read are shown too — a list that quietly
          dropped them would make coverage invisible.
        </Muted>
        <div style={{ marginTop: 12 }}>
          <ShowMore
            items={report.byQuestion}
            initial={6}
            noun="more questions"
            render={(q) => (
              <div key={q.promptId || q.text} style={{ padding: '12px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{q.text}</div>
                <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                  {q.byEngine.length ? q.byEngine.map((e) => (
                    <div key={e.engine} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ width: 90, fontSize: 12.5, color: 'var(--text-2)' }}>{engineLabel(e.engine)}</span>
                        <OutcomeTag mentioned={e.mentioned} status={e.status} />
                        {e.grounded === false ? <Tag tone="muted">did not search</Tag> : null}
                        {e.cited ? <Tag tone="accent">cited your site</Tag> : null}
                        {e.failureReason ? <Muted size={11}>{e.failureReason}</Muted> : null}
                      </div>
                      {/* Who this engine named instead, on this question — a subset
                          of q.competitors, which pools every engine together. */}
                      {e.competitorsMentioned.length ? (
                        <Muted size={11} style={{ paddingLeft: 100 }}>
                          Also named: {e.competitorsMentioned.join(', ')}
                        </Muted>
                      ) : null}
                      <div style={{ paddingLeft: 100 }}>
                        <CitationList citations={e.citations} />
                      </div>
                      <div style={{ paddingLeft: 100 }}>
                        <AnswerToggle text={e.answerText} />
                      </div>
                    </div>
                  )) : <Muted size={11}>Not measured in this period.</Muted>}
                </div>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  );
}
