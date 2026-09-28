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

function EngineLogo({ engine, visual }) {
  if (!visual.logo) {
    return (
      <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-3)', lineHeight: `${LOGO_SIZE}px` }}>
        {engineLabel(engine).charAt(0)}
      </span>
    );
  }
  return (
    <span style={{ width: LOGO_SIZE, height: LOGO_SIZE, overflow: 'hidden', display: 'block' }}>
      <img
        src={visual.logo}
        alt={engineLabel(engine)}
        style={visual.cropLeftSquare
          ? { height: LOGO_SIZE, width: 'auto', maxWidth: 'none', display: 'block' }
          : { width: LOGO_SIZE, height: LOGO_SIZE, objectFit: 'contain', display: 'block' }}
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
