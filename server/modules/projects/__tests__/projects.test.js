// ── Tests for the project aggregate's pure logic ────────────────────────────
// Domain/country normalization (PRD §8.2, §9.1, §3.2.3) and the overview
// builder's honesty rules (§16.11, §6.2, §5.2). Both are places where a plausible
// wrong answer is worse than an error: a mis-normalized origin silently makes
// two projects look like different sites, and a fabricated module score makes a
// dashboard confidently misreport a client's site.
//
// Run: node modules/projects/__tests__/projects.test.js

const assert = require('assert');
const domains = require('../domains');
const overview = require('../overview');
const moduleEvidence = require('../moduleEvidence');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// ── Origin normalization ────────────────────────────────────────────────────

console.log('\nDomains — origin normalization');

test('a bare host becomes an https origin', () => {
  const d = domains.normalizeOrigin('gentledental.com');
  assert.strictEqual(d.normalizedOrigin, 'https://gentledental.com');
  assert.strictEqual(d.host, 'gentledental.com');
  assert.strictEqual(d.scheme, 'https');
});

test('scheme and host are lowercased', () => {
  assert.strictEqual(
    domains.normalizeOrigin('HTTPS://Gentle.Dental.COM').normalizedOrigin,
    'https://gentle.dental.com',
  );
});

test('path, query and fragment are dropped — a domain is an origin', () => {
  for (const input of [
    'https://gentledental.com/locations/austin?x=1#top',
    'https://gentledental.com/',
    'gentledental.com/locations',
  ]) {
    assert.strictEqual(
      domains.normalizeOrigin(input).normalizedOrigin,
      'https://gentledental.com',
      input,
    );
  }
});

test('the default port is removed, a non-default port is kept', () => {
  assert.strictEqual(domains.normalizeOrigin('https://example.com:443').normalizedOrigin, 'https://example.com');
  assert.strictEqual(domains.normalizeOrigin('http://example.com:80').normalizedOrigin, 'http://example.com');
  assert.strictEqual(domains.normalizeOrigin('https://example.com:8443').normalizedOrigin, 'https://example.com:8443');
});

test('an explicit http scheme is preserved, not upgraded', () => {
  // §9.1 reserves scheme coercion for versioned project rules; silently
  // rewriting http to https would make the stored origin a claim we never tested.
  assert.strictEqual(domains.normalizeOrigin('http://example.com').normalizedOrigin, 'http://example.com');
});

test('www is NOT stripped — it is a different host', () => {
  assert.strictEqual(domains.normalizeOrigin('www.example.com').normalizedOrigin, 'https://www.example.com');
  assert.notStrictEqual(
    domains.normalizeOrigin('www.example.com').normalizedOrigin,
    domains.normalizeOrigin('example.com').normalizedOrigin,
  );
});

test('a trailing root dot is the same origin', () => {
  assert.strictEqual(domains.normalizeOrigin('example.com.').normalizedOrigin, 'https://example.com');
});

test('the raw input is always preserved alongside the normalized form', () => {
  const d = domains.normalizeOrigin('  HTTPS://Example.com/path  ');
  assert.strictEqual(d.raw, 'HTTPS://Example.com/path');
  assert.strictEqual(d.normalizedOrigin, 'https://example.com');
});

test('non-http schemes are rejected', () => {
  for (const input of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
    assert.throws(() => domains.normalizeOrigin(input), (e) => e.status === 400, input);
  }
});

test('input with no usable host is rejected', () => {
  for (const input of ['', '   ', 'localhost', 'not a domain', 'https://', '.', 'https://.com']) {
    assert.throws(() => domains.normalizeOrigin(input), (e) => e.status === 400, JSON.stringify(input));
  }
});

test('an IPv4 literal is accepted — the crawler SSRF guard still decides', () => {
  assert.strictEqual(domains.normalizeOrigin('http://192.168.1.10').normalizedOrigin, 'http://192.168.1.10');
});

// ── Country ─────────────────────────────────────────────────────────────────

console.log('\nDomains — country (ISO 3166-1 alpha-2)');

test('a valid code is uppercased', () => {
  assert.strictEqual(domains.normalizeCountry('us'), 'US');
  assert.strictEqual(domains.normalizeCountry(' gb '), 'GB');
  assert.strictEqual(domains.normalizeCountry('IN'), 'IN');
});

test('common names and UK/USA are mapped to their real codes', () => {
  assert.strictEqual(domains.normalizeCountry('UK'), 'GB');
  assert.strictEqual(domains.normalizeCountry('United Kingdom'), 'GB');
  assert.strictEqual(domains.normalizeCountry('USA'), 'US');
  assert.strictEqual(domains.normalizeCountry('united states'), 'US');
});

test('a missing country is an error, never a silent default', () => {
  // Defaulting to US would hand every non-US client the wrong market.
  for (const input of [undefined, null, '', '   ']) {
    assert.throws(() => domains.normalizeCountry(input), (e) => e.status === 400, JSON.stringify(input));
  }
});

test('a code that is not a real ISO country is rejected', () => {
  for (const input of ['XX', 'ZZ', 'U', 'USA1', 'Atlantis', 'EU']) {
    assert.throws(() => domains.normalizeCountry(input), (e) => e.status === 400, input);
  }
});

test('no alias shadows an assigned ISO code', () => {
  // The alias map is consulted before the ISO set, so an alias key that is also
  // a real code would silently rewrite that country to somewhere else.
  const shadowing = Object.keys(domains.COUNTRY_ALIASES).filter((k) => domains.ISO_3166_ALPHA2.has(k));
  assert.deepStrictEqual(shadowing, [], `these aliases shadow real codes: ${shadowing.join(', ')}`);
});

test('every alias resolves to an assigned ISO code', () => {
  for (const [alias, code] of Object.entries(domains.COUNTRY_ALIASES)) {
    assert.ok(domains.ISO_3166_ALPHA2.has(code), `${alias} maps to ${code}, which is not an ISO code`);
  }
});

// ── Competitors ─────────────────────────────────────────────────────────────

console.log('\nDomains — competitor lists');

test('duplicates by origin collapse, and input order is kept', () => {
  const out = domains.normalizeCompetitors([
    'aspendental.com',
    'https://aspendental.com/',       // same origin, typed differently
    'smiledirectclub.com',
  ]);
  assert.deepStrictEqual(out.map((d) => d.host), ['aspendental.com', 'smiledirectclub.com']);
});

test('empty entries are skipped rather than rejecting the whole list', () => {
  const out = domains.normalizeCompetitors(['aspendental.com', '', null, '  ']);
  assert.strictEqual(out.length, 1);
});

test('the primary domain cannot also be a competitor (§8.2)', () => {
  assert.throws(
    () => domains.normalizeCompetitors(['gentledental.com'], { primaryOrigin: 'https://gentledental.com' }),
    (e) => e.status === 400 && /primary domain/i.test(e.message),
  );
});

test('the competitor cap is enforced', () => {
  const many = Array.from({ length: 30 }, (_, i) => `competitor${i}.com`);
  assert.throws(() => domains.normalizeCompetitors(many, { max: 25 }), (e) => e.status === 400);
});

test('a single string is accepted as a one-item list', () => {
  assert.strictEqual(domains.normalizeCompetitors('aspendental.com').length, 1);
});

// ── Overview: run status display (PRD §10.5, §30.7) ─────────────────────────

console.log('\nOverview — run status');

test("legacy 'stopped' displays as cancelled without rewriting the stored value", () => {
  assert.strictEqual(overview.displayRunStatus({ status: 'stopped' }), 'cancelled');
});

test('a completed run with error findings is completed_with_errors (AC-015)', () => {
  assert.strictEqual(
    overview.displayRunStatus({ status: 'completed', summary: { counts: { error: 3 } } }),
    'completed_with_errors',
  );
  assert.strictEqual(
    overview.displayRunStatus({ status: 'completed', summary: { counts: { error: 0, warning: 5 } } }),
    'completed',
  );
  assert.strictEqual(overview.displayRunStatus({ status: 'completed' }), 'completed');
});

// ── Overview: the honesty rules ─────────────────────────────────────────────

console.log('\nOverview — missing evidence is never a number');

test('a never-crawled project reports not_run with no score', () => {
  const card = overview.technicalCard([], []);
  assert.strictEqual(card.status, 'not_run');
  assert.strictEqual(card.score, null);
  assert.strictEqual(card.scored, false);
  assert.strictEqual(card.evidence, null);
});

test('an in-flight first crawl reports running, still with no score', () => {
  const card = overview.technicalCard([{ id: 'r1', status: 'running', created_at: '2026-08-21T10:00:00Z' }], []);
  assert.strictEqual(card.status, 'running');
  assert.strictEqual(card.score, null);
  assert.strictEqual(card.runId, 'r1');
});

test('a completed crawl reports real counts, and still no invented score', () => {
  const card = overview.technicalCard(
    [{
      id: 'r2', status: 'completed', finished_at: '2026-08-21T11:00:00Z',
      summary: { counts: { error: 2, warning: 3, notice: 7 }, resultCount: 412, robotsStatus: 'ok' },
    }],
    [
      { rule_id: 'page-4xx', severity: 'error', category: 'Technical', count: 12, detail: { title: 'Pages returning 4XX errors' } },
      { rule_id: 'title-missing', severity: 'warning', category: 'On-Page', count: 30, detail: { title: 'Missing title' } },
    ],
  );
  assert.strictEqual(card.status, 'completed_with_errors');
  assert.strictEqual(card.score, null, 'CrawlScope has no 0-100 rubric; §6.2 forbids inventing one');
  assert.strictEqual(card.scored, false);
  assert.strictEqual(card.evidence.counts.error, 2);
  assert.strictEqual(card.evidence.resultCount, 412);
  // No page count supplied: the card must not guess that all 412 results were
  // pages of the site, so it says "checked" rather than "crawled".
  assert.strictEqual(card.evidence.pagesCrawled, null);
  assert.match(card.detail, /412 URLs checked/);
  // error severity sorts ahead of the higher-count warning
  assert.strictEqual(card.evidence.topFindings[0].ruleId, 'page-4xx');
});

test('pages crawled and external links checked are reported separately', () => {
  // The real case that exposed this: a run capped at 50 pages stored 86 results,
  // because 36 of them were outbound link checks governed by a different limit.
  const card = overview.technicalCard(
    [{
      id: 'r3', status: 'completed', finished_at: '2026-08-21T15:35:46Z',
      summary: { counts: { error: 1, warning: 314, notice: 113 }, resultCount: 86 },
    }],
    [],
    50,
  );
  assert.strictEqual(card.evidence.pagesCrawled, 50);
  assert.strictEqual(card.evidence.externalChecked, 36);
  assert.strictEqual(card.evidence.resultCount, 86);
  assert.match(card.detail, /50 pages crawled/);
  assert.match(card.detail, /36 external links checked/);
  assert.doesNotMatch(
    card.detail, /86/,
    'the total must not be presented as pages crawled — it is what made a 50-page cap look broken',
  );
});

test('no external results means no external clause', () => {
  const card = overview.technicalCard(
    [{ id: 'r4', status: 'completed', summary: { counts: {}, resultCount: 12 } }],
    [],
    12,
  );
  assert.match(card.detail, /12 pages crawled/);
  assert.doesNotMatch(card.detail, /external/);
});

test('the pending-card shape still names the phase it is waiting on', () => {
  // No MODULES entry is pending any more — phases 3 and 4 connected all six.
  // pendingCard remains the fallback for any module added with live: false, and
  // its contract is what stops a future addition from rendering a silent blank.
  const card = overview.pendingCard({
    key: 'future_module', label: 'Future Module', live: false,
    pendingPhase: 'phase 7 — reporting',
  });
  assert.strictEqual(card.status, 'not_run');
  assert.strictEqual(card.score, null);
  assert.strictEqual(card.scored, false);
  assert.ok(/phase 7/.test(card.detail), 'the card explains when it becomes real');
});

test('the composite is null with nothing scored — never zero (§16.11)', () => {
  const composite = overview.buildComposite(overview.MODULES.map(overview.pendingCard));
  assert.strictEqual(composite.value, null);
  assert.notStrictEqual(composite.value, 0);
  assert.strictEqual(composite.status, 'insufficient_data');
  assert.strictEqual(composite.scoredModules, 0);
  assert.strictEqual(composite.totalModules, 6);
});

test('the composite averages only the modules that really scored', () => {
  const composite = overview.buildComposite([
    { scored: true,  score: 80 },
    { scored: true,  score: 60 },
    { scored: false, score: null },
  ]);
  assert.strictEqual(composite.value, 70);
  assert.strictEqual(composite.scoredModules, 2);
  assert.strictEqual(composite.status, 'partial');
});

test('the audit profile covers the six modules the design shows', () => {
  assert.deepStrictEqual(
    overview.MODULES.map((m) => m.key),
    ['technical', 'hub_spoke', 'competitor', 'seo_geo', 'ai_visibility', 'agent_readiness'],
  );
  // All six are wired to durable project-scoped evidence: CrawlScope via
  // crawl_runs, the other five via project_module_runs.
  //
  // ai_visibility took the slot on_page vacated, and is the odd one out: it
  // measures what ChatGPT and Google AI Overview say about the client rather
  // than anything on the client's own site.
  //
  // on_page was a sixth. It was removed with the standalone /on-page-audit page:
  // the On-Page report now lives as a tab inside the SEO & GEO Audit, which runs
  // ad-hoc audits through /api/on-page-audit rather than storing project runs.
  // server/modules/onPageAudit/ is still there and still serves that tab —
  assert.deepStrictEqual(
    overview.MODULES.filter((m) => m.live).map((m) => m.key).sort(),
    ['agent_readiness', 'ai_visibility', 'competitor', 'hub_spoke', 'seo_geo', 'technical'],
  );
  assert.deepStrictEqual(overview.MODULES.filter((m) => !m.live), []);

  // Every module the dashboard can run must declare it, and technical must NOT:
  // a crawl is queued through CrawlScope's own worker and takes minutes, so
  // routing it through the synchronous runModule path would hang the request.
  assert.deepStrictEqual(
    overview.MODULES.filter((m) => m.runnable).map((m) => m.key).sort(),
    ['agent_readiness', 'ai_visibility', 'competitor', 'hub_spoke', 'seo_geo'],
  );
  assert.strictEqual(
    overview.MODULES.find((m) => m.key === 'technical').runnable,
    undefined,
  );
});

// ─ Live crawl status ────────────────────────────────────────────────

console.log('\nOverview — live crawl status');

const nowIso = () => new Date().toISOString();
const running = (progress, extra = {}) => ([{
  id: 'run-1', url: 'https://example.com', status: 'running',
  started_at: nowIso(), heartbeat_at: nowIso(), progress, ...extra,
}]);

test('nothing in flight reports nothing at all', () => {
  assert.strictEqual(overview.crawlStatus([]), null);
  assert.strictEqual(overview.crawlStatus([{ id: 'r', status: 'completed' }]), null);
});

test('a queued crawl has no percentage rather than a zero one', () => {
  // 0% would claim the crawl started and got nowhere. It has not started.
  const st = overview.crawlStatus([{ id: 'r', status: 'queued', created_at: nowIso(), progress: {} }]);
  assert.strictEqual(st.state, 'pending');
  assert.strictEqual(st.percent, null);
  assert.strictEqual(st.crawled, null);
});

test('the bar measures progress against the ceiling, not against discovery', () => {
  // The invariant that stops the bar moving backwards: discovered grows as links
  // are found, while the ceiling is fixed for the whole run.
  const st = overview.crawlStatus(running({ crawled: 27, discovered: 41, maxUrls: 60 }));
  assert.strictEqual(st.percent, 45);           // 27/60, not 27/41
  assert.strictEqual(st.discovered, 41);
});

test('finding more pages never moves the bar backwards', () => {
  const before = overview.crawlStatus(running({ crawled: 27, discovered: 41, maxUrls: 60 }));
  const after = overview.crawlStatus(running({ crawled: 27, discovered: 205, maxUrls: 60 }));
  assert.strictEqual(before.percent, after.percent);
});

test('the bar is capped at 100 rather than overflowing', () => {
  const st = overview.crawlStatus(running({ crawled: 90, discovered: 90, maxUrls: 60 }));
  assert.strictEqual(st.percent, 100);
});

test('no ceiling means no percentage, not a full bar', () => {
  const st = overview.crawlStatus(running({ crawled: 5 }));
  assert.strictEqual(st.percent, null);
  assert.strictEqual(st.crawled, 5);
});

test('a stalled crawl is not reported as running', () => {
  // The state the dashboard hid completely: a dead crawl looked exactly like a
  // slow one, and the only way to tell was to read the heartbeat column by hand.
  const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const st = overview.crawlStatus(running({ crawled: 3, maxUrls: 60 }, { heartbeat_at: stale }));
  assert.strictEqual(st.state, 'stalled');
  assert.strictEqual(st.live, false);
  assert.ok(st.silentMinutes >= 39, 'reports how long it has been silent');
  assert.ok(/stopped responding/i.test(st.headline));
});

test('a paused crawl says so instead of claiming to be alive', () => {
  const st = overview.crawlStatus([{
    id: 'r', status: 'paused', started_at: nowIso(), heartbeat_at: nowIso(),
    progress: { crawled: 9, maxUrls: 60 },
  }]);
  assert.strictEqual(st.state, 'paused');
  assert.strictEqual(st.live, false);
});

test('following page audits are named only when there are some', () => {
  const with3 = overview.crawlStatus(running({ crawled: 4, maxUrls: 60 }), 3);
  assert.ok(/3 page audits running behind it/.test(with3.detail));
  const none = overview.crawlStatus(running({ crawled: 4, maxUrls: 60 }), 0);
  assert.ok(!/behind it/.test(none.detail));
});


// ─ Capability names ────────────────────────────────────────────────────────────

console.log('\nRoutes — capability names');

test('every capability a route asks for actually exists', () => {
  // capabilityFor() denies unknown capability names on purpose — "a typo must
  // not open a door". The safe failure mode has a cost: a misspelt capability
  // does not throw, it silently refuses EVERYONE, including the project owner,
  // and the route looks like a permissions problem rather than a typo.
  //
  // That is exactly how `requireProject(req, id, 'runModule')` shipped: there is
  // no 'runModule' capability, the real one is 'startRun', and the endpoint
  // rejected every caller. Nothing failed loudly enough to notice.
  const fs = require('fs');
  const path = require('path');
  const { CAPABILITIES } = require('../../../services/projectAccess');

  const src = fs.readFileSync(path.join(__dirname, '../routes.js'), 'utf8');
  const asked = [...src.matchAll(/require(?:Project|Workspace)\([^)]*?,\s*'([a-zA-Z]+)'/g)]
    .map((m) => m[1]);

  assert.ok(asked.length > 0, 'the scan must actually find capability arguments');

  const unknown = [...new Set(asked)].filter((name) => !(name in CAPABILITIES));
  assert.deepStrictEqual(
    unknown,
    [],
    `these routes ask for capabilities that do not exist, so they deny everyone: ${unknown.join(', ')}`,
  );
});


// ─ Schema drift ─────────────────────────────────────────────────

console.log('');
console.log('Module keys — JavaScript vs the database');

test('every module key the app can write is allowed by the CHECK constraint', () => {
  // project_module_runs.module_key carries a closed-vocabulary CHECK. Adding a
  // module to the JS lists without widening it means startRun is refused by the
  // database, before any module code runs, and the route answers the generic
  // "Something went wrong handling that project request" — because a constraint
  // violation carries no HTTP status for handleError to surface.
  //
  // That is exactly how ai_visibility shipped broken: four JS lists updated, the
  // constraint forgotten. This reads the migrations so the two cannot drift
  // again without a test failing.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../../../../supabase/migrations');

  // The last migration that redefines the constraint wins.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let allowed = null;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const match = [...sql.matchAll(/project_module_runs_module_check[\s\S]*?check \(module_key in \(([^)]*)\)/g)].pop();
    if (match) {
      allowed = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    }
  }

  assert.ok(allowed, 'no migration defines project_module_runs_module_check');

  const missing = moduleEvidence.MODULE_KEYS.filter((k) => !allowed.includes(k));
  assert.deepStrictEqual(
    missing, [],
    `these module keys would be rejected by the database: ${missing.join(', ')}`,
  );
});

// ─ The queue owns the long module ────────────────────────

console.log('');
console.log('AI Visibility — queued, never run inside the request');

test('the run route enqueues ai_visibility instead of running it detached', () => {
  // A module run started inside the request opens a `running` row that NOTHING
  // ever heartbeats — only a worker's claim stamps worker_id/heartbeat_at. That
  // is exactly what moduleQueue.reap()'s "running but never heartbeated" arm
  // reclaims, and its threshold (10 min) is shorter than an AI Visibility run
  // (10-35 min), so every manual run was requeued while it was still working:
  // the dashboard saw the module leave `running` and said it had finished, and
  // the worker then captured the whole set again on the client's money.
  //
  // Asserted against the source because the failure is structural — the route
  // answers 202 either way, and only the row it leaves behind differs.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes.js'), 'utf8');

  assert.ok(
    src.includes('moduleQueue.enqueue('),
    'the run route must put the queued modules on the queue',
  );
  assert.ok(
    src.includes('QUEUED_MODULES'),
    'the set of queue-only modules must be named here',
  );
  // The constant that drove the old behaviour. Asserted by name rather than by
  // scanning for the word "detached", which also appears in the prose above and
  // in the audit route's own (correct) description of its background loop.
  assert.ok(
    !src.includes('DETACHED_MODULES'),
    'no route may start a module run detached inside the request — the reaper '
    + 'cannot tell such a row from a dead worker, and reclaims it mid-flight',
  );
  assert.ok(
    !/runModule\(\{[^}]*detached/s.test(src),
    'runModule must not be handed a detached flag from a route',
  );
});

test('a queued run is not terminal, so a click is not reported as finished', () => {
  // enqueue() writes `queued`, and both pollers ask the overview whether the
  // module is still going. moduleEvidence classes anything non-terminal as
  // in-flight and evidenceCard turns that into `running`. If `queued` ever
  // became terminal, every click would report "Measuring finished" instantly.
  assert.ok(!moduleEvidence.TERMINAL.includes('queued'), 'queued must not be terminal');
  assert.ok(!moduleEvidence.TERMINAL.includes('running'), 'running must not be terminal');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
