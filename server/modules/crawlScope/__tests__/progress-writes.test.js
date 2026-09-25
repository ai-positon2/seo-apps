// A running crawl's frequent writes must never pile up on the connection pool.
//
// Progress was written every second, unawaited, with `returning *`. On a large
// crawl the row carries a multi-megabyte checkpoint, so each write outlasted the
// interval; the next queued behind it on the row lock, and one crawl held all ten
// pooled connections until every other query in the process timed out.
const test = require("node:test");
const assert = require("node:assert/strict");
const repo = require("../db/repo");
const { latestOnlyWriter } = require("../run/manager");

test("latestOnlyWriter keeps one write in flight and writes only the newest value after it", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const written = [];
  let release;
  const write = async (value) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    written.push(value);
    if (value === 1) await new Promise((resolve) => { release = resolve; });
    inFlight -= 1;
  };
  const push = latestOnlyWriter(write);

  push(1);            // starts, and hangs until released
  push(2);
  push(3);
  push(4);            // 2 and 3 are superseded while 1 is still in flight
  assert.equal(maxInFlight, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written, [1, 4]);
  assert.equal(maxInFlight, 1);
});

test("latestOnlyWriter survives a failed write and carries on", async () => {
  const written = [];
  const push = latestOnlyWriter(async (value) => {
    written.push(value);
    if (value === "a") throw new Error("connection timeout");
  });
  push("a");
  await new Promise((resolve) => setImmediate(resolve));
  push("b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["a", "b"]);
});

test("updateRun with returning: false does not ask for the row back", async () => {
  const sent = [];
  const client = {
    query: async (text, params) => { sent.push({ text, params }); return { rows: [] }; },
    maybeOne: async () => { throw new Error("must not read the row back"); },
  };
  const result = await repo.updateRun(client, "run-1", { progress: { crawled: 5 } }, { returning: false });
  assert.equal(result, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^update crawl_runs set .+ where id = \$2$/);
  assert.doesNotMatch(sent[0].text, /returning/i);
});
