#!/usr/bin/env node
// ── Run hub and spoke end to end on one site, entirely in this process ────────
//
// Crawls a site with the real CrawlScope crawler, then runs the real hub_spoke
// module runner over that crawl — informational page selection, clustering,
// naming, hub selection, diagnostics — and writes out what a reader would see:
// the run's note and findings, the clusters with their hubs and spokes, what
// was left out and why, and the Excel export.
//
// NOTHING touches a database. services/db is replaced by an in-memory fake
// before anything loads it, and DATABASE_URL is pointed at a port nothing
// listens on, so a code path that slipped past the fake would fail rather than
// write somewhere real. (The repo's .env points at the production database.)
//
// It does make real model calls when ANTHROPIC_API_KEY is in .env — a few cents
// per site — and a real crawl of the site, politely spaced.
//
// Usage (from server/):
//   node scripts/hubSpokeLocalRun.js --url=https://www.example.com [--max=400] [--recrawl] [--out=DIR]
//
//   --max      crawl URL cap (default 400)
//   --recrawl  ignore the cached crawl for this host and fetch again
//   --out      where to write <host>.* files (default: os tmpdir/hub-spoke-local)
//   --no-ai    run selection and naming without the model

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => args.includes(`--${name}`);

// ── Keep every write off real databases, before any module loads ─────────────
process.env.DATABASE_URL = 'postgres://offline:offline@127.0.0.1:1/offline';
process.env.HUB_SPOKE_AUTOSTART = 'off';
{
  const envFile = path.join(__dirname, '..', '..', '.env');
  if (!flag('no-ai') && fs.existsSync(envFile)) {
    const parsed = require('dotenv').parse(fs.readFileSync(envFile));
    // Only the model key is taken from .env — never its database settings.
    if (!process.env.ANTHROPIC_API_KEY && parsed.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
    }
  }
  if (flag('no-ai')) process.env.ANTHROPIC_API_KEY = '';
}

const { createFakeDb } = require('../modules/projects/__tests__/helpers/fakeDb');

const tables = {
  crawl_runs: [],
  project_module_runs: [],
  content_architect_projects: [],
  content_architect_artifacts: [],
};
const fake = createFakeDb(tables, {
  unique: {
    content_architect_projects: [{
      columns: ['platform_project_id'],
      where: (row) => row.platform_project_id !== null && row.platform_project_id !== undefined,
    }],
    content_architect_artifacts: [{ columns: ['project_id', 'kind'] }],
  },
});
// The crawl's pages and links, served to crawlToArchitect's paged reads.
const crawlStore = { results: [], links: [] };
const db = Object.create(fake);
db.rows = async (sql, params) => {
  if (/from crawl_run_results|from crawl_run_links/.test(sql)) {
    const lastId = params[params.length - 2];
    const limit = params[params.length - 1];
    const source = /crawl_run_links/.test(sql) ? crawlStore.links : crawlStore.results;
    return source.filter((r) => r.id > lastId).slice(0, limit);
  }
  return fake.rows(sql, params);
};
const dbPath = require.resolve('../services/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

// ── Crawl ─────────────────────────────────────────────────────────────────────

async function crawl(url, maxUrls) {
  const { SeoCrawler } = require('../modules/crawlScope/crawler');
  const { createFetch } = require('../modules/crawlScope/net/egress');
  const crawler = new SeoCrawler({
    maxUrls,
    concurrency: 4,
    perHostDelay: 150,
    timeout: 20000,
    checkExternalLinks: false,
    crawlAssets: false,
    renderCheck: false,
    fetch: createFetch({ mode: 'direct' }),
  });
  let last = 0;
  crawler.on('progress', (p) => {
    const now = Date.now();
    if (now - last > 15000) { last = now; console.log(`  crawl: ${p.completed ?? '?'} done, ${p.queued ?? '?'} queued`); }
  });
  const summary = await crawler.start(url);
  return {
    url,
    maxUrls,
    crawledAt: new Date().toISOString(),
    stopped: Boolean(summary.stopped),
    truncated: Boolean(summary.truncated),
    budgetReached: Boolean(summary.budgetReached),
    depthLimited: Boolean(summary.depthLimited),
    edgesTruncated: Boolean(summary.edgesTruncated),
    results: summary.results,
    linkEdges: (summary.linkEdges || []).filter((e) => e.internal && e.sourceUrl && e.targetUrl)
      .map((e) => ({ sourceUrl: e.sourceUrl, targetUrl: e.targetUrl })),
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

function pathOf(url) {
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return url; }
}

function textReport({ host, crawlData, result, analysis }) {
  const out = [];
  const line = (s = '') => out.push(s);
  const byId = new Map((analysis?.pages || []).map((p) => [p.id, p]));
  line(`HUB AND SPOKE — ${host}`);
  line(`crawl: ${crawlData.results.filter((r) => r.scope === 'Internal').length} internal results, `
    + `${crawlData.linkEdges.length} internal links, cap ${crawlData.maxUrls}`
    + `${crawlData.budgetReached ? ' (budget reached)' : ''}`);
  line();
  line(`status: ${result.status || 'completed'}   score: ${result.score ?? '—'}   band: ${result.band ?? '—'}`);
  line(`card:   ${result.payload?.cardNote || '—'}`);
  line(`note:   ${result.note}`);
  line();
  const sel = analysis?.selection?.summary || result.payload;
  const disc = analysis?.selection?.summary?.discovery;
  if (disc) {
    line(`DISCOVERY  candidates ${disc.candidates}: ${disc.fromSitemap} from sitemap, ${disc.fromListings} only from listings`);
    line(`  sitemap: ${disc.sitemap?.mode} ${disc.sitemap?.source || ''} (${disc.sitemap?.count} URLs${disc.sitemap?.capped ? ', capped' : ''})`);
    line(`  menus: ${disc.menu?.header} header links, ${disc.menu?.footer} footer links; informational: ${(disc.menu?.informational || []).map((m) => `${m.label || '?'} ${pathOf(m.url)}`).join(', ') || 'none'}`);
    for (const l of disc.listings || []) line(`  listing ${pathOf(l.url)} (${l.label || '?'}): ${l.pagesWalked} page(s), ${l.found} links — ${l.stoppedBecause}`);
    line();
  }
  if (sel) {
    line(`SELECTION  method=${sel.method || sel.selectionMethod || '—'}`);
    for (const r of sel.excludedByReason || []) line(`  left out ${String(r.count).padStart(5)}  ${r.label}`);
    for (const t of (analysis?.selection?.summary?.templates || []).slice(0, 30)) {
      line(`  template ${String(t.count).padStart(4)} ${t.pattern.padEnd(50)} ${t.category.padEnd(13)} ${t.source.padEnd(11)} kept ${t.included}`);
    }
    for (const l of (analysis?.selection?.summary?.limitations || [])) line(`  ! ${l}`);
    line();
  }
  if (!analysis) {
    line('(no analysis saved)');
    return out.join('\n');
  }
  line(`FINDINGS`);
  for (const f of result.findings || []) line(`  [${f.severity}] ${f.title} — ${f.count}`);
  line();
  line(`CLUSTERS (${analysis.clusters.length})   pages ${analysis.pages.length}, unassigned ${analysis.unassignedPages.length}`);
  for (const c of [...analysis.clusters].sort((a, b) => (a.health ?? 0) - (b.health ?? 0))) {
    const hub = c.hubPageId ? byId.get(c.hubPageId) : null;
    line(`■ ${c.name}   health ${c.health}   ${c.isGap ? 'HUB MISSING' : `hub (${c.hubConfidence})`}`);
    if (hub) line(`    hub:   ${pathOf(hub.url)}   “${hub.title || ''}”`);
    else if (c.gapSuggestion) line(`    suggested hub: “${c.gapSuggestion.title}”  ${c.gapSuggestion.slug}`);
    for (const id of c.spokeIds) {
      const p = byId.get(id);
      line(`    spoke: ${pathOf(p?.url)}   “${(p?.title || '').slice(0, 80)}”`);
    }
  }
  line();
  line(`UNASSIGNED (${analysis.unassignedPages.length})`);
  for (const p of analysis.unassignedPages.slice(0, 40)) {
    line(`  ${pathOf(p.url)}   nearest: ${p.nearestCluster?.clusterName || '—'} (${(p.nearestCluster?.similarity ?? 0).toFixed(2)})`);
  }
  line();
  line('LIMITATIONS');
  for (const l of result.payload?.limitations || []) line(`  - ${l}`);
  return out.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const url = option('url');
  if (!url) throw new Error('--url is required');
  const maxUrls = Number(option('max', 400));
  const host = new URL(url).host.replace(/^www\./, '');
  const outDir = option('out', path.join(os.tmpdir(), 'hub-spoke-local'));
  fs.mkdirSync(outDir, { recursive: true });
  const crawlFile = path.join(outDir, `${host}.crawl.json`);

  let crawlData;
  if (!flag('recrawl') && fs.existsSync(crawlFile)) {
    crawlData = JSON.parse(fs.readFileSync(crawlFile, 'utf8'));
    console.log(`Using cached crawl of ${host} (${crawlData.crawledAt}).`);
  } else {
    console.log(`Crawling ${url} (cap ${maxUrls})…`);
    crawlData = await crawl(url, maxUrls);
    fs.writeFileSync(crawlFile, JSON.stringify(crawlData));
  }

  // Rows and links as crawl_run_results / crawl_run_links hold them.
  let id = 0;
  crawlStore.results = crawlData.results
    .filter((r) => r.scope === 'Internal')
    .map((r) => ({ id: ++id, url: r.url, status: r.status || null, indexability: r.indexability || null, data: r }));
  crawlStore.links = crawlData.linkEdges.map((e) => ({ id: ++id, from_url: e.sourceUrl, to_url: e.targetUrl }));

  const projectId = '00000000-0000-4000-8000-000000000001';
  tables.crawl_runs.push({
    id: 'local-crawl', project_id: projectId, status: crawlData.stopped ? 'stopped' : 'completed',
    finished_at: crawlData.crawledAt, created_at: crawlData.crawledAt,
    summary: {
      truncated: crawlData.truncated, budgetReached: crawlData.budgetReached,
      depthLimited: crawlData.depthLimited, edgesTruncated: crawlData.edgesTruncated,
    },
    options: { maxUrls: crawlData.maxUrls },
  });

  const { RUNNERS } = require('../modules/projects/moduleRunners');
  const caStore = require('../modules/contentArchitect/store');
  const exporter = require('../modules/contentArchitect/exporter');

  const project = { id: projectId, workspace_id: null, url: new URL(url).origin, name: host };
  const domains = [{ role: 'primary', status: 'active', normalized_origin: new URL(url).origin }];

  console.log('Running hub_spoke…');
  const started = Date.now();
  const result = await RUNNERS.hub_spoke({ project, domains });
  const caProject = (await caStore.listProjects()).find((p) => p.platformProjectId === projectId);
  const analysis = caProject ? await caStore.getFullAnalysis(caProject.id) : null;
  console.log(`hub_spoke finished in ${Math.round((Date.now() - started) / 1000)}s`);

  // --compare: what the previous approach — informational pages chosen from
  // the site crawl's own pages — would have clustered, against discovery.
  let comparison = '';
  if (flag('compare')) {
    const c2a = require('../modules/projects/crawlToArchitect');
    const old = await c2a.buildFromCrawl('local-crawl', {
      maxUrls: crawlData.maxUrls,
      crawlSummary: tables.crawl_runs[0].summary,
      crawlStatus: tables.crawl_runs[0].status,
    });
    const key = (u) => { try { const x = new URL(u); return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`; } catch { return u; } };
    const oldSet = new Map((old.crawlResult?.pages || []).map((p) => [key(p.url), p.url]));
    const newSet = new Map((analysis?.pages || []).map((p) => [key(p.url), p.url]));
    const both = [...newSet.keys()].filter((k) => oldSet.has(k));
    const newOnly = [...newSet.keys()].filter((k) => !oldSet.has(k)).map((k) => newSet.get(k));
    const oldOnly = [...oldSet.keys()].filter((k) => !newSet.has(k)).map((k) => oldSet.get(k));
    const lines = [
      '',
      'COMPARISON — discovery (new) vs crawl-based selection (previous)',
      `  new: ${newSet.size} informational pages   previous: ${oldSet.size}${old.tooFewInformational ? ' (too few to cluster)' : ''}   in both: ${both.length}`,
      `  found only by discovery (${newOnly.length}):`,
      ...newOnly.slice(0, 25).map((u) => `    + ${pathOf(u)}`),
      `  found only by the crawl (${oldOnly.length}):`,
      ...oldOnly.slice(0, 25).map((u) => `    - ${pathOf(u)}`),
    ];
    comparison = lines.join('\n');
  }

  fs.writeFileSync(path.join(outDir, `${host}.result.json`), JSON.stringify({ result, analysis }, null, 2));
  const report = textReport({ host, crawlData, result, analysis }) + comparison;
  fs.writeFileSync(path.join(outDir, `${host}.report.txt`), report);
  if (analysis) {
    const wb = await exporter.buildWorkbook(analysis, { domain: project.url, name: host });
    await wb.xlsx.writeFile(path.join(outDir, `${host}.xlsx`));
  }
  console.log(report);
  console.log(`\nWritten to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
