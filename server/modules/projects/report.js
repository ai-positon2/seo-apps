// ── Project report (PRD phase 7) ─────────────────────────────────────────────
//
// One workbook assembling everything stored against a project: the audit
// profile, each module's findings, the hub-and-spoke structure, and the
// recommendation board with its decisions.
//
// The report is a rendering of stored rows and nothing else. It runs no audits,
// fetches no pages, and computes no new numbers — a report that measures things
// while producing itself would give a figure that cannot be reproduced from the
// database it claims to summarise.
//
// Where a module has no evidence, the workbook says so in words. An export is
// exactly where a blank cell gets read as a zero, so nothing is left blank: a
// sheet that would be empty carries a sentence explaining why instead.

const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const moduleEvidence = require('./moduleEvidence');
const recommendations = require('./recommendations');
const overview = require('./overview');
const insights = require('./insights');

// Same launch pattern as services/competitorPdfGenerator.js and
// routes/agentReadinessAudit.js's PDF export — reused rather than introducing
// a different document library for a third report.
function findLocalBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Matches the app's palette so an exported sheet does not look like a different
// product from the dashboard it came from.
const INK = 'FF1C1E24';
const ACCENT = 'FF2F5D50';
const MUTED = 'FF6B6B72';
const PAPER = 'FFF5F3EE';

const SEVERITY_FILL = {
  error: 'FFF8D7D5',
  warning: 'FFFDF0D5',
  notice: 'FFE8EAF0',
  info: 'FFE3EFE9',
};

function headerRow(sheet, labels, { width = [] } = {}) {
  const row = sheet.addRow(labels);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
  row.alignment = { vertical: 'middle' };
  row.height = 20;
  labels.forEach((_, i) => {
    if (width[i]) sheet.getColumn(i + 1).width = width[i];
  });
  sheet.views = [{ state: 'frozen', ySplit: row.number }];
  return row;
}

function note(sheet, text) {
  const row = sheet.addRow([text]);
  row.font = { italic: true, color: { argb: MUTED }, size: 10 };
  row.alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn(1).width = 110;
  return row;
}

function titleBlock(sheet, title, subtitle) {
  const t = sheet.addRow([title]);
  t.font = { bold: true, size: 15, color: { argb: INK } };
  t.height = 24;
  if (subtitle) {
    const s = sheet.addRow([subtitle]);
    s.font = { size: 10, color: { argb: MUTED } };
  }
  sheet.addRow([]);
}

/**
 * The audit profile: one row per module, with the score ONLY where the module
 * computes one, and the basis for it alongside.
 *
 * An empty score cell is deliberate and is labelled — "Not scored" with the
 * reason — because a blank in a spreadsheet is the single easiest place for a
 * missing measurement to be mistaken for a zero (§16.11).
 */
function addProfileSheet(book, { project, modules, composite }) {
  const sheet = book.addWorksheet('Audit profile', {
    properties: { tabColor: { argb: ACCENT } },
  });

  titleBlock(
    sheet,
    project.name,
    `${project.primaryDomain?.origin || project.legacyUrl || 'no primary domain'}`
    + `${project.countryCode ? ` · ${project.countryCode}` : ''}`,
  );

  headerRow(
    sheet,
    ['Module', 'Status', 'Score', 'Out of', 'Basis for the score', 'Errors', 'Warnings', 'Notices', 'Last run'],
    { width: [24, 20, 9, 9, 52, 9, 11, 10, 22] },
  );

  for (const module of modules) {
    const counts = module.evidence?.counts || {};
    const row = sheet.addRow([
      module.label,
      module.status === 'insufficient_data' ? 'Nothing to measure' : module.status,
      module.scored ? module.score : 'Not scored',
      module.scored ? 100 : '',
      module.scored
        ? (module.scoreBasis || 'the module reported a score without naming its basis')
        : 'This module reports findings, not a 0–100 score.',
      counts.error ?? '',
      counts.warning ?? '',
      counts.notice ?? '',
      module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : 'never',
    ]);
    if (!module.scored) {
      row.getCell(3).font = { italic: true, color: { argb: MUTED } };
      row.getCell(5).font = { italic: true, color: { argb: MUTED } };
    }
    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
  }

  sheet.addRow([]);
  const compositeRow = sheet.addRow([
    'Composite',
    composite.status,
    composite.value === null ? 'No composite' : composite.value,
    composite.value === null ? '' : 100,
    composite.value === null
      ? `Nothing has scored yet, so no composite is shown. It is not zero — ${composite.scoredModules} of ${composite.totalModules} modules scored.`
      : `Mean of the ${composite.scoredModules} module score(s) that exist, out of ${composite.totalModules} modules. Unscored modules are omitted, not counted as zero.`,
  ]);
  compositeRow.font = { bold: true, color: { argb: INK } };
  compositeRow.getCell(5).alignment = { wrapText: true, vertical: 'top' };
  compositeRow.getCell(5).font = { italic: true, color: { argb: MUTED }, bold: false };

  return sheet;
}

/** One sheet of findings per module that has any. */
function addFindingsSheets(book, evidenceByModule) {
  let added = 0;

  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;   // CrawlScope has its own workbook
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;

    const findings = Array.isArray(run.findings) ? run.findings : [];
    // Excel sheet names are capped at 31 chars and cannot contain : \\ / ? * [ ]
    const name = module.label.replace(/[:\\/?*[\]]/g, '').slice(0, 28);
    const sheet = book.addWorksheet(name);

    titleBlock(
      sheet,
      `${module.label} — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
      [
        run.target_url ? `Audited ${run.target_url}` : null,
        run.finished_at ? `on ${new Date(run.finished_at).toISOString().slice(0, 16).replace('T', ' ')}` : null,
        run.score !== null && run.score !== undefined ? `Score ${run.score}` : null,
      ].filter(Boolean).join(' · '),
    );

    if (!findings.length) {
      note(sheet, run.status === 'insufficient_data'
        ? 'This module ran and found nothing it could measure for this project. That is a real '
          + 'result, not a missing one.'
        : 'This module ran and reported no findings at error, warning or notice level.');
      added += 1;
      continue;
    }

    headerRow(
      sheet,
      ['Severity', 'Finding', 'Category', 'Affected', 'Detail', 'Recommendation'],
      { width: [11, 46, 20, 10, 60, 60] },
    );

    const rank = { error: 0, warning: 1, notice: 2, info: 3 };
    for (const f of [...findings].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.count - a.count)) {
      const row = sheet.addRow([
        f.severity, f.title, f.category || '', f.count,
        typeof f.detail === 'string' ? f.detail : (f.detail ? JSON.stringify(f.detail) : ''),
        f.recommendation || '',
      ]);
      row.getCell(1).fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: SEVERITY_FILL[f.severity] || SEVERITY_FILL.notice },
      };
      row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
      row.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    }
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 6 } };
    added += 1;
  }

  return added;
}

/** Hub-and-spoke structure, when a run stored one. */
function addStructureSheet(book, evidenceByModule) {
  const run = evidenceByModule.get('hub_spoke')?.terminal;
  if (!run) return null;

  const sheet = book.addWorksheet('Site structure');
  const payload = run.payload || {};
  const structure = payload.structure || {};

  titleBlock(
    sheet,
    'Internal link structure',
    run.status === 'insufficient_data'
      ? 'No link graph was available'
      : `${structure.pagesAnalyzed || 0} pages · ${structure.edgeCount || 0} internal links`,
  );

  if (run.status === 'insufficient_data') {
    // The evidence rows come from latestByModule, which projects the note out
    // of the payload rather than loading the payload itself — so `run.note` is
    // where the run's own explanation (e.g. too few informational pages) is.
    note(sheet, payload.note || run.note || 'No completed crawl with a stored link graph for this project yet.');
    return sheet;
  }

  headerRow(sheet, ['Measure', 'Value', 'What it means'], { width: [28, 12, 80] });
  const rows = [
    ['Pages analysed', structure.pagesAnalyzed, 'Internal pages the crawl reached.'],
    ['Internal links', structure.edgeCount, 'Link edges between those pages.'],
    ['Topic hubs', structure.hubCount, `Pages linking to at least ${structure.hubMinOutlinks} others, excluding site-wide navigation.`],
    ['Navigation hubs', structure.navigationHubCount, `Pages linking to ${Math.round((structure.navigationLinkShare || 0) * 100)}%+ of the site — header, footer or sitemap rather than a topic grouping.`],
    ['Clusters', structure.clusterCount, 'Topic hubs that actually have spokes.'],
    ['Orphans', structure.orphanCount, 'Pages nothing internal links to.'],
    ['Unclustered', structure.unclusteredCount, 'Linked, but only from navigation.'],
  ];
  for (const r of rows) {
    const row = sheet.addRow(r);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(3).font = { color: { argb: MUTED }, size: 10 };
  }

  if (structure.navigationTestApplied === false) {
    sheet.addRow([]);
    note(sheet,
      'This site has too few pages for the navigation test to be meaningful, so every wide-linking '
      + 'page was treated as a topic hub.');
  }

  if ((payload.clusters || []).length) {
    sheet.addRow([]);
    headerRow(sheet, ['Hub', 'Spokes', 'Linked from', 'Example spokes'], { width: [46, 9, 12, 80] });
    for (const cluster of payload.clusters) {
      const row = sheet.addRow([
        cluster.hub, cluster.spokes.length, cluster.inboundCount,
        cluster.spokes.slice(0, 8).join(', '),
      ]);
      row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    }
  }

  return sheet;
}

/** The recommendation board, with who decided what. */
function addRecommendationsSheet(book, items) {
  const sheet = book.addWorksheet('Recommendations');

  const byStatus = {};
  for (const r of items) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  titleBlock(
    sheet,
    `Recommendations — ${items.length}`,
    recommendations.STATUSES.map((s) => `${byStatus[s] || 0} ${s}`).join(' · '),
  );

  if (!items.length) {
    note(sheet, 'No recommendations have been raised for this project yet. Findings become '
      + 'recommendations when somebody decides they are worth advising on.');
    return sheet;
  }

  headerRow(
    sheet,
    ['Status', 'Priority', 'Recommendation', 'From', 'Detail', 'Decided', 'Reason if rejected', 'Shipped'],
    { width: [11, 10, 46, 16, 60, 20, 40, 20] },
  );

  const order = { proposed: 0, approved: 1, draft: 2, shipped: 3, rejected: 4 };
  for (const r of [...items].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))) {
    const decided = r.approvedAt || r.rejectedAt || r.proposedAt;
    const row = sheet.addRow([
      r.status,
      r.priority,
      r.title,
      r.moduleKey || 'raised by hand',
      r.body || '',
      decided ? new Date(decided).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.rejectionReason || '',
      r.shippedAt ? new Date(r.shippedAt).toISOString().slice(0, 10) : '',
    ]);
    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  }
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 8 } };

  return sheet;
}

/**
 * What this report does NOT cover.
 *
 * The most useful sheet in an audit export, and the one usually missing: a
 * reader has to be able to tell the difference between "we measured this and it
 * was fine" and "we never measured this". §30 asks for capability gaps to be
 * surfaced rather than left as silence.
 */
function addCoverageSheet(book, { modules, generatedAt }) {
  const sheet = book.addWorksheet('Coverage and gaps');
  titleBlock(sheet, 'What this report covers', `Generated ${generatedAt}`);

  headerRow(sheet, ['Module', 'Covered?', 'Why'], { width: [24, 14, 96] });

  for (const module of modules) {
    const covered = Boolean(module.evidence) || module.status === 'insufficient_data';
    const row = sheet.addRow([
      module.label,
      covered ? 'yes' : 'no',
      covered
        ? (module.status === 'insufficient_data'
          ? 'Ran, but had nothing it could measure for this project.'
          : `Stored evidence from ${module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 10) : 'an earlier run'}.`)
        : 'Never run against this project, so nothing here reflects it.',
    ]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    if (!covered) row.getCell(2).font = { color: { argb: 'FFB3261E' }, bold: true };
  }

  sheet.addRow([]);
  note(sheet,
    'Every figure in this workbook is read from stored rows. Nothing was measured while the '
    + 'report was produced, and no score was computed here — each score is the one its own module '
    + 'calculated, with its basis stated on the audit profile sheet. Where a module has no score, '
    + 'the cell says "Not scored" rather than being left blank, because a blank cell in a '
    + 'spreadsheet reads as a zero.');

  return sheet;
}

/**
 * Everything all three formats need, gathered once. Same stored-rows-only
 * contract as build() below — nothing here runs an audit or computes a score.
 */
async function gather({ access }) {
  const store = require('./store');
  const project = await store.getProject(access.project);

  const [profile, evidenceByModule, recos, backlogBuilt] = await Promise.all([
    overview.buildOverview({ access }),
    moduleEvidence.latestByModule(access.project.id),
    recommendations.list(access.project.id, { limit: 500 }),
    insights.buildInsights({ access }),
  ]);

  // Same composition the dashboard's own Executive Summary card reads —
  // GET /:projectId/executive-summary — so the PDF's narrative says exactly
  // what the app already told this reader, not a second, differently-worded
  // opinion about the same evidence.
  const executiveSummary = insights.executive.buildExecutiveSummary({
    overview: profile,
    backlog: backlogBuilt.backlog,
  });

  return { project, profile, evidenceByModule, recos, executiveSummary };
}

function slugify(name) {
  return String(name || 'project')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

/**
 * Builds the workbook.
 *
 * @param {object} input
 * @param {object} input.access  from projectAccess.requireProject
 * @returns {Promise<{buffer: Buffer, filename: string, sheets: string[]}>}
 */
async function build({ access }) {
  const { project, profile, evidenceByModule, recos } = await gather({ access });

  const book = new ExcelJS.Workbook();
  book.creator = 'SEO Studio';
  book.created = new Date();
  book.properties.defaultRowHeight = 16;

  addProfileSheet(book, {
    project,
    modules: profile.modules,
    composite: profile.composite,
  });
  addFindingsSheets(book, evidenceByModule);
  addStructureSheet(book, evidenceByModule);
  addRecommendationsSheet(book, recos);
  addCoverageSheet(book, {
    modules: profile.modules,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });

  const buffer = await book.xlsx.writeBuffer();
  const slug = slugify(project.name);

  return {
    buffer: Buffer.from(buffer),
    filename: `${slug}-seo-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheets: book.worksheets.map((w) => w.name),
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────
// The same five sections as the workbook, as one document instead of six
// sheets — for pasting into a doc or a PR rather than opening in Excel.

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(lines, headers, rows) {
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`|${headers.map(() => '---').join('|')}|`);
  for (const row of rows) lines.push(`| ${row.map((c) => mdEscape(c)).join(' | ')} |`);
  lines.push('');
}

function buildMarkdownReport({ project, profile, evidenceByModule, recos, generatedAt }) {
  const lines = [];

  lines.push(`# ${project.name}`);
  lines.push(
    `${project.primaryDomain?.origin || project.legacyUrl || 'no primary domain'}`
    + `${project.countryCode ? ` · ${project.countryCode}` : ''}`,
  );
  lines.push('');
  lines.push(`_Generated ${generatedAt}_`);
  lines.push('');

  lines.push('## Audit profile');
  lines.push('');
  mdTable(
    lines,
    ['Module', 'Status', 'Score', 'Basis for the score', 'Errors', 'Warnings', 'Notices', 'Last run'],
    profile.modules.map((module) => {
      const counts = module.evidence?.counts || {};
      return [
        module.label,
        module.status === 'insufficient_data' ? 'Nothing to measure' : module.status,
        module.scored ? module.score : 'Not scored',
        module.scored
          ? (module.scoreBasis || 'the module reported a score without naming its basis')
          : 'This module reports findings, not a 0–100 score.',
        counts.error ?? '',
        counts.warning ?? '',
        counts.notice ?? '',
        module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : 'never',
      ];
    }),
  );
  const { composite } = profile;
  lines.push(composite.value === null
    ? `**Composite:** no composite shown — nothing has scored yet (${composite.scoredModules} of `
      + `${composite.totalModules} modules scored).`
    : `**Composite: ${composite.value}/100** — mean of the ${composite.scoredModules} module `
      + `score(s) that exist, out of ${composite.totalModules} modules. Unscored modules are `
      + 'omitted, not counted as zero.');
  lines.push('');

  let findingsSheets = 0;
  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;
    findingsSheets += 1;

    const findings = Array.isArray(run.findings) ? run.findings : [];
    lines.push(`## ${module.label} — ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    const subtitle = [
      run.target_url ? `Audited ${run.target_url}` : null,
      run.finished_at ? `on ${new Date(run.finished_at).toISOString().slice(0, 16).replace('T', ' ')}` : null,
      run.score !== null && run.score !== undefined ? `Score ${run.score}` : null,
    ].filter(Boolean).join(' · ');
    if (subtitle) { lines.push(`_${subtitle}_`); lines.push(''); }

    if (!findings.length) {
      lines.push(run.status === 'insufficient_data'
        ? 'This module ran and found nothing it could measure for this project. That is a real '
          + 'result, not a missing one.'
        : 'This module ran and reported no findings at error, warning or notice level.');
      lines.push('');
      continue;
    }

    const rank = { error: 0, warning: 1, notice: 2, info: 3 };
    const sorted = [...findings].sort(
      (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.count - a.count,
    );
    mdTable(
      lines,
      ['Severity', 'Finding', 'Category', 'Affected', 'Detail', 'Recommendation'],
      sorted.map((f) => [
        f.severity, f.title, f.category || '', f.count,
        typeof f.detail === 'string' ? f.detail : (f.detail ? JSON.stringify(f.detail) : ''),
        f.recommendation || '',
      ]),
    );
  }

  const structRun = evidenceByModule.get('hub_spoke')?.terminal;
  if (structRun) {
    lines.push('## Internal link structure');
    const payload = structRun.payload || {};
    const structure = payload.structure || {};
    if (structRun.status === 'insufficient_data') {
      lines.push(payload.note || structRun.note || 'No completed crawl with a stored link graph for this project yet.');
      lines.push('');
    } else {
      lines.push(`${structure.pagesAnalyzed || 0} pages · ${structure.edgeCount || 0} internal links`);
      lines.push('');
      mdTable(lines, ['Measure', 'Value', 'What it means'], [
        ['Pages analysed', structure.pagesAnalyzed, 'Internal pages the crawl reached.'],
        ['Internal links', structure.edgeCount, 'Link edges between those pages.'],
        ['Topic hubs', structure.hubCount,
          `Pages linking to at least ${structure.hubMinOutlinks} others, excluding site-wide navigation.`],
        ['Navigation hubs', structure.navigationHubCount,
          `Pages linking to ${Math.round((structure.navigationLinkShare || 0) * 100)}%+ of the site — `
          + 'header, footer or sitemap rather than a topic grouping.'],
        ['Clusters', structure.clusterCount, 'Topic hubs that actually have spokes.'],
        ['Orphans', structure.orphanCount, 'Pages nothing internal links to.'],
        ['Unclustered', structure.unclusteredCount, 'Linked, but only from navigation.'],
      ]);
      if (structure.navigationTestApplied === false) {
        lines.push(
          'This site has too few pages for the navigation test to be meaningful, so every '
          + 'wide-linking page was treated as a topic hub.',
        );
        lines.push('');
      }
      if ((payload.clusters || []).length) {
        mdTable(lines, ['Hub', 'Spokes', 'Linked from', 'Example spokes'], payload.clusters.map((c) => [
          c.hub, c.spokes.length, c.inboundCount, c.spokes.slice(0, 8).join(', '),
        ]));
      }
    }
  }

  lines.push(`## Recommendations — ${recos.length}`);
  lines.push('');
  if (!recos.length) {
    lines.push(
      'No recommendations have been raised for this project yet. Findings become recommendations '
      + 'when somebody decides they are worth advising on.',
    );
    lines.push('');
  } else {
    const order = { proposed: 0, approved: 1, draft: 2, shipped: 3, rejected: 4 };
    const sorted = [...recos].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    mdTable(lines, ['Status', 'Priority', 'Recommendation', 'From', 'Decided', 'Reason if rejected', 'Shipped'],
      sorted.map((r) => {
        const decided = r.approvedAt || r.rejectedAt || r.proposedAt;
        return [
          r.status, r.priority, r.title, r.moduleKey || 'raised by hand',
          decided ? new Date(decided).toISOString().slice(0, 16).replace('T', ' ') : '',
          r.rejectionReason || '',
          r.shippedAt ? new Date(r.shippedAt).toISOString().slice(0, 10) : '',
        ];
      }));
  }

  lines.push('## What this report covers');
  lines.push('');
  mdTable(lines, ['Module', 'Covered?', 'Why'], profile.modules.map((module) => {
    const covered = Boolean(module.evidence) || module.status === 'insufficient_data';
    return [
      module.label,
      covered ? 'yes' : 'no',
      covered
        ? (module.status === 'insufficient_data'
          ? 'Ran, but had nothing it could measure for this project.'
          : `Stored evidence from ${module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 10) : 'an earlier run'}.`)
        : 'Never run against this project, so nothing here reflects it.',
    ];
  }));
  lines.push(
    '_Every figure in this document is read from stored rows. Nothing was measured while the '
    + 'report was produced, and no score was computed here — each score is the one its own module '
    + 'calculated, with its basis stated in Audit profile above._',
  );

  return lines.join('\n');
}

async function buildMarkdown({ access }) {
  const data = await gather({ access });
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const md = buildMarkdownReport({ ...data, generatedAt });
  return {
    buffer: Buffer.from(md, 'utf8'),
    filename: `${slugify(data.project.name)}-seo-report-${new Date().toISOString().slice(0, 10)}.md`,
  };
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// Same data, rendered as HTML and rasterized with the same puppeteer-core +
// @sparticuz/chromium pattern as services/competitorPdfGenerator.js and
// routes/agentReadinessAudit.js.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function htmlTable(headers, rows, { className = '' } = {}) {
  if (!rows.length) return '<p class="muted">Nothing to show.</p>';
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c ?? '')}</td>`).join('')}</tr>`).join('');
  return `<table class="${className}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Colours a verdict/severity/status word by what it means, not by where it
// appears — the same red/amber/green a reader already learned from the
// dashboard (insights/executive.js's HEALTHY_AT/WATCH_AT bands).
const TONE = { risk: '#B3261E', warn: '#9A6B00', good: '#1F6F5C', neutral: '#5B5B63' };
const VERDICT_TONE = { at_risk: TONE.risk, needs_attention: TONE.warn, healthy: TONE.good, not_measured: TONE.neutral };
const SEVERITY_TONE = { error: TONE.risk, warning: TONE.warn, notice: TONE.neutral, info: TONE.neutral };
const STATUS_TONE = { approved: TONE.good, shipped: TONE.good, proposed: TONE.warn, draft: TONE.neutral, rejected: TONE.risk };

function tone(map, key, fallback = TONE.neutral) { return map[key] || fallback; }

/** 'completed_with_errors' -> 'Completed with errors' — raw status/enum values read as code, not prose. */
function humanize(value) {
  const s = String(value ?? '').replace(/_/g, ' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * A finding's `detail` field is a plain string a module wrote for a wide
 * table cell — often a comma-joined list of every affected URL, which reads
 * fine as one cell in a spreadsheet and reads as a wall of text once it's
 * the main line of a card. Two specific cleanups, not a generic truncation:
 *
 *   1. "Cluster → suggested: Cluster" — the arrow-separated pairs Hub & Spoke
 *      writes when a cluster's name and its suggested hub title happen to be
 *      the same string. Collapsed to one when they match, since restating an
 *      identical string either side of an arrow says nothing.
 *   2. A same-site URL list — every entry shares the same protocol and
 *      domain, so that prefix is repeated once per URL and the one part that
 *      actually differs (the path) is squeezed to the end. Same fix as
 *      ProjectReportBar's "Add a page" list: show the path, cap the count,
 *      say how many more.
 */
function formatDetail(detail) {
  if (typeof detail !== 'string') return detail ? JSON.stringify(detail) : '';
  if (!detail) return '';

  let text = detail.replace(
    /([^;,]+?)\s*(?:→|->)\s*suggested:\s*([^;,]+)/gi,
    (whole, a, b) => (a.trim().toLowerCase() === b.trim().toLowerCase() ? a.trim() : whole),
  );

  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const isUrlList = parts.length > 3 && parts.every((p) => /^https?:\/\//i.test(p));
  if (!isUrlList) return text;

  const MAX_SHOWN = 6;
  const shown = parts.slice(0, MAX_SHOWN).map((u) => {
    try {
      const path = new URL(u).pathname;
      return path === '/' ? '/ (home)' : path;
    } catch {
      return u;
    }
  });
  const remaining = parts.length - shown.length;
  return shown.join(', ') + (remaining > 0 ? `, and ${remaining} more` : '');
}

/**
 * What a module tile's second line says. "Completed with errors" repeated on
 * every scored tile said nothing the error/warning badges below it didn't
 * already say better — the actually useful second fact is WHEN it ran, so
 * that wins whenever there's a real status to report instead of a gap.
 */
function moduleStatusLine(module) {
  if (module.status === 'insufficient_data') return 'Nothing to measure';
  if (module.status === 'not_run') return 'Not run yet';
  if (module.status === 'failed') return 'Failed — see findings below';
  if (module.updatedAt) return `Last run ${new Date(module.updatedAt).toISOString().slice(0, 10)}`;
  return humanize(module.status);
}

function badge(label, color) {
  return `<span class="badge" style="color:${color};border-color:${color};background:${color}14;">`
    + `${escapeHtml(label)}</span>`;
}

/** A static SVG score ring — same geometry as AgentReadinessAuditPage's ScoreRing, without the animation a print target has no use for. */
function scoreRing(score, size = 116) {
  const r = 50, cx = 58, cy = 58, circ = 2 * Math.PI * r;
  if (score === null || score === undefined) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 116 116">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E1D8" stroke-width="9"/>
      <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="22" fill="${TONE.neutral}">—</text>
    </svg>`;
  }
  const color = score >= 80 ? TONE.good : score >= 60 ? TONE.warn : TONE.risk;
  const offset = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 116 116">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#E5E1D8" stroke-width="9"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="9"
      stroke-dasharray="${circ}" stroke-dashoffset="${offset}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="26" font-weight="700" fill="${color}">${Math.round(score)}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" fill="${TONE.neutral}">/ 100</text>
  </svg>`;
}

function kpi(label, value, sub) {
  return `<div class="kpi"><span class="kpi-label">${escapeHtml(label)}</span>`
    + `<span class="kpi-value">${escapeHtml(value)}</span>`
    + `${sub ? `<span class="kpi-sub">${escapeHtml(sub)}</span>` : ''}</div>`;
}

function buildReportHtml({ project, profile, evidenceByModule, recos, executiveSummary, generatedAt }) {
  const domain = project.primaryDomain?.origin || project.legacyUrl || 'no primary domain';
  const { verdict, standing, leverage, priorities, confidence } = executiveSummary;
  const sections = [];

  // ── Cover ───────────────────────────────────────────────────────────────
  sections.push(`
    <section class="cover">
      <div class="cover-eyebrow">SEO &amp; GEO AUDIT REPORT</div>
      <h1 class="cover-title">${escapeHtml(project.name)}</h1>
      <div class="cover-sub">${escapeHtml(domain)}${project.countryCode ? ` · ${escapeHtml(project.countryCode)}` : ''}
        &nbsp;·&nbsp; Generated ${escapeHtml(generatedAt)}</div>
      <div class="cover-row">
        <div class="cover-ring">
          ${scoreRing(standing.score, 140)}
          <div class="cover-ring-label">Composite score</div>
        </div>
        <div class="cover-kpis">
          ${kpi('To fix', String(leverage.actions || 0), leverage.templateWide
            ? `${leverage.templateWide} template-wide` : 'actions open')}
          ${kpi('Pages crawled', confidence.crawledPages ? confidence.crawledPages.toLocaleString('en-US') : '—',
            'in the latest evidence')}
          ${kpi('Coverage', `${confidence.modulesCovered} / ${confidence.modulesTotal}`, 'audits with evidence')}
          ${kpi('Recommendations', String(recos.length), recos.length ? `${recos.filter((r) => r.status === 'shipped').length} shipped` : 'none raised yet')}
        </div>
      </div>
      <div class="cover-verdict" style="border-color:${tone(VERDICT_TONE, verdict.state)}">
        <strong style="color:${tone(VERDICT_TONE, verdict.state)}">${escapeHtml(verdict.headline)}</strong>
        <span>${escapeHtml(verdict.sentence)}</span>
      </div>
    </section>
  `);

  // ── Executive summary ──────────────────────────────────────────────────
  sections.push(`
    <section class="pagebreak">
      <div class="eyebrow">Executive Summary</div>
      <h2 class="exec-headline" style="color:${tone(VERDICT_TONE, verdict.state)}">${escapeHtml(verdict.headline)}</h2>
      <p class="lead">${escapeHtml(verdict.sentence)}</p>
      ${leverage.sentence ? `<p class="lead-sub">${escapeHtml(leverage.sentence)}</p>` : ''}
  `);

  if (priorities.length) {
    sections.push(`
      <div class="priorities">
        <div class="section-label">Start with these ${priorities.length}</div>
        ${priorities.map((p) => `
          <div class="priority-card">
            <span class="priority-rank">${p.rank}</span>
            <div class="priority-body">
              <div class="priority-title">${escapeHtml(p.title)}</div>
              <div class="priority-meta">
                ${p.moduleLabel ? badge(p.moduleLabel, TONE.neutral) : ''}
                ${p.severity ? badge(p.severity, tone(SEVERITY_TONE, p.severity)) : ''}
              </div>
              ${p.reach ? `<div class="priority-reach">${escapeHtml(p.reach)}</div>` : ''}
              ${p.basis ? `<div class="priority-basis muted">${escapeHtml(p.basis)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `);
  }

  sections.push(`
      <div class="confidence">
        <div class="section-label">What this covers</div>
        <p>${escapeHtml(confidence.sentence)}</p>
        ${confidence.caveats.length ? `<ul class="caveats">${confidence.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
      </div>
    </section>
  `);

  // ── Audit profile ───────────────────────────────────────────────────────
  sections.push(`
    <section class="pagebreak">
      <div class="eyebrow">Audit Profile</div>
      <h2>Score by module</h2>
      <div class="module-grid">
        ${profile.modules.map((module) => {
          const counts = module.evidence?.counts || {};
          const scoreColor = !module.scored ? TONE.neutral : module.score >= 80 ? TONE.good : module.score >= 60 ? TONE.warn : TONE.risk;
          return `
            <div class="module-tile">
              <div class="module-tile-top">
                <span class="module-tile-label">${escapeHtml(module.label)}</span>
                <span class="module-tile-score" style="color:${scoreColor}">${module.scored ? module.score : '—'}</span>
              </div>
              <div class="module-tile-status">${escapeHtml(moduleStatusLine(module))}</div>
              <div class="module-tile-counts">
                ${counts.error ? badge(`${counts.error} error${counts.error === 1 ? '' : 's'}`, TONE.risk) : ''}
                ${counts.warning ? badge(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`, TONE.warn) : ''}
                ${counts.notice ? badge(`${counts.notice} notice${counts.notice === 1 ? '' : 's'}`, TONE.neutral) : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      <p class="muted small">${standing.basis}</p>
    </section>
  `);

  // ── Per-module deep dives ───────────────────────────────────────────────
  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;
    const findings = Array.isArray(run.findings) ? run.findings : [];
    const subtitle = [
      run.target_url ? `Audited ${run.target_url}` : null,
      run.finished_at ? `on ${new Date(run.finished_at).toISOString().slice(0, 16).replace('T', ' ')}` : null,
      run.score !== null && run.score !== undefined ? `Score ${run.score}` : null,
    ].filter(Boolean).join(' · ');

    sections.push(`
      <section class="pagebreak">
        <div class="eyebrow">${escapeHtml(module.label)}</div>
        <h2>${findings.length} finding${findings.length === 1 ? '' : 's'}</h2>
        ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ''}
    `);

    if (!findings.length) {
      sections.push(`<p class="muted">${escapeHtml(run.status === 'insufficient_data'
        ? 'This module ran and found nothing it could measure for this project. That is a real result, not a missing one.'
        : 'This module ran and reported no findings at error, warning or notice level.')}</p></section>`);
      continue;
    }

    const rank = { error: 0, warning: 1, notice: 2, info: 3 };
    const sorted = [...findings].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.count - a.count);
    sections.push(`
      <div class="findings">
        ${sorted.map((f) => `
          <div class="finding-card" style="border-left-color:${tone(SEVERITY_TONE, f.severity)}">
            <div class="finding-head">
              ${badge(f.severity, tone(SEVERITY_TONE, f.severity))}
              <span class="finding-title">${escapeHtml(f.title)}</span>
              <span class="finding-count">${f.count} affected</span>
            </div>
            ${f.category ? `<div class="muted small">${escapeHtml(f.category)}</div>` : ''}
            ${f.detail ? `<p class="finding-detail">${escapeHtml(formatDetail(f.detail))}</p>` : ''}
            ${f.recommendation ? `<div class="finding-reco"><strong>Recommendation</strong> ${escapeHtml(f.recommendation)}</div>` : ''}
          </div>
        `).join('')}
      </div>
      </section>
    `);
  }

  // ── Site structure ──────────────────────────────────────────────────────
  const structRun = evidenceByModule.get('hub_spoke')?.terminal;
  if (structRun) {
    sections.push('<section class="pagebreak"><div class="eyebrow">Content Architecture</div><h2>Internal link structure</h2>');
    const payload = structRun.payload || {};
    const structure = payload.structure || {};
    if (structRun.status === 'insufficient_data') {
      sections.push(`<p class="muted">${escapeHtml(payload.note || structRun.note || 'No completed crawl with a stored link graph for this project yet.')}</p></section>`);
    } else {
      sections.push(`<p class="lead-sub">${structure.pagesAnalyzed || 0} pages · ${structure.edgeCount || 0} internal links</p>`);
      sections.push(`<div class="module-grid">
        ${[
          ['Topic hubs', structure.hubCount, `Link to ${structure.hubMinOutlinks}+ others`],
          ['Navigation hubs', structure.navigationHubCount, 'Header/footer/sitemap'],
          ['Clusters', structure.clusterCount, 'Hubs that have spokes'],
          ['Orphans', structure.orphanCount, 'No inbound internal link'],
          ['Unclustered', structure.unclusteredCount, 'Linked only from nav'],
        ].map(([label, value, sub]) => kpi(label, String(value ?? '—'), sub)).join('')}
      </div>`);
      if ((payload.clusters || []).length) {
        sections.push(htmlTable(['Hub', 'Spokes', 'Linked from', 'Example spokes'], payload.clusters.map((c) => [
          c.hub, c.spokes.length, c.inboundCount, c.spokes.slice(0, 8).join(', '),
        ]), { className: 'data-table' }));
      }
      sections.push('</section>');
    }
  }

  // ── Recommendations ─────────────────────────────────────────────────────
  sections.push(`<section class="pagebreak"><div class="eyebrow">Recommendations</div><h2>${recos.length} raised</h2>`);
  if (!recos.length) {
    sections.push('<p class="muted">No recommendations have been raised for this project yet. Findings become recommendations when somebody decides they are worth advising on.</p>');
  } else {
    const order = { proposed: 0, approved: 1, draft: 2, shipped: 3, rejected: 4 };
    const sorted = [...recos].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    sections.push(`<div class="recos">
      ${sorted.map((r) => {
        const decided = r.approvedAt || r.rejectedAt || r.proposedAt;
        return `
          <div class="reco-card" style="border-left-color:${tone(STATUS_TONE, r.status)}">
            <div class="finding-head">
              ${badge(r.status, tone(STATUS_TONE, r.status))}
              ${badge(r.priority, TONE.neutral)}
              <span class="finding-title">${escapeHtml(r.title)}</span>
            </div>
            <div class="muted small">${escapeHtml(r.moduleKey || 'raised by hand')}
              ${decided ? ` · decided ${new Date(decided).toISOString().slice(0, 10)}` : ''}
              ${r.shippedAt ? ` · shipped ${new Date(r.shippedAt).toISOString().slice(0, 10)}` : ''}</div>
            ${r.body ? `<p class="finding-detail">${escapeHtml(r.body)}</p>` : ''}
            ${r.rejectionReason ? `<div class="finding-reco"><strong>Rejected</strong> ${escapeHtml(r.rejectionReason)}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>`);
  }
  sections.push('</section>');

  // ── Coverage ─────────────────────────────────────────────────────────────
  sections.push(`
    <section class="pagebreak">
      <div class="eyebrow">Coverage</div>
      <h2>What this report does not cover</h2>
      ${htmlTable(['Module', 'Covered?', 'Why'], profile.modules.map((module) => {
        const covered = Boolean(module.evidence) || module.status === 'insufficient_data';
        return [
          module.label, covered ? 'yes' : 'no',
          covered
            ? (module.status === 'insufficient_data'
              ? 'Ran, but had nothing it could measure for this project.'
              : `Stored evidence from ${module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 10) : 'an earlier run'}.`)
            : 'Never run against this project, so nothing here reflects it.',
        ];
      }), { className: 'data-table' })}
      <p class="muted small" style="margin-top:14px;">Every figure in this report is read from stored rows. Nothing was
        measured while the report was produced, and no score was computed here — each score is the one its own module
        calculated, with its basis stated on the Audit Profile page.</p>
    </section>
  `);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #1C1E24; font-size: 12px; margin: 0; line-height: 1.45; }
    .pagebreak { page-break-before: always; padding-top: 6px; }
    .muted { color: #6B6B72; } .small { font-size: 10.5px; }
    .eyebrow { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #1F6F5C; font-weight: 700; margin-bottom: 4px; }
    .section-label { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #6B6B72; font-weight: 700; margin: 18px 0 8px; }
    h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 17px; margin: 0 0 10px; }

    /* Cover */
    .cover { background: linear-gradient(155deg, #F5F3EE 0%, #EAF1EE 100%); border-radius: 14px; padding: 30px 28px; }
    .cover-eyebrow { font-size: 10.5px; letter-spacing: 0.16em; color: #1F6F5C; font-weight: 700; margin-bottom: 10px; }
    .cover-title { color: #1C1E24; }
    .cover-sub { color: #6B6B72; font-size: 12.5px; margin-bottom: 22px; }
    .cover-row { display: flex; align-items: center; gap: 26px; margin-bottom: 20px; }
    .cover-ring { text-align: center; flex-shrink: 0; }
    .cover-ring-label { font-size: 10.5px; color: #6B6B72; margin-top: 4px; }
    .cover-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; flex: 1; }
    .cover-verdict { border-left: 4px solid; padding: 12px 16px; background: #fff; border-radius: 8px;
      display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; box-shadow: 0 1px 3px rgba(28,30,36,0.07); }

    /* KPI tiles */
    .kpi { background: #fff; border: 1px solid #E5E1D8; border-radius: 8px; padding: 10px 13px;
      display: flex; flex-direction: column; gap: 2px; box-shadow: 0 1px 2px rgba(28,30,36,0.05); }
    .kpi-label { font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: #6B6B72; }
    .kpi-value { font-size: 19px; font-weight: 700; }
    .kpi-sub { font-size: 10px; color: #6B6B72; }

    /* Executive summary */
    .exec-headline { font-size: 20px; margin-top: 6px; }
    .lead { font-size: 13.5px; line-height: 1.55; margin: 0 0 6px; }
    .lead-sub { font-size: 12px; color: #444; line-height: 1.5; margin: 0 0 4px; }
    .priorities { margin-top: 8px; }
    .priority-card { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #ECE9E2; }
    .priority-rank { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: #1F6F5C; color: #fff;
      font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .priority-title { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
    .priority-meta { display: flex; gap: 5px; margin-bottom: 3px; }
    .priority-reach { font-size: 11.5px; color: #333; margin-bottom: 2px; }
    .priority-basis { font-size: 10.5px; }
    .confidence { margin-top: 16px; background: #F5F3EE; border-radius: 8px; padding: 12px 14px; }
    .confidence p { margin: 0 0 4px; font-size: 12px; }
    .caveats { margin: 4px 0 0; padding-left: 16px; font-size: 11px; color: #6B6B72; }
    .caveats li { margin-bottom: 2px; }

    /* Badges */
    .badge { display: inline-block; font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.03em; padding: 2px 7px; border-radius: 99px; border: 1px solid; }

    /* Module grid */
    .module-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 10px 0; }
    .module-tile { border: 1px solid #E5E1D8; border-radius: 9px; padding: 12px 14px; box-shadow: 0 1px 2px rgba(28,30,36,0.05); }
    .module-tile-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
    .module-tile-label { font-size: 11.5px; font-weight: 600; }
    .module-tile-score { font-size: 18px; font-weight: 700; }
    .module-tile-status { font-size: 10.5px; color: #6B6B72; margin-bottom: 7px; }
    .module-tile-counts { display: flex; gap: 4px; flex-wrap: wrap; }

    /* Findings / Recommendations cards */
    .findings, .recos { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
    .finding-card, .reco-card { border: 1px solid #E5E1D8; border-left: 4px solid; border-radius: 8px; padding: 12px 15px;
      box-shadow: 0 1px 2px rgba(28,30,36,0.05); }
    .finding-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 5px; }
    .finding-title { font-size: 12.5px; font-weight: 600; flex: 1; }
    .finding-count { font-size: 10.5px; color: #6B6B72; }
    .finding-detail { margin: 5px 0; font-size: 11.5px; line-height: 1.55; color: #40404A; }
    .finding-reco { font-size: 11px; line-height: 1.5; background: #EAF1EE; border-radius: 6px; padding: 7px 10px; margin-top: 6px; }

    /* Tables (structure / coverage) */
    table.data-table { border-collapse: collapse; width: 100%; margin: 8px 0 4px; box-shadow: 0 1px 2px rgba(28,30,36,0.05); }
    table.data-table th, table.data-table td { border: 1px solid #E5E1D8; padding: 6px 9px; text-align: left; font-size: 11px; vertical-align: top; }
    table.data-table th { background: #1F6F5C; color: #fff; font-weight: 600; }
    table.data-table tr:nth-child(even) td { background: #FAF9F6; }
  </style></head><body>${sections.join('\n')}</body></html>`;
}

async function buildPdf({ access }) {
  const data = await gather({ access });
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const html = buildReportHtml({ ...data, generatedAt });

  const localBrowser = findLocalBrowser();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: localBrowser || (await chromium.executablePath()),
      headless: true,
      args: localBrowser ? ['--no-sandbox', '--disable-setuid-sandbox'] : chromium.args,
      defaultViewport: localBrowser ? { width: 1280, height: 800 } : chromium.defaultViewport,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:9px;color:#9A968C;font-family:-apple-system,'Segoe UI',sans-serif;
        display:flex;justify-content:space-between;padding:0 14mm;">
        <span>${escapeHtml(data.project.name)} — SEO &amp; GEO Audit</span>
        <span class="pageNumber"></span></div>`,
    });
    return {
      buffer: Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf),
      filename: `${slugify(data.project.name)}-seo-report-${new Date().toISOString().slice(0, 10)}.pdf`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  build,
  buildMarkdown,
  buildPdf,
  addProfileSheet,
  addFindingsSheets,
  addStructureSheet,
  addRecommendationsSheet,
  addCoverageSheet,
};
