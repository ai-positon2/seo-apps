const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');

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
  return candidates.find(p => fs.existsSync(p)) || null;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

function scoreColor(score, goodAt = 70, okAt = 40) {
  if (score === null || score === undefined) return '#9CA3AF';
  return score >= goodAt ? '#3B6D11' : score >= okAt ? '#EF9F27' : '#E24B4A';
}

function insightBlock(title, insight) {
  if (!insight || insight.error) return '';
  const obs = (insight.observation || []).map(o => `<li style="margin-bottom:4px;">${esc(o)}</li>`).join('');
  const rec = (insight.recommendation || []).map(r => `<li style="margin-bottom:4px;">${esc(r)}</li>`).join('');
  return `
    <div style="background:#EEEDFE;border-radius:8px;padding:12px 16px;margin:10px 0 18px;">
      <div style="font-size:10px;font-weight:600;color:#534AB7;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${esc(title)} — Insight</div>
      <div style="font-size:11px;color:#374151;margin-bottom:6px;"><strong>Observation</strong><ul style="margin:4px 0 0;padding-left:16px;">${obs}</ul></div>
      <div style="font-size:11px;color:#374151;"><strong>Recommendation</strong><ul style="margin:4px 0 0;padding-left:16px;">${rec}</ul></div>
    </div>`;
}

function domainLabel(d) {
  return esc(d.label || d.domain) + (d.isClient ? ' <span style="color:#534AB7;font-weight:600;">(Client)</span>' : '');
}

function overallSection(domains) {
  const rows = domains.map(d => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${domainLabel(d)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.authorityScore)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.homepageAuthorityScore)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.domainRank?.organicTraffic)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.domainRank?.organicKeywords)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.backlinks?.totalBacklinks)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.backlinks?.referringDomains)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.aioKeywordCount)}</td>
    </tr>`).join('');

  return `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">Overall Analysis</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Authority</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Home Page Auth.</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Organic Traffic</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Keywords</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Backlinks</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Ref. Domains</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">AIO Keywords</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function pageSpeedSection(domains) {
  const rows = domains.map(d => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${domainLabel(d)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;color:${scoreColor(d.pageSpeed?.mobile?.score)};font-weight:600;">${fmt(d.pageSpeed?.mobile?.score)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;color:${scoreColor(d.pageSpeed?.desktop?.score)};font-weight:600;">${fmt(d.pageSpeed?.desktop?.score)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${d.pageSpeed?.coreWebVitalsPassed === true ? 'Pass' : d.pageSpeed?.coreWebVitalsPassed === false ? 'Fail' : '—'}</td>
    </tr>`).join('');

  return `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">Page Speed Score Comparison</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Mobile</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Desktop</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Core Web Vitals</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function keywordSection(domains, keywordGap) {
  const rows = domains.map(d => {
    const b = d.keywordBuckets || {};
    return `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${domainLabel(d)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(b.page1)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(b.page2)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(b.page3to5)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(b.page6to10)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;font-weight:600;">${fmt(b.total)}</td>
    </tr>`;
  }).join('');

  const gapSummary = keywordGap
    ? `<p style="font-size:12px;color:#6B7280;margin:8px 0 0;">Striking distance: <strong>${keywordGap.strikingDistance.length}</strong> · Untapped opportunities: <strong>${keywordGap.untapped.length}</strong> · Missing entirely: <strong>${keywordGap.missing.length}</strong></p>`
    : '';

  return `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">Keyword Ranking Comparison</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Page 1</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Page 2</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Page 3-5</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Page 6-10</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${gapSummary}`;
}

function brandedSection(domains) {
  const rows = domains.map(d => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${domainLabel(d)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.brandedKeywordCount)}${d.brandedKeywordCountCapped ? '+' : ''}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.nonBrandedKeywordCount)}</td>
    </tr>`).join('');

  return `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">Branded vs. Non-branded Keywords</h2>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Branded</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Non-branded</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function backlinkSection(domains, backlinkGap) {
  const gapRows = (backlinkGap || []).slice(0, 15).map(g => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;">${esc(g.domain)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(g.ascore)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(g.sharedByCount)}</td>
    </tr>`).join('');

  return `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">Off-page Metrics Comparison</h2>
    ${overallAuthorityTable(domains)}
    ${gapRows ? `
    <h3 style="font-size:13px;margin:16px 0 8px;color:#374151;">Top Referring Domain Gaps (link to competitors, not client)</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Authority</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Shared By</th>
      </tr></thead>
      <tbody>${gapRows}</tbody>
    </table>` : ''}`;
}

function overallAuthorityTable(domains) {
  const rows = domains.map(d => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${domainLabel(d)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.authorityScore)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.backlinks?.referringDomains)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:right;">${fmt(d.backlinks?.totalBacklinks)}</td>
    </tr>`).join('');
  return `
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#F9FAFB;">
        <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6B7280;">Domain</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Authority</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Referring Domains</th>
        <th style="padding:8px 10px;text-align:right;font-size:11px;color:#6B7280;">Backlinks</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function aiVisibilitySection(insights) {
  const insight = insights?.aiVisibility;
  if (!insight || insight.error) return '';
  return `<h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">AI Visibility</h2>${insightBlock('AI Visibility', insight)}`;
}

function buildDashboardHtml({ client, snapshot, insights }) {
  const domains = snapshot?.domains || [];
  const capturedAt = snapshot?.capturedAt ? new Date(snapshot.capturedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #111827; margin: 0; padding: 0; }
    * { box-sizing: border-box; }
  </style></head>
  <body>
    <div style="padding:32px 36px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111827;padding-bottom:14px;margin-bottom:20px;">
        <div>
          <h1 style="font-size:20px;margin:0;color:#111827;">Competitor Analysis — ${esc(client.name)}</h1>
          <p style="font-size:12px;color:#6B7280;margin:4px 0 0;">${esc(client.domain)}</p>
        </div>
        <div style="font-size:11px;color:#9CA3AF;">Data as of ${capturedAt}</div>
      </div>

      ${overallSection(domains)}
      ${insightBlock('Overall Analysis', insights?.overall)}

      ${pageSpeedSection(domains)}
      ${insightBlock('Page Speed', insights?.pageSpeed)}

      ${keywordSection(domains, snapshot?.keywordGap)}
      ${insightBlock('Keyword Ranking', insights?.keywordRanking)}

      ${brandedSection(domains)}
      ${insightBlock('Branded vs. Non-branded', insights?.branded)}

      ${backlinkSection(domains, snapshot?.backlinkGap)}
      ${insightBlock('Off-page Metrics', insights?.backlink)}

      ${aiVisibilitySection(insights)}
    </div>
  </body></html>`;
}

async function renderDashboardPdf({ client, snapshot, insights }) {
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
    await page.setContent(buildDashboardHtml({ client, snapshot, insights }), { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    return pdf;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderDashboardPdf };
