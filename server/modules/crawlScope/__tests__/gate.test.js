const test = require("node:test");
const assert = require("node:assert/strict");
const { createGate } = require("../shared/gate");

test("a gate of 1 serializes overlapping work", async () => {
  const withGate = createGate(1);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 5 }, () =>
      withGate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ),
  );

  assert.equal(peak, 1);
  assert.equal(active, 0);
});

test("a gate of N admits exactly N at a time and completes everything", async () => {
  const withGate = createGate(3);
  let active = 0;
  let peak = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: 12 }, () =>
      withGate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        done += 1;
      }),
    ),
  );

  assert.equal(peak, 3);
  assert.equal(done, 12);
});

test("a thrown task releases its slot and propagates", async () => {
  // If a failed workbook build leaked its slot, the gate would deadlock and every later
  // report would hang forever.
  const withGate = createGate(1);
  await assert.rejects(
    withGate(async () => {
      throw new Error("build failed");
    }),
    /build failed/,
  );

  let ran = false;
  await withGate(async () => {
    ran = true;
  });
  assert.ok(ran, "the gate is still usable after a failure");
});

test("the gate returns the task's value", async () => {
  const withGate = createGate(1);
  assert.equal(await withGate(async () => "workbook"), "workbook");
});

test("a non-positive limit is treated as 1 rather than deadlocking", async () => {
  for (const limit of [0, -3, undefined, NaN]) {
    const withGate = createGate(limit);
    assert.equal(await withGate(async () => "ok"), "ok", `limit ${limit} must still run`);
  }
});
