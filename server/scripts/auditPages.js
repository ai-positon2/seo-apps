'use strict';

// ── Batch SEO & GEO audit runner ─────────────────────────────────────────────
// Runs the same check engine the SEO & GEO Audit / Snapshot tools use, against
// a list of real URLs, without going through the HTTP route or the UI. Useful
// for regression-checking the module itself against real pages.
//
// Usage:
//   node scripts/auditPages.js [batch.json] [--full]
//
// batch.json defaults to scripts/audit-batch.sample.json. Format:
//   [ { "url": "https://...", "keywords": ["primary kw","secondary kw"], "pageIntent": "auto" }, ... ]
//
// An entry may set "htmlFile" (path relative to the batch.json file, or absolute) to audit
// a locally cached copy of the page instead of fetching "url" live — useful for regression
// runs against a snapshot when the live site is unreachable.
//
// --full writes the complete runAllChecks() output for each page to
// scripts/audit-results/<slug>.json for deeper inspection.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runAllChecks } = require('../checks/seoGeoChecks');

async function fetchHtml(url) {
  const resp = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: () => true,
  });
  return { html: typeof resp.data === 'string' ? resp.data : String(resp.data), status: resp.status };
}

function loadHtml(page, batchDir) {
  if (page.htmlFile) {
    const file = path.isAbsolute(page.htmlFile) ? page.htmlFile : path.join(batchDir, page.htmlFile);
    return Promise.resolve({ html: fs.readFileSync(file, 'utf8'), status: 200 });
  }
  return fetchHtml(page.url);
}

function slugFor(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function summarize(url, result) {
  const s = result.scores;
  const lines = [];
  lines.push(`\n=== ${url} ===`);
  lines.push(`intent: ${result.pageIntent} (${result.pageIntentSource}) | page_type: ${result.pageContext.pageType} (conf ${result.pageContext.pageTypeConfidence})`);
  lines.push(`overall: ${s.overall} (${s.band.label}) | composite: ${s.composite}${s.cap ? ` | CAPPED at ${s.cap.value}: ${s.cap.groups.map(g=>g.reason).join('; ')}` : ''}`);
  lines.push(`bars: ${s.breakdown.map(b => `${b.label}=${b.score}(${b.checks_scored})`).join('  ')}`);
  lines.push(`counts: errors=${s.counts.errors} warnings=${s.counts.warnings} notices=${s.counts.notices} passed=${s.counts.passed} na=${s.counts.na} skipped=${s.counts.skipped}`);
  lines.push(`answerability: ${result.geo.answerability_rubric} ${result.geo.answerability_score}/10 (${JSON.stringify(result.geo.answerability_breakdown.map(b => `${b.key}:${b.points}/${b.max}`))})`);
  const errs = result.checks.filter(c => c.status === 'fail');
  if (errs.length) {
    lines.push('errors:');
    errs.forEach(c => lines.push(`  ${c.id} [${c.severity}] ${c.category} — ${c.detail}`));
  }
  if (result.kwChecks && result.kwChecks.length) {
    lines.push('keyword checks:');
    result.kwChecks.forEach(c => lines.push(`  ${c.id.padEnd(6)} ${c.status.padEnd(9)} ${(c.tier || '').padEnd(22)} ${c.detail}`));
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const batchPath = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'audit-batch.sample.json');
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const batchDir = path.dirname(batchPath);

  const resultsDir = path.join(__dirname, 'audit-results');
  if (full) fs.mkdirSync(resultsDir, { recursive: true });

  for (const page of batch) {
    try {
      const { html, status } = await loadHtml(page, batchDir);
      if (status !== 200) {
        console.log(`\n=== ${page.url} ===\nHTTP ${status} — skipped.`);
        continue;
      }
      const result = await runAllChecks(html, page.url, {}, page.keywords || [], { pageIntent: page.pageIntent || 'auto' });
      console.log(summarize(page.url, result));
      if (full) {
        const file = path.join(resultsDir, `${slugFor(page.url)}.json`);
        fs.writeFileSync(file, JSON.stringify(result, null, 2));
        console.log(`(full output: ${file})`);
      }
    } catch (err) {
      console.log(`\n=== ${page.url} ===\nERROR: ${err.message}`);
    }
  }
}

main();
