// ── Which pages a budgeted audit covers ─────────────────────────────────────
//
// Fix 4.1 (5) / 5.4: the budget used to take the top of a depth-first list, so
// a site's score was its homepage and the pages one click away, and Nike's was
// ten country homepages.
//
// Run: node --test modules/projects/__tests__/auditSpread.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spreadOrder, sectionOf } = require('../crawledPages');

const row = (url) => ({ data: { url } });
const urls = (rows) => rows.map((r) => r.data.url.replace('https://x.com', ''));

test('a small budget covers several sections, not one section in depth', () => {
  const ordered = ['/', '/blog/a', '/blog/b', '/blog/c', '/services/x', '/services/y', '/about']
    .map((p) => row(`https://x.com${p}`));
  assert.deepEqual(urls(spreadOrder(ordered)).slice(0, 4), ['/', '/blog/a', '/services/x', '/about']);
  assert.equal(spreadOrder(ordered).length, ordered.length, 'nothing is dropped, only reordered');
});

test('country homepages queue behind the root instead of filling the budget', () => {
  const ordered = ['/', '/en-us/', '/en-gb/', '/de/', '/en-us/shoes/a', '/en-us/help/b']
    .map((p) => row(`https://x.com${p}`));
  assert.deepEqual(urls(spreadOrder(ordered)).slice(0, 3), ['/', '/en-us/shoes/a', '/en-us/help/b']);
  assert.equal(sectionOf('https://x.com/en-us/'), '');
  assert.equal(sectionOf('https://x.com/en-us/shoes/a'), 'shoes');
});
