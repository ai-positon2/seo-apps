import { useEffect, useState } from 'react';
import { projectsApi } from './projectsApi';
import { useActiveProjectId, useProjectsChanged } from './activeProject';

// ── The header's project, as an object ──────────────────────────────────────
//
// Tools that follow the header (docs/design-audit/02-plan-one-client.md) need
// the selected project's name and domain, not just its id. One shared read of
// /api/projects per page session, refreshed when the set of projects changes,
// so a page with several such tools does not fetch the list once per tool.

let cache = null; // { version, promise }

function loadProjects(version) {
  if (!cache || cache.version !== version) {
    cache = {
      version,
      promise: projectsApi.list()
        .then((res) => (res.projects || []).filter((p) => p.lifecycleStatus !== 'deleted'))
        .catch(() => { cache = null; return []; }),
    };
  }
  return cache.promise;
}

/**
 * @returns {{ project: object|null, projects: object[], loaded: boolean }}
 *   `project` is the header's client resolved against the server's list (or
 *   the first accessible one, as the header itself falls back).
 */
export function useActiveProject() {
  const [activeId] = useActiveProjectId();
  const version = useProjectsChanged();
  const [projects, setProjects] = useState(null);

  useEffect(() => {
    let alive = true;
    loadProjects(version).then((list) => { if (alive) setProjects(list); });
    return () => { alive = false; };
  }, [version]);

  const list = projects || [];
  const project = list.find((p) => p.id === activeId) || list[0] || null;
  return { project, projects: list, loaded: projects !== null };
}
