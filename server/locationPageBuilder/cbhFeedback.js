// ── Client feedback rules for Clear Behavioral Health pages ─────────────────
// The client reviews pages and sends feedback: "CBH does not provide
// medication", "never ask about switching to telehealth", "stress pages open
// with this line". Each item becomes a RULE, stored in lpb_feedbackrules and
// managed from the Feedback Rules screen, so a new batch of feedback changes the
// pipeline without a code change.
//
// A rule does two jobs, and both read from the same record so they cannot drift
// apart:
//   1. its `instruction` is written into the brief planner, writer and
//      field-regen prompts for the stages it names;
//   2. its `checks` gate the finished page. `forbid` and `require` are regexes,
//      free and instant, run inside QC. `review` is a question for the LLM
//      reviewer (cbhFeedbackReview.js), for what no regex can see: "does the
//      stress page drift into anxiety?".
//
// Rule shape (see normalizeRule):
//   { key, status: draft|active|retired, title, quote (the client's words),
//     kind: constraint|fact, severity: Critical|Major|Minor,
//     scope: { services: ['*'] | [serviceId], programGroups: [], sections: [] },
//     stages: [brief|writer|regen], instruction,
//     checks: [{ type: forbid|require, pattern, flags, unit: field|sentence|faq,
//                when, sections, exceptSections, message }
//            | { type: review, question }] }
//
// Check semantics:
//   forbid          any unit matching `pattern` (and `when`, if given) is a hit
//   require + when  every unit matching `when` must also match `pattern`
//   require         at least one unit in scope must match `pattern`
//   unit 'faq'      `when` is tested on the question, `pattern` on the answer
// Patterns are case-insensitive by default and may use {city} {service}
// {condition} {brand}, which are regex-escaped before matching.
//
// Pages made before rules existed are never touched: QC only runs these on a
// page carrying the `feedback` marker that generateFromBrief stamps.

const crypto = require('crypto');
const contract = require('./cbhContract');
const cbhQc = require('./cbhQc');
const store = require('./store');

// ── Vocabulary ──────────────────────────────────────────────────────────────
// Where on the page a rule or check applies. The editor's dropdowns, the regen
// field map and the checks all use these keys. A prefix ("educational") covers
// every key under it.
const SECTIONS = [
  'meta.title', 'meta.description', 'hero.h1', 'hero.description',
  'approach.intro', 'approach.philosophy', 'approach.therapies',
  'insurance', 'educational.intro', 'educational.heading', 'educational.body',
  'uvp', 'service', 'treatment.heading', 'treatment.body',
  'faq.question', 'faq.answer',
];
const SECTION_GROUPS = ['meta', 'hero', 'approach', 'educational', 'treatment', 'faq'];

const SECTION_LABELS = {
  'meta.title': 'the meta title',
  'meta.description': 'the meta description',
  'hero.h1': 'the H1',
  'hero.description': 'the hero description',
  'approach.intro': 'the approach section',
  'approach.philosophy': 'the philosophy section',
  'approach.therapies': 'the clinical therapies section',
  insurance: 'the insurance section',
  'educational.intro': 'the educational intro',
  'educational.heading': 'an educational H3 heading',
  'educational.body': 'an educational H3 body',
  uvp: 'the Why Choose paragraph',
  service: 'the service paragraph',
  'treatment.heading': 'the treatment heading',
  'treatment.body': 'the treatment paragraph',
  'faq.question': 'an FAQ question',
  'faq.answer': 'an FAQ answer',
  meta: 'the meta tags', hero: 'the hero', approach: 'the approach section',
  educational: 'the educational section', treatment: 'the treatment section', faq: 'the FAQs',
};

const STAGES = ['brief', 'writer', 'regen'];
const SEVERITIES = ['Critical', 'Major', 'Minor'];
const STATUSES = ['draft', 'active', 'retired'];
const KINDS = ['constraint', 'fact'];
const CHECK_TYPES = ['forbid', 'require', 'review'];
const UNITS = ['field', 'sentence', 'faq'];

// The program a location runs, as seed.js groups services. The writer is told
// which one this page belongs to, and a rule can be scoped to one.
const PROGRAM_GROUPS = ['mh-residential', 'mh-outpatient', 'addiction-residential', 'addiction-outpatient', 'teen'];
const PROGRAM_LABELS = {
  'mh-residential': 'Residential mental health treatment',
  'mh-outpatient': 'Outpatient mental health treatment (PHP and IOP)',
  'addiction-residential': 'Residential addiction treatment and detox',
  'addiction-outpatient': 'Outpatient addiction treatment',
  teen: 'Teen mental health program (Teen IOP)',
};

// ── Small helpers ───────────────────────────────────────────────────────────
const arr = v => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]));
const strs = v => arr(v).map(x => String(x || '').trim()).filter(Boolean);
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function slugKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function sectionIn(section, list) {
  return (list || []).some(s => section === s || String(section).startsWith(`${s}.`));
}

function knownSection(s) {
  return SECTIONS.includes(s) || SECTION_GROUPS.includes(s);
}

function placeholderValues(ctx = {}) {
  return {
    city: ctx.city || '',
    service: ctx.service || '',
    condition: ctx.condition || ctx.service || '',
    brand: contract.BRAND,
  };
}

// Prose: a missing value reads as a generic phrase rather than a hole.
function fill(text, ctx = {}) {
  const v = placeholderValues(ctx);
  return String(text || '')
    .replace(/\{city\}/g, v.city || 'this location')
    .replace(/\{service\}/g, v.service || 'this service')
    .replace(/\{condition\}/g, v.condition || 'this condition')
    .replace(/\{brand\}/g, v.brand);
}

// Patterns: values are escaped, and a missing one can never match, so a rule
// about "{city}" stays silent rather than matching the empty string.
function compile(pattern, flags, ctx = {}) {
  const v = placeholderValues(ctx);
  const source = String(pattern || '').replace(/\{(city|service|condition|brand)\}/g,
    (_, k) => (v[k] ? escapeRe(v[k]) : '(?!)'));
  const f = String(flags == null ? 'i' : flags).replace(/[gy]/g, '');
  return new RegExp(source, f);
}

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function excerpt(text, re) {
  const s = String(text || '');
  const m = re ? re.exec(s) : null;
  if (!m) return s.length > 140 ? `${s.slice(0, 137)}...` : s;
  const start = Math.max(0, m.index - 50);
  const end = Math.min(s.length, m.index + m[0].length + 50);
  return `${start > 0 ? '...' : ''}${s.slice(start, end)}${end < s.length ? '...' : ''}`;
}

// ── Normalising and validating ──────────────────────────────────────────────
function normalizeCheck(c = {}) {
  const type = CHECK_TYPES.includes(c.type) ? c.type : 'forbid';
  if (type === 'review') return { type, question: String(c.question || '').trim() };
  const out = {
    type,
    pattern: String(c.pattern || ''),
    unit: UNITS.includes(c.unit) ? c.unit : 'field',
  };
  if (c.flags != null && c.flags !== '') out.flags = String(c.flags);
  if (c.when) out.when = String(c.when);
  if (strs(c.sections).length) out.sections = strs(c.sections);
  if (strs(c.exceptSections).length) out.exceptSections = strs(c.exceptSections);
  if (c.message) out.message = String(c.message).trim();
  return out;
}

// Store bookkeeping passes through; anything else a caller sends is dropped, so
// the editor and the drafter cannot smuggle fields into a stored rule.
const PASSTHROUGH = ['id', 'client_id', 'batch_id', 'batch_key', 'version', 'history', 'created_at', 'updated_at'];

function normalizeRule(raw = {}) {
  const scope = raw.scope || {};
  const services = strs(scope.services);
  const rule = {
    key: slugKey(raw.key || raw.title),
    status: STATUSES.includes(raw.status) ? raw.status : 'draft',
    title: String(raw.title || '').trim(),
    quote: String(raw.quote || '').trim(),
    kind: KINDS.includes(raw.kind) ? raw.kind : 'constraint',
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'Major',
    scope: {
      services: services.length ? services : ['*'],
      programGroups: strs(scope.programGroups),
      sections: strs(scope.sections),
    },
    stages: strs(raw.stages).filter(s => STAGES.includes(s)),
    instruction: String(raw.instruction || '').trim(),
    checks: arr(raw.checks).map(normalizeCheck),
  };
  if (!rule.stages.length) rule.stages = [...STAGES];
  PASSTHROUGH.forEach((k) => { if (raw[k] !== undefined) rule[k] = raw[k]; });
  return rule;
}

// `vocab.serviceIds` is optional: given, every scoped service must exist.
function validateRule(raw = {}, vocab = {}) {
  const rule = normalizeRule(raw);
  const errors = [];
  if (!rule.key) errors.push('A rule needs a key or a title.');
  if (!rule.title) errors.push('A rule needs a title.');
  if (!rule.instruction) errors.push('A rule needs an instruction for the writer.');
  if (raw.severity && !SEVERITIES.includes(raw.severity)) errors.push(`Unknown severity "${raw.severity}".`);
  rule.scope.sections.filter(s => !knownSection(s)).forEach(s => errors.push(`Unknown section "${s}".`));
  rule.scope.programGroups.filter(g => !PROGRAM_GROUPS.includes(g)).forEach(g => errors.push(`Unknown program group "${g}".`));
  if (vocab.serviceIds) {
    rule.scope.services.filter(s => s !== '*' && !vocab.serviceIds.includes(s))
      .forEach(s => errors.push(`Unknown service "${s}".`));
  }
  const probe = { city: 'Anaheim Hills', service: 'anxiety treatment', condition: 'Anxiety' };
  arr(raw.checks).forEach((c, i) => {
    const n = `Check ${i + 1}`;
    if (!CHECK_TYPES.includes(c && c.type)) { errors.push(`${n}: unknown type "${c && c.type}".`); return; }
    if (c.type === 'review') {
      if (!String(c.question || '').trim()) errors.push(`${n}: a review check needs a question.`);
      return;
    }
    if (!String(c.pattern || '').trim()) errors.push(`${n}: a ${c.type} check needs a pattern.`);
    if (c.unit && !UNITS.includes(c.unit)) errors.push(`${n}: unknown unit "${c.unit}".`);
    [['pattern', c.pattern], ['when', c.when]].forEach(([label, p]) => {
      if (!p) return;
      try { compile(p, c.flags, probe); } catch (e) { errors.push(`${n}: the ${label} is not a valid regex (${e.message}).`); }
    });
    [...strs(c.sections), ...strs(c.exceptSections)].filter(s => !knownSection(s))
      .forEach(s => errors.push(`${n}: unknown section "${s}".`));
  });
  return { ok: !errors.length, errors, rule };
}

// ── Scope ───────────────────────────────────────────────────────────────────
// `section` narrows to rules that can apply to that part of the page: a rule
// with no section scope applies everywhere.
function rulesFor(rules, { serviceId, programGroups, stage, section } = {}) {
  return arr(rules).filter((r) => {
    const s = r.scope || {};
    const svcs = arr(s.services);
    if (svcs.length && !svcs.includes('*') && !svcs.includes(serviceId)) return false;
    const groups = arr(s.programGroups);
    if (groups.length && !groups.some(g => arr(programGroups).includes(g))) return false;
    if (stage && !arr(r.stages || STAGES).includes(stage)) return false;
    if (section && arr(s.sections).length && !sectionIn(section, s.sections)) return false;
    return true;
  });
}

const hasReview = r => arr(r.checks).some(c => c.type === 'review');
const hasTextChecks = r => arr(r.checks).some(c => c.type === 'forbid' || c.type === 'require');

// Identifies a rule set. Order-independent, and it moves when any rule is
// edited (version) or added/removed (key), which is what makes a stored review
// recognisably out of date.
function rulesVersion(rules) {
  const keys = arr(rules).map(r => `${r.key}@${r.version || 1}`).sort();
  if (!keys.length) return 'none';
  return crypto.createHash('sha1').update(keys.join('|')).digest('hex').slice(0, 10);
}

// ── Prompt block ────────────────────────────────────────────────────────────
function promptBlock(rules, ctx = {}) {
  const applicable = rulesFor(rules, ctx);
  if (!applicable.length) return '';
  const lines = applicable.map((r) => {
    const where = arr(r.scope && r.scope.sections).map(s => SECTION_LABELS[s] || s);
    const prefix = where.length ? `[${where.join(', ')}] ` : '';
    return `- ${prefix}${contract.removeEmDashes(fill(r.instruction, ctx))}`;
  });
  return `CLIENT FEEDBACK RULES
These come from ${contract.BRAND}'s own review of earlier pages. They state what the client does and does not
offer and how it wants things said, and they OVERRIDE any instruction above where the two conflict.
${lines.join('\n')}
`;
}

// ── Running the text checks ─────────────────────────────────────────────────
// A "doc" is what the checks read: labelled pieces of prose, plus the FAQ pairs
// for the checks that relate a question to its answer.
function pageContext(page = {}) {
  return {
    serviceId: page.meta && page.meta.service_id,
    programGroups: arr(page.meta && page.meta.programGroups),
    city: page.locationName || '',
    service: page.serviceName || '',
    condition: page.conditionName || page.serviceName || '',
  };
}

function pageDoc(page) {
  const ctx = cbhQc.context(page);
  return {
    pieces: cbhQc.prosePieces(ctx).map(p => ({ section: p.section, field: p.field, text: String(p.text || '') })),
    faqs: ctx.faqs.map(f => ({ q: String(f.q || ''), a: String(f.a || '') })),
  };
}

function scopedPieces(rule, check, doc) {
  const sections = arr(check.sections).length ? check.sections : arr(rule.scope && rule.scope.sections);
  return doc.pieces.filter(p => (!sections.length || sectionIn(p.section, sections))
    && !sectionIn(p.section, check.exceptSections));
}

// mode 'page'  : a whole page.
// mode 'brief' : headings and planned questions only, so an unconditional
//                `require` and the FAQ-answer checks have nothing to read.
// mode 'field' : one regenerated field.
function runCheck(rule, check, doc, ctx, mode) {
  const hits = [];
  const re = compile(check.pattern, check.flags, ctx);
  const whenRe = check.when ? compile(check.when, check.flags, ctx) : null;

  if (check.unit === 'faq') {
    if (mode === 'brief') return hits;
    arr(doc.faqs).forEach((f) => {
      if (whenRe && !whenRe.test(f.q)) return;
      if (check.type === 'forbid' && re.test(f.a)) {
        hits.push({ section: 'faq.answer', field: 'faq', snippet: excerpt(f.a, re) });
      }
      if (check.type === 'require' && !re.test(f.a)) {
        hits.push({ section: 'faq.answer', field: 'faq', where: `the answer to "${f.q}"` });
      }
    });
    return hits;
  }

  const scoped = scopedPieces(rule, check, doc);
  const units = check.unit === 'sentence'
    ? scoped.flatMap(p => sentences(p.text).map(t => ({ ...p, text: t })))
    : scoped;

  if (check.type === 'forbid') {
    units.forEach((u) => {
      if (whenRe && !whenRe.test(u.text)) return;
      if (re.test(u.text)) hits.push({ section: u.section, field: u.field, snippet: excerpt(u.text, re) });
    });
  } else if (whenRe) {
    units.forEach((u) => {
      if (whenRe.test(u.text) && !re.test(u.text)) {
        hits.push({ section: u.section, field: u.field, snippet: excerpt(u.text, whenRe) });
      }
    });
  } else if (mode !== 'brief' && units.length && !units.some(u => re.test(u.text))) {
    // Nothing in scope at all is not a failure: there is nothing to check.
    hits.push({ section: units[0].section, field: units[0].field, snippet: excerpt(units[0].text, null) });
  }
  return hits;
}

function describeHits(check, hits, ctx) {
  const shown = hits.slice(0, 3).map(h => (h.where
    ? `in ${h.where}`
    : `in ${SECTION_LABELS[h.section] || h.section}: "${h.snippet}"`));
  const more = hits.length > 3 ? ` (and ${hits.length - 3} more)` : '';
  const what = fill(check.message || (check.type === 'forbid' ? 'Uses wording the client ruled out' : 'Missing what the client asked for'), ctx);
  return `${what}, ${shown.join('; ')}${more}`;
}

function runRuleChecks(rule, doc, ctx = {}, { mode = 'page' } = {}) {
  const r = rule.scope ? rule : normalizeRule(rule);
  const failures = [];
  arr(r.checks).filter(c => c.type === 'forbid' || c.type === 'require').forEach((check) => {
    const hits = runCheck(r, check, doc, ctx, mode);
    if (hits.length) failures.push({ check, hits, detail: describeHits(check, hits, ctx) });
  });
  return {
    pass: !failures.length,
    hits: failures.flatMap(f => f.hits),
    detail: failures.map(f => f.detail).join(' | '),
  };
}

// ── QC checks ───────────────────────────────────────────────────────────────
// QC-shaped results, so the wizard's banner and the exports render them like
// any other gate. One check per rule for its text checks (fb_<key>) and one
// for its review (fb_<key>_review).
function deterministicChecks(page, rules) {
  const ctx = pageContext(page);
  const doc = pageDoc(page);
  return rulesFor(rules, ctx).filter(hasTextChecks).map((rule) => {
    const res = runRuleChecks(rule, doc, ctx);
    return {
      id: `fb_${rule.key}`,
      name: `Client feedback: ${rule.title}`,
      severity: rule.severity,
      field: (res.hits[0] && res.hits[0].field) || 'page',
      pass: res.pass,
      detail: res.pass ? 'Complies.' : res.detail,
      group: 'feedback',
      ruleKey: rule.key,
    };
  });
}

function reviewRulesFor(page, rules) {
  return rulesFor(rules, pageContext(page)).filter(hasReview);
}

// Over the body prose the reviewer reads. The meta is excluded (the reviewer
// never sees it, and the brief's meta replaces the writer's after the review),
// and casing is folded, because headings are re-cased after generation.
function reviewContentHash(page) {
  const body = pageDoc(page).pieces
    .filter(p => !String(p.section).startsWith('meta.'))
    .map(p => `${p.section}:${String(p.text).toLowerCase().replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
}

// A review in which every applicable rule complies. For tests, and for a page
// whose applicable rules have no review questions.
function emptyReview(page, rules) {
  const reviewRules = reviewRulesFor(page, rules);
  return {
    rulesVersion: rulesVersion(reviewRules),
    contentHash: reviewContentHash(page),
    reviewedAt: new Date().toISOString(),
    model: 'none',
    results: reviewRules.map(r => ({ ruleKey: r.key, compliant: true, verified: true, section: '', evidence: '', fix: '' })),
  };
}

function reviewChecks(page, rules) {
  const reviewRules = reviewRulesFor(page, rules);
  if (!reviewRules.length) return [];
  const base = { group: 'feedback', field: 'page', severity: 'Minor', pass: false };
  const rev = page.feedbackReview;
  if (!rev) {
    return [{
      ...base, id: 'fb_review_missing', name: 'Client feedback: AI review',
      detail: 'The AI review against the client feedback rules has not run on this page. Use "Re-check client feedback".',
    }];
  }
  const rulesMoved = rev.rulesVersion !== rulesVersion(reviewRules);
  const contentMoved = rev.contentHash !== reviewContentHash(page);
  if (rulesMoved || contentMoved) {
    const why = [contentMoved && 'the content was edited', rulesMoved && 'the feedback rules changed']
      .filter(Boolean).join(' and ');
    return [{
      ...base, id: 'fb_review_stale', name: 'Client feedback: AI review',
      detail: `The AI review is out of date: ${why} after it ran. Use "Re-check client feedback".`,
    }];
  }
  return reviewRules.map((rule) => {
    const res = arr(rev.results).find(x => x.ruleKey === rule.key);
    const id = `fb_${rule.key}_review`;
    const name = `Client feedback (AI review): ${rule.title}`;
    if (!res) {
      return { ...base, id, name, ruleKey: rule.key, unverified: true, detail: 'The reviewer returned no verdict for this rule. Needs a human look.' };
    }
    if (res.compliant) {
      return { id, name, severity: rule.severity, field: 'page', pass: true, detail: 'AI review: complies.', group: 'feedback', ruleKey: rule.key };
    }
    const where = SECTION_LABELS[res.section] || res.section || 'the page';
    const quote = res.evidence ? ` "${res.evidence}"` : '';
    const fix = res.fix ? ` ${res.fix}` : '';
    return {
      id, name, field: res.field || 'page', pass: false, group: 'feedback', ruleKey: rule.key,
      // A finding the reviewer could not quote from the page is not trusted at
      // the rule's severity: it may be a hallucination. A person decides.
      severity: res.verified ? rule.severity : 'Minor',
      unverified: !res.verified,
      detail: `AI review${res.verified ? '' : ' (its quote was not found on the page, so it needs a human look)'}: `
        + `${where}${quote}.${fix}`,
    };
  });
}

function qcChecks(page, rules) {
  return [...deterministicChecks(page, rules), ...reviewChecks(page, rules)];
}

// ── Brief warnings ──────────────────────────────────────────────────────────
// The planned FAQ questions are answered verbatim by the writer, so a question
// the client ruled out ("can I switch to telehealth?") has to be caught HERE,
// while it is still an editable line in the brief.
function briefDoc(brief = {}) {
  const pieces = [];
  arr(brief.educational && brief.educational.h3s).forEach((h) => {
    if (h.heading) pieces.push({ section: 'educational.heading', field: 'educational', text: String(h.heading) });
    if (h.intent) pieces.push({ section: 'educational.heading', field: 'educational', text: String(h.intent) });
  });
  arr(brief.faqs).forEach((f) => {
    if (f.q) pieces.push({ section: 'faq.question', field: 'faq', text: String(f.q) });
  });
  return { pieces, faqs: [] };
}

function briefFeedbackWarnings(brief, rules, ctx = {}) {
  const doc = briefDoc(brief);
  return rulesFor(rules, ctx).filter(hasTextChecks).map((rule) => {
    const res = runRuleChecks(rule, doc, ctx, { mode: 'brief' });
    return res.pass ? null : { ruleKey: rule.key, title: rule.title, severity: rule.severity, detail: res.detail };
  }).filter(Boolean);
}

// One regenerated field: `texts` is the new value (a string or a list) and the
// section it sits in. FAQ answers bring their question so the FAQ checks run.
function fieldHits(rules, { section, texts, question }, ctx = {}) {
  const pieces = arr(texts).map(t => ({ section, field: section.split('.')[0], text: String(t || '') }));
  const faqs = section === 'faq.answer' && question ? arr(texts).map(a => ({ q: String(question), a: String(a) })) : [];
  const doc = { pieces, faqs };
  return rulesFor(rules, { ...ctx, section }).filter(hasTextChecks).map((rule) => {
    const res = runRuleChecks(rule, doc, ctx, { mode: 'field' });
    return res.pass ? null : { ruleKey: rule.key, title: rule.title, severity: rule.severity, detail: res.detail };
  }).filter(Boolean);
}

// ── Loading ─────────────────────────────────────────────────────────────────
// Every brief, generation and regen reads the active rules, so they are cached
// briefly in-process; every write through this module clears the cache.
const CACHE_MS = 30 * 1000;
const cache = new Map();
let warnedMissingTable = false;

async function loadRules(clientId) {
  const rows = await store.list('feedbackRules', { client_id: clientId });
  return rows.map(normalizeRule);
}

async function loadActiveRules(clientId) {
  if (!clientId) return [];
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
  try {
    const rules = (await loadRules(clientId)).filter(r => r.status === 'active');
    cache.set(clientId, { at: Date.now(), rules });
    return rules;
  } catch (e) {
    // Most likely migration 0011 has not been applied. Generation must still
    // work, so this degrades to "no rules" and says so once, loudly.
    if (!warnedMissingTable) {
      console.error('[cbhFeedback] could not load feedback rules; pages will be built WITHOUT them:', e.message);
      warnedMissingTable = true;
    }
    return [];
  }
}

function invalidateRules(clientId) {
  if (clientId) cache.delete(clientId); else cache.clear();
}

module.exports = {
  SECTIONS, SECTION_GROUPS, SECTION_LABELS, STAGES, SEVERITIES, STATUSES, KINDS, CHECK_TYPES, UNITS,
  PROGRAM_GROUPS, PROGRAM_LABELS,
  normalizeRule, normalizeCheck, validateRule, rulesFor, rulesVersion, promptBlock, fill, compile,
  pageContext, pageDoc, runRuleChecks, deterministicChecks, reviewRulesFor, reviewContentHash,
  emptyReview, reviewChecks, qcChecks, briefFeedbackWarnings, fieldHits, sectionIn,
  loadRules, loadActiveRules, invalidateRules,
};
