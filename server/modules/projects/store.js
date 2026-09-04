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

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
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
    new Error('Projects need Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'),
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

async function domainsForProjects(projectIds) {
  if (!projectIds.length) return new Map();
  const { data, error } = await getSupabase()
    .from('project_domains')
    .select('*')
    .in('project_id', projectIds)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) fail('domainsForProjects', error);

  const byProject = new Map();
  for (const row of data || []) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
    byProject.get(row.project_id).push(row);
  }
  return byProject;
}

/**
 * Every active domain row for one project, in DB shape.
 *
 * projectView() splits domains into primaryDomain/competitors and renames the
 * columns for the client. Callers that work on the rows themselves — the module
 * runners, which need normalized_origin and role — get them unmapped from here
 * rather than reassembling them from the view.
 */
async function listDomains(projectId) {
  if (!projectId) return [];
  const byProject = await domainsForProjects([projectId]);
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
  if (!isSupabaseConfigured()) throw notConfigured();

  const scope = workspaceId ? [workspaceId] : (workspaceIds || []);
  if (!scope.length) return [];

  let query = getSupabase()
    .from('crawl_projects')
    .select('*')
    .in('workspace_id', scope)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
  if (!includeDeleted) query = query.neq('lifecycle_status', 'deleted');

  const { data, error } = await query;
  if (error) fail('listProjects', error);

  const projects = data || [];
  const byProject = await domainsForProjects(projects.map((p) => p.id));
  return projects.map((p) => projectView(p, byProject.get(p.id) || []));
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

  const { data, error } = await getSupabase()
    .from('crawl_projects')
    .select('id, name, url, workspace_id, lifecycle_status, created_at')
    .in('workspace_id', scope)
    .neq('lifecycle_status', 'deleted')
    .order('created_at', { ascending: false });
  if (error) fail('summariesForWorkspaces', error);

  const rows = data || [];
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

/** One project plus its domains. The caller has already been authorized. */
async function getProject(projectRow) {
  const byProject = await domainsForProjects([projectRow.id]);
  return projectView(projectRow, byProject.get(projectRow.id) || []);
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creates a project. PRD §18.2 + AC-004: primary domain and country are both
 * required, and the country is normalized to ISO alpha-2.
 *
 * Not transactional — Supabase's REST interface has no multi-statement
 * transaction — so the order is chosen to fail safe: the project row first, then
 * its primary domain. A crash between the two leaves a project whose
 * primaryDomainSource reads 'legacy_url_column' (its `url` is already correct),
 * which the UI shows as needing a domain rather than as broken. The reverse
 * order would leave an orphaned domain row pointing at nothing.
 */
async function createProject({ access, name, primaryDomain, country, competitors = [], schedule = {}, recipients = [], crawlOptions = {}, autoFindCompetitors = false }) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const primary = domainsLib.normalizeOrigin(primaryDomain);
  const countryCode = domainsLib.normalizeCountry(country);
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

  const sb = getSupabase();
  const { data: project, error } = await sb
    .from('crawl_projects')
    .insert({
      owner: access.userId,                 // creator attribution only (§7.4)
      workspace_id: access.workspaceId,     // the authorization boundary
      name: projectName,
      url: primary.normalizedOrigin,        // compatibility projection (§8.1)
      country_code: countryCode,
      options,
      cron: cronExpr,
      timezone,
      recipients: Array.isArray(recipients) ? recipients.filter(Boolean) : [],
      // A weekly slot is computed and stored, but the schedule starts OFF unless
      // asked for. Creating a project should not silently begin crawling a
      // client's site on a timer — turning it on is a deliberate act, and the
      // setup panel says so.
      enabled: schedule.enabled === true,
      next_run_at: schedule.enabled === true
        ? cron.nextRun(cronExpr, new Date(), timezone)?.toISOString() || null
        : null,
      lifecycle_status: 'active',
      // "Find competitors for me" from setup. Deliberately not acted on here —
      // it only fires later, from the Competitor Research run itself (see
      // moduleRunners.runCompetitor), so choosing this at setup never spends a
      // metered SEMrush budget before anyone asked to run anything.
      settings: autoFindCompetitors ? { autoFindCompetitors: true } : {},
    })
    .select('*')
    .single();
  if (error) fail('createProject', error);

  const domainRows = [
    domainRow(project, access, primary, 'primary', 'user_entered'),
    ...competitorDomains.map((d) => domainRow(project, access, d, 'competitor', 'user_entered')),
  ];
  const { error: domainErr } = await sb.from('project_domains').insert(domainRows);
  if (domainErr) fail('createProject(domains)', domainErr);

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
  if (!isSupabaseConfigured()) throw notConfigured();
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

  const { data, error } = await getSupabase()
    .from('crawl_projects')
    .update(update)
    .eq('id', project.id)
    .eq('workspace_id', project.workspace_id)   // boundary re-asserted on the write
    .select('*')
    .single();
  if (error) fail('updateProject', error);

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
  if (!isSupabaseConfigured()) throw notConfigured();
  const project = access.project;

  const current = await domainsForProjects([project.id]);
  const rows = current.get(project.id) || [];
  const primary = rows.find((d) => d.role === 'primary' && d.status === 'active');

  const [normalized] = domainsLib.normalizeCompetitors([domain], {
    primaryOrigin: primary?.normalized_origin || null,
  });
  if (!normalized) throw invalid('A competitor domain is required.');

  const { limits } = await adminLimits.effectiveLimits({ workspaceId: project.workspace_id });
  void limits; // competitor-count caps are provider limits (§10.2); not enforced yet

  const { data, error } = await getSupabase()
    .from('project_domains')
    .insert({
      ...domainRow(project, access, normalized, 'competitor', source),
      status,
    })
    .select('*')
    .single();
  if (error) {
    // The partial unique index on (project_id, normalized_origin) where active
    // is what makes "add the same competitor twice" a no-op instead of a
    // duplicate row — report it as already-tracked rather than as a failure.
    if (/duplicate key|unique/i.test(error.message)) {
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
 * Removes a domain. Marked 'removed' rather than deleted, so the record of what
 * was once tracked survives (and the partial unique indexes free the origin up
 * for re-adding). The primary domain cannot be removed — a project without one
 * has nothing to crawl; changing it is setPrimaryDomain's job.
 */
async function removeDomain({ access, domainId, reason }) {
  if (!isSupabaseConfigured()) throw notConfigured();
  const project = access.project;
  const sb = getSupabase();

  const { data: existing, error: findErr } = await sb
    .from('project_domains')
    .select('*')
    .eq('id', domainId)
    .eq('project_id', project.id)      // scoped: a domain id from another project is a 404
    .maybeSingle();
  if (findErr) fail('removeDomain(find)', findErr);
  if (!existing) throw Object.assign(new Error('Domain not found on this project.'), { status: 404 });

  if (existing.role === 'primary') {
    throw invalid('The primary domain cannot be removed. Change it instead.');
  }
  if (existing.status === 'removed') return domainView(existing);

  const { data, error } = await sb
    .from('project_domains')
    .update({ status: 'removed' })
    .eq('id', domainId)
    .select('*')
    .single();
  if (error) fail('removeDomain', error);

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
  if (!isSupabaseConfigured()) throw notConfigured();
  const project = access.project;
  const normalized = domainsLib.normalizeOrigin(domain);
  const sb = getSupabase();

  const current = await domainsForProjects([project.id]);
  const rows = current.get(project.id) || [];
  const oldPrimary = rows.find((d) => d.role === 'primary' && d.status === 'active');

  if (oldPrimary?.normalized_origin === normalized.normalizedOrigin) {
    return getProject(project);
  }
  const clashingCompetitor = rows.find(
    (d) => d.role === 'competitor' && d.status === 'active' && d.normalized_origin === normalized.normalizedOrigin,
  );
  if (clashingCompetitor) {
    throw invalid(
      `${normalized.host} is tracked as a competitor on this project — remove it there before making it the primary domain.`,
    );
  }

  // Retire the old primary first: the partial unique index allows only one
  // active primary per project, so inserting before retiring would be rejected.
  if (oldPrimary) {
    const { error } = await sb.from('project_domains')
      .update({ status: 'removed' }).eq('id', oldPrimary.id);
    if (error) fail('setPrimaryDomain(retire)', error);
  }

  const { error: insertErr } = await sb
    .from('project_domains')
    .insert(domainRow(project, access, normalized, 'primary', 'user_entered'));
  if (insertErr) fail('setPrimaryDomain(insert)', insertErr);

  // Verification does not survive a domain change, and neither does a robots
  // override that was only granted because the old site was verified (§22.2).
  const { data, error } = await sb
    .from('crawl_projects')
    .update({
      url: normalized.normalizedOrigin,
      site_verified_at: null,
      site_verified_by: null,
      robots_override: false,
    })
    .eq('id', project.id)
    .eq('workspace_id', project.workspace_id)
    .select('*')
    .single();
  if (error) fail('setPrimaryDomain(project)', error);

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
  if (!isSupabaseConfigured()) throw notConfigured();
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

  const { data, error } = await getSupabase()
    .from('crawl_projects')
    .update({ robots_override: Boolean(enabled) })
    .eq('id', project.id)
    .eq('workspace_id', project.workspace_id)
    .select('*')
    .single();
  if (error) fail('setRobotsOverride', error);

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
  if (!isSupabaseConfigured()) throw notConfigured();
  const project = access.project;

  const { data, error } = await getSupabase()
    .from('crawl_projects')
    .update({
      lifecycle_status: 'deleted',
      deleted_at: new Date().toISOString(),
      deleted_by: access.userId,
      enabled: false,          // stop the scheduler firing a deleted project
      next_run_at: null,
    })
    .eq('id', project.id)
    .eq('workspace_id', project.workspace_id)
    .select('*')
    .single();
  if (error) fail('deleteProject', error);

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
  if (!isSupabaseConfigured()) throw notConfigured();
  const project = access.project;

  const { data, error } = await getSupabase()
    .from('crawl_projects')
    .update({
      lifecycle_status: 'active',
      deleted_at: null,
      deleted_by: null,
      // Left disabled on purpose: re-enabling a schedule is a separate,
      // deliberate act, so a restore never silently starts crawling.
      next_run_at: null,
    })
    .eq('id', project.id)
    .eq('workspace_id', project.workspace_id)
    .select('*')
    .single();
  if (error) fail('restoreProject', error);

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
// crawl_finding_reviews and crawl_run_links then cascade from it.
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
  if (!isSupabaseConfigured()) throw notConfigured();
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

  const db = getSupabase();

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

  const deleted = {};
  for (const { table, column, workspaceScoped } of PROJECT_PURGE_ORDER) {
    let query = db.from(table).delete().eq(column, project.id);
    // Only when the project actually has a workspace. A project predating
    // migration 0011's backfill is authorized by its creator instead
    // (projectAccess.requireProject), and its workspace_id is null — an
    // `.eq('workspace_id', null)` becomes SQL `= NULL`, which matches nothing,
    // so adding the predicate unconditionally would delete no row and still
    // report a successful purge.
    if (workspaceScoped && project.workspace_id) {
      query = query.eq('workspace_id', project.workspace_id);
    }

    const { data, error } = await query.select('id');
    if (error) fail(`purgeProject.${table}`, error);
    deleted[table] = (data || []).length;
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
  getProject,
  createProject,
  updateProject,
  addCompetitor,
  removeDomain,
  setPrimaryDomain,
  setRobotsOverride,
  deleteProject,
  restoreProject,
  purgeProject,
  PROJECT_PURGE_ORDER,
};
