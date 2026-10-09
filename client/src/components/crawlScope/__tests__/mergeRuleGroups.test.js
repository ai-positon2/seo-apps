// A template-scoped finding reaches both issueGroups() (via each page's
// .issues) and siteScopedGroups() (via the findings), so the issue list showed
// the same rule twice and the severity tabs left stale rows behind.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { issueGroups, siteScopedGroups, mergeRuleGroups } from '../crawlHelpers.js';

const finding = (ruleId, url, scope, severity = 'notice') => ({
  ruleId, url, scope, severity, title: ruleId,
});

test('a template-scoped rule seen by both group builders is listed once', () => {
  const findings = [
    finding('link-no-name', 'https://a.com/1', 'template'),
    finding('link-no-name', 'https://a.com/2', 'template'),
    finding('missing-title', 'https://a.com/1', 'page', 'error'),
  ];
  const pages = ['https://a.com/1', 'https://a.com/2'].map((url) => ({
    url,
    issues: findings.filter((f) => f.url === url)
      .map((f) => ({ id: f.ruleId, label: f.title, severity: f.severity })),
  }));

  const merged = mergeRuleGroups([...issueGroups(pages, findings), ...siteScopedGroups(findings)]);

  assert.deepStrictEqual(merged.map((g) => g.id).sort(), ['link-no-name', 'missing-title']);
  const rule = merged.find((g) => g.id === 'link-no-name');
  assert.strictEqual(rule.urls.length, 2);
  assert.strictEqual(rule.scope, 'template');
});

test('a rule split across page and template scope keeps every occurrence', () => {
  const merged = mergeRuleGroups([
    { id: 'broken-link', severity: 'error', urls: ['/a', '/a', '/b'] },
    { id: 'broken-link', severity: 'error', scope: 'template', urls: ['/a', '/c'] },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual([...merged[0].urls].sort(), ['/a', '/a', '/b', '/c']);
});
