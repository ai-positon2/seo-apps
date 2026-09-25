// ── Stage 9: export ───────────────────────────────────────────────────────────
// XLSX (6 tabs) + a Markdown narrative. Split from an earlier 4-tab version
// after real user feedback: a flat "one row per page" Cluster Map didn't
// show which spokes belong to which hub, and "Gaps & Actions" mixed three
// unrelated concepts (pages that don't exist yet, pages worth improving,
// pages worth retiring) with no explanation, so nobody reading it could tell
// what it meant. Every tab now: (1) has ONE clear meaning, (2) says what
// that meaning is in a note at the top, (3) shows cluster context on every
// row rather than leaving pages to float with no explanation.
const ExcelJS = require('exceljs');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3A2E' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
const BANNER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCEEE8' } };
const HUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
const NOTE_FONT = { italic: true, size: 10, color: { argb: 'FF555555' } };

function styleHeaderRow(ws, colCount) {
  const row = ws.getRow(ws.headerRowNumber || 1);
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 22;
}

function addNote(ws, text, colCount) {
  const row = ws.addRow([text]);
  ws.mergeCells(row.number, 1, row.number, colCount);
  row.getCell(1).font = NOTE_FONT;
  row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  row.height = Math.max(18, Math.ceil(text.length / 110) * 15);
  return row;
}

function hyperlink(url) {
  return url ? { text: url, hyperlink: url } : '';
}

function fmtDate(d) {
  if (!d) return '';
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? String(d) : parsed.toISOString().slice(0, 10);
}

function fmtPct(v) {
  return `${Math.round(v * 100)}%`;
}

// A page with estimated:true was never actually crawled — on a large site
// that exceeded the crawl-sample threshold, most pages fall here, with no
// title/content of any kind, only their URL. Showing a bare "(no title)"
// reads as a bug ("why didn't you find this?"); a real user caught exactly
// that. Falling back to a readable name derived from the URL slug, plus an
// explicit "(not crawled)" marker, makes clear this is a known, structural
// limitation of sampling — not a missed extraction.
function titleFromSlug(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || url;
    return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

function displayTitle(page) {
  if (page.title) return page.title;
  return `${titleFromSlug(page.url)} (not crawled — estimated from URL only)`;
}

const FLAG_SEVERITY = { 'gap-hub': 4, 'possible-cannibalization': 3, 'thin-or-stale': 2, orphan: 2, buried: 1 };
const FLAG_LABEL = {
  'gap-hub': 'Gap hub — no existing page broad enough to serve as pillar',
  'possible-cannibalization': 'Possible cannibalization — two pages very similar in the same cluster',
  'thin-or-stale': 'Thin or stale content',
  orphan: 'Orphan page — no internal links pointing to it',
  buried: 'Buried — 4+ clicks from the homepage',
};

function buildTopFindings(analysis) {
  const findings = [];
  for (const c of analysis.clusters) {
    if (c.isGap) findings.push({ type: 'gap-hub', severity: FLAG_SEVERITY['gap-hub'], detail: `"${c.name}" cluster (${c.spokeIds.length} pages) has no natural hub` });
  }
  for (const group of analysis.cannibalization) {
    const cluster = analysis.clusters.find((c) => c.id === group.clusterId);
    for (const pair of group.pairs) {
      findings.push({ type: 'possible-cannibalization', severity: FLAG_SEVERITY['possible-cannibalization'], detail: `${pair.pageA} vs ${pair.pageB} (${Math.round(pair.similarity * 100)}% similar) in "${cluster?.name || group.clusterId}"` });
    }
  }
  for (const p of analysis.pages) {
    for (const flag of p.flags || []) {
      if (flag === 'possible-cannibalization') continue;
      findings.push({ type: flag, severity: FLAG_SEVERITY[flag] || 1, detail: p.url });
    }
  }
  return findings.sort((a, b) => b.severity - a.severity).slice(0, 10);
}

function buildNarrative(analysis, project) {
  const totalPages = analysis.pages.length;
  const clustered = analysis.clusters.reduce((s, c) => s + c.spokeIds.length + (c.hubPageId ? 1 : 0), 0);
  const gapCount = analysis.clusters.filter((c) => c.isGap).length;
  const orphanCount = analysis.pages.filter((p) => (p.flags || []).includes('orphan')).length;
  const meanHealth = analysis.clusters.length
    ? Math.round(analysis.clusters.reduce((s, c) => s + (c.health || 0), 0) / analysis.clusters.length)
    : 0;

  const lines = [];
  // A project-linked analysis clusters only the crawl's informational pages, and
  // says so — "confirmed pages" would imply somebody chose them.
  const selection = analysis.selection?.summary;
  const scopeText = selection
    ? `${totalPages} informational pages (articles, guides, FAQs) out of the ${selection.crawledPageCount} found in its sitemaps and informational listings`
    : `${totalPages} confirmed pages`;
  lines.push(`${project.domain} was analyzed across ${scopeText}, organized into ${analysis.clusters.length} topic clusters `
    + `(${clustered} pages assigned, ${analysis.unassignedPages.length} left unassigned — no cluster met the similarity bar).`);
  if (selection) {
    lines.push(`The other ${analysis.excludedUrls.length} crawled pages — location, service, people, listing and utility `
      + 'pages among them — were left out of hub and spoke by design; the "Excluded" tab lists each with its reason.');
  }
  lines.push(`Average cluster health is ${meanHealth}/100. ${gapCount} cluster${gapCount === 1 ? '' : 's'} ${gapCount === 1 ? 'has' : 'have'} no existing page broad enough `
    + `to serve as a hub — these are the clearest content gaps to fill first (see the "Suggested New Pages" tab).`);
  if (analysis.orphanDetectionWithheld) {
    lines.push('Orphan pages were not assessed: the crawl did not cover the whole site, so a page with no inbound link here may simply be linked from a page it never fetched.');
  } else if (orphanCount > 0) {
    lines.push(`${orphanCount} page${orphanCount === 1 ? '' : 's'} have no internal links pointing to them at all; search engines and users alike are unlikely to find these without a sitemap or search.`);
  }
  if (analysis.crawlMeta.sampled) {
    lines.push(`This site's confirmed selection (${totalPages + analysis.excludedUrls.length}+ pages) exceeded the crawl threshold, so this analysis is based on a representative sample of ${analysis.crawlMeta.sampleSize} pages rather than every page — link/orphan counts for the un-sampled majority are estimates, not verified.`);
  }
  return lines.join(' ');
}

async function buildWorkbook(analysis, project) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Content Architect';
  wb.created = new Date();

  // ── Tab 1: Summary ──────────────────────────────────────────────────────
  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 46 }, { width: 65 }];
  addNote(summary, 'HOW TO READ THIS WORKBOOK:  Cluster Map = every page, grouped under its hub.  '
    + 'Suggested New Pages = pages that DON\'T exist yet — write these.  Pages to Refresh or Retire = EXISTING pages worth improving or removing.  '
    + (analysis.selection
      ? 'Excluded = crawled pages left out before clustering: pages that are not informational (location, service, people, listing, utility) and technical cases (noindex, duplicates).  '
      : 'Excluded = URLs removed before analysis (technical reasons).  ')
    + 'Unassigned = pages we read but couldn\'t confidently group.', 2);
  summary.addRow([]);
  const summaryHeaderRow = summary.addRow(['Metric', 'Value']);
  summary.headerRowNumber = summaryHeaderRow.number;
  styleHeaderRow(summary);
  summary.views = [{ state: 'frozen', ySplit: summaryHeaderRow.number }];
  const excludedByReason = {};
  for (const e of analysis.excludedUrls) excludedByReason[e.reason] = (excludedByReason[e.reason] || 0) + 1;
  const meanHealth = analysis.clusters.length
    ? Math.round(analysis.clusters.reduce((s, c) => s + (c.health || 0), 0) / analysis.clusters.length)
    : 0;

  const estimatedCount = analysis.pages.filter((p) => p.estimated).length;
  summary.addRow(['Domain', project.domain]);
  summary.addRow(['Pages analyzed', analysis.pages.length]);
  if (estimatedCount > 0) {
    summary.addRow([`  — fully read (title, content, links)`, analysis.pages.length - estimatedCount]);
    summary.addRow([`  — estimated from URL only (not crawled — see note on Cluster Map)`, estimatedCount]);
  }
  summary.addRow(['Pages excluded (see "Excluded" tab)', analysis.excludedUrls.length]);
  for (const [reason, count] of Object.entries(excludedByReason)) summary.addRow([`  — ${reason}`, count]);
  summary.addRow(['Clusters', analysis.clusters.length]);
  summary.addRow(['Suggested new pages (see "Suggested New Pages" tab)', analysis.clusters.filter((c) => c.isGap).length]);
  summary.addRow(['Orphan pages (no internal links in)', analysis.orphanDetectionWithheld
    ? 'Not assessed — the crawl did not cover the whole site'
    : analysis.pages.filter((p) => (p.flags || []).includes('orphan')).length]);
  summary.addRow(['Unassigned pages (see "Unassigned" tab)', analysis.unassignedPages.length]);
  summary.addRow(['Mean cluster health', `${meanHealth}/100`]);
  summary.addRow(['Crawl mode', analysis.crawlMeta.crawlMode + (analysis.crawlMeta.sampled ? ` (sampled ${analysis.crawlMeta.sampleSize} of ${analysis.pages.length}+ pages)` : '')]);
  summary.addRow([]);
  const findingsHeader = summary.addRow(['Top findings, most severe first']);
  findingsHeader.font = { bold: true };
  for (const f of buildTopFindings(analysis)) summary.addRow([FLAG_LABEL[f.type] || f.type, f.detail]);
  summary.addRow([]);
  const narrativeHeader = summary.addRow(['Summary']);
  narrativeHeader.font = { bold: true };
  const narrativeRow = summary.addRow([buildNarrative(analysis, project)]);
  summary.mergeCells(narrativeRow.number, 1, narrativeRow.number, 2);
  narrativeRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  narrativeRow.height = 60;

  // ── Tab 2: Cluster Map — grouped, hub visually distinct, collapsible ────
  const clusterMap = wb.addWorksheet('Cluster Map');
  const cmCols = ['Cluster / Page', 'Role', 'URL', 'Word Count', 'Inbound Internal Links', 'Click Depth', 'Last Modified', 'Flags', 'Why It Is Placed Here'];
  clusterMap.columns = cmCols.map((h) => ({ width: h === 'URL' ? 48 : (h === 'Cluster / Page' ? 34 : (h === 'Why It Is Placed Here' ? 46 : 16)) }));
  addNote(clusterMap, 'One block per cluster. The HUB (highlighted) is the existing page that best serves as the pillar for that topic; SPOKES beneath it are the supporting articles. '
    + 'Rows are grouped per cluster — use the [-] / [+] controls in the row-number gutter (left edge) to collapse clusters you don\'t need right now. '
    + 'A page name ending in "(not crawled — estimated from URL only)" means the site had more confirmed pages than could be fully crawled, so that page was grouped by its URL alone, with no title or content read — see the Summary tab for how many.', cmCols.length);
  clusterMap.headerRowNumber = clusterMap.rowCount + 1;
  const cmHeaderRow = clusterMap.addRow(cmCols);
  styleHeaderRow(clusterMap);
  clusterMap.views = [{ state: 'frozen', ySplit: cmHeaderRow.number }];

  const sortedClusters = [...analysis.clusters].sort((a, b) => (a.health || 0) - (b.health || 0));
  for (const c of sortedClusters) {
    const banner = clusterMap.addRow([
      `${c.name}  —  Health ${c.health}/100${c.isGap ? '  —  NO HUB (see Suggested New Pages)' : ''}${c.ambiguous ? '  —  ambiguous hub, worth a manual check' : ''}`,
    ]);
    clusterMap.mergeCells(banner.number, 1, banner.number, cmCols.length);
    banner.eachCell((cell) => { cell.fill = BANNER_FILL; cell.font = { bold: true, size: 11 }; });
    banner.height = 20;

    if (!c.isGap && c.hubPageId) {
      const hub = analysis.pages.find((p) => p.id === c.hubPageId);
      if (hub) {
        const row = clusterMap.addRow([
          `  ★ ${displayTitle(hub)}`, 'HUB', hyperlink(hub.url), hub.wordCount || 0,
          hub.inboundLinkCount || 0, hub.depth ?? '', fmtDate(hub.modifiedAt), (hub.flags || []).join(', '), hub.assignmentReason || '',
        ]);
        row.eachCell((cell) => { cell.fill = HUB_FILL; cell.font = { bold: true, size: 10 }; });
        row.outlineLevel = 1;
      }
    }
    for (const spokeId of c.spokeIds) {
      const spoke = analysis.pages.find((p) => p.id === spokeId);
      if (!spoke) continue;
      const row = clusterMap.addRow([
        `     ${displayTitle(spoke)}`, 'Spoke', hyperlink(spoke.url), spoke.wordCount || 0,
        spoke.inboundLinkCount || 0, spoke.depth ?? '', fmtDate(spoke.modifiedAt), (spoke.flags || []).join(', '), spoke.assignmentReason || '',
      ]);
      row.eachCell((cell) => { cell.font = { size: 10 }; });
      row.outlineLevel = 1;
    }
  }

  // ── Tab 3: Suggested New Pages (gap hubs — pages that don't exist yet) ──
  const newPages = wb.addWorksheet('Suggested New Pages');
  const npCols = ['Cluster', 'Proposed Title', 'Proposed URL', 'Suggested Outline (from existing related pages)', 'Existing Pages This Would Tie Together'];
  newPages.columns = npCols.map((h) => ({ width: h.includes('Outline') ? 60 : (h.includes('Existing') ? 50 : 30) }));
  addNote(newPages, 'These pages DO NOT EXIST YET. Each row is a topic where you already have several related articles (spokes) but no single page broad enough to '
    + 'introduce the topic and link out to them — the classic missing "pillar page". The outline is assembled from headings already used across the related existing pages, as a starting point.', npCols.length);
  newPages.headerRowNumber = newPages.rowCount + 1;
  newPages.addRow(npCols);
  styleHeaderRow(newPages);
  newPages.views = [{ state: 'frozen', ySplit: newPages.headerRowNumber }];
  newPages.autoFilter = { from: { row: newPages.headerRowNumber, column: 1 }, to: { row: newPages.headerRowNumber, column: npCols.length } };

  let npRowIdx = 0;
  for (const c of analysis.clusters.filter((c) => c.isGap)) {
    const spokes = c.spokeIds.map((id) => analysis.pages.find((p) => p.id === id)).filter(Boolean);
    const spokeList = spokes.map((s) => s.title || s.url).join('; ');
    const row = newPages.addRow([c.name, c.gapSuggestion?.title || c.name, c.gapSuggestion?.slug || '', (c.gapSuggestion?.outline || []).join(' → '), spokeList]);
    row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; cell.font = { size: 10 }; });
    if (npRowIdx % 2 === 0) row.eachCell((cell) => { cell.fill = ZEBRA_FILL; });
    npRowIdx++;
  }

  // ── Tab 4: Pages to Refresh or Retire (existing pages, action needed) ───
  const actions = wb.addWorksheet('Pages to Refresh or Retire');
  const actCols = ['Action', 'Page', 'URL', 'Cluster', 'Word Count', 'Last Modified', 'Why'];
  actions.columns = actCols.map((h) => ({ width: h === 'Why' ? 55 : (h === 'URL' ? 45 : (h === 'Page' ? 35 : 20)) }));
  addNote(actions, 'These are EXISTING pages, not suggestions for new ones. Each was read and judged on its actual content, not just word count or age — '
    + 'a short or slightly-older page that is still relevant is left alone. REFRESH = still relevant but thin or could be expanded. '
    + 'RETIRE = the content itself is genuinely outdated or references something no longer current (an expired offer, a past event treated as ongoing, discontinued information).', actCols.length);
  actions.headerRowNumber = actions.rowCount + 1;
  actions.addRow(actCols);
  styleHeaderRow(actions);
  actions.views = [{ state: 'frozen', ySplit: actions.headerRowNumber }];
  actions.autoFilter = { from: { row: actions.headerRowNumber, column: 1 }, to: { row: actions.headerRowNumber, column: actCols.length } };

  let actRowIdx = 0;
  for (const p of analysis.pages) {
    if (p.contentAction !== 'retire' && p.contentAction !== 'refresh') continue;
    const cluster = analysis.clusters.find((c) => c.id === p.clusterId);
    const row = actions.addRow([
      p.contentAction === 'retire' ? 'Retire' : 'Refresh', displayTitle(p), hyperlink(p.url),
      cluster ? cluster.name : '(not part of any cluster)', p.wordCount || 0, fmtDate(p.modifiedAt),
      p.contentActionReason || '',
    ]);
    row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; cell.font = { size: 10 }; });
    if (p.contentAction === 'retire') row.getCell(1).font = { bold: true, color: { argb: 'FFB91C1C' } };
    else row.getCell(1).font = { bold: true, color: { argb: 'FF92400E' } };
    if (actRowIdx % 2 === 0) row.eachCell((cell) => { cell.fill = cell.fill || ZEBRA_FILL; });
    actRowIdx++;
  }

  // ── Tab 5: Excluded (left out before analysis, each with its reason) ────
  const excludedWs = wb.addWorksheet('Excluded');
  const exCols = ['URL', 'Reason', 'Detail'];
  excludedWs.columns = [{ width: 55 }, { width: 30 }, { width: 45 }];
  addNote(excludedWs, analysis.selection
    ? 'These crawled pages were left out BEFORE clustering. Hub and spoke maps informational content only, so location, service, people, listing and utility pages are excluded by design; the rest are technical cases (noindex, canonicalised elsewhere, duplicates). Each row gives the reason.'
    : 'These confirmed URLs were removed BEFORE clustering, for a specific technical reason — they were never read for topic or content and do not appear anywhere else in this workbook.', exCols.length);
  excludedWs.headerRowNumber = excludedWs.rowCount + 1;
  excludedWs.addRow(exCols);
  styleHeaderRow(excludedWs);
  excludedWs.views = [{ state: 'frozen', ySplit: excludedWs.headerRowNumber }];
  excludedWs.autoFilter = { from: { row: excludedWs.headerRowNumber, column: 1 }, to: { row: excludedWs.headerRowNumber, column: exCols.length } };
  let exRowIdx = 0;
  for (const e of analysis.excludedUrls) {
    const row = excludedWs.addRow([hyperlink(e.url), e.reason, e.detail || '']);
    row.eachCell((cell) => { cell.font = { size: 10 }; });
    if (exRowIdx % 2 === 0) row.eachCell((cell) => { cell.fill = ZEBRA_FILL; });
    exRowIdx++;
  }

  // ── Tab 6: Unassigned (analyzed, but no cluster fit) ────────────────────
  const unassignedWs = wb.addWorksheet('Unassigned');
  const unCols = ['URL', 'Title', 'Word Count', 'Closest Cluster (didn\'t quite fit)', 'How Close', 'Recommendation'];
  unassignedWs.columns = [{ width: 48 }, { width: 40 }, { width: 12 }, { width: 32 }, { width: 12 }, { width: 45 }];
  addNote(unassignedWs, 'These pages didn\'t share enough topical similarity with any cluster to join one confidently. Most were fully read; on a large site some may say '
    + '"(not crawled — estimated from URL only)" instead of a real title — those were grouped by URL alone because the site exceeded the crawl-sample limit, not because of an error. '
    + '"Closest Cluster" is the group it came nearest to (even though it fell short) — a person can decide whether to place it there manually, leave it standalone, or retire it.', unCols.length);
  unassignedWs.headerRowNumber = unassignedWs.rowCount + 1;
  unassignedWs.addRow(unCols);
  styleHeaderRow(unassignedWs);
  unassignedWs.views = [{ state: 'frozen', ySplit: unassignedWs.headerRowNumber }];
  unassignedWs.autoFilter = { from: { row: unassignedWs.headerRowNumber, column: 1 }, to: { row: unassignedWs.headerRowNumber, column: unCols.length } };
  let unRowIdx = 0;
  for (const p of analysis.unassignedPages) {
    let recommendation = 'Review manually — may be fine as a standalone page.';
    if (p.contentAction === 'retire') recommendation = `Retire — ${p.contentActionReason || 'content judged no longer relevant'}`;
    else if (p.contentAction === 'refresh') recommendation = `Refresh — ${p.contentActionReason || 'still relevant but could be improved'}`;
    const row = unassignedWs.addRow([
      hyperlink(p.url), displayTitle(p), p.wordCount || 0,
      p.nearestCluster ? p.nearestCluster.clusterName : '(no clusters formed)',
      p.nearestCluster ? fmtPct(p.nearestCluster.similarity) : '',
      recommendation,
    ]);
    row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; cell.font = { size: 10 }; });
    if (unRowIdx % 2 === 0) row.eachCell((cell) => { cell.fill = cell.fill || ZEBRA_FILL; });
    unRowIdx++;
  }

  return wb;
}

function buildMarkdownNarrative(analysis, project) {
  const lines = [];
  lines.push(`# Content Architecture — ${project.domain}`);
  lines.push('');
  lines.push(buildNarrative(analysis, project));
  lines.push('');
  lines.push('## Clusters');
  for (const c of analysis.clusters.sort((a, b) => (a.health || 0) - (b.health || 0))) {
    lines.push('');
    lines.push(`### ${c.name} — health ${c.health}/100${c.isGap ? ' (no existing hub — see suggested new page below)' : ''}`);
    if (c.description) lines.push(c.description);
    if (c.isGap) {
      lines.push('');
      lines.push(`**Suggested new pillar page:** ${c.gapSuggestion?.title} (\`${c.gapSuggestion?.slug}\`)`);
      lines.push('Outline:');
      for (const h of c.gapSuggestion?.outline || []) lines.push(`- ${h}`);
    } else {
      const hub = analysis.pages.find((p) => p.id === c.hubPageId);
      lines.push('');
      lines.push(`**Hub:** [${hub?.title || hub?.url}](${hub?.url})${c.ambiguous ? ' _(ambiguous — two candidates were close, worth a manual check)_' : ''}`);
      lines.push('**Spokes:**');
      for (const id of c.spokeIds) {
        const s = analysis.pages.find((p) => p.id === id);
        if (s) lines.push(`- [${s.title || s.url}](${s.url})`);
      }
    }
  }
  lines.push('');
  lines.push('## What this analysis can\'t tell you');
  lines.push('- No search volume, so gaps are sized by cluster size, not by opportunity.');
  lines.push('- Cannibalization is inferred from content similarity, not measured from impressions — labeled "possible" throughout.');
  lines.push('- Hub selection uses structural proxies, not actual rankings. Mostly right, occasionally wrong where an older post outranks the pillar.');
  lines.push('- No internal link recommendations in this version.');
  lines.push('- Pages that could not be crawled were clustered from their URL only and are marked accordingly.');
  if (analysis.crawlMeta.sampled) lines.push(`- This run analyzed a ${analysis.crawlMeta.sampleSize}-page sample, not the full confirmed selection — it exceeded the crawl threshold.`);
  return lines.join('\n');
}

module.exports = { buildWorkbook, buildMarkdownNarrative, buildNarrative, buildTopFindings };
