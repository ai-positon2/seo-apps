// ── Project aggregate store (PRD §8.1, §8.2, §17.2, §24.3) ──────────────────
// The product's Project, backed by the physical tables that already exist:
//
//   crawl_projects   the project row. Retained as the physical table for
//                    backward compatibility (§30.6); `url` is kept as a
//                    compatibility projection of the primary domain (§8.1) so
//                    the CrawlScope worker, scheduler and UI keep working
//                    untouched while new code reads project_domains.
//   project_domains  the authoritative primary + competitor domains (§30.6).
//
// Authorization is NOT done here. Every function takes an already-resolved
// access context from services/projectAccess.js, which is what makes the
// workspace boundary un-forgettable: there is no code path into this store that
// hasn't been through it.

const db = require('../../services/db');
const auditEvents = require('../../services/auditEvents');
const adminLimits = require('../../services/adminLimits');
const domainsLib = require('./domains');
const cron = require('../crawlScope/shared/cron');
const { staggerMinute } = require('../crawlScope/shared/schedule');

// Weekly is the initial recurring schedule (PRD §3.1.3). A new project gets a
// Sunday-night slot in the configured default zone, staggered across the hour so
// twenty projects don't all fire on :00 (see staggerMinute).
// How many pages one on-page run may audit. Each page is a fetch plus a
// PageSpeed call — measured at roughly 20-40 seconds — so this is a wall-clock
// bound, not a storage one. Anything beyond it is reported as skipped rather
// than silently dropped.
const MAX_TARGET_PAGES = 10;

const DEFAULT_SCHEDULE_DAY = 0;    // Sunday
const DEFAULT_SCHEDULE_HOUR = 22;  // 10 PM local

function fail(op, error) {
  throw new Error(`[projects.${op}] ${error.message || error}`);
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_input' });
}

function notConfigured() {
  return Object.assign(
    new Error('Projects need the database configured (DATABASE_URL).'),
    { status: 503, code: 'not_configured' },
  );
}

// ── Views ───────────────────────────────────────────────────────────────────

function domainView(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    origin: row.normalized_origin,
    host: row.host,
    scheme: row.scheme,
    raw: row.raw_input,
    source: row.source,
    status: row.status,
    scoreRefreshedAt: row.score_refreshed_at,
    createdAt: row.created_at,
  };
}

/**
 * The shape the client reads. `primaryDomain` comes from project_domains where
 * one exists and falls back to the legacy `url` column only for a row the
 * backfill couldn't parse — labelled so the UI can say so rather than showing a
 * confidently wrong domain (§24.2: no invented evidence).
 */
function projectView(project, domains = []) {
  const primary = domains.find((d) => d.role === 'primary' && d.status === 'active');
  const competitors = domains.filter((d) => d.role === 'competitor' && d.status === 'active');
  // Competitors a contributor has proposed but nobody has accepted yet (§7.2).
  // Empty unless the caller fetched with ACTIVE_AND_PROPOSED — which the project
  // read paths do, and the runners deliberately do not: a proposal is not
  // tracked, and nothing should measure against it until it is accepted.
  const proposedCompetitors = domains.filter((d) => d.role === 'competitor' && d.status === 'proposed');
  const weekly = cron.parseWeeklyCron(project.cron);

  return {
    id: project.id,
    name: project.name || (primary ? primary.host : project.url),
    workspaceId: project.workspace_id,
    // Creator attribution (§7.4) — authorization is the workspace, never this.
    // It is exposed because CrawlScope's run endpoints are still creator-scoped,
    // so the dashboard needs to say who can launch a crawl rather than offering
    // a button that 404s for a teammate.
    createdBy: project.owner || null,
    countryCode: project.country_code || null,
    countryMissing: !project.country_code,
    lifecycleStatus: project.lifecycle_status || 'active',
    primaryDomain: primary ? domainView(primary) : null,
    primaryDomainSource: primary ? 'project_domains' : 'legacy_url_column',
    legacyUrl: project.url,
    competitors: competitors.map(domainView),
    proposedCompetitors: proposedCompetitors.map(domainView),
    schedule: {
      cron: project.cron,
      timezone: project.timezone,
      weekly,                                   // null for a non-weekly expression
      enabled: Boolean(project.enabled),
      lastRunAt: project.last_run_at,
      nextRunAt: project.next_run_at,
    },
    recipients: project.recipients || [],
    crawlOptions: project.options || {},
    siteVerifiedAt: project.site_verified_at,
    robotsOverride: Boolean(project.robots_override),
    settings: project.settings || {},
    // Set at creation (Project Setup's "Find competitors for me" toggle). Read
    // by moduleRunners.runCompetitor: when true and no competitor is tracked
    // yet, that run discovers and self-confirms candidates instead of reporting
    // insufficient_data. Left alone once any competitor exists — see there.
    autoFindCompetitors: Boolean(project.settings?.autoFindCompetitors),
    // The pages this project targets, each with its OWN keywords. Keywords are
    // per page, not per site: the implants page targets a different term from
    // the pricing page. Kept in settings rather than a table of its own — it is
    // configuration, and 0011 already provides the jsonb bag.
    //
    // A page with no keywords is still audited; the checks about keyword
    // placement stand down for it (see onPageAudit/auditor.js).
    pages: Array.isArray(project.settings?.pageKeywords) ? project.settings.pageKeywords : [],
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

// Read active rows unless asked otherwise.
//
// 'active' being the default is what keeps every existing caller — the module
// runners, the autostart scheduler, the report — measuring only domains that are
// really tracked. But it was also hardcoded into the SQL, which made a
// 'proposed' row unreadable by anything: a contributor's competitor was written
// and then returned by nothing, ever. Callers that need to SEE a proposal ask
// for it; callers that ACT on domains keep the default.
const ACTIVE_ONLY = ['active'];
const ACTIVE_AND_PROPOSED = ['active', 'proposed'];

async function domainsForProjects(projectIds, { statuses = ACTIVE_ONLY } = {}) {
  if (!projectIds.length) return new Map();
  let data;
  try {
    data = await db.rows(
      `select * from project_domains
        where project_id = any($1) and status = any($2)
        order by created_at asc`,
      [projectIds, statuses]
    );
  } catch (error) {
    fail('domainsForProjects', error);
  }

  const byProject = new Map();
  for (const row of data) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push(row);
  }
  return byProject;
}

/**
 * Every domain row for one project, in DB shape. Active only by default.
 *
 * projectView() splits domains into primaryDomain/competitors and renames the
 * columns for the client. Callers that work on the rows themselves — the module
 * runners, which need normalized_origin and role — get them unmapped from here
 * rather than reassembling them from the view.
 *
 * @param {string[]} [opts.statuses] pass ACTIVE_AND_PROPOSED to include proposals
 */
async function listDomains(projectId, { statuses = ACTIVE_ONLY } = {}) {
  if (!projectId) return [];
  const byProject = await domainsForProjects([projectId], { statuses });
  return byProject.get(projectId) || [];
}

/**
 * Projects the caller can see: every workspace they belong to, newest first.
 *
 * The workspace filter is applied in the query (`in`), not after the fetch —
 * a post-fetch filter is one a future refactor can drop without any test
 * noticing (PRD §22.3).
 */
async function listProjects({ workspaceIds, workspaceId = null, includeDeleted = false, limit = 100 }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const scope = workspaceId ? [workspaceId] : (workspaceIds || []);
  if (!scope.length) return [];

  // The workspace filter is part of the query, never applied after the fetch.
  let projects;
  try {
    projects = await db.rows(
      `select * from crawl_projects
        where workspace_id = any($1)
          ${includeDeleted ? '' : `and lifecycle_status <> 'deleted'`}
        order by created_at desc
        limit $2`,
      [scope, Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)]
    );
  } catch (error) {
    fail('listProjects', error);
  }
  // Proposals included: the projects list is where an approver notices there is
  // something to approve, and a pending item nobody can see is the whole defect
  // this fixes.
  const byProject = await domainsForProjects(projects.map((p) => p.id), { statuses: ACTIVE_AND_PROPOSED });
  return projects.map((p) => projectView(p, byProject.get(p.id) || []));
}

/**
 * The project in this workspace already tracking an origin, or null.
 *
 * PRD §18.2 wants a duplicate primary domain to WARN and ask for confirmation
 * rather than be rejected, so creation needs to know. That check used to fetch
 * the workspace's projects with listProjects() and scan them in JavaScript —
 * which carried listProjects' default `limit: 100`, so in a workspace with more
 * than a hundred projects the warning silently stopped appearing. A bug that
 * only shows up once a workspace gets big, as a missing warning rather than an
 * error, is one nobody reports.
 *
 * Asking the database the actual question has no limit to get wrong, and uses
 * the (project_id, normalized_origin) index instead of reading every project's
 * settings blob to compare one field.
 */
async function projectTrackingOrigin({ workspaceId, normalizedOrigin, excludeProjectId = null }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  if (!workspaceId || !normalizedOrigin) return null;

  const params = [workspaceId, normalizedOrigin];
  let exclude = '';
  if (excludeProjectId) {
    params.push(excludeProjectId);
    exclude = ` and p.id <> $${params.length}`;
  }

  try {
    return await db.maybeOne(
      `select p.id, p.name, p.url
         from project_domains d
         join crawl_projects p on p.id = d.project_id
        where p.workspace_id = $1
          and d.normalized_origin = $2
          and d.role = 'primary'
          and d.status = 'active'
          and p.lifecycle_status <> 'deleted'${exclude}
        limit 1`,
      params
    );
  } catch (error) {
    fail('projectTrackingOrigin', error);
  }
}

/** Best-effort host from the legacy url column. Null, never a guess. */
function hostFromUrl(url) {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

/**
 * What each workspace CONTAINS, as a lean summary, keyed by workspace id.
 *
 * The workspaces screen could not answer "what is in this workspace" because
 * nothing served it: the API returned a workspace's members and nothing else, so
 * the one relationship that screen exists to show — a workspace holds projects —
 * was invisible on it.
 *
 * Deliberately not projectView(): rendering a name and a count does not need
 * every project's settings blob, schedule, recipients and competitor list. Two
 * queries, both already indexed.
 *
 * A workspace with no projects comes back with an empty array rather than
 * missing from the map. "None" is an answer, and a caller should not have to
 * tell it apart from "not asked".
 */
async function summariesForWorkspaces(workspaceIds) {
  const scope = [...new Set((workspaceIds || []).filter(Boolean))];
  const byWorkspace = new Map(scope.map((id) => [id, []]));
  if (!scope.length) return byWorkspace;

  let rows;
  try {
    rows = await db.rows(
      `select id, name, url, workspace_id, lifecycle_status, created_at
         from crawl_projects
        where workspace_id = any($1) and lifecycle_status <> 'deleted'
        order by created_at desc`,
      [scope]
    );
  } catch (error) {
    fail('summariesForWorkspaces', error);
  }
  const domains = await domainsForProjects(rows.map((r) => r.id));

  for (const row of rows) {
    const primary = (domains.get(row.id) || []).find((d) => d.role === 'primary');
    if (!byWorkspace.has(row.workspace_id)) byWorkspace.set(row.workspace_id, []);
    byWorkspace.get(row.workspace_id).push({
      id: row.id,
      name: row.name || primary?.host || row.url,
      // Shown under the name. Null rather than invented when the project predates
      // project_domains and its legacy url will not parse (§24.2).
      host: primary?.host || hostFromUrl(row.url),
      lifecycleStatus: row.lifecycle_status || 'active',
      createdAt: row.created_at,
    });
  }
  return byWorkspace;
}

/**
 * One project plus its domains. The caller has already been authorized.
 *
 * Fetches proposals alongside the active rows — one query, not two — so the
 * screen showing a project can also show what is waiting on an approver.
 */
async function getProject(projectRow) {
  const byProject = await domainsForProjects([projectRow.id], { statuses: ACTIVE_AND_PROPOSED });
  return projectView(projectRow, byProject.get(projectRow.id) || []);
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creates a project. PRD §18.2 + AC-004: primary domain and country are both
 * required, and the country is normalized to ISO alpha-2.
 *
 * The project row and its domain rows go in together. This used to be two
 * independent writes with the order chosen to fail safe, because Supabase's
 * REST interface had no multi-statement transaction: a crash between them left
 * a project whose primaryDomainSource read 'legacy_url_column', which the UI
 * showed as needing a domain rather than as broken. Speaking SQL directly there
 * is no need to pick the least-bad partial state — either the project exists
 * with its domains or it does not exist at all.
 *
 * This is the ONLY function permitted to insert a crawl_projects row. CrawlScope
 * used to have its own (repo.createProject), which wrote the project and nothing
 * else — no primary domain, no country — so every project it made read as
 * 'legacy_url_column' forever. Both endpoints come through here now, and
 * migration 0027 enforces the invariant in the database so a third writer cannot
 * quietly reappear:
 *
 *   no crawl_projects row without an active primary project_domains row
 *
 * @param {boolean} [requireCountry=true] AC-004 makes country mandatory on
 *   /api/projects. CrawlScope's endpoint predates that rule and has callers that
 *   send no country; refusing them with a 400 would break working integrations.
 *   Passing false leaves country_code NULL, which surfaces as countryMissing in
 *   projectView and is repaired in project settings. Never defaulted to a guess
 *   — an invented market is worse than an absent one (§24.2).
 */
async function createProject({ access, name, primaryDomain, country, competitors = [], schedule = {}, recipients = [], crawlOptions = {}, autoFindCompetitors = false, requireCountry = true }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const primary = domainsLib.normalizeOrigin(primaryDomain);
  // A country that IS supplied is always validated, even when not required —
  // "XG" should fail loudly rather than be stored and later hand the rank
  // provider a market that does not exist.
  const countryCode = (!requireCountry && (country == null || String(country).trim() === ''))
    ? null
    : domainsLib.normalizeCountry(country);
  const competitorDomains = domainsLib.normalizeCompetitors(competitors, {
    primaryOrigin: primary.normalizedOrigin,
  });

  const projectName = String(name || '').trim() || primary.host;

  // Schedule: weekly by default, and never more frequent than the effective
  // limit allows (§10.2). A caller asking for a custom cron has it validated,
  // because an unparseable expression creates a project that never fires.
  const timezone = schedule.timezone && cron.isValidTimezone(schedule.timezone)
    ? schedule.timezone
    : cron.DEFAULT_TIMEZONE;

  let cronExpr;
  if (schedule.cron) {
    if (!cron.isValidCron(schedule.cron, timezone)) {
      throw invalid(`"${schedule.cron}" is not a schedule that will ever fire in ${timezone}.`);
    }
    cronExpr = schedule.cron;
  } else {
    const dayOfWeek = Number.isInteger(schedule.dayOfWeek) ? schedule.dayOfWeek : DEFAULT_SCHEDULE_DAY;
    const hour = Number.isInteger(schedule.hour) ? schedule.hour : DEFAULT_SCHEDULE_HOUR;
    cronExpr = cron.weeklyCron({
      dayOfWeek,
      hour,
      minute: staggerMinute(`${access.workspaceId}:${primary.normalizedOrigin}`),
    });
    if (!cronExpr) throw invalid('That schedule day/hour is not valid.');
  }

  const { limits } = await adminLimits.effectiveLimits({ workspaceId: access.workspaceId });
  const options = { ...crawlOptions };
  if (Number(options.maxUrls) > limits.maxUrlsPerCrawl || !options.maxUrls) {
    options.maxUrls = limits.maxUrlsPerCrawl;
  }
  if (Number(options.maxDepth) > limits.maxCrawlDepth) options.maxDepth = limits.maxCrawlDepth;

  let project;
  try {
    project = await db.tx(async (t) => {
      const created = await t.one(
        `insert into crawl_projects
           (owner, workspace_id, name, url, country_code, options, cron, timezone,
            recipients, enabled, next_run_at, lifecycle_status, settings)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)
         returning *`,
        [
          access.userId,                 // creator attribution only (§7.4)
          access.workspaceId,            // the authorization boundary
          projectName,
          primary.normalizedOrigin,      // compatibility projection (§8.1)
          countryCode,
          db.json(options),
          cronExpr,
          timezone,
          // A real text[] column, so it stays a JS array.
          Array.isArray(recipients) ? recipients.filter(Boolean) : [],
          // A weekly slot is computed and stored, but the schedule starts OFF
          // unless asked for. Creating a project should not silently begin
          // crawling a client's site on a timer — turning it on is a deliberate
          // act, and the setup panel says so.
          schedule.enabled === true,
          schedule.enabled === true
            ? cron.nextRun(cronExpr, new Date(), timezone)?.toISOString() || null
            : null,
          // "Find competitors for me" from setup. Deliberately not acted on
          // here — it only fires later, from the Competitor Research run itself
          // (see moduleRunners.runCompetitor), so choosing this at setup never
          // spends a metered SEMrush budget before anyone asked to run anything.
          db.json(autoFindCompetitors ? { autoFindCompetitors: true } : {}),
        ]
      );

      const domainRows = [
        domainRow(created, access, primary, 'primary', 'user_entered'),
        ...competitorDomains.map((d) => domainRow(created, access, d, 'competitor', 'user_entered')),
      ];
      const cols = Object.keys(domainRows[0]);
      const params = [];
      const tuples = domainRows.map((row) => {
        const slots = cols.map((c) => {
          params.push(row[c]);
          return `$${params.length}`;
        });
        return `(${slots.join(', ')})`;
      });
      await t.query(
        `insert into project_domains (${cols.map((c) => `"${c}"`).join(', ')}) values ${tuples.join(', ')}`,
        params
      );

      return created;
    });
  } catch (error) {
    fail('createProject', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.PROJECT_CREATED,
    workspaceId: access.workspaceId,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    newState: {
      name: projectName,
      primaryDomain: primary.normalizedOrigin,
      countryCode,
      competitors: competitorDomains.map((d) => d.normalizedOrigin),
      autoFindCompetitors: Boolean(autoFindCompetitors),
    },
    source: 'api.projects',
  });

  return getProject(project);
}

function domainRow(project, access, domain, role, source) {
  return {
    workspace_id: project.workspace_id,
    project_id: project.id,
    role,
    normalized_origin: domain.normalizedOrigin,
    host: domain.host,
    scheme: domain.scheme,
    raw_input: domain.raw,
    source,
    status: 'active',
    created_by: access.userId,
  };
}

/**
 * Patches a project. Only the fields the PRD calls "non-destructive project
 * settings" (§7.2) are handled here; the robots override has its own function
 * because it needs a verified site and a reason.
 */
async function updateProject({ access, patch }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;
  const update = {};
  const changed = {};

  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw invalid('A project name cannot be empty.');
    update.name = name;
    changed.name = { from: project.name, to: name };
  }

  if (patch.country !== undefined) {
    const countryCode = domainsLib.normalizeCountry(patch.country);
    update.country_code = countryCode;
    changed.countryCode = { from: project.country_code, to: countryCode };
  }

  if (patch.recipients !== undefined) {
    if (!Array.isArray(patch.recipients)) throw invalid('recipients must be an array of email addresses.');
    update.recipients = patch.recipients.filter(Boolean);
    changed.recipients = { from: project.recipients, to: update.recipients };
  }

  if (patch.enabled !== undefined) {
    update.enabled = Boolean(patch.enabled);
    changed.enabled = { from: project.enabled, to: update.enabled };
  }

  // ── How many pages this client's crawls fetch ───────────────────────────
  //
  // Settable after creation, which it was not. createProject() accepts
  // crawlOptions and then clamps DOWNWARD only — `if (maxUrls > limit ||
  // !maxUrls) maxUrls = limit` — so a project stored with a small budget kept
  // it permanently: nothing in the API or the UI could raise it, and the only
  // fix was to delete the project and make a new one. A real client sat at 150
  // pages, re-crawling 150 pages a week, while every score on the dashboard
  // described that fraction of the site without saying so.
  //
  // Clamped to the effective admin limit on the way in — the same ceiling
  // createProject() applies — so this cannot exceed the operator's policy, and
  // a clamp is audited as its own field rather than silently becoming the
  // ceiling. Note the run-time path clamps AGAIN to MAX_URLS_CEILING, which
  // the admin policy does not influence, so the number stored here is a
  // request and not a guarantee.
  if (patch.crawlOptions !== undefined) {
    if (!patch.crawlOptions || typeof patch.crawlOptions !== 'object') {
      throw invalid('crawlOptions must be an object.');
    }
    const { limits } = await adminLimits.effectiveLimits({ workspaceId: access.workspaceId });
    const next = { ...(project.options || {}) };

    let clamped = null;
    if (patch.crawlOptions.maxUrls !== undefined) {
      const asked = Math.floor(Number(patch.crawlOptions.maxUrls));
      if (!Number.isFinite(asked) || asked < 1) {
        throw invalid('maxUrls must be a whole number of at least 1.');
      }
      next.maxUrls = Math.min(asked, limits.maxUrlsPerCrawl);
      // Clamped rather than rejected — but recorded as its own audited field
      // when it happens, because the audit writer below keeps only `from` and
      // `to` from each entry. Hanging `requested` and `ceilings` off the
      // crawlOptions entry looked like it recorded them and did not: they were
      // dropped on the way into oldState/newState. A request above policy has
      // to be visible as such, or the trail shows the ceiling being chosen
      // deliberately.
      if (next.maxUrls !== asked) clamped = { from: asked, to: next.maxUrls };
    }

    if (patch.crawlOptions.maxDepth !== undefined) {
      const asked = Math.floor(Number(patch.crawlOptions.maxDepth));
      if (!Number.isFinite(asked) || asked < 1) {
        throw invalid('maxDepth must be a whole number of at least 1.');
      }
      next.maxDepth = Math.min(asked, limits.maxCrawlDepth);
    }

    update.options = next;
    changed.crawlOptions = { from: project.options || {}, to: next };
    if (clamped) changed.crawlBudgetClampedByPolicy = clamped;
  }

  if (patch.pages !== undefined) {
    if (!Array.isArray(patch.pages)) {
      throw invalid('pages must be an array of { url, keywords } entries.');
    }
    if (patch.pages.length > MAX_TARGET_PAGES) {
      throw invalid(`A project can target at most ${MAX_TARGET_PAGES} pages.`);
    }

    const seenUrls = new Set();
    const pages = [];
    for (const entry of patch.pages) {
      const rawUrl = String(entry?.url || '').trim();
      if (!rawUrl) continue;

      // Normalised through the same helper the primary domain uses, so a page
      // typed as "site.com/x" and one typed as "https://site.com/x" are one page.
      let url;
      try {
        url = domainsLib.normalizeOrigin(rawUrl).normalizedOrigin;
      } catch {
        throw invalid(`"${rawUrl}" is not a URL this project can audit.`);
      }
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Per page, de-duplicated case-insensitively but stored as typed: the
      // audit quotes the term back to the reader, so their casing is kept.
      const seenTerms = new Set();
      const keywords = [];
      for (const raw of (Array.isArray(entry.keywords) ? entry.keywords : [])) {
        const term = String(raw || '').trim();
        if (!term) continue;
        const key = term.toLowerCase();
        if (seenTerms.has(key)) continue;
        seenTerms.add(key);
        keywords.push(term);
      }
      pages.push({ url, keywords });
    }

    // Merged, not replaced: settings holds more than this.
    update.settings = { ...(project.settings || {}), pageKeywords: pages };
    changed.pages = { from: project.settings?.pageKeywords || [], to: pages };
  }

  if (patch.schedule) {
    const timezone = patch.schedule.timezone && cron.isValidTimezone(patch.schedule.timezone)
      ? patch.schedule.timezone
      : project.timezone;
    let cronExpr = project.cron;

    if (patch.schedule.cron) {
      if (!cron.isValidCron(patch.schedule.cron, timezone)) {
        throw invalid(`"${patch.schedule.cron}" is not a schedule that will ever fire in ${timezone}.`);
      }
      cronExpr = patch.schedule.cron;
    } else if (Number.isInteger(patch.schedule.dayOfWeek) || Number.isInteger(patch.schedule.hour)) {
      const existing = cron.parseWeeklyCron(project.cron) || { dayOfWeek: DEFAULT_SCHEDULE_DAY, hour: DEFAULT_SCHEDULE_HOUR, minute: 0 };
      const next = cron.weeklyCron({
        dayOfWeek: Number.isInteger(patch.schedule.dayOfWeek) ? patch.schedule.dayOfWeek : existing.dayOfWeek,
        hour: Number.isInteger(patch.schedule.hour) ? patch.schedule.hour : existing.hour,
        minute: existing.minute,
      });
      if (!next) throw invalid('That schedule day/hour is not valid.');
      cronExpr = next;
    }

    if (cronExpr !== project.cron || timezone !== project.timezone) {
      update.cron = cronExpr;
      update.timezone = timezone;
      // Re-anchor the next fire so a schedule change takes effect now rather
      // than after the old slot passes.
      update.next_run_at = cron.nextRun(cronExpr, new Date(), timezone)?.toISOString() || null;
      changed.schedule = { from: { cron: project.cron, timezone: project.timezone }, to: { cron: cronExpr, timezone } };
    }
  }

  // Enabling a schedule has to anchor the next fire, or the project sits
  // enabled with next_run_at NULL and never runs — the exact silent failure
  // crawlScope/shared/cron.js warns about.
  if (update.enabled === true && update.next_run_at === undefined) {
    const expr = update.cron || project.cron;
    const zone = update.timezone || project.timezone;
    update.next_run_at = cron.nextRun(expr, new Date(), zone)?.toISOString() || null;
  }
  if (update.enabled === false) update.next_run_at = null;

  if (!Object.keys(update).length) return getProject(project);

  let data;
  try {
    // The workspace boundary is re-asserted on the write.
    const rows = await db.updateWhere(
      'crawl_projects', update,
      { id: project.id, workspace_id: project.workspace_id },
      { returning: '*' },
    );
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    [data] = rows;
  } catch (error) {
    fail('updateProject', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.PROJECT_UPDATED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    reason: patch.reason || null,
    oldState: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
    newState: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
    source: 'api.projects',
  });

  return getProject(data);
}

/**
 * Adds a competitor domain (PRD §3.2.1 — competitors are user-approved).
 *
 * `source` defaults to 'user_entered' — a human typed it in. The auto-discovery
 * path in moduleRunners.runCompetitor passes 'accepted' instead: a candidate
 * SEMrush + AI surfaced and that this project's setup toggle authorized adding
 * without a review step, as opposed to one a human is still expected to look
 * at (project_domains_source_check already allows both, plus 'suggested' for
 * a not-yet-accepted candidate — unused today because nothing here holds one
 * for review instead of accepting it immediately).
 */
async function addCompetitor({ access, domain, status = 'active', source = 'user_entered' }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  // Proposals included deliberately. The partial unique index that makes a
  // duplicate add a no-op is `where status = 'active'`, so it does not see a
  // pending proposal: without this, proposing the same domain twice wrote two
  // rows, and an approver was shown the same competitor waiting for them twice.
  const current = await domainsForProjects([project.id], { statuses: ACTIVE_AND_PROPOSED });
  const rows = current.get(project.id) || [];
  const primary = rows.find((d) => d.role === 'primary' && d.status === 'active');

  const [normalized] = domainsLib.normalizeCompetitors([domain], {
    primaryOrigin: primary?.normalized_origin || null,
  });
  if (!normalized) throw invalid('A competitor domain is required.');

  const alreadyProposed = rows.find(
    (d) => d.role === 'competitor'
      && d.status === 'proposed'
      && d.normalized_origin === normalized.normalizedOrigin,
  );
  if (alreadyProposed) {
    throw Object.assign(
      new Error(`${normalized.host} has already been proposed on this project and is waiting for approval.`),
      { status: 409, code: 'already_proposed' },
    );
  }

  const { limits } = await adminLimits.effectiveLimits({ workspaceId: project.workspace_id });
  void limits; // competitor-count caps are provider limits (§10.2); not enforced yet

  let data;
  try {
    data = await db.insertOne('project_domains', {
      ...domainRow(project, access, normalized, 'competitor', source),
      status,
    });
  } catch (error) {
    // The partial unique index on (project_id, normalized_origin) where active
    // is what makes "add the same competitor twice" a no-op instead of a
    // duplicate row — report it as already-tracked rather than as a failure.
    // 23505 is Postgres's unique_violation.
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      throw Object.assign(
        new Error(`${normalized.host} is already tracked on this project.`),
        { status: 409 },
      );
    }
    fail('addCompetitor', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.DOMAIN_ADDED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project_domain',
    entityId: data.id,
    // domainSource: this domain's own provenance (user_entered/accepted/...).
    // Distinct from `source` below, which names the API surface that logged
    // the event — the two happen to share a name, not a meaning.
    newState: { role: 'competitor', origin: normalized.normalizedOrigin, status, domainSource: source },
    source: 'api.projects',
  });

  return domainView(data);
}

/**
 * Decides a proposed competitor (PRD §7.2).
 *
 * A contributor holds 'propose' on manageCompetitors, so their additions land as
 * status='proposed'. Until now nothing could move them off it: no route listed
 * proposals, none accepted them, and every read filtered them out — the row was
 * written and then invisible forever. These are the two ways out.
 *
 * Approving flips the row to 'active', which is the moment it becomes something
 * the app will spend metered SEMrush units measuring — so it is audited under
 * its own action, with the approver named.
 *
 * Rejecting marks it 'removed' rather than deleting it: the same reasoning as
 * removeDomain. What someone proposed, and that it was turned down, is part of
 * the project's history, and the partial unique indexes free the origin up so
 * the domain can be proposed again later.
 *
 * @param {'approve'|'reject'} decision
 */
async function decideCompetitorProposal({ access, domainId, decision, reason }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  let existing;
  try {
    // Scoped to this project: a domain id from another project is a 404, not a
    // forbidden — knowing an id must not confirm it exists (AC-001).
    existing = await db.maybeOne(
      `select * from project_domains where id = $1 and project_id = $2`,
      [domainId, project.id]
    );
  } catch (error) {
    fail('decideCompetitorProposal(find)', error);
  }
  if (!existing) throw Object.assign(new Error('Domain not found on this project.'), { status: 404 });

  if (existing.status !== 'proposed') {
    throw invalid(
      existing.status === 'active'
        ? `${existing.host} is already tracked on this project.`
        : `${existing.host} is not awaiting a decision (its status is "${existing.status}").`,
    );
  }
  if (existing.role !== 'competitor') {
    throw invalid('Only a proposed competitor can be approved or rejected.');
  }

  const approving = decision === 'approve';
  const nextStatus = approving ? 'active' : 'removed';

  let data;
  try {
    // `and status = 'proposed'` is the race guard, not decoration. The status
    // was read a few lines above, and two approvers clicking at once both read
    // 'proposed' and both used to succeed — leaving the row correctly active but
    // writing TWO "approved" rows into an append-only log whose whole job is to
    // answer who accepted this competitor. Making the UPDATE conditional means
    // exactly one caller changes the row; the loser matches zero rows and is
    // told the decision was already made.
    data = await db.one(
      `update project_domains set status = $2
        where id = $1 and status = 'proposed'
        returning *`,
      [domainId, nextStatus]
    );
  } catch (error) {
    if (/expected exactly one row, got 0/.test(error.message || '')) {
      throw Object.assign(
        new Error(`${existing.host} has already been decided by someone else.`),
        { status: 409, code: 'already_decided' },
      );
    }
    // Approving re-enters the partial unique index on (project_id,
    // normalized_origin) where active. It can collide if the same domain was
    // accepted by another route while this proposal sat pending — which is an
    // answer ("already tracked"), not a failure.
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      throw Object.assign(
        new Error(`${existing.host} is already tracked on this project — this proposal is redundant.`),
        { status: 409, code: 'already_tracked' },
      );
    }
    fail('decideCompetitorProposal', error);
  }

  await auditEvents.record({
    action: approving
      ? auditEvents.ACTIONS.DOMAIN_PROPOSAL_APPROVED
      : auditEvents.ACTIONS.DOMAIN_PROPOSAL_REJECTED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project_domain',
    entityId: domainId,
    reason: reason || null,
    oldState: { origin: existing.normalized_origin, status: 'proposed', proposedBy: existing.created_by },
    newState: { status: nextStatus },
    source: 'api.projects',
  // Approving releases metered spend and rejecting overrules a colleague;
  // both are decisions a person is accountable for, so a silently dropped
  // audit row would leave nobody answerable.
  }, { strict: true });

  return domainView(data);
}

/**
 * Removes a domain. Marked 'removed' rather than deleted, so the record of what
 * was once tracked survives (and the partial unique indexes free the origin up
 * for re-adding). The primary domain cannot be removed — a project without one
 * has nothing to crawl; changing it is setPrimaryDomain's job.
 */
async function removeDomain({ access, domainId, reason }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  let existing;
  try {
    // Scoped: a domain id from another project is a 404.
    existing = await db.maybeOne(
      `select * from project_domains where id = $1 and project_id = $2`,
      [domainId, project.id]
    );
  } catch (error) {
    fail('removeDomain(find)', error);
  }
  if (!existing) throw Object.assign(new Error('Domain not found on this project.'), { status: 404 });

  if (existing.role === 'primary') {
    throw invalid('The primary domain cannot be removed. Change it instead.');
  }
  if (existing.status === 'removed') return domainView(existing);

  let data;
  try {
    data = await db.one(
      `update project_domains set status = 'removed' where id = $1 returning *`,
      [domainId]
    );
  } catch (error) {
    fail('removeDomain', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.DOMAIN_REMOVED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project_domain',
    entityId: domainId,
    reason: reason || null,
    oldState: { origin: existing.normalized_origin, status: existing.status },
    newState: { status: 'removed' },
    source: 'api.projects',
  });

  return domainView(data);
}

/**
 * Changes the primary domain. The old primary is retired to 'removed' and the
 * new one inserted, then `crawl_projects.url` is re-pointed so the CrawlScope
 * scheduler keeps crawling the right site (§8.1).
 */
async function setPrimaryDomain({ access, domain, reason }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;
  const normalized = domainsLib.normalizeOrigin(domain);

  const current = await domainsForProjects([project.id], { statuses: ACTIVE_AND_PROPOSED });
  const rows = current.get(project.id) || [];
  const oldPrimary = rows.find((d) => d.role === 'primary' && d.status === 'active');

  if (oldPrimary?.normalized_origin === normalized.normalizedOrigin) {
    return getProject(project);
  }
  // A PROPOSED competitor clashes too. The unique index only covers active
  // rows, so without this the domain could become the primary while a proposal
  // for the same origin sat pending — and approving it later would fail on the
  // index, with the error pointing at the approval rather than at this.
  const clashingCompetitor = rows.find(
    (d) => d.role === 'competitor'
      && (d.status === 'active' || d.status === 'proposed')
      && d.normalized_origin === normalized.normalizedOrigin,
  );
  if (clashingCompetitor) {
    throw invalid(
      clashingCompetitor.status === 'proposed'
        ? `${normalized.host} has been proposed as a competitor on this project — reject that proposal before making it the primary domain.`
        : `${normalized.host} is tracked as a competitor on this project — remove it there before making it the primary domain.`,
    );
  }

  // All three writes in one transaction. Half-applied, this leaves a project
  // with no active primary domain at all (the old one retired, the new one
  // never inserted) — the state the partial unique index exists to make
  // impossible, reached by crashing between two requests instead of by one bad
  // one.
  let data;
  try {
    data = await db.tx(async (t) => {
      // Retire the old primary first: the partial unique index allows only one
      // active primary per project, so inserting before retiring is rejected.
      if (oldPrimary) {
        await t.query(
          `update project_domains set status = 'removed' where id = $1`, [oldPrimary.id]);
      }

      const row = domainRow(project, access, normalized, 'primary', 'user_entered');
      const cols = Object.keys(row);
      await t.query(
        `insert into project_domains (${cols.map((c) => `"${c}"`).join(', ')})
         values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((c) => row[c])
      );

      // Verification does not survive a domain change, and neither does a
      // robots override that was only granted because the old site was
      // verified (§22.2).
      //
      // Keyed on id alone. This used to carry `and workspace_id = $3`, which
      // added no safety — requireProject has already authorised this caller
      // against this project's workspace, and re-asserting it here cannot catch
      // anything that check missed — but did add a trap: for a project whose
      // workspace_id was NULL, `workspace_id = NULL` is never true in SQL, so
      // t.one() matched zero rows and threw. Setting the primary domain on a
      // workspace-less project failed with "expected exactly one row, got 0",
      // which is exactly the project most in need of a primary domain.
      // Migration 0027 makes workspace_id NOT NULL, so the null case is gone
      // too — but the predicate stays out, because it was never doing work.
      return t.one(
        `update crawl_projects
            set url = $1, site_verified_at = null, site_verified_by = null,
                robots_override = false
          where id = $2
          returning *`,
        [normalized.normalizedOrigin, project.id]
      );
    });
  } catch (error) {
    fail('setPrimaryDomain', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.DOMAIN_PRIMARY_CHANGED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project_domain',
    entityId: project.id,
    reason: reason || null,
    oldState: { origin: oldPrimary?.normalized_origin || project.url, robotsOverride: project.robots_override },
    newState: { origin: normalized.normalizedOrigin, robotsOverride: false, verificationCleared: true },
    source: 'api.projects',
  });

  return getProject(data);
}

/**
 * Sets the robots.txt override (PRD §3.1.4, §22.2). Three preconditions, all
 * checked here rather than trusted from the client: administrator capability
 * (the route), a verified primary site, and a reason. Always audited.
 */
async function setRobotsOverride({ access, enabled, reason }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  if (enabled) {
    if (!project.site_verified_at) {
      throw Object.assign(
        new Error('robots.txt can only be overridden for a verified primary site. Verify ownership first.'),
        { status: 409 },
      );
    }
    if (!reason || !String(reason).trim()) {
      throw invalid('Overriding robots.txt requires a reason, which is recorded in the audit log.');
    }
  }

  let data;
  try {
    data = await db.one(
      `update crawl_projects set robots_override = $1
        where id = $2 and workspace_id = $3
        returning *`,
      [Boolean(enabled), project.id, project.workspace_id]
    );
  } catch (error) {
    fail('setRobotsOverride', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.ROBOTS_OVERRIDE_SET,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    reason: reason || null,
    oldState: { robotsOverride: Boolean(project.robots_override) },
    newState: { robotsOverride: Boolean(enabled) },
    source: 'api.projects',
  }, { strict: true });   // this one must be on the record before we answer

  return getProject(data);
}

/**
 * Soft-deletes a project. Nothing is dropped: the crawl runs, results and
 * findings stay readable (§4.3.1), and the project can be restored.
 */
async function deleteProject({ access, reason }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  let data;
  try {
    data = await db.one(
      `update crawl_projects
          set lifecycle_status = 'deleted',
              deleted_at = $1,
              deleted_by = $2,
              enabled = false,      -- stop the scheduler firing a deleted project
              next_run_at = null
        where id = $3 and workspace_id = $4
        returning *`,
      [new Date().toISOString(), access.userId, project.id, project.workspace_id]
    );
  } catch (error) {
    fail('deleteProject', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.PROJECT_DELETED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    reason: reason || null,
    oldState: { lifecycleStatus: project.lifecycle_status, enabled: project.enabled },
    newState: { lifecycleStatus: 'deleted', enabled: false },
    source: 'api.projects',
  });

  return getProject(data);
}

async function restoreProject({ access }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  let data;
  try {
    data = await db.one(
      `update crawl_projects
          set lifecycle_status = 'active',
              deleted_at = null,
              deleted_by = null,
              -- Left disabled on purpose: re-enabling a schedule is a separate,
              -- deliberate act, so a restore never silently starts crawling.
              next_run_at = null
        where id = $1 and workspace_id = $2
        returning *`,
      [project.id, project.workspace_id]
    );
  } catch (error) {
    fail('restoreProject', error);
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.PROJECT_RESTORED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    oldState: { lifecycleStatus: 'deleted' },
    newState: { lifecycleStatus: 'active', enabled: false },
    source: 'api.projects',
  });

  return getProject(data);
}

// ── Permanent deletion ──────────────────────────────────────────────────────
//
// Deleted in dependency order — children before the rows they reference — so a
// foreign key never blocks a purge halfway through and leaves a project neither
// present nor gone.
//
// Only two entries, and the short list is the point. crawl_runs carries
// `project_id ... on delete set null` (0010), so dropping the project row would
// ORPHAN a client's entire crawl history — every run, result, finding and link
// still on disk with nothing pointing at them — rather than remove it. It has to
// go first and explicitly; crawl_run_results, crawl_run_findings,
// crawl_run_finding_instances, crawl_finding_reviews and crawl_run_links then
// cascade from it.
//
// Everything else that references a project is `on delete cascade`:
// project_domains, project_pages, project_brands, recommendations,
// project_module_runs, project_module_page_runs, project_module_schedules,
// ai_visibility_prompts, ai_visibility_captures, capture_mention,
// capture_citation, capture_attribute, page_category and category_rule. Naming
// them here instead would be a list to forget to update — letting the database
// do it is faster, impossible to get out of order, and purges a table added next
// month without this code changing. Migration 0011's workspace PURGE_ORDER
// deletes crawl_projects rows for exactly the same reason.
//
// audit_events.project_id is `set null` and stays behind on purpose. The trail
// keeps its workspace_id, actor, reason and entity_id, so "what happened to that
// project" still has a dated answer after the project itself is gone.
const PROJECT_PURGE_ORDER = [
  // Scoped by project_id alone. crawl_runs.workspace_id is itself `set null`
  // (0010), so a run whose workspace was purged earlier still carries this
  // project_id — adding a workspace predicate here would skip it and leave the
  // very orphan this entry exists to prevent.
  { table: 'crawl_runs', column: 'project_id' },
  // The project row last, taking every cascade with it. Workspace-scoped for the
  // same defense-in-depth as deleteProject: a project id is resolved from the
  // caller's membership, and the delete re-states that constraint.
  { table: 'crawl_projects', column: 'id', workspaceScoped: true },
];

/**
 * Permanently destroys one project. Nothing survives this and nothing restores
 * it — the opposite of deleteProject, which only flips a status.
 *
 * Two guards stand in front of it, because the operation has no undo:
 *
 *  - the project must ALREADY be soft-deleted, so erasing one is always a
 *    second, deliberate act on something already out of use rather than one
 *    click on a live client's data; and
 *  - the caller must echo the project's exact name. An id in a URL is not
 *    something a person reads, and "which project was I looking at" is precisely
 *    the mistake that a permanent delete gives no chance to notice.
 *
 * The audit row is written BEFORE the deletion, with { strict: true }. It
 * carries project_id, so writing it afterwards would either violate that
 * foreign key or have to drop the reference; and a failure to record the one
 * irreversible action in the system must stop it, not be swallowed. The cost is
 * that a purge failing midway leaves a recorded intent — which is the safe
 * direction: the trail over-reports rather than losing the event entirely.
 */
async function purgeProject({ access, reason, confirmName }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  const project = access.project;

  if (project.lifecycle_status !== 'deleted') {
    throw Object.assign(
      new Error('Delete the project first — permanent deletion only applies to an already-deleted project.'),
      { status: 409, code: 'not_deleted' },
    );
  }

  const expected = String(project.name || '').trim();
  if (String(confirmName || '').trim() !== expected) {
    throw Object.assign(
      new Error(`Type the project name exactly ("${expected}") to permanently delete it.`),
      { status: 400, code: 'confirm_name_mismatch' },
    );
  }

  await auditEvents.record({
    action: auditEvents.ACTIONS.PROJECT_PURGED,
    workspaceId: project.workspace_id,
    projectId: project.id,
    actorUserId: access.userId,
    actorEmail: access.actorEmail,
    actorRole: access.role,
    entityType: 'project',
    entityId: project.id,
    reason: reason || null,
    // The name and url are snapshotted here because in a moment they will not
    // exist anywhere else, and a trail that can only say "some project" cannot
    // answer the question it is kept for.
    oldState: {
      name: project.name,
      url: project.url,
      lifecycleStatus: project.lifecycle_status,
      deletedAt: project.deleted_at,
    },
    newState: { purged: true },
    source: 'api.projects',
  }, { strict: true });

  // One transaction across the whole ordered purge. Half-applied — which two
  // dozen independent DELETE requests could always leave behind — the project
  // is neither present nor gone, and PROJECT_PURGE_ORDER exists precisely
  // because that state is unrecoverable by hand.
  let deleted;
  try {
    deleted = await db.tx(async (t) => {
      const counts = {};
      for (const { table, column, workspaceScoped } of PROJECT_PURGE_ORDER) {
        const params = [project.id];
        let scope = '';
        // Only when the project actually has a workspace. A project predating
        // migration 0011's backfill is authorized by its creator instead
        // (projectAccess.requireProject), and its workspace_id is null — a
        // `workspace_id = NULL` predicate matches nothing, so adding it
        // unconditionally would delete no row and still report a successful
        // purge.
        if (workspaceScoped && project.workspace_id) {
          params.push(project.workspace_id);
          scope = ` and workspace_id = $${params.length}`;
        }
        // table/column come from the PROJECT_PURGE_ORDER constant, never a request.
        const res = await t.query(
          `delete from "${table}" where "${column}" = $1${scope}`, params);
        counts[table] = res.rowCount || 0;
      }
      return counts;
    });
  } catch (error) {
    fail('purgeProject', error);
  }

  // The project row is the one deletion that must have happened: every cascade
  // hangs off it, so a zero here means the data is still there and every caller
  // above has just been told it is gone. Louder than a wrong answer.
  if (!deleted.crawl_projects) {
    throw new Error(
      `[store.purgeProject] ${project.id} still exists after its purge — nothing was deleted.`,
    );
  }

  console.log(`[projects] purged ${project.name} (${project.id}):`, JSON.stringify(deleted));
  return { id: project.id, name: project.name, purged: true, deleted };
}

module.exports = {
  DEFAULT_SCHEDULE_DAY,
  DEFAULT_SCHEDULE_HOUR,
  MAX_TARGET_PAGES,
  projectView,
  domainView,
  listProjects,
  summariesForWorkspaces,
  listDomains,
  projectTrackingOrigin,
  getProject,
  createProject,
  updateProject,
  addCompetitor,
  decideCompetitorProposal,
  removeDomain,
  ACTIVE_ONLY,
  ACTIVE_AND_PROPOSED,
  setPrimaryDomain,
  setRobotsOverride,
  deleteProject,
  restoreProject,
  purgeProject,
  PROJECT_PURGE_ORDER,
};
