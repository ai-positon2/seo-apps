import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectsApi, relativeTime, countryLabel } from '../lib/projectsApi';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner,
} from '../components/home/primitives';
import ProjectSetupCard from '../components/home/ProjectSetupCard';

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
      await fn();
      await load();
      if (successText) setBanner({ tone: 'accent', text: successText });
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
        {capabilities.editProjectSettings && (
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
          onCreated={async (project) => {
            setShowSetup(false);
            setSelectedId(project.id);
            await load();
            setBanner({ tone: 'accent', text: `${project.name} created. Its weekly schedule is off until you enable it.` });
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
              project={selected}
              capabilities={capabilities}
              onMutate={mutate}
              onOpenDashboard={() => navigate('/')}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({ project, capabilities, onMutate, onOpenDashboard }) {
  const [name, setName] = useState(project.name);
  const [country, setCountry] = useState(project.countryCode || '');
  const [competitor, setCompetitor] = useState('');
  const [reason, setReason] = useState('');
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
    setPages((project.pages || []).map((p) => ({
      url: p.url, keywords: (p.keywords || []).join(', '),
    })));
  }, [project.id, project.name, project.countryCode, project.pages]);

  const canEdit = capabilities.editProjectSettings === true;
  const canManageCompetitors = Boolean(capabilities.manageCompetitors);
  const proposeOnly = capabilities.manageCompetitors === 'propose';
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Muted>Primary</Muted>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {project.primaryDomain
              ? <Tag tone="outline">{project.primaryDomain.origin}</Tag>
              : <Tag tone="warn">Missing — the crawler is using {project.legacyUrl}</Tag>}
            {project.primaryDomain?.source === 'backfill' && (
              <Muted>migrated from the previous schema</Muted>
            )}
          </div>
        </div>

        <FadingRule />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Muted>Competitors — used for comparative evidence only; their sites are never crawled.</Muted>
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
                }, proposeOnly ? 'Competitor proposed for approval.' : 'Competitor added.')}
              >
                {proposeOnly ? 'Propose competitor' : 'Add competitor'}
              </Btn>
              {proposeOnly && <Muted>Your role can propose; an approver applies it.</Muted>}
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

          {!project.siteVerifiedAt && capabilities.editProjectSettings && (
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

      {/* Lifecycle */}
      {capabilities.editProjectSettings && (
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
        </Card>
      )}
    </div>
  );
}
