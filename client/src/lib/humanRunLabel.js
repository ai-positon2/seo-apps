// Pure, dependency-free so the node test runner can load it (see runLabel.js
// for the hook that supplies project names).

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROJECT_RE = new RegExp(`^project (${UUID})$`, 'i');
const RUN_RE = new RegExp(`^run (${UUID})$`, 'i');
const CLIENT_RE = /^client (client_[a-z0-9_]+)$/i;

/**
 * @param {string} label       the stored run label
 * @param {Map<string,string>} [projectNames]  project id → name
 * @returns {string} what to show a person
 */
export function humanRunLabel(label, projectNames) {
  const text = String(label || '').trim();
  if (!text) return text;

  const project = text.match(PROJECT_RE);
  if (project) {
    const name = projectNames && projectNames.get(project[1]);
    return name ? `${name} (whole site)` : 'A client project (whole site)';
  }
  if (RUN_RE.test(text)) return 'An earlier crawl';
  if (CLIENT_RE.test(text)) return 'A tracked competitor set';
  return text;
}

// ── Statuses and actions people can read ────────────────────────────────────
// Run rows store lowercase enums ('completed', 'queue', 'run-manual'). These
// are what a badge or a column shows instead; the stored value is unchanged.

const STATUS_LABELS = {
  queued: 'Waiting to start',
  running: 'Running',
  paused: 'Paused',
  completed: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
};

const ACTION_LABELS = {
  run: 'Ran',
  'run-manual': 'Ran',
  create: 'Created',
  save: 'Saved',
  delete: 'Deleted',
  toggle: 'Paused or resumed',
  export: 'Downloaded',
  queue: 'Scheduled',
  discover: 'Discovered',
  summary: 'Summarised',
  keywords: 'Researched keywords',
  'ls-keywords': 'Researched keywords',
  content: 'Wrote content',
  'ls-content': 'Wrote content',
  'ls-brief': 'Wrote a brief',
  'ls-regen': 'Rewrote content',
  'regen-field': 'Rewrote a section',
  'content-analysis': 'Analysed content',
  'draft-clusters': 'Drafted topics',
  'page-speed': 'Checked page speed',
  qa: 'Checked quality',
  wizard: 'Generated',
};

function sentenceCase(value) {
  const words = String(value || '').trim().replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 'completed' → 'Finished'. Unknown values are sentence-cased, never hidden. */
export function humanRunStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  return STATUS_LABELS[key] || sentenceCase(key);
}

/** 'export' → 'Downloaded'. A missing action is a plain run. */
export function humanRunAction(action) {
  const key = String(action || 'run').trim().toLowerCase();
  return ACTION_LABELS[key] || sentenceCase(key);
}
