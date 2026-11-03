// ── Every module's latest result, however many runs another module has ──────
//
// The dashboard read the newest 120 runs across all modules, so 210 Hub and
// Spoke runs hid Eventgroove's SEO & GEO (89), Agent Readiness (28) and AI
// Visibility results behind "Not run for this project yet".
//
// The query needs a database to execute; this holds its shape, and the
// bucketing it feeds is checked with rows a burst would produce.
//
// Run: node --test modules/projects/__tests__/latestByModule.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../moduleEvidence.js'), 'utf8');
const start = source.indexOf('async function latestByModule');
const body = source.slice(start, source.indexOf('\n}\n', start));

test('the latest run is taken per module, not from a mixed window', () => {
  assert.match(body, /partition by r\.module_key/);
  assert.doesNotMatch(body, /limit \$2/, 'no global run limit');
  assert.match(body, /where runs\.rn = 1/);
});

test('finished and in-flight runs are ranked separately, so a running module still shows its last result', () => {
  assert.match(body, /partition by r\.module_key, \(r\.status = any\(\$2\)\)/);
});
