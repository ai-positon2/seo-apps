#!/usr/bin/env node
// ── Match every rival client list to a project (read-only) ──────────────────
//
// docs/design-audit/02-plan-one-client.md, step 1 ("inventory and match").
//
//   node scripts/clientListInventory.js [--out report.json]
//
// Reads projects and their primary domains, then every record in the four
// separate client lists (Competitor Analysis, Robots Monitor, Location Pages,
// Knowledge Base brand/feedback entries) and proposes a project for each by
// domain, then by name. Prints a summary and, with --out, writes the full
// report for review.
//
// It CANNOT write: the session is set to read-only before the first query, so
// even a bug here fails instead of changing data. It proposes; a person
// reviews; a separate fill step (after migration 0038) applies.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const db = require('../services/db');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

const hostOf = (value) => {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  try { return new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).host.replace(/^www\./, ''); } catch { return ''; }
};
const slug = (value) => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function propose(projects, { hosts = [], name = '' }) {
  const wanted = hosts.map(hostOf).filter(Boolean);
  const byHost = projects.filter((p) => p.hosts.some((h) => wanted.includes(h)));
  if (byHost.length === 1) return { projectId: byHost[0].id, projectName: byHost[0].name, how: 'domain' };
  if (byHost.length > 1) return { projectId: null, how: 'ambiguous', candidates: byHost.map((p) => p.name) };
  const s = slug(name);
  // Project display names carry " (workspace)"; match on the bare name.
  const bare = (p) => slug(p.name.replace(/ \([^)]*\)$/, ''));
  const byName = s ? projects.filter((p) => bare(p) === s || bare(p).startsWith(`${s}-`) || s.startsWith(`${bare(p)}-`)) : [];
  if (byName.length === 1) return { projectId: byName[0].id, projectName: byName[0].name, how: 'name' };
  if (byName.length > 1) return { projectId: null, how: 'ambiguous', candidates: byName.map((p) => p.name) };
  return { projectId: null, how: 'needs assigning' };
}

(async () => {
  if (!db.isDatabaseConfigured()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('set session characteristics as transaction read only');
    const q = async (sql) => (await client.query(sql)).rows;

    // Deleted projects are not candidates: a record should never be attached to
    // a project nobody can open. The workspace is kept so a person can tell two
    // same-named projects apart.
    const projectRows = await q(`
      select p.id, p.name, p.url, p.workspace_id, w.name as workspace_name,
             coalesce(array_agg(d.host) filter (where d.role = 'primary' and d.status = 'active'), '{}') as hosts
        from crawl_projects p
        left join project_domains d on d.project_id = p.id
        left join workspaces w on w.id = p.workspace_id
       where coalesce(p.lifecycle_status, 'active') <> 'deleted'
       group by p.id, p.name, p.url, p.workspace_id, w.name`);
    const projects = projectRows.map((p) => ({
      id: p.id, name: p.workspace_name ? `${p.name} (${p.workspace_name})` : p.name,
      hosts: [...(p.hosts || []), hostOf(p.url)].map(hostOf).filter(Boolean),
    }));

    const safe = async (sql) => { try { return await q(sql); } catch (e) { return { error: e.message }; } };
    const lists = {
      competitorAnalysis: await safe('select id, data from competitor_analysis_clients'),
      robotsMonitor: await safe('select id, data from robots_monitor_clients'),
      locationPages: await safe('select id, data from lpb_clients'),
    };

    const report = { generatedAt: new Date().toISOString(), projects: projects.length, lists: {} };
    const addList = (key, rows, describe) => {
      if (rows.error) { report.lists[key] = { error: rows.error }; return; }
      report.lists[key] = rows.map((r) => {
        const d = describe(r.data || {});
        return { id: r.id, name: d.name, hosts: d.hosts, ...propose(projects, d) };
      });
    };
    addList('competitorAnalysis', lists.competitorAnalysis, (d) => ({ name: d.name, hosts: [d.domain] }));
    addList('robotsMonitor', lists.robotsMonitor, (d) => ({ name: d.name, hosts: (d.domains || []).map((x) => x.url) }));
    addList('locationPages', lists.locationPages, (d) => ({ name: d.name, hosts: [d.brand_static?.base_url] }));

    // The Knowledge Base is a file index, not a table.
    const kbRoot = process.env.KB_ROOT && fs.existsSync(process.env.KB_ROOT)
      ? process.env.KB_ROOT : path.join(__dirname, '../../knowledge-base');
    try {
      const index = JSON.parse(fs.readFileSync(path.join(kbRoot, '_index.json'), 'utf8'));
      const clients = [...new Set((index.knowledge_bases || []).map((k) => k.client).filter((c) => c && c !== 'global'))];
      report.lists.knowledgeBase = clients.map((c) => ({ id: c, name: c, hosts: [], ...propose(projects, { name: c }) }));
      report.kbRoot = kbRoot;
    } catch (e) {
      report.lists.knowledgeBase = { error: `could not read ${kbRoot}/_index.json: ${e.message}` };
    }

    console.log(`Projects: ${projects.length}`);
    for (const [key, rows] of Object.entries(report.lists)) {
      if (!Array.isArray(rows)) { console.log(`${key}: ${rows.error}`); continue; }
      const counts = rows.reduce((acc, r) => { acc[r.how] = (acc[r.how] || 0) + 1; return acc; }, {});
      console.log(`${key}: ${rows.length} records — ${Object.entries(counts).map(([k, v]) => `${v} by ${k}`).join(', ') || 'none'}`);
      for (const r of rows.filter((x) => !x.projectId)) {
        console.log(`   needs a decision: ${r.name || r.id} (${r.how}${r.candidates ? `: ${r.candidates.join(' / ')}` : ''})`);
      }
    }
    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
      console.log(`Full report written to ${outFile}`);
    }
  } finally {
    client.release();
    await db.end().catch(() => {});
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
