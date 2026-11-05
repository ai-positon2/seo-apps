// ── Competitor dashboard: unknown is not zero ───────────────────────────────
//
// Run: npm test --prefix client
//
// A rival whose numbers failed to load was ranked as 0 (pushing the client up
// to "#1 of 4"), a site that blocked the sitemap check showed "0 pages", and a
// branded count capped at 40 rows was drawn as "100% non-branded".

import { test } from 'node:test';
import assert from 'node:assert';

import {
  computeClientStat, rankedRows, unlessFailed, brandedCountText, hasBrandedShare,
  sitemapStatusText, sitemapFootnote, isSitemapPartial,
  bumpClientLoad, isClientLoading,
} from '../utils.js';

test('a reload for a client the reader left never leaves the selected one loading', () => {
  // Reader on A starts a read, switches to B (B's read starts), then A's run
  // finishes and reloads A. Every read settles; B must end not loading.
  let loads = {};
  loads = bumpClientLoad(loads, 'A', 1);
  loads = bumpClientLoad(loads, 'B', 1);
  assert.strictEqual(isClientLoading(loads, 'B'), true);
  loads = bumpClientLoad(loads, 'A', 1);   // A's run finished → reload A
  loads = bumpClientLoad(loads, 'B', -1);  // B answered
  assert.strictEqual(isClientLoading(loads, 'B'), false);
  assert.strictEqual(isClientLoading(loads, 'A'), true);
  loads = bumpClientLoad(loads, 'A', -1);
  loads = bumpClientLoad(loads, 'A', -1);
  assert.deepStrictEqual(loads, {});
  // No client, no state; never negative.
  assert.strictEqual(isClientLoading(loads, ''), false);
  assert.deepStrictEqual(bumpClientLoad({}, 'A', -1), {});
  assert.deepStrictEqual(bumpClientLoad(undefined, '', 1), {});
});

const client = { domain: 'me.com', isClient: true, v: 50 };

test('an unmeasured competitor is left out of the rank, not ranked as 0', () => {
  const domains = [client, { domain: 'a.com', v: 100 }, { domain: 'b.com', v: null }, { domain: 'c.com', v: undefined }];
  const stat = computeClientStat(domains, (d) => d.v);
  assert.strictEqual(stat.rank, 2);
  assert.strictEqual(stat.total, 2);
  assert.strictEqual(stat.unmeasured, 2);
  assert.strictEqual(stat.isLeader, false);
});

test('a failed Semrush call reads as unknown even where an old snapshot stored 0', () => {
  const authority = unlessFailed('backlinksOverview', (d) => d.authorityScore);
  const domains = [{ ...client, authorityScore: 30 }, { domain: 'x.com', authorityScore: 0, fetchErrors: ['backlinksOverview'] }];
  const stat = computeClientStat(domains, authority);
  assert.strictEqual(stat.total, 1);
  assert.strictEqual(stat.unmeasured, 1);
});

test('ranked rows put unknown rows last with no value, and the leader is measured', () => {
  const { rows, leader } = rankedRows([{ domain: 'z', v: null }, { domain: 'y', v: 5 }, { domain: 'x', v: 9 }], (d) => d.v);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.value, r.unknown]), [['x', 9, false], ['y', 5, false], ['z', null, true]]);
  assert.strictEqual(leader, 9);
});

test('a blocked or missing sitemap is a status, never a 0 bar', () => {
  const blocked = { domain: '8x8.com', sitemapStatus: 'blocked', totalUrls: null, error: 'Site blocked our request (HTTP 429).' };
  const { rows } = rankedRows([blocked, { domain: 'v.com', sitemapStatus: 'found', totalUrls: 40 }], (d) => d.totalUrls, (d) => d.sitemapStatus !== 'found');
  assert.strictEqual(rows[1].unknown, true);
  assert.match(sitemapStatusText(blocked), /blocked our request/);
  assert.match(sitemapFootnote(blocked), /HTTP 429/);
  assert.strictEqual(sitemapStatusText({ sitemapStatus: 'found' }), null);
  assert.strictEqual(isSitemapPartial({ sitemapStatus: 'found', partial: true }), true);
  assert.strictEqual(isSitemapPartial({ sitemapStatus: 'found' }), false);
});

test('a capped branded count reads "40+" and has no share to draw', () => {
  const capped = { brandedKeywordCount: 40, brandedKeywordCountCapped: true, nonBrandedKeywordCount: 3786587 };
  assert.strictEqual(brandedCountText(capped), '40+');
  assert.strictEqual(hasBrandedShare(capped), false);
  const real = { brandedKeywordCount: 12, brandedKeywordCountCapped: false, nonBrandedKeywordCount: 900 };
  assert.strictEqual(brandedCountText(real), '12');
  assert.strictEqual(hasBrandedShare(real), true);
  assert.strictEqual(brandedCountText({ brandedKeywordCount: null }), '—');
});
