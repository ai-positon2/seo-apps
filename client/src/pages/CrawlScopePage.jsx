// CrawlScope landing: start a crawl, manage scheduled projects, browse history.
//
// The desktop app had these as three sibling screens behind a nav rail. Here
// they are three tabs on one page, and a run opens its own route so a crawl in
// progress can be linked to and returned to.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  SectionHeader, Card, Button, Badge, Field, EmptyState, useToast,
} from '../ui';
import ModuleRuns from '../components/ModuleRuns';
import CrawlOptionsForm from '../components/crawlScope/CrawlOptionsForm';
import ProjectForm from '../components/crawlScope/ProjectForm';
import {
  DEFAULT_OPTIONS, describeSchedule, formatInTimezone, runStatusVariant,
  TERMINAL_STATUSES, WORKER_EXECUTED_TRIGGERS, formatDuration,
} from '../components/crawlScope/crawlHelpers';
import { cs } from '../lib/crawlScopeApi';

const TABS = [
  { id: 'crawl', label: 'New crawl' },
  { id: 'projects', label: 'Scheduled crawls' },
  { id: 'history', label: 'History' },
];

// ── New crawl ───────────────────────────────────────────────────────────────
// Spider mode crawls from one URL; list mode audits exactly the URLs given and
// follows nothing, which is what the server's `urls` array selects.
function NewCrawl({ onStarted, onScheduleInstead }) {
  const toast = useToast();
  const [mode, setMode] = useState('spider');
  const [url, setUrl] = useState('');
  const [urlList, setUrlList] = useState('');
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [starting, setStarting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const listUrls = useMemo(
    () => urlList.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    [urlList],
  );

  const canStart = mode === 'spider' ? Boolean(url.trim()) : listUrls.length > 0;

  async function start() {
    setStarting(true);
    try {
      const body = mode === 'spider'
        ? { url: url.trim(), options }
        : { urls: listUrls, options };
      const { run } = await cs.startRun(body);
      onStarted(run);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[['spider', 'Crawl a site'], ['list', 'Audit a URL list']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            style={{
              padding: '6px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 999,
              border: `1px solid ${mode === id ? 'var(--primary)' : 'var(--border)'}`,
              background: mode === id ? 'var(--primary-soft)' : 'transparent',
              color: mode === id ? 'var(--primary-text, var(--primary))' : 'var(--text-2)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'spider' ? (
        <Field
          label="Start URL"
          required
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canStart && !starting) start(); }}
          helper="Only crawl sites you are authorised to audit. Requests identify as CrawlScope."
        />
      ) : (
        <Field
          label="URLs"
          as="textarea"
          rows={7}
          placeholder={'https://example.com/one\nhttps://example.com/two'}
          value={urlList}
          onChange={(e) => setUrlList(e.target.value)}
          helper={`${listUrls.length} URL${listUrls.length === 1 ? '' : 's'} — one per line. Invalid lines are skipped, duplicates removed.`}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={start} loading={starting} disabled={!canStart}>Start crawl</Button>
        {/* How many URLs this will actually fetch, next to the button that
            fetches them.
            The number was only visible by opening Crawl settings, and its
            consequences are not small: it is the ceiling on the pages every
            score is computed over, and a crawl budgeted below the size of the
            site produces an audit of the part it reached without saying so.
            In list mode the budget is the list — the server pins maxUrls to
            its length — so the label says that instead of a cap that does not
            apply. */}
        <span style={{ fontSize: 12.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
          {mode === 'list'
            ? `${listUrls.length.toLocaleString()} URL${listUrls.length === 1 ? '' : 's'} in the list`
            : `up to ${Number(options.maxUrls || 0).toLocaleString()} pages`}
          {mode !== 'list' && options.maxExternalUrls
            ? ` · ${Number(options.maxExternalUrls).toLocaleString()} external links checked`
            : ''}
        </span>
        <Button variant="ghost" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? 'Hide settings' : 'Crawl settings'}
        </Button>
      </div>

      {/* This form only ever starts a one-off run — nothing here mentions
          that a recurring, self-emailing version exists on the other tab.
          A single explicit link, not a hidden feature someone has to
          stumble onto the "Scheduled crawls" tab to discover. */}
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text-3)' }}>
        Want this to run automatically and email you the report?{' '}
        <button
          type="button"
          onClick={() => onScheduleInstead(mode === 'spider' ? url.trim() : '')}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            font: 'inherit', color: 'var(--primary-text, var(--primary))', textDecoration: 'underline',
          }}
        >
          Set up a scheduled crawl instead
        </button>
      </div>

      {showSettings && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
          {/* Was `disabled={mode === 'list'}`, which greyed out every setting.
              Only maxUrls and sitemap discovery are actually inert for a list —
              politeness, timeout, robots and asset crawling all still apply, and
              a list spanning many hosts is exactly when someone wants to reach
              for the per-host delay. */}
          <CrawlOptionsForm options={options} onChange={setOptions} mode={mode} />
          {mode === 'list' && (
            <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10 }}>
              In list mode the crawl visits exactly the URLs above, so the discovery limits don't apply.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Scheduled projects ──────────────────────────────────────────────────────
// Form open/editing/prefill state is owned by the parent page, not this
// component — "Set up a scheduled crawl instead" (on New Crawl) and
// "Schedule this crawl to repeat" (on a finished run's page) both need to
// open this same modal from outside the Projects tab.
function Projects({
  projects, loading, reload, onOpenRun,
  formOpen, setFormOpen, editing, setEditing, prefillUrl, prefillAt,
}) {
  const toast = useToast();
  const [busy, setBusy] = useState('');

  async function save(body) {
    if (editing) await cs.updateProject(editing.id, body);
    else await cs.createProject(body);
    await reload();
    toast.success(editing ? 'Schedule updated.' : 'Project created — first crawl queued.');
  }

  async function act(project, fn, message) {
    setBusy(project.id);
    try {
      await fn();
      await reload();
      toast.success(message);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>New scheduled crawl</Button>
      </div>

      {loading ? (
        <EmptyState title="Loading…" />
      ) : !projects.length ? (
        <EmptyState
          title="No scheduled crawls"
          description="A scheduled crawl re-audits a site on a weekly cadence and emails the workbook to whoever you list."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.map((p) => (
            <Card key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14.5 }}>{p.name || p.url}</span>
                    <Badge variant={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'Active' : 'Paused'}</Badge>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', wordBreak: 'break-all' }}>{p.url}</div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
                    <span>{describeSchedule(p)}</span>
                    <span>Next: {p.enabled ? formatInTimezone(p.next_run_at, p.timezone) : '—'}</span>
                    <span>Last: {formatInTimezone(p.last_run_at, p.timezone)}</span>
                  </div>
                  {p.recipients?.length ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
                      Emails: {p.recipients.join(', ')}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 6 }}>
                      No recipients — the report is stored but not emailed.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <Button
                    variant="secondary" size="sm" disabled={busy === p.id}
                    onClick={() => act(p, async () => {
                      const { run } = await cs.runProjectNow(p.id);
                      if (run) onOpenRun(run.id);
                    }, 'Crawl queued.')}
                  >
                    Run now
                  </Button>
                  <Button
                    variant="secondary" size="sm" disabled={busy === p.id}
                    onClick={() => act(p, () => cs.updateProject(p.id, { enabled: !p.enabled }), p.enabled ? 'Paused.' : 'Resumed.')}
                  >
                    {p.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(p); setFormOpen(true); }}>Edit</Button>
                  <Button
                    variant="ghost" size="sm" disabled={busy === p.id}
                    onClick={() => {
                      if (!window.confirm(`Delete "${p.name || p.url}"? Its past runs are kept.`)) return;
                      act(p, () => cs.deleteProject(p.id), 'Project deleted.');
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ProjectForm
        open={formOpen}
        project={editing}
        initialUrl={prefillUrl}
        initialAt={prefillAt}
        onClose={() => setFormOpen(false)}
        onSave={save}
      />
    </div>
  );
}

// ── History ─────────────────────────────────────────────────────────────────
function History({ runs, loading, onOpenRun }) {
  if (loading) return <EmptyState title="Loading…" />;
  if (!runs.length) {
    return <EmptyState title="No crawls yet" description="Start one from the New crawl tab." />;
  }
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ background: 'var(--surface)' }}>
            {['Started', 'Site', 'Trigger', 'Status', 'URLs', 'Duration', ''].map((h) => (
              <th key={h} style={{
                padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text-3)',
                borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const started = run.started_at || run.created_at;
            const duration = run.finished_at && started
              ? formatDuration(new Date(run.finished_at) - new Date(started))
              : '—';
            return (
              <tr
                key={run.id}
                onClick={() => onOpenRun(run.id)}
                style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
              >
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                  {new Date(started).toLocaleString()}
                </td>
                <td style={{ padding: '8px 10px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                  {run.url}
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--text-3)' }}>
                  {WORKER_EXECUTED_TRIGGERS.includes(run.trigger) ? 'Scheduled' : 'Manual'}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <Badge variant={runStatusVariant(run.status)}>{run.status}</Badge>
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-2)' }}>
                  {run.summary?.resultCount ?? run.progress?.crawled ?? '—'}
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--text-2)' }}>{duration}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                  {TERMINAL_STATUSES.includes(run.status) && (
                    <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onOpenRun(run.id); }}>
                      Open
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CrawlScopePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [tab, setTab] = useState('crawl');
  const [projects, setProjects] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Schedule-form state lives here, not inside Projects, so it can be opened
  // from the New Crawl tab's cross-link and from CrawlScopeRunPage's
  // "Schedule this crawl to repeat" button, not only from within the
  // Projects tab itself.
  const [formOpen, setFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [prefillUrl, setPrefillUrl] = useState('');
  const [prefillAt, setPrefillAt] = useState(null);

  const openScheduleForm = useCallback((url, at) => {
    setTab('projects');
    setEditingProject(null);
    setPrefillUrl(url || '');
    // When the run being scheduled already has a first report behind it,
    // its own started_at is the day/time the new schedule should default
    // to — see ProjectForm's initialAt.
    setPrefillAt(at || null);
    setFormOpen(true);
  }, []);

  // Arriving via navigate('/crawl-scope', { state: { scheduleUrl, scheduleAt } })
  // from a finished run's "Schedule this crawl to repeat" button.
  useEffect(() => {
    if (location.state?.scheduleUrl) {
      openScheduleForm(location.state.scheduleUrl, location.state.scheduleAt);
      // Consume the navigation state so a refresh or back-navigation doesn't
      // silently reopen the form.
      window.history.replaceState({}, document.title);
    }
  }, [location.state, openScheduleForm]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([cs.projects(), cs.runs({ limit: 50 })]);
      setProjects(p.projects || []);
      setRuns(r.runs || []);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openRun = (id) => navigate(`/crawl-scope/runs/${id}`);

  return (
    <main style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeader
        title="CrawlScope"
        subtitle="Crawl a site, audit every URL against 92 technical SEO checks, and schedule the whole thing to re-run and email itself."
      />

      {error && (
        <Card style={{ borderColor: 'var(--danger)' }}>
          <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '9px 15px', fontSize: 13, cursor: 'pointer', background: 'none', border: 'none',
              color: tab === t.id ? 'var(--text)' : 'var(--text-3)',
              fontWeight: tab === t.id ? 600 : 400,
              borderBottom: `2px solid ${tab === t.id ? 'var(--primary)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'crawl' && (
        <NewCrawl
          onStarted={(run) => { toast.success('Crawl started.'); openRun(run.id); }}
          onScheduleInstead={openScheduleForm}
        />
      )}
      {tab === 'projects' && (
        <Projects
          projects={projects}
          loading={loading}
          reload={load}
          onOpenRun={openRun}
          formOpen={formOpen}
          setFormOpen={setFormOpen}
          editing={editingProject}
          setEditing={setEditingProject}
          prefillUrl={prefillUrl}
          prefillAt={prefillAt}
        />
      )}
      {tab === 'history' && (
        <History runs={runs} loading={loading} onOpenRun={openRun} />
      )}

      <ModuleRuns toolId="crawl-scope" />
    </main>
  );
}
