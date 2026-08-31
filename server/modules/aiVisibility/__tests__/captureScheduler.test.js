// ── captureScheduler ──────────────────────────────────────────────────────
//
// The concurrency shape is the whole point: SERIAL within an engine (politeness
// — Phase 0 measured that a second Google search inside the cooldown is refused
// outright), PARALLEL across engines (independent services, independent limits),
// under one global browser cap (memory).
//
// A test that only checked the results would pass on a fully serial
// implementation, so these assert on OBSERVED OVERLAP.
//
// Run: node modules/aiVisibility/__tests__/captureScheduler.test.js

const assert = require('assert');
const sched = require('../captureScheduler');

let passed = 0, failed = 0;
async function test(name, fn) {
  // The burst counter is module-level and deliberately survives a measureSet
  // now (run boundaries are our concept, not the engine’s), so tests must
  // clear it or one case inherits another’s bursts and sleeps out a real rest.
  try { require('../captureScheduler').resetBursts(); } catch { /* not loaded */ }
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPTS = [
  { id: 'p1', text: 'one' },
  { id: 'p2', text: 'two' },
  { id: 'p3', text: 'three' },
];

/** A measure() that records when each capture was in flight. */
function tracker({ delay = 20, fail: failOn = null } = {}) {
  const events = [];
  const inFlight = new Map();
  let maxOverlapPerEngine = 0;
  let maxOverlapTotal = 0;

  const measure = async ({ surfaceId, prompt, promptId }) => {
    const engine = surfaceId.split(':')[0];
    inFlight.set(`${surfaceId}|${promptId}`, engine);

    const perEngine = [...inFlight.values()].filter((e) => e === engine).length;
    maxOverlapPerEngine = Math.max(maxOverlapPerEngine, perEngine);
    maxOverlapTotal = Math.max(maxOverlapTotal, inFlight.size);

    events.push({ surfaceId, promptId, at: Date.now() });
    await wait(delay);
    inFlight.delete(`${surfaceId}|${promptId}`);

    if (failOn && failOn(surfaceId, promptId)) throw new Error('capture blew up');
    return {
      status: 'captured', prompt, surfaceId, engine, mentioned: false,
    };
  };

  return {
    measure, events, get maxOverlapPerEngine() { return maxOverlapPerEngine; }, get maxOverlapTotal() { return maxOverlapTotal; },
  };
}

(async () => {
  section('within an engine, captures are strictly serial');

  await test('two prompts on one surface never overlap', async () => {
    const t = tracker({ delay: 25 });
    await sched.measureSet({
      prompts: PROMPTS,
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: t.measure,
    });
    assert.strictEqual(t.maxOverlapPerEngine, 1,
      'parallel requests from one IP is the fastest way to lose the surface');
  });

  section('across engines, captures run in parallel');

  await test('four engines overlap rather than queueing behind each other', async () => {
    const t = tracker({ delay: 30 });
    const surfaces = [
      { id: 'chatgpt:scraped', engine: 'chatgpt' },
      { id: 'gemini:scraped', engine: 'gemini' },
      { id: 'google_ai_overview:scraped', engine: 'google_ai_overview' },
      { id: 'google_ai_mode:scraped', engine: 'google_ai_mode' },
    ];
    await sched.measureSet({ prompts: PROMPTS, surfaces, measure: t.measure });

    assert.ok(t.maxOverlapTotal > 1,
      `expected engines to overlap, saw a maximum of ${t.maxOverlapTotal} in flight`);
    assert.strictEqual(t.maxOverlapPerEngine, 1, 'but each engine stayed serial');
  });

  await test('the global browser cap is never exceeded', async () => {
    const t = tracker({ delay: 20 });
    const surfaces = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}:scraped`, engine: `e${i}` }));
    await sched.measureSet({ prompts: PROMPTS, surfaces, measure: t.measure });
    // Read through the accessor: the cap is resolved from env when used, not
    // frozen at require time.
    const cap = sched.maxConcurrentBrowsers();
    assert.ok(t.maxOverlapTotal <= cap,
      `${t.maxOverlapTotal} browsers in flight, cap is ${cap}`);
  });

  section('every prompt on every surface is attempted exactly once');

  await test('no capture is dropped or duplicated', async () => {
    const t = tracker({ delay: 5 });
    const surfaces = [
      { id: 'chatgpt:scraped', engine: 'chatgpt' },
      { id: 'gemini:scraped', engine: 'gemini' },
    ];
    const { rows } = await sched.measureSet({ prompts: PROMPTS, surfaces, measure: t.measure });
    assert.strictEqual(rows.length, 6);
    const keys = rows.map((r) => `${r.surfaceId}|${r.promptId}`);
    assert.strictEqual(new Set(keys).size, 6, 'a duplicate would bill the client twice');
  });

  section('a thrown capture is a FAILED capture, never a missing one');

  await test('a blown-up capture yields a row with mentioned null', async () => {
    const t = tracker({ delay: 5, fail: (s, p) => p === 'p2' });
    const { rows } = await sched.measureSet({
      prompts: PROMPTS,
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: t.measure,
    });
    assert.strictEqual(rows.length, 3, 'the lane must not abandon its remaining prompts');
    const bad = rows.find((r) => r.promptId === 'p2');
    assert.strictEqual(bad.status, 'failed');
    assert.strictEqual(bad.mentioned, null,
      'false here would assert the brand was absent from an answer nobody read');
    assert.ok(bad.failureReason);
  });

  section('Gemini rests after 5 — measured, not guessed');

  await test('never takes more than 5 Gemini captures in a row', async () => {
    process.env.AIV_GEMINI_BURST_REST_MS = '40';
    delete require.cache[require.resolve('../captureScheduler')];
    const fresh = require('../captureScheduler');

    const order = [];
    const rests = [];
    await fresh.measureSet({
      prompts: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, text: `q${i}` })),
      surfaces: [{ id: 'gemini:scraped', engine: 'gemini' }],
      measure: async ({ promptId }) => { order.push(promptId); return { status: 'captured' }; },
      onRest: (info) => rests.push(info),
    });

    assert.strictEqual(order.length, 12, 'every prompt is still measured, just paced');
    assert.strictEqual(rests.length, 2, '12 captures at 5 per burst rests twice');
    assert.strictEqual(rests[0].engine, 'gemini');
    assert.strictEqual(rests[0].after, 5,
      'a ramp measured Gemini refusing from capture 6, so 5 is the ceiling');

    delete process.env.AIV_GEMINI_BURST_REST_MS;
    delete require.cache[require.resolve('../captureScheduler')];
  });

  await test('the burst count SURVIVES a run boundary', async () => {
    // Five runs in three hours never rested once, because measureSet called
    // resetBursts() on the way in. A run boundary is our concept; the engine
    // only sees requests from this machine, so the count has to carry.
    process.env.AIV_GEMINI_BURST_REST_MS = '40';
    delete require.cache[require.resolve('../captureScheduler')];
    const fresh = require('../captureScheduler');

    const rests = [];
    const runOf = (n) => fresh.measureSet({
      prompts: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `q${i}` })),
      surfaces: [{ id: 'gemini:scraped', engine: 'gemini' }],
      measure: async () => ({ status: 'captured' }),
      onRest: (info) => rests.push(info),
    });

    await runOf(3);                       // 3 taken, under the limit of 5
    assert.strictEqual(rests.length, 0, 'three captures is under the cap');

    await runOf(3);                       // a SECOND run, seconds later
    assert.strictEqual(rests.length, 1,
      'the 6th consecutive Gemini capture must rest even though a new run started');

    delete process.env.AIV_GEMINI_BURST_REST_MS;
    delete require.cache[require.resolve('../captureScheduler')];
  });

  await test('ChatGPT is not capped — 15 consecutive showed no degradation', async () => {
    const sched2 = require('../captureScheduler');
    const rests = [];
    await sched2.measureSet({
      prompts: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, text: `q${i}` })),
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: async () => ({ status: 'captured' }),
      onRest: (info) => rests.push(info),
    });
    assert.strictEqual(rests.length, 0,
      'a cap "to be safe" would halve throughput for a problem that was looked for and not found');
  });

  await test('one engine resting does not stall the other', async () => {
    process.env.AIV_GEMINI_BURST_REST_MS = '120';
    delete require.cache[require.resolve('../captureScheduler')];
    const fresh = require('../captureScheduler');

    const done = [];
    await fresh.measureSet({
      prompts: Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, text: `q${i}` })),
      surfaces: [
        { id: 'gemini:scraped', engine: 'gemini' },
        { id: 'chatgpt:scraped', engine: 'chatgpt' },
      ],
      measure: async ({ surfaceId }) => { await wait(5); done.push(surfaceId); return { status: 'captured' }; },
    });

    // ChatGPT must finish all 7 before Gemini does, because Gemini paused.
    const lastChatgpt = done.lastIndexOf('chatgpt:scraped');
    const lastGemini = done.lastIndexOf('gemini:scraped');
    assert.ok(lastChatgpt < lastGemini,
      'the rest is taken inside the engine lane, so it must not hold up other engines');

    delete process.env.AIV_GEMINI_BURST_REST_MS;
    delete require.cache[require.resolve('../captureScheduler')];
  });

  section('shouldStop — the budget ceiling lands here');

  await test('a stop is checked BEFORE each capture, so nothing more is spent', async () => {
    const t = tracker({ delay: 5 });
    let seen = 0;
    const { rows, stopped } = await sched.measureSet({
      prompts: PROMPTS,
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: t.measure,
      shouldStop: async () => {
        seen += 1;
        return seen > 2 ? 'budget exhausted' : null;
      },
    });
    assert.strictEqual(stopped, 'budget exhausted');
    assert.strictEqual(rows.length, 2, 'the capture that would have crossed the line was not made');
  });

  await test('no shouldStop means no stopping', async () => {
    const t = tracker({ delay: 2 });
    const { stopped } = await sched.measureSet({
      prompts: PROMPTS,
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: t.measure,
    });
    assert.strictEqual(stopped, null);
  });

  section('onCapture streams rows as they land');

  await test('every row is handed over as it completes, not in one batch at the end', async () => {
    const t = tracker({ delay: 5 });
    const streamed = [];
    const { rows } = await sched.measureSet({
      prompts: PROMPTS,
      surfaces: [{ id: 'chatgpt:scraped', engine: 'chatgpt' }],
      measure: t.measure,
      onCapture: async (row) => { streamed.push(row.promptId); },
    });
    assert.deepStrictEqual(streamed, ['p1', 'p2', 'p3']);
    assert.strictEqual(rows.length, streamed.length);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
