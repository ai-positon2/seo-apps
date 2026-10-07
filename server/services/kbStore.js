const fs = require('fs').promises;
const path = require('path');
const matter = require('gray-matter');

const KB_ROOT = process.env.KB_ROOT || path.join(__dirname, '../../knowledge-base');
const MODULES_ROOT = process.env.MODULES_ROOT || path.join(__dirname, '../../modules');
const INDEX_PATH = path.join(KB_ROOT, '_index.json');

// ── Index ────────────────────────────────────────────────────────────────────

async function readIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { last_updated: today(), knowledge_bases: [] };
  }
}

async function writeIndex(index) {
  index.last_updated = today();
  await fs.mkdir(KB_ROOT, { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}

// ── KB CRUD ──────────────────────────────────────────────────────────────────

async function listKBs() {
  const index = await readIndex();
  return index.knowledge_bases;
}

async function readKB(id) {
  const index = await readIndex();
  const entry = index.knowledge_bases.find(kb => kb.id === id);
  if (!entry) return null;
  const filePath = path.join(KB_ROOT, entry.path);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = matter(raw);
    return { id, path: entry.path, meta: parsed.data, body: parsed.content.trim() };
  } catch {
    return null;
  }
}

async function writeKB(id, frontmatter, body, changeNote = 'Updated') {
  const index = await readIndex();
  const entry = index.knowledge_bases.find(kb => kb.id === id);
  if (!entry) throw new Error(`KB "${id}" not found in index.`);

  // Auto-increment patch version
  const parts = (frontmatter.version || '1.0.0').split('.').map(Number);
  parts[2]++;
  frontmatter.version = parts.join('.');
  frontmatter.last_updated = today();

  // Append changelog entry
  const changelogLine = `- ${today()} v${frontmatter.version} — ${changeNote}`;
  let updatedBody = body || '';
  if (updatedBody.includes('## Changelog')) {
    updatedBody = updatedBody.replace('## Changelog\n', `## Changelog\n${changelogLine}\n`);
  } else {
    updatedBody += `\n\n## Changelog\n${changelogLine}`;
  }

  const fileContent = matter.stringify('\n' + updatedBody.trim(), frontmatter);
  const filePath = path.join(KB_ROOT, entry.path);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, fileContent, 'utf8');

  // Sync index entry
  entry.active = frontmatter.active !== false;
  entry.tags = frontmatter.tags || [];
  entry.linked_modules = frontmatter.linked_modules || [];
  await writeIndex(index);

  return frontmatter;
}

async function createKB(data) {
  const { id, category, client, industry, tags, linked_modules, priority, body, period, label } = data;

  // Determine file path based on category
  let filePath;
  if (category === 'client-feedback') {
    const p = period || currentPeriod();
    filePath = `client-feedback/${client}/${p}.md`;
  } else if (category === 'industry') {
    filePath = `industry/${id}.md`;
  } else if (category === 'brand') {
    filePath = `brand/${id}.md`;
  } else if (category === 'best-practices') {
    filePath = `best-practices/${id}.md`;
  } else {
    throw new Error(`Unknown category: ${category}`);
  }

  // Check for duplicate
  const index = await readIndex();
  if (index.knowledge_bases.find(kb => kb.id === id)) {
    throw new Error(`KB "${id}" already exists.`);
  }

  const t = today();
  const frontmatter = {
    id,
    category,
    client: client || 'global',
    industry: industry || 'global',
    tags: tags || [],
    last_updated: t,
    version: '1.0.0',
    active: true,
    priority: priority || 3,
    linked_kbs: [],
    linked_modules: linked_modules || [],
    deprecated: false,
    ...(label ? { label } : {}),
  };

  const changelogLine = `- ${t} v1.0.0 — Initial creation`;
  const initialBody = (body ? body.trim() + '\n' : '') + `\n## Changelog\n${changelogLine}`;
  const fileContent = matter.stringify('\n' + initialBody.trim(), frontmatter);

  const fullPath = path.join(KB_ROOT, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, fileContent, 'utf8');

  index.knowledge_bases.push({
    id,
    category,
    client: client || 'global',
    path: filePath,
    active: true,
    tags: tags || [],
    linked_modules: linked_modules || [],
  });
  await writeIndex(index);

  return { id, path: filePath, meta: frontmatter, body: initialBody };
}

async function deleteKB(id) {
  const index = await readIndex();
  const entryIdx = index.knowledge_bases.findIndex(kb => kb.id === id);
  if (entryIdx === -1) throw new Error(`KB "${id}" not found in index.`);
  const entry = index.knowledge_bases[entryIdx];
  const filePath = path.join(KB_ROOT, entry.path);
  try { await fs.unlink(filePath); } catch { /* file may not exist */ }
  index.knowledge_bases.splice(entryIdx, 1);
  await writeIndex(index);
}

async function toggleActive(id) {
  const kb = await readKB(id);
  if (!kb) throw new Error(`KB "${id}" not found.`);
  const nowActive = !kb.meta.active;
  kb.meta.active = nowActive;
  kb.meta.deprecated = !nowActive;
  await writeKB(id, kb.meta, kb.body, nowActive ? 'Reactivated' : 'Deactivated');
  return nowActive;
}

// ── Module manifests ─────────────────────────────────────────────────────────

async function listModules() {
  try {
    const entries = await fs.readdir(MODULES_ROOT, { withFileTypes: true });
    const modules = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(MODULES_ROOT, entry.name, 'manifest.json');
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          modules.push(JSON.parse(raw));
        } catch { /* skip */ }
      }
    }
    return modules;
  } catch {
    return [];
  }
}

async function readModule(moduleId) {
  const manifestPath = path.join(MODULES_ROOT, moduleId, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(raw);
}

async function writeModule(moduleId, manifest) {
  const dir = path.join(MODULES_ROOT, moduleId);
  await fs.mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentPeriod() {
  const d = new Date();
  const q = Math.ceil((d.getMonth() + 1) / 3);
  return `${d.getFullYear()}-q${q}`;
}

module.exports = {
  KB_ROOT, MODULES_ROOT,
  readIndex, writeIndex,
  listKBs, readKB, writeKB, createKB, deleteKB, toggleActive,
  listModules, readModule, writeModule,
};
