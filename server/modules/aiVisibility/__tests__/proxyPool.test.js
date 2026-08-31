// ── proxyPool ─────────────────────────────────────────────────────────────
//
// The rule the whole file is built around, and the one most worth pinning:
//
//   If no proxy in the required country is available, the capture FAILS.
//   It never falls back to another country, and never to a direct connection.
//
// Phase 0 measured that Google's block was a LOCALE MISMATCH, not
// fingerprinting — so a proxy that exits in the wrong country does not fail
// loudly, it succeeds and returns a differently-localised answer that we then
// record as a US measurement. Nothing downstream can detect that.
//
// Run: node modules/aiVisibility/__tests__/proxyPool.test.js

const assert = require('assert');
const { ProxyPool, parseProxy, parseList } = require('../captureEngines/proxyPool');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const US = (n) => ({ id: `us${n}`, url: `http://us${n}:8000`, country: 'us' });
const DE = (n) => ({ id: `de${n}`, url: `http://de${n}:8000`, country: 'de' });

section('parsing — both formats every provider hands out');

test('URL form, with credentials', () => {
  const p = parseProxy('http://user:pa%40ss@gate.example.com:7000#US');
  assert.strictEqual(p.url, 'http://gate.example.com:7000');
  assert.strictEqual(p.username, 'user');
  assert.strictEqual(p.password, 'pa@ss', 'percent-encoding must survive');
  assert.strictEqual(p.country, 'us');
});

test('host:port:user:pass list form', () => {
  const p = parseProxy('1.2.3.4:8080:bob:secret#de');
  assert.strictEqual(p.url, 'http://1.2.3.4:8080');
  assert.strictEqual(p.username, 'bob');
  assert.strictEqual(p.country, 'de');
});

test('an untagged proxy parses but carries no country', () => {
  assert.strictEqual(parseProxy('1.2.3.4:8080').country, null);
});

test('junk is dropped rather than throwing', () => {
  assert.strictEqual(parseProxy('nonsense'), null);
  assert.strictEqual(parseProxy(''), null);
  assert.strictEqual(parseList('good:8080\nnonsense\n1.2.3.4:9090').length, 2);
});

section('geo pinning — the rule that protects the data');

test('a US request never leases a German proxy', () => {
  const pool = new ProxyPool([DE(1), DE(2)]);
  const { proxy, reason } = pool.lease({ engine: 'google_ai_overview', country: 'us' });
  assert.strictEqual(proxy, null,
    'a German exit would return a German answer recorded as a US measurement');
  assert.strictEqual(reason, 'no_proxy_for_country_us');
});

test('an UNTAGGED proxy is not eligible for geo-pinned work', () => {
  const pool = new ProxyPool([{ id: 'x', url: 'http://x:8000', country: null }]);
  assert.strictEqual(pool.lease({ engine: 'google_ai_overview', country: 'us' }).proxy, null,
    'unprovable location is not the same as the right location');
});

test('but an untagged proxy is fine when no country is required', () => {
  const pool = new ProxyPool([{ id: 'x', url: 'http://x:8000', country: null }]);
  assert.ok(pool.lease({ engine: 'chatgpt' }).proxy);
});

test('an empty pool refuses rather than implying a direct connection', () => {
  const { proxy, reason } = new ProxyPool([]).lease({ engine: 'chatgpt' });
  assert.strictEqual(proxy, null);
  assert.strictEqual(reason, 'no_proxies_configured');
});

section('cooldown — Google is rate-limited per address');

test('a leased proxy is not handed out again until it has rested', () => {
  const pool = new ProxyPool([US(1)]);
  const t = 1_000_000;
  assert.ok(pool.lease({ engine: 'google_ai_overview', country: 'us', now: t }).proxy);
  const second = pool.lease({ engine: 'google_ai_overview', country: 'us', now: t + 1000 });
  assert.strictEqual(second.proxy, null);
  assert.strictEqual(second.reason, 'all_proxies_cooling');
  assert.ok(second.retryInMs > 0, 'the caller is told how long to wait, not just refused');
});

test('it becomes available again once the cooldown passes', () => {
  const pool = new ProxyPool([US(1)]);
  const t = 1_000_000;
  pool.lease({ engine: 'google_ai_overview', country: 'us', now: t });
  assert.ok(pool.lease({ engine: 'google_ai_overview', country: 'us', now: t + 120_000 }).proxy);
});

test('Google rests longer than the chat engines', () => {
  const { COOLDOWN_MS } = require('../captureEngines/proxyPool');
  assert.ok(COOLDOWN_MS.google_ai_overview > COOLDOWN_MS.chatgpt);
});

section('rotation — load spreads instead of burning the head of the list');

test('least recently used is chosen, so use is even', () => {
  const pool = new ProxyPool([US(1), US(2), US(3)]);
  const t = 1_000_000;
  const first = [];
  for (let i = 0; i < 3; i += 1) {
    first.push(pool.lease({ engine: 'chatgpt', country: 'us', now: t + i }).proxy.id);
  }
  assert.strictEqual(new Set(first).size, 3, 'all three were used before any repeat');
});

section('sticky sessions — an IP must not change mid-conversation');

test('the same session key keeps the same exit IP', () => {
  const pool = new ProxyPool([US(1), US(2), US(3)]);
  const t = 1_000_000;
  const a = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's1', now: t }).proxy;
  const b = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's1', now: t + 60_000 }).proxy;
  assert.strictEqual(a.id, b.id, 'a changing IP looks like a hijack and ends the session');
});

test('different sessions get different proxies', () => {
  const pool = new ProxyPool([US(1), US(2)]);
  const t = 1_000_000;
  const a = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's1', now: t }).proxy;
  const b = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's2', now: t + 1 }).proxy;
  assert.notStrictEqual(a.id, b.id);
});

section('health — a wall burns the address immediately');

test('a blocked proxy is burned, not merely counted against', () => {
  const pool = new ProxyPool([US(1), US(2)]);
  const t = 1_000_000;
  const p = pool.lease({ engine: 'google_ai_overview', country: 'us', now: t }).proxy;
  pool.release(p, { blocked: true, now: t });
  const stats = pool.stats(t);
  assert.strictEqual(stats.burned, 1, 'one more request confirms nothing and deepens the block');
});

test('a burned proxy is dropped from its sticky sessions', () => {
  const pool = new ProxyPool([US(1), US(2)]);
  const t = 1_000_000;
  const p = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's1', now: t }).proxy;
  pool.release(p, { blocked: true, now: t });
  const next = pool.lease({ engine: 'chatgpt', country: 'us', sessionKey: 's1', now: t + 60_000 }).proxy;
  assert.notStrictEqual(next.id, p.id, 'the session must not be pinned to a dead address');
});

test('one failure is noise; three in a row is the address', () => {
  const pool = new ProxyPool([US(1)]);
  const t = 1_000_000;
  const p = pool.proxies[0];
  pool.release(p, { ok: false, now: t });
  assert.strictEqual(pool.stats(t).burned, 0, 'a single timeout must not eject a good proxy');
  pool.release(p, { ok: false, now: t });
  pool.release(p, { ok: false, now: t });
  assert.strictEqual(pool.stats(t).burned, 1);
});

test('a success clears the failure streak', () => {
  const pool = new ProxyPool([US(1)]);
  const t = 1_000_000;
  const p = pool.proxies[0];
  pool.release(p, { ok: false, now: t });
  pool.release(p, { ok: false, now: t });
  pool.release(p, { ok: true, now: t });
  pool.release(p, { ok: false, now: t });
  assert.strictEqual(pool.stats(t).burned, 0, 'failures must be consecutive to mean anything');
});

test('when every proxy is burned the reason says so', () => {
  const pool = new ProxyPool([US(1)]);
  const t = 1_000_000;
  pool.release(pool.proxies[0], { blocked: true, now: t });
  assert.strictEqual(pool.lease({ engine: 'chatgpt', country: 'us', now: t }).reason, 'all_proxies_burned');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
