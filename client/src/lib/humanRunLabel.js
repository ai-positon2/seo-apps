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
