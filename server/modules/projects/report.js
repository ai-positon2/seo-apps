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

// ── Plain language, shared by all three formats ─────────────────────────────

// The dashboard's own status words (client lib/projectsApi.js
// MODULE_STATUS_LABEL). A client reading "completed_with_errors" in a report
// is reading the database, not the audit.
const STATUS_LABEL = {
  not_run: 'Not run',
  running: 'Running',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Up to date',
  completed_with_errors: 'Finished with errors',
  cancelled: 'Cancelled',
  failed: 'Failed',
  insufficient_data: 'Nothing to measure',
  needs_setup: 'Needs setup',
};

function statusLabel(module) {
  if (module.profileStale) return 'Profile out of date';
  if (module.healthPending) return 'Score still being worked out';
  return STATUS_LABEL[module.status] || humanize(module.status);
}

/** 'completed_with_errors' -> 'Completed with errors' — raw status/enum values read as code, not prose. */
function humanize(value) {
  const s = String(value ?? '').replace(/_/g, ' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * The figure the dashboard card leads with. Competitor Research and AI
 * Visibility lead with a percentage (`metric`), not their 0-100 score — the
 * report printed the score ("50") beside a card reading "17% of AI answers".
 */
function headlineFigure(module) {
  const metric = module?.metric;
  if (metric && metric.display && metric.display !== '—') {
    return `${metric.display}${metric.unit ? ` ${metric.unit}` : ''}`;
  }
  return module?.scored ? `${module.score}/100` : null;
}

/** Why a module's results are left out of the report, or null. */
function staleNote(module) {
  if (!module?.profileStale) return null;
  const builtFor = module.profileStale.builtFor;
  return `Profile out of date: it was built for ${builtFor || 'the project’s previous site'}, not this one. `
    + 'Its results describe that site, so they are left out of this report. Rebuild the profile to measure this one.';
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * A finding's structured `detail` in words. AI Visibility stores lists
 * (prompts, competitors, cited domains, topics); JSON.stringify put
 * '{"prompts":[...]}' in a client's report.
 */
function detailText(detail) {
  if (detail === null || detail === undefined || detail === '') return '';
  if (typeof detail === 'string') return detail;
  if (typeof detail !== 'object') return String(detail);
  const parts = [];
  const list = (items, cap = 3) => {
    const shown = items.slice(0, cap);
    const more = items.length - shown.length;
    return shown.join('; ') + (more > 0 ? `; and ${more} more` : '');
  };
  if (Array.isArray(detail.prompts)) {
    const prompts = [...new Set(detail.prompts.map((p) => String(p).trim()).filter(Boolean))];
    if (prompts.length) parts.push(`For example: ${list(prompts.map((p) => `“${p}”`))}`);
  }
  if (Array.isArray(detail.competitors)) {
    const named = detail.competitors.map((c) => (typeof c === 'string' ? c
      : `${c.name || c.domain || 'a competitor'}${Number.isFinite(c.prompts) ? ` named in ${plural(c.prompts, 'prompt', 'prompts')}` : ''}`));
    if (named.length) parts.push(list(named, 5));
  }
  if (Array.isArray(detail.domains)) {
    const cited = detail.domains.map((d) => (typeof d === 'string' ? d
      : `${d.domain || d.name || 'a site'}${Number.isFinite(d.prompts) ? ` (${plural(d.prompts, 'prompt', 'prompts')})` : ''}`));
    if (cited.length) parts.push(`Cited: ${list(cited, 5)}`);
  }
  if (Array.isArray(detail.topics)) {
    const topics = detail.topics.map((t) => (typeof t === 'string' ? t
      : `${t.topic || 'a topic'}${t.targetUrl ? ` (${t.targetUrl})` : ''}`
        + `${Array.isArray(t.competitorsNamed) && t.competitorsNamed.length ? `: ${t.competitorsNamed.join(', ')} named instead` : ''}`));
    if (topics.length) parts.push(list(topics));
  }
  if (parts.length) return parts.join('. ');
  // Anything else: its fields, in words, never as code.
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const label = humanize(k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      if (Array.isArray(v)) return `${label}: ${list(v.map((x) => (x && typeof x === 'object' ? Object.values(x).filter((y) => typeof y !== 'object').join(' ') : String(x))), 5)}`;
      if (typeof v === 'object') return `${label}: ${Object.values(v).filter((y) => typeof y !== 'object').join(', ')}`;
      return `${label}: ${v}`;
    })
    .join('. ');
}

// ── Tech Audit, from the crawl the card reads ───────────────────────────────

// How many issues a report lists. The full list is the Site Crawler's own
// export; this is what the card's numbers are made of, worst first.
const TECH_ISSUE_CAP = 25;
const SEVERITY_ORDER = { error: 0, warning: 1, notice: 2, info: 3 };

/**
 * The Tech Audit section's data: the dashboard card (its Site Health score and
 * headline), and the latest finished crawl's issues — the rules that cost
 * points first, then by severity and by how many scored pages each is on.
 * Read from the same cached aggregates as the card (overview.costingRulePages).
 */
async function techAuditData(modules) {
  const card = (modules || []).find((m) => m.key === 'technical');
  const runId = card ? (card.evidence ? card.runId : card.previousRunId) : null;
  if (!card || !runId) return null;
  const [rollup, costing] = await Promise.all([
    overview.findingsForRun(runId).catch((e) => {
      console.error('[projects.report.techFindings]', e.message);
      return [];
    }),
    overview.costingRulePages(runId),
  ]);
  return techAuditRows(card, rollup, costing);
}

/** Pure: the rows, given the card, the per-rule rollup and the costing map. */
function techAuditRows(card, rollup, costing) {
  const issues = (rollup || [])
    .filter((f) => f.severity in SEVERITY_ORDER && f.severity !== 'info')
    .map((f) => {
      const cost = costing?.get?.(f.rule_id) || null;
      return {
        ruleId: f.rule_id,
        title: f.detail?.title || f.rule_id,
        severity: f.severity,
        category: f.category || '',
        findings: Number(f.count) || 0,
        costsPoints: costing ? Boolean(cost) : null,
        pages: cost ? (cost.siteLevel ? null : cost.pages.size) : null,
        siteLevel: cost?.siteLevel || null,
      };
    })
    .sort((a, b) => (Number(b.costsPoints) - Number(a.costsPoints))
      || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      || ((b.pages || 0) - (a.pages || 0))
      || (b.findings - a.findings));
  return { card, issues: issues.slice(0, TECH_ISSUE_CAP), total: issues.length };
}

function techScoreLine(card) {
  if (card.healthPending) return 'Site Health is still being worked out for this crawl.';
  return card.scored ? `Site Health ${card.score}/100` : 'Site Health not scored for this crawl';
}

function techPagesCell(issue) {
  if (issue.siteLevel) return 'site-wide';
  if (issue.pages === null) return issue.costsPoints === false ? 'none scored' : '—';
  return issue.pages;
}

function techCostCell(issue) {
  if (issue.costsPoints === null) return '—';
  return issue.costsPoints ? 'yes' : 'no';
}

// ── Hub and Spoke structure, from the analysis the card reads ───────────────

const STRUCTURE_CLUSTER_CAP = 50;

/**
 * The Content Architect analysis behind the Hub and Spoke card: its page and
 * cluster counts, and the clusters themselves. The report used to read
 * `payload.structure`, which the Content Architect-based run never writes —
 * and which the evidence rows do not load anyway — so every field printed as
 * blank or "undefined". Null when there is no saved analysis.
 */
async function hubSpokeStructure(projectId) {
  const db = require('../../services/db');
  const [row] = await db.rows(
    `select a.updated_at,
            jsonb_array_length(coalesce(a.data->'pages', '[]'::jsonb)) as pages,
            jsonb_array_length(coalesce(a.data->'clusters', '[]'::jsonb)) as clusters,
            jsonb_array_length(coalesce(a.data->'unassignedPages', '[]'::jsonb)) as unassigned,
            (select count(*) from jsonb_array_elements(coalesce(a.data->'clusters', '[]'::jsonb)) c
              where (c->>'isGap')::boolean)::int as gaps,
            (select round(avg(coalesce((c->>'health')::numeric, 0)))
               from jsonb_array_elements(coalesce(a.data->'clusters', '[]'::jsonb)) c)::int as mean_health,
            (select coalesce(json_agg(x), '[]'::json) from (
               select c->>'name' as name,
                      (c->>'health')::numeric as health,
                      coalesce((c->>'isGap')::boolean, false) as gap,
                      jsonb_array_length(coalesce(c->'spokeIds', '[]'::jsonb)) as spokes,
                      (select p->>'url' from jsonb_array_elements(coalesce(a.data->'pages', '[]'::jsonb)) p
                        where p->>'id' = c->>'hubPageId' limit 1) as hub
                 from jsonb_array_elements(coalesce(a.data->'clusters', '[]'::jsonb)) c
                limit $2) x) as cluster_rows
       from content_architect_projects ca
       join content_architect_artifacts a on a.project_id = ca.id and a.kind = 'full_analysis'
      where ca.platform_project_id = $1
      order by a.updated_at desc
      limit 1`,
    [projectId, STRUCTURE_CLUSTER_CAP],
  );
  if (!row) return null;
  return {
    savedAt: row.updated_at,
    pages: Number(row.pages) || 0,
    clusters: Number(row.clusters) || 0,
    gaps: Number(row.gaps) || 0,
    unassigned: Number(row.unassigned) || 0,
    meanHealth: Number.isFinite(row.mean_health) ? row.mean_health : null,
    clusterRows: (Array.isArray(row.cluster_rows) ? row.cluster_rows : [])
      .sort((a, b) => (Number(b.spokes) || 0) - (Number(a.spokes) || 0)),
  };
}

/** The structure section's content, the same for every format. */
function structureContent(run, structure) {
  if (!run) return null;
  if (run.status === 'insufficient_data') {
    return { note: run.payload?.note || run.note || 'No completed crawl with a stored link graph for this project yet.' };
  }
  if (!structure) {
    return {
      note: 'This Hub and Spoke result has no saved Content Architect analysis to summarise. '
        + 'Open Hub and Spoke for the clusters.',
    };
  }
  const day = structure.savedAt ? new Date(structure.savedAt).toISOString().slice(0, 10) : null;
  return {
    subtitle: `${plural(structure.pages, 'page', 'pages')} analysed · ${plural(structure.clusters, 'topic cluster', 'topic clusters')}`
      + (day ? ` · analysis saved ${day}` : ''),
    measures: [
      ['Pages analysed', structure.pages, 'Informational pages the analysis grouped into topics.'],
      ['Topic clusters', structure.clusters, 'Groups of pages about one topic.'],
      ['Clusters with no hub', structure.gaps, 'Topics with several pages but no single page that covers them broadly.'],
      ['Pages not in any topic', structure.unassigned, 'Pages the analysis could not place in a cluster.'],
      ['Mean cluster health', structure.meanHealth === null ? 'Not scored' : `${structure.meanHealth}/100`,
        'The Hub and Spoke score: the average of every cluster’s health.'],
    ],
    clusters: structure.clusterRows.map((c) => [
      c.name || 'Unnamed cluster',
      c.gap ? 'No hub yet' : (c.hub || '—'),
      Number(c.spokes) || 0,
      Number.isFinite(Number(c.health)) && c.health !== null ? Math.round(Number(c.health)) : '—',
    ]),
    clustersCapped: structure.clusters > structure.clusterRows.length,
  };
}

/** The card's percentage, when it leads with one and has a value. */
function profileMetric(module) {
  const metric = module?.metric;
  return metric && metric.display && metric.display !== '—' ? metric : null;
}

/**
 * One audit-profile row, the same in every format: the figure the card leads
 * with (a percentage for Competitor Research and AI Visibility, labelled; the
 * 0-100 score otherwise), the status in the dashboard's words.
 */
function profileCells(module) {
  const counts = module.evidence?.counts || {};
  const metric = profileMetric(module);
  const stale = staleNote(module);
  let score;
  let outOf;
  let basis;
  if (stale) {
    score = 'Not scored';
    outOf = '';
    basis = stale;
  } else if (metric) {
    score = metric.display;
    outOf = '';
    basis = `${metric.unit ? `${metric.unit[0].toUpperCase()}${metric.unit.slice(1)}` : 'A percentage'}, the figure the dashboard card shows.`
      + (module.scored ? ` Its 0–100 score is ${module.score}: ${module.scoreBasis || 'the module’s own score'}.` : '');
  } else if (module.scored) {
    score = module.score;
    outOf = 100;
    basis = module.scoreBasis || 'the module reported a score without naming its basis';
  } else {
    score = 'Not scored';
    outOf = '';
    basis = module.healthPending
      ? 'The site crawl’s health score was still being worked out when this report was made.'
      : 'This module reports findings, not a 0–100 score.';
  }
  return [
    module.label,
    statusLabel(module),
    score,
    outOf,
    basis,
    stale ? '' : (counts.error ?? ''),
    stale ? '' : (counts.warning ?? ''),
    stale ? '' : (counts.notice ?? ''),
    module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : 'never',
  ];
}

/** Coverage: [covered?, why], the same in every format. */
function coverageCells(module) {
  if (module.profileStale) return ['no', staleNote(module)];
  const covered = Boolean(module.evidence) || module.status === 'insufficient_data';
  if (!covered) return ['no', 'Never run against this project, so nothing here reflects it.'];
  return ['yes', module.status === 'insufficient_data'
    ? 'Ran, but had nothing it could measure for this project.'
    : `Stored evidence from ${module.updatedAt ? new Date(module.updatedAt).toISOString().slice(0, 10) : 'an earlier run'}.`];
}

/** The findings a report may show for a module: none for a stale profile. */
function reportableFindings(run, card) {
  if (card?.profileStale) return [];
  return Array.isArray(run?.findings) ? run.findings : [];
}

/** A findings section's subtitle, leading with the card's own figure. */
function findingsSubtitle(run, card) {
  const figure = card ? headlineFigure(card) : (run.score !== null && run.score !== undefined ? `Score ${run.score}` : null);
  return [
    run.target_url ? `Audited ${run.target_url}` : null,
    run.finished_at ? `on ${new Date(run.finished_at).toISOString().slice(0, 16).replace('T', ' ')}` : null,
    card && figure ? `Dashboard figure ${figure}` : figure,
  ].filter(Boolean).join(' · ');
}

/** What a findings section says when it has none to list. */
function noFindingsText(run, card) {
  return staleNote(card) || (run.status === 'insufficient_data'
    ? 'This module ran and found nothing it could measure for this project. That is a real '
      + 'result, not a missing one.'
    : 'This module ran and reported no findings at error, warning or notice level.');
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
    const row = sheet.addRow(profileCells(module));
    if (!module.scored && !profileMetric(module)) {
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
// `modules` are the dashboard's cards, when the caller has them: the section
// leads with the card's figure and a stale AI Visibility profile lists nothing.
// The Tech Audit is not here: its findings live in the crawl, not in a module
// run (addTechAuditSheet).
function addFindingsSheets(book, evidenceByModule, modules = []) {
  let added = 0;

  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;   // addTechAuditSheet
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;
    const card = modules.find((m) => m.key === module.key) || null;

    const findings = reportableFindings(run, card);
    // Excel sheet names are capped at 31 chars and cannot contain : \\ / ? * [ ]
    const name = module.label.replace(/[:\\/?*[\]]/g, '').slice(0, 28);
    const sheet = book.addWorksheet(name);

    titleBlock(
      sheet,
      `${module.label} — ${findings.length} finding${findings.length === 1 ? '' : 's'}`,
      findingsSubtitle(run, card),
    );

    if (!findings.length) {
      note(sheet, noFindingsText(run, card));
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
        detailText(f.detail),
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

/**
 * Hub-and-spoke structure: the Content Architect analysis the card reads
 * (hubSpokeStructure), or a sentence saying why there is none.
 *
 * @param {object|null} structure  hubSpokeStructure's answer
 */
function addStructureSheet(book, evidenceByModule, structure = null) {
  const run = evidenceByModule.get('hub_spoke')?.terminal;
  const content = structureContent(run, structure);
  if (!content) return null;

  const sheet = book.addWorksheet('Site structure');
  titleBlock(sheet, 'Topic structure (Hub and Spoke)', content.subtitle || null);

  if (content.note) {
    // The evidence rows come from latestByModule, which projects the note out
    // of the payload rather than loading the payload itself — so `run.note` is
    // where the run's own explanation (e.g. too few informational pages) is.
    note(sheet, content.note);
    return sheet;
  }

  headerRow(sheet, ['Measure', 'Value', 'What it means'], { width: [28, 12, 80] });
  for (const r of content.measures) {
    const row = sheet.addRow(r);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(3).font = { color: { argb: MUTED }, size: 10 };
  }

  if (content.clusters.length) {
    sheet.addRow([]);
    headerRow(sheet, ['Cluster', 'Hub page', 'Spokes', 'Health'], { width: [40, 70, 9, 9] });
    for (const r of content.clusters) {
      const row = sheet.addRow(r);
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    }
    if (content.clustersCapped) {
      note(sheet, `The ${STRUCTURE_CLUSTER_CAP} largest clusters are listed; Hub and Spoke has the rest.`);
    }
  }

  return sheet;
}

/**
 * Tech Audit: the card's Site Health and the latest crawl's issues, worst first.
 *
 * @param {object|null} tech  techAuditData's answer
 */
function addTechAuditSheet(book, tech) {
  if (!tech) return null;
  const { card, issues, total } = tech;
  const sheet = book.addWorksheet('Tech Audit');
  titleBlock(sheet, `Tech Audit — ${techScoreLine(card)}`, [card.headline, card.coverage].filter(Boolean).join(' · '));
  if (card.detail) note(sheet, card.detail);
  sheet.addRow([]);

  if (!issues.length) {
    note(sheet, 'The latest crawl reported no error, warning or notice findings.');
    return sheet;
  }

  headerRow(
    sheet,
    ['Severity', 'Issue', 'Category', 'Costs points', 'Scored pages affected', 'Findings listed'],
    { width: [11, 56, 20, 13, 20, 14] },
  );
  for (const issue of issues) {
    const row = sheet.addRow([
      issue.severity, issue.title, issue.category, techCostCell(issue), techPagesCell(issue), issue.findings,
    ]);
    row.getCell(1).fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: SEVERITY_FILL[issue.severity] || SEVERITY_FILL.notice },
    };
  }
  if (total > issues.length) {
    sheet.addRow([]);
    note(sheet, `The ${issues.length} issues that cost the most are listed, of ${total}. `
      + 'The Site Crawler report has every one, page by page.');
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
    const [covered, why] = coverageCells(module);
    const row = sheet.addRow([module.label, covered, why]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    if (covered === 'no') row.getCell(2).font = { color: { argb: 'FFB3261E' }, bold: true };
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

  // The evidence comes WITH the overview, after the cards' own freshness rules
  // (AI Visibility's stale-profile check, Hub and Spoke's Content Architect
  // analysis) — reading latestByModule separately put results in the file that
  // the card beside it had set aside. `reuse` takes the build the dashboard
  // made a moment ago instead of a third one.
  const [{ overview: profile, evidenceByModule }, recos, backlogBuilt] = await Promise.all([
    overview.buildOverviewWithEvidence({ access, reuse: true }),
    recommendations.list(access.project.id, { limit: 500 }),
    insights.buildInsights({ access, reuse: true }),
  ]);
  const hubRun = evidenceByModule.get('hub_spoke')?.terminal;
  const [tech, structure] = await Promise.all([
    techAuditData(profile.modules).catch((e) => {
      console.error('[projects.report.techAudit]', e.message);
      return null;
    }),
    hubRun && hubRun.status !== 'insufficient_data'
      ? hubSpokeStructure(access.project.id).catch((e) => {
        console.error('[projects.report.structure]', e.message);
        return null;
      })
      : Promise.resolve(null),
  ]);

  // Same composition the dashboard's own Executive Summary card reads —
  // GET /:projectId/executive-summary — so the PDF's narrative says exactly
  // what the app already told this reader, not a second, differently-worded
  // opinion about the same evidence.
  const executiveSummary = insights.executive.buildExecutiveSummary({
    overview: profile,
    backlog: backlogBuilt.backlog,
  });

  return { project, profile, evidenceByModule, recos, executiveSummary, tech, structure };
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
  const { project, profile, evidenceByModule, recos, tech, structure } = await gather({ access });

  const book = new ExcelJS.Workbook();
  book.creator = 'SEO Studio';
  book.created = new Date();
  book.properties.defaultRowHeight = 16;

  addProfileSheet(book, {
    project,
    modules: profile.modules,
    composite: profile.composite,
  });
  addTechAuditSheet(book, tech);
  addFindingsSheets(book, evidenceByModule, profile.modules);
  addStructureSheet(book, evidenceByModule, structure);
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

function buildMarkdownReport({ project, profile, evidenceByModule, recos, generatedAt, tech = null, structure = null }) {
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
      // Same cells as the workbook, without its "Out of" column.
      const [label, status, score, outOf, ...rest] = profileCells(module);
      return [label, status, outOf ? `${score}/${outOf}` : score, ...rest];
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

  if (tech) {
    const { card, issues, total } = tech;
    lines.push(`## Tech Audit — ${techScoreLine(card)}`);
    const sub = [card.headline, card.coverage].filter(Boolean).join(' · ');
    if (sub) { lines.push(`_${sub}_`); lines.push(''); }
    if (card.detail) { lines.push(card.detail); lines.push(''); }
    if (!issues.length) {
      lines.push('The latest crawl reported no error, warning or notice findings.');
      lines.push('');
    } else {
      mdTable(
        lines,
        ['Severity', 'Issue', 'Category', 'Costs points', 'Scored pages affected', 'Findings listed'],
        issues.map((i) => [i.severity, i.title, i.category, techCostCell(i), techPagesCell(i), i.findings]),
      );
      if (total > issues.length) {
        lines.push(`_The ${issues.length} issues that cost the most are listed, of ${total}. `
          + 'The Site Crawler report has every one, page by page._');
        lines.push('');
      }
    }
  }

  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;
    const card = profile.modules.find((m) => m.key === module.key) || null;

    const findings = reportableFindings(run, card);
    lines.push(`## ${module.label} — ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    const subtitle = findingsSubtitle(run, card);
    if (subtitle) { lines.push(`_${subtitle}_`); lines.push(''); }

    if (!findings.length) {
      lines.push(noFindingsText(run, card));
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
        detailText(f.detail),
        f.recommendation || '',
      ]),
    );
  }

  const struct = structureContent(evidenceByModule.get('hub_spoke')?.terminal, structure);
  if (struct) {
    lines.push('## Topic structure (Hub and Spoke)');
    if (struct.note) {
      lines.push(struct.note);
      lines.push('');
    } else {
      lines.push(struct.subtitle);
      lines.push('');
      mdTable(lines, ['Measure', 'Value', 'What it means'], struct.measures);
      if (struct.clusters.length) {
        mdTable(lines, ['Cluster', 'Hub page', 'Spokes', 'Health'], struct.clusters);
        if (struct.clustersCapped) {
          lines.push(`_The ${STRUCTURE_CLUSTER_CAP} largest clusters are listed; Hub and Spoke has the rest._`);
          lines.push('');
        }
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
  mdTable(lines, ['Module', 'Covered?', 'Why'], profile.modules.map((module) => [module.label, ...coverageCells(module)]));
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
  if (typeof detail !== 'string') return detailText(detail);
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
  if (module.profileStale) return 'Profile out of date — results left out';
  if (module.healthPending) return 'Score still being worked out';
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

function buildReportHtml({ project, profile, evidenceByModule, recos, executiveSummary, generatedAt, tech = null, structure = null }) {
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
          const counts = module.profileStale ? {} : (module.evidence?.counts || {});
          const scoreColor = !module.scored ? TONE.neutral : module.score >= 80 ? TONE.good : module.score >= 60 ? TONE.warn : TONE.risk;
          return `
            <div class="module-tile">
              <div class="module-tile-top">
                <span class="module-tile-label">${escapeHtml(module.label)}</span>
                <span class="module-tile-score" style="color:${scoreColor}">${escapeHtml(profileMetric(module) && !module.profileStale ? module.metric.display : (module.scored ? module.score : '—'))}</span>
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

  // ── Tech Audit ──────────────────────────────────────────────────────────
  if (tech) {
    const { card, issues, total } = tech;
    sections.push(`
      <section class="pagebreak">
        <div class="eyebrow">Tech Audit</div>
        <h2>${escapeHtml(techScoreLine(card))}</h2>
        ${card.headline ? `<p class="lead-sub">${escapeHtml(card.headline)}</p>` : ''}
        ${card.coverage ? `<p class="muted">${escapeHtml(card.coverage)}</p>` : ''}
        ${card.detail ? `<p class="muted small">${escapeHtml(card.detail)}</p>` : ''}
        ${issues.length
          ? htmlTable(['Severity', 'Issue', 'Costs points', 'Scored pages affected', 'Findings listed'],
            issues.map((i) => [humanize(i.severity), i.title, techCostCell(i), techPagesCell(i), i.findings]),
            { className: 'data-table' })
          : '<p class="muted">The latest crawl reported no error, warning or notice findings.</p>'}
        ${total > issues.length
          ? `<p class="muted small">The ${issues.length} issues that cost the most are listed, of ${total}. The Site Crawler report has every one, page by page.</p>`
          : ''}
      </section>
    `);
  }

  // ── Per-module deep dives ───────────────────────────────────────────────
  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;
    const entry = evidenceByModule.get(module.key);
    const run = entry?.terminal;
    if (!run) continue;
    const card = profile.modules.find((m) => m.key === module.key) || null;
    const findings = reportableFindings(run, card);
    const subtitle = findingsSubtitle(run, card);

    sections.push(`
      <section class="pagebreak">
        <div class="eyebrow">${escapeHtml(module.label)}</div>
        <h2>${findings.length} finding${findings.length === 1 ? '' : 's'}</h2>
        ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ''}
    `);

    if (!findings.length) {
      sections.push(`<p class="muted">${escapeHtml(noFindingsText(run, card))}</p></section>`);
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
  const struct = structureContent(evidenceByModule.get('hub_spoke')?.terminal, structure);
  if (struct) {
    sections.push('<section class="pagebreak"><div class="eyebrow">Content Architecture</div><h2>Topic structure (Hub and Spoke)</h2>');
    if (struct.note) {
      sections.push(`<p class="muted">${escapeHtml(struct.note)}</p></section>`);
    } else {
      sections.push(`<p class="lead-sub">${escapeHtml(struct.subtitle)}</p>`);
      sections.push(`<div class="module-grid">
        ${struct.measures.map(([label, value, sub]) => kpi(label, String(value ?? '—'), sub)).join('')}
      </div>`);
      if (struct.clusters.length) {
        sections.push(htmlTable(['Cluster', 'Hub page', 'Spokes', 'Health'], struct.clusters, { className: 'data-table' }));
        if (struct.clustersCapped) {
          sections.push(`<p class="muted small">The ${STRUCTURE_CLUSTER_CAP} largest clusters are listed; Hub and Spoke has the rest.</p>`);
        }
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
      ${htmlTable(['Module', 'Covered?', 'Why'], profile.modules.map((module) => [module.label, ...coverageCells(module)]), { className: 'data-table' })}
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
  addTechAuditSheet,
  // The pure builders behind the three formats, for the tests.
  buildMarkdownReport,
  buildReportHtml,
  detailText,
  techAuditRows,
  structureContent,
  profileCells,
};
