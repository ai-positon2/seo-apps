// ── A project's pages ────────────────────────────────────────────────────────
//
// The product's central noun. Before this, a URL existed only as a row inside a
// crawl run, so nothing could attach to a page and outlive the crawl that found
// it — no owner, no note, no "stop flagging this one", no history.
//
// Three rules this module exists to enforce:
//
//   1. One page per canonical spelling. `/a` and `/a/` are one page, and the
//      pretty spelling is what a human sees.
//   2. **Absence is only evidence when the crawl was not capped.** A crawl that
//      stopped at its URL limit never reached some pages. Retiring a page on the
//      strength of a capped crawl would retire half a site the first time
//      somebody lowered the limit, so retirement is withheld and counted instead.
//   3. Nothing is ever deleted. A page that 404s this week may be back next week,
//      and its owner, notes, exclusion and audit history all have to survive it.

const db = require('../../services/db');
const crawledPages = require('./crawledPages');

// Pages go in batches: one statement per 500 keeps the bound-parameter count
// well inside Postgres's limit. A 5,000-page crawl is within the platform's
// configured URL ceiling, so this has to work at that size.
const UPSERT_BATCH = 500;
// Reads are paged too. There is no transport ceiling any more — this used to
// exist because PostgREST capped a response regardless of .limit() — but a
// 5,000-page inventory is still better read in windows than as one result set.
const READ_PAGE = 1000;

function notConfigured() {
  return Object.assign(
    new Error('Reading project pages needs the database configured.'),
    { status: 503, code: 'not_configured' },
  );
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function invalid(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function fail(where, error) {
  throw new Error(`[pages.${where}] ${error.message || error}`);
}

/** True when the table has not been created yet. */
function isMissingTable(error) {
  return error?.code === '42P01'
    || error?.code === '42703'
    || /does not exist/i.test(error?.message || '');
}

let warnedMissing = false;

/**
 * Logged once rather than per request, so an unapplied migration is visible in
 * the log without burying everything else in it. Callers that can degrade read
 * the empty result; callers that cannot re-throw.
 */
function warnMissingOnce() {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn(
    '[pages] project_pages is missing — apply migration 0015_project_pages.sql. '
    + 'Page identity, exclusions and page history are unavailable until then.',
  );
}

function view(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    canonicalKey: row.canonical_key,
    url: row.url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    // Nullable throughout: an unobserved fact is null, never 0 or false.
    depth: row.depth === null || row.depth === undefined ? null : Number(row.depth),
    inboundLinks: row.inbound_links === null || row.inbound_links === undefined
      ? null : Number(row.inbound_links),
    title: row.title || null,
    statusCode: row.status_code === null || row.status_code === undefined
      ? null : Number(row.status_code),
    isIndexable: row.is_indexable === null || row.is_indexable === undefined
      ? null : Boolean(row.is_indexable),
    ownerEmail: row.owner_email || null,
    notes: row.notes || null,
    excluded: Boolean(row.excluded_at),
    excludedAt: row.excluded_at || null,
    excludedReason: row.excluded_reason || null,
    excludedBy: row.excluded_by || null,
    retired: Boolean(row.retired_at),
    retiredAt: row.retired_at || null,
    retiredReason: row.retired_reason || null,
  };
}

// `sql` must end in an ORDER BY (or nothing) and carry no LIMIT/OFFSET of its
// own — this appends the window.
async function readAll(sql, params, label) {
  const rows = [];
  for (let from = 0; ; from += READ_PAGE) {
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await db.rows(`${sql} limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, READ_PAGE, from]);
    } catch (error) {
      if (isMissingTable(error)) { warnMissingOnce(); return []; }
      fail(label, error);
    }
    if (!data.length) break;
    rows.push(...data);
    if (data.length < READ_PAGE) break;
  }
  return rows;
}

/**
 * Bring the page inventory in line with one completed crawl.
 *
 * Upserts every page the crawl saw, and decides — carefully — what to do about
 * pages it did not see.
 *
 * @param {object} input
 * @param {object} input.access     from projectAccess.requireProject
 * @param {string} [input.crawlRunId]  defaults to the latest completed crawl
 * @returns {Promise<object>} {
 *   crawlRunId, seen, created, updated, retired, retirementWithheld, capped
 * }
 */
/**
 * Whether a page missing from the latest crawl may be retired.
 *
 * Absence is only evidence when the crawl looked everywhere. Three ways it did
 * not, and all three have to block retirement:
 *
 *   capped            the audit budget truncated the ranked page list
 *   crawlCapped true  the crawler stopped at its own maxUrls ceiling
 *   crawlCapped null  the run does not record a usable maxUrls, so we cannot tell
 *
 * The third is the one worth stating: "cannot tell" is not "not capped". Reading
 * it as permission is how a guard against retiring half a site turns into the
 * thing that retires half a site.
 *
 * This was previously `if (crawl.capped)` inline, which was always false here —
 * syncFromCrawl asks for an unlimited budget by design, so budget truncation
 * cannot occur, and the guard never once fired.
 *
 * @param {{capped: boolean, crawlCapped: boolean|null}} crawl
 */
function retirementAllowed(crawl) {
  if (!crawl) return false;
  if (crawl.capped) return false;
  return crawl.crawlCapped === false;
}

async function syncFromCrawl({ access, crawlRunId = null }) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const projectId = access.project.id;
  const workspaceId = access.project.workspace_id || null;

  // The whole inventory, not the audit budget's slice: `limit` is what bounds a
  // page AUDIT, and it must not bound what the project knows exists.
  const crawl = await crawledPages.listCrawledPages(projectId, {
    limit: Number.MAX_SAFE_INTEGER,
  });

  if (!crawl.crawl) {
    return {
      crawlRunId: null, seen: 0, created: 0, updated: 0,
      retired: 0, retirementWithheld: 0, capped: false,
      reason: 'No completed crawl for this project yet.',
    };
  }
  if (crawlRunId && crawl.crawl.id !== crawlRunId) {
    throw invalid(
      `Crawl ${crawlRunId} is not the latest completed crawl for this project.`,
      'stale_crawl',
    );
  }

  const seenAt = crawl.crawl.finished_at || crawl.crawl.created_at || new Date().toISOString();

  // Existing rows, so created-vs-updated is a real count rather than a guess.
  const existing = await readAll(
    `select id, canonical_key, retired_at from project_pages
      where project_id = $1
      order by id asc`,
    [projectId],
    'syncFromCrawl.existing',
  );
  const existingByKey = new Map(existing.map((r) => [r.canonical_key, r]));

  const rows = [];
  const seenKeys = new Set();
  for (const page of crawl.pages) {
    const key = crawledPages.canonicalKey(page.url);
    if (!key || seenKeys.has(key)) continue;   // the crawl can list two spellings
    seenKeys.add(key);
    rows.push({
      project_id: projectId,
      workspace_id: workspaceId,
      canonical_key: key,
      url: page.url,
      last_seen_at: seenAt,
      last_seen_run: crawl.crawl.id,
      depth: page.depth,
      inbound_links: page.inlinks === null || page.inlinks === undefined
        ? null : Number(page.inlinks),
      title: page.title,
      // A page the crawl reached and re-saw is not retired any more. Its owner,
      // notes and exclusion are untouched — only the retirement is lifted.
      retired_at: null,
      retired_reason: null,
    });
  }

  let created = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.upsert('project_pages', batch, ['project_id', 'canonical_key']);
    } catch (error) {
      if (isMissingTable(error)) { warnMissingOnce(); throw notFound('project_pages does not exist yet — apply migration 0015.'); }
      fail('syncFromCrawl.upsert', error);
    }
    for (const row of batch) {
      if (existingByKey.has(row.canonical_key)) updated += 1;
      else created += 1;
    }
  }

  // first_seen_* only on rows this sync created. Done as a follow-up update so
  // the upsert above cannot overwrite an older first_seen with today's date —
  // which would quietly destroy the one fact the table exists to remember.
  const newKeys = [...seenKeys].filter((k) => !existingByKey.has(k));
  for (let i = 0; i < newKeys.length; i += UPSERT_BATCH) {
    const batch = newKeys.slice(i, i + UPSERT_BATCH);
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        `update project_pages set first_seen_at = $1, first_seen_run = $2
          where project_id = $3 and canonical_key = any($4)`,
        [seenAt, crawl.crawl.id, projectId, batch]
      );
    } catch (error) {
      fail('syncFromCrawl.firstSeen', error);
    }
  }

  // ── Pages the crawl did not see ─────────────────────────────────────────
  //
  // This is the judgement call the whole module turns on. A capped crawl stopped
  // before it ran out of pages, so a page's absence from it is not evidence of
  // anything. Retiring on that basis would mark most of a site gone the first
  // time somebody lowered the crawl limit.
  const missing = existing.filter((r) => !seenKeys.has(r.canonical_key) && !r.retired_at);
  let retired = 0;
  let retirementWithheld = 0;

  if (missing.length) {
    if (!retirementAllowed(crawl)) {
      retirementWithheld = missing.length;
    } else {
      const ids = missing.map((r) => r.id);
      const reason = `Not found in the crawl of ${seenAt}, which completed without `
        + 'hitting its URL limit — so the page is genuinely absent rather than unreached.';
      for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.query(
            `update project_pages set retired_at = $1, retired_reason = $2
              where id = any($3)`,
            [seenAt, reason, ids.slice(i, i + UPSERT_BATCH)]
          );
        } catch (error) {
          fail('syncFromCrawl.retire', error);
        }
      }
      retired = ids.length;
    }
  }

  return {
    crawlRunId: crawl.crawl.id,
    crawledAt: seenAt,
    seen: seenKeys.size,
    created,
    updated,
    retired,
    // Named rather than silent: "12 pages were not seen, and we are not calling
    // them gone because the crawl was capped" is the honest sentence.
    retirementWithheld,
    capped: crawl.capped,
    crawlCapped: crawl.crawlCapped,
    crawlLimit: crawl.crawlLimit,
    note: retirementWithheld
      ? `${retirementWithheld} page(s) were not seen in this crawl, but it stopped at its `
        + `${crawl.limit}-URL limit, so they are not marked retired — absence is not evidence `
        + 'when the crawl did not finish looking.'
      : null,
  };
}

/**
 * The page inventory.
 *
 * Retired and excluded pages are excluded by default and counted, so a caller
 * always knows what it is not being shown.
 */
async function listPages(projectId, { includeRetired = false, includeExcluded = true } = {}) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const rows = await readAll(
    // nulls last matches the old { nullsFirst: false }: a page with no inbound
    // link count sorts after every page that has one, not before.
    `select * from project_pages
      where project_id = $1
      order by inbound_links desc nulls last, id asc`,
    [projectId],
    'listPages',
  );

  const all = rows.map(view);
  const filtered = all.filter((p) => {
    if (!includeRetired && p.retired) return false;
    if (!includeExcluded && p.excluded) return false;
    return true;
  });

  return {
    pages: filtered,
    total: all.length,
    shown: filtered.length,
    retired: all.filter((p) => p.retired).length,
    excluded: all.filter((p) => p.excluded).length,
    withOwner: all.filter((p) => p.ownerEmail).length,
  };
}

/** The canonical keys of every excluded page, for the backlog to subtract. */
async function excludedKeys(projectId) {
  if (!db.isDatabaseConfigured()) return new Set();
  const rows = await readAll(
    `select canonical_key from project_pages
      where project_id = $1 and excluded_at is not null
      order by id asc`,
    [projectId],
    'excludedKeys',
  );
  return new Set(rows.map((r) => r.canonical_key));
}

async function getPage(projectId, pageId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  let data;
  try {
    data = await db.maybeOne(
      `select * from project_pages where project_id = $1 and id = $2`,
      [projectId, pageId]
    );
  } catch (error) {
    if (isMissingTable(error)) { warnMissingOnce(); return null; }
    fail('getPage', error);
  }
  return view(data);
}

/** Look one page up by URL, on its canonical spelling. */
async function findByUrl(projectId, url) {
  const key = crawledPages.canonicalKey(url);
  if (!key) return null;
  let data;
  try {
    data = await db.maybeOne(
      `select * from project_pages where project_id = $1 and canonical_key = $2`,
      [projectId, key]
    );
  } catch (error) {
    if (isMissingTable(error)) { warnMissingOnce(); return null; }
    fail('findByUrl', error);
  }
  return view(data);
}

/** canonical key → page id, for resolving a run's findings onto pages. */
async function keyToId(projectId) {
  const rows = await readAll(
    `select id, canonical_key from project_pages
      where project_id = $1
      order by id asc`,
    [projectId],
    'keyToId',
  );
  return new Map(rows.map((r) => [r.canonical_key, r.id]));
}

async function updatePage(projectId, pageId, patch) {
  // Validate before checking configuration: a malformed request is a 400 whether
  // or not the database is reachable, and answering 503 tells the caller to retry
  // something that will never succeed.
  const update = {};
  if (patch.ownerEmail !== undefined) {
    update.owner_email = patch.ownerEmail ? String(patch.ownerEmail).trim().toLowerCase() : null;
  }
  if (patch.notes !== undefined) update.notes = patch.notes ? String(patch.notes) : null;
  if (!Object.keys(update).length) throw invalid('Nothing to update.', 'empty_patch');

  if (!db.isDatabaseConfigured()) throw notConfigured();

  let data;
  try {
    const rows = await db.updateWhere(
      'project_pages', update, { project_id: projectId, id: pageId }, { returning: '*' });
    [data] = rows;
  } catch (error) {
    fail('updatePage', error);
  }
  if (!data) throw notFound('Page not found.');
  return view(data);
}

/**
 * Stop auditing one page.
 *
 * A reason is required. "Why are we not checking this page" is the question a
 * handover asks, and an exclusion without an answer is indistinguishable from a
 * mistake — the same argument that makes a rejection reason mandatory on a
 * recommendation.
 */
async function excludePage(projectId, pageId, { reason, by }) {
  // The reason is checked first, for the same reason as in updatePage: a missing
  // reason is the caller's mistake, not the database's.
  const clean = String(reason || '').trim();
  if (!clean) {
    throw invalid('Excluding a page needs a reason.', 'reason_required');
  }
  if (!db.isDatabaseConfigured()) throw notConfigured();

  let data;
  try {
    data = await db.maybeOne(
      `update project_pages
          set excluded_at = $1, excluded_reason = $2, excluded_by = $3
        where project_id = $4 and id = $5
        returning *`,
      [new Date().toISOString(), clean, by || null, projectId, pageId]
    );
  } catch (error) {
    fail('excludePage', error);
  }
  if (!data) throw notFound('Page not found.');
  return view(data);
}

async function includePage(projectId, pageId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();
  let data;
  try {
    data = await db.maybeOne(
      `update project_pages
          set excluded_at = null, excluded_reason = null, excluded_by = null
        where project_id = $1 and id = $2
        returning *`,
      [projectId, pageId]
    );
  } catch (error) {
    fail('includePage', error);
  }
  if (!data) throw notFound('Page not found.');
  return view(data);
}

/**
 * One page's audit history.
 *
 * The question the product could not answer before this table existed. Rows are
 * matched by page_id where the run recorded one and by canonical spelling
 * otherwise, so history written before migration 0015 is not lost — but which
 * way each row was matched is reported, because a string match is a weaker claim
 * than a foreign key.
 */
async function pageHistory(projectId, pageId) {
  if (!db.isDatabaseConfigured()) throw notConfigured();

  const page = await getPage(projectId, pageId);
  if (!page) throw notFound('Page not found.');

  const HISTORY_COLUMNS =
    'id, run_id, module_key, status, score, band, counts, error, finished_at, created_at';

  const byId = await readAll(
    `select ${HISTORY_COLUMNS} from project_module_page_runs
      where project_id = $1 and page_id = $2
      order by created_at desc, id desc`,
    [projectId, pageId],
    'pageHistory.byId',
  );

  const byUrl = await readAll(
    `select ${HISTORY_COLUMNS} from project_module_page_runs
      where project_id = $1 and page_id is null and url = $2
      order by created_at desc, id desc`,
    [projectId, page.url],
    'pageHistory.byUrl',
  );

  const shape = (row, matchedBy) => ({
    id: row.id,
    runId: row.run_id,
    moduleKey: row.module_key,
    status: row.status,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    band: row.band || null,
    counts: row.counts || {},
    error: row.error || null,
    at: row.finished_at || row.created_at,
    matchedBy,
  });

  const audits = [
    ...byId.map((r) => shape(r, 'page_id')),
    ...byUrl.map((r) => shape(r, 'url')),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return {
    page,
    audits,
    // Legacy rows are matched on an exact URL string, which misses any page whose
    // spelling changed. Stated rather than hidden.
    legacyMatches: byUrl.length,
  };
}

module.exports = {
  syncFromCrawl,
  listPages,
  getPage,
  findByUrl,
  retirementAllowed,
  keyToId,
  excludedKeys,
  updatePage,
  excludePage,
  includePage,
  pageHistory,
  isMissingTable,
  view,
  UPSERT_BATCH,
};
