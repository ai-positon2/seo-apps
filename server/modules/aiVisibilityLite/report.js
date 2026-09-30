// ── The report ───────────────────────────────────────────────────────────────
//
// Built from stored captures, using v1's metric functions. Rebuilt on read
// rather than served from a run's payload, so a report never goes stale against
// the evidence behind it.
//
// ── Naming is deliberate ───────────────────────────────────────────────────
//
// Every metric here is named for what it counts, in this module's own words:
//
//   score            named/rank/perception/cited combined by weight
//                    (SCORE_WEIGHTS), reweighted across whichever of the four
//                    are available (compositeScore) — THE headline figure
//   avgScore         the mean of `score` across every run this project has
//                    completed, not just the one this report currently scopes
//   namedRate        share of MEASURED answers that name the client
//   shareOfMentions  the client's share of all brand mentions in those answers
//   citationRate     share of measured answers that cite the client's domain
//   mentionRank      where the client falls in the order brands are named
//   groundedRate     share of answers that actually searched the web
//
// They are not borrowed from any other product's vocabulary, and each one is
// defined next to the code that computes it so a reader can check the claim
// rather than take the label's word for it.
//
// ── What is reused, and what could not be ──────────────────────────────────
//
// REUSED WHOLE, by require, with no copied arithmetic:
//
//   scoring.js          score, scoreBasis, shareOfVoice, citedDomains,
//                       findings, groupByPrompt — v1's metric logic for a run,
//                       reading exactly what measure() returns
//   metrics/format.js   the {value, display, delta, deltaDisplay, direction}
//                       envelope, so the UI never does metric maths
//   metrics/period.js   period windows and the prompt-set INTERSECTION rule,
//                       which is what stops a delta reporting a change caused
//                       by editing the questions
//   metrics/core.js     coverage() and scopeCaptures()
//   capture.js          prominenceOf / normalizeHost — the same matchers that
//                       decided `mentioned` at capture time, reused here to
//                       order brands within an answer
//   captureEngines/domainClassify.js
//                       registrableDomain and classifyDomain, so a cited source
//                       is categorised by the same pure ruleset v1 uses — no
//                       model call, and reproducible for a past period
//
// SENTIMENT AND DESCRIPTORS come from describe.js, which runs once per RUN over
// the answers that named the brand, and are read back from the run payload
// rather than recomputed here. They are the only numbers on this report that
// are NOT rebuilt from stored captures on read, so they carry their own
// timestamp and their own basis — see the route. Both are quote-guarded: a
// descriptor or a score whose verbatim justification is not a literal span of
// some answer is discarded before it is ever stored.
//
// NOT AVAILABLE HERE, and deliberately absent rather than approximated:
//
//   PER-PROMPT sentiment SCORES. describe.js is one call over the whole
//   answer set, which is what makes it affordable; a per-prompt score would
//   need a call per capture (~60 a run). That same call does tag each answer
//   positive/neutral/negative, and those counts (overall and per model) are
//   read back from the run payload with the rest of `described`.
//
//   PROMPT TOPICS, SEARCH VOLUME, and any market/geography axis. No column
//   holds them and nothing in this module collects them. scoring.groupByTopic
//   exists but reads topicLabel, which promptView never sets — every prompt
//   would fold into one 'Uncategorised' bucket, so it is deliberately unused.
//
//   IS-INLINE-CITED, and therefore v1's citation-rate column. The stored
//   citation is {url, title, domain, index}; there is no inline flag, and the
//   three adapters do not even mean the same thing by a citation (OpenAI and
//   Anthropic report what the answer cited, Google reports what grounding
//   retrieved). Any number here would read 100% on every row.

const scoring = require('../aiVisibility/scoring');
const core = require('../aiVisibility/metrics/core');
const period = require('../aiVisibility/metrics/period');
const fmt = require('../aiVisibility/metrics/format');
const { prominenceOf, namesBrand } = require('../aiVisibility/capture');
const domainClassify = require('../aiVisibility/captureEngines/domainClassify');
const { TONE_VERSION } = require('./describe');

// A brand needs to appear in at least this many measured answers before it is
// ranked against the others. Two answers is not a standing, and a competitor
// named once would otherwise sit at the top of the table on 100%.
const MIN_ANSWERS_TO_RANK = 3;

// ── The composite score ──────────────────────────────────────────────────────
//
// `score` is not just "were you named". Appearing at all, appearing FIRST,
// being described WARMLY, and being CITED as a source are four different
// claims, and a client can win on one and lose on another — being named last
// in every answer is not the same result as being named first. Combined by
// weight, appearance-led: being found matters most, and the other three
// refine what that appearance was worth.
const SCORE_WEIGHTS = { named: 40, rank: 25, perception: 20, cited: 15 };

/**
 * Combine whichever of the four factors are actually available, reweighted
 * across just those — never silently as if the missing one scored zero.
 *
 * Perception in particular is not always there: it costs its own model call,
 * runs once per measurement run rather than being derived from captures, and
 * can be missing outright (no run has completed one yet, or the call failed).
 * A client whose only gap is "no sentiment reading yet" should not see a score
 * that looks like they were savaged in every answer — the weight redistributes
 * across named/rank/cited instead of counting perception as a zero.
 *
 * Returns null only when NOTHING is available — the same three-state rule
 * every other metric on this report follows.
 */
function compositeScore({ named, rank, perception, cited }) {
  const parts = [
    { value: named, weight: SCORE_WEIGHTS.named },
    { value: rank, weight: SCORE_WEIGHTS.rank },
    { value: perception, weight: SCORE_WEIGHTS.perception },
    { value: cited, weight: SCORE_WEIGHTS.cited },
  ].filter((p) => typeof p.value === 'number' && Number.isFinite(p.value));
  if (!parts.length) return null;
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  return parts.reduce((sum, p) => sum + (p.value * p.weight) / totalWeight, 0);
}

/**
 * Mention order, as a 0-100 "higher is better" score instead of a raw
 * position — so it can sit in the same weighted average as the other three.
 *
 * Needs at least two tracked brands: with only the client tracked, rank is
 * always #1 of 1 and turning that into a component would silently reward a
 * project for never having added a competitor, which is not a visibility
 * result — it is an unset-up project.
 */
function rankToScore(rankValue, trackedBrandCount) {
  if (typeof rankValue !== 'number' || !Number.isFinite(rankValue)) return null;
  if (!trackedBrandCount || trackedBrandCount < 2) return null;
  return (100 * (trackedBrandCount - rankValue)) / (trackedBrandCount - 1);
}

/** Share of a measured/citable set that hit, as a 0-100 number, or null over an empty set. */
function shareScore(hit, total) {
  return total ? (hit / total) * 100 : null;
}

/** Every name a brand might be written as. */
function namesOf(brand) {
  return [brand?.name, ...(brand?.aliases || [])].filter(Boolean);
}

/**
 * Where each brand first appears in one answer, as an order.
 *
 * ── Two matchers, and using the wrong one makes a row contradict itself ────
 *
 * v1 exports two, and they do NOT agree:
 *
 *   namesBrand(text, names)    word-boundary Unicode regex. THIS is what
 *                              decided the stored `mentioned` column at
 *                              capture time.
 *   prominenceOf(text, names)  plain case-insensitive indexOf, no boundary.
 *                              Returns WHERE the earliest match is.
 *
 * Ranking on prominenceOf alone was a real defect: it matches inside longer
 * words, so a brand could be ranked in an answer whose `mentioned` column says
 * it was never named. The named count and the order column in the same table
 * row would then disagree, and the one a reader trusts is whichever they read
 * second.
 *
 * So membership is decided by namesBrand — the same rule as the stored column —
 * and prominenceOf is used ONLY to order the brands that already passed it.
 * Each matcher does the job it is correct for.
 *
 * Returns a Map of brand name to 1-based rank, covering only the brands the
 * answer genuinely names.
 */
function mentionOrder(answerText, brands) {
  const at = [];
  for (const brand of brands) {
    const names = namesOf(brand);
    // Membership first, on the same rule as `mentioned`.
    if (!namesBrand(answerText, names)) continue;
    const where = prominenceOf(answerText, names);
    if (where === null) continue;
    at.push({ name: brand.name, where });
  }
  at.sort((a, b) => a.where - b.where);

  const ranks = new Map();
  at.forEach((entry, i) => ranks.set(entry.name, i + 1));
  return ranks;
}

/** A list entry's name part: its bold text if it leads with one, else up to the first separator. */
function entryLead(text) {
  const bold = text.match(/^\s*(\*\*|__)(.+?)\1/);
  const raw = bold ? bold[2] : text.split(/\s[-–—]\s|:\s/)[0];
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

/**
 * The recommendation lists an answer is made of, as blocks of entry names in
 * order. An entry is a numbered or bulleted item, a heading, or a line that
 * is only a bold name — the shapes every provider writes a "here are some
 * options" answer in. Entries ending in ':' are section labels ("Top
 * Recommendations:", "The Setup:"), not options, and are skipped.
 *
 * A block ends where its structure does: a list at an unindented paragraph
 * or heading, a heading level at a shallower heading (### entries under a
 * new ## section start a new ranking), and
 * a run of bold-name lines at any heading. That is what keeps "Other options
 * you might consider" or a closing list of questions from being counted as
 * more places in the same ranking.
 */
function listBlocks(answerText) {
  const blocks = [];
  const open = new Map(); // kind -> current block

  const close = (pred) => {
    for (const [kind, block] of open) {
      if (pred(kind)) { if (block.length) blocks.push(block); open.delete(kind); }
    }
  };
  const add = (kind, lead) => {
    if (!lead || lead.endsWith(':')) return;
    if (!open.has(kind)) open.set(kind, []);
    open.get(kind).push(lead);
  };

  for (const line of String(answerText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    const bullet = line.match(/^(\s*)[-*+•]\s+(.+)$/);

    if (heading) {
      const level = heading[1].length;
      close((k) => k.startsWith('list') || k === 'bold' || (k.startsWith('h') && Number(k.slice(1)) > level));
      add(`h${level}`, entryLead(heading[2]));
    } else if (numbered || bullet) {
      const [, indent, rest] = numbered || bullet;
      add(`list:${numbered ? 'ol' : 'ul'}:${indent.length > 1 ? 1 : 0}`, entryLead(rest));
    } else if (/^(\*\*|__)(.+?)\1\s*:?\s*$/.test(line.trim())) {
      add('bold', entryLead(line.trim()));
    } else if (!/^\s/.test(line)) {
      // An unindented paragraph ends any list, but not a run of headings or
      // bold names — those are separated by paragraphs by design.
      close((k) => k.startsWith('list'));
    }
  }
  close(() => true);
  return blocks;
}

/**
 * Where the client sits in the answer's own recommendation list: "3rd of the
 * 4 practices this answer lists", counting every business the answer names
 * as an option — not only the brands this project tracks, which is what made
 * a position read #1 while the answer listed two other practices first.
 *
 * Null when the answer names the client only in running text, outside any
 * list: there is no ranking to have a place in.
 */
function listPosition(answerText, client) {
  const names = namesOf(client);
  const domain = String(client?.domain || '').toLowerCase().replace(/^www\./, '');
  if (!names.length && !domain) return null;
  const isClient = (lead) => (names.length && namesBrand(lead, names))
    || (domain && lead.toLowerCase().includes(domain));

  for (const block of listBlocks(answerText)) {
    const at = block.findIndex(isClient);
    if (at !== -1) return { rank: at + 1, of: block.length };
  }
  return null;
}

// ── Sentiment ────────────────────────────────────────────────────────────────
//
// Every answer that named the client carries a tone (describe.classifyTones,
// read back from run payloads) and a place in that answer's own list
// (listPosition). The two combine into one 0-100 score per answer from a
// fixed table, and the sentiment score is their mean.
//
// Position changes what a tone is worth because it changes who reads it. Being
// recommended first is the strongest thing an answer can do for a business;
// the same warm words at #6 are read by far fewer people. The same holds in
// reverse: a criticism attached to the first name on the list is the most
// damaging, so a negative at #1 scores LOWER than a negative further down.
//
// A fixed table, not a model's number: every score on the page traces back to
// answers a reader can open, and the table itself is shown on the page.
const POSITION_BUCKETS = ['first', 'top3', 'lower', 'text'];
const SENTIMENT_SCORES = {
  positive: { first: 100, top3: 85, lower: 75, text: 70 },
  // Neutral stays inside the neutral band (40-59) wherever it is listed, so a
  // factual mention at #1 can never read as "Positive" on the gauge.
  neutral: { first: 58, top3: 55, lower: 50, text: 50 },
  negative: { first: 10, top3: 20, lower: 25, text: 25 },
};

// Below this many analysed answers, the sentiment score does not feed the
// headline composite: it falls back to the older one-call reading instead.
const MIN_TONED_FOR_COMPOSITE = 3;

const toneKey = (runId, promptId, engine) => `${runId || ''}|${promptId || ''}|${engine || ''}`;

function positionBucket(rank) {
  if (rank === null || rank === undefined) return 'text';
  if (rank === 1) return 'first';
  return rank <= 3 ? 'top3' : 'lower';
}

/** Counts, mean score and net sentiment over a set of analysed answers. */
function sentimentSummary(entries) {
  const toned = entries.filter((e) => e.tone);
  const count = (t) => toned.filter((e) => e.tone === t).length;
  const positive = count('positive');
  const neutral = count('neutral');
  const negative = count('negative');
  const mean = toned.length ? toned.reduce((s, e) => s + e.score, 0) / toned.length : null;
  // Net sentiment: share positive minus share negative, -100 to +100. The
  // counts in one number, independent of position.
  const net = toned.length ? Math.round(((positive - negative) / toned.length) * 100) : null;
  return {
    named: entries.length,
    analysed: toned.length,
    positive,
    neutral,
    negative,
    score: fmt.metric(mean, 'score'),
    net: { value: net, display: net === null ? '—' : `${net > 0 ? '+' : ''}${net}` },
  };
}

function sentimentSentence(s, listedFirst) {
  if (!s.analysed) return null;
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    `${s.positive} ${s.positive === 1 ? 'praises' : 'praise'} you`,
    `${s.neutral} ${s.neutral === 1 ? 'lists' : 'list'} you without praise`,
    s.negative ? `${s.negative} ${s.negative === 1 ? 'criticises' : 'criticise'} you` : 'none criticise you',
  ];
  return `Of the ${n(s.analysed, 'answer', 'answers')} that mention you, ${parts[0]}, ${parts[1]}, and ${parts[2]}.`
    + (listedFirst ? ` You were recommended first in ${listedFirst}.` : '');
}

/**
 * The sentiment report over the period's answers that named the client.
 *
 * @param {object[]} measured   the period's measured captures
 * @param {Map} toneMap         toneKey -> {tone, quote}
 * @param {object} client       {name, domain, aliases}
 * @param {object[]} prompts    the live prompt set, for prompt text
 */
function sentimentTable(measured, toneMap, client, prompts = []) {
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));

  const all = measured
    .filter((r) => r.mentioned === true)
    .map((r) => {
      const t = toneMap.get(toneKey(r.runId, r.promptId, r.engine)) || null;
      const place = client?.name ? listPosition(r.answerText, client) : null;
      const bucket = positionBucket(place ? place.rank : null);
      return {
        runId: r.runId || null,
        promptId: r.promptId || null,
        prompt: promptText.get(r.promptId) || r.prompt || null,
        engine: r.engine,
        at: r.capturedAt || null,
        tone: t ? t.tone : null,
        quote: t ? t.quote : null,
        rank: place ? place.rank : null,
        listed: place ? place.of : null,
        bucket,
        score: t && SENTIMENT_SCORES[t.tone] ? SENTIMENT_SCORES[t.tone][bucket] : null,
      };
    });

  // Answers mention matching counted, but which the tone pass found are not
  // about the client at all (an alias that is really a product name, a
  // similarly named business). Left out of every count below, and reported,
  // so the reader can see why "named" and "analysed" differ.
  const entries = all.filter((e) => e.tone !== 'absent');

  // Which of the client's names matched in those answers — so the page can
  // say "they matched on Invisalign", which is what the reader needs to fix
  // the name list, rather than only that they did not count.
  const names = namesOf(client);
  const notAboutYouMatched = {};
  for (const e of all.filter((x) => x.tone === 'absent')) {
    const row = measured.find((r) => r.runId === e.runId && r.promptId === e.promptId && r.engine === e.engine);
    for (const n of names.filter((name) => namesBrand(row?.answerText || '', [name]))) {
      notAboutYouMatched[n] = (notAboutYouMatched[n] || 0) + 1;
    }
  }

  const engines = [...new Set(entries.map((e) => e.engine))].sort();
  const promptIds = [...new Set(entries.map((e) => e.promptId))];
  const overall = sentimentSummary(entries);

  return {
    ...overall,
    // One sentence, from the same counts as the score — so the words beside
    // the gauge can never disagree with the number on it.
    summary: sentimentSentence(overall, entries.filter((e) => e.tone && e.bucket === 'first').length),
    // Named answers with no backed tone yet — from runs before per-answer
    // tones existed, or whose tone the model could not quote.
    unanalysed: entries.filter((e) => !e.tone).length,
    notAboutYou: all.length - entries.length,
    notAboutYouMatched: Object.entries(notAboutYouMatched)
      .sort((a, b) => b[1] - a[1])
      .map(([name, answers]) => ({ name, answers })),
    byEngine: engines.map((engine) => ({ engine, ...sentimentSummary(entries.filter((e) => e.engine === engine)) })),
    byPrompt: promptIds
      .map((promptId) => {
        const rows = entries.filter((e) => e.promptId === promptId);
        return { promptId, prompt: rows[0].prompt, ...sentimentSummary(rows), answers: rows };
      })
      .sort((a, b) => (a.score.value ?? 101) - (b.score.value ?? 101)),
    // How tone and position combine across the period: count of answers in
    // each cell of the scoring table.
    matrix: Object.fromEntries(['positive', 'neutral', 'negative'].map((tone) => [
      tone,
      Object.fromEntries(POSITION_BUCKETS.map((b) => [b, entries.filter((e) => e.tone === tone && e.bucket === b).length])),
    ])),
    table: SENTIMENT_SCORES,
    answers: entries
      .filter((e) => e.tone)
      .sort((a, b) => a.score - b.score),
  };
}

/**
 * How the client and each competitor did, side by side.
 *
 * `namedRate` is over MEASURED answers, never attempted ones — a provider
 * outage must not read as a competitor outperforming the client.
 * `mentionRank` averages only the answers that named the brand: a brand's
 * typical position when it appears is a different question from how often it
 * appears, and the first metric already answers the second.
 */
function brandTable(measured, client, competitors) {
  const all = [{ ...client, isClient: true }, ...competitors.map((c) => ({ ...c, isClient: false }))];

  const tally = new Map(all.map((b) => [b.name, {
    name: b.name, isClient: b.isClient, named: 0, rankSum: 0, rankCount: 0,
  }]));

  for (const row of measured) {
    const ranks = mentionOrder(row.answerText, all);
    for (const [name, rank] of ranks) {
      const entry = tally.get(name);
      if (!entry) continue;
      entry.named += 1;
      entry.rankSum += rank;
      entry.rankCount += 1;
    }
  }

  // Total mentions across every brand, which is the denominator share is taken
  // against. Counted in ANSWERS, not occurrences: a model repeating a name six
  // times in one answer has not made that brand six times more visible.
  const totalMentions = [...tally.values()].reduce((sum, b) => sum + b.named, 0);

  return [...tally.values()]
    .map((b) => ({
      name: b.name,
      isClient: b.isClient,
      answers: measured.length,
      named: b.named,
      namedRate: fmt.metric(fmt.ratio(b.named, measured.length), 'percent'),
      shareOfMentions: fmt.metric(fmt.ratio(b.named, totalMentions), 'percent'),
      // Null — rendered '—' — below the threshold, because an average over one
      // or two answers is not a position.
      mentionRank: fmt.metric(
        b.rankCount >= MIN_ANSWERS_TO_RANK ? b.rankSum / b.rankCount : null,
        'position',
        {
          direction: 'lower_is_better',
          note: b.rankCount && b.rankCount < MIN_ANSWERS_TO_RANK
            ? `Named in only ${b.rankCount} answer${b.rankCount === 1 ? '' : 's'} — too few to rank.`
            : null,
        },
      ),
      rankedOver: b.rankCount,
    }))
    .sort((a, b) => (b.named - a.named) || a.name.localeCompare(b.name));
}

/**
 * Which sources the models pulled from, and what kind of sources they are.
 *
 * Counted in CITATIONS, not answers: a domain cited three times in one answer
 * was retrieved three times, and this table is about what the models read
 * rather than about how many questions it influenced.
 *
 * The type comes from v1's `classifyDomain`, a pure ruleset — so 'you' and
 * 'competitor' are decided by the configured domains and never by pattern,
 * which is the rule that stops a client's own site being filed as 'corporate'
 * because it happens to be a .com.
 */
function sourceTable(measured, client, competitors) {
  const clientDomains = [client?.domain].filter(Boolean);
  const competitorDomains = competitors.map((c) => c.domain).filter(Boolean);

  const byDomain = new Map();
  let total = 0;
  // Citations that named no publisher we can stand behind. Counted, never
  // guessed at — see below.
  let unattributed = 0;

  for (const row of measured) {
    for (const citation of row.citations || []) {
      // `domain` only, NEVER falling back to the url.
      //
      // googleApi sets domain: null deliberately when a citation arrives as a
      // vertexaisearch.cloud.google.com redirect, because a redirect host is
      // not evidence about a publisher. Falling back to the url put that
      // redirect through registrableDomain and produced a `google.com` row —
      // a source that was never cited, sitting in a table of ones that were,
      // with a citation count borrowed from real publishers.
      //
      // Skipped and counted instead. A smaller total that says how much it is
      // missing beats a complete-looking one with an invented row in it.
      if (!citation.domain) { unattributed += 1; continue; }
      const registrable = domainClassify.registrableDomain(
        domainClassify.hostOf(citation.domain) || citation.domain,
      );
      if (!registrable) { unattributed += 1; continue; }

      total += 1;
      if (!byDomain.has(registrable)) {
        byDomain.set(registrable, {
          domain: registrable,
          citations: 0,
          answers: new Set(),
          sourceType: domainClassify.classifyDomain(registrable, { clientDomains, competitorDomains }),
        });
      }
      const entry = byDomain.get(registrable);
      entry.citations += 1;
      entry.answers.add(row.id);
    }
  }

  const domains = [...byDomain.values()]
    .map((d) => ({
      domain: d.domain,
      citations: d.citations,
      // How many distinct answers it turned up in — a domain cited once in each
      // of ten answers is a different thing from one cited ten times in one.
      answers: d.answers.size,
      share: fmt.metric(fmt.ratio(d.citations, total), 'percent'),
      sourceType: d.sourceType,
    }))
    .sort((a, b) => b.citations - a.citations);

  const byType = new Map();
  for (const d of domains) byType.set(d.sourceType, (byType.get(d.sourceType) || 0) + d.citations);

  return {
    totalCitations: total,
    // Surfaced, not swallowed. Gemini returns its sources as opaque redirects,
    // so this is usually non-zero and the sources table is genuinely
    // under-counting that engine. A reader comparing this total against the
    // per-engine citation counts deserves to know why they differ.
    unattributed,
    domains,
    byType: [...byType.entries()]
      .map(([type, citations]) => ({
        type,
        citations,
        share: fmt.metric(fmt.ratio(citations, total), 'percent'),
      }))
      .sort((a, b) => b.citations - a.citations),
  };
}

/**
 * One row per question, with the metrics that row can actually carry.
 *
 * Built on top of scoring.groupByPrompt, which already does the hard part: it
 * groups captures by prompt, keeps a question that got no captures this period
 * (with an empty surface list, so "not measured" stays distinguishable from
 * "not named"), and carries orphaned captures under their own text rather than
 * dropping them.
 *
 * Every rate here is over MEASURED answers for that question — at most three,
 * one per engine. That is a small denominator and it is stated on the row,
 * because a question measured twice can only ever read 0%, 50% or 100%, and a
 * delta on it moves in 33-point steps.
 */
function questionTable(groups, client = null) {
  return groups.map((g) => {
    const surfaces = g.surfaces || [];
    const measured = surfaces.filter((s) => s.mentioned !== null && s.mentioned !== undefined);
    const named = measured.filter((s) => s.mentioned === true).length;
    const grounded = surfaces.filter((s) => s.grounded === true).length;
    const rivals = [...new Set(surfaces.flatMap((s) => s.competitorsMentioned || []))];

    return {
      promptId: g.promptId,
      text: g.text,
      intent: g.intent || null,
      // Three states, kept apart: measured and named, measured and absent, and
      // never measured. groupByPrompt emits the third with surfaces: [].
      state: measured.length === 0 ? 'not_measured' : (named > 0 ? 'named' : 'absent'),
      answers: surfaces.length,
      measured: measured.length,
      named,
      namedRate: fmt.metric(fmt.ratio(named, measured.length), 'percent'),
      groundedRate: fmt.metric(fmt.ratio(grounded, surfaces.length), 'percent'),
      // Which competitors the models reached for on this question instead,
      // across every engine. Kept alongside the per-engine breakdown below,
      // which says WHICH one reached for them — this is the quick "who else"
      // a reader checks first.
      competitors: rivals,
      // Per engine, so a reader can see WHICH model named them, what it said,
      // who else it named instead, and what it cited while answering.
      byEngine: surfaces.map((s) => ({
        engine: s.engine,
        surfaceLabel: s.surfaceLabel,
        mentioned: s.mentioned,
        cited: s.cited,
        grounded: s.grounded,
        status: s.status,
        failureReason: s.failureReason || null,
        // Competitors THIS engine's answer named — a subset of `competitors`
        // above, which pools every engine on this question together.
        competitorsMentioned: s.competitorsMentioned || [],
        // {url, title, domain, index}[] — whatever this engine's answer cited,
        // regardless of whether it named the client. Empty, not omitted, when
        // an answer cited nothing, so the UI can say "no citations" rather
        // than treat a missing key as "not measured".
        citations: s.citations || [],
        // The verbatim answer. Only a failed capture has none — see status.
        answerText: s.answerText || null,
      })),
      // One row per engine that touched this question this period, named
      // over its own measured surfaces — the same arithmetic as the report's
      // top-level `byEngine`, applied to just this question. `byEngine` above
      // is one row per SURFACE, so a question asked across two runs in the
      // period carries two rows for the same engine there; this collapses
      // those into the single rate a "this model, this question" card needs.
      visibilityByEngine: [...new Set(surfaces.map((s) => s.engine))].sort().map((engine) => {
        const rows = surfaces.filter((s) => s.engine === engine);
        const engineMeasured = rows.filter((s) => s.mentioned !== null && s.mentioned !== undefined);
        const engineNamed = engineMeasured.filter((s) => s.mentioned === true).length;
        // The client's place in each answer's own list of recommendations
        // (listPosition), over the answers that name the client.
        const namedRows = engineMeasured.filter((s) => s.mentioned === true);
        const placed = namedRows
          .map((s) => listPosition(s.answerText, client))
          .filter(Boolean);
        let position = null;
        if (placed.length === 1) {
          // One answer is a fact, not an average — "#3", not "#3.0".
          position = { value: placed[0].rank, display: `#${placed[0].rank}`, listed: placed[0].of, answers: 1 };
        } else if (placed.length > 1) {
          const avg = placed.reduce((sum, p) => sum + p.rank, 0) / placed.length;
          position = { ...fmt.metric(avg, 'position'), listed: null, answers: placed.length };
        }
        return {
          engine,
          surfaceLabel: rows[0]?.surfaceLabel || engine,
          answers: rows.length,
          measured: engineMeasured.length,
          named: engineNamed,
          namedRate: fmt.metric(fmt.ratio(engineNamed, engineMeasured.length), 'percent'),
          position,
          // Named, but only in running text — so there is no list place to show.
          namedOutsideList: namedRows.length > 0 && placed.length === 0,
        };
      }),
    };
  });
}

/**
 * Sources that feed answers naming a competitor, but not answers naming you.
 *
 * METRICS.md §6's formula, and every input for it is a real stored column:
 * `mentioned` and `competitors_mentioned` sit on the same row as `citations`,
 * so "answers that cited this domain and named a competitor" is one pass.
 *
 *   gapCaptures(d) = compCaptures(d) - youCaptures(d), floored at 0
 *   gapScore(d)    = round(gapCaptures(d) x retrievedPct(d) x 100 x typeWeight)
 *
 * The type weight is v1's, unchanged: a directory you can get listed in is
 * worth more than a competitor's own site you can never appear on.
 *
 * ── Two things this deliberately does not claim ───────────────────────────
 *
 * It does NOT say a domain "never cites you". A zero here means you were not
 * NAMED in the answers that used that source, in this period. Whether the site
 * links you is not something any stored row knows.
 *
 * It does NOT carry a remedy. v1's own gaps report states the rule — rank the
 * facts, never write the fix in the UI — and this follows it.
 */
function gapTable(measured, client, competitors) {
  const clientDomains = [client?.domain].filter(Boolean);
  const competitorDomains = competitors.map((c) => c.domain).filter(Boolean);

  const acc = new Map();

  for (const row of measured) {
    const namedClient = row.mentioned === true;
    const namedCompetitor = (row.competitorsMentioned || []).length > 0;
    // A capture that named neither side tells us nothing about a gap.
    if (!namedClient && !namedCompetitor) continue;

    // Distinct domains per capture: a source cited three times in one answer
    // still only witnessed that answer once.
    const seen = new Set();
    for (const citation of row.citations || []) {
      if (!citation.domain) continue;
      const d = domainClassify.registrableDomain(
        domainClassify.hostOf(citation.domain) || citation.domain,
      );
      if (!d || seen.has(d)) continue;
      seen.add(d);

      if (!acc.has(d)) {
        acc.set(d, {
          domain: d,
          answers: 0,
          compCaptures: 0,
          youCaptures: 0,
          sourceType: domainClassify.classifyDomain(d, { clientDomains, competitorDomains }),
        });
      }
      const e = acc.get(d);
      e.answers += 1;
      if (namedCompetitor) e.compCaptures += 1;
      if (namedClient) e.youCaptures += 1;
    }
  }

  const rows = [...acc.values()]
    .map((e) => {
      const gapCaptures = Math.max(0, e.compCaptures - e.youCaptures);
      const retrievedPct = fmt.ratio(e.answers, measured.length);
      const weight = domainClassify.TYPE_WEIGHT[e.sourceType] ?? 0.5;
      return {
        domain: e.domain,
        sourceType: e.sourceType,
        answers: e.answers,
        // Stated on the row so the score is auditable where it is shown,
        // rather than being a number a reader has to take on trust.
        namedCompetitor: e.compCaptures,
        namedYou: e.youCaptures,
        retrievedPct: fmt.metric(retrievedPct, 'percent'),
        gapScore: Math.round(gapCaptures * (retrievedPct || 0) * 100 * weight),
      };
    })
    .filter((r) => r.gapScore > 0)
    .sort((a, b) => b.gapScore - a.gapScore);

  return { rows, total: rows.length, biggest: rows[0] || null };
}

/**
 * Individual pages the models pulled in.
 *
 * ── Only two of the three engines can appear here, and that is stated ─────
 *
 * OpenAI and Anthropic return a real publisher URL and a real page title.
 * Google returns an opaque `vertexaisearch…/grounding-api-redirect/<blob>` and
 * puts the PUBLISHER DOMAIN in `title` — so for Gemini there is no page, only a
 * site. Including it would be three silent failures at once: every row typed
 * 'other' because no rule matches a redirect path, the same page appearing as a
 * new row on every run because the blob differs per call, and a bare domain
 * printed in a column headed "title".
 *
 * So Gemini is excluded and the basis is returned alongside the rows, because a
 * URLs table whose totals disagree with the domains table beside it — with no
 * explanation — is worse than one that is narrower and says so.
 */
function urlTable(measured, client, competitors) {
  const clientDomains = [client?.domain].filter(Boolean);
  const competitorDomains = competitors.map((c) => c.domain).filter(Boolean);

  const usable = measured.filter((r) => r.engine !== 'google');
  const excludedEngines = [...new Set(measured.filter((r) => r.engine === 'google').map((r) => r.engine))];

  const acc = new Map();
  let total = 0;

  for (const row of usable) {
    for (const citation of row.citations || []) {
      if (!citation.url) continue;
      const url = domainClassify.normaliseUrl(citation.url) || citation.url;
      total += 1;

      if (!acc.has(url)) {
        acc.set(url, {
          url,
          // Nullable, and left null rather than synthesised. A fabricated
          // title on a page the client will click through to is the fastest
          // way to discredit the whole table.
          title: citation.title || null,
          domain: citation.domain || null,
          pageType: domainClassify.classifyUrl(url),
          sourceType: domainClassify.classifyDomain(citation.domain || url, {
            clientDomains, competitorDomains,
          }),
          citations: 0,
          engines: new Set(),
          namedYou: 0,
          lastSeen: row.capturedAt,
        });
      }
      const e = acc.get(url);
      e.citations += 1;
      e.engines.add(row.engine);
      if (row.mentioned === true) e.namedYou += 1;
      if (row.capturedAt > e.lastSeen) e.lastSeen = row.capturedAt;
      if (!e.title && citation.title) e.title = citation.title;
    }
  }

  const rows = [...acc.values()]
    .map((e) => ({
      url: e.url,
      title: e.title,
      domain: e.domain,
      pageType: e.pageType,
      sourceType: e.sourceType,
      citations: e.citations,
      // A page both ChatGPT and Claude reach is a different finding from one
      // only ChatGPT reaches.
      engines: [...e.engines].sort(),
      // Was the client named in the answers this page fed? The insight
      // version of the designed "YOU NAMED" column.
      namedYou: e.namedYou,
      namedRate: fmt.metric(fmt.ratio(e.namedYou, e.citations), 'percent'),
      // 'Last retrieved', NOT 'updated'. Nothing here knows when a page
      // changed; this says when a model last pulled it in.
      lastSeen: e.lastSeen,
      share: fmt.metric(fmt.ratio(e.citations, total), 'percent'),
    }))
    .sort((a, b) => b.citations - a.citations);

  const byType = new Map();
  for (const r of rows) byType.set(r.pageType, (byType.get(r.pageType) || 0) + r.citations);

  return {
    totalCitations: total,
    rows,
    byType: [...byType.entries()]
      .map(([type, citations]) => ({
        type, citations, share: fmt.metric(fmt.ratio(citations, total), 'percent'),
      }))
      .sort((a, b) => b.citations - a.citations),
    // The honest denominator note for this page.
    basis: {
      answers: usable.length,
      excludedEngines,
      why: excludedEngines.length
        ? 'Gemini returns its sources as redirects rather than page URLs, so its citations '
          + 'appear under Sources by site but cannot be listed as individual pages.'
        : null,
    },
  };
}

/**
 * How the named rate moved, one point per run.
 *
 * Per RUN rather than per day: a run is the unit that asked the whole question
 * set at one moment, and averaging two runs from the same day would blur two
 * measurements into a number neither of them reported.
 */
/**
 * @param {object} [ctx]
 * @param {object} [ctx.brand]         needed to compute each run's OWN score,
 *                                     not just its namedRate
 * @param {object[]} [ctx.competitors]
 * @param {Map<string,{score:number,at:string}>} [ctx.runSentiment]  each run's
 *   own describe.js reading, keyed by run id — a run this project completed
 *   before the descriptor panel existed, or one whose describe call failed,
 *   simply has no entry, and that run's score is reweighted across the other
 *   three factors exactly as the headline is (see compositeScore).
 */
function trendByRun(inScope, {
  brand, competitors = [], runSentiment, toneMap = new Map(),
} = {}) {
  const runs = new Map();
  for (const row of inScope) {
    if (!row.runId) continue;
    if (!runs.has(row.runId)) runs.set(row.runId, { runId: row.runId, at: row.capturedAt, rows: [] });
    const entry = runs.get(row.runId);
    entry.rows.push(row);
    if (row.capturedAt < entry.at) entry.at = row.capturedAt;
  }

  const trackedBrandCount = 1 + competitors.length;

  return [...runs.values()]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((r) => {
      const measured = scoring.measuredRows(r.rows);
      const named = measured.filter((x) => x.mentioned).length;

      // The run's own score, not a re-derivation of the headline's — same four
      // factors, computed over just this run's rows, so avgScore below is a
      // mean of scores runs actually earned rather than of namedRate alone.
      let score = null;
      let runSentimentScore = null;
      if (brand) {
        const runClientRow = brandTable(measured, brand, competitors).find((b) => b.isClient) || null;
        const citable = measured.filter((x) => x.cited !== null);
        runSentimentScore = sentimentFor(sentimentTable(measured, toneMap, brand), runSentiment?.get(r.runId));
        score = compositeScore({
          named: shareScore(named, measured.length),
          rank: rankToScore(runClientRow ? runClientRow.mentionRank.value : null, trackedBrandCount),
          perception: runSentimentScore ? runSentimentScore.score : null,
          cited: shareScore(citable.filter((x) => x.cited).length, citable.length),
        });
      }

      return {
        runId: r.runId,
        at: r.at,
        answers: r.rows.length,
        measured: measured.length,
        namedRate: fmt.metric(fmt.ratio(named, measured.length), 'percent'),
        score: fmt.metric(score, 'score'),
        sentiment: fmt.metric(runSentimentScore ? runSentimentScore.score : null, 'score'),
      };
    });
}

/**
 * The sentiment reading the composite uses: the per-answer score when enough
 * answers have a tone, else the older one-call reading, else nothing.
 */
function sentimentFor(table, fallback) {
  if (table && table.analysed >= MIN_TONED_FOR_COMPOSITE) {
    return { score: table.score.value, at: null, analysed: table.analysed, source: 'answers' };
  }
  return fallback ? { ...fallback, source: 'run' } : null;
}

/**
 * Build the report for a project.
 *
 * @param {object} input
 * @param {object[]} input.captures  from store.capturesForProject (camelCase)
 * @param {object[]} input.prompts   the live prompt set
 * @param {object} input.brand       {name, domain, aliases}
 * @param {object[]} [input.competitors]  [{name, domain, aliases}]
 * @param {object} [input.options]   {from, to} — the period, defaulting to
 *                                   everything with the previous equal-length
 *                                   window as the comparison
 * @param {Map<string,{score:number,at:string}>} [input.runSentiment]  each run's
 *   own describe.js sentiment reading, keyed by run id (see routes.js). Not
 *   scoped to `options` — perception is a per-RUN artifact, not a per-period
 *   one, so `score` uses whichever run's reading is most recent regardless of
 *   the selected window, same as the `described` panel already does.
 */
function build({
  captures = [], prompts = [], brand = {}, competitors = [], options = {}, runSentiment = null,
  answerTones = [],
}) {
  // Only tones from the current instructions: older ones are re-read by the
  // backfill (routes.js), and until then that answer counts as unanalysed.
  const toneMap = new Map((answerTones || [])
    .filter((t) => t.v === TONE_VERSION)
    .map((t) => [toneKey(t.runId, t.promptId, t.engine), t]));
  // Only the questions the project currently asks. A deleted question is not
  // part of what we measure, so it is not part of what we report — including
  // its failures, which would otherwise drag coverage down after the question
  // itself had gone. v1's buildContext narrows at exactly this point and for
  // exactly this reason.
  const live = new Set(prompts.map((p) => p.id));
  const excluded = captures.filter((c) => !c.promptId || !live.has(c.promptId));
  const inScope = captures.filter((c) => c.promptId && live.has(c.promptId));

  // period.split gives the current window and the intersection windows: the
  // prompts BOTH periods measured. Comparing anything else would report the
  // effect of editing the question set as though the client had moved.
  const split = period.split(inScope, options);

  const current = core.scopeCaptures(split.current, {});
  const deltaNow = core.scopeCaptures(split.currentForDelta, {});
  const deltaPrev = core.scopeCaptures(split.previousForDelta, {});

  const summary = scoring.summarise(split.current, brand);
  const previous = deltaPrev.length ? scoring.summarise(deltaPrev, brand) : null;
  const currentForDelta = deltaNow.length ? scoring.summarise(deltaNow, brand) : null;
  const comparable = Boolean(currentForDelta && previous && previous.score !== null);

  const coverage = core.coverage(split.current);
  const measured = scoring.measuredRows(current);

  // ── The five headline numbers ────────────────────────────────────────────
  const named = measured.filter((r) => r.mentioned).length;
  // `cited` is nullable: a citation set we could not resolve is not evidence
  // that the client was uncited. Those rows leave the denominator rather than
  // counting against them.
  const citable = measured.filter((r) => r.cited !== null);
  const cited = citable.filter((r) => r.cited).length;
  const groundedCount = current.filter((c) => c.grounded === true).length;

  const brands = brandTable(measured, brand, competitors);
  const clientRow = brands.find((b) => b.isClient) || null;

  // The same table over the PREVIOUS comparable window, so the two headline
  // metrics lifted from it can carry a delta like every other one.
  //
  // Without this, shareOfMentions and mentionRank were the only two headline
  // numbers that could never move — they were read straight off the current
  // period's row, which has no previous value in it. A KPI strip where three
  // tiles show a delta and two structurally cannot is read as "those two did
  // not change", which is a claim nobody made.
  //
  // Over previousForDelta, not `previous`: the intersection of prompts BOTH
  // periods asked. Comparing anything else reports the effect of editing the
  // question set as though the client had moved.
  const prevMeasured = scoring.measuredRows(deltaPrev);
  const prevBrands = prevMeasured.length ? brandTable(prevMeasured, brand, competitors) : [];
  const prevClientRow = prevBrands.find((b) => b.isClient) || null;

  const trackedBrandCount = 1 + competitors.length;

  // Perception, if any run has ever produced one — the MOST RECENT reading
  // regardless of the selected period, same convention the `described` panel
  // already uses (see routes.js and the runSentiment doc above).
  const latestRunReading = runSentiment && runSentiment.size
    ? [...runSentiment.values()].sort((a, b) => new Date(b.at) - new Date(a.at))[0]
    : null;
  // The period's own per-answer sentiment when enough answers are analysed;
  // otherwise the most recent run's one-call reading, as before.
  const sentiment = sentimentTable(measured, toneMap, brand, prompts);
  const latestPerception = sentimentFor(sentiment, latestRunReading);

  const currentRankScore = rankToScore(clientRow ? clientRow.mentionRank.value : null, trackedBrandCount);
  const currentCitedScore = shareScore(cited, citable.length);
  const currentComposite = compositeScore({
    named: summary.score,
    rank: currentRankScore,
    perception: latestPerception ? latestPerception.score : null,
    cited: currentCitedScore,
  });

  // The same three per-period factors over the PREVIOUS comparable window, so
  // the score can carry a delta like every other headline number. Perception
  // is reused unchanged from `latestPerception` rather than looked up for the
  // previous window — there is no "previous period's perception" (it is a
  // per-run artifact, not a per-period one), and giving it a delta would
  // invent a change nobody measured.
  const prevCitable = prevMeasured.filter((r) => r.cited !== null);
  const previousComposite = comparable
    ? compositeScore({
      named: previous.score,
      rank: rankToScore(prevClientRow ? prevClientRow.mentionRank.value : null, trackedBrandCount),
      perception: latestPerception ? latestPerception.score : null,
      cited: shareScore(prevCitable.filter((r) => r.cited).length, prevCitable.length),
    })
    : null;

  // What actually went into `score` — a weighted blend of four numbers cannot
  // speak for itself the way "10 of 30" can, so the basis names each factor
  // that counted and, if perception is stale relative to this period, says so.
  const scoreParts = [];
  if (summary.score !== null) scoreParts.push(`named ${summary.score}`);
  if (currentRankScore !== null) scoreParts.push(`rank ${clientRow.mentionRank.display}`);
  if (latestPerception) scoreParts.push(`sentiment ${Math.round(latestPerception.score)}`);
  if (currentCitedScore !== null) scoreParts.push(`cited ${Math.round(currentCitedScore)}%`);
  const scoreNote = !scoreParts.length
    ? 'Nothing was measured in this period.'
    : `Weighted from: ${scoreParts.join(', ')}.`
      + (latestPerception?.source === 'answers'
        ? ` Sentiment over ${latestPerception.analysed} analysed answers.`
        : (latestPerception?.at ? ` Sentiment last measured ${new Date(latestPerception.at).toLocaleDateString()}.` : ''));

  // The same four numbers as scoreNote, structured rather than prose — so a UI
  // can draw an actual per-factor breakdown (bars, an included/excluded state)
  // instead of parsing a sentence back apart to get them.
  const scoreBreakdown = [
    {
      key: 'named', label: 'Named in answers', weight: SCORE_WEIGHTS.named,
      included: summary.score !== null, value: summary.score,
      display: summary.score === null ? null : `${summary.score}`,
    },
    {
      key: 'rank', label: 'Typical position when named', weight: SCORE_WEIGHTS.rank,
      included: currentRankScore !== null, value: currentRankScore,
      display: clientRow ? clientRow.mentionRank.display : null,
    },
    {
      key: 'perception', label: 'Sentiment — how warmly you’re described', weight: SCORE_WEIGHTS.perception,
      included: Boolean(latestPerception), value: latestPerception ? latestPerception.score : null,
      display: latestPerception ? `${Math.round(latestPerception.score)}` : null,
      at: latestPerception ? latestPerception.at : null,
    },
    {
      key: 'cited', label: 'Cited as a source', weight: SCORE_WEIGHTS.cited,
      included: currentCitedScore !== null, value: currentCitedScore,
      display: currentCitedScore === null ? null : `${Math.round(currentCitedScore)}%`,
    },
  ];

  // Computed here, ahead of `headline`, so avgScore can be built from it — and
  // reused below for the `trendAllRuns` field rather than walked twice.
  const allRunsTrend = trendByRun(inScope, { brand, competitors, runSentiment, toneMap });
  const scoredRuns = allRunsTrend.filter((r) => r.score.value !== null);

  const headline = {
    // The composite: appearance, ranking, perception and citation credibility,
    // weighted (SCORE_WEIGHTS) and reweighted across whichever are available
    // (compositeScore) — THE number this report puts in front of everything
    // else.
    score: fmt.metric(currentComposite, 'score', {
      previous: previousComposite,
      note: scoreNote,
    }),
    // The mean of THIS SAME per-run score across every run this project has
    // ever completed, not a separate metric — one bad or one lucky run reads
    // very differently next to "usually around X" than it does alone.
    avgScore: fmt.metric(
      scoredRuns.length
        ? scoredRuns.reduce((sum, r) => sum + r.score.value, 0) / scoredRuns.length
        : null,
      'score',
      {
        note: scoredRuns.length
          ? `Averaged across ${scoredRuns.length} scored run${scoredRuns.length === 1 ? '' : 's'}.`
          : 'No run has been scored yet.',
      },
    ),
    // Not a metric envelope like the others — see the comment above
    // scoreBreakdown's definition. Read by a UI that wants to draw the four
    // factors apart rather than just display scoreNote as a sentence.
    scoreBreakdown,
    namedRate: fmt.metric(
      summary.score === null ? null : summary.score / 100,
      'percent',
      {
        previous: comparable ? previous.score / 100 : null,
        note: summary.score === null ? 'Nothing was measured in this period.' : null,
      },
    ),
    // The client's share of every brand mention across those answers.
    shareOfMentions: fmt.metric(
      clientRow ? clientRow.shareOfMentions.value : null,
      'percent',
      { previous: prevClientRow ? prevClientRow.shareOfMentions.value : null },
    ),
    // Share of measured answers whose citations include the client's domain.
    // Being named and being cited are separate signals: named without a link is
    // visible but not credited; linked without a name is credited but invisible.
    citationRate: fmt.metric(fmt.ratio(cited, citable.length), 'percent'),
    // Typical order among the brands an answer names. Lower is better, so the
    // direction is passed explicitly rather than inferred from the sign — a
    // move from #4 to #2 is a negative delta and an improvement, and colouring
    // by sign alone paints the best result on the page red.
    mentionRank: fmt.metric(
      clientRow ? clientRow.mentionRank.value : null,
      'position',
      {
        direction: 'lower_is_better',
        previous: prevClientRow ? prevClientRow.mentionRank.value : null,
        note: clientRow ? clientRow.mentionRank.note : null,
      },
    ),
    // Share of answers where the model actually searched. Not a performance
    // metric — a check on whether the rest of the report describes the live web
    // or the model's training data.
    groundedRate: fmt.metric(fmt.ratio(groundedCount, current.length), 'percent'),
  };

  // Per engine, from the inline columns. core.byEngine needs the entity layer,
  // and this is the same arithmetic scoring.score does — share of MEASURED
  // captures naming the brand — applied one engine at a time.
  const engines = [...new Set(current.map((c) => c.engine))].sort().map((engine) => {
    const rows = current.filter((c) => c.engine === engine);
    const engineMeasured = scoring.measuredRows(rows);
    const engineNamed = engineMeasured.filter((r) => r.mentioned).length;
    const engineGrounded = rows.filter((r) => r.grounded === true).length;
    return {
      engine,
      surfaceLabel: rows[0]?.surfaceLabel || engine,
      answers: rows.length,
      measured: engineMeasured.length,
      named: engineNamed,
      namedRate: fmt.metric(fmt.ratio(engineNamed, engineMeasured.length), 'percent'),
      groundedRate: fmt.metric(fmt.ratio(engineGrounded, rows.length), 'percent'),
    };
  });

  const warnings = [...(split.warnings || [])];
  if (coverage.belowThreshold) warnings.push('coverage_below_threshold');
  if (excluded.length) warnings.push('removed_prompts_excluded');
  if (!brand?.name) warnings.push('no_client_brand');
  if (current.length && groundedCount < current.length) warnings.push('ungrounded_answers_included');
  if (!competitors.length) warnings.push('no_competitors_configured');

  return {
    meta: {
      period: split.period.current,
      comparePeriod: split.period.previous,
      comparison: split.comparison,
      answers: split.current.length,
      coverage: fmt.metric(coverage.value, 'percent'),
      // DISTINCT questions with at least one measured answer — not
      // `summary.promptsMeasured`, which counts measured capture ROWS. The two
      // are the same in v1, where a prompt is measured on one surface at a
      // time; here every question is asked of three models, so that field
      // reported 22 of 10 questions. A denominator larger than its own
      // numerator is the kind of number that destroys trust in every other one
      // on the page.
      questionsMeasured: new Set(measured.map((r) => r.promptId).filter(Boolean)).size,
      questionsLive: prompts.length,
      // Kept under its own name, because it IS the useful figure for coverage:
      // how many individual model answers were usable.
      answersMeasured: measured.length,
      // The sentence that has to travel with the headline number.
      basis: summary.scoreBasis,
      generatedAt: new Date().toISOString(),
    },
    headline,
    brands,
    sources: sourceTable(measured, brand, competitors),
    byEngine: engines,
    // Strongest / weakest, gated on a real sample.
    //
    // v1's MIN_CAPTURES_PER_MODEL exists because a model with three answers
    // always wins or loses by noise. A 10-prompt single run gives each engine
    // ten answers, so this is usually null early on — and null with a stated
    // threshold is the honest reading, not a podium built from a coin flip.
    modelStrength: (() => {
      const rankable = engines.filter((e) => e.measured >= core.MIN_CAPTURES_PER_MODEL
        && e.namedRate.value !== null);
      if (rankable.length < 2) {
        return {
          strongest: null,
          weakest: null,
          threshold: core.MIN_CAPTURES_PER_MODEL,
          note: `Needs at least ${core.MIN_CAPTURES_PER_MODEL} measured answers per model `
            + 'before one can be called stronger than another.',
        };
      }
      const sorted = [...rankable].sort((a, b) => b.namedRate.value - a.namedRate.value);
      return {
        strongest: sorted[0],
        weakest: sorted[sorted.length - 1],
        threshold: core.MIN_CAPTURES_PER_MODEL,
        note: null,
      };
    })(),
    gaps: gapTable(measured, brand, competitors),
    urls: urlTable(measured, brand, competitors),
    // Prompts passed so a group carries the question's current wording and
    // intent rather than only the text as it was sent.
    byQuestion: questionTable(scoring.groupByPrompt(split.current, prompts), brand),
    // Over split.current, the same window every other number on this report
    // uses. It was built over `inScope` — all history — so the chart and the
    // KPI row above it described different periods, and a reader comparing the
    // headline against the last point of its own trend line would find they
    // disagreed with no way to tell which was wrong.
    trend: trendByRun(split.current, { brand, competitors, runSentiment, toneMap }),
    sentiment,
    // The full history, kept separate and labelled as such. A project with two
    // runs outside the default 30-day window would otherwise show an empty
    // trend and no hint that history exists.
    trendAllRuns: allRunsTrend,
    findings: summary.findings,
    spend: summary.spend,
    surfaces: summary.surfaces,
    warnings,
  };
}

module.exports = {
  build, brandTable, sourceTable, gapTable, urlTable, questionTable,
  mentionOrder, trendByRun, MIN_ANSWERS_TO_RANK,
  compositeScore, rankToScore, shareScore, SCORE_WEIGHTS,
  sentimentTable, listPosition, toneKey, SENTIMENT_SCORES,
};
