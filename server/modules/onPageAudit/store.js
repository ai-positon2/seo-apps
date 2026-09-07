const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');

// Ephemeral inside the image on a container platform; see services/dataRoot.js.
const DATA_ROOT = resolveDataRoot(
  'on-page-audit', path.join(__dirname, 'data'), 'ON_PAGE_AUDIT_DATA_ROOT',
);

function genId() {
  return `audit_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

async function ensureDir() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
}

async function saveAudit(audit) {
  await ensureDir();
  // Strip raw HTML from saved file to keep size manageable
  const { _html, ...saveData } = audit;
  await fs.writeFile(
    path.join(DATA_ROOT, `${audit.id}.json`),
    JSON.stringify(saveData, null, 2)
  );
}

async function getAudit(id) {
  try {
    const raw = await fs.readFile(path.join(DATA_ROOT, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function listAudits() {
  await ensureDir();
  try {
    const files = await fs.readdir(DATA_ROOT);
    const results = [];
    for (const f of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(DATA_ROOT, f), 'utf8');
        const a = JSON.parse(raw);
        results.push({
          id: a.id,
          url: a.url,
          primaryKeywords: a.primaryKeywords,
          pageType: a.pageType,
          isYMYL: a.isYMYL,
          status: a.status,
          auditDate: a.auditDate,
          passCount: (a.sections || []).filter(s => s.status === 'pass').length,
          totalSections: (a.sections || []).length,
          failCount: (a.sections || []).filter(s => s.status === 'fail').length,
        });
      } catch { /* skip corrupt files */ }
    }
    return results.sort((a, b) => b.auditDate.localeCompare(a.auditDate)).slice(0, 50);
  } catch { return []; }
}

async function deleteAudit(id) {
  await fs.unlink(path.join(DATA_ROOT, `${id}.json`)).catch(() => {});
}

async function init() {
  await ensureDir();
}

module.exports = { genId, saveAudit, getAudit, listAudits, deleteAudit, init };
