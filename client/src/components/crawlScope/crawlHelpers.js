// Pure display logic for the CrawlScope screens, ported from the standalone
// app's renderer (src/renderer/app.js). Kept in one place, and kept pure, so the
// React pages stay about layout and the numbers stay identical to what the
// desktop app produced — the health score in particular is a published figure
// and must not drift because it was reimplemented.

export const PAGE_SIZE = 25;
// User-selectable "rows per page" for the results table — PAGE_SIZE stays the
// default so nothing else that imports it needs to change.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200, 500];

const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const REVIEW_STATUSES = [
  'Needs review',
  'Confirmed issue',
  'False positive',
  'Resolved',
];

// A finding marked either of these is out of the picture for metrics and counts:
// it is not an outstanding problem any more.
const DISMISSED = ['False positive', 'Resolved'];
// Finding scopes that describe the pages themselves, and so count toward Site
// Health. Mirrored by server/modules/projects/overview.js#siteHealth.
const PAGE_LEVEL_SCOPES = new Set(['page', 'template']);

export const SEVERITY_ORDER = ['error', 'warning', 'notice', 'info'];

const SEVERITY_VARIANT = {
  error: 'danger',
  warning: 'warning',
  notice: 'info',
  info: 'neutral',
};

export function severityVariant(severity) {
  return SEVERITY_VARIANT[severity] || 'neutral';
}

export function statusVariant(status) {
  if (!status) return 'neutral';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'info';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'danger';
  return 'neutral';
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.floor((milliseconds || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// The single most serious issue on a result, used for the Priority column.
export function topSeverity(result) {
  const issues = result?.issues || [];
  for (const severity of SEVERITY_ORDER) {
    const hit = issues.find((issue) => issue.severity === severity);
    if (hit) return hit;
  }
  return null;
}

// ── Redirect / refresh summaries ────────────────────────────────────────────
// A 3xx without a usable Location, or a Location that doesn't parse, is itself
// the finding — so the column shows why rather than an empty cell.
export function redirectLocationIssueSummary(result) {
  if (!result) return '';
  if (!HTTP_REDIRECT_STATUSES.has(result.status)) return '';
  if (result.redirectUrl) return '';
  if (!result.locationHeaderRaw) return 'Missing Location header';
  return 'Unparseable Location header';
}

// meta refresh / Refresh header, whichever the crawler recorded.
export function declarativeRefreshData(result) {
  return result?.declarativeRefresh || result?.metaRefresh || null;
}

export function declarativeRefreshSummary(result) {
  const refresh = declarativeRefreshData(result);
  if (!refresh) return '';
  const target = refresh.targetUrl || refresh.url || '';
  const delay = refresh.delaySeconds ?? refresh.delay;
  if (target && delay !== undefined && delay !== null) return `${delay}s → ${target}`;
  if (target) return `→ ${target}`;
  if (delay !== undefined && delay !== null) return `${delay}s (self)`;
  return refresh.raw || '';
}

// ── Table tabs ──────────────────────────────────────────────────────────────
// [key, label, width, align] — the same five report tabs the desktop app had.
export const COLUMN_SETS = {
  all: [
    ['status', 'Status', '70px'],
    ['url', 'URL', '30%'],
    ['pageCategory', 'Category', '110px'],
    ['contentType', 'Content type', '110px'],
    ['title', 'Page title', '20%'],
    ['indexability', 'Indexability', '95px'],
    ['depth', 'Depth', '55px', 'numeric'],
    ['responseTime', 'Time', '65px', 'numeric'],
    ['issues', 'Issues', '60px', 'numeric'],
  ],
  issues: [
    ['severity', 'Priority', '90px'],
    ['url', 'URL', '34%'],
    ['topIssue', 'Top issue', '27%'],
    ['status', 'Status', '65px'],
    ['title', 'Page title', '24%'],
    ['issues', 'Count', '58px', 'numeric'],
  ],
  response: [
    ['status', 'Status', '70px'],
    ['url', 'URL', '38%'],
    ['statusText', 'Status text', '120px'],
    ['contentType', 'Content type', '150px'],
    ['redirectUrl', 'HTTP redirect destination', '24%'],
    ['declarativeRefresh', 'Timed refresh', '24%'],
    ['size', 'Size', '75px', 'numeric'],
    ['responseTime', 'Time', '65px', 'numeric'],
  ],
  metadata: [
    ['url', 'URL', '24%'],
    ['pageCategory', 'Category', '110px'],
    ['title', 'Page title', '22%'],
    ['titleLength', 'Title len.', '65px', 'numeric'],
    ['metaDescription', 'Meta description', '28%'],
    ['metaLength', 'Meta len.', '65px', 'numeric'],
    ['h1', 'H1', '18%'],
    ['h1Count', 'H1s', '45px', 'numeric'],
    ['words', 'Words', '60px', 'numeric'],
  ],
  links: [
    ['url', 'URL', '34%'],
    ['inlinks', 'Inlinks', '65px', 'numeric'],
    ['outlinks', 'Outlinks', '70px', 'numeric'],
    ['externalLinks', 'External', '70px', 'numeric'],
    ['canonical', 'Canonical URL', '34%'],
    ['depth', 'Depth', '55px', 'numeric'],
  ],
};

export const TABLE_TABS = [
  { id: 'all', label: 'All URLs' },
  { id: 'issues', label: 'Issues' },
  { id: 'response', label: 'Response' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'links', label: 'Links' },
];

export const QUICK_FILTERS = [
  { id: '', label: 'No filter' },
  { id: 'errors', label: 'Has an error' },
  { id: 'warnings', label: 'Has a warning' },
  { id: 'indexable', label: 'Indexable' },
  { id: 'non-indexable', label: 'Non-indexable' },
  { id: '2xx', label: '2xx' },
  { id: '3xx', label: '3xx' },
  { id: '4xx', label: '4xx' },
  { id: '5xx', label: '5xx' },
];

/**
 * Is this crawl result an HTML page of the site, rather than a file it serves?
 *
 * The audit universe. A crawl of 1,700 URLs is typically ~1,370 internal rows,
 * of which only some are pages — the rest are images, stylesheets, scripts,
 * PDFs and feeds the crawler fetched because a page referenced them. No check
 * in analyzer.js runs on a stylesheet, so it can never appear in the findings,
 * and listing it in a table of "your pages" pads the count with rows nobody
 * can act on.
 *
 * Exported because this predicate decides the denominator of the health score,
 * the "HTML pages" tile and the page table's contents, and those three have to
 * be the same set by construction rather than by three copies of one filter
 * agreeing by luck.
 */
export const isHtmlPage = (result) => Boolean(result?.contentType?.includes('text/html'));

// ── Filtering ───────────────────────────────────────────────────────────────
export function filterResults(results, { tab = 'all', issueFilter = '', filter = '', category = '', query = '' } = {}) {
  let values = results;

  if (tab === 'issues') {
    values = values.filter((item) => item.issues?.length);
  } else if (tab === 'metadata') {
    values = values.filter(isHtmlPage);
  }

  if (issueFilter) {
    values = values.filter((item) => (item.issues || []).some((issue) => issue.id === issueFilter));
  }

  if (category) {
    values = values.filter((item) => item.pageCategory === category);
  }

  if (filter === 'errors') {
    values = values.filter((item) => (item.issues || []).some((i) => i.severity === 'error'));
  } else if (filter === 'warnings') {
    values = values.filter((item) => (item.issues || []).some((i) => i.severity === 'warning'));
  } else if (filter === 'indexable') {
    values = values.filter((item) => item.indexability === 'Indexable');
  } else if (filter === 'non-indexable') {
    values = values.filter((item) => item.indexability !== 'Indexable');
  } else if (/^[2345]xx$/.test(filter)) {
    const start = Number(filter[0]) * 100;
    values = values.filter((item) => item.status >= start && item.status < start + 100);
  }

  if (query) {
    const q = query.toLowerCase();
    values = values.filter((item) =>
      [
        item.url,
        item.title,
        item.metaDescription,
        item.h1,
        item.statusText,
        ...(item.issues || []).map((issue) => issue.label),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }

  return values;
}

// ── Health ──────────────────────────────────────────────────────────────────
// Weights (45 / 22 / 8) and the dedupe-by-affected-page rule are carried over
// verbatim. Counting affected PAGES rather than raw findings is deliberate: a
// page with five missing alt attributes is one affected page, not five, and
// counting findings let a single page hit the same penalty as a site-wide issue.
//
// Internal pages only, everywhere below.
//
// The crawler follows the external pages a site links out to, and stores them as
// results. No check ever runs on them — analyzer.js evaluates internalResults —
// so they cannot be counted as affected, but they WERE counted in the
// denominator, where each one silently acted as a clean page. On the live project
// that was 35 of 85 HTML results, worth 13 points of Site Health.
//
// The external rows still matter and are still stored: they are the evidence
// behind broken-external-link and external-403, which attach to the internal page
// carrying the link. They are simply not pages of this site, so they are not
// scored as pages of this site.
export function healthMetrics(results, findings = []) {
  const internalResults = results.filter((item) => item.scope !== 'External');
  // A response that refused the crawler (bot protection, rate limiting — the
  // analyzer's crawl-blocked finding) is not one of the site's pages: nothing
  // was learned about it, so it is neither counted clean nor counted broken.
  const htmlResults = internalResults.filter((item) => isHtmlPage(item) && !item.crawlRefused);
  const htmlUrls = new Set(htmlResults.map((item) => item.url));
  // `finding.scope` ('page' | 'site' | 'resource' | 'template') is unrelated to
  // a crawl result's own `.scope` ('Internal' | 'External') just above. A
  // site-wide misconfiguration (sitemap/robots, HSTS, llms.txt) or a resource
  // file's issue must never inflate Errors/Warnings/Notices here;
  // siteScopedGroups() is where those are counted instead.
  //
  // 'template' is different: it is a PAGE defect that the analyzer found on at
  // least half the pages (collapseTemplateFindings), so it is grouped as one
  // cause for display — but every one of those pages still has it. Leaving it
  // out made the score rise as a problem spread: 45% of pages missing a meta
  // description scored 90, and 100% of them scored 100.
  const activeFindings = findings.filter(
    (f) => !DISMISSED.includes(f.reviewStatus) && PAGE_LEVEL_SCOPES.has(f.scope || 'page'),
  );
  const useFindings = findings.length > 0;

  const countBySeverity = (severity) =>
    useFindings
      ? activeFindings.filter((f) => f.severity === severity).length
      : internalResults.reduce(
          (sum, item) => sum + (item.issues || []).filter((i) => i.severity === severity).length,
          0,
        );

  // Counted over the same pages as the denominator. A finding on an image,
  // script or unreachable URL is real, but that URL is not one of the HTML
  // pages the share is taken over, so it cannot be one of the pages "with" it.
  const affectedPages = (severity) =>
    new Set(
      (useFindings
        ? activeFindings.filter((f) => f.severity === severity).map((f) => f.url)
        : internalResults
            .filter((item) => (item.issues || []).some((i) => i.severity === severity))
            .map((item) => item.url)
      ).filter((url) => htmlUrls.has(url)),
    ).size;

  const errors = countBySeverity('error');
  const warnings = countBySeverity('warning');
  const notices = countBySeverity('notice');
  const affectedErrorPages = affectedPages('error');
  const affectedWarningPages = affectedPages('warning');
  const affectedNoticePages = affectedPages('notice');

  // Internal HTML pages alone. The old `Math.max(htmlResults.length,
  // results.length)` put every external result back into the divisor.
  const denominator = Math.max(htmlResults.length, 1);
  const health = htmlResults.length
    ? Math.max(
        0,
        Math.round(
          100 -
            (affectedErrorPages / denominator) * 45 -
            (affectedWarningPages / denominator) * 22 -
            (affectedNoticePages / denominator) * 8,
        ),
      )
    : null;

  return {
    errors,
    warnings,
    notices,
    health,
    indexable: htmlResults.filter((item) => item.indexability === 'Indexable').length,
    htmlCount: htmlResults.length,
    refusedCount: internalResults.filter((item) => item.crawlRefused).length,
    affectedErrorPages,
    affectedWarningPages,
    affectedNoticePages,
  };
}

// Structured version of the same weighted breakdown, for an always-visible
// panel rather than a hover-only tooltip — a score with a hidden formula
// isn't credible to a client. Lists every tier, even ones contributing zero,
// so the panel reads as the whole formula, not just the parts that hurt.
//
// ── Why the rounding is apportioned rather than per-band ────────────────────
//
// The parts have to add up to the whole, and until now they did not. `health`
// rounds ONCE, at the end (`round(100 - a - b - c)`); this rounded each band
// separately and the panel printed their sum as "how the N points were lost".
// Two different roundings of the same arithmetic disagree constantly — a site
// with 2 HTML pages and one page in error scored 78 beside the words "How the
// 23 points were lost", and 100 − 78 is 22. On the one panel in the product
// whose entire job is to show its working, that is the worst possible defect:
// it invites the reader to check the number and then fails the check.
//
// So the deductions are apportioned by LARGEST REMAINDER against the score the
// crawler actually published. Each band gets the floor of its exact
// contribution, and the leftover points — always fewer than three — go to the
// bands with the largest fractional parts. The result sums to `100 - health`
// exactly, by construction, and each band still lands within a point of its
// true weight. The bars are still the real formula; they just reconcile.
//
// The published score is NOT recomputed here. It is stored on runs, drives the
// dashboard's composite and appears in exports, so the display bends to the
// score and never the other way round.
export function healthScoreBreakdown(metrics) {
  if (!metrics || metrics.health === null) return [];
  const denominator = Math.max(metrics.htmlCount, 1);

  const bands = [
    { label: 'Errors', pages: metrics.affectedErrorPages, weight: 45 },
    { label: 'Warnings', pages: metrics.affectedWarningPages, weight: 22 },
    { label: 'Notices', pages: metrics.affectedNoticePages, weight: 8 },
  ].map((b) => {
    const exact = ((b.pages || 0) / denominator) * b.weight;
    return { ...b, exact, points: Math.floor(exact) };
  });

  // What the score says was lost. `health` is clamped at 0, so on a site bad
  // enough to bottom out this is 100 and the bands are scaled down to fit it —
  // which is right: the panel must explain the score that was published, not
  // the one the unclamped arithmetic would have given.
  const target = 100 - metrics.health;
  const exactTotal = bands.reduce((sum, b) => sum + b.exact, 0);
  if (exactTotal > 0 && Math.abs(exactTotal - target) > 0.5) {
    // Clamped, or a caller passed a score from a different computation. Rescale
    // to the published figure before apportioning, rather than printing bands
    // that sum to something else.
    const scale = target / exactTotal;
    bands.forEach((b) => { b.exact *= scale; b.points = Math.floor(b.exact); });
  }

  let remaining = target - bands.reduce((sum, b) => sum + b.points, 0);
  // Largest fractional part first; ties broken by weight so a point lands on
  // the more serious band, and the order is stable run to run.
  const order = [...bands].sort(
    (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || b.weight - a.weight,
  );
  for (const band of order) {
    if (remaining <= 0) break;
    band.points += 1;
    remaining -= 1;
  }

  return bands.map(({ label, pages, weight, points }) => ({ label, pages, weight, points }));
}

// Plain-language breakdown so a health score is never an unexplained number.
// Points lost mirror the weights above exactly.
// Built from healthScoreBreakdown rather than recomputing the weights, so the
// sentence in a tooltip and the bars in the panel can never quote two different
// numbers for one deduction. They did before: this rounded per band and the
// panel summed those, while the score rounded once.
const BAND_NOUN = { Errors: 'errors', Warnings: 'warnings', Notices: 'notices' };

export function healthScoreExplanation(metrics) {
  if (!metrics || metrics.health === null) return 'Run a crawl to calculate site health.';
  const parts = healthScoreBreakdown(metrics)
    .filter((b) => b.pages)
    .map((b) => `−${b.points} from ${b.pages} page(s) with ${BAND_NOUN[b.label]}`);
  if (!parts.length) return 'No issues found — a clean 100.';
  return `Starting from 100: ${parts.join(', ')}. That is ${metrics.health} out of 100.`;
}

// ── Issue overview ──────────────────────────────────────────────────────────
// Groups the crawl's per-URL issues into one row per distinct issue, ordered by
// severity then by how many URLs it touches. Findings marked resolved or false
// positive are excluded so the overview tracks outstanding work.
export function issueGroups(results, findings = []) {
  const dismissed = new Set(
    findings.filter((f) => DISMISSED.includes(f.reviewStatus)).map((f) => `${f.ruleId}|${f.url}`),
  );
  const map = new Map();
  for (const result of results) {
    for (const issue of result.issues || []) {
      if (dismissed.has(`${issue.id}|${result.url}`)) continue;
      const existing = map.get(issue.id) || {
        id: issue.id,
        label: issue.label,
        severity: issue.severity,
        urls: [],
      };
      existing.urls.push(result.url);
      map.set(issue.id, existing);
    }
  }
  return [...map.values()].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.urls.length - a.urls.length;
  });
}

// A page×check matrix can't represent a whole-site finding without either
// double-counting it per host or dropping it — this is issueGroups()'s
// counterpart for the ~12 catalog entries that carry a non-'page' scope
// (site/template/resource), read directly from `findings` rather than from
// any one page's `.issues`, since these aren't really about one page. Each
// finding already carries its own `reviewStatus`, so dismissal-checking here
// is a direct field check rather than issueGroups()'s composite-key lookup.
export function siteScopedGroups(findings = []) {
  const map = new Map();
  for (const f of findings) {
    if (DISMISSED.includes(f.reviewStatus)) continue;
    const scope = f.scope || 'page';
    if (scope === 'page') continue;
    const existing = map.get(f.ruleId) || {
      id: f.ruleId,
      label: f.title,
      severity: f.severity,
      scope,
      urls: [],
    };
    existing.urls.push(f.url);
    map.set(f.ruleId, existing);
  }
  return [...map.values()].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.urls.length - a.urls.length;
  });
}

// ── SEO snapshot (Passed Checks / On-Page Issues / Quick Wins / Indexability
//    Risks — the SWOT quadrants, in SEO-native language) ─────────────────────
// A quadrant read of a single run's own findings — there is no second crawl or
// competitor data here, so this is deliberately scoped to what one run's
// catalog coverage actually supports, not a trend or a rival comparison:
//   Passed Checks       — catalog checks that came back clean.
//   On-Page Issues      — confirmed on-page/content problems (Metadata,
//                         Content, Links, Accessibility & Social, Performance).
//   Indexability Risks  — problems that risk whether pages can be crawled or
//                         indexed at all (Indexability, Technical) — the ones
//                         that can get worse, not just the ones that already
//                         fired.
//   Quick Wins          — the catalog's own "Low Priority" tier: notice-
//                         severity items, i.e. quick, non-urgent wins.
// Severity partitions Indexability Risks/On-Page Issues from Quick Wins
// (notice vs. error/warning) and category partitions Indexability Risks from
// On-Page Issues, so a given issue id can only ever land in exactly one
// quadrant.
const RISK_CATEGORIES = new Set(['Indexability', 'Technical']);

function snapshotItem(group, catalogById) {
  const meta = catalogById.get(group.id);
  return {
    id: group.id,
    label: group.label,
    detail: meta?.description || '',
    severity: group.severity,
    count: group.urls.length,
  };
}

export function buildSeoSnapshot(pages, groups, catalog) {
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  // Strengths: how much of the catalog's automatic coverage came back clean.
  const flaggedIds = new Set(groups.map((g) => g.id));
  const automaticChecks = catalog.filter((c) => c.detection === 'Automatic');
  const passedCount = automaticChecks.filter((c) => !flaggedIds.has(c.id)).length;

  const categoryTotals = new Map();
  for (const c of automaticChecks) categoryTotals.set(c.category, (categoryTotals.get(c.category) || 0) + 1);
  const flaggedCategories = new Set(
    groups.map((g) => catalogById.get(g.id)?.category).filter(Boolean),
  );
  const cleanCategories = [...categoryTotals.entries()]
    .filter(([category]) => !flaggedCategories.has(category))
    .sort((a, b) => b[1] - a[1]);

  const htmlPages = pages.filter(isHtmlPage);
  const indexableCount = htmlPages.filter((p) => p.indexability === 'Indexable').length;
  const indexableRatio = htmlPages.length ? indexableCount / htmlPages.length : null;

  const strengths = [];
  if (automaticChecks.length) {
    strengths.push({
      id: 'checks-clean',
      label: `${passedCount} of ${automaticChecks.length} checks clean`,
      detail: 'No findings across these automatic checks this run.',
    });
  }
  for (const [category, count] of cleanCategories.slice(0, 3)) {
    strengths.push({
      id: `category-${category}`,
      label: `${category}: ${count}/${count} checks clean`,
      detail: `Every automatic ${category.toLowerCase()} check passed.`,
    });
  }
  if (indexableRatio !== null && indexableRatio >= 0.9) {
    strengths.push({
      id: 'indexable-ratio',
      label: `${indexableCount} of ${htmlPages.length} HTML pages indexable`,
      detail: 'Most pages are eligible to appear in search results.',
    });
  }

  // groups is already sorted severity-first then by affected-page count
  // (issueGroups), and filtering preserves that order.
  const threatGroups = groups.filter(
    (g) => g.severity !== 'notice' && RISK_CATEGORIES.has(catalogById.get(g.id)?.category),
  );
  const weaknessGroups = groups.filter(
    (g) => g.severity !== 'notice' && !RISK_CATEGORIES.has(catalogById.get(g.id)?.category),
  );
  const opportunityGroups = groups.filter((g) => g.severity === 'notice');

  return {
    strengths: strengths.slice(0, 4),
    weaknesses: weaknessGroups.slice(0, 3).map((g) => snapshotItem(g, catalogById)),
    threats: threatGroups.slice(0, 3).map((g) => snapshotItem(g, catalogById)),
    opportunities: opportunityGroups.slice(0, 3).map((g) => snapshotItem(g, catalogById)),
  };
}

// ── Issue overview grouping ─────────────────────────────────────────────────
// Organizes issueGroups()'s flat list into the catalog's own category
// sections (Technical, Indexability, Metadata, ...) — reusing the category
// each card already shows as its eyebrow label, just using it to group
// instead of only to label. A group whose id has no catalog match (shouldn't
// happen post-fix, but a live crawl can still be mid-flight) falls into an
// "Other" section rather than silently vanishing.
export function groupsByCategory(groups, catalogById) {
  const sections = new Map();
  for (const g of groups) {
    const category = catalogById.get(g.id)?.category || "Other";
    const list = sections.get(category) || [];
    list.push(g);
    sections.set(category, list);
  }
  return [...sections.entries()]
    .map(([category, items]) => ({
      category,
      items,
      affectedPages: new Set(items.flatMap((g) => g.urls)).size,
      worstSeverity: SEVERITY_ORDER.find((s) => items.some((g) => g.severity === s)) || "info",
    }))
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER.indexOf(a.worstSeverity) - SEVERITY_ORDER.indexOf(b.worstSeverity);
      return bySeverity !== 0 ? bySeverity : b.affectedPages - a.affectedPages;
    });
}

// ── What a finding says to do ───────────────────────────────────────────────
// The analyzer writes page-specific advice onto a finding: a suggested value
// (a rewritten title, a starter meta description, an H1) in recommendedValue,
// and for some rules a recommendation built from this page's own evidence —
// the sitemap fix naming the canonical URL, the robots.txt line naming the real
// domain. The report showed only the catalog's text for the rule, so that
// advice reached the Excel export and nowhere else. `fix` is null when the
// finding only repeats the catalog text, which the issue card already shows.
export function findingFix(finding, entry) {
  const raw = finding?.recommendedValue;
  const suggestion = raw === undefined || raw === null ? '' : String(raw).trim();
  const own = String(finding?.recommendation || '').trim();
  const generic = String(entry?.recommendation || '').trim();
  return {
    suggestion: suggestion || null,
    fix: own && own !== generic ? own : null,
  };
}

// A finding's evidence as two lines: what it means (`detail`, e.g. "2 redirect
// hops", "HTTP 404 Not Found") and what was found (`detectedValue`: the hops,
// the link text, the title itself). Rows used to print `detail || value`, so a
// finding with both showed only the first. The value is left off when it says
// the same thing, or is only a placeholder for "nothing there".
const ABSENT_VALUES = new Set(['(absent)', '(none)']);
const EVIDENCE_MAX = 240;

export function findingEvidence(finding) {
  const detail = String(finding?.detail ?? '').trim();
  const raw = finding?.detectedValue;
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!detail) return { primary: value || '—', secondary: null };
  const secondary = value && value !== detail && !ABSENT_VALUES.has(value)
    ? (value.length > EVIDENCE_MAX ? `${value.slice(0, EVIDENCE_MAX - 1)}…` : value)
    : null;
  return { primary: detail, secondary };
}

// The issue cards on one page's own view. Page- AND template-scoped findings:
// a template finding is a page defect found on most pages, so it is on this
// page too, and it counts toward Site Health; leaving it off the page's own
// view made a page "have" a problem it did not list. Dismissed findings are
// left out, matching the page table's issue count.
export function pageIssueCards(findings, pageUrl, catalogById, pagesByRule = new Map()) {
  return findings
    .filter((f) => f.url === pageUrl
      && PAGE_LEVEL_SCOPES.has(f.scope || 'page')
      && !DISMISSED.includes(f.reviewStatus))
    .map((f) => {
      const entry = catalogById.get(f.ruleId);
      const { suggestion, fix } = findingFix(f, entry);
      const evidence = findingEvidence(f);
      return {
        // Per finding, not per rule: a page with two broken links has two.
        key: f.id || `${f.ruleId}|${f.targetUrl || ''}|${f.detail || ''}`,
        id: f.ruleId,
        title: entry?.title || f.title || f.ruleId,
        severity: f.severity,
        detected: evidence.primary === '—' ? null : evidence.primary,
        found: evidence.secondary,
        targetUrl: f.targetUrl || null,
        suggestion,
        description: entry?.description || null,
        recommendation: fix || entry?.recommendation || null,
        pages: pagesByRule.get(f.ruleId) || 1,
      };
    });
}

// ── Effective issues & count hierarchy ──────────────────────────────────────
// A crawled page's embedded `.issues` is `quickIssues()` output from crawl time
// (crawler.js) — a small synchronous rule set evaluated per-page as it's fetched.
// The full picture — analyzer.js's whole rule catalog, with detectedValue/
// recommendedValue — only exists in `findings`, fetched once after the crawl
// completes, and is never written back onto the stored per-page rows. Left
// alone, that means "Issues found" cards, this table's Issues column, and the
// SEO snapshot quadrants all show the SMALLER crawl-time set forever, while
// "Issue review" and the Excel export show the full one — two different
// detection passes presented as if they were one number.
//
// This re-derives every page's `.issues` from `findings` once findings exist,
// so everything downstream reads the same, authoritative set. Dismissed
// findings (False positive / Resolved) are excluded here too, matching
// `issueGroups`'s existing dismissal semantics — a page you've already
// resolved shouldn't still show a live issue badge for it.
export function withEffectiveIssues(results, findings = []) {
  if (!findings.length) return results;
  const dismissed = new Set(
    findings.filter((f) => DISMISSED.includes(f.reviewStatus)).map((f) => `${f.ruleId}|${f.url}`),
  );
  const byUrl = new Map();
  for (const f of findings) {
    if (dismissed.has(`${f.ruleId}|${f.url}`)) continue;
    // Site/template/resource-scoped findings don't belong on any one page's
    // issue list — the URL they're attached to (robots.txt, llms.txt, a
    // representative host, a specific asset) is where the check happened to
    // run, not "this page has this problem." They live in
    // siteScopedGroups()'s own section instead.
    if ((f.scope || 'page') !== 'page') continue;
    const list = byUrl.get(f.url) || [];
    list.push({ id: f.ruleId, label: f.title, severity: f.severity, category: f.category });
    byUrl.set(f.url, list);
  }
  return results.map((r) => ({ ...r, issues: byUrl.get(r.url) || [] }));
}

// One coherent count hierarchy instead of several numbers that look related
// but are actually different units of different things:
//   URLs fetched (all content types, incl. external)
//     └─ HTML pages (the audit universe)
//          └─ page findings + site findings + resource findings
//               └─ occurrences (page findings only — see below)
//                    └─ issue types / root-cause groups (distinct checks that fired)
// In this codebase issue types and root-cause groups are currently the same
// number — nothing here consolidates several related rule ids into one fix
// action yet, so the hierarchy is honestly four tiers, not five.
//
// `occurrences` (page-level) is computed TWO independent ways — once per
// issue type (summing each group's affected-URL list) and once per page
// (summing each page's own issue count) — and asserted equal. They're built
// from the same underlying data via different code paths, so this is a real
// invariant, not a tautology: `reconciled` goes false, loudly, if a future
// edit ever lets them drift apart. Site/resource/template occurrences are
// counted separately (from siteScopedGroups()) and are NEVER added into this
// page-level total — a site-wide finding isn't one more "page finding."
export function buildCountHierarchy(results, effectivePages, metrics, groups, siteGroups = []) {
  const occurrencesByCheck = groups.reduce((sum, g) => sum + g.urls.length, 0);
  const occurrencesByPage = effectivePages.reduce((sum, p) => sum + (p.issues || []).length, 0);
  const byScope = (scope) =>
    siteGroups.filter((g) => g.scope === scope).reduce((sum, g) => sum + g.urls.length, 0);
  return {
    urlsFetched: results.length,
    htmlPages: metrics.htmlCount,
    siteOccurrences: byScope('site'),
    resourceOccurrences: byScope('resource'),
    templateOccurrences: byScope('template'),
    occurrences: occurrencesByCheck,
    occurrencesByCheck,
    occurrencesByPage,
    issueTypes: groups.length,
    rootCauseGroups: groups.length,
    reconciled: occurrencesByCheck === occurrencesByPage,
  };
}

// ── Backlog (issues carried across scheduled runs) ─────────────────────────
// How long a still-open issue has been sitting there, and whether it's
// getting better or worse — only meaningful for a scheduled project with
// real crawl history, so this is built from a bounded window of *previous*
// runs' findings (fetched by the page, not by this module) rather than from
// anything stored per-run today. `crawl_runs.summary.counts` (see
// worker/index.js) only carries severity totals, not a per-check breakdown,
// so there is no cheap server-side shortcut here — this walks the findings
// arrays the existing /runs/:id/findings endpoint already returns.
export const BACKLOG_HISTORY_WINDOW = 6;

function ruleCounts(findings = []) {
  const map = new Map();
  for (const f of findings) {
    if (DISMISSED.includes(f.reviewStatus)) continue;
    const existing = map.get(f.ruleId) || { id: f.ruleId, label: f.title, severity: f.severity, count: 0 };
    existing.count += 1;
    map.set(f.ruleId, existing);
  }
  return map;
}

// `historyRuns`: [{ id, finishedAt, findings }], strictly before the current
// run, ordered newest-first — as many as the caller fetched (bounded by
// BACKLOG_HISTORY_WINDOW). A rule only counts as "backlog" once it has shown
// up in the current run AND at least the one immediately before it; a rule
// that only ever appeared once is new, not a backlog. `openEnded` on an item
// means the streak ran to the edge of the fetched window while still
// present — the issue may be older than `runsPresent` says, just not
// verifiably so from what was fetched.
export function buildBacklog(currentFindings, historyRuns = []) {
  if (!historyRuns.length) return { items: [], windowRuns: 0 };
  const current = ruleCounts(currentFindings);
  const history = historyRuns.map((r) => ({ ...r, counts: ruleCounts(r.findings) }));

  const items = [];
  for (const [ruleId, cur] of current) {
    let runsPresent = 1; // the current run
    let firstSeenAt = null;
    let openEnded = true;
    for (const h of history) {
      const prevCount = h.counts.get(ruleId)?.count || 0;
      if (prevCount <= 0) { openEnded = false; break; }
      runsPresent += 1;
      firstSeenAt = h.finishedAt;
    }
    if (runsPresent < 2) continue; // first appearance this run — not backlog yet
    const previousCount = history[0]?.counts.get(ruleId)?.count || 0;
    const changePercent = previousCount > 0
      ? Math.round(((cur.count - previousCount) / previousCount) * 100)
      : null;
    items.push({
      id: ruleId,
      label: cur.label,
      severity: cur.severity,
      count: cur.count,
      previousCount,
      changePercent,
      runsPresent,
      firstSeenAt: firstSeenAt || history[0]?.finishedAt || null,
      openEnded,
    });
  }

  items.sort((a, b) => {
    if (b.runsPresent !== a.runsPresent) return b.runsPresent - a.runsPresent;
    return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  });
  return { items, windowRuns: historyRuns.length };
}

// ── Summary text builders (copyable) ────────────────────────────────────────
// Deterministic, data-only recaps of everything else on the page — never a
// generated narrative, so each is exactly as trustworthy as the numbers it's
// built from and never drifts from them. Each is a fixed number of lines
// regardless of site size (a handful of overview facts + a bounded top-N
// list), so none of them can balloon on a large crawl.
function hostOf(url) {
  try { return new URL(url || '').hostname; } catch { return url || 'this site'; }
}

// Page-scope and site-scope issues, unified into one priority-ordered list —
// the same severity-then-affected-count ordering issueGroups/siteScopedGroups
// already use individually, just interleaved so "what to fix first" reads as
// one list instead of two.
function combinedPriorityGroups(groups = [], siteGroups = []) {
  return [...groups, ...siteGroups].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.urls.length - a.urls.length;
  });
}

// A deterministic, data-only recap of everything else on the page, not a
// generated narrative — so it's exactly as trustworthy as the numbers it's
// built from, and never drifts from them. It's a fixed number of bullet
// lines regardless of site size, so it stays comfortably under a 1000-word
// ceiling for any crawl this app produces.
export function buildExecutiveSummaryText({ run, metrics, counts, seoSnapshot, groups = [], backlog }) {
  if (!metrics || !counts) return '';
  const host = hostOf(run?.url);
  const when = run?.finished_at || run?.started_at || run?.created_at;
  const lines = [];

  lines.push(`SEO CRAWL SUMMARY — ${host}`);
  if (when) lines.push(`Crawled ${new Date(when).toLocaleString()}`);
  lines.push('');

  lines.push('OVERVIEW');
  lines.push(`- Site health: ${metrics.health ?? '—'}/100 (${metrics.errors} error, ${metrics.warnings} warning, ${metrics.notices} notice findings)`);
  const indexablePct = counts.htmlPages ? Math.round((metrics.indexable / counts.htmlPages) * 100) : 0;
  lines.push(`- ${counts.htmlPages} pages audited; ${metrics.indexable} indexable (${indexablePct}%)`);
  lines.push(`- ${counts.occurrences} page-level issue occurrences across ${counts.issueTypes} distinct checks`);
  const nonPageTotal = counts.siteOccurrences + counts.resourceOccurrences + counts.templateOccurrences;
  if (nonPageTotal > 0) {
    lines.push(`- ${counts.siteOccurrences} site-wide, ${counts.resourceOccurrences} resource, ${counts.templateOccurrences} template-level finding(s) — tracked separately, not in the counts above`);
  }
  lines.push('');

  const topIssues = [...groups].sort((a, b) => b.urls.length - a.urls.length).slice(0, 5);
  if (topIssues.length) {
    lines.push('TOP ISSUES');
    for (const g of topIssues) {
      lines.push(`- ${g.label} — ${g.urls.length} page${g.urls.length === 1 ? '' : 's'} (${g.severity})`);
    }
    lines.push('');
  }

  if (seoSnapshot) {
    lines.push('SEO SNAPSHOT');
    lines.push(`- ${seoSnapshot.strengths[0]?.label || 'Passed checks not available'}`);
    lines.push(`- On-page issues flagged: ${seoSnapshot.weaknesses.length}`);
    lines.push(`- Quick wins queued: ${seoSnapshot.opportunities.length}`);
    lines.push(`- Indexability risks: ${seoSnapshot.threats.length}`);
    lines.push('');
  }

  if (backlog?.items?.length) {
    const oldest = backlog.items[0];
    lines.push('BACKLOG');
    lines.push(`- ${backlog.items.length} issue(s) carried over from a previous crawl`);
    lines.push(`- Longest-standing: ${oldest.label}, open ${oldest.runsPresent}${oldest.openEnded ? '+' : ''} crawls in a row`);
    lines.push('');
  }

  if (topIssues.length) {
    lines.push('SUGGESTED NEXT STEPS');
    for (const g of topIssues.slice(0, 3)) {
      lines.push(`- Fix "${g.label}" — affects ${g.urls.length} page${g.urls.length === 1 ? '' : 's'}`);
    }
  }

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// "Email to dev" — plain text, paste-ready for an email body: a Subject:
// line to split off by hand, the two links a recipient actually needs (the
// dashboard and the Excel download), then the same overview/backlog facts as
// the on-screen summary, then a prioritized fix list instead of just the top
// 3. Tone follows the scheduled-crawl email (worker/email.js) — terse and
// data-first, no "Dear team," greeting or sign-off invented for it.
export function buildEmailShareText({
  run, id, metrics, counts, backlog, groups = [], siteGroups = [], email,
}) {
  if (!metrics || !counts) return '';
  const host = hostOf(run?.url);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const dashboardUrl = id ? `${origin}/crawl-scope/runs/${id}` : '';
  const excelUrl = id ? `${origin}/api/crawl-scope/runs/${id}/report.xlsx` : '';
  const lines = [];

  lines.push(`Subject: CrawlScope audit — ${host}: ${metrics.errors} errors, ${metrics.warnings} warnings`);
  lines.push('');
  if (dashboardUrl) lines.push(`Dashboard report: ${dashboardUrl}`);
  if (excelUrl) {
    // Worth saying once: this is a cookie-gated app link, not a public one —
    // the one destination here where a reader might otherwise assume it just
    // opens for anyone.
    lines.push(`Excel audit download: ${excelUrl}`);
    lines.push('  (opens for anyone signed in to SEO Studio — not a public link)');
  }
  lines.push('');

  lines.push('OVERVIEW');
  lines.push(`- Site health: ${metrics.health ?? '—'}/100 (${metrics.errors} error, ${metrics.warnings} warning, ${metrics.notices} notice findings)`);
  const indexablePct = counts.htmlPages ? Math.round((metrics.indexable / counts.htmlPages) * 100) : 0;
  lines.push(`- ${counts.htmlPages} pages audited; ${metrics.indexable} indexable (${indexablePct}%)`);
  lines.push(`- ${counts.occurrences} page-level issue occurrences across ${counts.issueTypes} distinct checks`);
  const nonPageTotal = counts.siteOccurrences + counts.resourceOccurrences + counts.templateOccurrences;
  if (nonPageTotal > 0) {
    lines.push(`- ${counts.siteOccurrences} site-wide, ${counts.resourceOccurrences} resource, ${counts.templateOccurrences} template-level finding(s) — tracked separately, not in the counts above`);
  }
  lines.push('');

  if (backlog?.items?.length) {
    const oldest = backlog.items[0];
    lines.push('BACKLOG');
    lines.push(`- ${backlog.items.length} issue(s) carried over from a previous crawl`);
    lines.push(`- Longest-standing: "${oldest.label}", open ${oldest.runsPresent}${oldest.openEnded ? '+' : ''} crawls in a row`);
    lines.push('');
  }

  const priority = combinedPriorityGroups(groups, siteGroups).slice(0, 8);
  if (priority.length) {
    lines.push('STEPS TO TAKE, BY PRIORITY');
    priority.forEach((g, i) => {
      lines.push(`${i + 1}. "${g.label}" — ${g.severity}, ${g.urls.length} page${g.urls.length === 1 ? '' : 's'}`);
    });
    lines.push('');
  }

  if (email) lines.push(`Prepared by ${email} via SEO Studio CrawlScope`);

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// "Message for a channel" — the same plain, structured style as the on-screen
// quick summary (ALL-CAPS section headers, "- " bullets, no emoji, no chat
// markdown) just shorter: a condensed version of buildExecutiveSummaryText
// for a channel post rather than a different voice entirely.
export function buildChannelShareText({
  run, id, metrics, counts, backlog, groups = [], siteGroups = [],
}) {
  if (!metrics || !counts) return '';
  const host = hostOf(run?.url);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const dashboardUrl = id ? `${origin}/crawl-scope/runs/${id}` : '';
  const lines = [];

  lines.push(`CrawlScope — ${host}`);
  lines.push(`Health: ${metrics.health ?? '—'}/100 (${metrics.errors} errors, ${metrics.warnings} warnings, ${metrics.notices} notices)`);
  lines.push(`${counts.htmlPages} pages audited, ${metrics.indexable} indexable`);
  lines.push('');

  const top = combinedPriorityGroups(groups, siteGroups).slice(0, 5);
  if (top.length) {
    lines.push('TOP ISSUES');
    for (const g of top) {
      lines.push(`- ${g.label} — ${g.urls.length} page${g.urls.length === 1 ? '' : 's'} (${g.severity})`);
    }
    lines.push('');
  }

  if (backlog?.items?.length) {
    const oldest = backlog.items[0];
    lines.push('BACKLOG');
    lines.push(`- ${backlog.items.length} issue${backlog.items.length === 1 ? '' : 's'} recurring, oldest since ${oldest.runsPresent}${oldest.openEnded ? '+' : ''} crawls ago`);
    lines.push('');
  }
  if (dashboardUrl) lines.push(`Full report: ${dashboardUrl}`);

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// "Task table" — tab-separated, not markdown: pasted into Excel/Sheets/
// Notion this becomes real, editable columns (including a blank Owner column
// to assign), where a markdown pipe table would paste as literal `| ... |`
// text with no columns at all. Every outstanding issue group, not just a
// top-N — these are root-cause groups, capped at the size of the catalog, so
// even a large site produces a manageable row count, and a task list that
// silently dropped items past #8 would be a worse task list than a long one.
function tsvEscape(value) {
  // A tab or newline inside a field would corrupt the row/column structure
  // on paste, so it's collapsed to a single space rather than preserved.
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

export function buildTaskTableTsv({ groups = [], siteGroups = [], backlog }) {
  const all = combinedPriorityGroups(groups, siteGroups);
  const header = ['Issue', 'Severity', 'Scope', 'Pages affected', 'Age (crawls)', 'Change vs last crawl', 'Owner'];
  // Header alone on a clean crawl (no open issues) rather than nothing —
  // pasting an empty tracker shell is still useful, and it means the button
  // always does something when clicked instead of silently no-op-ing.
  if (!all.length) return header.join('\t');
  const ageByRule = new Map((backlog?.items || []).map((item) => [item.id, item]));
  const rows = all.map((g) => {
    const b = ageByRule.get(g.id);
    const age = b ? `${b.runsPresent}${b.openEnded ? '+' : ''}` : '—';
    const change = b ? (b.changePercent === null ? '—' : `${b.changePercent > 0 ? '+' : ''}${b.changePercent}%`) : '—';
    return [
      tsvEscape(g.label),
      g.severity,
      g.scope || 'page',
      String(g.urls.length),
      age,
      change,
      '', // Owner — left blank for manual assignment once pasted
    ].join('\t');
  });
  return [header.join('\t'), ...rows].join('\n');
}

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  ['url', 'URL'],
  ['pageCategory', 'Category'],
  ['status', 'Status'],
  ['statusText', 'Status text'],
  ['contentType', 'Content type'],
  ['indexability', 'Indexability'],
  ['indexabilityStatus', 'Indexability detail'],
  ['title', 'Page title'],
  ['titleLength', 'Title length'],
  ['metaDescription', 'Meta description'],
  ['metaLength', 'Meta description length'],
  ['h1', 'H1'],
  ['h1Count', 'H1 count'],
  ['words', 'Word count'],
  ['size', 'Size (bytes)'],
  ['responseTime', 'Response time (ms)'],
  ['clickDepth', 'Click depth'],
  ['inlinks', 'Inlinks'],
  ['outlinks', 'Outlinks'],
  ['externalLinks', 'External links'],
  ['canonical', 'Canonical URL'],
  ['redirectUrl', 'Redirect destination'],
  ['sourceUrl', 'Discovered from'],
];

// Excel reads a leading =, +, - or @ as a formula, so any cell starting with one
// is prefixed with a quote. Without this a URL in a spreadsheet can execute.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// The fewest links from the start page, once the crawl has been analysed (null:
// no followable link reaches the page). A crawl analysed before click depth
// existed only has the order the crawler found the page in.
function clickDepthCell(result) {
  if (result.clickDepth === undefined) return result.depth;
  return result.clickDepth === null ? 'not linked' : result.clickDepth;
}

export function toCsv(results) {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const rows = results.map((result) => {
    const cells = CSV_COLUMNS.map(([key]) => csvCell(key === 'clickDepth' ? clickDepthCell(result) : result[key]));
    const issues = (result.issues || []).map((i) => i.label).join('; ');
    return [...cells, csvCell(issues)].join(',');
  });
  return [`${header},${csvCell('Issues')}`, ...rows].join('\r\n');
}

// ── Schedule formatting ─────────────────────────────────────────────────────
export const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

export const TIMEZONES = [
  { id: 'America/Chicago', label: 'Central (America/Chicago)' },
  { id: 'America/New_York', label: 'Eastern (America/New_York)' },
  { id: 'America/Denver', label: 'Mountain (America/Denver)' },
  { id: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { id: 'Europe/London', label: 'UK (Europe/London)' },
  { id: 'Asia/Kolkata', label: 'India (Asia/Kolkata)' },
  { id: 'UTC', label: 'UTC' },
];

// The day-of-week + hour a given instant falls on, read in a specific IANA
// timezone — `Date#getDay`/`getHours` only ever answer for the browser's own
// zone, which is wrong here: a schedule's day/hour picker is local to the
// timezone the project itself picks, not to whoever happens to be filling
// out the form. Used to default a new project's schedule to the day/time its
// first report was (or, with no run yet, will be) generated — see
// ProjectForm.jsx.
export function dayAndHourInTimezone(instant, timezone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return { dayOfWeek: 0, hour: 0 };
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const dayOfWeek = DAY_NAMES.findIndex((d) => d.startsWith(weekday));
    return {
      dayOfWeek: dayOfWeek >= 0 ? dayOfWeek : date.getDay(),
      hour: Number.isFinite(hour) ? hour % 24 : date.getHours(),
    };
  } catch {
    return { dayOfWeek: date.getDay(), hour: date.getHours() };
  }
}

export function hour12Label(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return '';
  if (h === 0) return '12:00 AM';
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return '12:00 PM';
  return `${h - 12}:00 PM`;
}

// Only weekly "minute hour * * day" expressions round-trip through the pickers;
// anything hand-written is shown verbatim rather than mis-described.
export function parseWeeklyCron(cron) {
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*') return null;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || !/^\d+$/.test(dow)) return null;
  return { minute: Number(minute), hour: Number(hour), dayOfWeek: Number(dow) };
}

export function describeSchedule(project) {
  const parsed = parseWeeklyCron(project?.cron);
  if (!parsed) return project?.cron || '—';
  const day = DAY_NAMES[parsed.dayOfWeek] || `day ${parsed.dayOfWeek}`;
  const zone = (project.timezone || 'UTC').split('/').pop().replace(/_/g, ' ');
  return `${day}s at ${hour12Label(parsed.hour)} ${zone}`;
}

export function formatInTimezone(instant, timezone) {
  if (!instant) return '—';
  try {
    return new Date(instant).toLocaleString(undefined, {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(instant).toLocaleString();
  }
}

// ── Run status ──────────────────────────────────────────────────────────────
export const TERMINAL_STATUSES = ['completed', 'failed', 'stopped'];

export function runStatusVariant(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'stopped') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}

// Crawls with these triggers are executed by the worker, so they are the ones
// that produce an emailed report.
export const WORKER_EXECUTED_TRIGGERS = ['schedule', 'initial'];

// ── Crawl option defaults ───────────────────────────────────────────────────
// Mirrors parseCrawlRequest in server/modules/crawlScope/shared/options.js. The
// server clamps against operator ceilings regardless of what is sent, so these
// are starting points for the form, not limits.
export const DEFAULT_OPTIONS = {
  maxUrls: 500,
  maxExternalUrls: 500,
  concurrency: 4,
  timeout: 15000,
  perHostDelay: 250,
  respectRobots: true,
  includeSubdomains: false,
  crawlAssets: true,
  checkExternalLinks: true,
  discoverSitemaps: true,
};
