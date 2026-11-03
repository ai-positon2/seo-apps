// ── One set of bands on every screen ────────────────────────────────────────
//
// Cabinet's SEO & GEO 76 was green "Good" in its report and amber "Needs
// attention" on the dashboard; Acalvio's Hub & Spoke 51 was amber in Content
// Architect and red on the dashboard.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scoreTone, scoreVerdict } from '../scoreVerdict.js';

test('every score switches at 80 and 60', () => {
  assert.strictEqual(scoreTone(80), 'success');
  assert.strictEqual(scoreTone(79), 'warning');
  assert.strictEqual(scoreTone(60), 'warning');
  assert.strictEqual(scoreTone(59), 'danger');
  assert.strictEqual(scoreTone(null), null);
  assert.strictEqual(scoreVerdict(76).label, 'Needs attention');
});

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the module screens read the shared bands instead of their own thresholds', () => {
  for (const [file, uses] of [
    ['../../components/contentArchitect/HubSpokeReport.jsx', 'scoreTone(score)'],
    ['../../components/seoGeo/report/reportKit.jsx', 'scoreBandColor(score)'],
    ['../../components/seoGeo/primitives.jsx', 'scoreTone(score)'],
    ['../../pages/AgentReadinessAuditPage.jsx', 'scoreTone(score)'],
    ['../../ui/ScoreRing.jsx', 'scoreTone(score)'],
  ]) {
    assert.ok(read(file).includes(uses), `${file} uses ${uses}`);
  }
});
