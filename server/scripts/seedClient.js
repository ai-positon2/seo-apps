#!/usr/bin/env node
// ── Seed a Location Page Builder client's reference data ────────────────────
// Writes the L1/L2 layers a client needs before any page can be generated:
// the client record, its global template, its services and its locations.
//
// This is ONBOARDING, not product surface — it runs once when a client is
// added (and again whenever its taxonomy changes), so it lives here rather
// than behind a button. The module's dashboards are for pages, not setup.
//
// Usage (from repo root, with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set):
//   node server/scripts/seedClient.js <client>
//   node server/scripts/seedClient.js --all
//   node server/scripts/seedClient.js --list
//
// Every seeder is scoped to its own client_id and is re-runnable: it replaces
// that client's services and locations and touches no other client's rows.
// Locations merge rather than overwrite — the NAP fields the SEO team fills in
// by hand survive a re-seed (see seed.mergeLocation).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { isSupabaseConfigured } = require('../services/supabase');
const seed = require('../locationPageBuilder/seed');

// Keyed by the name typed on the command line. `id` is only used for the
// summary line, so a seeder that changes its client id can't drift from this.
const CLIENTS = {
  'neuro': { id: seed.CLIENT_ID, label: 'Neuro Wellness Spa', run: seed.seedNeuroWellness },
  'gentle-dental': { id: seed.GD_CLIENT_ID, label: 'Gentle Dental of New England', run: seed.seedGentleDental },
  'clear-behavioral': { id: seed.CBH_CLIENT_ID, label: 'Clear Behavioral Health', run: seed.seedClearBehavioral },
};

const names = Object.keys(CLIENTS);
const arg = process.argv[2];

function usage(stream = console.error) {
  stream(`Usage: node server/scripts/seedClient.js <client>
       node server/scripts/seedClient.js --all
       node server/scripts/seedClient.js --list

Clients: ${names.join(', ')}`);
}

async function seedOne(name) {
  const { label, run } = CLIENTS[name];
  process.stdout.write(`  ${label}… `);
  const result = await run();
  // Every seeder returns { client_id, services, locations, ... }; the extra
  // keys (Gentle Dental's preserved-NAP count, Neuro's provider count) are
  // printed as-is rather than being special-cased here.
  const { client_id, ...counts } = result;
  console.log('ok');
  console.log(`    ${client_id}`);
  Object.entries(counts).forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${v}`));
  return result;
}

async function main() {
  if (!arg || arg === '--help' || arg === '-h') {
    usage(arg ? console.log : console.error);
    process.exit(arg ? 0 : 1);
  }
  if (arg === '--list') {
    names.forEach(n => console.log(`${n.padEnd(20)} ${CLIENTS[n].label}`));
    return;
  }
  if (!isSupabaseConfigured()) {
    console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Aborting.');
    process.exit(1);
  }

  const targets = arg === '--all' ? names : [arg];
  const unknown = targets.filter(n => !CLIENTS[n]);
  if (unknown.length) {
    console.error(`✗ Unknown client: ${unknown.join(', ')}`);
    usage();
    process.exit(1);
  }

  console.log(`Seeding reference data (${targets.length} client${targets.length === 1 ? '' : 's'}):`);
  // Sequential on purpose: these write to the same tables, and a readable
  // per-client log matters more here than shaving a second off onboarding.
  for (const name of targets) await seedOne(name);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
