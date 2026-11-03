// ── Every crawl is graded by today's catalog ────────────────────────────────
//
// Nike's crawl was analysed under an older rulebook and read 29; under today's
// it reads 66. A finding's stored severity is only a fallback now.
//
// Run: node --test modules/crawlScope/__tests__/currentSeverity.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { currentSeverity, regrade, SEVERITY_TABLE_JSON } = require('../currentSeverity');
const catalog = require('../issue-catalog.json');

test('the catalog severity overrides the stored one', () => {
  const rule = catalog.find((r) => r.severity === 'notice');
  assert.equal(currentSeverity(rule.id, 'error'), 'notice');
  assert.equal(regrade({ ruleId: rule.id, severity: 'error' }).severity, 'notice');
});

test('a rule the catalog no longer lists keeps its stored severity', () => {
  assert.equal(currentSeverity('retired-rule-xyz', 'warning'), 'warning');
});

test('the dashboard SQL reads the same table', () => {
  const table = JSON.parse(SEVERITY_TABLE_JSON);
  for (const rule of catalog) assert.equal(table[rule.id], rule.severity);
  const overview = fs.readFileSync(path.join(__dirname, '../../projects/overview.js'), 'utf8');
  assert.match(overview, /coalesce\(\(\$7::jsonb\)->>\(f\.data->>'ruleId'\), f\.data->>'severity'\)/);
});

test('the report and export readers regrade what they return', () => {
  const repo = fs.readFileSync(path.join(__dirname, '../db/repo.js'), 'utf8');
  assert.match(repo, /all\.push\(regrade\(finding\)\)/);
  assert.match(repo, /rows\.map\(\(r\) => regrade\(r\.data\)\)/);
});
