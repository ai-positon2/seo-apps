#!/usr/bin/env node
// ── The server test runner ───────────────────────────────────────────────────
//
// `npm test` used to be 59 commands joined with `&&` on one 4,500-character
// line. That has two costs, and the second one is the expensive one:
//
//   • It is unreadable and unmaintainable. Adding a suite meant editing a line
//     no editor will wrap usefully.
//   • `&&` STOPS AT THE FIRST FAILURE. One broken suite hid the 55 after it, so
//     a run told you about exactly one problem per invocation — and a run that
//     died on suite 4 looked identical to one where everything after it was
//     also broken. That is precisely what happened with the Location Page
//     Builder reference data: one missing file, one stack trace, and no signal
//     at all about the other 55 suites.
//
// This runs every suite, reports each one's outcome as it goes, and prints a
// summary of everything that failed at the end. Exit code is unchanged: zero
// only when every suite passed.
//
// The list is explicit and ordered, not globbed. Globbing would silently pick
// up helpers and fixtures under __tests__ and would change what runs whenever
// somebody adds a file, which is not a property a test command should have.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SUITES = [
  'routes/__tests__/auth.test.js',
  'routes/__tests__/workspaces.test.js',
  'locationPageBuilder/__tests__/run.js',
  'locationPageBuilder/__tests__/lsPages.test.js',
  'middleware/__tests__/runTracking.test.js',
  'services/__tests__/runStore.test.js',
  'services/__tests__/platformFoundation.test.js',
  'services/__tests__/projectAccessDb.test.js',
  'modules/projects/__tests__/projects.test.js',
  'modules/projects/__tests__/competitorProposals.test.js',
  'modules/projects/__tests__/contentArchitect.test.js',
  'modules/projects/__tests__/homepageAutostart.test.js',
  'modules/projects/__tests__/competitorAutostart.test.js',
  'modules/projects/__tests__/projectPurge.test.js',
  'services/__tests__/appendOnlySchema.test.js',
  'modules/projects/__tests__/moduleEvidence.test.js',
  'modules/projects/__tests__/hubSpoke.test.js',
  'modules/projects/__tests__/moduleDetail.test.js',
  'modules/projects/__tests__/moduleReportRoute.test.js',
  'modules/projects/__tests__/perPageAudits.test.js',
  'modules/competitorAnalysis/__tests__/pageTaxonomy.test.js',
  'modules/projects/__tests__/insights.test.js',
  'modules/projects/__tests__/executiveSummary.test.js',
  'modules/projects/__tests__/pages.test.js',
  'modules/projects/__tests__/streamingAudit.test.js',
  'modules/projects/__tests__/pageSelection.test.js',
  'modules/aiVisibility/__tests__/capture.test.js',
  'modules/aiVisibility/__tests__/settle.test.js',
  'modules/aiVisibility/__tests__/run.test.js',
  'modules/aiVisibility/__tests__/scoring.test.js',
  'modules/aiVisibility/__tests__/promptLifecycle.test.js',
  'modules/aiVisibility/__tests__/store.test.js',
  'modules/aiVisibility/__tests__/promptTopics.test.js',
  'modules/aiVisibility/__tests__/promptValidator.test.js',
  'modules/aiVisibility/__tests__/chatgptExtract.test.js',
  'modules/aiVisibility/__tests__/geminiExtract.test.js',
  'modules/aiVisibility/__tests__/googleExtract.test.js',
  'modules/aiVisibility/__tests__/brandAliases.test.js',
  'modules/aiVisibility/__tests__/mentionExtract.test.js',
  'modules/aiVisibility/__tests__/domainClassify.test.js',
  'modules/aiVisibility/__tests__/llmExtract.test.js',
  'modules/aiVisibility/__tests__/extractionPass.test.js',
  'modules/aiVisibility/__tests__/metricsFormat.test.js',
  'modules/aiVisibility/__tests__/metricsCore.test.js',
  'modules/aiVisibility/__tests__/metricsPeriod.test.js',
  'modules/aiVisibility/__tests__/metricsReports.test.js',
  // AI Visibility Lite — the API-based module. Its suites are pure (fake
  // surfaces, rows in memory) and need no database.
  'modules/aiVisibilityLite/__tests__/measure.test.js',
  'modules/aiVisibilityLite/__tests__/report.test.js',
  'modules/aiVisibilityLite/__tests__/promptGen.test.js',
  'modules/aiVisibility/__tests__/captureScheduler.test.js',
  'modules/aiVisibility/__tests__/proxyPool.test.js',
  'modules/aiVisibility/__tests__/surfaceAvailability.test.js',
  'modules/aiVisibility/__tests__/surfaceContract.test.js',
  'modules/aiVisibility/__tests__/redirectSafety.test.js',
  'modules/aiVisibility/__tests__/provenance.test.js',
  'modules/aiVisibility/__tests__/budgetRetention.test.js',
  'services/__tests__/moduleQueue.test.js',
  'services/__tests__/moduleScheduler.test.js',
  'modules/projects/__tests__/recommendations.test.js',
  'modules/projects/__tests__/report.test.js',
  'config/__tests__/registry.test.js',
  'config/__tests__/moduleRuns.test.js',];

// The crawlScope suite runs through its own script, which picks the right
// --test-isolation spelling for the Node version in use. See testCrawlScope.js.
const EXTRA = [['crawlScope (node:test)', [path.join(__dirname, 'testCrawlScope.js')]]];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const match = (name) => !only.length || only.some((f) => name.includes(f));

const jobs = [
  ...SUITES.map((s) => [s, [s]]),
  ...EXTRA,
].filter(([name]) => match(name));

if (!jobs.length) {
  console.error(`No suite matches ${only.join(', ')}.`);
  process.exit(1);
}

const failures = [];
const started = Date.now();

for (const [name, args] of jobs) {
  const at = Date.now();
  const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const ms = Date.now() - at;

  // A suite killed by a signal has a null exit code. Treating that as a pass is
  // how an out-of-memory test run goes green.
  const ok = run.status === 0 && !run.signal;
  if (!ok) {
    failures.push({
      name,
      why: run.error ? run.error.message
        : run.signal ? `killed by ${run.signal}`
          : `exit ${run.status}`,
    });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${(ms / 1000).toFixed(1)}s)`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${jobs.length - failures.length}/${jobs.length} suites passed in ${secs}s`);

if (failures.length) {
  // Repeated at the bottom because the output above is thousands of lines long
  // and the reader has scrolled past every one of these.
  console.error(`\n${failures.length} suite(s) failed:`);
  for (const f of failures) console.error(`  ${f.name} — ${f.why}`);
  process.exit(1);
}
