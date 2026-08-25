const ExcelJS = require("exceljs");

const COLORS = {
  navy: "1F4E78",
  navyDark: "17365D",
  lightBlue: "B4C7E7",
  headerGray: "B7B7B7",
  white: "FFFFFF",
  zebra: "F5F8FC",
  black: "111827",
  border: "D9E0E8",
  link: "0000FF",
  error: "FDE9E9",
  warning: "FFF2CC",
  notice: "DDEBF7",
  green: "E2F0D9",
  muted: "667085",
};

// One color per priority tier, used for the SUMMARY band headers and for a
// tinted badge on each row so the tier stays visible even after sorting or
// scrolling away from the band header.
const PRIORITY_COLORS = {
  "High Priority": { band: "B03A2E", tint: "FADBD8", text: COLORS.white },
  "Medium Priority": { band: "B9770E", tint: "FCF3CF", text: COLORS.white },
  "Good to have": { band: "1E8449", tint: "D5F5E3", text: COLORS.white },
};
const DEFAULT_PRIORITY_COLOR = { band: COLORS.navy, tint: COLORS.zebra, text: COLORS.white };

const REVIEW_STATUSES = [
  "Needs review",
  "Confirmed issue",
  "False positive",
  "Resolved",
];

// Detail sheets for these rules show a Current/Recommended pair instead of
// the generic Target/Detected Value/Recommendations columns — a concrete
// before-and-after is far more actionable than a length or a generic tip
// repeated on every row of the sheet.
const BEFORE_AFTER_LABELS = {
  "title-long": { current: "Current Title", recommended: "Recommended Title" },
  "meta-long": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "meta-short": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "meta-missing": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "h1-missing": { current: "Current H1", recommended: "Recommended H1" },
};

function valueOrNull(value) {
  return value === "" || value === undefined || value === null ? null : value;
}

function safeSheetName(name, usedNames) {
  const base = name.replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || "Issue";
  let candidate = base;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${counter}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function quoteSheet(name) {
  return `'${name.replaceAll("'", "''")}'`;
}

function excelColumnLetter(oneBasedIndex) {
  let n = oneBasedIndex;
  let letters = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function applyGridBorder(cell) {
  cell.border = {
    top: { style: "thin", color: { argb: COLORS.border } },
    bottom: { style: "thin", color: { argb: COLORS.border } },
    left: { style: "thin", color: { argb: COLORS.border } },
    right: { style: "thin", color: { argb: COLORS.border } },
  };
}

// Row heights are content-dependent: a "Missing H1" row and a Schema.org
// validation-error row need wildly different heights to avoid either wasting
// space or clipping text. This estimates wrapped line count per cell from its
// column width and picks the tallest cell in the row.
function estimateWrappedLines(text, columnWidth) {
  if (text === null || text === undefined || text === "") return 1;
  const charsPerLine = Math.max(10, Math.round(columnWidth * 1.7));
  return String(text)
    .split("\n")
    .reduce((total, segment) => total + Math.max(1, Math.ceil(segment.length / charsPerLine)), 0);
}

function rowHeightFromLines(lines, { lineHeight = 13, minHeight = 20, maxHeight = 140 } = {}) {
  return Math.min(maxHeight, Math.max(minHeight, lines * lineHeight + 8));
}

function styleSummarySheet(sheet) {
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.columns = [
    { key: "priority", width: 8 },
    { key: "issue", width: 34 },
    { key: "errors", width: 17 },
    { key: "status", width: 24 },
    { key: "implemented", width: 22 },
    { key: "action", width: 72 },
  ];
  const header = sheet.getRow(1);
  header.height = 36;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerGray } };
    cell.font = { name: "Poppins", size: 11, bold: true, color: { argb: "000000" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyGridBorder(cell);
  });
}

function addPriorityBand(sheet, title) {
  const palette = PRIORITY_COLORS[title] || DEFAULT_PRIORITY_COLOR;
  const row = sheet.addRow([title]);
  sheet.mergeCells(row.number, 1, row.number, 6);
  row.height = 24;
  const cell = row.getCell(1);
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.band } };
  cell.font = { name: "Poppins", size: 11, bold: true, color: { argb: palette.text } };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  return row.number;
}

function styleDetailSheet(sheet, lastColumnLetter, tableHeaderRow, lastDataRow) {
  sheet.views = [
    {
      state: "frozen",
      ySplit: tableHeaderRow,
      showGridLines: false,
    },
  ];
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  sheet.autoFilter = {
    from: `A${tableHeaderRow}`,
    to: `${lastColumnLetter}${Math.max(tableHeaderRow, lastDataRow)}`,
  };
}

// Column layout for a rule's detail sheet. Most rules share the generic
// layout (a page URL, whatever related URL or detail text applies, the
// detected value, an HTTP code where relevant, the catalog recommendation,
// review status, and reviewer notes). A handful of rules — the ones where a
// concrete rewritten value is more useful than a repeated generic tip — get a
// Current/Recommended pair instead.
function detailColumns(ruleId) {
  const beforeAfter = BEFORE_AFTER_LABELS[ruleId];
  if (beforeAfter) {
    return [
      { key: "url", header: "Page URL", width: 54, type: "url" },
      { key: "current", header: beforeAfter.current, width: 46, type: "text" },
      { key: "recommended", header: beforeAfter.recommended, width: 46, type: "text" },
      { key: "status", header: "SEO Status", width: 22, type: "status" },
      { key: "notes", header: "Reviewer Notes", width: 38, type: "notes" },
    ];
  }
  return [
    { key: "url", header: "Page URL", width: 54, type: "url" },
    { key: "target", header: "Target / Related URL", width: 48, type: "url" },
    { key: "value", header: "Detected Value", width: 40, type: "text" },
    { key: "code", header: "HTTP Code", width: 13, type: "code" },
    { key: "recommendation", header: "Recommendations", width: 62, type: "text" },
    { key: "status", header: "SEO Status", width: 22, type: "status" },
    { key: "notes", header: "Reviewer Notes", width: 38, type: "notes" },
  ];
}

function cellValueFor(key, finding) {
  switch (key) {
    case "url":
      return finding.url;
    case "target":
      return finding.targetUrl || finding.detail || null;
    case "value":
      return valueOrNull(finding.detectedValue);
    case "code":
      return valueOrNull(finding.statusCode) || null;
    case "recommendation":
      return finding.recommendation;
    case "current":
      return valueOrNull(finding.detectedValue) || "(none)";
    case "recommended":
      return valueOrNull(finding.recommendedValue);
    case "status":
      return finding.reviewStatus || "Needs review";
    case "notes":
      return finding.reviewerNotes || null;
    default:
      return null;
  }
}

function addDetailSheet(workbook, definition, findings, sheetName) {
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { tabColor: { argb: (PRIORITY_COLORS[definition.priority] || DEFAULT_PRIORITY_COLOR).band } },
  });
  const columns = detailColumns(definition.id);
  const columnCount = columns.length;
  const lastColumn = excelColumnLetter(columnCount);
  const statusColumnIndex = columns.findIndex((column) => column.type === "status") + 1;
  const statusColumnLetter = excelColumnLetter(statusColumnIndex);

  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));

  const titleLastColumn = excelColumnLetter(Math.max(1, columnCount - 1));
  sheet.mergeCells(`A1:${titleLastColumn}1`);
  sheet.getCell("A1").value = definition.title;
  sheet.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: COLORS.navy },
  };
  sheet.getCell("A1").font = {
    name: "Poppins",
    size: 13,
    bold: true,
    color: { argb: COLORS.white },
  };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(1).height = 25;
  const backLinkCell = sheet.getCell(`${lastColumn}1`);
  backLinkCell.value = { text: "Go Back to Summary", hyperlink: "#'SUMMARY'!A1" };
  backLinkCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2CC" } };
  backLinkCell.font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.link } };
  backLinkCell.alignment = { horizontal: "center", vertical: "middle" };

  const narrative = [
    [2, "Observation", true],
    [
      3,
      `It is observed that ${findings.length.toLocaleString()} occurrence(s) of “${definition.title}” were identified.`,
      false,
    ],
    [4, "Impact", true],
    [5, definition.description, false],
    [6, "Recommendations", true],
    [7, definition.recommendation, false],
  ];
  for (const [rowNumber, value, heading] of narrative) {
    sheet.mergeCells(`A${rowNumber}:${lastColumn}${rowNumber}`);
    const cell = sheet.getCell(`A${rowNumber}`);
    cell.value = value;
    cell.font = {
      name: "Poppins",
      size: heading ? 11 : 10,
      bold: heading,
      color: { argb: COLORS.black },
    };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: heading ? 0 : 1 };
    sheet.getRow(rowNumber).height = heading
      ? 21
      : rowHeightFromLines(estimateWrappedLines(value, columnCount * 12), { lineHeight: 14 });
  }

  const tableHeaderRow = 9;
  sheet.getRow(tableHeaderRow).values = columns.map((column) => column.header);
  sheet.getRow(tableHeaderRow).height = 26;
  sheet.getRow(tableHeaderRow).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lightBlue } };
    cell.font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.black } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyGridBorder(cell);
  });

  findings.forEach((finding, index) => {
    const rowValues = columns.map((column) => {
      const raw = cellValueFor(column.key, finding);
      if (column.type === "url" && raw) {
        const hyperlink = column.key === "url" ? finding.url : finding.targetUrl;
        if (hyperlink) return { text: raw, hyperlink };
      }
      return raw;
    });
    const row = sheet.addRow(rowValues);
    const isZebra = index % 2 === 1;
    let maxLines = 1;
    row.eachCell((cell, columnNumber) => {
      const column = columns[columnNumber - 1];
      const isLink = Boolean(cell.value && typeof cell.value === "object" && cell.value.hyperlink);
      cell.font = {
        name: "Poppins",
        size: 9,
        color: { argb: isLink ? COLORS.link : COLORS.black },
        underline: isLink,
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: column.type === "code" ? "center" : "left",
        wrapText: true,
      };
      if (isZebra) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.zebra } };
      }
      applyGridBorder(cell);
      const text = isLink ? cell.value.text : cell.value;
      maxLines = Math.max(maxLines, estimateWrappedLines(text, column.width));
    });
    row.height = rowHeightFromLines(maxLines);
    const statusCell = row.getCell(statusColumnIndex);
    statusCell.dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: [`"${REVIEW_STATUSES.join(",")}"`],
      showErrorMessage: true,
      errorTitle: "Choose a review status",
      error: "Select a value from the list.",
    };
  });

  const lastDataRow = Math.max(tableHeaderRow + 1, sheet.lastRow.number);
  const statusRange = `${statusColumnLetter}${tableHeaderRow + 1}:${statusColumnLetter}${lastDataRow}`;
  sheet.addConditionalFormatting({
    ref: statusRange,
    rules: [
      {
        type: "containsText",
        operator: "containsText",
        text: "Confirmed issue",
        priority: 1,
        style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.error } } },
      },
      {
        type: "containsText",
        operator: "containsText",
        text: "False positive",
        priority: 2,
        style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.notice } } },
      },
      {
        type: "containsText",
        operator: "containsText",
        text: "Resolved",
        priority: 3,
        style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } } },
      },
      {
        type: "containsText",
        operator: "containsText",
        text: "Needs review",
        priority: 4,
        style: {
          fill: { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.warning } },
        },
      },
    ],
  });

  // Slow pages carry a real numeric severity (response time) instead of an
  // enum, so a duration-formatted color scale communicates severity at a
  // glance the way the status colors do for every other rule.
  if (definition.id === "slow-page") {
    const valueColumnIndex = columns.findIndex((column) => column.key === "value") + 1;
    const valueColumnLetter = excelColumnLetter(valueColumnIndex);
    for (let rowNumber = tableHeaderRow + 1; rowNumber <= lastDataRow; rowNumber += 1) {
      sheet.getCell(`${valueColumnLetter}${rowNumber}`).numFmt = '0.00"s"';
    }
    sheet.addConditionalFormatting({
      ref: `${valueColumnLetter}${tableHeaderRow + 1}:${valueColumnLetter}${lastDataRow}`,
      rules: [
        {
          type: "colorScale",
          cfvo: [
            { type: "num", value: 1 },
            { type: "num", value: 8 },
          ],
          color: [{ argb: COLORS.warning }, { argb: "FFC0392B" }],
        },
      ],
    });
  }

  styleDetailSheet(sheet, lastColumn, tableHeaderRow, lastDataRow);
  return { sheet, statusRange };
}

async function buildAuditWorkbook({
  findings = [],
  catalog = [],
  siteUrl = "",
  crawlDate = new Date().toISOString(),
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CrawlScope";
  workbook.lastModifiedBy = "CrawlScope";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.subject = `Technical SEO audit for ${siteUrl}`;
  workbook.title = "CrawlScope Technical SEO Audit";
  workbook.description =
    "Editable technical SEO findings generated locally by CrawlScope.";

  const summary = workbook.addWorksheet("SUMMARY", {
    properties: { tabColor: { argb: COLORS.navy } },
  });
  summary.addRow([
    "#",
    "Issue",
    "New No of Errors",
    "Status",
    "Previously Implemented",
    "Actions to be taken",
  ]);
  styleSummarySheet(summary);

  const definitions = new Map(catalog.map((item) => [item.id, item]));
  const grouped = new Map();
  for (const finding of findings) {
    const group = grouped.get(finding.ruleId) || [];
    group.push(finding);
    grouped.set(finding.ruleId, group);
  }
  const usedNames = new Set(["summary"]);
  const detailSheets = new Map();

  for (const [ruleId, group] of grouped) {
    const definition = definitions.get(ruleId) || group[0];
    const sheetName = safeSheetName(definition.title, usedNames);
    detailSheets.set(ruleId, {
      ...addDetailSheet(workbook, definition, group, sheetName),
      sheetName,
    });
  }

  const priorities = ["High Priority", "Medium Priority", "Good to have"];
  let sequence = 1;
  const countRows = [];
  for (const priority of priorities) {
    const palette = PRIORITY_COLORS[priority] || DEFAULT_PRIORITY_COLOR;
    // Rank by actual affected-page count first, not alphabetically — a "Start
    // Here" list should surface the issue hitting 500 pages before one hitting
    // 2, even within the same priority tier. Category/title break ties so the
    // order stays deterministic when counts match.
    const rules = [...grouped.keys()]
      .map((ruleId) => definitions.get(ruleId) || grouped.get(ruleId)[0])
      .filter((definition) => definition.priority === priority)
      .map((definition) => ({
        definition,
        activeCount: grouped
          .get(definition.id)
          .filter((finding) =>
            ["Needs review", "Confirmed issue"].includes(finding.reviewStatus),
          ).length,
      }))
      .sort(
        (a, b) =>
          b.activeCount - a.activeCount ||
          a.definition.category.localeCompare(b.definition.category) ||
          a.definition.title.localeCompare(b.definition.title),
      )
      .map(({ definition }) => definition);
    if (!rules.length) continue;
    addPriorityBand(summary, priority);
    rules.forEach((definition, indexInTier) => {
      const group = grouped.get(definition.id);
      const detail = detailSheets.get(definition.id);
      const activeCount = group.filter((finding) =>
        ["Needs review", "Confirmed issue"].includes(finding.reviewStatus),
      ).length;
      const resolvedCount = group.filter(
        (finding) => finding.reviewStatus === "Resolved",
      ).length;
      const needsReviewCount = group.filter(
        (finding) => finding.reviewStatus === "Needs review",
      ).length;
      const quoted = quoteSheet(detail.sheetName);
      const row = summary.addRow([
        sequence,
        {
          text: definition.title,
          hyperlink: `#${quoted}!A1`,
        },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Needs review")+COUNTIF(${quoted}!${detail.statusRange},"Confirmed issue")`,
          result: activeCount,
        },
        {
          formula: `IF(COUNTIF(${quoted}!${detail.statusRange},"Needs review")>0,"Review in progress","Reviewed")`,
          result: needsReviewCount ? "Review in progress" : "Reviewed",
        },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Resolved")`,
          result: resolvedCount,
        },
        definition.recommendation,
      ]);
      countRows.push(row.number);
      sequence += 1;
      const isZebra = indexInTier % 2 === 1;
      row.height = rowHeightFromLines(estimateWrappedLines(definition.recommendation, 72), {
        lineHeight: 14,
        minHeight: 28,
      });
      row.eachCell((cell, columnNumber) => {
        cell.font = {
          name: "Poppins",
          size: 10,
          bold: columnNumber === 2,
          color: {
            argb: columnNumber === 3 ? COLORS.link : COLORS.black,
          },
        };
        cell.alignment = {
          vertical: "middle",
          horizontal: [1, 3, 5].includes(columnNumber) ? "center" : "left",
          wrapText: true,
        };
        if (columnNumber === 1) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.tint } };
          cell.font = { ...cell.font, bold: true };
        } else if (isZebra) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.zebra } };
        }
        applyGridBorder(cell);
      });
      row.getCell(2).font = {
        name: "Poppins",
        size: 10,
        bold: true,
        color: { argb: COLORS.link },
        underline: true,
      };
    });
  }

  const total = findings.filter((finding) =>
    ["Needs review", "Confirmed issue"].includes(finding.reviewStatus),
  ).length;
  const totalRow = summary.addRow([
    null,
    "TOTAL",
    {
      formula: `SUM(${countRows.map((row) => `C${row}`).join(",")})`,
      result: total,
    },
    null,
    null,
    null,
  ]);
  totalRow.height = 25;
  totalRow.eachCell((cell, columnNumber) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerGray } };
    cell.font = {
      name: "Poppins",
      size: 11,
      bold: true,
      color: { argb: columnNumber === 3 ? COLORS.link : COLORS.black },
    };
    cell.alignment = { vertical: "middle", horizontal: columnNumber === 3 ? "center" : "left" };
    applyGridBorder(cell);
  });

  summary.getCell("H1").value = "Audit details";
  summary.getCell("H1").font = { name: "Poppins", size: 11, bold: true };
  summary.getCell("H2").value = "Website";
  summary.getCell("I2").value = siteUrl || null;
  summary.getCell("H3").value = "Crawl date";
  summary.getCell("I3").value = new Date(crawlDate);
  summary.getCell("I3").numFmt = "yyyy-mm-dd hh:mm";
  summary.getCell("H4").value = "Generated by";
  summary.getCell("I4").value = "CrawlScope";
  summary.getColumn("H").width = 16;
  summary.getColumn("I").width = 38;
  summary.getCell("I2").font = { color: { argb: COLORS.link }, underline: true };
  if (siteUrl) summary.getCell("I2").value = { text: siteUrl, hyperlink: siteUrl };

  const catalogSheet = workbook.addWorksheet("Issue Catalog");
  catalogSheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  catalogSheet.columns = [
    { width: 34 },
    { width: 22 },
    { width: 18 },
    { width: 22 },
    { width: 68 },
    { width: 74 },
  ];
  catalogSheet.addRow([
    "Issue",
    "Category",
    "Priority",
    "Detection",
    "Brief Description",
    "Recommended Fix",
  ]);
  catalogSheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyGridBorder(cell);
  });
  catalogSheet.getRow(1).height = 30;
  catalog.forEach((definition, index) => {
    const palette = PRIORITY_COLORS[definition.priority] || DEFAULT_PRIORITY_COLOR;
    const row = catalogSheet.addRow([
      definition.title,
      definition.category,
      definition.priority,
      definition.detection,
      definition.description,
      definition.recommendation,
    ]);
    const isZebra = index % 2 === 1;
    row.height = rowHeightFromLines(
      Math.max(
        estimateWrappedLines(definition.description, 68),
        estimateWrappedLines(definition.recommendation, 74),
      ),
      { lineHeight: 13, minHeight: 32 },
    );
    row.eachCell((cell, columnNumber) => {
      cell.font = { name: "Poppins", size: 9, color: { argb: COLORS.black } };
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
      if (columnNumber === 3) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.tint } };
        cell.font = { ...cell.font, bold: true };
        cell.alignment = { ...cell.alignment, horizontal: "center" };
      } else if (isZebra) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.zebra } };
      }
      applyGridBorder(cell);
    });
  });
  catalogSheet.autoFilter = `A1:F${catalogSheet.lastRow.number}`;

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildAuditWorkbook, REVIEW_STATUSES };
