// The options form's threshold defaults are the server's (thresholds.js):
// a form that starts from other numbers would save them as a project's own.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { DEFAULT_OPTIONS, DEFAULT_THRESHOLDS } from '../crawlHelpers.js';

const require = createRequire(import.meta.url);
const server = require('../../../../../server/modules/crawlScope/thresholds.js');

test('the form starts from the server’s own threshold defaults', () => {
  assert.deepStrictEqual(DEFAULT_THRESHOLDS, server.DEFAULT_THRESHOLDS);
  assert.deepStrictEqual(DEFAULT_OPTIONS.thresholds, server.DEFAULT_THRESHOLDS);
});
