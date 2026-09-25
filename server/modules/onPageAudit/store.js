// ── Persistence — backed by Postgres ─────────────────────────────────────────
// Was one JSON file per audit under a data root. Now the on_page_audits table;
// see supabase/migrations/0034_on_page_audit_to_postgres.sql for why.
//
// Every exported name, argument and return shape is unchanged.
//
// listAudits() is the one that changed underneath: it used to read every file in
// the directory, JSON.parse each one, sort them all and keep the newest 50. The
// ordering and the cap are the database's now, so the cost is fifty rows rather
// than every audit ever saved. The summary shape it returns is identical.

const crypto = require('crypto');
const db = require('../../services/db');

function genId() {
  return `audit_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// The table is created by the migration runner; nothing to make on boot.
async function init() {}

async function saveAudit(audit) {
  // Raw HTML is still stripped before storing. It was dropped to keep the file
  // manageable; the same reasoning applies to a jsonb column, and nothing reads
  // it back.
  const { _html, ...saveData } = audit;
  await db.query(
    `insert into on_page_audits (id, data, audit_date)
     values ($1, $2, $3::timestamptz)
     on conflict (id) do update set
       data = excluded.data, audit_date = excluded.audit_date, updated_at = now()`,
    [saveData.id, db.json(saveData), saveData.auditDate || null]
  );
}

async function getAudit(id) {
  const row = await db.maybeOne(`select data from on_page_audits where id = $1`, [id]);
  return row ? row.data : null;
}

// The list screen's summary row. Derived here rather than stored, because it is
// a projection of the audit and would otherwise be a second copy to keep in step.
function summarize(audit) {
  const sections = audit.sections || [];
  return {
    id: audit.id,
    url: audit.url,
    primaryKeywords: audit.primaryKeywords,
    pageType: audit.pageType,
    isYMYL: audit.isYMYL,
    status: audit.status,
    auditDate: audit.auditDate,
    passCount: sections.filter((s) => s.status === 'pass').length,
    totalSections: sections.length,
    failCount: sections.filter((s) => s.status === 'fail').length,
  };
}

async function listAudits() {
  const found = await db.rows(
    `select data from on_page_audits
      order by audit_date desc nulls last, id desc
      limit 50`
  );
  return found.map((r) => summarize(r.data));
}

async function deleteAudit(id) {
  await db.query(`delete from on_page_audits where id = $1`, [id]);
}

module.exports = { genId, saveAudit, getAudit, listAudits, deleteAudit, init };
