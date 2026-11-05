// ── Reads that stop when their request goes away (UX-054) ───────────────────
//
// db.signalOnClose turns a response's early 'close' into an AbortSignal, and
// db.boundedRead takes one to cancel a read only that request was waiting on.
// Offline: nothing here opens a connection (an aborted signal is refused
// before one is taken).
//
// Run: node --test services/__tests__/boundedRead.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const db = require('../db');

function fakeResponse() {
  const res = new EventEmitter();
  res.writableEnded = false;
  return res;
}

test('a response closed before it was sent aborts its signal', () => {
  const res = fakeResponse();
  const signal = db.signalOnClose(res);
  assert.equal(signal.aborted, false);
  res.emit('close');
  assert.equal(signal.aborted, true);
});

test('a response that finished normally never aborts anything', () => {
  const res = fakeResponse();
  const signal = db.signalOnClose(res);
  res.writableEnded = true;
  res.emit('close');
  assert.equal(signal.aborted, false);
});

test('a read whose request is already gone is refused without taking a connection', async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  await assert.rejects(
    db.boundedRead(1000, async () => { ran = true; }, { signal: controller.signal }),
    (err) => db.isAborted(err) && !db.isStatementTimeout(err),
  );
  assert.equal(ran, false);
});

test('isAborted recognises only the abort error', () => {
  assert.equal(db.isAborted({ code: 'ABORT_ERR' }), true);
  assert.equal(db.isAborted({ code: '57014' }), false);
  assert.equal(db.isAborted(null), false);
});

test('an abort that fires while waiting for a pool connection is honoured before BEGIN', async () => {
  // No real connection: the pool's connect is stubbed, and the abort fires
  // while it is pending (after boundedRead's first check, before its listener).
  const { Pool } = require('pg');
  const realConnect = Pool.prototype.connect;
  const realUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/offline';
  const controller = new AbortController();
  const queries = [];
  let released = null;
  const client = {
    processID: 1,
    query: async (sql) => { queries.push(sql); return { rows: [] }; },
    release: (destroy) => { released = destroy === true ? 'destroyed' : 'returned'; },
  };
  Pool.prototype.connect = async function connect() {
    controller.abort();
    return client;
  };
  let ran = false;
  try {
    await assert.rejects(
      db.boundedRead(1000, async () => { ran = true; }, { signal: controller.signal }),
      (err) => db.isAborted(err),
    );
  } finally {
    Pool.prototype.connect = realConnect;
    if (realUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = realUrl;
    await db.end().catch(() => {});
  }
  assert.equal(ran, false);
  assert.deepEqual(queries, []);
  assert.equal(released, 'returned');
});
