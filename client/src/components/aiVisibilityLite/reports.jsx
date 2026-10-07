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
import MarkdownPreview from '@uiw/react-markdown-preview';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead,
} from '../studio/primitives';
import {
  FilledLabelBar, TypeChip, ShowMore,
} from '../aiVisibility/reportPrimitives';
import { LineChart } from '../aiVisibility/reportCharts';
import openaiLogo from './logos/openai.svg';
import claudeLogo from './logos/claude.webp';
import geminiLogo from './logos/gemini.webp';
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

/**
 * Tag colour for one model on one prompt, from its per-model totals
 * (byQuestion[].visibilityByEngine) — never from byEngine, which is one row
 * per ANSWER and so repeats a model once for every run in the period.
 * Amber is "named in some of its answers, not all".
 */
function engineTone(v) {
  if (!v.measured) return 'muted';
  if (v.named === 0) return 'neg';
  return v.named === v.measured ? 'accent' : 'warn';
}

/** A prompt's per-answer rows merged to one per model: competitors unioned, citations de-duplicated. */
function mergeByEngine(rows) {
  const merged = new Map();
  for (const r of rows || []) {
    if (!merged.has(r.engine)) merged.set(r.engine, { engine: r.engine, competitors: new Set(), citations: new Map() });
    const m = merged.get(r.engine);
    (r.competitorsMentioned || []).forEach((c) => m.competitors.add(c));
    (r.citations || []).forEach((c) => {
      const key = c.url || c.domain || c.title;
      if (key && !m.citations.has(key)) m.citations.set(key, c);
    });
  }
  return [...merged.values()]
    .sort((a, b) => a.engine.localeCompare(b.engine))
    .map((m) => ({ engine: m.engine, competitors: [...m.competitors], citations: [...m.citations.values()] }));
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

/**
 * One card per model across every answer in the period — the same card look
 * as a prompt's "Visibility by model", with the whole period's counts.
 */
function EngineOverviewCards({ byEngine }) {
  if (!byEngine.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
      {byEngine.map((e) => {
        const visual = ENGINE_VISUAL[e.engine] || DEFAULT_ENGINE_VISUAL;
        const status = !e.measured
          ? { text: 'Could not be measured', tone: 'muted' }
          : (e.named === 0 ? { text: 'Never mentions you', tone: 'neg' } : { text: 'Mentions you', tone: 'accent' });
        return (
          <div
            key={e.engine}
            style={{
              border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', background: 'var(--card)',
            }}
          >
            <div style={{ background: visual.tint, padding: '18px 14px', display: 'flex', justifyContent: 'center' }}>
              <EngineLogo engine={e.engine} visual={visual} />
            </div>
            <div style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)', lineHeight: 1 }}>
                {e.namedRate.display}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{engineLabel(e.engine)}</div>
              <div style={{ fontSize: 11.5, color: STATUS_TONE_COLOR[status.tone], marginTop: 2 }}>{status.text}</div>
              {e.measured > 0 && (
                <Muted size={11} style={{ display: 'block', marginTop: 2 }}>
                  In {e.named} of {e.measured} answer{e.measured === 1 ? '' : 's'}
                </Muted>
              )}
            </div>
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
          <EngineOverviewCards byEngine={report.byEngine} />
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
          <SectionHead title="Prompts where you are least visible" />
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
            || 'The same prompts, asked of each model.'}
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
            One point per measurement run — the unit that asked the whole prompt set at one
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

// ── 3. Sentiment ───────────────────────────────────────────────────────────
//
// The five bands are describe.js's own scale, word for word, so the gauge and
// the prompt that produced the number cannot disagree about what 55 means.

const SENTIMENT_BANDS = [
  { min: 0, max: 20, label: 'Warned against', color: '#B4483F', tone: 'negative' },
  { min: 20, max: 40, label: 'Negative', color: '#E07A5F', tone: 'negative' },
  { min: 40, max: 60, label: 'Neutral', color: '#B9B3A6', tone: 'neutral' },
  { min: 60, max: 80, label: 'Positive', color: '#6FB38F', tone: 'positive' },
  { min: 80, max: 101, label: 'Named the best choice', color: '#2F7D5B', tone: 'positive' },
];
const bandFor = (score) => SENTIMENT_BANDS.find((b) => score >= b.min && score < b.max) || SENTIMENT_BANDS[2];

const TONE_STYLE = {
  positive: { label: 'Positive', color: '#2F7D5B', bg: 'color-mix(in srgb, #2F7D5B 14%, transparent)' },
  neutral: { label: 'Neutral', color: '#8A8478', bg: 'color-mix(in srgb, #8A8478 14%, transparent)' },
  negative: { label: 'Negative', color: '#B4483F', bg: 'color-mix(in srgb, #B4483F 14%, transparent)' },
};

/** A face for a tone — smile, flat, frown — drawn, not an emoji, so it takes the tone's colour. */
function ToneFace({ tone, size = 18 }) {
  const color = TONE_STYLE[tone]?.color || 'var(--text-3)';
  const mouth = {
    positive: 'M8 14.5c1.2 1.6 2.5 2.3 4 2.3s2.8-.7 4-2.3',
    neutral: 'M8.5 15.5h7',
    negative: 'M8 16.8c1.2-1.6 2.5-2.3 4-2.3s2.8.7 4 2.3',
  }[tone] || 'M8.5 15.5h7';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label={TONE_STYLE[tone]?.label} style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" fill={`color-mix(in srgb, ${color} 12%, transparent)`} />
      <circle cx="9" cy="10" r="1.3" fill={color} />
      <circle cx="15" cy="10" r="1.3" fill={color} />
      <path d={mouth} stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A half-circle meter: five coloured bands, a needle at the score. */
function SentimentGauge({ score }) {
  const cx = 110; const cy = 110; const r = 90;
  const point = (value, radius) => {
    const a = Math.PI * (1 - value / 100);
    return [cx + radius * Math.cos(a), cy - radius * Math.sin(a)];
  };
  const arc = (from, to) => {
    const [x1, y1] = point(from, r);
    const [x2, y2] = point(to, r);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const [nx, ny] = point(score, r - 22);
  return (
    <svg viewBox="0 0 220 124" width="100%" style={{ maxWidth: 280, display: 'block' }} role="img" aria-label={`Sentiment ${score} out of 100`}>
      {SENTIMENT_BANDS.map((b) => (
        <path key={b.label} d={arc(b.min + 0.6, Math.min(b.max, 100) - 0.6)} stroke={b.color} strokeWidth="16" fill="none" />
      ))}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text)" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="7" fill="var(--text)" />
      <text x={cx - r} y={cy + 14} fontSize="10" textAnchor="middle" fill="var(--text-3)">0</text>
      <text x={cx + r} y={cy + 14} fontSize="10" textAnchor="middle" fill="var(--text-3)">100</text>
    </svg>
  );
}

/** Positive / neutral / negative as one stacked bar, proportional to answers. */
function ToneBar({ counts, height = 12 }) {
  const total = counts.classified || 0;
  if (!total) return null;
  return (
    <div style={{ display: 'flex', height, borderRadius: height / 2, overflow: 'hidden', background: 'var(--neutral-800)' }}>
      {['positive', 'neutral', 'negative'].map((t) => (counts[t] ? (
        <div
          key={t}
          title={`${counts[t]} ${t}`}
          style={{ width: `${(counts[t] / total) * 100}%`, background: TONE_STYLE[t].color }}
        />
      ) : null))}
    </div>
  );
}

const POSITION_LABELS = {
  first: 'Listed #1', top3: 'Listed #2–3', lower: 'Listed #4+', text: 'In the text only',
};
const TONE_ORDER = ['positive', 'neutral', 'negative'];

// Band colours are tuned for the gauge's arcs; as TEXT on a pale tint of
// themselves they are too faint (the neutral grey especially), so text uses
// a darker mix of the same colour.
const inkFor = (color) => `color-mix(in srgb, ${color} 62%, #1B1F22)`;

/** A prompt's score, big enough to read at a glance, coloured by its band. */
function ScoreBadge({ value }) {
  const band = bandFor(value);
  return (
    <div style={{
      width: 64, flexShrink: 0, textAlign: 'center', padding: '8px 4px', borderRadius: 12,
      background: `color-mix(in srgb, ${band.color} 14%, transparent)`,
      border: `1px solid color-mix(in srgb, ${band.color} 40%, transparent)`,
    }}
    >
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: inkFor(band.color), lineHeight: 1.1 }}>
        {Math.round(value)}
      </div>
      <div style={{ fontSize: 9.5, fontWeight: 600, color: inkFor(band.color), marginTop: 2, lineHeight: 1.2 }}>
        {band.label}
      </div>
    </div>
  );
}

/** The tone a model mostly took on one prompt, across its answers — ties read as neutral. */
function leadTone(answers) {
  const counts = TONE_ORDER.map((t) => [t, answers.filter((a) => a.tone === t).length]);
  const top = Math.max(...counts.map(([, n]) => n));
  const leaders = counts.filter(([, n]) => n === top).map(([t]) => t);
  return leaders.length === 1 ? leaders[0] : 'neutral';
}

/** One model on one prompt: its logo, the face of its usual tone, and how many answers. */
function ModelToneChip({ engine, answers }) {
  const visual = ENGINE_VISUAL[engine] || DEFAULT_ENGINE_VISUAL;
  const tone = leadTone(answers);
  return (
    <span
      title={`${engineLabel(engine)}: ${answers.map((a) => a.tone).join(', ')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 5px',
        borderRadius: 'var(--r-pill)', border: '1px solid var(--border)', background: 'var(--card)',
      }}
    >
      <span style={{
        width: 24, height: 24, borderRadius: '50%', background: visual.tint,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
      >
        <EngineLogo engine={engine} visual={visual} size={15} />
      </span>
      <ToneFace tone={tone} size={18} />
      {answers.length > 1 && (
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>×{answers.length}</span>
      )}
    </span>
  );
}

/**
 * One prompt: its score, the question, and each model's usual tone, closed to
 * one scannable line. Opens onto every answer behind the score — tone, where
 * it listed you, its score, and the words that decided it.
 */
function PromptSentimentRow({ p }) {
  const [open, setOpen] = useState(false);
  const toned = p.answers.filter((a) => a.tone);
  const engines = [...new Set(toned.map((a) => a.engine))].sort();
  const counts = TONE_ORDER
    .filter((t) => p[t])
    .map((t) => `${p[t]} ${TONE_STYLE[t].label.toLowerCase()}`)
    .join(' · ');

  return (
    <div style={{ borderBottom: '1px solid var(--neutral-800)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          padding: '14px 4px', background: 'none', border: 'none', cursor: 'pointer',
          font: 'inherit', color: 'inherit', textAlign: 'left',
        }}
      >
        <ScoreBadge value={p.score.value} />
        <span style={{ flex: 1, minWidth: 260 }}>
          <span style={{ display: 'block', fontSize: 14.5, fontWeight: 500, lineHeight: 1.45 }}>{p.prompt}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            {p.analysed} answer{p.analysed === 1 ? '' : 's'}{counts ? ` · ${counts}` : ''}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {engines.map((engine) => (
            <ModelToneChip key={engine} engine={engine} answers={toned.filter((a) => a.engine === engine)} />
          ))}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-3)', width: 14, textAlign: 'center' }}>{open ? '▲' : '▾'}</span>
      </button>

      {open && (
        <div style={{ display: 'grid', gap: 10, padding: '0 4px 16px 84px' }}>
          {toned.map((a) => {
            const visual = ENGINE_VISUAL[a.engine] || DEFAULT_ENGINE_VISUAL;
            return (
              <div
                key={`${a.runId}-${a.engine}`}
                style={{
                  border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '12px 14px',
                  borderLeft: `4px solid ${TONE_STYLE[a.tone].color}`, background: 'var(--card)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                    <EngineLogo engine={a.engine} visual={visual} size={18} />
                    {engineLabel(a.engine)}
                  </span>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
                    color: TONE_STYLE[a.tone].color, background: TONE_STYLE[a.tone].bg,
                    padding: '2px 10px 2px 6px', borderRadius: 'var(--r-pill)',
                  }}
                  >
                    <ToneFace tone={a.tone} size={15} /> {TONE_STYLE[a.tone].label}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                    {a.rank ? `Listed #${a.rank}${a.listed ? ` of ${a.listed}` : ''}` : 'Mentioned in the text, not in a list'}
                  </span>
                  <span style={{ marginLeft: 'auto' }}><ScorePill value={a.score} /></span>
                </div>
                {a.quote && (
                  <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 8, color: 'var(--text)' }}>
                    “{a.quote}”
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

function placeLabel(a) {
  if (a.rank) return `#${a.rank}${a.listed ? ` of ${a.listed}` : ''}`;
  return 'in text';
}

/** A small coloured score pill, coloured by the same bands as the gauge. */
function ScorePill({ value }) {
  if (value === null || value === undefined) return null;
  const band = bandFor(value);
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: inkFor(band.color),
      background: `color-mix(in srgb, ${band.color} 14%, transparent)`, borderRadius: 'var(--r-pill)',
      padding: '2px 9px', flexShrink: 0, alignSelf: 'center', lineHeight: 1.5,
    }}
    >
      {Math.round(value)}
    </span>
  );
}

function ToneCount({ tone, count, total }) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return (
    <div style={{
      flex: 1, minWidth: 120, background: TONE_STYLE[tone].bg, borderRadius: 'var(--r-lg)', padding: '12px 14px',
    }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ToneFace tone={tone} size={24} />
        <span style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', color: TONE_STYLE[tone].color }}>
          {count}
        </span>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>
        {TONE_STYLE[tone].label}
        <span style={{ color: 'var(--text-3)' }}> · {pct}%</span>
      </div>
    </div>
  );
}

/**
 * Tagging runs on the server by itself (see routes.js) — this only says so,
 * so a score that is about to change does not read as final.
 */
function AnalysingNote({ s, analysing }) {
  if (!analysing && !s.unanalysed) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginTop: 14,
      padding: '10px 14px', borderRadius: 'var(--r-lg)', background: 'var(--surface)', border: '1px solid var(--border)',
      fontSize: 12.5,
    }}
    >
      {analysing ? (
        <>
          <span className="aiv-pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
          <span>
            Reading {s.unanalysed} answer{s.unanalysed === 1 ? '' : 's'} that mention you — the score fills in by
            itself in a moment.
          </span>
          <style>{'@keyframes aiv-pulse{0%,100%{opacity:.25}50%{opacity:1}}.aiv-pulse{animation:aiv-pulse 1.2s ease-in-out infinite}'}</style>
        </>
      ) : (
        <span style={{ color: 'var(--text-2)' }}>
          {s.unanalysed} answer{s.unanalysed === 1 ? '' : 's'} that mention you could not be classified — the
          model found no quote about you to back a tone — so {s.unanalysed === 1 ? 'it is' : 'they are'} left out of the score.
        </span>
      )}
    </div>
  );
}

export function SentimentReport({
  report, described, describedAt, analysing = false,
}) {
  const s = report?.sentiment;
  const attributes = described?.attributes || [];
  const [filter, setFilter] = useState('all');

  // The report came back without a sentiment section at all — a server still
  // on older code. That is not "nobody mentions you", and must not say so.
  if (!s) {
    return (
      <Empty
        title="Sentiment could not be loaded"
        detail="This report did not include the sentiment reading. Refresh the page to load it again."
      />
    );
  }

  const matchedNames = (s.notAboutYouMatched || [])
    .map((m) => `“${m.name}” (${m.answers})`)
    .join(', ');

  // Every answer that mention matching counted turned out not to be about
  // the client. Say exactly that, and what matched — "nothing mentions you"
  // would contradict the Answers tab, which still counts them.
  if (!s.named && s.notAboutYou > 0) {
    return (
      <Card style={{ padding: 22 }}>
        <SectionHead title="None of the matched answers are actually about you" />
        <div style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 8 }}>
          {s.notAboutYou} answer{s.notAboutYou === 1 ? ' was' : 's were'} counted as mentioning you, but on reading
          {s.notAboutYou === 1 ? ' it' : ' them'}, none talk about your business. They matched on other names in your
          name list{matchedNames ? <> — <strong>{matchedNames}</strong></> : null}.
        </div>
        <Muted size={12} style={{ display: 'block', marginTop: 10 }}>
          Those look like products or payment plans you offer rather than names for your business. Removing them
          from &ldquo;Names we look for in answers&rdquo; (Setup &amp; runs) stops them being counted as mentions of you
          across the whole report.
        </Muted>
      </Card>
    );
  }

  if (!s.named && !attributes.length) {
    return (
      <Empty
        title="No sentiment reading yet"
        detail="Sentiment is read from the answers that mention you. None of the answers in this
                period do yet — once they do, each one is analysed here."
      />
    );
  }

  const score = s.score.value;
  const band = score === null ? null : bandFor(score);
  const answers = filter === 'all' ? s.answers : s.answers.filter((a) => a.tone === filter);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── The score ── */}
      <Card style={{ padding: 22 }}>
        <SectionHead title="How AI talks about you" />
        {score === null ? (
          <Muted size={12} style={{ display: 'block', marginTop: 8 }}>
            {analysing
              ? `${s.named} answer${s.named === 1 ? '' : 's'} mention you. Their tone is being read now.`
              : 'None of the answers that mention you could be classified yet, so there is no score.'}
          </Muted>
        ) : (
          <div style={{ display: 'flex', gap: 28, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ width: 260, maxWidth: '100%', textAlign: 'center' }}>
              <SentimentGauge score={Math.round(score)} />
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <ToneFace tone={band.tone} size={26} />
                <span style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-mono)', color: band.color }}>
                  {s.score.display}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-3)' }}>/100</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: band.color, marginTop: 2 }}>{band.label}</div>
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {TONE_ORDER.map((t) => <ToneCount key={t} tone={t} count={s[t]} total={s.analysed} />)}
              </div>
              <div style={{ marginTop: 12 }}><ToneBar counts={{ ...s, classified: s.analysed }} height={10} /></div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, fontSize: 12.5 }}>
                <span>
                  Net sentiment{' '}
                  <strong style={{ fontFamily: 'var(--font-mono)', color: (s.net.value ?? 0) >= 0 ? TONE_STYLE.positive.color : TONE_STYLE.negative.color }}>
                    {s.net.display}
                  </strong>
                  <Muted size={11}> (positive % minus negative %)</Muted>
                </span>
                <span style={{ color: 'var(--text-2)' }}>
                  Based on {s.analysed} of {s.named} answer{s.named === 1 ? '' : 's'} that mention you
                </span>
              </div>
              {s.summary && (
                <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-2)', borderLeft: `3px solid ${band.color}`, paddingLeft: 10 }}>
                  {s.summary}
                </div>
              )}
            </div>
          </div>
        )}
        <AnalysingNote s={s} analysing={analysing} />
        {s.notAboutYou > 0 && (
          <Muted size={11} style={{ display: 'block', marginTop: 10 }}>
            {s.notAboutYou} answer{s.notAboutYou === 1 ? ' was' : 's were'} counted as mentioning you but
            {s.notAboutYou === 1 ? ' is' : ' are'} not actually about you
            {matchedNames ? <> — {s.notAboutYou === 1 ? 'it' : 'they'} matched on {matchedNames}</> : null}.
            {s.notAboutYou === 1 ? ' It is' : ' They are'} left out of the score.
          </Muted>
        )}
      </Card>

      {/* ── How the score is worked out ── */}
      {s.analysed > 0 && (
        <Card style={{ padding: 18 }}>
          <SectionHead title="How the score is worked out" />
          <Muted size={11}>
            Each answer gets a score from its tone and where it placed you. Being recommended first
            counts most; a criticism of the first name on the list does the most damage. The overall
            score is the average across answers. Counts show how many of your answers fell in each cell.
          </Muted>
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table style={{ borderCollapse: 'separate', borderSpacing: 6, minWidth: 520 }}>
              <thead>
                <tr>
                  <th />
                  {POSITION_BUCKETS_UI.map((b) => (
                    <th key={b} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textAlign: 'center', padding: '0 6px' }}>
                      {POSITION_LABELS[b]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TONE_ORDER.map((t) => (
                  <tr key={t}>
                    <td style={{ fontSize: 12.5, paddingRight: 8 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <ToneFace tone={t} size={16} /> {TONE_STYLE[t].label}
                      </span>
                    </td>
                    {POSITION_BUCKETS_UI.map((b) => {
                      const n = s.matrix[t][b];
                      const value = s.table[t][b];
                      const c = bandFor(value).color;
                      return (
                        <td
                          key={b}
                          style={{
                            textAlign: 'center', padding: '8px 10px', borderRadius: 8,
                            background: `color-mix(in srgb, ${c} ${n ? 22 : 7}%, transparent)`,
                            border: n ? `1px solid color-mix(in srgb, ${c} 45%, transparent)` : '1px solid transparent',
                          }}
                        >
                          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: c }}>{value}</div>
                          <div style={{ fontSize: 10.5, color: n ? 'var(--text)' : 'var(--text-3)' }}>
                            {n} answer{n === 1 ? '' : 's'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── By model ── */}
      {s.byEngine.length > 0 && s.analysed > 0 && (
        <Card style={{ padding: 18 }}>
          <SectionHead title="By AI model" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 8 }}>
            {s.byEngine.map((e) => {
              const visual = ENGINE_VISUAL[e.engine] || DEFAULT_ENGINE_VISUAL;
              const eBand = e.score.value === null ? null : bandFor(e.score.value);
              return (
                <div key={e.engine} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
                  <div style={{ background: visual.tint, padding: 14, display: 'flex', justifyContent: 'center' }}>
                    <EngineLogo engine={e.engine} visual={visual} />
                  </div>
                  <div style={{ padding: '12px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{engineLabel(e.engine)}</span>
                      {eBand && <ToneFace tone={eBand.tone} size={20} />}
                    </div>
                    {e.analysed ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
                          <span style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--font-mono)', color: eBand.color }}>{e.score.display}</span>
                          <span style={{ fontSize: 12, color: eBand.color, fontWeight: 600 }}>{eBand.label}</span>
                        </div>
                        <div style={{ marginTop: 8 }}><ToneBar counts={{ ...e, classified: e.analysed }} height={8} /></div>
                        <Muted size={11} style={{ display: 'block', marginTop: 6 }}>
                          {e.positive} positive · {e.neutral} neutral · {e.negative} negative
                        </Muted>
                      </>
                    ) : (
                      <Muted size={11} style={{ display: 'block', marginTop: 6 }}>Not analysed yet.</Muted>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── By prompt ── */}
      {s.byPrompt.some((p) => p.analysed) && (
        <Card style={{ padding: 18 }}>
          <SectionHead title="By prompt" />
          <Muted size={11}>
            Weakest first — the prompts where AI speaks least warmly about you. Click a prompt to see
            every answer behind its score.
          </Muted>
          <div style={{ marginTop: 10 }}>
            <ShowMore
              items={s.byPrompt.filter((p) => p.analysed)}
              initial={8}
              noun="more prompts"
              render={(p) => <PromptSentimentRow key={p.promptId || p.prompt} p={p} />}
            />
          </div>
        </Card>
      )}

      {/* ── Every answer ── */}
      {s.answers.length > 0 && (
        <Card style={{ padding: 18 }}>
          <SectionHead title="Every answer, with its evidence" />
          <Muted size={11}>
            The words each answer used about you, copied exactly — the quote is what decided its tone.
          </Muted>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {['all', ...TONE_ORDER].map((t) => {
              const n = t === 'all' ? s.answers.length : s.answers.filter((a) => a.tone === t).length;
              const on = filter === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFilter(t)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', font: 'inherit', fontSize: 12,
                    padding: '4px 12px', borderRadius: 'var(--r-pill)',
                    border: on ? '1px solid var(--primary)' : '1px solid var(--border)',
                    background: on ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent', color: 'inherit',
                  }}
                >
                  {t !== 'all' && <ToneFace tone={t} size={14} />}
                  {t === 'all' ? 'All' : TONE_STYLE[t].label} ({n})
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 8 }}>
            <ShowMore
              key={filter}
              items={answers}
              initial={8}
              noun="more answers"
              render={(a) => (
                <div key={`${a.runId}-${a.promptId}-${a.engine}`} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                  <ToneFace tone={a.tone} size={22} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontStyle: 'italic', borderLeft: `3px solid ${TONE_STYLE[a.tone].color}`, paddingLeft: 10 }}>
                      “{a.quote}”
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
                      <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{engineLabel(a.engine)}</span>
                      <span>{a.rank ? `Listed ${placeLabel(a)}` : 'Mentioned in the text, not listed'}</span>
                      {a.prompt && <span>· {a.prompt}</span>}
                    </div>
                  </div>
                  <ScorePill value={a.score} />
                </div>
              )}
            />
          </div>
        </Card>
      )}

      {/* ── What they say you are ── */}
      {attributes.length > 0 && (
        <Card style={{ padding: 18 }}>
          <SectionHead title="What they say you are" />
          <Muted size={11}>
            The qualities the answers attribute to you, coloured by tone. Hover a phrase to read the
            quotes behind it.
          </Muted>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {attributes.map((a) => {
              const tone = TONE_STYLE[a.tone] ? a.tone : 'neutral';
              return (
                <span
                  key={a.label}
                  title={a.quotes.join('\n\n')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                    borderRadius: 'var(--r-pill)', background: TONE_STYLE[tone].bg, fontSize: 13,
                    border: `1px solid color-mix(in srgb, ${TONE_STYLE[tone].color} 35%, transparent)`,
                  }}
                >
                  <ToneFace tone={tone} size={16} />
                  {a.label}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                    {a.answers}/{described.basis}
                  </span>
                </span>
              );
            })}
          </div>
          <Basis>
            {describedAt ? `From the run of ${new Date(describedAt).toLocaleString()}. ` : ''}
            These phrases come from one run, so they do not follow the period filter.
          </Basis>
        </Card>
      )}
    </div>
  );
}

const POSITION_BUCKETS_UI = ['first', 'top3', 'lower', 'text'];

// ── 4. Prompts ─────────────────────────────────────────────────────────────

export function QuestionsReport({ report }) {
  const cols = '1fr 92px 92px 108px';
  return (
    <Card style={{ padding: 18 }}>
      <SectionHead
        title={`Every prompt (${report.byQuestion.length})`}
        right={<Muted size={11}>{report.headline.namedRate.display} overall</Muted>}
      />
      <Muted size={11}>
        Each prompt is asked of all three models, so a rate here is over at most three answers —
        the count beside it is the denominator.
      </Muted>
      <div style={{ marginTop: 12 }}>
        <Table head={{ cols, labels: ['Prompt', 'Named', 'Searched', 'Models'] }}>
          <ShowMore
            items={report.byQuestion}
            initial={10}
            noun="more prompts"
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
                    {(q.visibilityByEngine || []).map((v) => (
                      <Tag key={v.engine} tone={engineTone(v)}>
                        {engineLabel(v.engine)}
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
// Opens links in a new tab rather than navigating the report away — the
// default react-markdown renderer leaves target unset, which would replace
// this page with whatever the model cited.
const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/**
 * One model's verbatim answer(s) to a prompt, opened by clicking its card —
 * rendered as the model actually formatted it — headings,
 * bold, bullet lists and real clickable links — not the raw markdown source as
 * plain text. A capture stores the answer exactly as the API returned it
 * (markdown, since every provider writes it that way), so showing that source
 * unrendered means literal "**text**" and "[label](url)" on screen, which is
 * what made this unreadable before.
 */
function AnswerPanel({ engine, surfaces, onClose }) {
  return (
    <div style={{
      marginTop: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden',
    }}
    >
      {/* A header bar, so the box reads as "this is the answer the model
          gave", not a floating slab of text with no source. */}
      <div style={{
        padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}
      >
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em',
        }}
        >
          {engineLabel(engine)}&rsquo;s answer
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: 11.5, color: 'var(--text-3)',
          }}
        >
          Close ✕
        </button>
      </div>
      {surfaces.map((s, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} style={{ padding: '14px 18px', background: '#FFFFFF', borderTop: i ? '1px solid #E5E5E5' : 'none' }} data-color-mode="light">
          {surfaces.length > 1 && (
            <div style={{
              fontSize: 10.5, fontWeight: 600, color: '#6B6B6B', textTransform: 'uppercase',
              letterSpacing: '.06em', marginBottom: 8,
            }}
            >
              Answer {i + 1} of {surfaces.length}
            </div>
          )}
          {s.answerText ? (
            <MarkdownPreview
              source={s.answerText}
              components={MARKDOWN_COMPONENTS}
              style={{
                background: 'transparent', color: '#1A1A1A', fontSize: 14, lineHeight: 1.65,
                fontFamily: 'var(--font-sans)',
              }}
            />
          ) : (
            <span style={{ fontSize: 13, color: '#6B6B6B' }}>
              No answer could be captured{s.failureReason ? ` — ${s.failureReason}` : ''}.
            </span>
          )}
        </div>
      ))}
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

// ── Visibility-by-model cards ────────────────────────────────────────────

const LOGO_SIZE = 44;

// gemini.webp is the full wordmark (960x217) with the star as a square at its
// left edge; the box below crops to that square rather than keeping a
// separately cut file in sync with the original.
const ENGINE_VISUAL = {
  openai: { tint: '#E7F4EF', logo: openaiLogo },
  anthropic: { tint: '#FBECE5', logo: claudeLogo },
  google: { tint: '#ECEFFC', logo: geminiLogo, cropLeftSquare: true },
};
const DEFAULT_ENGINE_VISUAL = { tint: 'var(--surface)', logo: null };

function EngineLogo({ engine, visual, size = LOGO_SIZE }) {
  if (!visual.logo) {
    return (
      <span style={{ fontSize: size / 2, fontWeight: 700, color: 'var(--text-3)', lineHeight: `${size}px` }}>
        {engineLabel(engine).charAt(0)}
      </span>
    );
  }
  return (
    <span style={{ width: size, height: size, overflow: 'hidden', display: 'block', flexShrink: 0 }}>
      <img
        src={visual.logo}
        alt={engineLabel(engine)}
        style={visual.cropLeftSquare
          ? { height: size, width: 'auto', maxWidth: 'none', display: 'block' }
          : { width: size, height: size, objectFit: 'contain', display: 'block' }}
      />
    </span>
  );
}

const STATUS_TONE_COLOR = {
  accent: 'var(--accent-100)', warn: 'var(--viz-warn)', neg: 'var(--viz-neg)', muted: 'var(--text-3)',
};

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};

/** Plain-English read of one engine's visibility row for this one prompt. */
function visibilityStatus(e) {
  if (!e.answers) return { text: 'Not asked on this prompt', tone: 'muted' };
  if (!e.measured) return { text: 'Could not be measured', tone: 'muted' };
  if (e.named === 0) return { text: e.measured === 1 ? 'Not named in this answer' : 'Not named in these answers', tone: 'neg' };
  if (e.named === e.measured) return { text: e.measured === 1 ? 'Named in this answer' : 'Named in every answer', tone: 'accent' };
  return { text: 'Named in some answers', tone: 'warn' };
}

/** One model's card: its mark, its rate on this prompt, and what that rate means. */
function EngineVisibilityCard({ e, surfaces, selected, onSelect }) {
  const visual = ENGINE_VISUAL[e.engine] || DEFAULT_ENGINE_VISUAL;
  const status = visibilityStatus(e);
  const cited = surfaces.some((s) => s.cited);
  const didNotSearch = surfaces.some((s) => s.grounded === false);
  const failureReason = surfaces.find((s) => s.failureReason)?.failureReason || null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      style={{
        textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', padding: 0,
        display: 'flex', flexDirection: 'column',
        border: selected ? '1px solid var(--primary)' : '1px solid var(--border)',
        boxShadow: selected ? '0 0 0 1px var(--primary)' : 'none',
        borderRadius: 'var(--r-lg)', overflow: 'hidden', background: 'var(--card)',
      }}
    >
      <div style={{
        background: visual.tint, padding: '20px 14px', display: 'flex', justifyContent: 'center', position: 'relative',
        width: '100%', boxSizing: 'border-box',
      }}
      >
        <EngineLogo engine={e.engine} visual={visual} />
        {/* Every card carries a position slot. Where the model's list does not
            include the client, it says so rather than inventing a place. */}
        <span style={{
          position: 'absolute', top: 10, right: 10, background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '3px 10px',
          fontSize: 11.5, color: 'var(--text-2)', display: 'flex', alignItems: 'baseline', gap: 5,
        }}
        >
          {e.position ? (
            <>
              <strong style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                {e.position.display}
              </strong>
              {e.position.answers > 1 ? 'avg position' : 'position'}
            </>
          ) : (
            <span style={{ color: e.measured ? 'var(--viz-neg)' : 'var(--text-3)' }}>
              {e.measured ? 'Not listed' : 'Position —'}
            </span>
          )}
        </span>
      </div>
      <div style={{ padding: '12px 14px', flex: 1, width: '100%', boxSizing: 'border-box' }}>
        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text)', lineHeight: 1 }}>
          {e.namedRate.display}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{engineLabel(e.engine)}</div>
        <div style={{ fontSize: 11.5, color: STATUS_TONE_COLOR[status.tone], marginTop: 2 }}>{status.text}</div>
        {e.position?.listed ? (
          <Muted size={11} style={{ display: 'block', marginTop: 2 }}>
            {e.position.listed === 1
              ? 'The only business this answer lists'
              : `${ordinal(e.position.value)} of ${e.position.listed} businesses this answer lists`}
          </Muted>
        ) : null}
        {e.namedOutsideList ? (
          <Muted size={11} style={{ display: 'block', marginTop: 2 }}>
            Mentioned in the text, not in its list of recommendations
          </Muted>
        ) : null}
        {(cited || didNotSearch || failureReason) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {cited ? <Tag tone="accent">cited your site</Tag> : null}
            {didNotSearch ? <Tag tone="muted">did not search</Tag> : null}
            {failureReason ? <Muted size={11}>{failureReason}</Muted> : null}
          </div>
        )}
      </div>
      <div style={{
        width: '100%', boxSizing: 'border-box', padding: '8px 14px', borderTop: '1px solid var(--border)',
        fontSize: 11.5, color: selected ? 'var(--primary)' : 'var(--text-3)',
      }}
      >
        {selected ? 'Hide answer ▲' : 'View answer ▾'}
      </div>
    </button>
  );
}

/**
 * The card grid — one card per model that touched this prompt this period.
 * Clicking a card opens that model's answer beneath the grid; one at a time,
 * so the answer sits directly under the cards rather than inside one of them.
 */
function VisibilityByModel({ visibilityByEngine, byEngine }) {
  const [selected, setSelected] = useState(null);
  if (!visibilityByEngine?.length) return <Muted size={11}>Not measured in this period.</Muted>;
  const surfacesOf = (engine) => byEngine.filter((s) => s.engine === engine);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {visibilityByEngine.map((e) => (
          <EngineVisibilityCard
            key={e.engine}
            e={e}
            surfaces={surfacesOf(e.engine)}
            selected={selected === e.engine}
            onSelect={() => setSelected((cur) => (cur === e.engine ? null : e.engine))}
          />
        ))}
      </div>
      {selected && (
        <AnswerPanel engine={selected} surfaces={surfacesOf(selected)} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/** A labelled group inside an opened prompt — "what changed", not "who said it". */
function PromptDetailSection({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        fontSize: 10.5, fontFamily: 'var(--font-mono)', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-3)',
        marginBottom: 8,
      }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

const ENGINE_LABEL_COL = { width: 90, fontSize: 12.5, color: 'var(--text-2)', flexShrink: 0 };

/**
 * One prompt, collapsed to its text and a per-model at-a-glance tag until
 * clicked. Opening it groups the evidence by what a reader actually asks —
 * did it name you, who else came up, what did it read, what did it say —
 * rather than repeating three engine sub-blocks with the same four facts each.
 */
function PromptRow({ q }) {
  const [open, setOpen] = useState(false);
  const engines = q.byEngine || [];
  const perModel = q.visibilityByEngine || [];
  const merged = mergeByEngine(engines);
  const withCompetitors = merged.filter((m) => m.competitors.length);
  const withCitations = merged.filter((m) => m.citations.length);

  return (
    <div style={{ borderBottom: '1px solid var(--neutral-800)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
          background: 'none', border: 'none', padding: '12px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}
      >
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{q.text}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {perModel.length ? perModel.map((v) => (
            <Tag key={v.engine} tone={engineTone(v)}>
              {engineLabel(v.engine)}
            </Tag>
          )) : <Muted size={11}>not measured</Muted>}
          <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{open ? '▲' : '▾'}</span>
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 0 18px' }}>
          {!engines.length ? (
            <Muted size={11}>Not measured in this period.</Muted>
          ) : (
            <>
              <PromptDetailSection title="Visibility by model">
                <VisibilityByModel visibilityByEngine={q.visibilityByEngine} byEngine={engines} />
              </PromptDetailSection>

              <PromptDetailSection title="Competitors">
                {withCompetitors.length ? (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {withCompetitors.map((e) => (
                      <div key={e.engine} style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
                        <span style={ENGINE_LABEL_COL}>{engineLabel(e.engine)}</span>
                        <span>{e.competitors.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                ) : <Muted size={11}>No competitor named for this prompt.</Muted>}
              </PromptDetailSection>

              <PromptDetailSection title="Citations">
                {withCitations.length ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {withCitations.map((e) => (
                      <div key={e.engine} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <span style={{ ...ENGINE_LABEL_COL, paddingTop: 2 }}>{engineLabel(e.engine)}</span>
                        <CitationList citations={e.citations} />
                      </div>
                    ))}
                  </div>
                ) : <Muted size={11}>No source cited for this prompt.</Muted>}
              </PromptDetailSection>
            </>
          )}
        </div>
      )}
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
        <SectionHead title="Every prompt, every model" />
        <Muted size={11}>
          Click a prompt to open it: whether each model named you, who else it named instead, what it
          cited, and the answer itself. Answers we could not read are shown too — a list that quietly
          dropped them would make coverage invisible.
        </Muted>
        <div style={{ marginTop: 8 }}>
          <ShowMore
            items={report.byQuestion}
            initial={10}
            noun="more prompts"
            render={(q) => <PromptRow key={q.promptId || q.text} q={q} />}
          />
        </div>
      </Card>
    </div>
  );
}
