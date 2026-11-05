// Tests for the project report (PRD phase 7).
//
// The sheet builders take plain data, so the workbook can be built and read back
// without a database. What is worth asserting is not the formatting — it is that
// a missing measurement never renders as a blank or a zero. A spreadsheet is the
// single easiest place for "we never measured this" to be read as "this is zero",
// which §16.11 and §30 both exist to prevent.

const assert = require('assert');
const ExcelJS = require('exceljs');
const report = require('../report');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed += 1;
  }
}

const cellsOf = (sheet) => {
  const values = [];
  sheet.eachRow((row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cell.value === null || cell.value === undefined ? '' : String(cell.value));
    });
  });
  return values;
};

const scoredModule = {
  key: 'seo_geo', label: 'SEO & GEO', status: 'completed', scored: true, score: 74,
  scoreBasis: 'SEO & GEO audit: rule-based bucket scores', updatedAt: '2026-08-21T10:00:00Z',
  evidence: { counts: { error: 1, warning: 8, notice: 3 } },
};

const unscoredModule = {
  key: 'on_page', label: 'On-Page', status: 'completed_with_errors', scored: false, score: null,
  updatedAt: '2026-08-21T10:05:00Z',
  evidence: { counts: { error: 4, warning: 12, notice: 2 } },
};

const neverRunModule = {
  key: 'competitor', label: 'Competitor Research', status: 'not_run', scored: false, score: null,
  updatedAt: null, evidence: null,
};

async function main() {
  console.log('\nProject report — the audit profile sheet');

  await test('a module that does not score says so instead of leaving a blank', async () => {
    const book = new ExcelJS.Workbook();
    report.addProfileSheet(book, {
      project: { name: 'Gentle Dental', primaryDomain: { origin: 'https://gd.com' }, countryCode: 'US' },
      modules: [scoredModule, unscoredModule],
      composite: { value: 74, status: 'partial', scoredModules: 1, totalModules: 2 },
    });
    const cells = cellsOf(book.getWorksheet('Audit profile'));
    assert.ok(cells.includes('Not scored'), 'the score cell is labelled, not empty');
    assert.ok(
      cells.some((c) => /reports findings, not a 0–100 score/.test(c)),
      'and the reason is stated on the row',
    );
    assert.ok(!cells.includes('0'), 'no zero appears anywhere near an unscored module');
  });

  await test("a scored module carries the basis for its number", async () => {
    const book = new ExcelJS.Workbook();
    report.addProfileSheet(book, {
      project: { name: 'X', primaryDomain: null, legacyUrl: 'https://x.com' },
      modules: [scoredModule],
      composite: { value: 74, status: 'partial', scoredModules: 1, totalModules: 1 },
    });
    const cells = cellsOf(book.getWorksheet('Audit profile'));
    assert.ok(cells.includes('74'));
    assert.ok(
      cells.some((c) => /rule-based bucket scores/.test(c)),
      'a number in a client-facing export must be attributable',
    );
  });

  await test('a null composite is spelled out, never rendered as zero', async () => {
    const book = new ExcelJS.Workbook();
    report.addProfileSheet(book, {
      project: { name: 'X', primaryDomain: null, legacyUrl: 'https://x.com' },
      modules: [unscoredModule, neverRunModule],
      composite: { value: null, status: 'insufficient_data', scoredModules: 0, totalModules: 2 },
    });
    const cells = cellsOf(book.getWorksheet('Audit profile'));
    assert.ok(cells.includes('No composite'));
    assert.ok(cells.some((c) => /It is not zero/.test(c)), 'the sheet says it explicitly');
  });

  console.log('\nProject report — findings sheets');

  await test('a module with findings gets a sheet, sorted worst first', async () => {
    const book = new ExcelJS.Workbook();
    // seo_geo, not on_page: addFindingsSheets looks the key up in MODULES, and
    // on_page is no longer one. What this test is about is finding order, so any
    // live module serves.
    const evidence = new Map([['seo_geo', {
      terminal: {
        status: 'completed', target_url: 'https://x.com', finished_at: '2026-08-21T10:00:00Z',
        score: null,
        findings: [
          { ruleId: 'a', title: 'Low severity thing', severity: 'notice', count: 100 },
          { ruleId: 'b', title: 'Broken thing', severity: 'error', count: 2 },
        ],
      },
      inFlight: null,
    }]]);
    const added = report.addFindingsSheets(book, evidence);
    assert.strictEqual(added, 1);
    const sheet = book.worksheets[0];
    const cells = cellsOf(sheet);
    assert.ok(cells.indexOf('Broken thing') < cells.indexOf('Low severity thing'),
      'an error outranks a higher-count notice');
  });

  await test('a module that ran with nothing to measure says that, not "no findings"', async () => {
    const book = new ExcelJS.Workbook();
    const evidence = new Map([['competitor', {
      terminal: { status: 'insufficient_data', findings: [], finished_at: '2026-08-21T10:00:00Z' },
      inFlight: null,
    }]]);
    report.addFindingsSheets(book, evidence);
    const cells = cellsOf(book.worksheets[0]);
    assert.ok(
      cells.some((c) => /nothing it could measure/.test(c)),
      'the distinction between "clean" and "not measured" survives the export',
    );
  });

  await test('a module with no run at all gets no sheet', async () => {
    const book = new ExcelJS.Workbook();
    assert.strictEqual(report.addFindingsSheets(book, new Map()), 0);
    assert.strictEqual(book.worksheets.length, 0);
  });

  console.log('\nProject report — structure and recommendations');

  await test('the structure sheet explains a missing link graph', async () => {
    const book = new ExcelJS.Workbook();
    const evidence = new Map([['hub_spoke', {
      terminal: {
        status: 'insufficient_data',
        payload: { note: 'This crawl stored no internal link graph.' },
      },
      inFlight: null,
    }]]);
    report.addStructureSheet(book, evidence);
    const cells = cellsOf(book.getWorksheet('Site structure'));
    assert.ok(cells.some((c) => /no internal link graph/.test(c)));
  });

  await test('the structure sheet gives the run\'s own reason when only its note was loaded', async () => {
    // The dashboard's evidence rows carry `note` projected out of the payload,
    // not the payload itself — so a "too few informational pages" run arrives
    // with run.note and no payload.note.
    const book = new ExcelJS.Workbook();
    const evidence = new Map([['hub_spoke', {
      terminal: {
        status: 'insufficient_data',
        note: 'Only 2 informational page(s) (articles, guides, FAQs) among the 590 the crawl read.',
      },
      inFlight: null,
    }]]);
    report.addStructureSheet(book, evidence);
    const cells = cellsOf(book.getWorksheet('Site structure'));
    assert.ok(cells.some((c) => /Only 2 informational page/.test(c)));
    assert.ok(!cells.some((c) => /No completed crawl with a stored link graph/.test(c)));
  });

  await test('an empty recommendation board is explained rather than blank', async () => {
    const book = new ExcelJS.Workbook();
    report.addRecommendationsSheet(book, []);
    const cells = cellsOf(book.getWorksheet('Recommendations'));
    assert.ok(cells.some((c) => /No recommendations have been raised/.test(c)));
  });

  await test('a rejected recommendation keeps its reason in the export', async () => {
    const book = new ExcelJS.Workbook();
    report.addRecommendationsSheet(book, [{
      status: 'rejected', priority: 'high', title: 'Rewrite titles', moduleKey: 'on_page',
      body: null, rejectionReason: 'Client is mid-rebrand', rejectedAt: '2026-08-21T10:00:00Z',
    }]);
    const cells = cellsOf(book.getWorksheet('Recommendations'));
    assert.ok(cells.includes('Client is mid-rebrand'),
      'why advice was declined is the part a retro needs');
  });

  console.log('\nProject report — coverage');

  await test('a never-run module is listed as not covered', async () => {
    const book = new ExcelJS.Workbook();
    report.addCoverageSheet(book, {
      modules: [scoredModule, neverRunModule],
      generatedAt: '2026-08-21 10:00',
    });
    const cells = cellsOf(book.getWorksheet('Coverage and gaps'));
    assert.ok(cells.includes('no'));
    assert.ok(cells.some((c) => /Never run against this project/.test(c)));
    assert.ok(
      cells.some((c) => /reads as a zero/.test(c)),
      'the workbook states its own convention for missing numbers',
    );
  });

  await test('the whole workbook serialises to a real xlsx', async () => {
    const book = new ExcelJS.Workbook();
    report.addProfileSheet(book, {
      project: { name: 'Gentle Dental', primaryDomain: { origin: 'https://gd.com' }, countryCode: 'US' },
      modules: [scoredModule, unscoredModule, neverRunModule],
      composite: { value: 74, status: 'partial', scoredModules: 1, totalModules: 3 },
    });
    report.addRecommendationsSheet(book, []);
    report.addCoverageSheet(book, { modules: [scoredModule], generatedAt: '2026-08-21 10:00' });

    const buffer = await book.xlsx.writeBuffer();
    assert.ok(buffer.byteLength > 5000, 'a workbook with three sheets is not a stub');

    // Read it back: a file Excel cannot open is not a report.
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(buffer);
    assert.deepStrictEqual(
      reread.worksheets.map((w) => w.name),
      ['Audit profile', 'Recommendations', 'Coverage and gaps'],
    );
  });

  console.log('\nProject report — Tech Audit, structure and AI Visibility (UX-057/058/059/108)');

  const techCard = {
    key: 'technical', label: 'Tech Audit', status: 'completed', scored: true, score: 71,
    headline: '3 pages lose points to errors', detail: '300 pages crawled', runId: 'crawl-1',
    updatedAt: '2026-10-15T10:00:00Z', evidence: { counts: { error: 534, warning: 20, notice: 9 } },
  };
  const costing = new Map([
    ['broken-js', { severity: 'error', pages: new Set(['https://x.com/a', 'https://x.com/b', 'https://x.com/c']) }],
    ['robots-blocked', { severity: 'warning', pages: new Set(), siteLevel: 'site' }],
  ]);
  const rollup = [
    { rule_id: 'img-alt', severity: 'error', category: 'Images', count: 400, detail: { title: 'Images without alt text' } },
    { rule_id: 'broken-js', severity: 'error', category: 'Resources', count: 12, detail: { title: 'Broken internal JavaScript' } },
    { rule_id: 'robots-blocked', severity: 'warning', category: 'Crawl', count: 1, detail: { title: 'Robots.txt blocks a section' } },
    { rule_id: 'meta-short', severity: 'notice', category: 'Meta', count: 30, detail: null },
  ];

  await test('the Tech Audit section lists what costs points first, with pages affected', async () => {
    const tech = report.techAuditRows(techCard, rollup, costing);
    assert.deepStrictEqual(tech.issues.map((i) => i.ruleId), ['broken-js', 'robots-blocked', 'img-alt', 'meta-short']);
    assert.strictEqual(tech.issues[0].pages, 3);
    assert.strictEqual(tech.issues[2].costsPoints, false, 'a listed finding that costs nothing says so');
    const book = new ExcelJS.Workbook();
    report.addTechAuditSheet(book, tech);
    const cells = cellsOf(book.getWorksheet('Tech Audit'));
    assert.ok(cells.some((c) => /Site Health 71\/100/.test(c)));
    assert.ok(cells.includes('Broken internal JavaScript'));
    assert.ok(cells.includes('site-wide'));
  });

  const hubRun = { status: 'completed', finished_at: '2026-10-09T10:00:00Z', findings: [] };
  const structure = {
    savedAt: '2026-10-09T10:00:00Z', pages: 121, clusters: 25, gaps: 4, unassigned: 18, meanHealth: 62,
    clusterRows: [{ name: 'Fundraising', hub: 'https://x.com/fundraising', spokes: 9, health: 70, gap: false },
      { name: 'Events', hub: null, spokes: 3, health: 41, gap: true }],
  };
  const aivStale = {
    key: 'ai_visibility_lite', label: 'AI Visibility', status: 'completed_with_errors', scored: false, score: null,
    updatedAt: '2026-10-01T10:00:00Z', evidence: { counts: { error: 1, notice: 1 } },
    metric: { value: null, display: '—', unit: 'profile built for position2.com — rebuild it', tag: 'Profile out of date' },
    profileStale: { builtFor: 'position2.com' },
  };
  const aivRun = {
    status: 'completed_with_errors', finished_at: '2026-10-01T10:00:00Z', score: 50,
    findings: [{ ruleId: 'aiv-absent', title: 'Not named in 30 of 30 measured prompts', severity: 'error', count: 30,
      detail: { prompts: ['best marketing agency', 'best marketing agency'] } }],
  };
  const project = { name: 'Soteri', primaryDomain: { origin: 'https://soteriskin.com' } };
  const composite = { value: 71, status: 'partial', scoredModules: 1, totalModules: 3 };

  await test('the markdown report has Tech Audit and real structure figures, never "undefined"', async () => {
    const evidence = new Map([['hub_spoke', { terminal: hubRun }], ['ai_visibility_lite', { terminal: aivRun }]]);
    const md = report.buildMarkdownReport({
      project,
      profile: { modules: [techCard, aivStale], composite },
      evidenceByModule: evidence,
      recos: [],
      generatedAt: '2026-11-05 10:00',
      tech: report.techAuditRows(techCard, rollup, costing),
      structure,
    });
    assert.ok(/## Tech Audit — Site Health 71\/100/.test(md));
    assert.ok(/121 pages analysed · 25 topic clusters/.test(md));
    assert.ok(/No hub yet/.test(md));
    assert.ok(!/undefined/.test(md), 'no "undefined" anywhere');
    // UX-108: the stale profile's agency prompts are not this client's results.
    assert.ok(!/best marketing agency/.test(md));
    assert.ok(/Profile out of date/.test(md));
    assert.ok(/\| AI Visibility \| no \|/.test(md), 'counted as not covered');
    assert.ok(!/completed_with_errors/.test(md), 'statuses read as words');
  });

  await test('a Hub and Spoke run with no saved analysis gets a sentence, not an empty table', async () => {
    const book = new ExcelJS.Workbook();
    report.addStructureSheet(book, new Map([['hub_spoke', { terminal: hubRun }]]), null);
    const cells = cellsOf(book.getWorksheet('Site structure'));
    assert.ok(cells.some((c) => /no saved Content Architect analysis/.test(c)));
    assert.ok(!cells.some((c) => /undefined/.test(c)));
  });

  await test('the PDF html carries the same sections and no raw code', async () => {
    const evidence = new Map([['hub_spoke', { terminal: hubRun }]]);
    const html = report.buildReportHtml({
      project,
      profile: { modules: [techCard], composite },
      evidenceByModule: evidence,
      recos: [],
      executiveSummary: {
        verdict: { state: 'healthy', headline: 'h', sentence: 's' },
        standing: { score: 71, basis: 'b' },
        leverage: { actions: 0 },
        priorities: [],
        confidence: { crawledPages: 300, modulesCovered: 1, modulesTotal: 3, sentence: 'c', caveats: [] },
      },
      generatedAt: '2026-11-05 10:00',
      tech: report.techAuditRows(techCard, rollup, costing),
      structure,
    });
    assert.ok(/Tech Audit/.test(html) && /Broken internal JavaScript/.test(html));
    assert.ok(/Fundraising/.test(html));
    assert.ok(!/undefined/.test(html));
  });

  await test('AI Visibility details read as sentences, and the profile leads with the card\'s figure', async () => {
    const text = report.detailText({ competitors: [{ name: 'givebutter', prompts: 6 }] });
    assert.strictEqual(text, 'givebutter named in 6 prompts');
    const prompts = report.detailText({ prompts: ['a', 'a', 'b', 'c', 'd'] });
    assert.ok(/and 1 more/.test(prompts) && !/[{[]/.test(prompts), prompts);
    assert.ok(!/^[{[]/.test(report.detailText({ domains: [{ domain: 'bloomerang.com', prompts: 3 }] })));
    const cells = report.profileCells({
      key: 'ai_visibility_lite', label: 'AI Visibility', status: 'completed_with_errors', scored: true, score: 50,
      metric: { value: 17, display: '17%', unit: 'of AI answers' }, evidence: { counts: {} },
    });
    assert.strictEqual(cells[1], 'Finished with errors');
    assert.strictEqual(cells[2], '17%');
    assert.ok(/0–100 score is 50/.test(cells[4]), 'both figures, each labelled');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
