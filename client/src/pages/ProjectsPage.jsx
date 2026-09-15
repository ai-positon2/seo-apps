import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsApi, relativeTime, countryLabel } from '../lib/projectsApi';
import { setActiveProjectId } from '../lib/activeProject';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner,
} from '../components/studio/primitives';
import ProjectSetupCard from '../components/home/ProjectSetupCard';
import ModuleRuns from '../components/ModuleRuns';

// ── Projects — settings (PRD §20.9) ─────────────────────────────────────────
// Primary domain, country, competitors, schedule, verification and the robots
// policy for one project. Which controls are even rendered comes from the
// capability map the server sent (§7.2); the server re-checks every one of them
// on the write, so this gating is convenience, not security.

const inputStyle = {
  minHeight: 34,
  padding: '6px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  outline: 'none',
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [selectedId, setSelectedId] = useState(null);
  const [showSetup, setShowSetup] = useState(false);
  const [banner, setBanner] = useState(null);   // { tone, text }

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await projectsApi.list({ includeDeleted: true });
      setState({ loading: false, error: null, data });
      return data;
    } catch (e) {
      setState({ loading: false, error: e, data: null });
      return null;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const projects = state.data?.projects || [];
  const capabilities = state.data?.capabilities || {};
  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) || projects[0] || null,
    [projects, selectedId],
  );

  async function mutate(fn, successText) {
    setBanner(null);
    try {
      const result = await fn();
      await load();
      // successText may depend on what the server actually did (e.g. discovery
      // — added N vs. proposed vs. found none — isn't known until it returns).
      const text = typeof successText === 'function' ? successText(result) : successText;
      if (text) setBanner({ tone: 'accent', text });
    } catch (e) {
      setBanner({ tone: 'neg', text: e.message });
    }
  }

  if (state.loading) return <div style={{ padding: 24 }}><Spinner label="Loading projects…" /></div>;

  if (state.error) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 640 }}>
        <Card style={{ padding: 20, gap: 8 }}>
          <Kicker tone="muted">Projects unavailable</Kicker>
          <Muted size={13}>{state.error.message}</Muted>
          <div><Btn variant="primary" onClick={load}>Try again</Btn></div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Kicker>Workspace</Kicker>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.015em' }}>Projects</h1>
          <Muted size={13}>
            {projects.length} project{projects.length === 1 ? '' : 's'} in this workspace. Access is
            by workspace membership — your role here is{' '}
            <strong style={{ color: 'var(--text-2)' }}>{state.data?.workspaces?.find((w) => w.id === state.data.activeWorkspaceId)?.myRole || 'contributor'}</strong>.
          </Muted>
        </div>
        {capabilities.createProject && (
          <Btn variant="primary" onClick={() => setShowSetup((v) => !v)}>
            {showSetup ? 'Close' : 'New project'}
          </Btn>
        )}
      </div>

      {banner && (
        <div
          role="status"
          style={{
            padding: 12, borderRadius: 'var(--r-md)', fontSize: 13,
            background: `color-mix(in srgb, var(--${banner.tone === 'neg' ? 'viz-neg' : 'primary'}) 12%, transparent)`,
            border: `1px solid color-mix(in srgb, var(--${banner.tone === 'neg' ? 'viz-neg' : 'primary'}) 40%, transparent)`,
            color: banner.tone === 'neg' ? 'var(--viz-neg)' : 'var(--primary-text)',
          }}
        >
          {banner.text}
        </div>
      )}

      {showSetup && (
        <ProjectSetupCard
          limits={state.data?.limits}
          workspaces={state.data?.workspaces || []}
          activeWorkspaceId={state.data?.activeWorkspaceId || null}
          onCreated={async (project, competitorResearch) => {
            setShowSetup(false);
            setSelectedId(project.id);
            await load();
            setBanner({
              tone: 'accent',
              text: `${project.name} created. Its weekly schedule is off until you enable it. `
                + `${competitorResearch?.note || ''}`.trim(),
            });
          }}
          onCancel={() => setShowSetup(false)}
        />
      )}

      {!projects.length && !showSetup && (
        <Card style={{ padding: 20, gap: 8 }}>
          <Muted size={13}>No projects in this workspace yet.</Muted>
        </Card>
      )}

      {projects.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
          {/* Project list */}
          <Card style={{ padding: 8, gap: 2 }}>
            {projects.map((project) => {
              const active = selected?.id === project.id;
              const deleted = project.lifecycleStatus === 'deleted';
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedId(project.id)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', border: 'none',
                    background: active ? 'var(--nav-active-bg)' : 'transparent',
                    color: 'var(--text)', padding: '9px 10px', borderRadius: 'var(--r-sm)',
                    display: 'flex', flexDirection: 'column', gap: 2,
                    fontFamily: 'var(--font-sans)', opacity: deleted ? 0.55 : 1,
                  }}
                >
                  <span style={{ fontSize: 13.5, fontWeight: active ? 600 : 400 }}>{project.name}</span>
                  <Muted>
                    {project.primaryDomain?.host || project.legacyUrl}
                    {deleted && ' · deleted'}
                  </Muted>
                </button>
              );
            })}
          </Card>

          {selected && (
            <ProjectDetail
              /* Keyed, so switching projects REMOUNTS this rather than reusing
                 it. Without it every piece of local state belonged to whichever
                 project was opened first: the name field kept the old name, and
                 the permanent-delete confirmation stayed open with the previous
                 project's name typed into it, sitting armed in front of a
                 different project. The server's own name check meant the wrong
                 project could never actually be destroyed, but nothing on the
                 screen said so. */
              key={selected.id}
              project={selected}
              capabilities={capabilities}
              /* `capabilities` is workspace-wide; whether this particular
                 project is editable also depends on who created it (the server
                 grants its creator editProjectSettings on their own project).
                 Passing the viewer's id lets the panel ask the same question
                 the server will answer, instead of offering a control that
                 403s or hiding one that would have worked. */
              viewerUserId={state.data?.viewerUserId || null}
              onMutate={mutate}
              // The homepage reads which client to show from localStorage
              // (activeProject.js), not from anything in this URL — so
              // navigating here without setting it first opened whichever
              // project was already active, not the one on screen.
              onOpenDashboard={() => { setActiveProjectId(selected.id); navigate('/'); }}
            />
          )}
        </div>
      )}

      {/* Project creation, in the shared run history.
          The other way to create a project — the Site Crawler's form — has
          always recorded a run here, so the same act was visible or invisible
          depending on which door it came through. Both are tracked now, and
          this is where the ones created from this screen show up.
          Distinct from the per-project History card, which is that project's own
          audit trail; this is the cross-project record of the act. */}
      <ModuleRuns
        toolId="projects"
        title="Projects created"
        scopeNote="Creating a project from this screen or the Site Crawler's form."
        style={{ marginTop: 28 }}
      />
    </div>
  );
}

function ProjectDetail({ project, capabilities, viewerUserId, onMutate, onOpenDashboard }) {
  const [name, setName] = useState(project.name);
  const [country, setCountry] = useState(project.countryCode || '');
  const [competitor, setCompetitor] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [reason, setReason] = useState('');
  // Permanent deletion is behind a two-step: `purging` reveals the confirmation,
  // `purgeName` is the typed project name the server checks. Both reset when the
  // selection changes, so a half-finished confirmation can never carry over to a
  // different project.
  const [purging, setPurging] = useState(false);
  const [purgeName, setPurgeName] = useState('');
  // Changing the primary domain is behind a Change button, because it clears
  // site verification and any robots override. A project that has NO primary
  // domain skips that step — there is nothing to lose and the whole point is
  // that the repair is immediate — and the field opens pre-filled with the URL
  // the crawler has been using.
  const [editingDomain, setEditingDomain] = useState(false);
  const [primaryDomainInput, setPrimaryDomainInput] = useState(
    project.primaryDomain?.origin || project.legacyUrl || '',
  );
  // One row per targeted page. Keywords are per page, so this is a list of
  // { url, keywords } rather than a single field — the implants page and the
  // pricing page do not share a target term.
  const [pages, setPages] = useState(() => (project.pages || []).map((p) => ({
    url: p.url, keywords: (p.keywords || []).join(', '),
  })));

  // Reset the form when the selected project changes, or the fields keep the
  // previous project's values and a save would write them to the wrong site.
  useEffect(() => {
    setName(project.name);
    setCountry(project.countryCode || '');
    setCompetitor('');
    setReason('');
    setPurging(false);
    setPurgeName('');
    setEditingDomain(false);
    setPrimaryDomainInput(project.primaryDomain?.origin || project.legacyUrl || '');
    setPages((project.pages || []).map((p) => ({
      url: p.url, keywords: (p.keywords || []).join(', '),
    })));
  }, [
    project.id, project.name, project.countryCode, project.pages,
    // Included so the field re-syncs after a successful change, rather than
    // holding what was typed while the tag above it shows the new domain.
    project.primaryDomain?.origin, project.legacyUrl,
  ]);

  // Mirrors projectAccess.applyCreatorGrant on the server: an approver and above
  // may edit any project in the workspace, and whoever created a project may
  // edit that one whatever their role — otherwise a contributor who added a
  // client could not correct its name or country without asking someone else.
  const isCreator = Boolean(viewerUserId && project.createdBy === viewerUserId);
  const canEdit = capabilities.editProjectSettings === true || isCreator;
  const canManageCompetitors = Boolean(capabilities.manageCompetitors);
  const proposeOnly = capabilities.manageCompetitors === 'propose';
  // Only the full verdict decides a proposal — 'propose' is what creates one.
  const canDecideProposals = capabilities.manageCompetitors === true;
  const proposedCompetitors = project.proposedCompetitors || [];
  const weekly = project.schedule.weekly;
  const deleted = project.lifecycleStatus === 'deleted';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Identity */}
      <Card style={{ padding: 18, gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Kicker>Project</Kicker>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 500 }}>{project.name}</h2>
            <Muted size={12}>
              Created {relativeTime(project.createdAt)} · primary domain read from{' '}
              {project.primaryDomainSource === 'project_domains' ? 'project_domains' : 'the legacy url column'}
            </Muted>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {deleted && <Tag tone="neg">Deleted</Tag>}
            {project.siteVerifiedAt ? <Tag tone="accent">Site verified</Tag> : <Tag tone="muted">Not verified</Tag>}
            {project.robotsOverride && <Tag tone="warn">robots.txt overridden</Tag>}
            <Btn onClick={onOpenDashboard} style={{ height: 30, fontSize: 12, padding: '0 12px' }}>
              Open dashboard
            </Btn>
          </div>
        </div>

        <FadingRule />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Name</span>
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Country {project.countryMissing && <span style={{ color: 'var(--viz-warn)' }}>· required</span>}
            </span>
            <input
              style={inputStyle}
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              placeholder="US"
              maxLength={24}
              disabled={!canEdit}
            />
            <Muted>
              {project.countryCode
                ? `${countryLabel(project.countryCode)} — every rank and Search Console comparison uses this market.`
                : 'ISO 3166-1 alpha-2, or a country name.'}
            </Muted>
          </label>
        </div>

        {canEdit && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn
              variant="primary"
              disabled={name === project.name && country === (project.countryCode || '')}
              onClick={() => onMutate(
                () => projectsApi.update(project.id, { name, country: country || undefined }),
                'Project updated.',
              )}
            >
              Save changes
            </Btn>
          </div>
        )}
      </Card>

      {/* Target pages and their keywords */}
      <Card style={{ padding: 18, gap: 12 }}>
        <SectionHead
          title="Target pages"
          right={`${pages.length} page${pages.length === 1 ? '' : 's'} · the primary domain is always audited`}
        />
        <Muted size={12.5}>
          Keywords are per page. The On-Page audit checks where a page's own keyword appears — in its
          URL, title, H1, H2s and body — so each page needs its own. A page left without one is
          still audited in full; only the keyword-placement checks stand down for it, and the report
          says how many were skipped. No keyword is ever guessed from a slug or heading, because
          every one of those checks would then be scored against a term nobody chose.
        </Muted>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!pages.length && (
            <Muted size={12}>
              No pages configured. Only the primary domain will be audited, with no keyword.
            </Muted>
          )}
          {pages.map((page, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                style={{ ...inputStyle, flex: '2 1 240px' }}
                value={page.url}
                onChange={(e) => setPages(pages.map((p, i) => (i === index ? { ...p, url: e.target.value } : p)))}
                placeholder="https://example.com/services/implants"
                disabled={!canEdit}
                aria-label={`Page ${index + 1} URL`}
              />
              <input
                style={{ ...inputStyle, flex: '2 1 200px' }}
                value={page.keywords}
                onChange={(e) => setPages(pages.map((p, i) => (i === index ? { ...p, keywords: e.target.value } : p)))}
                placeholder="dental implants (optional)"
                disabled={!canEdit}
                aria-label={`Page ${index + 1} keywords`}
              />
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove page ${index + 1}`}
                  onClick={() => setPages(pages.filter((_, i) => i !== index))}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px',
                    color: 'var(--text-3)', fontSize: 16, lineHeight: 1,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn onClick={() => setPages([...pages, { url: '', keywords: '' }])}>Add a page</Btn>
            <Btn
              variant="primary"
              disabled={
                JSON.stringify(pages)
                === JSON.stringify((project.pages || []).map((p) => ({
                  url: p.url, keywords: (p.keywords || []).join(', '),
                })))
              }
              onClick={() => onMutate(
                () => projectsApi.update(project.id, {
                  pages: pages
                    .filter((p) => p.url.trim())
                    .map((p) => ({
                      url: p.url.trim(),
                      keywords: p.keywords.split(',').map((k) => k.trim()).filter(Boolean),
                    })),
                }),
                'Target pages saved.',
              )}
            >
              Save pages
            </Btn>
            <Muted style={{ alignSelf: 'center' }}>
              Up to 10 pages per audit — each one is a fetch plus a PageSpeed call.
            </Muted>
          </div>
        )}
      </Card>

      {/* Domains */}
      <Card style={{ padding: 18, gap: 12 }}>
        <SectionHead title="Domains" right={`${project.competitors.length} competitor${project.competitors.length === 1 ? '' : 's'}`} />

        {/* Primary domain.
            This was read-only: the API and the store function to change it both
            existed, and no screen called either. A project created by the Site
            Crawler wrote no project_domains row at all, so it rendered "Missing"
            permanently with nothing on the page able to fix it. The setter below
            is that missing control. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Muted>Primary</Muted>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {project.primaryDomain
              ? <Tag tone="outline">{project.primaryDomain.origin}</Tag>
              : <Tag tone="warn">Missing — the crawler is using {project.legacyUrl}</Tag>}
            {project.primaryDomain?.source === 'backfill' && (
              <Muted>migrated from the previous schema</Muted>
            )}
            {canEdit && project.primaryDomain && !editingDomain && (
              <Btn onClick={() => setEditingDomain(true)}>Change</Btn>
            )}
          </div>

          {/* A missing domain opens straight into the setter, pre-filled with
              whatever the crawler has been using: the fix is one click from the
              problem, not somewhere else. */}
          {canEdit && (!project.primaryDomain || editingDomain) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  id={`primary-domain-${project.id}`}
                  style={{ ...inputStyle, minWidth: 260, flex: 1 }}
                  value={primaryDomainInput}
                  onChange={(e) => setPrimaryDomainInput(e.target.value)}
                  placeholder="gentledental.com"
                  aria-label="Primary domain"
                />
                <Btn
                  variant="primary"
                  disabled={
                    !primaryDomainInput.trim()
                    || primaryDomainInput.trim() === project.primaryDomain?.origin
                  }
                  onClick={() => onMutate(
                    async () => {
                      const result = await projectsApi.setPrimaryDomain(
                        project.id, primaryDomainInput.trim(),
                        'Set from project settings',
                      );
                      setEditingDomain(false);
                      return result;
                    },
                    (result) => `Primary domain set. ${result?.competitorResearch?.note || ''}`.trim(),
                  )}
                >
                  {project.primaryDomain ? 'Change domain' : 'Set domain'}
                </Btn>
                {project.primaryDomain && (
                  <Btn onClick={() => { setEditingDomain(false); setPrimaryDomainInput(project.primaryDomain?.origin || ''); }}>
                    Cancel
                  </Btn>
                )}
              </div>

              {/* Stating what the server already does, before it does it. Both
                  are cleared because they described the previous site. */}
              <Muted size={11}>
                {project.primaryDomain
                  ? 'Changing the domain clears this project’s site verification and any robots.txt override — they applied to the previous site. The weekly crawl re-points to the new one.'
                  : 'This is the site every audit and score on this project describes. Pre-filled with the URL the crawler has been using.'}
              </Muted>
            </div>
          )}

          {!canEdit && !project.primaryDomain && (
            <Muted size={11}>
              An approver or administrator can set this — or whoever created the project.
            </Muted>
          )}
        </div>

        <FadingRule />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Muted>Competitors — used for comparative evidence only; their sites are never crawled.</Muted>

          {/* Awaiting a decision.
              A contributor can only PROPOSE a competitor, and until now the row
              they wrote was filtered out of every read — proposed, then
              invisible to everyone including the person who proposed it. It
              shows above the tracked list because it is the part with something
              outstanding. */}
          {proposedCompetitors.length > 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              padding: '10px 12px', borderRadius: 'var(--r-md)',
              border: '1px solid color-mix(in srgb, var(--viz-warn, #d97706) 35%, transparent)',
              background: 'color-mix(in srgb, var(--viz-warn, #d97706) 8%, transparent)',
            }}>
              <Muted size={12}>
                {canDecideProposals
                  ? `Awaiting your decision — ${proposedCompetitors.length} proposed competitor${proposedCompetitors.length === 1 ? '' : 's'}. Accepting one starts a comparison against it, which spends SEMrush units.`
                  : `Proposed — waiting for an approver or administrator to accept. ${proposedCompetitors.length === 1 ? 'It is' : 'They are'} not tracked yet.`}
              </Muted>

              {proposedCompetitors.map((domain) => (
                <div key={domain.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                }}>
                  <Tag tone="warn">{domain.host}</Tag>
                  {canDecideProposals && (
                    <>
                      <Btn
                        onClick={() => onMutate(
                          () => projectsApi.approveCompetitor(project.id, domain.id),
                          (result) => result?.message || `${domain.host} is now tracked.`,
                        )}
                      >
                        Approve
                      </Btn>
                      <Btn
                        onClick={() => onMutate(
                          () => projectsApi.rejectCompetitor(project.id, domain.id),
                          (result) => result?.message || `${domain.host} was not accepted.`,
                        )}
                      >
                        Reject
                      </Btn>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!project.competitors.length && <Muted size={12}>None tracked.</Muted>}
            {project.competitors.map((domain) => (
              <span key={domain.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Tag tone="muted">{domain.host}</Tag>
                {canManageCompetitors && !proposeOnly && (
                  <button
                    type="button"
                    aria-label={`Remove ${domain.host}`}
                    onClick={() => onMutate(
                      () => projectsApi.removeDomain(project.id, domain.id, 'Removed from project settings'),
                      `${domain.host} removed.`,
                    )}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                      color: 'var(--text-3)', fontSize: 14, lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>

          {canManageCompetitors && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                style={{ ...inputStyle, minWidth: 220 }}
                value={competitor}
                onChange={(e) => setCompetitor(e.target.value)}
                placeholder="aspendental.com"
              />
              <Btn
                disabled={!competitor.trim()}
                onClick={() => onMutate(async () => {
                  const result = await projectsApi.addCompetitor(project.id, competitor.trim());
                  setCompetitor('');
                  return result;
                }, (result) => {
                  if (proposeOnly) return 'Competitor proposed for approval.';
                  // Adding a competitor starts the comparison by itself, and it
                  // bills per domain — so the banner says what was started, not
                  // just that a row was written.
                  return `Competitor added. ${result?.competitorResearch?.note || ''}`.trim();
                })}
              >
                {proposeOnly ? 'Propose competitor' : 'Add competitor'}
              </Btn>
              {proposeOnly && <Muted>Your role can propose; an approver applies it.</Muted>}
            </div>
          )}

          {canManageCompetitors && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Btn
                disabled={discovering}
                onClick={async () => {
                  setDiscovering(true);
                  await onMutate(
                    () => projectsApi.discoverCompetitors(project.id),
                    (result) => result.message,
                  );
                  setDiscovering(false);
                }}
              >
                {discovering ? 'Finding…' : 'Find competitors with AI'}
              </Btn>
              <Muted>
                SEMrush + AI suggest domains for this site and add them the same way a typed-in
                competitor is added{proposeOnly
                  ? ' (proposed, pending approval)'
                  : ', which starts a comparison against them'}.
              </Muted>
            </div>
          )}
        </div>
      </Card>

      {/* Schedule */}
      <Card style={{ padding: 18, gap: 12 }}>
        <SectionHead
          title="Crawl schedule"
          right={project.schedule.nextRunAt ? `Next run ${relativeTime(project.schedule.nextRunAt)}` : 'Not scheduled'}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {project.schedule.enabled ? <Tag tone="accent">Enabled</Tag> : <Tag tone="muted">Disabled</Tag>}
          <Muted size={12.5}>
            {weekly
              ? `Weekly · ${DAY_NAMES[weekly.dayOfWeek]} at ${String(weekly.hour).padStart(2, '0')}:${String(weekly.minute).padStart(2, '0')} ${project.schedule.timezone}`
              : `Custom cron "${project.schedule.cron}" · ${project.schedule.timezone}`}
          </Muted>
          {project.schedule.lastRunAt && <Muted>Last run {relativeTime(project.schedule.lastRunAt)}</Muted>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn
              onClick={() => onMutate(
                () => projectsApi.update(project.id, { enabled: !project.schedule.enabled }),
                project.schedule.enabled ? 'Schedule disabled.' : 'Schedule enabled — the next weekly crawl is queued.',
              )}
            >
              {project.schedule.enabled ? 'Disable weekly crawl' : 'Enable weekly crawl'}
            </Btn>
          </div>
        )}
      </Card>

      {/* Crawl policy */}
      {(capabilities.overrideRobotsPolicy || project.robotsOverride) && (
        <Card style={{ padding: 18, gap: 12 }}>
          <SectionHead title="Crawl policy" right="robots.txt is obeyed by default" />
          <Muted size={12.5}>
            An override applies only to a verified primary site, needs a reason, and is written to the
            audit log. Changing the primary domain clears both the verification and the override.
          </Muted>

          {!project.siteVerifiedAt && canEdit && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                style={{ ...inputStyle, minWidth: 260, flex: 1 }}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="How was ownership confirmed?"
              />
              <Btn
                disabled={!reason.trim()}
                onClick={() => onMutate(
                  () => projectsApi.verifySite(project.id, reason.trim()),
                  'Site ownership recorded.',
                )}
              >
                Record verification
              </Btn>
            </div>
          )}

          {project.siteVerifiedAt && capabilities.overrideRobotsPolicy && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {!project.robotsOverride && (
                <input
                  style={{ ...inputStyle, minWidth: 260, flex: 1 }}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is the override needed?"
                />
              )}
              <Btn
                variant={project.robotsOverride ? 'secondary' : 'danger'}
                disabled={!project.robotsOverride && !reason.trim()}
                onClick={() => onMutate(
                  () => projectsApi.setRobotsOverride(project.id, !project.robotsOverride, reason.trim() || 'Override removed'),
                  project.robotsOverride ? 'Override removed.' : 'Override recorded in the audit log.',
                )}
              >
                {project.robotsOverride ? 'Remove override' : 'Override robots.txt'}
              </Btn>
            </div>
          )}
        </Card>
      )}

      {/* Lifecycle — deleting is editProjectSettings (so a creator may delete
          their own project); the permanent purge inside has its own stricter
          gate and is NOT part of the creator grant. */}
      {canEdit && (
        <Card style={{ padding: 18, gap: 10 }}>
          <SectionHead title="Lifecycle" right={deleted ? 'Deleted — recoverable' : 'Active'} />
          <Muted size={12.5}>
            Deleting a project stops its schedule and hides it. Nothing is dropped: its crawl runs,
            results and findings stay readable, and it can be restored.
          </Muted>
          <div style={{ display: 'flex', gap: 8 }}>
            {deleted ? (
              <Btn variant="primary" onClick={() => onMutate(() => projectsApi.restore(project.id), 'Project restored — its schedule is off.')}>
                Restore project
              </Btn>
            ) : (
              <Btn variant="danger" onClick={() => onMutate(() => projectsApi.remove(project.id, 'Deleted from project settings'), 'Project deleted.')}>
                Delete project
              </Btn>
            )}
          </div>

          {/* Permanent deletion. Offered only once the project is already
              deleted, and only to a role that holds the capability — the server
              enforces both, so this is about not showing a door that will not
              open. */}
          {deleted && capabilities.purgeProject === true && (
            <>
              <FadingRule />
              <SectionHead title="Delete permanently" right="No undo" />
              <Muted size={12.5}>
                This erases the project itself and everything under it — every crawl run, result,
                finding, tracked page, competitor, recommendation and AI Visibility capture. It
                cannot be restored. The audit trail keeps a dated record that it happened.
              </Muted>
              {purging ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Muted size={12.5}>
                    Type <strong style={{ color: 'var(--text)' }}>{project.name}</strong> to confirm.
                  </Muted>
                  <input
                    style={inputStyle}
                    value={purgeName}
                    onChange={(e) => setPurgeName(e.target.value)}
                    placeholder={project.name}
                    aria-label="Project name, to confirm permanent deletion"
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn
                      variant="danger"
                      disabled={purgeName.trim() !== String(project.name || '').trim()}
                      onClick={() => onMutate(
                        () => projectsApi.purge(project.id, {
                          confirmName: purgeName.trim(),
                          reason: 'Permanently deleted from project settings',
                        }),
                        (result) => `${result.name} permanently deleted.`,
                      )}
                    >
                      Permanently delete
                    </Btn>
                    <Btn onClick={() => { setPurging(false); setPurgeName(''); }}>Cancel</Btn>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn variant="danger" onClick={() => setPurging(true)}>Delete permanently…</Btn>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      <ProjectHistory projectId={project.id} />
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────
//
// The project's audit trail. Every domain change, override, verification and
// lifecycle decision has been written to audit_events all along — and until now
// nothing read it back. The route existed, the API client method existed, and no
// screen called either, so the trail was write-only: a record kept for a
// question nobody could ask.
//
// Read-only by construction: audit_events has a trigger rejecting UPDATE and
// DELETE, so what is shown here is what happened.

const ACTION_LABELS = {
  'project.created': 'Project created',
  'project.updated': 'Settings changed',
  'project.deleted': 'Deleted',
  'project.restored': 'Restored',
  'project.purged': 'Permanently deleted',
  'project.verified': 'Site verified',
  'project.robots_override_set': 'robots.txt override',
  'project_domain.added': 'Competitor added',
  'project_domain.removed': 'Domain removed',
  'project_domain.primary_changed': 'Primary domain changed',
  'project_domain.proposal_approved': 'Competitor approved',
  'project_domain.proposal_rejected': 'Competitor rejected',
  'project_pages.synced': 'Pages synced',
};

// The one detail worth putting on the row, per action. Anything longer belongs
// in the stored state, not in a list someone is scanning.
function historyDetail(event) {
  const next = event.new_state || {};
  const prev = event.old_state || {};
  if (event.action === 'project_domain.primary_changed') {
    return `${prev.origin || '—'} → ${next.origin || '—'}`;
  }
  if (event.action.startsWith('project_domain.')) {
    return next.origin || prev.origin || null;
  }
  if (event.action === 'project.created') return next.primaryDomain || null;
  if (event.action === 'project.robots_override_set') {
    return next.robotsOverride ? 'enabled' : 'disabled';
  }
  return null;
}

function ProjectHistory({ projectId }) {
  const [events, setEvents] = useState(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    projectsApi.auditEvents(projectId, { limit: 50 })
      .then((d) => { if (live) setEvents(d.events || []); })
      // An unreadable trail should not take the settings screen down with it.
      .catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [projectId]);

  if (events === null) return null;

  return (
    <Card style={{ padding: 18, gap: 10 }}>
      <SectionHead title="History" right={events.length ? `${events.length} recorded` : ''} />
      {events.length ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {events.map((e) => {
            const detail = historyDetail(e);
            return (
              <div
                key={e.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12,
                  padding: '7px 0', borderBottom: '1px solid var(--border)',
                  fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  {ACTION_LABELS[e.action] || e.action}
                  {detail && <span style={{ color: 'var(--text-3)' }}> · {detail}</span>}
                  {e.actor_email && <span style={{ color: 'var(--text-3)' }}> · {e.actor_email}</span>}
                  {e.reason && <span style={{ color: 'var(--text-3)' }}> · “{e.reason}”</span>}
                </span>
                <span style={{ color: 'var(--text-3)', fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {relativeTime(e.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <Muted size={12.5}>
          Nothing recorded yet for this project.
        </Muted>
      )}
    </Card>
  );
}
