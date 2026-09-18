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
  Metric as MetricCell, MetricStrip, FilledLabelBar, TypeChip, ShowMore,
} from '../aiVisibility/reportPrimitives';
import { LineChart } from '../aiVisibility/reportCharts';
import {
  SOURCE_TYPE_LABELS, PAGE_TYPE_LABELS, engineLabel,
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

// ── 1. Executive overview ──────────────────────────────────────────────────

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

        <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-.02em', marginTop: 10, lineHeight: 1.2 }}>
          {report.headline.namedRate.value === null
            ? 'Nothing was measured in this period'
            : `Named in ${report.headline.namedRate.display} of the answers we could measure`}
        </div>

        <Muted size={13} style={{ display: 'block', marginTop: 6 }}>
          {comparable && runnerUp
            ? `Ranked ${rank} of ${ranked.length} among the brands this project tracks. `
              + `The next tracked brand, ${runnerUp.name}, was named in ${runnerUp.namedRate.display}.`
            : 'Only one brand is tracked on this project, so there is nothing to rank against yet — '
              + 'add competitors to see share of voice and gap analysis.'}
        </Muted>

        <FadingRule style={{ margin: '16px 0' }} />

        <MetricStrip min={190}>
          <MetricCell label="Named in answers" metric={report.headline.namedRate} />
          <MetricCell label="Share of mentions" metric={report.headline.shareOfMentions} />
          <MetricCell label="Cited as a source" metric={report.headline.citationRate} />
          <MetricCell label="Mention order" metric={report.headline.mentionRank} />
          <MetricCell label="Answers that searched" metric={report.headline.groundedRate} />
        </MetricStrip>

        <Basis>{report.meta.basis}</Basis>
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
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{g.gapScore}</span>
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
        <SectionHead title="Headline" />
        <MetricStrip min={190}>
          <MetricCell label="Named in answers" metric={report.headline.namedRate} />
          <MetricCell label="Share of mentions" metric={report.headline.shareOfMentions} />
          <MetricCell label="Mention order" metric={report.headline.mentionRank} />
          <MetricCell label="Answers that searched" metric={report.headline.groundedRate} />
          <MetricCell label="Answers captured" metric={report.meta.coverage} />
        </MetricStrip>
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

export function AnswersReport({ report }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card style={{ padding: 20 }}>
        <MetricStrip min={180}>
          <MetricCell label="Answers measured" metric={report.meta.coverage} sub={`${report.meta.answersMeasured} of ${report.meta.answers}`} />
          <MetricCell label="Named in answers" metric={report.headline.namedRate} />
          <MetricCell label="Answers that searched" metric={report.headline.groundedRate} />
          <MetricCell label="Cited as a source" metric={report.headline.citationRate} />
        </MetricStrip>
      </Card>

      <Card style={{ padding: 18 }}>
        <SectionHead title="Every answer" />
        <Muted size={11}>
          One card per question and model. Answers we could not read are shown too — a list that
          quietly dropped them would make coverage invisible.
        </Muted>
        <div style={{ marginTop: 12 }}>
          <ShowMore
            items={report.byQuestion}
            initial={6}
            noun="more questions"
            render={(q) => (
              <div key={q.promptId || q.text} style={{ padding: '12px 0', borderBottom: '1px solid var(--neutral-800)' }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{q.text}</div>
                <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  {q.byEngine.length ? q.byEngine.map((e) => (
                    <div key={e.engine} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ width: 90, fontSize: 12.5, color: 'var(--text-2)' }}>{engineLabel(e.engine)}</span>
                      <OutcomeTag mentioned={e.mentioned} status={e.status} />
                      {e.grounded === false ? <Tag tone="muted">did not search</Tag> : null}
                      {e.cited ? <Tag tone="accent">cited your site</Tag> : null}
                      {e.failureReason ? <Muted size={11}>{e.failureReason}</Muted> : null}
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
