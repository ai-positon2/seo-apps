import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followRun, startRun, getRunIdFromUrl, setRunIdInUrl } from '../jobs.js';

class FakeEventSource {
  static last;
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.last = this;
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() { this.closed = true; }
  dispatch(name, data) {
    const event = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners[name] || []) fn(event);
  }
}

test('followRun routes named events, ignores reconnect errors, and closes on a terminal status', () => {
  const seen = [];
  followRun('r 1', {
    step: (d) => seen.push(['step', d]),
    result: (d) => seen.push(['result', d]),
    error: (d) => seen.push(['error', d]),
    status: (d) => seen.push(['status', d]),
  }, { EventSourceImpl: FakeEventSource });
  const es = FakeEventSource.last;
  assert.equal(es.url, '/api/runs/r%201/events');
  assert.equal(es.opts.withCredentials, true);

  es.dispatch('step', { id: 'fetch' });
  es.dispatch('error'); // a dropped connection: no data
  es.dispatch('status', { status: 'running' });
  assert.equal(es.closed, false);
  es.dispatch('result', { score: 1 });
  es.dispatch('error', { error: 'Page too short.', code: 'invalid_request' });
  es.dispatch('status', { status: 'failed', code: 'invalid_request' });
  assert.equal(es.closed, true);
  es.dispatch('step', { id: 'late' });

  assert.deepEqual(seen, [
    ['step', { id: 'fetch' }],
    ['status', { status: 'running' }],
    ['result', { score: 1 }],
    ['error', { error: 'Page too short.', code: 'invalid_request' }],
    ['status', { status: 'failed', code: 'invalid_request' }],
  ]);
});

test('stop() closes the stream and silences handlers', () => {
  const seen = [];
  const stop = followRun('r2', { step: (d) => seen.push(d) }, { EventSourceImpl: FakeEventSource });
  const es = FakeEventSource.last;
  stop();
  es.dispatch('step', { n: 1 });
  assert.equal(es.closed, true);
  assert.deepEqual(seen, []);
});

test('startRun posts JSON and resolves the run', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 202, text: async () => JSON.stringify({ run: { id: 'abc', status: 'running' } }) };
  };
  const run = await startRun('/api/keyword-research/runs', { keyword: 'dentist' });
  assert.deepEqual(run, { id: 'abc', status: 'running' });
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.body, '{"keyword":"dentist"}');
});

test('the run id round-trips through the URL without touching other params', () => {
  const location = { href: 'https://app.test/tools/ke?tab=2#top' };
  const calls = [];
  const history = { state: { a: 1 }, replaceState: (s, t, u) => { calls.push(u); location.href = `https://app.test${u}`; } };
  setRunIdInUrl('abc', { location, history });
  assert.equal(calls[0], '/tools/ke?tab=2&run=abc#top');
  assert.equal(getRunIdFromUrl(location), 'abc');
  setRunIdInUrl(null, { location, history });
  assert.equal(getRunIdFromUrl(location), null);
  assert.equal(calls[1], '/tools/ke?tab=2#top');
});
