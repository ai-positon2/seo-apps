// ── Capture concurrency ─────────────────────────────────────────────────────
//
// The binding constraint on this module is wall clock, not cost. Ten clients at
// ~56 prompts is ~2,800 captures a day, and `run.js` measures prompt × surface
// serially at 25–110s each — 19 to 85 hours. It does not fit in a day.
//
// The shape that does fit, and why each part of it is the way it is:
//
//   SERIAL within an engine. Google's tolerance is per-request-rate from one
//   address (Phase 0 measured this: a second search within the cooldown is
//   refused outright, and a homepage warm-up made it WORSE by spending the
//   allowance before the request that mattered). Two parallel ChatGPT captures
//   from one exit IP is the fastest way to get the IP blocked, and a blocked IP
//   produces `failed` captures, which produce nothing at all.
//
//   PARALLEL across engines. ChatGPT, Gemini and the two Google surfaces are
//   independent services with independent rate limits. Four lanes running at
//   once is a 4× speed-up that costs nothing in block risk.
//
//   PARALLEL across clients, but under ONE global browser cap. Each headless
//   Chrome is 150–300MB; without a ceiling, ten clients × four engines is forty
//   browsers and the worker dies of memory rather than of rate limiting.
//
// So: a gate per engine (width 1) for politeness, and a global gate for memory.
// Both are the same counting semaphore CrawlScope uses.

const { createGate } = require('../crawlScope/shared/gate');

// How many headless Chrome pages may exist at once across every client and
// engine. Each is 150–300MB, so this is a memory ceiling before it is anything
// else. Four is one lane per engine on a single-client run.
// Read when used, not at require time.
//
// These were module-level consts, so changing one needed a process restart
// while surfaces/index.js's disabledSet() re-read its own variable on every
// call — two config styles in one module, and the tests had to
// delete require.cache to work around this one.
const maxConcurrentBrowsers = () => Number(process.env.AIV_MAX_BROWSERS) || 4;

// Per-engine lanes. Width 1 is not arbitrary: it IS the politeness policy.
// Raising it for a scraped surface trades a modest speed-up for the risk of
// losing the surface entirely.
const ENGINE_LANE_WIDTH = {
  chatgpt: 1,
  gemini: 1,
  google_ai_overview: 1,
  google_ai_mode: 1,
};

// How many captures an engine will take back-to-back before resting, and how
// long it rests.
//
// MEASURED, not guessed. A 15-prompt ramp against Gemini returned six
// consecutive empty answers starting at capture 6, then recovered at 12 —
// normal response times throughout, no error, just a blank reply. Five is one
// below where it started refusing.
//
// The rest length comes from the same run: recovery took roughly the elapsed
// time of those six refused captures, about two minutes.
//
// ChatGPT showed no degradation across 15 consecutive captures and gets no
// cap. Adding one "to be safe" would halve throughput to solve a problem that
// was looked for and not found.
const ENGINE_BURST_LIMIT = {
  gemini: Number(process.env.AIV_GEMINI_BURST) || 5,
};

const ENGINE_BURST_REST_MS = {
  gemini: Number(process.env.AIV_GEMINI_BURST_REST_MS) || 120_000,
};

// Built on first use so the env read above actually takes effect. A gate
// created at require time would freeze the limit before dotenv has run.
let _globalGate = null;
const globalGate = (fn) => {
  if (!_globalGate) _globalGate = createGate(maxConcurrentBrowsers());
  return _globalGate(fn);
};
const engineGates = new Map();

// Consecutive captures taken on each engine since its last rest.
const burstCount = new Map();

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Rest an engine that has taken its burst allowance.
 *
 * Called BEFORE the capture, so the pause happens instead of the capture that
 * would have been refused — resting after the failure would have already spent
 * the request and recorded a row that says nothing.
 *
 * @param {Function} [onRest] told about the pause, so a run can report it
 *   rather than looking hung
 */
async function restIfBursted(engine, onRest) {
  const limit = ENGINE_BURST_LIMIT[engine];
  if (!limit) return;

  const taken = burstCount.get(engine) || 0;
  if (taken < limit) return;

  const restMs = ENGINE_BURST_REST_MS[engine] ?? 60_000;
  burstCount.set(engine, 0);
  if (onRest) onRest({ engine, restMs, after: taken });
  await sleep(restMs);
}

/**
 * Reset burst state. FOR TESTS ONLY.
 *
 * This used to be called at the top of every measureSet, which defeated the
 * rest entirely: a run starting seconds after the previous one finished its
 * fifth Gemini capture believed Gemini had taken zero and went straight back
 * in with no pause. Five runs in three hours therefore never rested once.
 *
 * The counter is deliberately module-level and process-lived, because the
 * thing being rate-limited is the ENGINE seen from this machine, and it has no
 * idea where one of our runs ends and the next begins.
 */
function resetBursts() {
  burstCount.clear();
}

function engineGate(engine) {
  if (!engineGates.has(engine)) {
    engineGates.set(engine, createGate(ENGINE_LANE_WIDTH[engine] ?? 1));
  }
  return engineGates.get(engine);
}

/**
 * Run one capture under both gates.
 *
 * Engine gate OUTSIDE, browser gate inside. The order matters: taking the
 * scarce global browser slot first and then waiting behind an engine lane would
 * hold a browser slot while doing nothing, and with four lanes contending that
 * deadlocks the pool. Queue for your lane first, then take a browser.
 */
async function withCaptureSlot(engine, fn, { onRest = null } = {}) {
  return engineGate(engine)(async () => {
    // Inside the engine lane, so the rest blocks only this engine. Holding it
    // outside would pause every engine for one engine's limit.
    await restIfBursted(engine, onRest);
    burstCount.set(engine, (burstCount.get(engine) || 0) + 1);
    return globalGate(fn);
  });
}

/**
 * Measure a whole prompt set, parallel across engines and serial within each.
 *
 * @param {object} input
 * @param {Array} input.prompts   [{id, text, location}]
 * @param {Array} input.surfaces  [{id, engine}]
 * @param {Function} input.measure async ({surfaceId, prompt, promptId}) => captureRow
 * @param {Function} [input.onCapture] called with each row as it lands
 * @param {Function} [input.shouldStop] async () => reason|null, checked between
 *   captures — this is where the budget ceiling and a cancellation both land
 * @returns {Promise<{rows, stopped}>}
 */
async function measureSet({
  prompts, surfaces, measure, onCapture = null, shouldStop = null, onRest = null,
  deadlineMs = null,
}) {
  // A wall clock for the whole set.
  //
  // One ChatGPT capture can now cost nav + echo + resend + settle, twice over
  // if it retries — roughly seven minutes for a single prompt. Twenty prompts
  // of those would run far past the 45-minute allowance moduleEvidence gives
  // this module, and the reaper would kill the run after it had spent the
  // money. Stopping ourselves reports coverage honestly instead.
  const deadline = Number.isFinite(deadlineMs) ? Date.now() + deadlineMs : null;
  const rows = [];
  let stopped = null;
  // Deliberately NOT resetting the burst counters here. Run boundaries are our
  // concept, not the engine's; carrying the count across runs is what makes
  // back-to-back runs rest instead of sprinting.

  // One lane per surface. Within a lane the prompts are strictly sequential;
  // the lanes themselves race.
  const lanes = surfaces.map(async (surface) => {
    for (const prompt of prompts) {
      if (stopped) return;

      if (deadline && Date.now() >= deadline) {
        stopped = stopped || 'This run reached its time limit. The remaining prompts were '
          + 'not measured, so coverage reflects what was actually asked.';
        return;
      }

      if (shouldStop) {
        // Checked BEFORE the capture, never after: the point of a ceiling is to
        // not spend the money, and a check after the fact has already spent it.
        const reason = await shouldStop();
        if (reason) { stopped = reason; return; }
      }

      let row;
      try {
        row = await withCaptureSlot(
          surface.engine,
          () => measure({ surfaceId: surface.id, prompt: prompt.text, promptId: prompt.id }),
          { onRest },
        );
      } catch (e) {
        // A thrown capture is a FAILED capture, never a missing one. §16.11:
        // `mentioned` stays null so nothing downstream reads this as the brand
        // being absent from an answer nobody managed to read.
        row = {
          promptId: prompt.id,
          prompt: prompt.text,
          surfaceId: surface.id,
          engine: surface.engine,
          // Without this the row falls to the column default 'scraped', so a
          // vendor-API capture that threw would be filed as self-hosted.
          access: surface.access || null,
          status: 'failed',
          failureReason: e.message,
          mentioned: null,
          cited: null,
          prominence: null,
        };
      }

      const stamped = { ...row, promptId: prompt.id };
      rows.push(stamped);
      if (onCapture) await onCapture(stamped);
    }
  });

  await Promise.all(lanes);
  return { rows, stopped };
}

/** Observability for the operator view — what the gates are doing right now. */
function laneConfig() {
  return {
    maxBrowsers: maxConcurrentBrowsers(),
    engines: { ...ENGINE_LANE_WIDTH },
  };
}

module.exports = {
  maxConcurrentBrowsers,
  ENGINE_LANE_WIDTH,
  ENGINE_BURST_LIMIT,
  ENGINE_BURST_REST_MS,
  restIfBursted,
  resetBursts,
  withCaptureSlot,
  measureSet,
  laneConfig,
};
