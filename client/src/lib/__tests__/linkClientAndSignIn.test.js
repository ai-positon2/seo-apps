// Round-2 shell rules:
//   - a ?project= link is adopted only once the user's list confirms it,
//   - in-app run links carry their client,
//   - "was signed in here" and the cross-tab sign-in signal.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser storage + window for the modules under test.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
const events = [];
globalThis.sessionStorage = memoryStorage();
globalThis.localStorage = memoryStorage();
globalThis.window = globalThis.window || {
  dispatchEvent: (e) => { events.push(e.type); return true; },
  addEventListener: () => {},
  removeEventListener: () => {},
};
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
}

const ap = await import('../activeProject.js');
const { runReportPath } = await import('../moduleReportRoute.js');
const { runDashboardUrl } = await import('../../components/crawlScope/crawlHelpers.js');
const auth = await import('../authEvents.js');

function reset(current) {
  sessionStorage.clear();
  localStorage.clear();
  ap.resetKnownProjectIds();
  if (current) sessionStorage.setItem(ap.ACTIVE_PROJECT_KEY, current);
}

test('a link client is held, not adopted, before the list is known', () => {
  reset('p1');
  assert.equal(ap.adoptProjectFromUrl('?project=p2'), null);
  assert.deepEqual(ap.pendingAdoption(), { id: 'p2', previous: 'p1' });
  // The tab stays on its client until the list confirms it.
  assert.equal(ap.readActiveProjectId(), 'p1');
});

test('a link client the known list has is adopted at once', () => {
  reset('p1');
  ap.setKnownProjectIds(['p1', 'p2']);
  assert.equal(ap.adoptProjectFromUrl('?project=p2'), 'p2');
  assert.equal(ap.pendingAdoption(), null);
  assert.equal(ap.readActiveProjectId(), 'p2');
});

test('a client not in the known list waits for a re-check instead of being applied', () => {
  reset('p1');
  ap.setKnownProjectIds(['p1']);
  assert.equal(ap.adoptProjectFromUrl('?project=pX'), null);
  assert.equal(ap.readActiveProjectId(), 'p1');
  assert.equal(ap.pendingAdoption().id, 'pX');
});

test('judgeAdoption: adopt, re-read once, then reject', () => {
  assert.equal(ap.judgeAdoption('p2', ['p1', 'p2']), 'adopt');
  assert.equal(ap.judgeAdoption('pX', ['p1']), 'recheck');
  assert.equal(ap.judgeAdoption('pX', ['p1'], { rechecked: true }), 'reject');
  assert.equal(ap.judgeAdoption(null, ['p1']), null);
});

test('accepting switches the tab; rejecting keeps it and is remembered', () => {
  reset('p1');
  ap.adoptProjectFromUrl('?project=p2');
  ap.acceptAdoption('p2');
  assert.equal(ap.readActiveProjectId(), 'p2');
  assert.equal(ap.pendingAdoption(), null);

  reset('p1');
  ap.adoptProjectFromUrl('?project=bad');
  ap.rejectAdoptedProject('bad');
  assert.equal(ap.pendingAdoption(), null);
  assert.equal(ap.readActiveProjectId(), 'p1');
  // The same address does not start a second wait.
  assert.equal(ap.adoptProjectFromUrl('?project=bad'), null);
  assert.equal(ap.pendingAdoption(), null);
});

test('a new address replaces a pending link; the current client is a no-op', () => {
  reset('p1');
  ap.adoptProjectFromUrl('?project=p2');
  assert.equal(ap.adoptProjectFromUrl('?tab=x'), null);
  assert.equal(ap.pendingAdoption(), null);
  assert.equal(ap.adoptProjectFromUrl('?project=p1'), 'p1');
  assert.equal(ap.pendingAdoption(), null);
});

test('run links carry the run client, else the tab client', () => {
  reset('p1');
  assert.equal(runReportPath('r1', 'p9'), '/crawl-scope/runs/r1?project=p9');
  assert.equal(runReportPath('r1'), '/crawl-scope/runs/r1?project=p1');
  assert.equal(runReportPath(null), '/crawl-scope');
});

test('the shared dashboard link names the run client', () => {
  assert.equal(runDashboardUrl('https://a.b', 'r1', { project_id: 'p9' }), 'https://a.b/crawl-scope/runs/r1?project=p9');
  assert.equal(runDashboardUrl('https://a.b', 'r1', { project_id: null }), 'https://a.b/crawl-scope/runs/r1');
  assert.equal(runDashboardUrl('https://a.b', null, {}), '');
});

test('"was signed in here" is set by a session and cleared by signing out', () => {
  localStorage.clear();
  assert.equal(auth.hadSession(), false);
  auth.markHadSession();
  assert.equal(auth.hadSession(), true);
  auth.clearHadSession();
  assert.equal(auth.hadSession(), false);
});

test('signing in leaves a storage trace other tabs hear', () => {
  localStorage.clear();
  auth.broadcastSignIn();
  assert.ok(localStorage.getItem('seo-studio:signed-in'));
  // Distinct from the sign-out key, so one never reads as the other.
  assert.equal(localStorage.getItem('seo-studio:signed-out'), null);
});

test('a link given up on (list failed / timed out) is re-judged once a list loads', () => {
  // The list read failed: the tab stays on p1 while the address says p2.
  reset('p1');
  ap.adoptProjectFromUrl('?project=p2');
  ap.clearAdoption();
  assert.equal(ap.pendingAdoption(), null);
  assert.equal(ap.readActiveProjectId(), 'p1');
  // Retry loads a list that has p2: adopted now, so header and address agree.
  ap.setKnownProjectIds(['p1', 'p2']);
  assert.equal(ap.retryClearedAdoption('?project=p2'), 'adopted');
  assert.equal(ap.readActiveProjectId(), 'p2');
  // Once only.
  assert.equal(ap.retryClearedAdoption('?project=p2'), null);

  // Not in the loaded list: held again for the header to reject and correct.
  reset('p1');
  ap.adoptProjectFromUrl('?project=pX');
  ap.clearAdoption();
  ap.setKnownProjectIds(['p1']);
  assert.equal(ap.retryClearedAdoption('?project=pX'), 'pending');
  assert.equal(ap.pendingAdoption().id, 'pX');
  assert.equal(ap.readActiveProjectId(), 'p1');

  // The address moved on since: nothing to re-judge.
  reset('p1');
  ap.adoptProjectFromUrl('?project=p2');
  ap.clearAdoption();
  ap.setKnownProjectIds(['p1', 'p2']);
  assert.equal(ap.retryClearedAdoption('?project=p3'), null);
  assert.equal(ap.readActiveProjectId(), 'p1');

  // A new address after the give-up replaces it.
  reset('p1');
  ap.adoptProjectFromUrl('?project=p2');
  ap.clearAdoption();
  ap.adoptProjectFromUrl('?tab=x');
  ap.setKnownProjectIds(['p1', 'p2']);
  assert.equal(ap.retryClearedAdoption('?project=p2'), null);
});

test('a record page names its client only once the list is known to have it', () => {
  // Cold load: no list yet. Rewriting now would make the link pending and the
  // shell would unmount the page that is already showing the run.
  reset('p1');
  assert.equal(ap.recordClientAddress('/crawl-scope/runs/r1', '', 'pR'), null);
  // The list lands with the run's client: rewrite, and it is adopted at once.
  ap.setKnownProjectIds(['p1', 'pR']);
  const fixed = ap.recordClientAddress('/crawl-scope/runs/r1', '?tab=urls', 'pR');
  assert.equal(fixed, '/crawl-scope/runs/r1?tab=urls&project=pR');
  assert.equal(ap.adoptProjectFromUrl(fixed.slice(fixed.indexOf('?'))), 'pR');
  assert.equal(ap.pendingAdoption(), null);
  // Already named, or a client the user cannot open: left alone.
  assert.equal(ap.recordClientAddress('/crawl-scope/runs/r1', '?project=pR', 'pR'), null);
  assert.equal(ap.recordClientAddress('/crawl-scope/runs/r1', '', 'pZ'), null);
  assert.equal(ap.recordClientAddress('/crawl-scope/runs/r1', '', null), null);
});

test('public routes never become the return path; protected gated routes do', () => {
  assert.equal(auth.isPublicPath('/agent-readiness-audit/summary'), true);
  assert.equal(auth.isPublicPath('/login'), true);
  assert.equal(auth.isPublicPath('/agent-readiness-audit'), false);
  assert.equal(auth.gateReturnPath('/agent-readiness-audit/summary', '?d=abc'), null);
  assert.equal(auth.gateReturnPath('/login', ''), null);
  assert.equal(auth.gateReturnPath('/', ''), null);
  assert.equal(auth.gateReturnPath('/agent-readiness-audit', '?project=p1'), '/agent-readiness-audit?project=p1');
  // The gated route overwrites a stale one.
  sessionStorage.clear();
  auth.rememberReturnPath('/agent-readiness-audit/summary?d=abc');
  auth.rememberReturnPath(auth.gateReturnPath('/agent-readiness-audit', '?project=p1'));
  assert.equal(auth.takeReturnPath(), '/agent-readiness-audit?project=p1');
});
