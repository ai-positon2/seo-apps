#!/usr/bin/env node
// ── Move the whole team into one workspace ──────────────────────────────────
//
//   node scripts/consolidateTeamWorkspace.js                     plan only (read-only)
//   node scripts/consolidateTeamWorkspace.js --apply             do it
//   node scripts/consolidateTeamWorkspace.js --apply --retire-duplicates [--keep <projectId>,...]
//
//   options:  --skip <workspaceId>,...   leave these workspaces where they are
//             --by <email>               who is running it, for the audit trail
//             --allow-busy               move workspaces with crawls/modules in flight
//
// Everyone with a Position2 email now joins one "Position2" workspace on sign-in
// (identityStore.ensureHomeWorkspace, migration 0039). This script moves what
// already exists into it:
//
//   1. makes sure the Position2 workspace exists and every Position2 user is a
//      member (platform administrators as owner, everyone else as approver —
//      people already in it keep their role);
//   2. for every other workspace whose members are ALL Position2 people —
//      everyone's personal workspace, and any team workspace made by hand —
//      moves its projects, crawls, runs and everything else carrying that
//      workspace id into Position2, ends its memberships, and marks it 'merged'
//      (the row stays, so the audit trail that names it still resolves);
//   3. lists clients that now exist more than once (same primary domain), with
//      a proposed keeper: the copy with the most crawl and module history.
//      With --retire-duplicates the other copies are soft-deleted — a status
//      change a project restore undoes, not a purge.
//
// A workspace with anyone outside Position2 in it is never touched; it is
// listed with the reason.
//
// Without --apply the session is set read-only before the first query, so a
// plan run cannot change anything. With --apply everything happens in ONE
// transaction: it all lands or none of it does.
//
// It runs against whatever DATABASE_URL the repo's .env names — which, on a
// developer laptop, is production. The first line printed is the host.

const path = require('path');

const PLATFORM_EMAIL = 'platform-embed@position2.com';
const TEAM_DOMAIN = 'position2.com';
const TEAM_NAME = 'Position2';
const TEAM_DEFAULT_ROLE = 'approver';
const ACTOR = 'script:consolidateTeamWorkspace';

// Every table with a workspace_id column must be in exactly one of these two
// lists. The script reads the live schema and refuses to run if a table is in
// neither: a new table carrying a workspace id would otherwise be silently left
// behind, pointing at a workspace nobody is a member of any more.
const MOVED_TABLES = [
  'crawl_projects', 'project_domains', 'crawl_runs',
  'project_module_runs', 'project_module_schedules', 'project_pages',
  'project_brands', 'recommendations',
  'ai_visibility_prompts', 'ai_visibility_captures',
  'aiv_lite_profiles', 'aiv_lite_prompts', 'aiv_lite_captures',
  'content_architect_projects',
  'tool_runs', 'activity_log',
];
const LEFT_IN_PLACE = {
  workspace_members: 'memberships of the old workspace are ended, not moved',
  workspace_member_events: "the old workspace's own membership history",
  audit_events: 'append-only: the trail records where things were',
};

const hostKey = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

// ── Reading ─────────────────────────────────────────────────────────────────

async function checkSchema(q) {
  const { rows } = await q(
    `select table_name from information_schema.columns
      where column_name = 'workspace_id' and table_schema = current_schema()`);
  const known = new Set([...MOVED_TABLES, ...Object.keys(LEFT_IN_PLACE)]);
  const unknown = rows.map((r) => r.table_name).filter((t) => !known.has(t));
  if (unknown.length) {
    throw new Error(
      `These tables carry a workspace_id this script does not know about: ${unknown.join(', ')}. `
      + 'Add each to MOVED_TABLES or LEFT_IN_PLACE before running it.');
  }
  const present = new Set(rows.map((r) => r.table_name));
  const col = await q(
    `select 1 from information_schema.columns
      where table_name = 'workspaces' and column_name = 'auto_join_domain' and table_schema = current_schema()`);
  if (!col.rows.length) throw new Error('Migration 0039 has not been applied (workspaces.auto_join_domain is missing).');
  return MOVED_TABLES.filter((t) => present.has(t));
}

/**
 * Works out what would happen. Reads only.
 *
 * @returns {Promise<object>} the plan: target, members to add, workspaces to
 *   merge (with row counts), workspaces left alone (with why), duplicate clients.
 */
async function buildPlan(q, { skip = [], keep = [] } = {}) {
  const tables = await checkSchema(q);

  const target = (await q(
    `select * from workspaces where auto_join_domain = $1 and lifecycle_status = 'active'`,
    [TEAM_DOMAIN])).rows[0] || null;

  const staff = (await q(
    `select id, email, created_at from app_users
      where lower(email) like $1 and lower(email) <> $2
      order by created_at`,
    [`%@${TEAM_DOMAIN}`, PLATFORM_EMAIL])).rows;
  const adminIds = new Set((await q(
    `select user_id from platform_admin_grants where status = 'active' and user_id is not null`)).rows
    .map((r) => r.user_id));

  const existing = target
    ? new Map((await q(`select user_id, role from workspace_members where workspace_id = $1`, [target.id]))
      .rows.map((r) => [r.user_id, r.role]))
    : new Map();
  const membersToAdd = staff
    .filter((u) => !existing.has(u.id))
    .map((u) => ({ userId: u.id, email: u.email, role: adminIds.has(u.id) ? 'owner' : TEAM_DEFAULT_ROLE }));

  const workspaces = (await q(
    `select w.id, w.name, w.is_personal, w.created_at, c.email as created_by_email,
            coalesce(json_agg(json_build_object('email', u.email, 'role', m.role))
                     filter (where u.id is not null), '[]') as members
       from workspaces w
       left join app_users c on c.id = w.created_by
       left join workspace_members m on m.workspace_id = w.id
       left join app_users u on u.id = m.user_id
      where w.lifecycle_status = 'active' and ($1::uuid is null or w.id <> $1::uuid)
      group by w.id, c.email
      order by w.created_at`,
    [target?.id || null])).rows;

  const merge = [];
  const leave = [];
  for (const w of workspaces) {
    const members = typeof w.members === 'string' ? JSON.parse(w.members) : w.members;
    const outsiders = members.map((m) => m.email).filter((e) => !String(e).toLowerCase().endsWith(`@${TEAM_DOMAIN}`));
    const view = { id: w.id, name: w.name, isPersonal: w.is_personal, createdBy: w.created_by_email, members };
    if (skip.includes(w.id)) leave.push({ ...view, why: 'skipped with --skip' });
    else if (String(w.created_by_email || '').toLowerCase() === PLATFORM_EMAIL) leave.push({ ...view, why: 'the platform-embed account’s own workspace' });
    else if (outsiders.length) leave.push({ ...view, why: `has members outside @${TEAM_DOMAIN}: ${outsiders.join(', ')}` });
    else if (!members.length && !String(w.created_by_email || '').toLowerCase().endsWith(`@${TEAM_DOMAIN}`)) {
      leave.push({ ...view, why: 'no members, and not created by a Position2 user' });
    } else merge.push(view);
  }

  for (const w of merge) {
    w.rows = {};
    for (const t of tables) {
      const n = Number((await q(`select count(*)::int as n from "${t}" where workspace_id = $1`, [w.id])).rows[0].n);
      if (n) w.rows[t] = n;
    }
    w.busy = (await q(
      `select 'crawl' as kind, id::text from crawl_runs where workspace_id = $1 and status in ('queued', 'running')
       union all
       select 'module', id::text from project_module_runs where workspace_id = $1 and status in ('queued', 'running')`,
      [w.id])).rows;
    w.workspaceLimits = Number((await q(
      `select count(*)::int as n from admin_limit_policies where scope = 'workspace' and scope_ref = $1`, [w.id])).rows[0].n);
    w.workspaceFlags = Number((await q(
      `select count(*)::int as n from feature_flag_assignments where scope = 'workspace' and scope_ref = $1`, [w.id])).rows[0].n);
  }

  // Every active client that will sit in the team workspace afterwards.
  const pool = [...(target ? [target.id] : []), ...merge.map((w) => w.id)];
  const projects = pool.length ? (await q(
    `select p.id, p.name, p.workspace_id, p.created_at, d.host,
            (select count(*)::int from crawl_runs r where r.project_id = p.id) as crawls,
            (select count(*)::int from project_module_runs r where r.project_id = p.id) as module_runs,
            greatest(p.created_at,
                     (select max(r.created_at) from crawl_runs r where r.project_id = p.id),
                     (select max(r.started_at) from project_module_runs r where r.project_id = p.id)) as last_activity
       from crawl_projects p
       left join project_domains d
         on d.project_id = p.id and d.role = 'primary' and d.status = 'active'
      where p.lifecycle_status = 'active' and p.workspace_id = any($1::uuid[])`,
    [pool])).rows : [];

  const byHost = new Map();
  for (const p of projects) {
    const key = hostKey(p.host);
    if (!key) continue;
    if (!byHost.has(key)) byHost.set(key, []);
    byHost.get(key).push(p);
  }
  const duplicates = [];
  for (const [host, list] of byHost) {
    if (list.length < 2) continue;
    // Most history wins; then the most recently used; then the oldest.
    const ranked = [...list].sort((a, b) =>
      (b.crawls + b.module_runs) - (a.crawls + a.module_runs)
      || new Date(b.last_activity) - new Date(a.last_activity)
      || new Date(a.created_at) - new Date(b.created_at));
    const chosen = list.find((p) => keep.includes(p.id)) || ranked[0];
    duplicates.push({
      host,
      keeper: chosen,
      keptBy: keep.includes(chosen.id) ? '--keep' : 'most history',
      retire: ranked.filter((p) => p.id !== chosen.id),
    });
  }

  return { target, staffCount: staff.length, adminIds: [...adminIds], membersToAdd, merge, leave, duplicates, tables };
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function audit(q, { workspaceId = null, projectId = null, action, entityType, entityId, reason = null, oldState = null, newState = null, by }) {
  await q(
    `insert into audit_events
       (workspace_id, project_id, actor_email, action, entity_type, entity_id, reason, old_state, new_state, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
    [workspaceId, projectId, by, action, entityType, entityId, reason,
      oldState ? JSON.stringify(oldState) : null, newState ? JSON.stringify(newState) : null, ACTOR]);
}

async function memberEvent(q, { workspaceId, subjectUserId, subjectEmail, action, oldRole, newRole, reason, by }) {
  await q(
    `insert into workspace_member_events
       (workspace_id, subject_user, subject_email, actor_email, action, old_role, new_role, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [workspaceId, subjectUserId, subjectEmail, by, action, oldRole, newRole, reason]);
}

/**
 * Carries out a plan from buildPlan. The caller owns the transaction.
 * Returns what was done, in the same shape the plan printed.
 */
async function applyPlan(q, plan, { retireDuplicates = false, allowBusy = false, by = ACTOR } = {}) {
  const busy = plan.merge.filter((w) => w.busy.length);
  if (busy.length && !allowBusy) {
    throw new Error(
      `Work is in flight in ${busy.map((w) => `"${w.name}"`).join(', ')} `
      + `(${busy.flatMap((w) => w.busy).map((b) => `${b.kind} ${b.id}`).join(', ')}). `
      + 'A job that is running keeps writing its results under the old workspace id. '
      + 'Wait for it to finish, or pass --allow-busy.');
  }

  // 1. The team workspace.
  let target = plan.target;
  if (!target) {
    const creatorId = plan.adminIds.find((id) => plan.membersToAdd.some((m) => m.userId === id))
      || plan.membersToAdd[0]?.userId;
    if (!creatorId) throw new Error(`There is no @${TEAM_DOMAIN} user to own the ${TEAM_NAME} workspace.`);
    target = (await q(
      `insert into workspaces (name, created_by, auto_join_domain) values ($1, $2, $3) returning *`,
      [TEAM_NAME, creatorId, TEAM_DOMAIN])).rows[0];
    await audit(q, {
      workspaceId: target.id, action: 'workspace.created', entityType: 'workspace', entityId: target.id,
      newState: { name: TEAM_NAME, autoJoinDomain: TEAM_DOMAIN }, by,
    });
  }

  for (const m of plan.membersToAdd) {
    const added = (await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
         on conflict (workspace_id, user_id) do nothing returning role`,
      [target.id, m.userId, m.role])).rows.length;
    if (!added) continue;
    await memberEvent(q, {
      workspaceId: target.id, subjectUserId: m.userId, subjectEmail: m.email,
      action: 'added', oldRole: null, newRole: m.role, reason: 'Team consolidation', by,
    });
  }

  // A workspace nobody can administer is a dead end. If the platform admins are
  // not in it yet as owners, the plan added them as owners above; this covers a
  // pre-existing workspace whose members were all added below owner.
  const owners = Number((await q(
    `select count(*)::int as n from workspace_members where workspace_id = $1 and role = 'owner'`,
    [target.id])).rows[0].n);
  if (!owners) {
    // Platform admins first; if none of them has ever signed in, whoever the
    // workspace row names as its creator.
    let promote = (await q(
      `update workspace_members set role = 'owner'
        where workspace_id = $1 and user_id = any($2::uuid[]) returning user_id`,
      [target.id, plan.adminIds])).rows;
    if (!promote.length) {
      promote = (await q(
        `update workspace_members set role = 'owner'
          where workspace_id = $1 and user_id = $2 returning user_id`,
        [target.id, target.created_by])).rows;
    }
    for (const r of promote) {
      await memberEvent(q, {
        workspaceId: target.id, subjectUserId: r.user_id, subjectEmail: null,
        action: 'role_changed', oldRole: null, newRole: 'owner', reason: 'Team consolidation: workspace had no owner', by,
      });
    }
  }

  // 2. Move each workspace's contents, then retire it.
  const moved = [];
  for (const w of plan.merge) {
    const counts = {};
    for (const t of plan.tables) {
      const res = await q(`update "${t}" set workspace_id = $1 where workspace_id = $2`, [target.id, w.id]);
      if (res.rowCount) counts[t] = res.rowCount;
    }
    // Content Architect keeps a copy of the id inside its record as well.
    await q(
      `update content_architect_projects
          set data = jsonb_set(data, '{workspaceId}', to_jsonb($1::text))
        where workspace_id = $1 and data ? 'workspaceId' and data->>'workspaceId' is distinct from $1::text`,
      [target.id]);

    const members = (await q(
      `delete from workspace_members where workspace_id = $1 returning user_id, role`, [w.id])).rows;
    for (const m of members) {
      await memberEvent(q, {
        workspaceId: w.id, subjectUserId: m.user_id, subjectEmail: null,
        action: 'removed', oldRole: m.role, newRole: null, reason: `Workspace merged into ${target.name}`, by,
      });
    }
    await q(
      `update workspaces
          set lifecycle_status = 'merged', merged_into = $1, merged_at = now(), is_personal = false
        where id = $2`,
      [target.id, w.id]);

    const state = { from: { id: w.id, name: w.name }, into: { id: target.id, name: target.name }, rows: counts };
    await audit(q, { workspaceId: w.id, action: 'workspace.merged', entityType: 'workspace', entityId: w.id, newState: state, by });
    await audit(q, { workspaceId: target.id, action: 'workspace.merged', entityType: 'workspace', entityId: w.id, newState: state, by });
    moved.push({ id: w.id, name: w.name, rows: counts });
  }

  // 3. Duplicate clients. Soft delete only — the same status change as the
  //    project screen's Delete, which Restore undoes.
  const retired = [];
  if (retireDuplicates) {
    for (const d of plan.duplicates) {
      for (const p of d.retire) {
        const reason = `Duplicate of "${d.keeper.name}" (${d.keeper.id}) after moving the team into one workspace`;
        const res = await q(
          `update crawl_projects
              set lifecycle_status = 'deleted', deleted_at = now(), deleted_by = null,
                  enabled = false, next_run_at = null
            where id = $1 and lifecycle_status = 'active'`,
          [p.id]);
        if (!res.rowCount) continue;
        await audit(q, {
          workspaceId: target.id, projectId: p.id, action: 'project.deleted', entityType: 'project', entityId: p.id,
          reason, oldState: { lifecycleStatus: 'active' }, newState: { lifecycleStatus: 'deleted', enabled: false }, by,
        });
        retired.push({ id: p.id, name: p.name, host: d.host, keeper: d.keeper.id });
      }
    }
  }

  return { target: { id: target.id, name: target.name }, moved, retired, membersAdded: plan.membersToAdd.length };
}

// ── Printing ────────────────────────────────────────────────────────────────

function printPlan(plan) {
  const out = [];
  out.push(`Team workspace: ${plan.target ? `"${plan.target.name}" (${plan.target.id})` : `none yet — "${TEAM_NAME}" will be created`}`);
  out.push(`Position2 users: ${plan.staffCount}; to add as members: ${plan.membersToAdd.length}`);
  for (const m of plan.membersToAdd) out.push(`  + ${m.email} as ${m.role}`);

  out.push('', `Workspaces to merge in: ${plan.merge.length}`);
  for (const w of plan.merge) {
    const rows = Object.entries(w.rows).map(([t, n]) => `${t} ${n}`).join(', ') || 'empty';
    out.push(`  → "${w.name}" (${w.id})${w.isPersonal ? ' [personal]' : ''} — ${w.members.map((m) => m.email).join(', ') || 'no members'}`);
    out.push(`      ${rows}`);
    if (w.busy.length) out.push(`      ! in flight: ${w.busy.map((b) => `${b.kind} ${b.id}`).join(', ')}`);
    if (w.workspaceLimits || w.workspaceFlags) {
      out.push(`      ! has ${w.workspaceLimits} workspace limit version(s) and ${w.workspaceFlags} flag(s); they stay on the old workspace — re-create in Admin if still wanted`);
    }
  }

  out.push('', `Workspaces left alone: ${plan.leave.length}`);
  for (const w of plan.leave) out.push(`  = "${w.name}" (${w.id}) — ${w.why}`);

  out.push('', `Clients that will exist more than once: ${plan.duplicates.length}`);
  for (const d of plan.duplicates) {
    const fmt = (p) => `"${p.name}" ${p.id} — ${p.crawls} crawls, ${p.module_runs} module runs, last used ${p.last_activity ? new Date(p.last_activity).toISOString().slice(0, 10) : '—'}`;
    out.push(`  ${d.host}`);
    out.push(`    keep    ${fmt(d.keeper)}  (${d.keptBy})`);
    for (const p of d.retire) out.push(`    retire  ${fmt(p)}`);
  }
  return out.join('\n');
}

// ── Command line ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const list = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  const one = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] || null : null; };
  return {
    apply: argv.includes('--apply'),
    retireDuplicates: argv.includes('--retire-duplicates'),
    allowBusy: argv.includes('--allow-busy'),
    skip: list('--skip'),
    keep: list('--keep'),
    by: one('--by'),
  };
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  const db = require('../services/db');
  const args = parseArgs(process.argv.slice(2));
  if (args.retireDuplicates && !args.apply) {
    console.error('--retire-duplicates only takes effect with --apply.');
    process.exit(2);
  }

  let host = '(unknown)';
  try { host = new URL(process.env.DATABASE_URL).host; } catch { /* printed as unknown */ }
  console.log(`Database: ${host}`);
  console.log(args.apply ? 'Mode: APPLY — changes will be written.\n' : 'Mode: plan only (read-only session).\n');

  const client = await db.getPool().connect();
  const q = (sql, params) => client.query(sql, params);
  try {
    await q('begin');
    if (!args.apply) await q('set transaction read only');
    const plan = await buildPlan(q, { skip: args.skip, keep: args.keep });
    console.log(printPlan(plan));

    if (!args.apply) {
      await q('rollback');
      console.log('\nNothing was changed. Re-run with --apply to carry this out'
        + (plan.duplicates.length ? ', and --retire-duplicates to soft-delete the "retire" rows.' : '.'));
      return;
    }

    const by = args.by ? `${ACTOR} (${args.by})` : ACTOR;
    const result = await applyPlan(q, plan, { retireDuplicates: args.retireDuplicates, allowBusy: args.allowBusy, by });
    await q('commit');
    console.log(`\nDone. Merged ${result.moved.length} workspace(s) into "${result.target.name}", `
      + `added ${result.membersAdded} member(s), retired ${result.retired.length} duplicate client(s).`);
    console.log('Restart the app (or wait 5 minutes) so cached workspace lookups pick this up.');
  } catch (e) {
    await q('rollback').catch(() => {});
    console.error(`\nStopped — nothing was changed.\n${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end().catch(() => {});
  }
}

module.exports = { buildPlan, applyPlan, printPlan, parseArgs, MOVED_TABLES, LEFT_IN_PLACE, TEAM_DOMAIN };

if (require.main === module) main();
