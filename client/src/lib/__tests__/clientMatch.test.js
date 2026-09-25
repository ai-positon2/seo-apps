// ── Header project → a tool's own client list ───────────────────────────────
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { slugify, hostKey, matchClientSlug } from '../clientMatch.js';

const KB_BRANDS = ['gentle-dental', 'great-lakes', 'riccobene', 'clear-behavioral-health', 'neuro-wellness-spa', 'new-life-house'];

test('names and hosts slugify the way the Knowledge Base names its brands', () => {
  assert.strictEqual(slugify('Gentle Dental'), 'gentle-dental');
  assert.strictEqual(slugify('https://www.gentledental.com/'), 'gentledental');
  assert.strictEqual(slugify('Clear Behavioral Health'), 'clear-behavioral-health');
  assert.strictEqual(hostKey('https://www.Brushandfloss.com/about'), 'brushandfloss.com');
});

test('the header project finds its brand by name, exactly or by prefix', () => {
  assert.strictEqual(matchClientSlug({ name: 'Riccobene' }, KB_BRANDS), 'riccobene');
  assert.strictEqual(matchClientSlug({ name: 'Riccobene Associates Family Dentistry' }, KB_BRANDS), 'riccobene');
  assert.strictEqual(matchClientSlug({ name: 'Gentle Dental' }, KB_BRANDS), 'gentle-dental');
});

test('the domain is the fallback when the name does not match', () => {
  assert.strictEqual(matchClientSlug({ name: 'GD', primaryDomain: { host: 'gentledental.com' } }, KB_BRANDS), 'gentle-dental');
});

test('no match is null, never a guess', () => {
  assert.strictEqual(matchClientSlug({ name: 'Acalvio', primaryDomain: { host: 'acalvio.com' } }, KB_BRANDS), null);
  assert.strictEqual(matchClientSlug(null, KB_BRANDS), null);
  assert.strictEqual(matchClientSlug({ name: 'Riccobene' }, []), null);
});
