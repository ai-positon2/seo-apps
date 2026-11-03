// ── One crawl, one Hub and Spoke run ────────────────────────────────────────
//
// The crawl manager used to queue Hub and Spoke every 50 pages while a crawl
// ran, as well as at completion. The runner analyses the latest COMPLETED
// crawl, so every one of those passes re-analysed the previous crawl: Gentle
// Dental's single crawl started 45 identical runs in 58 minutes, and
// Eventgroove's 210 pushed its other modules out of the dashboard's run window.
//
// Run: node --test modules/projects/__tests__/hubSpokeAutostart.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { decide } = require('../hubSpokeAutostart');

const managerSource = fs.readFileSync(
  path.join(__dirname, '../../crawlScope/run/manager.js'), 'utf8',
);

test('the crawl manager queues Hub and Spoke in one place only', () => {
  const calls = managerSource.match(/scheduleHubSpoke\(/g) || [];
  assert.equal(calls.length, 1, 'scheduleHubSpoke is called once, at completion');
});

test('nothing in the per-result handler queues Hub and Spoke', () => {
  const start = managerSource.indexOf('crawler.on("result"');
  assert.ok(start > 0, 'the result handler exists');
  const end = managerSource.indexOf('});', start);
  const handler = managerSource.slice(start, end);
  assert.doesNotMatch(handler, /HubSpoke|hubSpoke/);
});

test('a run already queued for the project is never doubled', () => {
  assert.deepEqual(
    decide({ enabled: true, hasProject: true, pending: { queued: { id: 'q' } } }),
    { start: false, reason: 'already_queued' },
  );
  // One running against an older crawl: the fresh crawl gets one run behind it.
  assert.deepEqual(
    decide({ enabled: true, hasProject: true, pending: { running: { id: 'r' } } }),
    { start: true, reason: 'queued_behind_running' },
  );
});
