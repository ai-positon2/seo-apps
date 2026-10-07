// The Projects page headline: live projects only, so it agrees with the Team
// page. Soft-deleted projects stay in the list (greyed, recoverable), so they
// are mentioned after the count rather than folded into it.
export function projectCountText(projects) {
  const deleted = projects.filter(p => p.lifecycleStatus === 'deleted').length;
  const live = projects.length - deleted;
  const head = `${live} project${live === 1 ? '' : 's'} in this workspace`;
  return deleted ? `${head}, plus ${deleted} deleted` : head;
}
