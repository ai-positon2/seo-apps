#!/usr/bin/env node
// ── Seed Clear Behavioral Health's first two feedback batches as rules ──────
// The client's October 2026 page review and its program-scope note, written up
// as rules by hand in locationPageBuilder/cbhFeedbackSeed.js. Later batches
// come in through the Feedback Rules screen instead.
//
// Re-runnable. Batches are matched by `key` and rules by (client, `key`):
//   - a rule not yet stored is inserted ACTIVE, at version 1;
//   - a stored rule whose wording differs from the seed is updated, with its
//     version bumped and the old wording kept in history -- and it keeps
//     whatever status it has, so a rule someone retired stays retired;
//   - a stored rule that already matches is left alone.
// It never touches a generated page.
//
// Requires migration 0011_lpb_feedback.sql.
//
// Usage (from repo root, with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set):
//   node server/scripts/seedCbhFeedback.js

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { isSupabaseConfigured } = require('../services/supabase');
const store = require('../locationPageBuilder/store');
const fb = require('../locationPageBuilder/cbhFeedback');
const { CBH_CLIENT_ID, BATCHES, RULES } = require('../locationPageBuilder/cbhFeedbackSeed');

// The parts of a rule that change what it does. Bookkeeping is ignored.
function substance(rule) {
  const r = fb.normalizeRule(rule);
  return JSON.stringify([r.title, r.quote, r.kind, r.severity, r.scope, r.stages, r.instruction, r.checks]);
}

async function main() {
  if (!isSupabaseConfigured()) {
    console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Aborting.');
    process.exit(1);
  }

  const storedBatches = await store.list('feedbackBatches', { client_id: CBH_CLIENT_ID });
  const batchIds = {};
  for (const b of BATCHES) {
    const existing = storedBatches.find(x => x.key === b.key);
    const saved = existing
      ? await store.update('feedbackBatches', existing.id, {
        ...b,
        rule_keys: RULES.filter(r => r.batch_key === b.key).map(r => r.key),
        // Action items someone has since worked on are theirs, not the seed's.
        action_items: existing.action_items?.length ? existing.action_items : b.action_items,
        proposed_revisions: existing.proposed_revisions || [],
      })
      : await store.insert('feedbackBatches', {
        ...b,
        rule_keys: RULES.filter(r => r.batch_key === b.key).map(r => r.key),
        proposed_revisions: [],
      }, 'fbb');
    batchIds[b.key] = saved.id;
    console.log(`  batch  ${existing ? 'updated ' : 'inserted'} ${b.key}`);
  }

  const storedRules = await store.list('feedbackRules', { client_id: CBH_CLIENT_ID });
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  for (const rule of RULES) {
    const v = fb.validateRule(rule);
    if (!v.ok) throw new Error(`Seed rule "${rule.key}" is invalid: ${v.errors.join(' ')}`);
    const existing = storedRules.find(r => r.key === rule.key);
    if (!existing) {
      await store.insert('feedbackRules', {
        ...v.rule, client_id: CBH_CLIENT_ID, batch_id: batchIds[rule.batch_key], batch_key: rule.batch_key,
        status: 'active', version: 1, history: [],
      }, 'fbr');
      counts.inserted++;
      console.log(`  rule   inserted ${rule.key}`);
    } else if (substance(existing) !== substance(rule)) {
      const { history, id, created_at: _c, updated_at: _u, ...snapshot } = existing;
      await store.update('feedbackRules', existing.id, {
        ...v.rule, client_id: CBH_CLIENT_ID, batch_id: batchIds[rule.batch_key], batch_key: rule.batch_key,
        status: existing.status,
        version: (existing.version || 1) + 1,
        history: [...(history || []), { ...snapshot, replaced_at: new Date().toISOString() }].slice(-20),
      });
      counts.updated++;
      console.log(`  rule   updated  ${rule.key} (now v${(existing.version || 1) + 1}, status ${existing.status})`);
    } else {
      counts.unchanged++;
    }
  }
  console.log(`\nDone: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged.`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  if (/lpb_feedback/.test(e.message)) console.error('  Has supabase/migrations/0011_lpb_feedback.sql been applied?');
  process.exit(1);
});
