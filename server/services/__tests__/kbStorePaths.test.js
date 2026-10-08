// The knowledge base and module manifests are files named after fields from the
// request (id, client, period, module id). path.join resolves `..` silently, so
// an unchecked value wrote, read or deleted files anywhere the process could
// reach. Each of these cases used to escape the data root.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'kbstore-'));
const KB_ROOT = path.join(SANDBOX, 'kb');
const MODULES_ROOT = path.join(SANDBOX, 'modules');
fs.mkdirSync(KB_ROOT, { recursive: true });
fs.mkdirSync(path.join(MODULES_ROOT, 'article-enhancement'), { recursive: true });
fs.writeFileSync(path.join(MODULES_ROOT, 'article-enhancement', 'manifest.json'), '{"id":"article-enhancement"}');

process.env.KB_ROOT = KB_ROOT;
process.env.MODULES_ROOT = MODULES_ROOT;
const store = require('../kbStore');

test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const outside = (...p) => path.join(SANDBOX, ...p);

test('createKB refuses an id that climbs out of the KB root', async () => {
  await assert.rejects(
    store.createKB({ id: '../escaped', category: 'brand', body: 'x' }),
    (e) => e.status === 400,
  );
  assert.strictEqual(fs.existsSync(outside('escaped.md')), false);
});

test('createKB refuses a client-feedback client or period that climbs out', async () => {
  await assert.rejects(
    store.createKB({ id: 'fb-1', category: 'client-feedback', client: '../../c', period: '2026-q4' }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    store.createKB({ id: 'fb-2', category: 'client-feedback', client: 'acme', period: '../../p' }),
    (e) => e.status === 400,
  );
});

test('createKB still creates an ordinary KB', async () => {
  const kb = await store.createKB({ id: 'acme-brand', category: 'brand', client: 'acme', body: 'Hello' });
  assert.strictEqual(kb.path, 'brand/acme-brand.md');
  assert.ok(fs.existsSync(path.join(KB_ROOT, 'brand', 'acme-brand.md')));
  const read = await store.readKB('acme-brand');
  assert.strictEqual(read.id, 'acme-brand');
});

test('deleteKB will not unlink a file outside the root, even if the index says so', async () => {
  const victim = outside('victim.md');
  fs.writeFileSync(victim, 'keep me');
  const index = await store.readIndex();
  index.knowledge_bases.push({ id: 'poisoned', category: 'brand', client: 'global', path: '../victim.md', active: true });
  await store.writeIndex(index);

  await assert.rejects(store.deleteKB('poisoned'), (e) => e.status === 400);
  assert.ok(fs.existsSync(victim), 'the file outside the KB root is still there');
});

test('readModule and writeModule refuse a module id that climbs out', async () => {
  await assert.rejects(store.readModule('../kb'), (e) => e.status === 400);
  await assert.rejects(store.writeModule('../elsewhere', { id: 'x' }), (e) => e.status === 400);
  assert.strictEqual(fs.existsSync(outside('elsewhere')), false);
});

test('readModule and writeModule still work for a real module', async () => {
  const mod = await store.readModule('article-enhancement');
  assert.strictEqual(mod.id, 'article-enhancement');
  await store.writeModule('article-enhancement', { id: 'article-enhancement', required_kbs: [] });
  assert.deepStrictEqual((await store.readModule('article-enhancement')).required_kbs, []);
});
