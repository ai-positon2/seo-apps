const db = require('../../services/db');
const { editableSchema, exportableSchema, cleanHtml } = require('./document');
const conflict = () => Object.assign(new Error('This article changed in another session. Reopen the saved article before saving again. Your current text can still be exported.'), { status: 409 });
async function list(projectId) {
  return db.rows(`select id, project_id, revision, updated_at, document->>'keyword' as keyword,
    document->'brief'->>'title' as title, coalesce(length(document->>'draftHtml'),0)>0 as has_draft
    from content_writer_articles where project_id=$1 order by updated_at desc`, [projectId]);
}
async function get(projectId, id) {
  const row = await db.maybeOne('select * from content_writer_articles where project_id=$1 and id=$2', [projectId, id]);
  if (!row) throw Object.assign(new Error('Article not found.'), { status: 404 });
  return row;
}
function parse(schema, input) {
  const data = schema.parse(input);
  data.draftHtml = cleanHtml(data.draftHtml);
  return data;
}
const editable = input => parse(editableSchema, input);
const exportable = input => parse(exportableSchema, input);
async function create(projectId, input) {
  return db.one('insert into content_writer_articles(project_id, document) values($1,$2::jsonb) returning *',
    [projectId, JSON.stringify(editable(input))]);
}
async function save(projectId, id, revision, document) {
  const row = await db.maybeOne(`update content_writer_articles set document=$4::jsonb,
    revision=revision+1, updated_at=now() where project_id=$1 and id=$2 and revision=$3 returning *`,
  [projectId, id, revision, JSON.stringify(document)]);
  if (!row) throw conflict();
  return row;
}
module.exports = { list, get, create, save, editable, exportable, conflict };
