const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBrief, briefMarkdown, cleanHtml, briefHash, ensureFaqSection } = require('../document');
const { removeUnsupported } = require('../removeUnsupported');
const { planBrief } = require('../briefPlan');
const { generateDraft, supportedEvidence, checkLinks } = require('../writer');
const { exportDocx } = require('../export');
const store = require('../store');
const db = require('../../../services/db');
const projectAccess = require('../../../services/projectAccess');
const { generateArticleBrief } = require('../../../services/articleBrief');

const markdown = `# H1: A practical guide

## H2: Understanding the topic
**Writing Instructions:**
- Explain the definition.
**Keywords:** topic, guide
### H3: A closer look
- Include an example.
**[Visual Opportunity: Comparison table]**
## H2: Frequently Asked Questions
- What should readers know?
**Reference Blog URLs:**
- [1] https://example.org/study`;
// Verification fixtures are deliberately short, so they opt out of a length
// target; the structural retry has its own test below.
const document = (options = {}) => store.editable({ keyword: 'a topic', brief: parseBrief(markdown), options, draftHtml: '' });

test('brief round-trip preserves the complete outline, instructions, visual guidance and references', () => {
  const brief = parseBrief(markdown);
  assert.equal(brief.title, 'A practical guide');
  assert.deepEqual(brief.sections.map(s => s.level), ['H2', 'H3', 'H2']);
  assert.match(brief.sections[0].guidance, /Keywords: topic, guide/);
  assert.match(brief.sections[1].guidance, /Visual Opportunity/);
  assert.match(brief.sections[2].guidance, /What should readers know/);
  assert.match(brief.references, /https:\/\/example.org/);
  const again = parseBrief(briefMarkdown(brief));
  assert.deepEqual(again.sections.map(({ id, ...s }) => s), brief.sections.map(({ id, ...s }) => s));
  const hash = briefHash(brief); brief.sections.reverse(); assert.notEqual(briefHash(brief), hash);
});
test('empty or malformed briefs are rejected, and optional writing inputs stay optional', () => {
  assert.throws(() => parseBrief('Bad response'));
  assert.equal(store.editable({ keyword: 'topic' }).options.wordCount, '');
  assert.throws(() => store.editable({ keyword: 'topic', options: { wordCount: -1 } }));
  assert.throws(() => store.editable({ keyword: '' }));
});
test('the shared brief pipeline preserves top-ten research, KB context and the realignment pass', async () => {
  const calls = [], events = [], kbCalls = [];
  const sources = Array.from({ length: 12 }, (_, i) => ({ url: `https://example.org/${i}`, title: `Page ${i}` }));
  const replies = [{ commonH2Topics: ['topic'], faqPatterns: ['question'] }, markdown, { aligned: false, reason: 'Adjust the scope' }, markdown];
  const result = await generateArticleBrief({ keyword: 'topic', client: 'brand', feedbackKbIds: ['feedback'] },
    (event, data) => events.push({ event, ...data }), {
      searchGoogle: async keyword => { assert.equal(keyword, 'topic'); return { results: sources }; },
      scrapeUrlsDetailed: async (urls, progress) => {
        assert.equal(urls.length, 10);
        return urls.map((url, index) => { progress({ index, total: 10, url, status: 'done' });
          return { url, success: true, title: 'Title', h1: 'Title', h2s: ['topic'], h3s: [], h4s: [], faqs: [], bodyText: 'Competitor source material.' }; });
      },
      loadKBContext: async (...args) => { kbCalls.push(args); return { systemPromptSuffix: '\nBrand rules', skipped: [], loaded: ['brand'], confidence: 'HIGH' }; },
      openai: { chat: { completions: { create: async request => { calls.push(request); const next = replies.shift();
        return { choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }; } } } },
    });
  assert.equal(result.brief, markdown); assert.equal(result.sourceUrls.length, 10);
  assert.deepEqual(kbCalls, [['article-recommendation', 'brand', ['feedback']]]);
  assert.equal(calls.length, 4); assert.ok(calls.every(c => c.model === 'gpt-5.4-mini'));
  assert.match(calls[1].messages[0].content, /Brand rules/);
  assert.match(calls[1].messages[0].content, /Every H2 must include Writing Instructions and Keywords/);
  assert.match(calls[3].messages[0].content, /Every H2 must include Writing Instructions and Keywords/);
  assert.match(calls[3].messages[1].content, /Competitor source material/);
  for (const id of ['search', 'scrape', 'analysis', 'brief', 'alignment']) assert.ok(events.some(e => e.id === id && e.status === 'done'));
});
test('the outline round-trips every heading level, not just H2 and H3', () => {
  const deep = `# H1: A practical guide

## H2: Understanding the topic
- Explain the definition.
### H3: A closer look
- Include an example.
#### H4: A narrower case
- Cover the exception.
##### H5: A detail
- One paragraph.
###### H6: The finest grain
- One sentence.

**Reference Blog URLs:**
- [1] https://example.org/study`;
  const brief = parseBrief(deep);
  assert.deepEqual(brief.sections.map(s => s.level), ['H2', 'H3', 'H4', 'H5', 'H6']);
  assert.deepEqual(parseBrief(briefMarkdown(brief)).sections.map(s => s.level), ['H2', 'H3', 'H4', 'H5', 'H6']);
  assert.match(briefMarkdown(brief), /^#### H4: A narrower case$/m);
  assert.match(cleanHtml('<h5>Five</h5><h6>Six</h6>'), /<h5>Five<\/h5><h6>Six<\/h6>/);
});
test('every brief offers an FAQ section, and keeps the generated one when there is one', () => {
  const added = ensureFaqSection(parseBrief(`# H1: Guide

## H2: Only section
- Guidance.`));
  const faq = added.sections[added.sections.length - 1];
  assert.equal(faq.heading, 'Frequently Asked Questions');
  assert.equal(faq.level, 'H2');
  assert.match(faq.guidance, /complete answer/);
  // A brief that already has one is left exactly as generated.
  const existing = parseBrief(markdown);
  assert.deepEqual(ensureFaqSection(existing).sections, existing.sections);
  // Deleting it is the writer's call, and nothing puts it back.
  const without = { ...existing, sections: existing.sections.filter(x => !/Frequently Asked/.test(x.heading)) };
  assert.equal(without.sections.length, existing.sections.length - 1);
});
test('removing an unsupported claim cuts whole sentences, never leaving a fragment', () => {
  const html = '<h2>Cleaning schedules</h2><p>Most adults are advised to attend every 6 months, but the best answer depends on your oral health.</p>';
  const { html: out, omitted } = removeUnsupported(html, { sources: [],
    removals: [{ blockId: 'B2', excerpt: 'Most adults are advised to attend every 6 months,', reason: 'Not in any source.' }] });
  // The old behaviour left "but the best answer depends on your oral health."
  assert.doesNotMatch(out, /(^|>)\s*but\b/i);
  assert.doesNotMatch(out, /6 months/);
  assert.doesNotMatch(out, /best answer/);
  assert.ok(omitted.length);
});
test('a question left without an answer is removed rather than shown bare', () => {
  const html = '<h2>Frequently Asked Questions</h2><h3>How often should you get a cleaning?</h3>'
    + '<p>A 2024 survey of researchers found 88% agreement.</p>'
    + '<h3>Does it hurt?</h3><p>Most people feel only mild pressure during a routine appointment.</p>';
  const { html: out } = removeUnsupported(html, { sources: [], conservative: true });
  assert.doesNotMatch(out, /How often should you get a cleaning/);
  assert.match(out, /Does it hurt/);
  assert.match(out, /mild pressure/);
  assert.match(out, /Frequently Asked Questions/);
});
test('stripping covers every heading level and leaves no mangled structure behind', () => {
  const { reviewBlocks } = require('../removeUnsupported');
  // The checker has to be able to see and anchor to H5 and H6, not just H2-H4.
  assert.deepEqual(reviewBlocks('<h5>Five</h5><p>Body five.</p><h6>Six</h6><p>Body six.</p>').passages.map(p => p.text),
    ['Five', 'Body five.', 'Six', 'Body six.']);
  // An unverified link in a heading loses the link, not the heading's wording.
  assert.equal(removeUnsupported('<h5>See <a href="https://evil.test">this claim</a> today.</h5><p>Body.</p>', { sources: [] }).html,
    '<h5>See this claim today.</h5><p>Body.</p>');
  // A quotation wrapping a paragraph is not a leaf block, but is still a quotation.
  assert.doesNotMatch(removeUnsupported('<p>Plain explanatory wording with no evidence.</p><blockquote><p>We transform outcomes.</p></blockquote>',
    { sources: [], conservative: true }).html, /transform outcomes/);
  // A number in a heading is not a claim to verify, so the heading survives intact.
  assert.match(removeUnsupported('<h2>6 signs of gum disease</h2><p>Plain explanatory wording.</p>',
    { sources: [], conservative: true }).html, /<h2>6 signs of gum disease<\/h2>/);
  // Nothing may leave an empty heading in the article.
  assert.equal(removeUnsupported('<h2></h2><p>Plain explanatory wording.</p>', { sources: [] }).html, '<p>Plain explanatory wording.</p>');
});
test('only claims credited to a source are policed when verification is inconclusive', () => {
  const survives = ['This section explains the topic in plain language for readers new to it.',
    'Most people wait 6 months between cleanings.', 'A routine cleaning costs about $150 in most areas.',
    'Many college students skip their cleanings.', 'Most people say they feel fine afterwards.'];
  const removed = ['According to the ADA, 42% of adults skip cleanings.',
    'A 2024 study found that 42% of adults skip cleanings.', 'Dr. Lee says most patients feel no pain.',
    'The American Dental Association recommends twice-yearly visits.', 'Harvard researchers reported a sharp decline.'];
  const strip = sentence => removeUnsupported(`<p>${sentence}</p><p>Filler wording that keeps the block alive.</p>`,
    { sources: [], conservative: true }).html;
  // A number alone is ordinary wording, not a sourced claim.
  for (const sentence of survives) assert.ok(strip(sentence).includes(sentence.slice(0, 20)), `should survive: ${sentence}`);
  for (const sentence of removed) assert.ok(!strip(sentence).includes(sentence.slice(0, 20)), `should be removed: ${sentence}`);
});
test('evidence survives the typography difference between a page and the model quoting it', () => {
  const page = 'The ADA’s 2024 survey found that 42% of adults — roughly 1 in 3 — skipped a cleaning. “Prevention beats repair,” said Dr. Lee.';
  const sources = [{ id: 'S1', url: 'https://example.org', text: page }];
  const keeps = (type, text) => supportedEvidence([{ sourceId: 'S1', type, claim: text, excerpt: text }], sources).length;
  // Curly on the page, straightened by the model: both must verify.
  assert.equal(keeps('statistic', 'The ADA’s 2024 survey found that 42% of adults — roughly 1 in 3 — skipped a cleaning.'), 1);
  assert.equal(keeps('statistic', "The ADA's 2024 survey found that 42% of adults - roughly 1 in 3 - skipped a cleaning."), 1);
  assert.equal(keeps('quotation', '“Prevention beats repair,” said Dr. Lee.'), 1);
  assert.equal(keeps('quotation', '"Prevention beats repair," said Dr. Lee.'), 1);
  // Folding must not start accepting text the source never contained.
  assert.equal(keeps('statistic', 'The ADA survey found that 91% of adults skipped a cleaning entirely.'), 0);
});
test('rich text sanitation preserves tables and safe links while removing executable markup', () => {
  const html = cleanHtml('<script>alert(1)</script><h2 onclick="x()">Title</h2><p><strong>Bold</strong><a href="javascript:alert(1)">bad</a></p><table><tr><td colspan="2">Cell</td></tr></table><a href="https://example.org">Source</a>');
  assert.doesNotMatch(html, /script|onclick|javascript:/);
  assert.match(html, /<strong>Bold<\/strong>/); assert.match(html, /colspan="2"/);
  assert.match(html, /href="https:\/\/example.org"/);
});
test('evidence requires a retrieved passage and quotations must occur verbatim', () => {
  const sources = [{ id: 'S1', url: 'https://example.org', text: 'The study reported that 25% of participants improved in 2024.' }];
  const valid = { sourceId: 'S1', type: 'statistic', claim: '25% improved', excerpt: sources[0].text };
  assert.equal(supportedEvidence([valid, { ...valid, sourceId: 'invented' }, { ...valid, excerpt: 'This number was invented in a fake passage.' },
    { ...valid, type: 'quotation', claim: 'An expert never said this' }], sources).length, 1);
  assert.deepEqual(checkLinks('<a href="https://example.org">Source</a>', sources), []);
  assert.equal(checkLinks('<a href="https://invented.org">Source</a>', sources).length, 1);
});
function fakeResearch(replies) {
  const calls = [];
  return { calls, deps: {
    search: async () => ({ results: [{ title: 'Study', url: 'https://example.org/study' }] }),
    fetcher: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, finalUrl: 'https://example.org/study',
      data: `<html><title>Study</title><main>The study reported that 25% of participants improved in 2024. ${'Research context and study methods are described here. '.repeat(8)}</main></html>` }),
    llm: { chat: { completions: { create: async request => { calls.push(request); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies.shift()) } }] }; } } } },
  } };
}
test('drafting uses the edited brief, gpt-5.4-mini, source verification and a correction pass', async () => {
  const doc = document(); doc.brief.sections[0].heading = 'User edited heading';
  const html = '<h1>A practical guide</h1><h2>User edited heading</h2><p>The study reported 25% improvement <a href="https://example.org/study">(Study, 2024)</a>.</p>';
  const { calls, deps } = fakeResearch([
    { claims: [{ sourceId: 'S1', type: 'statistic', claim: '25% improved in 2024', excerpt: 'The study reported that 25% of participants improved in 2024.' }] },
    { html: html.replace('example.org', 'invented.org'), gaps: [] },
    { approved: true, issues: [] }, // Deterministic URL guard still refuses it.
    { html, gaps: ['A named reviewer has not been supplied.'] },
    { approved: true, issues: [] },
  ]);
  const result = await generateDraft(doc, () => {}, deps);
  assert.equal(calls.length, 5); assert.ok(calls.every(c => c.model === 'gpt-5.4-mini'));
  assert.match(calls[1].messages[1].content, /User edited heading/);
  assert.match(calls[1].messages[0].content, /CSQAF/);
  assert.match(result.draftHtml, /example.org/); assert.doesNotMatch(result.draftHtml, /invented.org/);
  assert.equal(result.research.status, 'AI source check passed');
  assert.ok(result.research.gaps.some(g => /reviewer/.test(g)));
  assert.equal(result.research.sources[0].text, undefined);
});
test('research failure fails closed before any draft is written', async () => {
  const { deps } = fakeResearch([]); deps.fetcher = async () => { throw new Error('Offline'); };
  await assert.rejects(generateDraft(document(), () => {}, deps), /No research sources/);
});
// The body a failed check should leave behind: long enough to be worth keeping.
const survivingProse = 'This section explains the topic in plain language for readers new to it. '.repeat(4);
test('a draft that fails verification keeps its supported text and loses only the flagged passages', async () => {
  const warnings = [];
  const unsupported = 'Another unsupported statistic: 77% of clinics agree.';
  const rejection = { approved: false, issues: ['Unsupported 77% claim'],
    removals: [{ blockId: 'B3', excerpt: unsupported, reason: 'No retrieved source contains this figure.' }] };
  const { deps } = fakeResearch([{ claims: [] },
    { html: `<h1>A practical guide</h1><p>${survivingProse}</p><p>${unsupported}</p>`, gaps: [] }, rejection,
    { html: `<h1>A practical guide</h1><p>${survivingProse}</p><p>${unsupported}</p>`, gaps: [] }, rejection]);
  const result = await generateDraft(document(), (type, data) => { if (type === 'warning') warnings.push(data.message); }, deps);
  assert.doesNotMatch(result.draftHtml, /77%/);
  assert.match(result.draftHtml, /plain language/);
  assert.match(result.draftHtml, /<h1>A practical guide<\/h1>/);
  assert.equal(result.research.status, 'Unverified claims removed after AI source check');
  assert.equal(result.research.omitted.length, 1);
  assert.match(result.research.omitted[0].text, /77%/);
  assert.ok(result.research.gaps.some(g => /failed source verification/.test(g)));
  assert.ok(result.research.gaps.some(g => /Unsupported 77% claim/.test(g)));
  assert.ok(warnings.some(w => /unverified passage/.test(w)));
});
test('a rejection naming no passages strips every evidence-bearing sentence instead of guessing', async () => {
  const rejection = { approved: false, issues: ['Something is unsupported'], removals: [] };
  const body = `<h1>A practical guide</h1><p>${survivingProse}</p><p>A survey found 88% agreement.</p>`;
  const { deps } = fakeResearch([{ claims: [] }, { html: body, gaps: [] }, rejection, { html: body, gaps: [] }, rejection]);
  const result = await generateDraft(document(), () => {}, deps);
  assert.doesNotMatch(result.draftHtml, /88%/);
  assert.match(result.draftHtml, /plain language/);
  assert.equal(result.research.status, 'Unverified claims removed after AI source check');
  assert.match(result.research.omitted[0].reason, /the source it credits could not be verified/);
});
test('an unusable checker response strips evidence rather than discarding the draft', async () => {
  const { deps } = fakeResearch([{ claims: [] },
    { html: `<h1>A practical guide</h1><p>${survivingProse}</p><p>Researchers reported a 41% change.</p>`, gaps: [] }]);
  const create = deps.llm.chat.completions.create;
  let calls = 0;
  deps.llm.chat.completions.create = async request => (++calls > 2 ? Promise.reject(new Error('Checker timed out')) : create(request));
  const result = await generateDraft(document(), () => {}, deps);
  assert.doesNotMatch(result.draftHtml, /41%/);
  assert.match(result.draftHtml, /plain language/);
  assert.equal(result.research.status, 'Unverified claims removed after AI source check');
  assert.ok(result.research.gaps.some(g => /could not be completed/.test(g)));
  assert.ok(result.research.gaps.some(g => /Checker timed out/.test(g)));
});
test('a draft left empty by stripping is reported instead of overwriting saved work', async () => {
  const rejection = { approved: false, issues: ['Every figure is invented'], removals: [] };
  const body = '<p>A survey found 88% agreement among researchers in 2024.</p>';
  const { deps } = fakeResearch([{ claims: [] }, { html: body, gaps: [] }, rejection, { html: body, gaps: [] }, rejection]);
  await assert.rejects(generateDraft(document(), () => {}, deps), error => {
    assert.equal(error.code, 'source_verification_failed');
    assert.deepEqual(error.issues, ['Every figure is invented']);
    assert.match(error.message, /left no article to save/);
    assert.match(error.message, /saved brief and existing draft have not been changed/);
    return true;
  });
});
test('the outline is sized to the word count, and the shared legacy path is untouched', async () => {
  const prompts = [];
  const run = async targetWords => {
    prompts.length = 0;
    const replies = [JSON.stringify({ commonH2Topics: ['t'] }), markdown, JSON.stringify({ aligned: true })];
    const result = await generateArticleBrief({ keyword: 'topic', targetWords }, () => {}, {
      searchGoogle: async () => ({ results: Array.from({ length: 10 }, (_, i) => ({ url: `https://e.test/${i}`, title: 't' })) }),
      scrapeUrlsDetailed: async urls => urls.map((url, i) => ({ url, success: true, title: 'T', h1: 'H',
        h2s: [], h3s: [], h4s: [], faqs: [], bodyText: 'word '.repeat([1000, 1400, 1800][i % 3]) })),
      openai: { chat: { completions: { create: async request => {
        prompts.push(request.messages[0].content);
        return { choices: [{ message: { content: replies.shift() } }] };
      } } } },
    });
    return { resolved: result.targetWords, prompt: prompts[1] };
  };
  // Article Recommendation passes no target, and its prompt must not change.
  const legacy = await run(undefined);
  assert.equal(legacy.resolved, null);
  assert.match(legacy.prompt, /aim for 8–12 H2 sections total/);
  assert.doesNotMatch(legacy.prompt, /target length/);
  // ~200 words per H2, clamped, and the FAQ is additional.
  for (const [words, sections] of [[800, 4], [1000, 5], [2400, 12], [6000, 12]]) {
    const sized = await run(words);
    assert.equal(sized.resolved, words);
    assert.match(sized.prompt, new RegExp(`exactly ${sections} H2 sections`));
    assert.doesNotMatch(sized.prompt, /aim for 8–12 H2 sections total/);
  }
  // No target given: size to the median of the competitors that rank.
  const auto = await run('auto');
  assert.equal(auto.resolved, 1400);
  assert.match(auto.prompt, /exactly 7 H2 sections/);
});
const planFixture = () => parseBrief(['# H1: Guide', '', '## H2: Costs', '- g', '## H2: Timing', '- g',
  '## H2: Risks', '- g', '## H2: Frequently Asked Questions', '- q', '',
  '**Reference Blog URLs:**', '- [1] https://e.test'].join('\n'));
const claudeStub = (plan, capture = []) => ({ messages: { create: async request => {
  capture.push(request);
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] };
} } });

test('the planner places CSQAF and keywords selectively, on Claude Sonnet 5', async () => {
  const brief = planFixture();
  const [costs, timing, risks, faq] = brief.sections;
  const plan = { citations: [{ sectionId: risks.id, what: 'Back the risk claim.' }],
    statistics: [{ sectionId: costs.id, what: 'A dated average price.' }],
    quotations: [{ sectionId: risks.id, what: 'An expert on prevention.' }],
    tables: [{ sectionId: costs.id, what: 'Cost by plan.', columns: ['Plan', 'Cost'] },
      { sectionId: faq.id, what: 'Should never land on the FAQ.', columns: ['Q'] }],
    keywords: [{ sectionId: costs.id, keyword: 'cleaning cost' }, { sectionId: timing.id, keyword: 'how often' },
      { sectionId: costs.id, keyword: 'cleaning cost' }] };
  const requests = [];
  const planned = await planBrief(brief, { keyword: 'k', targetWords: 1000,
    secondaryKeywords: 'cleaning cost, how often, dental insurance' }, () => {}, { llm: claudeStub(plan, requests) });
  const byId = id => planned.brief.sections.find(s => s.id === id).guidance;
  assert.equal(requests[0].model, 'claude-sonnet-5');
  assert.deepEqual(requests[0].thinking, { type: 'adaptive' });
  assert.equal(requests[0].output_config.format.type, 'json_schema');
  assert.match(requests[0].system, /Do not force fit/);
  assert.match(byId(costs.id), /CSQAF:[\s\S]*Statistic: A dated average price/);
  assert.match(byId(costs.id), /Table: Cost by plan\. \(columns: Plan, Cost\)/);
  assert.match(byId(costs.id), /Keyword: cleaning cost/);
  assert.match(byId(risks.id), /Citation: Back the risk claim/);
  assert.match(byId(risks.id), /Quotation: An expert on prevention/);
  assert.match(byId(timing.id), /Keyword: how often/);
  // A table or quotation is never placed on the FAQ section.
  assert.equal(byId(faq.id), faq.guidance);
  // A keyword is placed once, however many times the model returned it.
  assert.equal((byId(costs.id).match(/Keyword: cleaning cost/g) || []).length, 1);
});
test('a keyword with no natural home is reported, not forced into a section', async () => {
  const brief = planFixture();
  const warnings = [];
  const plan = { citations: [], statistics: [], quotations: [], tables: [],
    keywords: [{ sectionId: brief.sections[0].id, keyword: 'cleaning cost' }] };
  const planned = await planBrief(brief, { keyword: 'k', secondaryKeywords: 'cleaning cost, orthodontics, veneers' },
    (type, data) => { if (type === 'warning') warnings.push(data.message); }, { llm: claudeStub(plan) });
  assert.deepEqual(planned.plan.unusedKeywords, ['orthodontics', 'veneers']);
  assert.ok(warnings.some(w => /no natural home/.test(w) && /orthodontics, veneers/.test(w)));
  // Nothing was invented to absorb them.
  assert.doesNotMatch(JSON.stringify(planned.brief.sections), /orthodontics|veneers/);
});
test('a planner that cannot run fails the brief rather than returning an unplanned one', async () => {
  const brief = planFixture();
  const broken = { messages: { create: async () => { throw new Error('planner down'); } } };
  await assert.rejects(planBrief(brief, { keyword: 'k' }, () => {}, { llm: broken }), /planner down/);
  // A refusal or a truncated plan is a failure too, not an empty plan.
  const refused = { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }) } };
  await assert.rejects(planBrief(brief, { keyword: 'k' }, () => {}, { llm: refused }), /declined \(cyber\)/);
  const truncated = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }) } };
  await assert.rejects(planBrief(brief, { keyword: 'k' }, () => {}, { llm: truncated }), /incomplete/);
});
test('a draft missing its tables or its length is corrected once, in a single pass', async () => {
  const { structuralFaults, articleWords } = require('../writer');
  const tables = [{ heading: 'Costs', what: 'Cost by plan', columns: ['Plan', 'Cost'] }];
  const short = '<h1>T</h1><p>Too short by far.</p>';
  // Both faults are reported together so one rewrite can fix them.
  const both = structuralFaults(short, tables, 1000);
  assert.equal(both.length, 2);
  assert.match(both[0], /asks for 1 table\(s\) but the draft contains 0/);
  assert.match(both[1], /against a target of 1000/);
  assert.match(both[1], /Expand/);
  const long = `<h1>T</h1><table><tr><th>Plan</th></tr></table><p>${'word '.repeat(2000)}</p>`;
  assert.match(structuralFaults(long, tables, 1000)[0], /Tighten/);
  // Inside the tolerance band, nothing is flagged.
  assert.deepEqual(structuralFaults(`<p>${'word '.repeat(960)}</p>`, [], 1000), []);
  assert.equal(articleWords('<h1>One two</h1><p>three four five</p>'), 5);
  // And with no target at all the check stays silent.
  assert.deepEqual(structuralFaults(short, [], 0), []);
});
test('DOCX exports preserve edited headings, formatted text, links and table cells', async () => {
  const JSZip = require('jszip');
  const doc = document();
  doc.draftHtml = '<h1>Edited title</h1><p><strong>Bold words</strong> and <em>italics</em> <a href="https://example.org/study">Study</a></p><ol><li>First</li><li>Second</li></ol><table><tr><th>Topic</th><th>Detail</th></tr><tr><td>Cell one</td><td>Cell two</td></tr></table>';
  const zip = await JSZip.loadAsync(await exportDocx(doc, 'draft'));
  const xml = await zip.file('word/document.xml').async('string');
  const rel = await zip.file('word/_rels/document.xml.rels').async('string');
  for (const text of ['Edited title', 'Bold words', 'Cell one', 'Cell two', 'First', 'Second']) assert.ok(xml.includes(text));
  assert.match(xml, /w:tbl/); assert.match(xml, /w:hyperlink/); assert.match(rel, /https:\/\/example.org\/study/);
  const brief = await JSZip.loadAsync(await exportDocx(doc, 'brief'));
  assert.match(await brief.file('word/document.xml').async('string'), /Visual Opportunity: Comparison table/);
});
test('exporting what is on screen does not depend on the keyword still being filled in', async () => {
  const brief = parseBrief(markdown);
  // Saving still requires a keyword; downloading a brief already written does not.
  assert.throws(() => store.editable({ keyword: '', brief, draftHtml: '' }));
  assert.equal(store.exportable({ keyword: '', brief, draftHtml: '' }).keyword, '');
  assert.ok((await exportDocx(store.exportable({ keyword: '', brief, draftHtml: '' }), 'brief')).length > 0);
});
test('store updates scope both project and revision and reject concurrent overwrites', async () => {
  const old = db.maybeOne;
  let captured;
  db.maybeOne = async (sql, args) => { captured = { sql, args }; return null; };
  try {
    await assert.rejects(store.save('project-1', 'article-1', 4, document()), { status: 409 });
    assert.match(captured.sql, /project_id=\$1 and id=\$2 and revision=\$3/);
    assert.deepEqual(captured.args.slice(0, 3), ['project-1', 'article-1', 4]);
  } finally { db.maybeOne = old; }
});
test('every content route checks project authorization before reading, writing, generating or exporting', async () => {
  const express = require('express');
  const app = express(); app.use(express.json()); app.use(require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const old = projectAccess.requireProject;
  const seen = []; projectAccess.requireProject = async (req, project, capability) => { seen.push({ project, capability }); throw Object.assign(new Error('Project not found.'), { status: 404 }); };
  const p = '11111111-1111-4111-8111-111111111111', a = '22222222-2222-4222-8222-222222222222';
  try {
    for (const [method, suffix] of [['GET','articles'],['POST','articles'],['GET',`articles/${a}`],['PUT',`articles/${a}`],['POST',`articles/${a}/brief`],['POST',`articles/${a}/draft`],['POST','export']]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/projects/${p}/${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(res.status, 404, `${method} ${suffix}`);
    }
    assert.equal(seen.length, 7); assert.ok(seen.every(s => s.project === p && s.capability));
  } finally { projectAccess.requireProject = old; await new Promise(r => server.close(r)); }
});
test('missing Content Writer storage returns actionable setup guidance instead of a generic failure', async () => {
  const express = require('express');
  const app = express(); app.use(require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const oldAccess = projectAccess.requireProject, oldList = store.list;
  projectAccess.requireProject = async () => ({});
  store.list = async () => { throw Object.assign(new Error('relation "content_writer_articles" does not exist'), { code: '42P01' }); };
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/projects/11111111-1111-4111-8111-111111111111/articles`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'content_writer_storage_not_ready');
    assert.match(body.error, /0031_content_writer\.sql/);
  } finally { projectAccess.requireProject = oldAccess; store.list = oldList; await new Promise(r => server.close(r)); }
});
