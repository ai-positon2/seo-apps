#!/usr/bin/env node
// ── Which pages would hub and spoke cluster? An offline before/after ─────────
//
// Runs informational page selection over the page sets saved by earlier
// project-linked Content Architect runs (server/modules/contentArchitect/data/,
// gitignored — local only) and prints, per site, how many pages the old run
// clustered, how many the new selection keeps, and why the rest are left out.
//
// Nothing is written anywhere and nothing touches the database. The saved pages
// predate the crawl fields selection reads, so noindex comes from the saved
// `noindex` flag and inlinks from `inboundLinkCount`; canonicals are as saved.
//
// Usage (from server/):
//   node scripts/contentArchitectSelectionReport.js                # URL rules only, free
//   node scripts/contentArchitectSelectionReport.js --ai           # real model calls (costs cents)
//   node scripts/contentArchitectSelectionReport.js --site=brushandfloss --urls
//
//   --ai         use the model (needs ANTHROPIC_API_KEY in .env)
//   --site=TEXT  only sites whose domain contains TEXT
//   --urls       list every included URL, and the excluded ones by reason

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

const DATA_DIR = path.join(__dirname, '..', 'modules', 'contentArchitect', 'data');

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`No saved analyses at ${DATA_DIR} — nothing to compare. (The folder is local only.)`);
    return;
  }
  if (flag('ai')) {
    const envFile = path.join(__dirname, '..', '..', '.env');
    require('dotenv').config({ path: envFile });
    // dotenv never overrides, so an EMPTY variable already in the shell hides
    // the file's key and reads as "no key". Fill only that one, only if empty.
    if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(envFile)) {
      const parsed = require('dotenv').parse(fs.readFileSync(envFile));
      if (parsed.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    }
  }

  const { selectInformationalPages } = require('../modules/contentArchitect/informationalSelection');
  const { createInformationalClassifier } = require('../modules/contentArchitect/informationalClassifier');
  const classifier = flag('ai') ? createInformationalClassifier() : null;
  if (flag('ai') && !classifier) {
    console.log('--ai needs ANTHROPIC_API_KEY; running on URL rules instead.\n');
  }

  let domains = {};
  const projectsFile = path.join(DATA_DIR, 'projects.json');
  if (fs.existsSync(projectsFile)) {
    const raw = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    const list = Array.isArray(raw) ? raw : Object.values(raw.projects || raw);
    domains = Object.fromEntries(list.map((p) => [p.id, p.domain]));
  }

  const siteFilter = option('site');
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_full_analysis.json')).sort();

  for (const file of files) {
    const id = file.replace('_full_analysis.json', '');
    const domain = domains[id] || id;
    if (siteFilter && !String(domain).includes(siteFilter)) continue;

    const analysis = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    const pages = analysis.pages || [];
    const candidates = pages.map((p) => ({
      url: p.url,
      canonical: p.canonical || null,
      indexability: p.noindex ? 'Non-indexable' : 'Indexable',
      inlinks: Number(p.inboundLinkCount) || 0,
    }));

    // eslint-disable-next-line no-await-in-loop
    const selection = await selectInformationalPages(candidates, { classifier });
    const s = selection.summary;

    console.log(`\n══ ${domain}  (${id})`);
    console.log(`   old run clustered: ${pages.length} pages in ${(analysis.clusters || []).length} clusters`);
    console.log(`   informational now: ${s.analysedPageCount} of ${s.crawledPageCount}   [method: ${s.method}]`);
    console.log('   left out:');
    for (const r of s.excludedByReason) console.log(`     ${String(r.count).padStart(5)}  ${r.label}`);
    console.log('   templates (2+ pages):');
    for (const t of s.templates.slice(0, 25)) {
      console.log(`     ${String(t.count).padStart(5)}  ${t.pattern.padEnd(48)} ${t.category.padEnd(14)} ${t.source.padEnd(11)} kept ${t.included}`);
    }
    if (s.templates.length > 25) console.log(`     … ${s.templates.length - 25} more`);
    for (const line of s.limitations) console.log(`   ! ${line}`);

    if (flag('urls')) {
      console.log('   included:');
      for (const i of selection.includedIdx) console.log(`     + ${candidates[i].url}`);
      console.log('   excluded:');
      for (const e of selection.excluded) console.log(`     - [${e.code}] ${e.url}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
