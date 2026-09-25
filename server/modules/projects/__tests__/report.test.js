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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
