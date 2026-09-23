const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const catalog = require("../issue-catalog.json");
const { buildAuditWorkbook } = require("../report-writer");

test("builds a formatted, editable multi-sheet Excel audit", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  const findings = [
    {
      id: "finding-1",
      ruleId: "page-4xx",
      ...definitions["page-4xx"],
      url: "https://example.com/missing",
      targetUrl: "",
      detail: "Not Found",
      statusCode: 404,
      detectedValue: 404,
      reviewStatus: "Confirmed issue",
      reviewerNotes: "Confirmed manually.",
    },
    {
      id: "finding-2",
      ruleId: "meta-missing",
      ...definitions["meta-missing"],
      url: "https://example.com/service",
      targetUrl: "",
      detail: "",
      statusCode: 200,
      detectedValue: "",
      reviewStatus: "False positive",
      reviewerNotes: "",
    },
    {
      id: "finding-3",
      ruleId: "open-graph-canonical",
      ...definitions["open-graph-canonical"],
      url: "https://example.com/social-preview",
      targetUrl: "https://example.com/preferred",
      detail:
        "og:url: https://social.example.com/shared; canonical: https://example.com/preferred",
      statusCode: 200,
      detectedValue: "https://social.example.com/shared",
      reviewStatus: "Needs review",
      reviewerNotes: "",
    },
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-07-24T12:00:00.000Z",
  });
  assert.ok(buffer.byteLength > 20_000);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.ok(workbook.getWorksheet("SUMMARY"));
  assert.ok(workbook.getWorksheet("Issue Catalog"));
  // One header row plus one row per catalog entry.
  assert.equal(workbook.getWorksheet("Issue Catalog").rowCount, catalog.length + 1);

  const detail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Pages returning 4XX errors",
  );
  assert.ok(detail);
  assert.equal(detail.getCell("F10").value, "Confirmed issue");
  assert.equal(detail.getCell("G10").value, "Confirmed manually.");
  assert.equal(detail.getCell("F10").dataValidation.type, "list");

  const metaDetail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Missing meta descriptions",
  );
  assert.ok(metaDetail);
  assert.equal(metaDetail.getCell("B9").value, "Current Meta Description");
  assert.equal(metaDetail.getCell("C9").value, "Recommended Meta Description");
  assert.equal(metaDetail.getCell("B10").value, "(none)");
  assert.equal(metaDetail.getCell("C10").value, null);
  assert.equal(metaDetail.getCell("E10").value, null);

  const openGraphDetail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Open Graph URL does not match canonical",
  );
  assert.ok(openGraphDetail);
  assert.equal(
    openGraphDetail.getCell("B10").value.text,
    "https://example.com/preferred",
  );
  assert.equal(
    openGraphDetail.getCell("B10").value.hyperlink,
    "https://example.com/preferred",
  );
  assert.equal(
    openGraphDetail.getCell("C10").value,
    "https://social.example.com/shared",
  );

  const summary = workbook.getWorksheet("SUMMARY");
  const issueRow = summary
    .getColumn(2)
    .values.findIndex((value) => value?.text === "Pages returning 4XX errors");
  assert.ok(issueRow > 0);
  assert.match(summary.getCell(`C${issueRow}`).value.formula, /COUNTIF/);
  assert.equal(summary.lastRow.getCell(1).value, null);
  assert.equal(summary.lastRow.getCell(4).value, null);
  assert.equal(summary.lastRow.getCell(5).value, null);
  assert.equal(summary.lastRow.getCell(6).value, null);

  // V9.0: Consolidated Actions lands as the second tab, right after SUMMARY.
  assert.equal(workbook.worksheets[1].name, "Consolidated Actions");
});

test("V9.0: Consolidated Actions is one row per root cause, links to its detail sheet, and drops fully-dismissed groups", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  const findings = [
    // 3 rows sharing the same redirected target — one root cause.
    ...["/a", "/b", "/c"].map((path, i) => ({
      id: `link-${i}`,
      ruleId: "link-to-redirect",
      ...definitions["link-to-redirect"],
      scope: "page",
      url: `https://example.com${path}`,
      targetUrl: "https://example.com/old-service",
      detail: "Target redirects (301) to https://example.com/current",
      statusCode: 301,
      detectedValue: "301 -> https://example.com/current",
      reviewStatus: "Needs review",
      reviewerNotes: "",
    })),
    // A whole rule with every instance already dismissed — must not appear.
    {
      id: "dismissed-1",
      ruleId: "meta-missing",
      ...definitions["meta-missing"],
      scope: "page",
      url: "https://example.com/dismissed",
      targetUrl: "",
      detail: "",
      statusCode: 200,
      detectedValue: "",
      reviewStatus: "False positive",
      reviewerNotes: "",
    },
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.getWorksheet("Consolidated Actions");
  assert.ok(sheet);
  assert.match(sheet.getCell("A1").value, /^1 action across 3 page-level occurrences$/);

  // Header at row 3 (title + note rows above it), one data row at row 4.
  assert.equal(sheet.getCell("A3").value, "#");
  assert.equal(sheet.getCell("B3").value, "Root Cause");
  const dataRow = sheet.getRow(4);
  assert.equal(dataRow.getCell(2).value.text, "Links to redirected pages");
  assert.match(dataRow.getCell(2).value.hyperlink, /^#'Links to redirected pages'!A1$/);
  assert.equal(dataRow.getCell(3).value, 3, "Occurrences: all 3 rows collapse to one root cause");
  assert.equal(dataRow.getCell(4).value, 3, "Affected Pages: 3 distinct source pages");
  assert.equal(dataRow.getCell(5).value, 1, "Unique Targets: one shared redirected URL");
  assert.equal(dataRow.getCell(6).value, "Template");
  assert.equal(dataRow.getCell(9).value, "Needs review");

  // Only one row of data — the fully-dismissed meta-missing group is absent.
  assert.equal(sheet.lastRow.number, 4);
});

test("SUMMARY ranks issues within a priority tier by affected-page count, not alphabetically", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  // Both High Priority + category "Technical", so alphabetical order (by title)
  // would put "Broken internal links" before "Page appears in multiple
  // sitemaps". Give the alphabetically-later one more active findings and
  // confirm it still comes first — ranking must be count-driven, not A-Z.
  const makeFinding = (n, ruleId, reviewStatus) => ({
    id: `finding-${ruleId}-${n}`,
    ruleId,
    ...definitions[ruleId],
    url: `https://example.com/${ruleId}-${n}`,
    targetUrl: "",
    detail: "",
    statusCode: 200,
    detectedValue: "",
    reviewStatus,
    reviewerNotes: "",
  });
  const findings = [
    makeFinding(1, "broken-internal-links", "Confirmed issue"),
    makeFinding(1, "sitemap-duplicate", "Confirmed issue"),
    makeFinding(2, "sitemap-duplicate", "Needs review"),
    makeFinding(3, "sitemap-duplicate", "Needs review"),
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-07-28T00:00:00.000Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const summary = workbook.getWorksheet("SUMMARY");
  const titles = summary.getColumn(2).values.map((value) => value?.text).filter(Boolean);

  const sitemapRow = titles.indexOf("Page appears in multiple sitemaps");
  const brokenLinksRow = titles.indexOf("Broken internal links");
  assert.notEqual(sitemapRow, -1);
  assert.notEqual(brokenLinksRow, -1);
  assert.ok(
    sitemapRow < brokenLinksRow,
    "the 3-finding issue should rank above the 1-finding issue despite alphabetical order",
  );
});

test("V5.1: site-scoped and slow-page findings get Site/Config fix types, never scaled by row count", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  assert.equal(definitions["hsts-missing"].scope, "site");

  const makeFinding = (n, ruleId, detectedValue) => ({
    id: `finding-${ruleId}-${n}`,
    ruleId,
    ...definitions[ruleId],
    url: `https://example.com/host-${n}/`,
    targetUrl: "",
    detail: "",
    statusCode: 0,
    detectedValue,
    reviewStatus: "Needs review",
    reviewerNotes: "",
  });
  const findings = [
    makeFinding(1, "hsts-missing", "no HSTS"),
    makeFinding(2, "hsts-missing", "no HSTS"),
    // Deliberately distinct detectedValues and > 5 rows — the generic
    // heuristic would call this "Page" (mostly distinct values, no shared
    // cause), but slow-page must be forced to "Config" regardless.
    makeFinding(1, "slow-page", 2871),
    makeFinding(2, "slow-page", 3402),
    makeFinding(3, "slow-page", 2965),
    makeFinding(4, "slow-page", 3810),
    makeFinding(5, "slow-page", 2604),
    makeFinding(6, "slow-page", 4013),
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const hstsDetail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Subdomains do not support HSTS",
  );
  assert.ok(hstsDetail);
  // Generic layout: url(1) target(2) value(3) code(4) recommendation(5)
  // status(6) notes(7) fixType(8) effort(9) owner(10) targetDate(11) impact(12).
  // Data rows start at 10 (tableHeaderRow is a fixed 9).
  assert.equal(hstsDetail.getCell(10, 8).value, "Site");
  assert.equal(hstsDetail.getCell(10, 9).value, "Easy");

  const slowDetail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Slow pages",
  );
  assert.ok(slowDetail);
  // slow-page drops the "Target / Related URL" column, so every column from
  // "value" onward shifts one to the left of the generic layout above:
  // url(1) value(2) code(3) recommendation(4) status(5) notes(6) fixType(7) effort(8).
  assert.notEqual(slowDetail.getCell(9, 2).value, "Target / Related URL");
  assert.equal(slowDetail.getCell(10, 7).value, "Config");
  assert.equal(slowDetail.getCell(10, 8).value, "Easy");
  // Raw ms, not seconds ("2.87s") — the number itself, display formatting is separate.
  assert.equal(slowDetail.getCell(10, 2).value, 2871);
});

test("V5.1: Recommended Length holds a target range, never the recommendation sentence's own length", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  const longSentence =
    "Needs a manual rewrite — current title is 84 characters (target 50-60). Keep the primary topic and brand; don't just shorten this one.";
  assert.ok(longSentence.length > 60, "fixture sentence must be long enough to prove the bug would trigger");

  const findings = [
    {
      id: "finding-title-long-1",
      ruleId: "title-long",
      ...definitions["title-long"],
      url: "https://example.com/page-1",
      targetUrl: "",
      detail: "84 characters",
      statusCode: 200,
      detectedValue: "A".repeat(84),
      recommendedValue: longSentence,
      reviewStatus: "Needs review",
      reviewerNotes: "",
    },
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const titleDetail = workbook.worksheets.find(
    (sheet) => sheet.getCell("A1").value === "Titles are too long",
  );
  assert.ok(titleDetail);
  // Before/after layout: url(A) current(B) recommended(C) status(D) notes(E)
  // currentLength(F) recommendedLength(G).
  assert.equal(titleDetail.getCell("F10").value, 84); // currentLength: the real current title's length
  assert.equal(titleDetail.getCell("G10").value, "50–60"); // recommendedLength: the target range, not longSentence.length (134)
});

test("V5.1: a 'Checks Passed' sheet lists every automatic check with zero active findings", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  const findings = [
    {
      id: "finding-1",
      ruleId: "page-4xx",
      ...definitions["page-4xx"],
      url: "https://example.com/missing",
      targetUrl: "",
      detail: "",
      statusCode: 404,
      detectedValue: 404,
      reviewStatus: "Confirmed issue",
      reviewerNotes: "",
    },
    {
      // A dismissed finding must NOT disqualify its check from "clean" —
      // matches the client's buildSeoSnapshot Strengths quadrant exactly.
      id: "finding-2",
      ruleId: "meta-missing",
      ...definitions["meta-missing"],
      url: "https://example.com/service",
      targetUrl: "",
      detail: "",
      statusCode: 200,
      detectedValue: "",
      reviewStatus: "False positive",
      reviewerNotes: "",
    },
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const passedSheet = workbook.getWorksheet("Checks Passed");
  assert.ok(passedSheet);

  const automaticChecks = catalog.filter((c) => c.detection === "Automatic");
  // Only page-4xx has a live (non-dismissed) finding; meta-missing's only
  // finding was dismissed, so it still counts as clean.
  const expectedClean = automaticChecks.length - 1;
  assert.equal(passedSheet.getCell("A1").value, `${expectedClean} of ${automaticChecks.length} automatic checks clean`);

  const titles = passedSheet.getColumn(1).values.filter(Boolean);
  assert.ok(titles.includes("Missing meta descriptions"));
  assert.ok(!titles.includes("Pages returning 4XX errors"));
});

test("V5.1: SUMMARY's TOTAL reconciles against its own per-rule rows (server-side invariant)", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  const makeFinding = (n, ruleId, reviewStatus = "Needs review") => ({
    id: `finding-${ruleId}-${n}`,
    ruleId,
    ...definitions[ruleId],
    url: `https://example.com/${ruleId}-${n}`,
    targetUrl: "",
    detail: "",
    statusCode: 200,
    detectedValue: "",
    reviewStatus,
    reviewerNotes: "",
  });
  const findings = [
    makeFinding(1, "broken-internal-links"),
    makeFinding(1, "meta-missing"),
    makeFinding(2, "meta-missing"),
    makeFinding(3, "meta-missing", "False positive"), // dismissed, but still an "occurrence" row
    makeFinding(1, "h1-missing"),
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const summary = workbook.getWorksheet("SUMMARY");

  // Column C ("Open Occurrences") on every real issue row, up to the TOTAL row.
  let summedFromRows = 0;
  for (let rowNumber = 3; rowNumber < summary.lastRow.number; rowNumber += 1) {
    const cell = summary.getCell(`C${rowNumber}`);
    const value = cell.value?.result ?? cell.value;
    if (typeof value === "number") summedFromRows += value;
  }
  const totalCell = summary.lastRow.getCell(3);
  assert.equal(totalCell.value.result, summedFromRows);
  // TOTAL counts OPEN occurrences (the "Open Occurrences" column header),
  // not every finding this crawl ever produced — a dismissed finding
  // (False positive/Resolved) is exactly the distinction the header button
  // and reconciliation strip fix in V5.1 makes on the client side too.
  const activeCount = findings.filter(
    (f) => !["False positive", "Resolved"].includes(f.reviewStatus),
  ).length;
  assert.equal(totalCell.value.result, activeCount);
});

test("V5.1: a site-scoped finding gets its own SUMMARY block, excluded from TOTAL", async () => {
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  assert.equal(definitions["hsts-missing"].scope, "site");

  const findings = [
    {
      id: "finding-page-1",
      ruleId: "broken-internal-links",
      ...definitions["broken-internal-links"],
      url: "https://example.com/page-1",
      targetUrl: "",
      detail: "",
      statusCode: 200,
      detectedValue: "",
      reviewStatus: "Needs review",
      reviewerNotes: "",
    },
    {
      id: "finding-hsts-1",
      ruleId: "hsts-missing",
      ...definitions["hsts-missing"],
      url: "https://sub1.example.com/",
      targetUrl: "",
      detail: "",
      statusCode: 0,
      detectedValue: "",
      reviewStatus: "Needs review",
      reviewerNotes: "",
    },
    {
      id: "finding-hsts-2",
      ruleId: "hsts-missing",
      ...definitions["hsts-missing"],
      url: "https://sub2.example.com/",
      targetUrl: "",
      detail: "",
      statusCode: 0,
      detectedValue: "",
      reviewStatus: "Needs review",
      reviewerNotes: "",
    },
  ];

  const buffer = await buildAuditWorkbook({
    findings,
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const summary = workbook.getWorksheet("SUMMARY");

  const values = summary.getColumn(2).values;
  const bandRowIndex = values.findIndex(
    (v) => v === "Site, resource & template-level findings — not page-scoped, and not part of TOTAL above",
  );
  assert.ok(bandRowIndex > 0, "expected a 'Site-level findings' band row");
  const hstsRowIndex = values.findIndex((v) => v?.text?.includes("Subdomains do not support HSTS"));
  assert.ok(hstsRowIndex > bandRowIndex, "HSTS row should appear inside the site-level block");
  assert.equal(summary.getCell(`C${hstsRowIndex}`).value.result, 2);
  // The Tier column (G) is what the real SUMIF keys off of — it must be
  // genuinely blank on this row, not just visually separated on the sheet.
  assert.equal(summary.getCell(`G${hstsRowIndex}`).value, null);

  // TOTAL must equal only the page-scoped finding (1), never 1 + 2.
  const totalRowIndex = values.findIndex((v) => v === "TOTAL");
  assert.ok(totalRowIndex > 0);
  assert.equal(summary.getCell(`C${totalRowIndex}`).value.result, 1);
});

test("crawler-completeness Phase 1: a rule split across page and template scope in the same run gets two rows, two detail sheets, and TOTAL counts only the page-scoped half", async () => {
  // Mirrors what collapseTemplateFindings() in analyzer.js actually
  // produces: broken-internal-links fires on both a genuine one-off broken
  // link (stays scope='page', the catalog default) AND a shared-footer link
  // that recurred across enough pages to be re-tagged scope='template' on
  // just those finding objects — the RULE's own catalog definition never
  // changes, only some of its instances this run.
  const definitions = Object.fromEntries(catalog.map((item) => [item.id, item]));
  assert.equal(definitions["broken-internal-links"].scope, undefined, "the catalog entry itself stays page-scoped by default");

  const pageScoped = {
    id: "finding-page-scoped",
    ruleId: "broken-internal-links",
    ...definitions["broken-internal-links"],
    scope: "page",
    url: "https://example.com/one-off",
    targetUrl: "https://example.com/typo-link",
    detail: "",
    statusCode: 404,
    detectedValue: "",
    reviewStatus: "Needs review",
    reviewerNotes: "",
  };
  const templateScoped = Array.from({ length: 6 }, (_, i) => ({
    id: `finding-template-${i}`,
    ruleId: "broken-internal-links",
    ...definitions["broken-internal-links"],
    scope: "template", // set by collapseTemplateFindings, not the catalog
    url: `https://example.com/page-${i}`,
    targetUrl: "https://example.com/search",
    detail: "",
    statusCode: 0,
    detectedValue: "",
    reviewStatus: "Needs review",
    reviewerNotes: "",
  }));

  const buffer = await buildAuditWorkbook({
    findings: [pageScoped, ...templateScoped],
    catalog,
    siteUrl: "https://example.com/",
    crawlDate: "2026-09-01T10:10:16.271Z",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const summary = workbook.getWorksheet("SUMMARY");
  const values = summary.getColumn(2).values;

  // The main table gets exactly one row for the page-scoped finding, count
  // 1 — not 7. Suffixed "(Page)" since the rule split this run, same as the
  // detail sheet it links to.
  const mainRowIndex = values.findIndex((v) => v?.text === "Broken internal links (Page)");
  assert.ok(mainRowIndex > 0);
  assert.equal(summary.getCell(`C${mainRowIndex}`).value.result, 1);

  // The template block gets its own row, suffixed, with count 6.
  const templateRowIndex = values.findIndex((v) => v?.text === "Broken internal links (Template)");
  assert.ok(templateRowIndex > 0);
  assert.equal(summary.getCell(`C${templateRowIndex}`).value.result, 6);
  assert.equal(summary.getCell(`G${templateRowIndex}`).value, null, "Tier blank keeps it out of TOTAL's SUMIF");

  // TOTAL is 1, not 7 — the whole point of the rollup.
  const totalRowIndex = values.findIndex((v) => v === "TOTAL");
  assert.equal(summary.getCell(`C${totalRowIndex}`).value.result, 1);

  // Two distinct detail sheets, not one mixed one — each with only its own
  // scope's rows, so the sheet's own COUNTIF ranges never double-count. A1
  // is checked rather than the tab name — a long enough title truncates at
  // Excel's 31-character sheet-name ceiling (pre-existing, unrelated to this
  // change), but A1's own display title never does.
  const pageDetail = workbook.worksheets.find((s) => s.getCell("A1").value === "Broken internal links (Page)");
  const templateDetail = workbook.worksheets.find((s) => s.getCell("A1").value === "Broken internal links (Template)");
  assert.ok(pageDetail && templateDetail && pageDetail !== templateDetail);

  // Generic layout: url(1) target(2) value(3) code(4) recommendation(5)
  // status(6) notes(7) fixType(8). Data rows start at 10.
  assert.equal(templateDetail.getCell(10, 8).value, "Template");
});
