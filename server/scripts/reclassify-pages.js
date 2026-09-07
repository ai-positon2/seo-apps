#!/usr/bin/env node
// ── Re-classify stored top pages, and report what moved ─────────────────────
//
//   node scripts/reclassify-pages.js --list
//   node scripts/reclassify-pages.js "Palo Alto Networks"
//   node scripts/reclassify-pages.js "Palo Alto Networks" --dry-run
//   node scripts/reclassify-pages.js --all
//
// Re-runs the classifier over pages already stored and prints a diff by subtype.
// Reads no SEMrush data and re-fetches nothing — the URLs and titles are already
// on the snapshot; only the types are recomputed. One model call per 125 pages.
//
// This exists because a taxonomy is edited more often than a crawl is run, and
// without a diff an edit is unauditable: the counts move and nobody can say
// which pages moved or whether the move was right. --dry-run prints the diff and
// writes nothing.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const store = require('../modules/competitorAnalysis/store');
const { reclassifyTopPages } = require('../modules/competitorAnalysis/contentAnalysis/orchestrator');
const { TAXONOMY_VERSION } = require('../modules/competitorAnalysis/contentAnalysis/pageTaxonomy');
const { CLASSIFIER_VERSION, MODEL } = require('../modules/competitorAnalysis/contentAnalysis/pageClassifier');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const listOnly = args.includes('--list');
const name = args.find((a) => !a.startsWith('--')) || null;

const pad = (s, n) => String(s).padEnd(n);

function printDiff(diff) {
  console.log(`\n  ${diff.changed} of ${diff.pages} pages changed subtype (${diff.unchanged} unchanged)\n`);
  console.log(`  ${pad('subtype', 26)} ${pad('before', 8)} ${pad('after', 8)} delta`);
  console.log(`  ${'-'.repeat(26)} ${'-'.repeat(8)} ${'-'.repeat(8)} -----`);
  for (const [subtype, v] of Object.entries(diff.bySubtype)) {
    const delta = v.delta > 0 ? `+${v.delta}` : String(v.delta);
    console.log(`  ${pad(subtype, 26)} ${pad(v.before, 8)} ${pad(v.after, 8)} ${delta}`);
  }
  if (diff.moved.length) {
    const show = diff.moved.slice(0, 25);
    console.log(`\n  moved (${show.length} of ${diff.moved.length}):`);
    for (const m of show) {
      let path;
      try { path = new URL(m.url).pathname; } catch { path = m.url; }
      console.log(`    ${pad(`${m.from} -> ${m.to}`, 40)} ${path.slice(0, 60)}`);
    }
  }
}

(async () => {
  const clients = await store.getClients();

  if (listOnly || (!name && !all)) {
    console.log('clients with a stored content analysis:');
    for (const c of clients) {
      const ca = await store.getContentAnalysis(c.id).catch(() => null);
      const pages = (ca?.topPages?.domains || []).reduce((n, d) => n + (d.pages?.length || 0), 0);
      const v = ca?.topPages?.classifier;
      console.log(`  ${pad(c.name, 26)} ${pad(`${pages} pages`, 12)} `
        + `${v ? `taxonomy ${v.taxonomyVersion || '?'} / classifier ${v.classifierVersion || '?'}` : 'never classified'}`);
    }
    console.log(`\ncurrent: taxonomy ${TAXONOMY_VERSION}, classifier ${CLASSIFIER_VERSION}, model ${MODEL}`);
    console.log('\nusage: node scripts/reclassify-pages.js "<client name>" [--dry-run]   |   --all');
    process.exit(0);
  }

  const targets = all ? clients : clients.filter((c) => c.name === name);
  if (!targets.length) {
    console.error(`No client named "${name}". Run with --list to see them.`);
    process.exit(1);
  }

  for (const client of targets) {
    const previous = await store.getContentAnalysis(client.id).catch(() => null);
    if (!previous?.topPages?.domains?.length) {
      console.log(`\n${client.name}: no stored top pages — skipped.`);
      continue;
    }
    console.log(`\n=== ${client.name} ===`);
    const { snapshot, diff } = await reclassifyTopPages(previous);
    printDiff(diff);
    if (dryRun) {
      console.log('\n  --dry-run: nothing written.');
    } else {
      await store.saveContentAnalysis(client.id, snapshot);
      console.log(`\n  saved · taxonomy ${TAXONOMY_VERSION} · classifier ${CLASSIFIER_VERSION} · ${MODEL}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
