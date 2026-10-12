// ── Managing client feedback rules and batches ──────────────────────────────
// What the Feedback Rules screen does, behind its routes: create, edit,
// activate and retire rules; save a pasted feedback batch; draft rules from
// it; track the code-change action items it raised; and test a rule on sample
// text before it goes live.
//
// It never reads or writes a generated page. Rules apply to pages generated
// after they are activated; pages already made are left as they are.

const store = require('./store');
const fb = require('./cbhFeedback');
const draft = require('./cbhFeedbackDraft');

// A rejection the route can turn straight into an HTTP status.
class FeedbackError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const RULES = 'feedbackRules';
const BATCHES = 'feedbackBatches';

async function serviceVocab(clientId) {
  const services = await store.list('services', { client_id: clientId });
  return {
    serviceIds: services.map(s => s.id),
    services: services.map(s => ({ id: s.id, name: s.name, groups: s.groups || [] })),
  };
}

async function vocabulary(clientId) {
  const { services } = await serviceVocab(clientId);
  return {
    sections: [...fb.SECTION_GROUPS, ...fb.SECTIONS].map(key => ({ key, label: fb.SECTION_LABELS[key] || key })),
    programGroups: fb.PROGRAM_GROUPS.map(key => ({ key, label: fb.PROGRAM_LABELS[key] })),
    stages: fb.STAGES, severities: fb.SEVERITIES, statuses: fb.STATUSES, kinds: fb.KINDS,
    checkTypes: fb.CHECK_TYPES, units: fb.UNITS,
    services: services.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const STATUS_ORDER = { active: 0, draft: 1, retired: 2 };

async function listRules(clientId) {
  const rows = await fb.loadRules(clientId);
  return rows.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

async function findRuleByKey(clientId, key) {
  return (await store.list(RULES, { client_id: clientId })).find(r => r.key === key) || null;
}

function validated(rule, vocab) {
  const v = fb.validateRule(rule, vocab);
  if (!v.ok) throw new FeedbackError(v.errors.join(' '), 400);
  return v.rule;
}

async function createRule({ clientId, rule, batchId }) {
  if (!clientId) throw new FeedbackError('clientId is required.');
  const r = validated(rule || {}, await serviceVocab(clientId));
  if (await findRuleByKey(clientId, r.key)) {
    throw new FeedbackError(`A rule with the key "${r.key}" already exists. Edit that one, or choose another key.`, 409);
  }
  const saved = await store.insert(RULES, {
    ...r,
    client_id: clientId,
    batch_id: batchId || rule.batch_id || null,
    status: fb.STATUSES.includes(rule.status) ? rule.status : 'draft',
    version: 1,
    history: [],
  }, 'fbr');
  fb.invalidateRules(clientId);
  return fb.normalizeRule(saved);
}

// Every edit bumps the version -- which is what marks a page's stored AI
// review out of date -- and keeps the previous wording in `history`.
async function updateRule({ id, rule }) {
  const existing = await store.get(RULES, id);
  if (!existing) throw new FeedbackError('Rule not found.', 404);
  const r = validated({ ...rule, key: rule.key || existing.key }, await serviceVocab(existing.client_id));
  if (r.key !== existing.key && await findRuleByKey(existing.client_id, r.key)) {
    throw new FeedbackError(`A rule with the key "${r.key}" already exists.`, 409);
  }
  const { history, id: _id, created_at: _c, updated_at: _u, ...snapshot } = existing;
  const next = {
    ...r,
    client_id: existing.client_id,
    batch_id: existing.batch_id || null,
    status: fb.STATUSES.includes(rule.status) ? rule.status : existing.status,
    version: (existing.version || 1) + 1,
    history: [...(history || []), { ...snapshot, replaced_at: new Date().toISOString() }].slice(-20),
  };
  const saved = await store.update(RULES, id, next);
  fb.invalidateRules(existing.client_id);
  return fb.normalizeRule(saved);
}

async function setRuleStatus({ id, status }) {
  if (!fb.STATUSES.includes(status)) throw new FeedbackError(`Unknown status "${status}".`);
  const existing = await store.get(RULES, id);
  if (!existing) throw new FeedbackError('Rule not found.', 404);
  const saved = await store.update(RULES, id, { status });
  fb.invalidateRules(existing.client_id);
  return fb.normalizeRule(saved);
}

// ── Batches ─────────────────────────────────────────────────────────────────
async function listBatches(clientId) {
  const rows = await store.list(BATCHES, { client_id: clientId });
  return rows.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || ''))
    || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function createBatch({ clientId, title, receivedAt, rawText }) {
  if (!clientId) throw new FeedbackError('clientId is required.');
  if (!String(rawText || '').trim()) throw new FeedbackError('Paste the client\'s feedback first.');
  return store.insert(BATCHES, {
    client_id: clientId,
    title: String(title || '').trim() || 'Client feedback',
    received_at: receivedAt || new Date().toISOString().slice(0, 10),
    raw_text: String(rawText),
    action_items: [],
    proposed_revisions: [],
    rule_keys: [],
  }, 'fbb');
}

async function getBatch(id) {
  const batch = await store.get(BATCHES, id);
  if (!batch) throw new FeedbackError('Feedback batch not found.', 404);
  return batch;
}

// BILLED: one drafting call. Saves the drafts (never active), and records the
// proposed revisions and the code-change action items on the batch.
async function draftBatch({ id }) {
  const batch = await getBatch(id);
  const all = await fb.loadRules(batch.client_id);
  const inForce = all.filter(r => r.status !== 'retired');
  const vocab = await serviceVocab(batch.client_id);
  const out = await draft.draftRules({ batch, activeRules: inForce, vocab });

  const taken = new Set(all.map(r => r.key));
  const saved = [];
  for (const rule of out.rules) {
    let key = rule.key;
    for (let n = 2; taken.has(key); n++) key = `${rule.key}-${n}`;
    taken.add(key);
    saved.push(await createRule({ clientId: batch.client_id, rule: { ...rule, key, status: 'draft' }, batchId: batch.id }));
  }

  const revisions = out.revisions.map(x => ({ ...x, ruleId: (all.find(r => r.key === x.ruleKey) || {}).id || null }));
  const updated = await store.update(BATCHES, batch.id, {
    rule_keys: [...(batch.rule_keys || []), ...saved.map(r => r.key)],
    action_items: [...(batch.action_items || []), ...out.actionItems],
    proposed_revisions: [...(batch.proposed_revisions || []), ...revisions],
  });
  return { batch: updated, rules: saved, revisions, actionItems: out.actionItems, rejected: out.rejected };
}

async function updateActionItem({ id, index, status, note }) {
  const batch = await getBatch(id);
  const items = [...(batch.action_items || [])];
  if (!items[index]) throw new FeedbackError('Action item not found.', 404);
  if (status && !['open', 'done'].includes(status)) throw new FeedbackError(`Unknown status "${status}".`);
  items[index] = {
    ...items[index],
    ...(status ? { status } : {}),
    ...(note !== undefined ? { note: String(note) } : {}),
    ...(status === 'done' ? { done_at: new Date().toISOString() } : {}),
  };
  return store.update(BATCHES, id, { action_items: items });
}

// Applies a revision the drafter proposed to the rule it revises. The rule
// keeps its status: an active rule stays active, with the new wording.
async function applyRevision({ id, index }) {
  const batch = await getBatch(id);
  const revisions = [...(batch.proposed_revisions || [])];
  const rev = revisions[index];
  if (!rev) throw new FeedbackError('Proposed revision not found.', 404);
  if (rev.applied) throw new FeedbackError('That revision has already been applied.', 409);
  const existing = rev.ruleId ? await store.get(RULES, rev.ruleId) : await findRuleByKey(batch.client_id, rev.ruleKey);
  if (!existing) throw new FeedbackError(`The rule "${rev.ruleKey}" no longer exists.`, 404);
  const rule = await updateRule({ id: existing.id, rule: { ...rev.rule, key: existing.key, status: existing.status } });
  revisions[index] = { ...rev, applied: true, applied_at: new Date().toISOString() };
  const updated = await store.update(BATCHES, id, { proposed_revisions: revisions });
  return { rule, batch: updated };
}

// Runs a rule's text checks on sample text. Scope is deliberately ignored --
// the point is to see what the PATTERN catches -- except for sections: text
// tested as "the philosophy section" is checked by rules about that section.
function testRule({ rule, text, section, question, city, service, condition }) {
  const r = validated(rule || {}, {});
  const sec = section || r.scope.sections.find(s => fb.SECTIONS.includes(s)) || 'service';
  const doc = {
    pieces: [{ section: sec, field: sec.split('.')[0], text: String(text || '') }],
    faqs: question ? [{ q: String(question), a: String(text || '') }] : [],
  };
  const res = fb.runRuleChecks(r, doc, { city, service, condition }, { mode: 'field' });
  return {
    pass: res.pass,
    detail: res.pass ? 'Nothing in this text breaks the rule.' : res.detail,
    section: sec,
    reviewOnly: !r.checks.some(c => c.type === 'forbid' || c.type === 'require'),
  };
}

module.exports = {
  FeedbackError, vocabulary, listRules, createRule, updateRule, setRuleStatus,
  listBatches, createBatch, draftBatch, updateActionItem, applyRevision, testRule,
};
