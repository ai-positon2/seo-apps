// ── extractionPass ────────────────────────────────────────────────────────
//
// The orchestrator. What is pinned here is the ORDER and the failure
// behaviour, because both are what make a number trustworthy months later:
// deterministic matching decides membership, the LLM only scores, rows land
// before the capture is stamped, and a capture that could not be extracted
// stays pending rather than being marked done with nothing behind it.
//
// The store is stubbed. Nothing here touches a database or a network.
//
// Run: node modules/aiVisibility/__tests__/extractionPass.test.js

const assert = require('assert');
const path = require('path');

// Stub the store before extract.js requires it.
const storePath = require.resolve('../store.js');
const calls = { mentions: [], citations: [], marked: [] };
let pendingRows = [];
let measured = [];
let throwOn = null;

require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  paths: [],
  exports: {
    async saveMentions(args) {
      if (throwOn === 'mentions') throw new Error('db down');
      calls.mentions.push(args);
      return args.mentions.length;
    },
    async saveCitations(args) { calls.citations.push(args); return args.citations.length; },
    async saveAttributes() { return 0; },
    async markExtracted(args) { calls.marked.push(args); return true; },
    async measuredSet() { return measured; },
    async capturesPendingExtraction() { return pendingRows; },
  },
};

const extract = require('../extractionPass');

let passed = 0, failed = 0;
async function test(name, fn) {
  calls.mentions = []; calls.citations = []; calls.marked = []; throwOn = null;
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const ACCESS = { project: { id: 'p1', workspace_id: 'w1' }, userId: 'u1' };

const BRANDS = [
  {
    id: 'b1', name: 'Gentle Dental', aliases: ['Gentle Dental'], isClient: true, domain: 'gentledental.com',
  },
  {
    id: 'b2', name: 'Aspen Dental', aliases: ['Aspen Dental'], isClient: false, domain: 'aspendental.com',
  },
];

const capture = (over = {}) => ({
  id: 'c1',
  status: 'captured',
  prompt: 'best dentist in boston',
  answerText: 'Gentle Dental is well reviewed. Aspen Dental is nearby too.',
  citations: [],
  ...over,
});

(async () => {
  section('extractCapture — the deterministic matcher decides membership');

  await test('mentions are found and persisted with the capture id', async () => {
    const r = await extract.extractCapture({
      access: ACCESS, capture: capture(), brands: BRANDS, useLlm: false,
    });
    assert.strictEqual(r.mentions, 2);
    assert.strictEqual(calls.mentions[0].captureId, 'c1');
    assert.strictEqual(calls.mentions[0].projectId, 'p1');
    assert.deepStrictEqual(
      calls.mentions[0].mentions.map((m) => m.brandId).sort(), ['b1', 'b2'],
    );
  });

  await test('with the LLM pass off, sentiment is null — never a default 50', async () => {
    await extract.extractCapture({
      access: ACCESS, capture: capture(), brands: BRANDS, useLlm: false,
    });
    assert.ok(calls.mentions[0].mentions.every((m) => m.sentiment === null));
  });

  await test('a brand not named produces no row at all', async () => {
    await extract.extractCapture({
      access: ACCESS,
      capture: capture({ answerText: 'Gentle Dental is well reviewed.' }),
      brands: BRANDS,
      useLlm: false,
    });
    assert.strictEqual(calls.mentions[0].mentions.length, 1,
      'absence must be the absence of a row, so a row count IS the numerator');
  });

  section('map answers — the local-business case');

  await test('a brand present only as a map card is found, not recorded as absent', async () => {
    const r = await extract.extractCapture({
      access: ACCESS,
      capture: capture({
        answerText: 'Here are some options near you.',
        raw: { mapCards: [{ name: 'Gentle Dental of Newbury St', position: 1 }] },
      }),
      brands: BRANDS,
      useLlm: false,
    });
    assert.strictEqual(r.mentions, 1);
    assert.strictEqual(calls.mentions[0].mentions[0].ordinal, 1, 'card position is the ranking');
  });

  section('citations — classified as of ingest, rolled up correctly');

  await test('a subdomain rolls up to its registrable domain for the Domains report', async () => {
    await extract.extractCapture({
      access: ACCESS,
      capture: capture({
        citations: [{
          url: null, host: 'adanews.ada.org', domain: 'adanews.ada.org', isInlineCited: true, occurrences: 3, index: 0,
        }],
      }),
      brands: BRANDS,
      useLlm: false,
    });
    const [c] = calls.citations[0].citations;
    assert.strictEqual(c.host, 'adanews.ada.org', 'the host stays distinguishable');
    assert.strictEqual(c.domain, 'ada.org', 'the adapter shape would never have rolled up');
    assert.strictEqual(c.domainType, 'institutional');
    assert.strictEqual(c.occurrences, 3);
    assert.ok(c.rulesetVersion, 'stored as of ingest so past periods stay reproducible');
  });

  await test('the client and a competitor are classified from the measured set, not by pattern', async () => {
    await extract.extractCapture({
      access: ACCESS,
      capture: capture({
        citations: [
          { url: 'https://gentledental.com/implants', host: 'gentledental.com', isInlineCited: true },
          { url: 'https://aspendental.com/', host: 'aspendental.com', isInlineCited: true },
        ],
      }),
      brands: BRANDS,
      useLlm: false,
    });
    const types = calls.citations[0].citations.map((c) => c.domainType);
    assert.deepStrictEqual(types, ['you', 'competitor']);
  });

  await test('duplicate citations merge their counts instead of failing the insert', async () => {
    await extract.extractCapture({
      access: ACCESS,
      capture: capture({
        citations: [
          { url: null, host: 'ada.org', isInlineCited: true, occurrences: 2 },
          { url: null, host: 'www.ada.org', isInlineCited: true, occurrences: 3 },
        ],
      }),
      brands: BRANDS,
      useLlm: false,
    });
    assert.strictEqual(calls.citations[0].citations.length, 1, '0018 makes this pair unique');
    assert.strictEqual(calls.citations[0].citations[0].occurrences, 5);
  });

  section('failed captures — never marked as a measured absence');

  await test('a failed capture is stamped extracted but writes no mention rows', async () => {
    const r = await extract.extractCapture({
      access: ACCESS,
      capture: capture({ status: 'failed', answerText: null }),
      brands: BRANDS,
      useLlm: false,
    });
    assert.strictEqual(r.skipped, 'not_captured');
    assert.strictEqual(calls.mentions.length, 0, 'no row may assert the brand was absent');
    assert.strictEqual(calls.marked.length, 1, 'but it must leave the queue, or it retries at cost forever');
  });

  section('rows land BEFORE the capture is stamped');

  await test('a persistence failure leaves the capture pending, not marked done', async () => {
    throwOn = 'mentions';
    await assert.rejects(() => extract.extractCapture({
      access: ACCESS, capture: capture(), brands: BRANDS, useLlm: false,
    }));
    assert.strictEqual(calls.marked.length, 0,
      'stamping first would lose the rows silently and forever');
  });

  section('extractPending — the batch path');

  await test('with no approved brands, nothing is extracted and the reason is reported', async () => {
    measured = [];
    pendingRows = [capture()];
    const s = await extract.extractPending({ access: ACCESS, useLlm: false });
    assert.strictEqual(s.extracted, 0);
    assert.strictEqual(s.errors[0].code, 'no_measured_set');
    assert.strictEqual(calls.marked.length, 0,
      'stamping here would freeze zero-mention rows in as measured absences');
  });

  await test('one bad capture does not stop the batch, and stays pending', async () => {
    measured = BRANDS;
    pendingRows = [capture({ id: 'c1' }), capture({ id: 'c2' }), capture({ id: 'c3' })];
    let n = 0;
    const realSave = require('../store').saveMentions;
    require('../store').saveMentions = async (args) => {
      n += 1;
      if (n === 2) throw new Error('transient');
      return realSave(args);
    };
    const s = await extract.extractPending({ access: ACCESS, useLlm: false });
    require('../store').saveMentions = realSave;

    assert.strictEqual(s.considered, 3);
    assert.strictEqual(s.extracted, 2);
    assert.strictEqual(s.failed, 1);
    assert.strictEqual(s.errors[0].captureId, 'c2');
  });

  section('the version stamp names every ruleset that produced the row');

  await test('EXTRACTION_VERSION carries both the classifier and the rubric version', () => {
    const classify = require('../captureEngines/domainClassify');
    const llm = require('../captureEngines/llmExtract');
    assert.ok(extract.EXTRACTION_VERSION.includes(classify.RULESET_VERSION));
    assert.ok(extract.EXTRACTION_VERSION.includes(llm.EXTRACTION_VERSION));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
