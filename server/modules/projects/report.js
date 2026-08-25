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
const moduleEvidence = require('./moduleEvidence');
const recommendations = require('./recommendations');
const overview = require('./overview');

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
    note(sheet, payload.note || 'No completed crawl with a stored link graph for this project yet.');
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
 * Builds the workbook.
 *
 * @param {object} input
 * @param {object} input.access  from projectAccess.requireProject
 * @returns {Promise<{buffer: Buffer, filename: string, sheets: string[]}>}
 */
async function build({ access }) {
  const store = require('./store');
  const project = await store.getProject(access.project);

  const [profile, evidenceByModule, recos] = await Promise.all([
    overview.buildOverview({ access }),
    moduleEvidence.latestByModule(access.project.id),
    recommendations.list(access.project.id, { limit: 500 }),
  ]);

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
  const slug = String(project.name || 'project')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';

  return {
    buffer: Buffer.from(buffer),
    filename: `${slug}-seo-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheets: book.worksheets.map((w) => w.name),
  };
}

module.exports = {
  build,
  addProfileSheet,
  addFindingsSheets,
  addStructureSheet,
  addRecommendationsSheet,
  addCoverageSheet,
};
