// Offline browser integration: build the client first. Uses an isolated in-memory
// API and fixture generation; never connects to the configured DB or AI providers.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');
const puppeteer = require('puppeteer-core');
const { editable, conflict } = require('../store');
const { parseBrief, briefHash } = require('../document');
const { exportDocx } = require('../export');

async function main() {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const project = { id: projectId, name: 'Content Writer QA', lifecycleStatus: 'active', primaryDomain: { host: 'example.org' }, schedule: {}, settings: {}, competitors: [], proposedCompetitors: [], recipients: [] };
  const app = express(); app.use(express.json());
  let row = null, draftInput;
  app.get('/api/auth/verify', (_, res) => res.json({ valid: true, role: 'seo', email: 'qa@example.org', userId: 'qa', hasProfile: true }));
  app.get('/api/projects', (_, res) => res.json({ projects: [project], workspaces: [], capabilities: {} }));
  const base = `/api/content-writer/projects/${projectId}/articles`;
  app.get(base, (_, res) => res.json({ articles: row ? [{ id: row.id, keyword: row.document.keyword, title: row.document.brief?.title, has_draft: !!row.document.draftHtml, updated_at: row.updated_at }] : [] }));
  app.post(base, (req, res) => {
    row = { id: '22222222-2222-4222-8222-222222222222', project_id: projectId, revision: 1, document: editable(req.body), updated_at: new Date().toISOString() };
    res.json(row);
  });
  app.get(`${base}/:id`, (_, res) => res.json(row));
  app.put(`${base}/:id`, (req, res) => {
    if (req.body.revision !== row.revision) return res.status(409).json({ error: conflict().message });
    row = { ...row, revision: row.revision + 1, document: { ...row.document, ...editable(req.body.document) }, updated_at: new Date().toISOString() };
    res.json(row);
  });
  app.post(`${base}/:id/:stage`, (req, res) => {
    if (req.body.stage) throw new Error('Unexpected request');
    if (req.params.stage === 'brief') row.document.brief = parseBrief(`# H1: A guide to healthy gums
## H2: Understanding gum health
**Writing Instructions:**
- Explain the signs and the role of prevention.
**Keywords:** healthy gums, gum health
### H3: When to seek help
- Explain the importance of professional care.
## H2: Frequently Asked Questions
- What does a healthy gum look like?
**Reference Blog URLs:**
- [1] https://example.org/research`);
    else {
      draftInput = JSON.parse(JSON.stringify(row.document.brief));
      row.document.draftHtml = `<h1>${row.document.brief.title}</h1><p>Healthy gums help support your teeth. This is a fixture article for checking the editor.</p>` + row.document.brief.sections.map(s => `<${s.level.toLowerCase()}>${s.heading}</${s.level.toLowerCase()}><p>Clear, practical information about gum health.</p>`).join('') + '<table><tr><th>Sign</th><th>Action</th></tr><tr><td>Sore gums</td><td>Speak to your dentist</td></tr></table>';
      row.document.draftBriefHash = briefHash(row.document.brief);
      row.document.research = { sources: [], gaps: ['Author details were not supplied.'], checkedAt: new Date().toISOString(), status: 'AI source check passed' };
    }
    row.revision++; res.set('Content-Type', 'text/event-stream'); res.end(`event: result\ndata: ${JSON.stringify(row)}\n\nevent: done\ndata: {}\n\n`);
  });
  app.post(`/api/content-writer/projects/${projectId}/export`, async (req, res) => {
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(await exportDocx(req.body.document, req.body.stage));
  });
  app.use('/api', (_, res) => res.json({ runs: [], totals: {}, balance: null }));
  const dist = path.resolve(__dirname, '../../../../client/dist');
  app.use(express.static(dist)); app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('Set CHROME_PATH for this browser test.');
  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1512, height: 1120 });
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-writer-downloads-'));
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const button = async text => { await page.waitForFunction(t => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === t && !b.disabled), {}, text);
      await page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t && !b.disabled).click(), text); };
    await page.goto(`http://127.0.0.1:${server.address().port}/content-writer`, { waitUntil: 'networkidle0' });
    await page.type('input[placeholder="e.g. what is periodontal disease"]', 'healthy gums');
    await button('Build brief'); await page.waitForSelector('#cw-title');
    // Deleting a parent heading must not strand its subheadings at a skipped level.
    await page.click('button[aria-label="Delete section 1"]');
    assert.equal(await page.$eval('select[aria-label="Section 1 heading level"]', s => s.value), 'H2');
    await button('Rebuild brief'); await page.waitForSelector('#cw-title');
    await page.click('input[aria-label="Section 1 heading"]', { clickCount: 3 });
    await page.type('input[aria-label="Section 1 heading"]', 'User edited heading');
    // Levels now run H2-H6, and an outline may not skip one.
    assert.deepEqual(await page.$$eval('select[aria-label="Section 2 heading level"] option',
      options => options.map(o => `${o.value}${o.disabled ? ':off' : ''}`)), ['H2', 'H3', 'H4:off', 'H5:off', 'H6:off']);
    await page.select('select[aria-label="Section 2 heading level"]', 'H2');
    await page.click('button[aria-label="Move section 2 up"]');
    await button('+ Add heading');
    await page.type('input[aria-label="Section 4 heading"]', 'New section');
    await page.click('button[aria-label="Delete section 4"]');
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      document.querySelector('.cw-drag').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      document.querySelectorAll('.cw-section')[2].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector('input[aria-label="Section 1 heading"]').value === 'User edited heading');
    await page.click('button[aria-label="Move section 2 up"]');
    await page.screenshot({ path: path.join(os.tmpdir(), 'content-writer-brief.png'), fullPage: true });
    await button('Generate draft →'); await page.waitForSelector('.tiptap[contenteditable="true"]');
    assert.equal(draftInput.sections[0].heading, 'When to seek help');
    assert.equal(draftInput.sections[0].level, 'H2');
    assert.equal(draftInput.sections[1].heading, 'User edited heading');
    await page.click('.tiptap p'); await page.keyboard.press('Home'); await page.keyboard.type('Manual edit. ');
    await page.waitForFunction(() => document.querySelector('.cw-save-status').textContent === 'Saved to project');
    assert.match(row.document.draftHtml, /Manual edit/);
    await page.click('.tiptap td'); await button('Add row');
    await page.waitForFunction(() => document.querySelectorAll('.tiptap tr').length === 3);
    await page.waitForFunction(() => document.querySelector('.cw-save-status').textContent === 'Saved to project');
    await button('Preview'); assert.equal(await page.$eval('.tiptap', e => e.contentEditable), 'false');
    await page.reload({ waitUntil: 'networkidle0' }); await button('Draft');
    await page.waitForFunction(() => document.querySelector('.tiptap')?.textContent.includes('Manual edit'));
    assert.equal(await page.$$eval('.tiptap tr', a => a.length), 3);
    const exportResponse = page.waitForResponse(r => r.url().endsWith('/export'));
    await button('Export draft · DOCX'); assert.equal((await exportResponse).status(), 200);
    await button('Export JSON');
    for (let i = 0; i < 40 && !fs.readdirSync(downloadDir).some(f => f.endsWith('.json')); i++) await new Promise(r => setTimeout(r, 100));
    const jsonFile = fs.readdirSync(downloadDir).find(f => f.endsWith('.json'));
    assert.ok(jsonFile, 'JSON download completed');
    const exported = JSON.parse(fs.readFileSync(path.join(downloadDir, jsonFile), 'utf8'));
    assert.equal(exported.projectId, projectId); assert.match(exported.draftHtml, /Manual edit/); assert.equal(exported.brief.sections[1].heading, 'User edited heading');
    const screenshot = path.join(os.tmpdir(), 'content-writer-desktop.png'); await page.screenshot({ path: screenshot, fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    const overflow = await page.$eval('.cw-page', el => el.scrollWidth > el.clientWidth + 2); assert.equal(overflow, false, 'Writer page should not overflow on mobile');
    await page.setViewport({ width: 1512, height: 1120 });
    row.revision++; row.document.keyword = 'Changed in another session';
    await page.click('.tiptap p'); await page.keyboard.press('Home'); await page.keyboard.type('Conflicting edit. ');
    await page.waitForFunction(() => document.body.textContent.includes('Another session saved this article'));
    await button('Discard local edits & reload saved article');
    await page.waitForFunction(() => document.querySelector('input[placeholder="e.g. what is periodontal disease"]').value === 'Changed in another session');
    assert.equal(await page.$eval('.tiptap', e => e.textContent.includes('Conflicting edit')), false);
    await page.click('.tiptap p'); await page.keyboard.press('Home'); await page.keyboard.type('Quick navigation edit. ');
    await button('Projects');
    for (let i = 0; i < 30 && !row.document.draftHtml.includes('Quick navigation edit'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(row.document.draftHtml, /Quick navigation edit/, 'Navigation flushes pending autosave');
    // The handoff from Keyword Research / Hub & Spoke: a fresh article,
    // prefilled, saving nothing until the writer asks for a brief.
    const articlesBefore = row.revision;
    await page.goto(`http://127.0.0.1:${server.address().port}/content-writer`
      + '?keyword=teeth%20cleaning%20cost&secondary=dental%20insurance%2C%20how%20often&client=gentle-dental',
    { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('input[placeholder="e.g. what is periodontal disease"]')?.value === 'teeth cleaning cost');
    assert.equal(await page.$eval('input[placeholder="Separate keywords with commas"]', el => el.value), 'dental insurance, how often');
    assert.equal(await page.$eval('.cw-settings select', el => el.value), 'gentle-dental');
    // Nothing is written until the writer presses a button, and the handoff
    // params do not survive into the URL.
    assert.equal(row.revision, articlesBefore, 'Handoff must not save anything on arrival');
    assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('keyword')), null);
    assert.deepEqual(errors, []);
    console.log(`Browser workflow passed: brief edits/drag -> draft -> table editing -> autosave/reopen -> DOCX/JSON -> conflict recovery -> navigation save -> keyword handoff; mobile layout. Screenshot: ${screenshot}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
