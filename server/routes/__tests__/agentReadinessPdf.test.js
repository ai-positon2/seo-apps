// POST /api/agent-readiness-audit/pdf renders the posted audit in headless
// Chrome. Every field of that body is caller-supplied, so a field that reaches
// the HTML unescaped lets the caller put an <iframe> pointing at an internal
// address into a page the server itself loads and prints.

const test = require('node:test');
const assert = require('node:assert');
const { buildPdfHtml } = require('../agentReadinessAudit')._private;

const PAYLOAD = '<iframe src="http://169.254.169.254/latest/meta-data/"></iframe>';

function audit(check) {
  return {
    site: { url: 'https://example.com', level: 'Basic', date: '2026-10-01', score: 40 },
    cats: [],
    checks: [check],
    onPageChecks: [],
  };
}

test('a roadmap row escapes the check label', () => {
  const html = buildPdfHtml(audit({ id: 'robots', status: 'fail', label: PAYLOAD, cat: 'Bots' }));
  assert.strictEqual(html.includes('<iframe'), false);
  assert.ok(html.includes('&lt;iframe'));
});

test('a roadmap row escapes the check category', () => {
  const html = buildPdfHtml(audit({ id: 'robots', status: 'fail', label: 'Robots', cat: PAYLOAD }));
  assert.strictEqual(html.includes('<iframe'), false);
});
