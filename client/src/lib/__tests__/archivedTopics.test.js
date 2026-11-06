// ── Archived Hub and Spoke topics: the optimistic report changes ────────────
//
// Archive moves a cluster and its pages out of the report at once; Restore
// takes it off the archived list. The page reloads from the server after, and
// puts the previous analysis back on an error.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import {
  withClusterArchived, withTopicRestored, archivedScoreNote, archivedInAnalysis, archivedWorkKeys,
} from '../archivedTopics.js';

const analysis = {
  pages: [
    { id: 'p1', url: 'https://s.com/a', clusterId: 'c0' },
    { id: 'p2', url: 'https://s.com/b', clusterId: 'c0' },
    { id: 'p3', url: 'https://s.com/c', clusterId: 'c1' },
  ],
  clusters: [
    { id: 'c0', name: 'Archive me', hubPageId: 'p1', spokeIds: ['p2'], health: 20 },
    { id: 'c1', name: 'Keep', hubPageId: 'p3', spokeIds: [], health: 80 },
  ],
};

test('archiving takes the cluster and its pages out, and lists it as pending', () => {
  const next = withClusterArchived(analysis, analysis.clusters[0]);
  assert.deepEqual(next.clusters.map((c) => c.id), ['c1']);
  assert.deepEqual(next.pages.map((p) => p.id), ['p3']);
  assert.equal(next.archivedClusters.length, 1);
  assert.equal(next.archivedClusters[0].pending, true);
  assert.deepEqual(next.archivedClusters[0].pageUrls, ['https://s.com/a', 'https://s.com/b']);
  assert.equal(analysis.clusters.length, 2, 'the previous analysis is untouched, for the rollback');
  assert.equal(archivedScoreNote(next), '1 topic archived — excluded from this score');
  assert.deepEqual(archivedWorkKeys(next).clusterIds, ['c0']);
});

test('restoring takes the topic off the list', () => {
  const archived = { ...analysis, archivedClusters: [{ key: 'k1', inAnalysis: true }, { key: 'k2', inAnalysis: false }] };
  assert.equal(archivedInAnalysis(archived), 1);
  assert.equal(archivedScoreNote(archived), '1 topic archived — excluded from this score');
  const next = withTopicRestored(archived, 'k1');
  assert.deepEqual(next.archivedClusters.map((a) => a.key), ['k2']);
  assert.equal(archivedScoreNote(next), null, 'one not in this analysis does not change its score');
});

test('nothing archived, no note', () => {
  assert.equal(archivedScoreNote(analysis), null);
  assert.equal(archivedScoreNote(null), null);
});
