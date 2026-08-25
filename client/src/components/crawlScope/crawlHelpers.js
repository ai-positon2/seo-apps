// Pure display logic for the CrawlScope screens, ported from the standalone
// app's renderer (src/renderer/app.js). Kept in one place, and kept pure, so the
// React pages stay about layout and the numbers stay identical to what the
// desktop app produced — the health score in particular is a published figure
// and must not drift because it was reimplemented.

export const PAGE_SIZE = 100;

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
    ['url', 'URL', '34%'],
    ['contentType', 'Content type', '120px'],
    ['title', 'Page title', '24%'],
    ['indexability', 'Indexability', '100px'],
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
    ['url', 'URL', '28%'],
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

// ── Filtering ───────────────────────────────────────────────────────────────
export function filterResults(results, { tab = 'all', issueFilter = '', filter = '', query = '' } = {}) {
  let values = results;

  if (tab === 'issues') {
    values = values.filter((item) => item.issues?.length);
  } else if (tab === 'metadata') {
    values = values.filter((item) => item.contentType?.includes('text/html'));
  }

  if (issueFilter) {
    values = values.filter((item) => (item.issues || []).some((issue) => issue.id === issueFilter));
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
  const htmlResults = internalResults.filter((item) => item.contentType?.includes('text/html'));
  const activeFindings = findings.filter((f) => !DISMISSED.includes(f.reviewStatus));
  const useFindings = findings.length > 0;

  const countBySeverity = (severity) =>
    useFindings
      ? activeFindings.filter((f) => f.severity === severity).length
      : internalResults.reduce(
          (sum, item) => sum + (item.issues || []).filter((i) => i.severity === severity).length,
          0,
        );

  const affectedPages = (severity) =>
    new Set(
      useFindings
        ? activeFindings.filter((f) => f.severity === severity).map((f) => f.url)
        : internalResults
            .filter((item) => (item.issues || []).some((i) => i.severity === severity))
            .map((item) => item.url),
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
    affectedErrorPages,
    affectedWarningPages,
    affectedNoticePages,
  };
}

// Plain-language breakdown so a health score is never an unexplained number.
// Points lost mirror the weights above exactly.
export function healthScoreExplanation(metrics) {
  if (!metrics || metrics.health === null) return 'Run a crawl to calculate site health.';
  const denominator = Math.max(metrics.htmlCount, 1);
  const lost = (pages, weight) => Math.round((pages / denominator) * weight);
  const parts = [];
  if (metrics.affectedErrorPages) {
    parts.push(`−${lost(metrics.affectedErrorPages, 45)} from ${metrics.affectedErrorPages} page(s) with errors`);
  }
  if (metrics.affectedWarningPages) {
    parts.push(`−${lost(metrics.affectedWarningPages, 22)} from ${metrics.affectedWarningPages} page(s) with warnings`);
  }
  if (metrics.affectedNoticePages) {
    parts.push(`−${lost(metrics.affectedNoticePages, 8)} from ${metrics.affectedNoticePages} page(s) with notices`);
  }
  if (!parts.length) return 'No issues found — a clean 100.';
  return `Starting from 100: ${parts.join(', ')}.`;
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

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  ['url', 'URL'],
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
  ['depth', 'Crawl depth'],
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

export function toCsv(results) {
  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const rows = results.map((result) => {
    const cells = CSV_COLUMNS.map(([key]) => csvCell(result[key]));
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
  maxExternalUrls: 150,
  concurrency: 4,
  timeout: 15000,
  perHostDelay: 250,
  respectRobots: true,
  includeSubdomains: false,
  crawlAssets: true,
  checkExternalLinks: true,
  discoverSitemaps: true,
};
