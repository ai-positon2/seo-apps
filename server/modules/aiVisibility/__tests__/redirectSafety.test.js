// ── resolveRedirects ───────────────────────────────────────────────────────
//
// A citation's redirect target is chosen by whoever controls the page being
// cited, and this module follows it. Without a guard that is a way to steer
// this server at its own network — cloud metadata at 169.254.169.254 being the
// usual first stop.
//
// The hostname check is a first cut, not a complete defence: DNS can still map
// a public name onto a private address. It stops the direct forms, and the
// tests below pin which ones.
//
// Run: node modules/aiVisibility/__tests__/redirectSafety.test.js

const assert = require('assert');
const { isPrivateAddress, isGoogleRedirect } = require('../resolveRedirects');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

section('a redirect must not reach our own network');

const PRIVATE = [
  ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['loopback by name', 'http://localhost:5000/api/health'],
  ['loopback by address', 'http://127.0.0.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['RFC1918 /8', 'http://10.1.2.3/x'],
  ['RFC1918 /16', 'http://192.168.0.10/x'],
  ['RFC1918 /12 low', 'http://172.16.0.1/'],
  ['RFC1918 /12 high', 'http://172.31.255.254/'],
  ['carrier-grade NAT', 'http://100.64.0.1/'],
  ['this-network', 'http://0.0.0.0/'],
  ['.internal suffix', 'http://db.internal/'],
];
for (const [label, url] of PRIVATE) {
  test(`blocked — ${label}`, () => {
    assert.strictEqual(isPrivateAddress(url), true, `${url} must not be followed`);
  });
}

const PUBLIC = [
  ['a real source', 'https://www.mayoclinic.org/diseases'],
  ['just outside /12', 'http://172.32.0.1/'],
  ['just outside /12 low', 'http://172.15.255.255/'],
  ['a public 100.x', 'http://100.128.0.1/'],
  ['a normal host', 'https://ada.org/root-canal'],
];
for (const [label, url] of PUBLIC) {
  test(`allowed — ${label}`, () => {
    assert.strictEqual(isPrivateAddress(url), false, `${url} is a legitimate destination`);
  });
}

test('an unparseable URL is treated as unsafe, not as safe', () => {
  // Failing open here would defeat the whole guard.
  assert.strictEqual(isPrivateAddress('not a url'), true);
  assert.strictEqual(isPrivateAddress(''), true);
  assert.strictEqual(isPrivateAddress(null), true);
});

test('an octet above 255 is not treated as a public address', () => {
  assert.strictEqual(isPrivateAddress('http://999.1.1.1/'), true);
});

section('the redirector itself is still recognised');

test('a Google /goto link is a redirector, a normal Google URL is not', () => {
  assert.strictEqual(isGoogleRedirect('https://www.google.com/goto?u=x'), true);
  assert.strictEqual(isGoogleRedirect('https://www.google.com/search?q=x'), false);
  assert.strictEqual(isGoogleRedirect('https://ada.org/goto'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
