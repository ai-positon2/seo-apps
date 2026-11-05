// ── The Admin page only claims what the app does ────────────────────────────
//
// Three ways the Admin page used to overstate the system, each pinned here:
//
//   • limits: twelve of the twenty policy keys had no reader anywhere, yet were
//     listed as "effective" and editable (adminLimits.ENFORCED_KEYS);
//   • flags: unified_project_workspace was shown "Off globally" with a switch
//     that did nothing, while the feature it named was live for everyone;
//   • capacity: a missing DATABASE_SIZE_LIMIT_MB fell back to a 512 MB cap from
//     a previous host and showed a permanent "Critical" (dbCapacity).
//
// Run: node services/__tests__/adminTruth.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../db');
const adminLimits = require('../adminLimits');
const featureFlags = require('../featureFlags');
const dbCapacity = require('../dbCapacity');

const SERVER_ROOT = path.join(__dirname, '..', '..');

// Every non-test .js file under server/, minus the files that only declare keys.
function sourceFiles(dir = SERVER_ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const DECLARING = new Set([
  path.join(SERVER_ROOT, 'services', 'adminLimits.js'),
  path.join(SERVER_ROOT, 'services', 'featureFlags.js'),
]);
const corpus = sourceFiles()
  .filter((f) => !DECLARING.has(f))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

test('every enforced limit is a known key and is read by some feature', () => {
  for (const key of adminLimits.ENFORCED_KEYS) {
    assert.ok(adminLimits.LIMIT_KEYS.includes(key), `${key} is not a limit key`);
    assert.ok(corpus.includes(key), `${key} is listed as enforced but nothing outside adminLimits.js reads it`);
  }
});

test('the spend and call caps are not claimed as enforced until a run stops on them', () => {
  for (const key of ['modelSpendPerRunUsd', 'modelCallsPerRun', 'providerCallsPerDay']) {
    assert.ok(!adminLimits.ENFORCED_KEYS.includes(key), `${key} must not be shown as an active limit`);
  }
});

test('every known feature flag is read somewhere other than where it is declared', () => {
  for (const key of Object.values(featureFlags.FLAGS)) {
    assert.ok(corpus.includes(key), `flag ${key} is declared but never read`);
  }
  assert.ok(!Object.values(featureFlags.FLAGS).includes('unified_project_workspace'));
});

test('a retired flag cannot be switched: a switch that does nothing must say so', async (t) => {
  t.mock.method(db, 'isDatabaseConfigured', () => true);
  await assert.rejects(
    featureFlags.setAssignment({ flagKey: 'unified_project_workspace', scope: 'global', enabled: true }),
    (e) => e.status === 400,
  );
});

test('database capacity: no configured limit means size only, never a verdict', () => {
  assert.equal(dbCapacity.limitBytesFrom(undefined), 0);
  assert.equal(dbCapacity.limitBytesFrom(''), 0);
  assert.equal(dbCapacity.limitBytesFrom('0'), 0);
  assert.equal(dbCapacity.limitBytesFrom('nonsense'), 0);
  assert.equal(dbCapacity.limitBytesFrom('20480'), 20480 * 1024 * 1024);
  if (!process.env.DATABASE_SIZE_LIMIT_MB) {
    assert.equal(dbCapacity.LIMIT_BYTES, 0, 'no stale 512 MB default');
    assert.equal(dbCapacity.levelFor(6.85), 'unknown');
  }
});
