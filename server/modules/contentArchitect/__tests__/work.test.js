// ── The Hub & Spoke report's saved work ─────────────────────────────────────
//
// work.js gathers keyword sets, Content Writer articles and page enhancements
// back onto the report. The linking rules are pure and always run; the SQL
// (the word count, the origin filter, the enhancement summaries) needs a real
// Postgres and runs only with TEST_DATABASE_URL.
//
// Run: TEST_DATABASE_URL=postgres://... node modules/contentArchitect/__tests__/work.test.js

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { linkArticles } = require('../work');

const topics = [
  { clusterId: 'c1', topic: 'How to Choose an MSP', primary: [{ keyword: 'choose msp' }, { keyword: 'msp checklist' }] },
  { clusterId: 'c2', topic: 'MSP Pricing', primary: [{ keyword: 'msp checklist' }, { keyword: 'msp pricing' }] },
];
const ctx = { caProjectId: 'proj_1', platformProjectId: 'p1' };

test('an article with this project\'s origin is placed by its origin', () => {
  const [a] = linkArticles([{ id: 'a', projectId: 'other', keyword: 'anything', origin: { caProjectId: 'proj_1', clusterId: 'c9', topic: 'T' } }], topics, ctx);
  assert.deepEqual([a.clusterId, a.topic, a.linkedBy], ['c9', 'T', 'origin']);
});

test('an article with another project\'s origin is not this report\'s', () => {
  assert.deepEqual(linkArticles([{ id: 'a', projectId: 'p1', keyword: 'choose msp', origin: { caProjectId: 'proj_2', clusterId: 'c1', topic: 'T' } }], topics, ctx), []);
});

test('an older article without origin is matched by primary keyword, first primary winning', () => {
  const linked = linkArticles([
    { id: 'a', projectId: 'p1', keyword: ' Choose MSP ' },
    { id: 'b', projectId: 'p1', keyword: 'msp checklist' },
    { id: 'c', projectId: 'p1', keyword: 'unrelated' },
    { id: 'd', projectId: 'elsewhere', keyword: 'choose msp' },
  ], topics, ctx);
  assert.deepEqual(linked.map((x) => [x.id, x.clusterId, x.linkedBy]), [['a', 'c1', 'keyword'], ['b', 'c2', 'keyword']]);
});

test('a standalone analysis matches nothing by keyword', () => {
  assert.deepEqual(linkArticles([{ id: 'a', projectId: 'p1', keyword: 'choose msp' }], topics, { caProjectId: 'proj_1', platformProjectId: null }), []);
});

// ── SQL ─────────────────────────────────────────────────────────────────────

const { useTestDatabase } = require('../../../services/__tests__/helpers/testDatabase');
const runDb = useTestDatabase('work (SQL)');

if (runDb) {
  const db = require('../../../services/db');
  const { createProjectFixture } = require('../../../services/__tests__/helpers/projectFixture');
  const work = require('../work');
  const keywordResearchStore = require('../keywordResearchStore');
  const enhancementsStore = require('../enhancementsStore');
  const contentWriterStore = require('../../contentWriter/store');

  const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');
  let fixture;
  let other;

  before(async () => {
    for (const f of ['0040_content_architect_keyword_research.sql', '0041_content_architect_enhancements.sql']) {
      await db.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    await db.query('truncate content_architect_keyword_research, content_architect_enhancements');
    fixture = await createProjectFixture({ prefix: 'cawork', url: 'https://cawork-selftest.invalid' });
    other = await createProjectFixture({ prefix: 'caworkother', url: 'https://caworkother-selftest.invalid' });
  });

  after(async () => { await db.end(); });

  test('the work summary: keyword sets, linked articles with words and sections, enhancements', async () => {
    const project = { id: `proj_work_${Date.now()}`, platformProjectId: fixture.projectId };
    await keywordResearchStore.saveResult(project.id, 'c1', {
      topic: 'How to Choose an MSP', intent: 'informational',
      result: { keyword: 'choose msp', result: { primary: [{ keyword: 'choose msp', volume: 90 }], secondary: [{ keyword: 'msp list', volume: 10 }] } },
      selection: null,
    });
    const brief = { title: 'Choosing an MSP', intro: '', references: '', sections: [
      { id: '1', level: 'H2', heading: 'One', guidance: '' }, { id: '2', level: 'H3', heading: 'Two', guidance: '' }] };
    const withOrigin = await contentWriterStore.create(fixture.projectId, {
      keyword: 'something else', brief, draftHtml: '<p>Four words are here.</p><h2>And two</h2>',
      origin: { tool: 'content-architect', caProjectId: project.id, clusterId: 'c1', topic: 'How to Choose an MSP' },
    });
    const byKeyword = await contentWriterStore.create(fixture.projectId, { keyword: 'Choose MSP' });
    await contentWriterStore.create(fixture.projectId, { keyword: 'not linked' });
    // Another project's article naming this analysis: invisible to a caller without access.
    await contentWriterStore.create(other.projectId, {
      keyword: 'x', origin: { tool: 'content-architect', caProjectId: project.id, clusterId: 'c1', topic: 'How to Choose an MSP' },
    });
    await enhancementsStore.saveEnhancement({
      projectId: project.id, clusterId: 'c1', url: 'https://cawork-selftest.invalid/blog/a', contentType: 'article', title: 'A',
      result: { recommendations: '# r', enhancedText: 'x [NEW]one[/NEW] y [NEW]two[/NEW]', coverage: { checked: 12, total: 12, covered: 9, reportMarkdown: '' } },
    });

    const req = { user: null }; // no identity: access to the other project is refused
    const out = await work.projectWork(req, project);

    assert.equal(out.keywordResearch.length, 1);
    assert.deepEqual(out.keywordResearch[0].primary, [{ keyword: 'choose msp', volume: 90 }]);
    assert.deepEqual(out.keywordResearch[0].secondary, [{ keyword: 'msp list', volume: 10 }]);

    const ids = out.articles.map((a) => a.id).sort();
    assert.deepEqual(ids, [withOrigin.id, byKeyword.id].sort());
    const a = out.articles.find((x) => x.id === withOrigin.id);
    assert.equal(a.linkedBy, 'origin');
    assert.equal(a.sections, 2);
    assert.equal(a.words, 6);
    assert.equal(a.stage, 'draft');
    assert.equal(out.articles.find((x) => x.id === byKeyword.id).stage, 'started');

    assert.equal(out.enhancements.length, 1);
    assert.deepEqual(out.enhancements[0].coverage, { covered: 9, total: 12 });
    assert.equal(out.enhancements[0].additions, 2);

    const full = await work.getArticle(req, project, withOrigin.id);
    assert.equal(full.brief.title, 'Choosing an MSP');
    assert.match(full.draftHtml, /Four words/);
    assert.equal(await work.getArticle(req, project, '00000000-0000-0000-0000-000000000000'), null);
    assert.equal(await work.getArticle(req, project, 'not-a-uuid'), null);
  });

  test('a PUT keeps the origin the article was created with', async () => {
    const row = await contentWriterStore.create(fixture.projectId, {
      keyword: 'k', origin: { tool: 'content-architect', caProjectId: 'proj_x', clusterId: 'c', topic: 't' },
    });
    const edited = contentWriterStore.editable({ keyword: 'k2', origin: { tool: 'content-architect', caProjectId: 'proj_evil', clusterId: 'c', topic: 't' } });
    assert.equal(edited.origin, undefined, 'the editable schema never carries origin');
    const saved = await contentWriterStore.save(fixture.projectId, row.id, row.revision, { ...row.document, ...edited });
    assert.equal(saved.document.origin.caProjectId, 'proj_x');
    const junk = await contentWriterStore.create(fixture.projectId, { keyword: 'k', origin: { tool: 'other' } });
    assert.equal(junk.document.origin, undefined, 'an unreadable origin is dropped');
  });

  test('re-enhancing a page replaces its saved enhancement', async () => {
    const base = { projectId: 'proj_enh', url: 'https://x.invalid/p', contentType: 'hub', title: 'P' };
    await enhancementsStore.saveEnhancement({ ...base, result: { enhancedText: 'first' } });
    await enhancementsStore.saveEnhancement({ ...base, result: { enhancedText: 'second' } });
    const list = await enhancementsStore.listSummaries('proj_enh');
    assert.equal(list.length, 1);
    assert.equal(list[0].coverage, null);
    assert.equal((await enhancementsStore.getEnhancement('proj_enh', base.url)).result.enhancedText, 'second');
    assert.equal(await enhancementsStore.getEnhancement('proj_enh', 'https://x.invalid/none'), null);
  });
}
