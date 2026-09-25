import { useEffect, useState } from 'react';
import { projectsApi } from './projectsApi';
import { humanRunLabel } from './humanRunLabel';

// ── Readable "Ran on" labels ────────────────────────────────────────────────
//
// Run tracking records what a run targeted as it saw it on the server —
// "project 8f6473f6-…", "run 372bfc54-…", "client client_mu6uey…". Those are
// row ids, not something a person recognises. The history is kept as written;
// this only changes how a label is shown, so old and new rows both read well.

let namesPromise = null;

/** Project id → name, loaded once per page session and shared by every list. */
function loadProjectNames() {
  if (!namesPromise) {
    namesPromise = projectsApi.list()
      .then((res) => new Map((res.projects || []).map((p) => [p.id, p.name])))
      .catch(() => { namesPromise = null; return new Map(); });
  }
  return namesPromise;
}

export function useProjectNames() {
  const [names, setNames] = useState(null);
  useEffect(() => {
    let alive = true;
    loadProjectNames().then((m) => { if (alive) setNames(m); });
    return () => { alive = false; };
  }, []);
  return names;
}

export { humanRunLabel };
