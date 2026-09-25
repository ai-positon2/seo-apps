// ── Matching the header's project to a tool's own client list ────────────────
//
// Several tools still keep a client list of their own (docs/design-audit/
// 02-plan-one-client.md). Until those lists carry a project reference, the
// header's project is matched to them by name and domain, the same way
// Competitor Analysis already matches its tracker clients. Pure and
// dependency-free so it can be tested with the node runner.

/** "Riccobene Associates" → "riccobene-associates"; "www.gentledental.com" → "gentledental". */
export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.[a-z.]{2,}(\/.*)?$/, '') // drop the TLD and any path from a host
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Host without scheme, www. or path: "https://www.Brushandfloss.com/" → "brushandfloss.com". */
export function hostKey(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

/**
 * The entry in `candidates` (slugs such as "gentle-dental") that belongs to
 * this project, or null. Tries the project's name, then its primary domain,
 * each both exactly and as a prefix ("riccobene" matches a project named
 * "Riccobene Associates Family Dentistry").
 *
 * @param {{ name?: string, primaryDomain?: { host?: string } }} project
 * @param {string[]} candidates
 */
export function matchClientSlug(project, candidates) {
  if (!project || !Array.isArray(candidates) || !candidates.length) return null;
  const keys = [slugify(project.name), slugify(project.primaryDomain?.host)].filter(Boolean);
  const squash = (s) => s.replace(/-/g, '');
  for (const key of keys) {
    const exact = candidates.find((c) => c && (c === key || squash(c) === squash(key)));
    if (exact) return exact;
  }
  for (const key of keys) {
    const prefix = candidates.find((c) => c && c.length >= 4
      && (key.startsWith(`${c}-`) || squash(key).startsWith(squash(c))));
    if (prefix) return prefix;
  }
  return null;
}
