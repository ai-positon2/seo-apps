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
  assert.equal(workbook.getWorksheet("Issue Catalog").rowCount, 93);

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
