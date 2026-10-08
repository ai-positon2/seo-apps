// ── Form labels name their fields ───────────────────────────────────────────
//
// Run: npm test --prefix client
//
// These labels were bare <label> elements beside their input, so a screen
// reader announced an unnamed text box and clicking the label did not focus
// it (found by a browser test: input.labels was empty on all three). Each
// label must point at its field with htmlFor, and the field must carry that id.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const FIELDS = [
  ['../keywordResearch/KrInputBar.jsx', 'Seed Keyword'],
  ['../../pages/ArticleRecommendationPage.jsx', 'Primary Keyword'],
  ['../../pages/ImageAltAuditPage.jsx', 'Page URLs'],
];

for (const [file, text] of FIELDS) {
  test(`"${text}" label is tied to its field (${file.split('/').pop()})`, () => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const at = src.search(new RegExp(`>\\s*${text}\\s*</label>`));
    assert.ok(at > 0, `label "${text}" not found`);
    const open = src.lastIndexOf('<label', at);
    const m = src.slice(open, at).match(/htmlFor="([^"]+)"/);
    assert.ok(m, `<label> for "${text}" has no htmlFor`);
    const field = src.slice(at, at + 1500).match(/<(input|textarea)\b[^>]*?\bid="([^"]+)"/s);
    assert.ok(field, `no id on the field after "${text}"`);
    assert.strictEqual(field[2], m[1]);
  });
}
