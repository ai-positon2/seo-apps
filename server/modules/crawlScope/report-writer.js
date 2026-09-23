const ExcelJS = require("exceljs");
const { buildRootCauseGroups } = require("./analyzer");

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
  "Low Priority": { band: "1E8449", tint: "D5F5E3", text: COLORS.white },
};
const DEFAULT_PRIORITY_COLOR = { band: COLORS.navy, tint: COLORS.zebra, text: COLORS.white };

const REVIEW_STATUSES = [
  "Needs review",
  "Confirmed issue",
  "False positive",
  "Resolved",
];

// Mirrors DISMISSED in client/src/components/crawlScope/crawlHelpers.js — a
// finding marked either of these is not an outstanding, live issue any more.
const DISMISSED_STATUSES = new Set(["False positive", "Resolved"]);

// Detail sheets for these rules show a Current/Recommended pair instead of
// the generic Target/Detected Value/Recommendations columns — a concrete
// before-and-after is far more actionable than a length or a generic tip
// repeated on every row of the sheet.
const BEFORE_AFTER_LABELS = {
  "title-missing": { current: "Current Title", recommended: "Recommended Title" },
  "title-long": { current: "Current Title", recommended: "Recommended Title" },
  "meta-long": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "meta-short": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "meta-missing": { current: "Current Meta Description", recommended: "Recommended Meta Description" },
  "h1-missing": { current: "Current H1", recommended: "Recommended H1" },
};

// "Recommended Length" is a target range to write to, not a character count of
// whatever string happens to sit in recommendedValue — that value is
// sometimes a real rewrite and sometimes an honest "needs a manual rewrite —
// current title is N characters..." sentence (analyzer.js's suggestTitle/
// suggestMetaDescription), and measuring the SENTENCE's length produced
// nonsense like "134" on every row of a Titles tab. h1-missing has no
// universal SEO length target, so it's an honest null rather than a
// fabricated range.
const TARGET_LENGTH_RANGES = {
  "title-missing": "50–60",
  "title-long": "50–60",
  "meta-missing": "150–160",
  "meta-long": "150–160",
  "meta-short": "150–160",
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

function styleSummarySheet(sheet, headerRowNumber) {
  sheet.views = [{ state: "frozen", ySplit: headerRowNumber, showGridLines: false }];
  sheet.columns = [
    { key: "priority", width: 8 },
    { key: "issue", width: 34 },
    { key: "errors", width: 17 },
    { key: "status", width: 24 },
    { key: "implemented", width: 22 },
    { key: "action", width: 72 },
    { key: "tier", width: 16 },
  ];
  const header = sheet.getRow(headerRowNumber);
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
  sheet.mergeCells(row.number, 1, row.number, 7);
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

// Appended to every detail sheet, generic layout or before/after. Fix Type
// and its root-cause line are computed from the findings themselves (see
// assessFixType); Owner and Target Date are deliberately left blank — a real
// name and a real date are the client team's to supply, not something a
// crawl can infer.
const ACTIONABILITY_COLUMNS = [
  { key: "fixType", header: "Fix Type", width: 12, type: "code" },
  { key: "effort", header: "Effort", width: 12, type: "code" },
  { key: "owner", header: "Owner", width: 18, type: "text" },
  { key: "targetDate", header: "Target Date", width: 14, type: "text" },
  { key: "impact", header: "Estimated Impact", width: 16, type: "code" },
];
const OWNER_OPTIONS = ["Unassigned", "SEO Team", "Dev Team", "Content Team", "Legal/Regulatory"];

// A rule that fires on many rows sharing the same detected value is a strong,
// generic signal that one shared cause (a theme, a plugin, a template
// component) produced all of them — fixing it once fixes every row. A rule
// where each row's detected value differs has no such shared cause visible in
// the data, so it's treated as needing page-by-page attention. This is a
// heuristic computed from the actual findings, not a per-site judgment call.
function assessFixType(findings, definition) {
  // scope/ruleId override the shared-value heuristic below entirely for the
  // cases where we already know the real fix shape from the catalog, rather
  // than inferring it from how many rows share a detected value:
  //   - scope='template' (set by collapseTemplateFindings in analyzer.js) is
  //     a PROVEN shared cause — identical evidence matched across most of
  //     the crawl — not the shareRatio heuristic's guess below. Checked
  //     first because it's the strongest signal available.
  //   - a site-scoped check (sitemap/robots config, llms.txt, HSTS, ...) is
  //     one whole-site fix regardless of how many findings it produced
  //   - slow-page is a server/hosting configuration change, not N page edits
  if (findings[0]?.scope === "template") {
    return {
      fixType: "Template",
      rootCause: `Identical evidence confirmed across all ${findings.length} rows — a shared template or component, not ${findings.length} separate problems. Fix it once.`,
    };
  }
  if (definition?.scope === "site") {
    return {
      fixType: "Site",
      rootCause: "A whole-site configuration issue (see Site-level findings), not a page-by-page problem — fix it once, not per URL.",
    };
  }
  if (definition?.id === "slow-page") {
    return {
      fixType: "Config",
      rootCause: "Server response time is a hosting/server configuration change, not something fixed one page at a time.",
    };
  }
  const total = findings.length;
  if (total < 5) {
    return { fixType: "Page", rootCause: `${total} row${total === 1 ? "" : "s"} — not enough to indicate a shared cause; review individually.` };
  }
  const values = findings
    .map((f) => (typeof f.detectedValue === "string" ? f.detectedValue : f.detectedValue != null ? String(f.detectedValue) : ""))
    .filter(Boolean);
  if (!values.length) {
    return { fixType: "Page", rootCause: `${total} rows with no comparable detected value recorded — review individually.` };
  }
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const [, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const shareRatio = topCount / total;
  if (shareRatio >= 0.6) {
    return {
      fixType: "Template",
      rootCause: `${total} rows, ${topCount} of them (${Math.round(shareRatio * 100)}%) sharing the same detected value — consistent with one shared template or component cause rather than ${total} separate problems.`,
    };
  }
  return {
    fixType: "Page",
    rootCause: `${total} rows with mostly distinct detected values — no shared cause visible in the data; likely needs page-by-page review.`,
  };
}

function assessEffort(fixType, count) {
  // One template edit, one site config change, or one server change — never
  // scales with how many rows/pages it happens to touch.
  if (fixType === "Template" || fixType === "Site" || fixType === "Config") return "Easy";
  if (count <= 5) return "Easy";
  if (count <= 15) return "Moderate";
  return "Complex";
}

function assessImpact(priority, count) {
  if (priority === "High Priority") return "High";
  if (priority === "Medium Priority") return count >= 5 ? "Medium" : "Low";
  return "Low";
}

function detailColumns(ruleId) {
  const beforeAfter = BEFORE_AFTER_LABELS[ruleId];
  if (beforeAfter) {
    return [
      { key: "url", header: "Page URL", width: 54, type: "url" },
      { key: "current", header: beforeAfter.current, width: 46, type: "text" },
      { key: "recommended", header: beforeAfter.recommended, width: 46, type: "text" },
      { key: "status", header: "SEO Status", width: 22, type: "status" },
      { key: "notes", header: "Reviewer Notes", width: 38, type: "notes" },
      // Appended, not inserted — keeps every existing column in place so a
      // cell reference into A-E still means what it always meant.
      { key: "currentLength", header: "Current Length", width: 14, type: "code" },
      { key: "recommendedLength", header: "Recommended Length", width: 18, type: "code" },
      ...ACTIONABILITY_COLUMNS,
    ];
  }
  const columns = [
    { key: "url", header: "Page URL", width: 54, type: "url" },
    { key: "target", header: "Target / Related URL", width: 48, type: "url" },
    { key: "value", header: "Detected Value", width: 40, type: "text" },
    // What was observed, in words: the redirect path, the canonical's chain,
    // the status the target answered. It used to stand in for the target URL
    // only when there was none, so a finding with both lost its proof.
    { key: "evidence", header: "Evidence", width: 56, type: "text" },
    { key: "code", header: "HTTP Code", width: 13, type: "code" },
    { key: "recommendation", header: "Recommendations", width: 62, type: "text" },
    { key: "status", header: "SEO Status", width: 22, type: "status" },
    { key: "notes", header: "Reviewer Notes", width: 38, type: "notes" },
    ...ACTIONABILITY_COLUMNS,
  ];
  // A response-time finding is about the page itself, not a second related
  // URL — that column is always empty for slow-page alone, so drop it rather
  // than ship a column that can never hold anything, on this one sheet only.
  return ruleId === "slow-page" ? columns.filter((c) => c.key !== "target") : columns;
}

const ABSENT_VALUES = new Set(["(none)", "(absent)"]);

function cellValueFor(key, finding) {
  switch (key) {
    case "url":
      return finding.url;
    case "target":
      return finding.targetUrl || null;
    case "value":
      return valueOrNull(finding.detectedValue);
    case "evidence":
      // Not repeated when it says exactly what Detected Value already does.
      return finding.detail && finding.detail !== String(finding.detectedValue ?? "")
        ? finding.detail
        : null;
    case "code":
      return valueOrNull(finding.statusCode) || null;
    case "recommendation":
      return finding.recommendation;
    case "current":
      return valueOrNull(finding.detectedValue) || "(none)";
    case "recommended":
      return valueOrNull(finding.recommendedValue);
    case "currentLength": {
      // "(absent)" and "(none)" say there is no value; their own 8 characters
      // are not a length the page has.
      const v = finding.detectedValue;
      if (typeof v !== "string") return null;
      return ABSENT_VALUES.has(v) ? 0 : v.length;
    }
    case "recommendedLength":
      return TARGET_LENGTH_RANGES[finding.ruleId] ?? null;
    case "status":
      return finding.reviewStatus || "Needs review";
    case "notes":
      return finding.reviewerNotes || null;
    case "fixType":
      return finding._fixType || null;
    case "effort":
      return finding._effort || null;
    case "impact":
      return finding._impact || null;
    case "owner":
      return "Unassigned";
    case "targetDate":
      return null;
    default:
      return null;
  }
}

function addDetailSheet(workbook, definition, findings, sheetName, displayTitle = definition.title) {
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { tabColor: { argb: (PRIORITY_COLORS[definition.priority] || DEFAULT_PRIORITY_COLOR).band } },
  });

  // Computed once per rule, then stamped onto every finding in the group —
  // cellValueFor reads a single finding at a time and has no other way to
  // see the shape of the whole group.
  const { fixType, rootCause } = assessFixType(findings, definition);
  const effort = assessEffort(fixType, findings.length);
  const impact = assessImpact(definition.priority, findings.length);
  for (const finding of findings) {
    finding._fixType = fixType;
    finding._effort = effort;
    finding._impact = impact;
  }

  const columns = detailColumns(definition.id);
  const columnCount = columns.length;
  const lastColumn = excelColumnLetter(columnCount);
  const statusColumnIndex = columns.findIndex((column) => column.type === "status") + 1;
  const statusColumnLetter = excelColumnLetter(statusColumnIndex);

  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));

  const titleLastColumn = excelColumnLetter(Math.max(1, columnCount - 1));
  sheet.mergeCells(`A1:${titleLastColumn}1`);
  sheet.getCell("A1").value = displayTitle;
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
      `${findings.length.toLocaleString()} ${findings.length === 1 ? "row flags" : "rows flag"} "${definition.title}".`,
      false,
    ],
    [4, "Impact", true],
    [5, definition.description, false],
    [6, "Recommendations", true],
    [7, `${definition.recommendation} Root cause: ${rootCause}`, false],
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
    const ownerColumnIndex = columns.findIndex((column) => column.key === "owner") + 1;
    if (ownerColumnIndex) {
      row.getCell(ownerColumnIndex).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: [`"${OWNER_OPTIONS.join(",")}"`],
        showErrorMessage: false,
      };
    }
    const targetDateColumnIndex = columns.findIndex((column) => column.key === "targetDate") + 1;
    if (targetDateColumnIndex) {
      row.getCell(targetDateColumnIndex).numFmt = "mmm d, yyyy";
    }
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
    // Milliseconds, thousands-separated — matches the crawl-time "Time"
    // column in the UI (e.g. "2,871 ms") rather than seconds rounded to 2
    // decimals, which silently dropped precision (2871ms -> "2.87s").
    for (let rowNumber = tableHeaderRow + 1; rowNumber <= lastDataRow; rowNumber += 1) {
      sheet.getCell(`${valueColumnLetter}${rowNumber}`).numFmt = '#,##0" ms"';
    }
    sheet.addConditionalFormatting({
      ref: `${valueColumnLetter}${tableHeaderRow + 1}:${valueColumnLetter}${lastDataRow}`,
      rules: [
        {
          type: "colorScale",
          cfvo: [
            { type: "num", value: 1000 },
            { type: "num", value: 8000 },
          ],
          color: [{ argb: COLORS.warning }, { argb: "FFC0392B" }],
        },
      ],
    });
  }

  styleDetailSheet(sheet, lastColumn, tableHeaderRow, lastDataRow);
  return { sheet, statusRange };
}

// One row per DISTINCT ROOT CAUSE, not per occurrence — analyzer.js's
// buildRootCauseGroups groups findings by (ruleId, evidence signature), so
// 119 rows sharing one bad href become one row here, while 44 broken
// external links to 43 different domains correctly stay 43 rows. This is
// the sheet a reviewer should start on; the per-rule detail sheets that
// follow are the occurrence-level backing data for whichever row they open.
function addConsolidatedActionsSheet(workbook, { findings, sheetPlan, findingScope }) {
  const rootCauseGroups = buildRootCauseGroups(findings);
  const findingsByGroupId = new Map();
  for (const finding of findings) {
    const list = findingsByGroupId.get(finding.rootCauseGroupId) || [];
    list.push(finding);
    findingsByGroupId.set(finding.rootCauseGroupId, list);
  }

  const priorityRank = { "High Priority": 0, "Medium Priority": 1, "Low Priority": 2 };
  const rows = [];
  for (const group of rootCauseGroups) {
    const members = findingsByGroupId.get(group.groupId) || [];
    const activeCount = members.filter((f) =>
      ["Needs review", "Confirmed issue"].includes(f.reviewStatus),
    ).length;
    if (!activeCount) continue; // every instance already dismissed — nothing outstanding
    const needsReviewCount = members.filter((f) => f.reviewStatus === "Needs review").length;
    const confirmedCount = members.filter((f) => f.reviewStatus === "Confirmed issue").length;
    const resolvedCount = members.filter((f) => f.reviewStatus === "Resolved").length;
    const statusResult = needsReviewCount
      ? "Needs review"
      : confirmedCount
        ? "Confirmed issue"
        : resolvedCount
          ? "Resolved"
          : "False positive";
    const effort = assessEffort(group.fixType, group.memberCount);
    const key = `${group.ruleId}::${group.scope}`;
    rows.push({ group, activeCount, statusResult, effort, sheetName: sheetPlan.get(key)?.sheetName });
  }
  rows.sort(
    (a, b) =>
      (priorityRank[a.group.priority] ?? 3) - (priorityRank[b.group.priority] ?? 3) ||
      b.group.memberCount - a.group.memberCount,
  );

  const sheet = workbook.addWorksheet("Consolidated Actions", {
    properties: { tabColor: { argb: COLORS.navy } },
  });
  sheet.views = [{ state: "frozen", ySplit: 3, showGridLines: false }];
  sheet.columns = [
    { key: "seq", width: 5 },
    { key: "rootCause", width: 40 },
    { key: "occurrences", width: 13 },
    { key: "pages", width: 13 },
    { key: "targets", width: 13 },
    { key: "fixType", width: 12 },
    { key: "effort", width: 12 },
    { key: "priority", width: 15 },
    { key: "status", width: 20 },
    { key: "action", width: 62 },
  ];

  const pageScopeActive = findings.filter(
    (f) => ["Needs review", "Confirmed issue"].includes(f.reviewStatus) && findingScope(f) === "page",
  ).length;
  const pageScopeActionCount = rows.filter((r) => r.group.scope === "page").length;
  const titleRow = sheet.addRow([
    rows.length
      ? `${pageScopeActionCount} action${pageScopeActionCount === 1 ? "" : "s"} across ${pageScopeActive.toLocaleString()} page-level occurrence${pageScopeActive === 1 ? "" : "s"}`
      : "No outstanding findings",
  ]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 10);
  titleRow.height = 26;
  titleRow.getCell(1).font = { name: "Poppins", size: 13, bold: true, color: { argb: COLORS.navy } };
  titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  const noteRow = sheet.addRow([
    "One row per distinct root cause (identical evidence — the same broken link, the same missing schema property, the same server) — not one row per affected page. " +
      "Site, resource & template-level actions are included below but excluded from the occurrence count above, same as SUMMARY's own TOTAL.",
  ]);
  sheet.mergeCells(noteRow.number, 1, noteRow.number, 10);
  noteRow.height = rowHeightFromLines(estimateWrappedLines(noteRow.getCell(1).value, 120), { lineHeight: 13, minHeight: 18 });
  noteRow.getCell(1).font = { name: "Poppins", size: 9, italic: true, color: { argb: COLORS.muted } };
  noteRow.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };

  const headerRowNumber = 3;
  const header = sheet.getRow(headerRowNumber);
  header.values = [
    "#", "Root Cause", "Occurrences", "Affected Pages", "Unique Targets",
    "Fix Type", "Effort", "Priority", "Status", "Recommended Action",
  ];
  header.height = 30;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerGray } };
    cell.font = { name: "Poppins", size: 10, bold: true, color: { argb: "000000" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyGridBorder(cell);
  });

  rows.forEach((row, index) => {
    const palette = PRIORITY_COLORS[row.group.priority] || DEFAULT_PRIORITY_COLOR;
    const titleCell = row.sheetName
      ? { text: row.group.title, hyperlink: `#${quoteSheet(row.sheetName)}!A1` }
      : row.group.title;
    const excelRow = sheet.addRow([
      index + 1,
      titleCell,
      row.activeCount,
      row.group.affectedPageCount,
      row.group.uniqueTargetCount,
      row.group.fixType,
      row.effort,
      row.group.priority,
      row.statusResult,
      row.group.recommendation,
    ]);
    excelRow.height = rowHeightFromLines(estimateWrappedLines(row.group.recommendation, 62), {
      lineHeight: 13,
      minHeight: 24,
    });
    const isZebra = index % 2 === 1;
    excelRow.eachCell((cell, columnNumber) => {
      cell.font = {
        name: "Poppins",
        size: 9,
        bold: columnNumber === 2,
        color: { argb: columnNumber === 2 && row.sheetName ? COLORS.link : COLORS.black },
        underline: columnNumber === 2 && Boolean(row.sheetName),
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: [1, 3, 4, 5, 6, 7].includes(columnNumber) ? "center" : "left",
        wrapText: true,
      };
      if (columnNumber === 8) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.tint } };
        cell.font = { ...cell.font, bold: true };
      } else if (isZebra) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.zebra } };
      }
      applyGridBorder(cell);
    });
  });

  sheet.autoFilter = { from: `A${headerRowNumber}`, to: `J${Math.max(headerRowNumber, sheet.lastRow.number)}` };
}

async function buildAuditWorkbook({
  findings = [],
  catalog = [],
  siteUrl = "",
  crawlDate = new Date().toISOString(),
  // analyzer.js buildFindings().coverage: checks this crawl could not run, or
  // ran on part of the site. Absent for runs analysed before it existed.
  coverage = null,
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
  const titleRow = summary.addRow([`CrawlScope Technical SEO Audit${siteUrl ? ` — ${siteUrl}` : ""}`]);
  summary.mergeCells(titleRow.number, 1, titleRow.number, 7);
  titleRow.height = 26;
  titleRow.getCell(1).font = { name: "Poppins", size: 13, bold: true, color: { argb: COLORS.navy } };
  titleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  const HEADER_ROW = 2;
  summary.addRow([
    "#",
    "Issue",
    "Open Occurrences",
    "Status",
    "Resolved Previously",
    "Actions to be taken",
    "Tier",
  ]);
  styleSummarySheet(summary, HEADER_ROW);

  const definitions = new Map(catalog.map((item) => [item.id, item]));
  // Grouped by (ruleId, scope), not ruleId alone. A rule used to carry one
  // scope for its whole run; now a rule like broken-internal-links can carry
  // BOTH — most findings still page-scoped, but a link recurring identically
  // across most of the crawl gets retagged scope='template' by
  // collapseTemplateFindings() in analyzer.js before this ever sees it.
  // Splitting the grouping key keeps every detail sheet — and the SUMIF
  // ranges the formulas below point at — scoped to rows of ONE kind, the
  // same reason a page×check matrix already can't mix a per-page count with
  // a per-host one.
  function findingScope(finding) {
    return finding.scope || definitions.get(finding.ruleId)?.scope || "page";
  }
  const grouped = new Map(); // "ruleId::scope" -> finding[]
  for (const finding of findings) {
    const key = `${finding.ruleId}::${findingScope(finding)}`;
    const group = grouped.get(key) || [];
    group.push(finding);
    grouped.set(key, group);
  }
  const usedNames = new Set(["summary"]);
  const detailSheets = new Map();

  // A rule only needs its title disambiguated with a scope suffix when it
  // actually split across more than one this run — the overwhelming common
  // case (a rule that's always been one scope) keeps its plain title, same
  // sheet name as before.
  const groupCountByRuleId = new Map();
  for (const group of grouped.values()) {
    const ruleId = group[0].ruleId;
    groupCountByRuleId.set(ruleId, (groupCountByRuleId.get(ruleId) || 0) + 1);
  }

  // Sheet names/titles are computed once, up front, and reused by both the
  // Consolidated Actions sheet (which needs to link to them before they
  // exist) and the actual addDetailSheet calls below — safeSheetName mutates
  // `usedNames` to dedupe collisions, so calling it twice for the same key
  // would hand back two DIFFERENT names ("Foo" then "Foo 2") and silently
  // break one of the two link sets.
  const sheetPlan = new Map(); // "ruleId::scope" -> { definition, scope, sheetName, sheetTitle }
  for (const [key, group] of grouped) {
    const ruleId = group[0].ruleId;
    const definition = definitions.get(ruleId) || group[0];
    const scope = findingScope(group[0]);
    const splitAcrossScopes = groupCountByRuleId.get(ruleId) > 1;
    const sheetTitle = splitAcrossScopes
      ? `${definition.title} (${scope.replace(/^./, (c) => c.toUpperCase())})`
      : definition.title;
    sheetPlan.set(key, { definition, scope, sheetName: safeSheetName(sheetTitle, usedNames), sheetTitle });
  }

  // Added here — right after SUMMARY's worksheet was created above, and
  // before any per-rule detail sheet's own addWorksheet call below — so it
  // lands as the second tab in the workbook, per the brief. Reads `findings`
  // directly rather than expecting a pre-computed rootCauseGroups input: the
  // grouping is a pure, cheap function of findings alone (see analyzer.js),
  // and recomputing it here means the Excel export can never drift from
  // whatever findings actually went into this workbook — the same class of
  // "computed it, forgot to pass it through" bug that dropped
  // summary.integrations earlier this build doesn't have anywhere to hide.
  addConsolidatedActionsSheet(workbook, { findings, sheetPlan, findingScope });

  for (const [key, group] of grouped) {
    const { definition, sheetName, sheetTitle } = sheetPlan.get(key);
    detailSheets.set(key, {
      ...addDetailSheet(workbook, definition, group, sheetName, sheetTitle),
      sheetName,
    });
  }

  const priorities = ["High Priority", "Medium Priority", "Low Priority"];
  let sequence = 1;
  const countRows = [];
  for (const priority of priorities) {
    const palette = PRIORITY_COLORS[priority] || DEFAULT_PRIORITY_COLOR;
    // Rank by actual affected-page count first, not alphabetically — a "Start
    // Here" list should surface the issue hitting 500 pages before one hitting
    // 2, even within the same priority tier. Category/title break ties so the
    // order stays deterministic when counts match.
    const rules = [...grouped.entries()]
      .filter(([, group]) => findingScope(group[0]) === "page")
      .map(([key, group]) => ({ key, definition: definitions.get(group[0].ruleId) || group[0] }))
      .filter(({ definition }) => definition.priority === priority)
      // Site/template/resource-scoped groups get their own block (and their
      // own total) below the main table — a page×check matrix can't
      // represent them without either double-counting (once per host, for
      // HSTS) or silently dropping them, so they're never mixed into this
      // per-page-issue ranking or its TOTAL.
      .map(({ key, definition }) => ({
        key,
        definition,
        activeCount: grouped
          .get(key)
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
      .map(({ key, definition }) => ({ key, definition }));
    if (!rules.length) continue;
    addPriorityBand(summary, priority);
    rules.forEach(({ key, definition }, indexInTier) => {
      const group = grouped.get(key);
      const detail = detailSheets.get(key);
      const activeCount = group.filter((finding) =>
        ["Needs review", "Confirmed issue"].includes(finding.reviewStatus),
      ).length;
      const resolvedCount = group.filter(
        (finding) => finding.reviewStatus === "Resolved",
      ).length;
      const needsReviewCount = group.filter(
        (finding) => finding.reviewStatus === "Needs review",
      ).length;
      const confirmedCount = group.filter(
        (finding) => finding.reviewStatus === "Confirmed issue",
      ).length;
      const quoted = quoteSheet(detail.sheetName);
      // Same four values every detail tab's dropdown uses (REVIEW_STATUSES),
      // not the separate "Review in progress"/"Reviewed" pair this used to
      // emit — one status vocabulary across the whole workbook. Precedence:
      // anything still needing a look outranks anything already decided.
      const statusResult = needsReviewCount
        ? "Needs review"
        : confirmedCount
          ? "Confirmed issue"
          : resolvedCount
            ? "Resolved"
            : "False positive";
      // Matches the same "(Page)"/"(Template)" suffix the detail sheet's own
      // tab and title carry when a rule split across scopes this run — a
      // reader scanning the summary sheet shouldn't have to click through to
      // discover which half of a split rule this row is.
      const rowTitle = groupCountByRuleId.get(definition.id) > 1
        ? `${definition.title} (Page)`
        : definition.title;
      const row = summary.addRow([
        sequence,
        {
          text: rowTitle,
          hyperlink: `#${quoted}!A1`,
        },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Needs review")+COUNTIF(${quoted}!${detail.statusRange},"Confirmed issue")`,
          result: activeCount,
        },
        {
          formula: `IF(COUNTIF(${quoted}!${detail.statusRange},"Needs review")>0,"Needs review",IF(COUNTIF(${quoted}!${detail.statusRange},"Confirmed issue")>0,"Confirmed issue",IF(COUNTIF(${quoted}!${detail.statusRange},"Resolved")>0,"Resolved","False positive")))`,
          result: statusResult,
        },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Resolved")`,
          result: resolvedCount,
        },
        definition.recommendation,
        priority,
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

  // Page-scoped only — matches the rows actually in this table above. A
  // site-scoped finding's count is never added in here (see its own block
  // and total below), the same rule the UI's reconciliation strip follows.
  const total = findings.filter((finding) =>
    ["Needs review", "Confirmed issue"].includes(finding.reviewStatus) &&
    findingScope(finding) === "page",
  ).length;
  // SUMIF on the Tier column (G), not a hardcoded list of row references: a
  // row inserted or deleted between the header and this total updates the
  // total automatically as long as it carries a Tier value, instead of
  // silently falling out of an explicit SUM(C3,C4,...) reference list.
  const lastPossibleDataRow = Math.max(...countRows, HEADER_ROW) + 500;
  const totalRow = summary.addRow([
    null,
    "TOTAL",
    {
      formula: `SUMIF(G${HEADER_ROW + 1}:G${lastPossibleDataRow},"<>",C${HEADER_ROW + 1}:C${lastPossibleDataRow})`,
      result: total,
    },
    null,
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

  summary.autoFilter = { from: `A${HEADER_ROW}`, to: `G${totalRow.number - 1}` };

  // Site/template/resource-scoped findings, on their own — not one more row
  // in the table above. The Tier column (G) is left blank on every row in
  // this block on purpose: TOTAL's SUMIF sums column C wherever column G is
  // non-blank, over a wide fixed row range that includes these rows too, so
  // leaving G blank here is what actually keeps them out of TOTAL, not just
  // where they're visually placed on the sheet.
  const siteScopedGroupKeys = [...grouped.keys()].filter((key) => findingScope(grouped.get(key)[0]) !== "page");
  if (siteScopedGroupKeys.length) {
    const bandRow = summary.addRow([
      "Site, resource & template-level findings — not page-scoped, and not part of TOTAL above",
    ]);
    summary.mergeCells(bandRow.number, 1, bandRow.number, 7);
    bandRow.height = 22;
    bandRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    bandRow.getCell(1).font = { name: "Poppins", size: 11, bold: true, color: { argb: COLORS.white } };
    bandRow.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };

    let siteSequence = 1;
    for (const key of siteScopedGroupKeys) {
      const group = grouped.get(key);
      const definition = definitions.get(group[0].ruleId) || group[0];
      const activeCount = group.filter((finding) =>
        ["Needs review", "Confirmed issue"].includes(finding.reviewStatus),
      ).length;
      if (!activeCount) continue; // every instance already dismissed — nothing outstanding to list
      const resolvedCount = group.filter((finding) => finding.reviewStatus === "Resolved").length;
      const needsReviewCount = group.filter((finding) => finding.reviewStatus === "Needs review").length;
      const confirmedCount = group.filter((finding) => finding.reviewStatus === "Confirmed issue").length;
      const statusResult = needsReviewCount
        ? "Needs review"
        : confirmedCount
          ? "Confirmed issue"
          : resolvedCount
            ? "Resolved"
            : "False positive";
      const scopeLabel = findingScope(group[0]).replace(/^./, (c) => c.toUpperCase());
      const detail = detailSheets.get(key);
      const quoted = quoteSheet(detail.sheetName);
      // Columns A-F match the main table exactly (sequence, title, open
      // occurrences, status, resolved count, recommendation) — only column
      // G (Tier) is omitted, which is what excludes these rows from TOTAL.
      const row = summary.addRow([
        siteSequence,
        { text: `${definition.title} (${scopeLabel})`, hyperlink: `#${quoted}!A1` },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Needs review")+COUNTIF(${quoted}!${detail.statusRange},"Confirmed issue")`,
          result: activeCount,
        },
        {
          formula: `IF(COUNTIF(${quoted}!${detail.statusRange},"Needs review")>0,"Needs review",IF(COUNTIF(${quoted}!${detail.statusRange},"Confirmed issue")>0,"Confirmed issue",IF(COUNTIF(${quoted}!${detail.statusRange},"Resolved")>0,"Resolved","False positive")))`,
          result: statusResult,
        },
        {
          formula: `COUNTIF(${quoted}!${detail.statusRange},"Resolved")`,
          result: resolvedCount,
        },
        definition.recommendation,
      ]);
      siteSequence += 1;
      row.eachCell((cell, columnNumber) => {
        cell.font = {
          name: "Poppins", size: 10, bold: columnNumber === 2,
          color: { argb: columnNumber === 3 ? COLORS.link : COLORS.black },
        };
        cell.alignment = { vertical: "middle", horizontal: [1, 3, 5].includes(columnNumber) ? "center" : "left", wrapText: true };
        applyGridBorder(cell);
      });
      row.getCell(2).font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.link }, underline: true };
    }
  }

  summary.getCell("H1").value = "Audit details";
  summary.getCell("H1").font = { name: "Poppins", size: 11, bold: true };
  summary.getCell("H2").value = "Website";
  summary.getCell("I2").value = siteUrl || null;
  summary.getCell("H3").value = "Crawl date";
  summary.getCell("I3").value = new Date(crawlDate);
  // "Sep. 1, 2026" — date only, no time-of-day.
  summary.getCell("I3").numFmt = 'mmm". "d", "yyyy';
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

  // The UI shows "N of M automatic checks clean" (buildSeoSnapshot's
  // Strengths quadrant) — this sheet is that same computation, exported. A
  // check counts as clean the same way the UI counts it: it produced no
  // ACTIVE finding this run — one dismissed as a false positive or already
  // resolved is not a live, outstanding issue, so it doesn't disqualify the
  // check. "Connected data required" checks (e.g. Search Console-backed
  // ones CrawlScope can't run alone) are excluded from both sides of the
  // ratio — they were never actually checked, clean or not.
  const cleanRuleIds = new Set(catalog.map((c) => c.id));
  for (const finding of findings) {
    if (!DISMISSED_STATUSES.has(finding.reviewStatus)) cleanRuleIds.delete(finding.ruleId);
  }
  //
  // A check this crawl could not run (coverage.notEvaluated: orphans on a
  // capped crawl, sitemap checks with sitemaps off) produced no findings for
  // want of trying, so it is on neither side of the ratio either: it is listed
  // below the clean checks with the reason.
  const notEvaluated = new Map((coverage?.notEvaluated || []).map((entry) => [entry.ruleId, entry.reason]));
  const partlyChecked = new Map((coverage?.partial || []).map((entry) => [entry.ruleId, entry.reason]));
  const automaticChecks = catalog.filter((c) => c.detection === "Automatic" && !notEvaluated.has(c.id));
  const cleanChecks = automaticChecks.filter((c) => cleanRuleIds.has(c.id));
  const notEvaluatedChecks = catalog.filter((c) => c.detection === "Automatic" && notEvaluated.has(c.id));

  const passedSheet = workbook.addWorksheet("Checks Passed");
  passedSheet.views = [{ state: "frozen", ySplit: 2, showGridLines: false }];
  passedSheet.columns = [{ width: 34 }, { width: 22 }, { width: 68 }];
  const passedTitleRow = passedSheet.addRow([
    `${cleanChecks.length} of ${automaticChecks.length} automatic checks clean` +
      (notEvaluatedChecks.length ? `; ${notEvaluatedChecks.length} not evaluated` : ""),
  ]);
  passedSheet.mergeCells(passedTitleRow.number, 1, passedTitleRow.number, 3);
  passedTitleRow.height = 24;
  passedTitleRow.getCell(1).font = { name: "Poppins", size: 12, bold: true, color: { argb: COLORS.navy } };
  passedTitleRow.getCell(1).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  passedSheet.addRow(["Issue", "Category", "Brief Description"]);
  passedSheet.getRow(2).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    applyGridBorder(cell);
  });
  passedSheet.getRow(2).height = 26;
  const addCheckRow = (definition, text, index) => {
    const row = passedSheet.addRow([definition.title, definition.category, text]);
    const isZebra = index % 2 === 1;
    row.height = rowHeightFromLines(estimateWrappedLines(text, 68), {
      lineHeight: 13,
      minHeight: 28,
    });
    row.eachCell((cell) => {
      cell.font = { name: "Poppins", size: 9, color: { argb: COLORS.black } };
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
      if (isZebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.zebra } };
      applyGridBorder(cell);
    });
  };
  cleanChecks.forEach((definition, index) => {
    // Clean as far as it went, and how far that was.
    const limit = partlyChecked.get(definition.id);
    addCheckRow(definition, limit ? `${definition.description} Partly checked: ${limit}` : definition.description, index);
  });
  if (cleanChecks.length) {
    passedSheet.autoFilter = `A2:C${passedSheet.lastRow.number}`;
  }
  if (notEvaluatedChecks.length) {
    passedSheet.addRow([]);
    const heading = passedSheet.addRow(["Not evaluated on this crawl", "Category", "Why"]);
    heading.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
      cell.font = { name: "Poppins", size: 10, bold: true, color: { argb: COLORS.white } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      applyGridBorder(cell);
    });
    heading.height = 26;
    notEvaluatedChecks.forEach((definition, index) => {
      addCheckRow(definition, notEvaluated.get(definition.id), index);
    });
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildAuditWorkbook, REVIEW_STATUSES };
