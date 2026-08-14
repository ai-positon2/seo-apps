// Styled .xlsx export for QC results and generated content, ported from the
// standalone gbp-qc-agent tool's openpyxl-based exporter. Uses exceljs (this
// codebase's existing convention — see server/modules/hubSpoke/exporter.js)
// in place of openpyxl.
const ExcelJS = require('exceljs');

const BG_TITLE = 'FF1F3864';
const BG_SECTION = 'FF2E75B6';
const BG_META_LABEL = 'FFD6DCE4';
const BG_PASS = 'FFE2EFDA';
const BG_MINOR = 'FFFFF2CC';
const BG_MAJOR = 'FFFFE0E0';
const BG_ALT = 'FFF5F5F5';
const BG_TBL_HDR = 'FFBDD7EE';
const BG_WHITE = 'FFFFFFFF';

const FG_WHITE = 'FFFFFFFF';
const FG_PASS = 'FF375623';
const FG_MINOR = 'FF7F6000';
const FG_MAJOR = 'FF8B0000';
const FG_DARK = 'FF1A1A1A';

const BORDER_COLOR = 'FFBFBFBF';
const LAST_COL = 'E';

const STATUS_STYLE = {
  Pass: [BG_PASS, FG_PASS],
  'Needs Minor Edits': [BG_MINOR, FG_MINOR],
  'Needs Major Edits': [BG_MAJOR, FG_MAJOR],
  Error: [BG_MAJOR, FG_MAJOR],
};
const SEVERITY_STYLE = { major: [BG_MAJOR, FG_MAJOR], minor: [BG_MINOR, FG_MINOR] };

function fill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}
function font({ bold = false, color = FG_DARK, size = 11, italic = false } = {}) {
  return { name: 'Calibri', bold, color: { argb: color }, size, italic };
}
function align({ wrap = false, h = 'left', v = 'middle' } = {}) {
  return { wrapText: wrap, horizontal: h, vertical: v };
}
function thinBorder() {
  const side = { style: 'thin', color: { argb: BORDER_COLOR } };
  return { top: side, bottom: side, left: side, right: side };
}

function setWidths(ws, widths) {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function titleRow(ws, r, text) {
  ws.mergeCells(`A${r}:${LAST_COL}${r}`);
  const c = ws.getCell(`A${r}`);
  c.value = text;
  c.font = font({ bold: true, color: FG_WHITE, size: 16 });
  c.fill = fill(BG_TITLE);
  c.alignment = align({ h: 'center' });
  ws.getRow(r).height = 34;
  return r + 1;
}

function sectionHeader(ws, r, title) {
  ws.mergeCells(`A${r}:${LAST_COL}${r}`);
  const c = ws.getCell(`A${r}`);
  c.value = title;
  c.font = font({ bold: true, color: FG_WHITE, size: 12 });
  c.fill = fill(BG_SECTION);
  c.alignment = align({ h: 'left' });
  ws.getRow(r).height = 22;
  return r + 1;
}

function metaRow(ws, r, label1, val1, label2, val2) {
  const cells = [
    ['A', label1, true, BG_META_LABEL],
    ['B', val1, false, BG_WHITE],
    ['C', label2, true, BG_META_LABEL],
    ['D', val2, true, BG_WHITE],
  ];
  for (const [col, text, bold, bg] of cells) {
    const c = ws.getCell(`${col}${r}`);
    c.value = text;
    c.font = font({ bold });
    c.fill = fill(bg);
    c.alignment = align();
  }
  ws.getRow(r).height = 18;
  return r + 1;
}

function colHeader(ws, r, labels, { spanTo = null, colBSpan = false } = {}) {
  const cols = ['A', 'B', 'C', 'D', 'E'];
  labels.forEach((label, i) => {
    const col = cols[i];
    if (colBSpan && col === 'B') ws.mergeCells(`B${r}:${LAST_COL}${r}`);
    const c = ws.getCell(`${col}${r}`);
    c.value = label;
    c.font = font({ bold: true });
    c.fill = fill(BG_TBL_HDR);
    c.border = thinBorder();
    c.alignment = align({ h: 'center' });
  });
  if (spanTo && labels.length === 1) ws.mergeCells(`A${r}:${spanTo}${r}`);
  ws.getRow(r).height = 18;
  return r + 1;
}

function emptyRow(ws, r, text, green = false) {
  ws.mergeCells(`A${r}:${LAST_COL}${r}`);
  const c = ws.getCell(`A${r}`);
  c.value = text;
  c.font = font({ italic: true, color: green ? FG_PASS : FG_DARK });
  c.fill = fill(green ? BG_PASS : BG_ALT);
  c.alignment = align();
  return r + 1;
}

function spacer(ws, r) {
  ws.getRow(r).height = 10;
  return r + 1;
}

async function toQcExcel(result, clientId, stage, clientName = '') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('QC Report');
  setWidths(ws, [22, 14, 30, 52, 40]);

  let r = 1;
  const now = new Date();
  const tsDisplay = now.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  r = titleRow(ws, r, 'GBP Quality Check Report');

  const stageLabel = stage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const score = result.qc_score || 0;
  const status = result.overall_status || '';
  const [statusBg, statusFg] = STATUS_STYLE[status] || [BG_WHITE, FG_DARK];

  r = metaRow(ws, r, 'Client', clientName || clientId, 'Stage', stageLabel);
  r = metaRow(ws, r, 'Date', tsDisplay, 'QC Score', `${score} / 100`);

  {
    const a = ws.getCell(`A${r}`);
    a.value = 'Status';
    a.font = font({ bold: true });
    a.fill = fill(BG_META_LABEL);
    a.alignment = align();
    ws.mergeCells(`B${r}:${LAST_COL}${r}`);
    const b = ws.getCell(`B${r}`);
    b.value = status;
    b.font = font({ bold: true, color: statusFg, size: 13 });
    b.fill = fill(statusBg);
    b.alignment = align({ h: 'center' });
    ws.getRow(r).height = 24;
    r += 1;
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'PASSED CHECKS');
  const passed = result.passed_checks || [];
  if (passed.length) {
    r = colHeader(ws, r, ['Check'], { spanTo: LAST_COL });
    passed.forEach((check, i) => {
      const bg = i % 2 === 0 ? BG_WHITE : BG_ALT;
      ws.mergeCells(`A${r}:${LAST_COL}${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = `OK   ${check}`;
      c.font = font({ color: FG_PASS });
      c.fill = fill(bg);
      c.border = thinBorder();
      c.alignment = align();
      r += 1;
    });
  } else {
    r = emptyRow(ws, r, 'No checks passed.');
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'ISSUES FOUND');
  const issues = result.issues_found || [];
  if (issues.length) {
    r = colHeader(ws, r, ['Severity', 'Check', 'Description', 'Guideline / Rule Violated']);
    for (const issue of issues) {
      const sev = issue.severity || 'minor';
      const [ib, ifg] = SEVERITY_STYLE[sev] || [BG_WHITE, FG_DARK];
      const icell = (col, val, { bold = false, wrap = false, center = false } = {}) => {
        const c = ws.getCell(`${col}${r}`);
        c.value = val;
        c.font = font({ bold, color: ifg, italic: !bold });
        c.fill = fill(ib);
        c.border = thinBorder();
        c.alignment = align({ wrap, h: center ? 'center' : 'left' });
      };
      icell('A', sev.toUpperCase(), { bold: true, center: true });
      icell('B', issue.check || '', { bold: true });
      icell('C', issue.issue || '', { wrap: true });
      icell('D', issue.reason || '', { wrap: true });
      ws.getRow(r).height = 48;
      r += 1;
    }
  } else {
    r = emptyRow(ws, r, 'No issues found.', true);
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'RECOMMENDED FIXES');
  const fixes = result.recommended_fixes || [];
  if (fixes.length) {
    r = colHeader(ws, r, ['#', 'Fix'], { colBSpan: true });
    fixes.forEach((fix, i) => {
      const a = ws.getCell(`A${r}`);
      a.value = String(i + 1);
      a.font = font({ bold: true });
      a.fill = fill(BG_META_LABEL);
      a.border = thinBorder();
      a.alignment = align({ h: 'center' });
      ws.mergeCells(`B${r}:${LAST_COL}${r}`);
      const b = ws.getCell(`B${r}`);
      b.value = fix;
      b.font = font();
      b.border = thinBorder();
      b.alignment = align({ wrap: true });
      ws.getRow(r).height = 36;
      r += 1;
    });
  } else {
    r = emptyRow(ws, r, 'No fixes required.', true);
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'RECOMMENDED CONTENT — Suggested Edited Version');
  const edited = (result.suggested_edited_version || '').trim();
  if (edited) {
    const charCount = edited.length;
    ws.mergeCells(`A${r}:${LAST_COL}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = edited;
    c.font = font({ size: 11 });
    c.border = thinBorder();
    c.alignment = align({ wrap: true, v: 'top' });
    ws.getRow(r).height = Math.max(80, Math.min(Math.floor(charCount / 5), 400));
    r += 1;
    ws.mergeCells(`A${r}:${LAST_COL}${r}`);
    const c2 = ws.getCell(`A${r}`);
    c2.value = `${charCount} characters`;
    c2.font = font({ italic: true, color: 'FF888888' });
    c2.fill = fill(BG_ALT);
    c2.alignment = align({ h: 'right' });
    r += 1;
  } else {
    r = emptyRow(ws, r, 'No edits required — original content approved.', true);
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'FINAL APPROVAL RECOMMENDATION');
  const rec = (result.final_approval_recommendation || '').trim();
  if (rec) {
    ws.mergeCells(`A${r}:${LAST_COL}${r}`);
    const [bg2, fg2] = STATUS_STYLE[status] || [BG_WHITE, FG_DARK];
    const c = ws.getCell(`A${r}`);
    c.value = rec;
    c.font = font({ color: fg2 });
    c.fill = fill(bg2);
    c.border = thinBorder();
    c.alignment = align({ wrap: true, v: 'top' });
    ws.getRow(r).height = 60;
  }

  return wb.xlsx.writeBuffer();
}

async function toGeneratedExcel(result, clientId, location, clientName = '') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Generated Content');
  setWidths(ws, [22, 14, 30, 52, 40]);

  let r = 1;
  const now = new Date();
  const tsDisplay = now.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  r = titleRow(ws, r, 'GBP Location Content — Generated Post');

  const charCount = result.character_count || 0;
  const within = result.within_limit != null ? result.within_limit : charCount <= 1500;
  r = metaRow(ws, r, 'Client', clientName || clientId, 'Location', location);
  r = metaRow(ws, r, 'Date', tsDisplay, 'Characters', `${charCount} / 1500`);

  {
    const slBg = within ? BG_PASS : BG_MAJOR;
    const slFg = within ? FG_PASS : FG_MAJOR;
    const a = ws.getCell(`A${r}`);
    a.value = 'Status';
    a.font = font({ bold: true });
    a.fill = fill(BG_META_LABEL);
    a.alignment = align();
    ws.mergeCells(`B${r}:${LAST_COL}${r}`);
    const b = ws.getCell(`B${r}`);
    b.value = within ? 'Within character limit' : 'OVER CHARACTER LIMIT — must be trimmed';
    b.font = font({ bold: true, color: slFg, size: 12 });
    b.fill = fill(slBg);
    b.alignment = align({ h: 'center' });
    ws.getRow(r).height = 24;
    r += 1;
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'SECTIONS INCLUDED');
  const sections = result.sections_included || [];
  ws.mergeCells(`A${r}:${LAST_COL}${r}`);
  {
    const c = ws.getCell(`A${r}`);
    c.value = sections.length ? sections.join('  |  ') : 'Not specified';
    c.font = font({ color: FG_PASS });
    c.fill = fill(BG_PASS);
    c.alignment = align({ h: 'center' });
    r += 1;
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'GENERATED POST — Ready to Copy and Use');
  const fullPost = (result.full_post || '').trim();
  if (fullPost) {
    ws.mergeCells(`A${r}:${LAST_COL}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = fullPost;
    c.font = font({ size: 11 });
    c.border = thinBorder();
    c.alignment = align({ wrap: true, v: 'top' });
    ws.getRow(r).height = Math.max(120, Math.min(Math.floor(charCount / 4), 500));
    r += 1;
    ws.mergeCells(`A${r}:${LAST_COL}${r}`);
    const c2 = ws.getCell(`A${r}`);
    c2.value = `${charCount} characters`;
    c2.font = font({ italic: true, color: 'FF888888' });
    c2.fill = fill(BG_ALT);
    c2.alignment = align({ h: 'right' });
    r += 1;
  }

  r = spacer(ws, r);

  r = sectionHeader(ws, r, 'CUSTOMIZATION NOTES');
  const notes = result.customization_notes || [];
  if (notes.length) {
    notes.forEach((note, i) => {
      const bg = i % 2 === 0 ? BG_WHITE : BG_ALT;
      ws.mergeCells(`A${r}:${LAST_COL}${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = note;
      c.font = font();
      c.fill = fill(bg);
      c.border = thinBorder();
      c.alignment = align({ wrap: true });
      r += 1;
    });
  } else {
    r = emptyRow(ws, r, 'No notes provided.');
  }

  return wb.xlsx.writeBuffer();
}

async function toAllLocationsExcel(results, clientId, postType, clientName = '') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('All Locations');
  ws.getColumn(1).width = 32;
  ws.getColumn(2).width = 100;

  const locations = Object.keys(results);
  const total = locations.length;
  let r = 1;
  const now = new Date();
  const tsDisplay = now.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  ws.mergeCells(`A${r}:B${r}`);
  {
    const c = ws.getCell(`A${r}`);
    c.value = 'GBP Location Content — All Locations';
    c.font = font({ bold: true, color: FG_WHITE, size: 16 });
    c.fill = fill(BG_TITLE);
    c.alignment = align({ h: 'center' });
    ws.getRow(r).height = 34;
    r += 1;
  }

  for (const [label, val] of [
    ['Client', clientName || clientId],
    ['Post Type', postType],
    ['Date', tsDisplay],
    ['Total Locations', String(total)],
  ]) {
    const a = ws.getCell(`A${r}`);
    a.value = label;
    a.font = font({ bold: true });
    a.fill = fill(BG_META_LABEL);
    a.alignment = align();
    const b = ws.getCell(`B${r}`);
    b.value = val;
    b.font = font();
    b.alignment = align();
    ws.getRow(r).height = 18;
    r += 1;
  }

  r += 1; // spacer

  for (const [col, hdr] of [['A', 'Location'], ['B', 'Generated Post']]) {
    const c = ws.getCell(`${col}${r}`);
    c.value = hdr;
    c.font = font({ bold: true });
    c.fill = fill(BG_TBL_HDR);
    c.border = thinBorder();
    c.alignment = align({ h: 'center' });
  }
  ws.getRow(r).height = 22;
  r += 1;

  locations.forEach((loc, i) => {
    const res = results[loc];
    const chars = res.character_count || 0;
    const within = res.within_limit != null ? res.within_limit : chars <= 1500;
    const fullPost = (res.full_post || '').trim();

    const rowBg = i % 2 === 0 ? BG_WHITE : 'FFEEF4FB';
    const slFg = within ? FG_PASS : FG_MAJOR;
    const status = `${chars} chars  |  ${within ? 'OK' : 'OVER LIMIT'}`;

    const a = ws.getCell(`A${r}`);
    a.value = `${loc}\n${status}`;
    a.font = font({ bold: true, color: slFg });
    a.fill = fill(within ? BG_PASS : BG_MAJOR);
    a.border = thinBorder();
    a.alignment = align({ wrap: true, v: 'top' });

    const b = ws.getCell(`B${r}`);
    b.value = fullPost;
    b.font = font({ size: 11 });
    b.fill = fill(rowBg);
    b.border = thinBorder();
    b.alignment = align({ wrap: true, v: 'top' });

    ws.getRow(r).height = Math.max(150, Math.min(Math.floor(chars / 3), 400));
    r += 1;
  });

  return wb.xlsx.writeBuffer();
}

module.exports = { toQcExcel, toGeneratedExcel, toAllLocationsExcel };
