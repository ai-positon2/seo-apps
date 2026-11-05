// The session and client-selection rules the app shell relies on:
//   - which responses end a session (and which must not),
//   - how a verify answer is read (a 5xx is not a sign-out),
//   - the client a link names, and where a header switch goes,
//   - plain-language errors for non-JSON bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSessionEndedResponse, classifyVerify, retryDelay, notifySessionEnded, onSessionEnded, resetSessionEnded,
} from '../authEvents.js';
import { projectFromSearch, withProjectParam, switchTarget } from '../activeProject.js';
import { moduleReportRoute } from '../moduleReportRoute.js';
import { readJsonBody, SERVER_DOWN_MESSAGE } from '../fetchJson.js';

const ORIGIN = 'https://app.example';

test('only a requireAuth 401 from our own API ends the session', () => {
  assert.equal(isSessionEndedResponse('/api/workspaces', 401, '1', ORIGIN), true);
  assert.equal(isSessionEndedResponse(`${ORIGIN}/api/projects?x=1`, 401, '1', ORIGIN), true);
  // verify drives the gate itself; reacting to it would loop.
  assert.equal(isSessionEndedResponse('/api/auth/verify', 401, '1', ORIGIN), false);
  // A route's own 401 (an upstream API key) carries no marker.
  assert.equal(isSessionEndedResponse('/api/analyze', 401, null, ORIGIN), false);
  assert.equal(isSessionEndedResponse('/api/projects', 500, '1', ORIGIN), false);
  assert.equal(isSessionEndedResponse('https://other.example/api/x', 401, '1', ORIGIN), false);
});

test('many failing requests make one transition', () => {
  resetSessionEnded();
  let calls = 0;
  const off = onSessionEnded(() => { calls += 1; });
  notifySessionEnded(); notifySessionEnded(); notifySessionEnded();
  assert.equal(calls, 1);
  off();
  resetSessionEnded();
});

test('a server hiccup is "unreachable", never "signed out"', () => {
  assert.equal(classifyVerify(503, { error: 'x' }), 'unreachable');
  assert.equal(classifyVerify(500, null), 'unreachable');
  assert.equal(classifyVerify(null, null), 'unreachable');      // network error
  assert.equal(classifyVerify(200, null), 'unreachable');       // HTML from a proxy
  assert.equal(classifyVerify(401, null), 'unauthenticated');
  assert.equal(classifyVerify(403, null), 'unauthenticated');
  assert.equal(classifyVerify(200, { valid: false }), 'unauthenticated');
  assert.equal(classifyVerify(200, { valid: true }), 'authenticated');
  assert.deepEqual([0, 1, 2, 9].map(retryDelay), [2000, 5000, 10000, 10000]);
});

test('?project= is read safely and written without losing other parameters', () => {
  assert.equal(projectFromSearch('?project=abc-123'), 'abc-123');
  assert.equal(projectFromSearch('?tab=x'), null);
  assert.equal(projectFromSearch('?project=<script>'), null);
  assert.equal(withProjectParam('/seo-geo-audit', 'p1'), '/seo-geo-audit?project=p1');
  assert.equal(withProjectParam('/competitor-analysis?client=c9', 'p1'), '/competitor-analysis?client=c9&project=p1');
  assert.equal(withProjectParam('/x?project=old', 'new'), '/x?project=new');
});

test('switching client stays on the page, except on a page about one record', () => {
  assert.equal(switchTarget('/agent-readiness-audit', 'B'), '/agent-readiness-audit?project=B');
  assert.equal(switchTarget('/', 'B'), '/?project=B');
  assert.equal(switchTarget('/crawl-scope/runs/r-1', 'B'), '/crawl-scope?project=B');
  assert.equal(switchTarget('/content-architect/proj_1', 'B'), '/content-architect?project=B');
  assert.equal(switchTarget('/content-architect', 'B'), '/content-architect?project=B');
});

test('every report link names its client', () => {
  const pid = 'proj-9';
  assert.equal(moduleReportRoute({ key: 'seo_geo', toolPath: '/seo-geo-audit', evidence: {} }, { projectId: pid }).path,
    '/seo-geo-audit?project=proj-9');
  assert.equal(moduleReportRoute({ key: 'technical', runId: 'r1' }, { projectId: pid }).path,
    '/crawl-scope/runs/r1?project=proj-9');
  assert.equal(moduleReportRoute({ key: 'hub_spoke', reportRef: 'h1' }, { projectId: pid }).path,
    '/content-architect/h1?project=proj-9');
  assert.equal(moduleReportRoute({ key: 'competitor', reportRef: 'c1' }, { projectId: pid }).path,
    '/competitor-analysis?client=c1&project=proj-9');
  // No client known: the plain path, as before.
  assert.equal(moduleReportRoute({ key: 'seo_geo', toolPath: '/seo-geo-audit' }).path, '/seo-geo-audit');
});

test('a gateway HTML page becomes a plain message; a server error message is kept', () => {
  const html = readJsonBody(502, '<!DOCTYPE html><html>Bad gateway</html>');
  assert.equal(html.ok, false);
  assert.equal(html.message, SERVER_DOWN_MESSAGE);
  assert.doesNotMatch(html.message, /Unexpected token/);
  assert.equal(readJsonBody(400, '{"error":"Email is required."}').message, 'Email is required.');
  assert.deepEqual(readJsonBody(200, '{"a":1}'), { ok: true, data: { a: 1 } });
  assert.equal(readJsonBody(200, '<html>').ok, false);
});
