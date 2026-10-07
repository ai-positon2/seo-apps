// ── "Ran on" labels people can read ─────────────────────────────────────────
//
// Run: npm test --prefix client
//
// Run history and every "Recent runs" panel showed what a run targeted as a
// row id — "project 8f6473f6-3991-4a25-8417-ec519012a520". The stored label is
// kept; only its display changes.

import { test } from 'node:test';
import assert from 'node:assert';

import { humanRunLabel } from '../humanRunLabel.js';

const ID = '8f6473f6-3991-4a25-8417-ec519012a520';

test('a project id becomes the project name when it is known', () => {
  assert.strictEqual(humanRunLabel(`project ${ID}`, new Map([[ID, 'Riccobene']])), 'Riccobene (whole site)');
});

test('a project id never shows raw, even before names have loaded', () => {
  assert.strictEqual(humanRunLabel(`project ${ID}`, null), 'A client project (whole site)');
  assert.strictEqual(humanRunLabel(`project ${ID}`, new Map()), 'A client project (whole site)');
});

test('crawl-run and tracker-client ids are replaced too', () => {
  assert.strictEqual(humanRunLabel('run 372bfc54-21c0-4dec-83f3-c9110398818e'), 'An earlier crawl');
  assert.strictEqual(humanRunLabel('client client_mu6uey0835174a47'), 'A tracked competitor set');
});

test('ordinary labels pass through untouched', () => {
  for (const label of ['https://www.brushandfloss.com/', 'dental implants', 'gentledental.com', 'project plan review']) {
    assert.strictEqual(humanRunLabel(label, new Map()), label);
  }
  assert.strictEqual(humanRunLabel('', new Map()), '');
  assert.strictEqual(humanRunLabel(null, new Map()), '');
});
