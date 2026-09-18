import { Suspense, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { NAV_GROUPS, TAGS, getToolByPath } from '../toolsMeta';
import { useAuth } from '../context/AuthContext';
import { useTheme } from './ThemeContext';
import { projectsApi } from '../lib/projectsApi';
import { useActiveProjectId, useProjectsChanged } from '../lib/activeProject';
import { switchWorkspace } from '../lib/activeWorkspace';
import SemrushBalanceBadge from './SemrushBalanceBadge';
import CrawlStatusBar from './home/CrawlStatusBar';
import { useCrawlStatus } from '../lib/useCrawlStatus';
import ChunkErrorBoundary from './ChunkErrorBoundary';

// Shown while a route's chunk is in flight. Routes are code-split (see App.jsx),
// so navigating to a tool now fetches it — a few hundred milliseconds on a cold
// cache, nothing on a warm one. Deliberately near-empty: the sidebar and header
// are still on screen either side of it, and a spinner that flashes for 200ms
// reads as a slower app than one that simply holds its ground.
function RouteFallback() {
  return <div style={{ minHeight: '60vh' }} aria-busy="true" />;
}

/* ── Embed mode ──────────────────────────────────────────────────────────────
   When the app is framed with ?embed=1 (used by the public intelligence.position2.com
   /app agents), render ONLY the tool content — no sidebar, no "SEO Studio" header,
   no "All Tools" nav — so public users see just the single agent they opened.
   Internal /p2/seo embeds omit the param and keep the full studio. */
export const EMBED_MODE = (() => {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get('embed') === '1' || p.get('chrome') === 'none';
  } catch (e) { return false; }
})();

/* ── Sidebar icons (14px line-art, Lucide-style) ── */
const TOOL_ICONS = {
  'keyword-research': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  'keyword-research-public': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  ),
  'content-research': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  'article-recommendation': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6V7.5z" />
    </svg>
  ),
  'content-enhancement': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12.75h6m-6 3h6m2.25 4.5H6.75A2.25 2.25 0 014.5 18V6A2.25 2.25 0 016.75 3.75h5.379c.597 0 1.17.237 1.591.659l1.871 1.871c.422.422.659.994.659 1.591V18a2.25 2.25 0 01-2.25 2.25z" />
    </svg>
  ),
  'article-enhancement': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  ),
  'article-enhancement-lite': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  'ai-visibility': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 18.75a6.75 6.75 0 100-13.5 6.75 6.75 0 000 13.5z" />
      <path d="M4.5 12a7.5 7.5 0 0115 0M2.25 12a9.75 9.75 0 0119.5 0" />
    </svg>
  ),
  'seo-geo-audit': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  'agent-readiness-audit': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  'image-alt-audit': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  ),
  'location-page-builder': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
      <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
    </svg>
  ),
  'crawl-scope': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0V3m0 18c-2.5-2.2-4-5.4-4-9s1.5-6.8 4-9m0 18c2.5-2.2 4-5.4 4-9s-1.5-6.8-4-9M3.6 9h16.8M3.6 15h16.8" />
    </svg>
  ),
  'content-architect': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6.75V15m6-6v8.25m.503-13.036L20.25 6.75V19.5l-5.747-2.036M8.503 3.964L3.75 6.75v12.75l5.747-2.036m0-13.5l6-2.036" />
    </svg>
  ),
  'knowledge-base': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
    </svg>
  ),
  'robots-monitor': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
    </svg>
  ),
  'market-potential': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
    </svg>
  ),
  'competitor-analysis': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20V13M22 20V7" />
    </svg>
  ),
};

/* -- Header icons -- */
const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A8.5 8.5 0 1111.2 3a6.6 6.6 0 009.8 9.8z" />
  </svg>
);

const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);

/* Header buttons share one treatment: quiet until hovered, never a filled
   rectangle -- the design keeps a single accent per screen. */
function HeaderButton({ children, onClick, title, active, style }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 10px',
        fontSize: 12,
        fontWeight: 500,
        fontFamily: 'var(--font-sans)',
        color: active ? 'var(--primary-text)' : hover ? 'var(--text)' : 'var(--text-2)',
        background: hover || active ? 'var(--surface)' : 'transparent',
        border: '1px solid ' + (active ? 'var(--primary)' : 'var(--border)'),
        borderRadius: 6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* -- Client switcher --------------------------------------------------------
   The header names the client every screen below it is about, so switching is
   one click from anywhere. It lists only the projects /api/projects returned --
   i.e. only workspaces the caller belongs to -- and picking one just records the
   choice locally; every request still names the project and is authorised
   server-side. */
// No props, rendered in the header next to the nav search. Same reasoning as
// SemrushBalanceBadge: a props comparison that cannot fail, so memo is free.
const ClientSwitcher = memo(function ClientSwitcher() {
  const navigate = useNavigate();
  const [activeProjectId, setActiveProjectId] = useActiveProjectId();
  const [projects, setProjects] = useState([]);
  // The workspace every new project and tool run is RECORDED against. It used
  // to be visible on exactly one screen (/workspaces), so the answer to "where
  // is this going to be filed" was invisible everywhere it mattered — and
  // nothing kept it consistent with the client named right here.
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  // This component lives in the app shell, which does not unmount as the user
  // navigates, so a once-on-mount fetch held its list for the lifetime of the
  // tab. Deleting a project left it in this menu — and, because the resolution
  // below still found it, left the header naming a client the dashboard was no
  // longer showing. Re-reading on the change signal is what keeps the two the
  // same client.
  const projectsVersion = useProjectsChanged();
  // True while a list refetch triggered by `projectsVersion` is in flight.
  // Starts true: the very first fetch on mount is exactly the same case — the
  // repair effect below must not judge `activeProjectId` against an empty
  // `projects` array before that first read ever lands.
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    // A failure here is not worth an error state in the chrome: the dashboard
    // below reports it properly, and the switcher simply has nothing to offer.
    projectsApi.list()
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects || []);
        setWorkspaces(data.workspaces || []);
        setActiveWorkspaceId(data.activeWorkspaceId || null);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects([]);
        setWorkspaces([]);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
  }, [projectsVersion]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || projects[0] || null,
    [projects, activeProjectId],
  );

  // Repair the stored selection, exactly as the dashboard does. Without this the
  // header would keep resolving a dead id to projects[0] on every render while
  // localStorage still named the deleted project, so any screen that read the id
  // without resolving it got a different answer than the one on show here.
  //
  // Gated on `!refreshing`: a project created elsewhere (HomePage's setup card)
  // changes `activeProjectId` the instant it is created, via the same
  // localStorage event this component listens to — but that event fires
  // independently of THIS component's own list refetch, which was only just
  // triggered by the matching `projectsVersion` bump and has not landed yet.
  // Without this guard, that brief window reads exactly like a deleted
  // project — not found in the (still stale) `projects` array — and the
  // header "repairs" a brand-new project id back to whatever was first in the
  // old list, fighting the very screen that just created it.
  useEffect(() => {
    if (refreshing) return;
    if (active && active.id !== activeProjectId) setActiveProjectId(active.id);
  }, [active, activeProjectId, setActiveProjectId, refreshing]);

  if (!projects.length) {
    return (
      <HeaderButton title="Set up a client project" onClick={() => navigate('/projects')}>
        Add a client
      </HeaderButton>
    );
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <HeaderButton title="Switch client" onClick={() => setOpen((v) => !v)} active={open}>
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: active?.schedule?.enabled ? 'var(--primary)' : 'var(--text-3)',
          }}
        />
        <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {active ? active.name : 'Select a client'}
        </span>
        <ChevronDownIcon />
      </HeaderButton>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 36, left: 0, minWidth: 260, zIndex: 40,
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)',
            padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
          }}
        >
          {/* Workspace, above the clients.
              Shown only when there is more than one — with a single workspace
              the choice has one answer and the row is noise. Switching here goes
              through switchWorkspace(), which activates it, refreshes every
              list, AND moves the client selection into the new workspace if it
              was pointing outside it. Those three were previously separate,
              which is how the header came to name a client in one workspace
              while new runs were being filed under another. */}
          {workspaces.length > 1 && (
            <>
              <div style={{
                fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-3)', fontWeight: 600, padding: '6px 9px 4px',
              }}>
                Recording work in
              </div>
              {workspaces.map((ws) => {
                const isActiveWs = ws.id === activeWorkspaceId;
                return (
                  <button
                    key={ws.id}
                    role="menuitem"
                    disabled={switching}
                    onClick={async () => {
                      if (isActiveWs) return;
                      setSwitching(true);
                      try {
                        const result = await switchWorkspace(ws.id, projects);
                        setActiveWorkspaceId(result.workspaceId);
                        setOpen(false);
                        // The client moved with the workspace, so the screen
                        // below is about a different project now.
                        if (result.projectChanged) navigate('/');
                      } catch {
                        /* The cookie is unchanged, so both selections still
                           agree; /workspaces reports the failure properly. */
                      } finally {
                        setSwitching(false);
                      }
                    }}
                    style={{
                      textAlign: 'left', border: 'none',
                      cursor: isActiveWs || switching ? 'default' : 'pointer',
                      background: isActiveWs ? 'var(--nav-active-bg)' : 'transparent',
                      color: 'var(--text)', padding: '6px 9px', borderRadius: 'var(--r-sm)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, fontFamily: 'var(--font-sans)', fontSize: 12.5,
                    }}
                  >
                    <span style={{ fontWeight: isActiveWs ? 600 : 400 }}>
                      {ws.name}{ws.isPersonal ? ' (personal)' : ''}
                    </span>
                    {isActiveWs && (
                      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>active</span>
                    )}
                  </button>
                );
              })}
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
              <div style={{
                fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: 'var(--text-3)', fontWeight: 600, padding: '2px 9px 4px',
              }}>
                Clients
              </div>
            </>
          )}

          {projects.map((project) => {
            const isActive = active?.id === project.id;
            const ws = workspaces.find((w) => w.id === project.workspaceId);
            return (
              <button
                key={project.id}
                role="menuitem"
                onClick={() => { setActiveProjectId(project.id); setOpen(false); navigate('/'); }}
                style={{
                  textAlign: 'left', border: 'none', cursor: 'pointer',
                  background: isActive ? 'var(--nav-active-bg)' : 'transparent',
                  color: 'var(--text)', padding: '7px 9px', borderRadius: 'var(--r-sm)',
                  display: 'flex', flexDirection: 'column', gap: 1,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: isActive ? 600 : 400 }}>{project.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {project.primaryDomain?.host || project.legacyUrl}
                  {project.countryCode ? ' · ' + project.countryCode : ' · country not set'}
                  {/* Which workspace this client's work is filed under. Only
                      worth saying when it is NOT the one currently recording,
                      because that is the case where picking it means work lands
                      somewhere other than the row above says. */}
                  {workspaces.length > 1 && project.workspaceId !== activeWorkspaceId && (
                    <span style={{ color: 'var(--viz-warn)' }}>
                      {' · in '}{ws?.name || 'another workspace'}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
          <button
            onClick={() => { setOpen(false); navigate('/projects'); }}
            style={{
              textAlign: 'left', border: 'none', cursor: 'pointer', background: 'transparent',
              color: 'var(--primary-text)', padding: '7px 9px', borderRadius: 'var(--r-sm)',
              fontSize: 12.5, fontFamily: 'var(--font-sans)',
            }}
          >
            Manage projects
          </button>
        </div>
      )}
    </div>
  );
});

const ChevronLeftIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

/* ── AppShell (replaces old MacWindow) ── */
export default function MacWindow() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [search, setSearch] = useState('');

  // The live crawl for the active client, polled here so it survives navigation.
  // Server-derived on every tick, so there is no client-side crawl state that a
  // route change could drop.
  const crawl = useCrawlStatus({ enabled: !EMBED_MODE });

  // Collapsing the tool list is a per-person preference about their own screen,
  // so it is remembered locally rather than round-tripped to the server. Wrapped
  // because localStorage throws outright in a private window rather than
  // returning null.
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('seoStudio.navCollapsed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('seoStudio.navCollapsed', navCollapsed ? '1' : '0');
    } catch {
      // A viewer who cannot store the preference still gets to use the toggle;
      // it just does not survive a reload.
    }
  }, [navCollapsed]);

  // Same collapse mechanism, kept as its own preference: the dashboard states
  // its own six audit modules directly (AuditRadar, ModuleCard grid), so the
  // tool-browsing sidebar was mostly competing with them for space and starts
  // collapsed here by default — but it is still a real, working toggle, not a
  // hard block, so anyone who wants the tool list open on the dashboard too
  // can have it. Defaults to collapsed (not "false", matching navCollapsed's
  // default) on a first visit with nothing stored yet.
  const [homeNavCollapsed, setHomeNavCollapsed] = useState(() => {
    try {
      const stored = window.localStorage.getItem('seoStudio.homeNavCollapsed');
      return stored === null ? true : stored === '1';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('seoStudio.homeNavCollapsed', homeNavCollapsed ? '1' : '0');
    } catch {
      // See the navCollapsed effect above — same non-fatal fallback.
    }
  }, [homeNavCollapsed]);

  const { email, logout, isPlatformAdmin } = useAuth();
  const { isDark, toggle: toggleTheme } = useTheme();

  const isHome = pathname === '/';
  const currentTool = getToolByPath(pathname);

  // Which of the two preferences applies here, and the setter that changes
  // it — one toggle button below drives whichever is live for this route.
  const sidebarHidden = isHome ? homeNavCollapsed : navCollapsed;
  const setSidebarHidden = isHome ? setHomeNavCollapsed : setNavCollapsed;

  // Rebuilt on every render — including every crawl-status tick — and it called
  // search.toLowerCase() once per tool, so ~37 times per pass. Depends only on
  // the search box.
  //
  // Note the untrimmed toLowerCase(): the guard tests search.trim() but the
  // filter has always matched on the raw value, so "  seo" matches nothing
  // today. That is preserved deliberately — hoisting search.trim().toLowerCase()
  // here would quietly change which results appear, which is a behaviour change
  // dressed up as a performance one.
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return NAV_GROUPS;
    const needle = search.toLowerCase();
    return NAV_GROUPS
      .map(g => ({ ...g, tools: g.tools.filter(t => t.label.toLowerCase().includes(needle)) }))
      .filter(g => g.tools.length > 0);
  }, [search]);

  // Chrome-less embed: only the tool content, for public framed use.
  if (EMBED_MODE) {
    return (
      <div style={{ minHeight: '100vh', overflowY: 'auto', background: 'var(--bg)' }}>
        <ChunkErrorBoundary fallback={RouteFallback}><Suspense fallback={<RouteFallback />}><Outlet context={crawl} /></Suspense></ChunkErrorBoundary>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0 }}>

        {/* ── AppHeader (56px solid) ── */}
        <div style={{
          height: 56,
          flexShrink: 0,
          background: 'var(--card)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          zIndex: 10,
        }}>
          {/* Brand block — aligned to sidebar width, and collapses with it */}
          <div style={{
            width: sidebarHidden ? 60 : 248,
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            padding: sidebarHidden ? '0 10px' : '0 16px',
            gap: 10,
            borderRight: '1px solid var(--border)',
            boxSizing: 'border-box',
            transition: 'width 160ms ease, padding 160ms ease',
          }}>
            {/* Brand square */}
            <div style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>
            {!sidebarHidden && (
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
                <span style={{
                  fontWeight: 600,
                  fontSize: 13.5,
                  color: 'var(--text)',
                  letterSpacing: '-0.015em',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}>
                  SEO Studio
                </span>
                <span style={{
                  fontSize: 9.5,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--text-3)',
                  userSelect: 'none',
                }}>
                  Position2
                </span>
              </div>
            )}

          </div>

          {/* Breadcrumb / page title */}
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 20px',
          }}>
            {/* Collapse the tool list. Moved out of the brand block above (a
                fixed 60px column with no room to make this bigger without
                overlapping its neighbour) into this row, which always has
                space. Retractable everywhere, including the dashboard — it
                just starts collapsed there by default (homeNavCollapsed
                above), rather than being unavailable. Sized up and tinted
                when collapsed specifically, since that state is the only way
                back into the pane and is worth being obvious about. */}
            <button
              type="button"
              onClick={() => setSidebarHidden((v) => !v)}
              title={sidebarHidden ? 'Show the tool list' : 'Hide the tool list'}
              aria-label={sidebarHidden ? 'Show the tool list' : 'Hide the tool list'}
              aria-expanded={!sidebarHidden}
              style={{
                width: sidebarHidden ? 38 : 30,
                height: sidebarHidden ? 38 : 30,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: sidebarHidden ? 'color-mix(in srgb, var(--primary) 14%, transparent)' : 'none',
                border: `1px solid ${sidebarHidden ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 9,
                cursor: 'pointer',
                color: sidebarHidden ? 'var(--primary)' : 'var(--text-3)',
                padding: 0,
                transition: 'width 160ms ease, height 160ms ease, background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
              }}
            >
              <svg width={sidebarHidden ? 19 : 16} height={sidebarHidden ? 19 : 16} viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>

            {/* Return to the dashboard — present on every page except the
                dashboard itself. Was an icon plus a plain "All Tools" label
                that navigated to '/', which is the overview, not a tool list;
                the mislabel made it easy to miss as a real "go home" control.
                One button, worded for where it actually goes. */}
            {!isHome && (
              <button
                onClick={() => navigate('/')}
                title="Back to the dashboard"
                style={{
                  background: 'none',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  height: 28,
                  padding: '0 10px 0 8px',
                  borderRadius: 7,
                  color: 'var(--text-2)',
                  fontSize: 12.5,
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                  transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
                  flexShrink: 0,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--surface)';
                  e.currentTarget.style.color = 'var(--text)';
                  e.currentTarget.style.borderColor = 'var(--primary)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'none';
                  e.currentTarget.style.color = 'var(--text-2)';
                  e.currentTarget.style.borderColor = 'var(--border)';
                }}
              >
                <ChevronLeftIcon />
                Dashboard
              </button>
            )}
            {!isHome && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>/</span>
            )}
            <span style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: '-0.01em',
              userSelect: 'none',
            }}>
              {isHome ? 'Overview' : (currentTool ? currentTool.label : 'SEO Studio')}
            </span>

            {/* Which client the screens below are about (PRD 20.1). */}
            <div style={{ marginLeft: 12 }}>
              <ClientSwitcher />
            </div>
          </div>

          {/* Right controls: usage, navigation, appearance, identity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 16 }}>
            <SemrushBalanceBadge />

            <HeaderButton title="Crawl and tool runs" onClick={() => navigate('/runs')}>
              Runs
            </HeaderButton>
            <HeaderButton title="Projects and competitors" onClick={() => navigate('/projects')}>
              Projects
            </HeaderButton>
            <HeaderButton title="Workspaces and members" onClick={() => navigate('/workspaces')}>
              Workspaces
            </HeaderButton>

            {/* Shown on the server's say-so; /api/admin re-checks the persisted
                grant on every request, so this is a signpost, not a gate. */}
            {isPlatformAdmin && (
              <HeaderButton title="Platform administration" onClick={() => navigate('/admin')}>
                <GearIcon />
                Admin
              </HeaderButton>
            )}

            <HeaderButton
              title={isDark ? 'Switch to the light theme' : 'Switch to the dark theme'}
              onClick={toggleTheme}
              style={{ padding: '0 8px' }}
            >
              {isDark ? <SunIcon /> : <MoonIcon />}
            </HeaderButton>

            <UserChip email={email} onLogout={logout} />
          </div>
        </div>

        {/* ── Body: sidebar + content ── */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

          {/* ── Sidebar ──────────────────────────────────────────────────
              Painted from the nav tokens rather than white alphas: the same
              markup has to read on a warm-paper light background and on the
              near-black dark one, and an alpha tuned for navy does neither. */}
          <div style={{
            width: sidebarHidden ? 0 : 248,
            flexShrink: 0,
            background: 'linear-gradient(180deg, var(--nav-bg-top) 0%, var(--nav-bg-bot) 100%)',
            borderRight: sidebarHidden ? 'none' : '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'width 160ms ease',
          }}>
            {/* Search */}
            <div style={{ padding: '14px 12px 8px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '6px 10px',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search tools…"
                  style={{
                    background: 'none',
                    border: 'none',
                    outline: 'none',
                    fontSize: 12,
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--nav-text-active)',
                    width: '100%',
                  }}
                />
              </div>
            </div>

            {/* Nav groups */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 20px' }}>
              {search.trim() && !filteredGroups.length && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>
                  No tool matches “{search.trim()}”.
                </div>
              )}
              {filteredGroups.map(group => (
                <div key={group.label} style={{ marginBottom: 20 }}>
                  {/* Group label */}
                  <div style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--text-3)',
                    padding: '4px 10px 6px',
                  }}>
                    {group.label}
                  </div>
                  {group.tools.map(tool => {
                    const isActive = pathname === tool.path || pathname.startsWith(tool.path + '/');
                    return (
                      <SidebarItem
                        key={tool.id}
                        tool={tool}
                        icon={TOOL_ICONS[tool.id]}
                        isActive={isActive}
                        onClick={() => navigate(tool.path)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* ── Content area (solid bg) ── */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            background: 'var(--bg)',
          }}>
            {/* The live crawl, above whatever screen you are on.
                It sits in the shell rather than on the dashboard because a crawl
                runs for tens of minutes and people do not stand still for it —
                walking over to another tool used to make the crawl disappear,
                which reads as "it stopped" rather than "you changed screens".
                Renders nothing when no crawl is in flight. */}
            {crawl.status && (
              // Same column geometry as the dashboard beneath it (32px gutters,
              // 1520 max, centred), so the bar's edges line up with the cards
              // rather than sitting proud of them by eight pixels.
              <div style={{ padding: '24px 32px 0', maxWidth: 1520, margin: '0 auto' }}>
                <CrawlStatusBar
                  status={crawl.status}
                  onWatch={(runId) => navigate(`/crawl-scope/runs/${runId}`)}
                />
              </div>
            )}
            <ChunkErrorBoundary fallback={RouteFallback}><Suspense fallback={<RouteFallback />}><Outlet context={crawl} /></Suspense></ChunkErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -- Identity ---------------------------------------------------------------
   Avatar and name, with sign-out behind it. The initials come from the signed-in
   email, which is the only identity the client is given -- there is no display
   name in the session, so inventing one would only be decoration. */
function UserChip({ email, onLogout }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const local = (email || '').split('@')[0] || '';
  const initials = local
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={email || 'Account'}
        aria-label="Account"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 30, padding: '0 8px 0 3px',
          background: open ? 'var(--surface)' : 'transparent',
          border: '1px solid ' + (open ? 'var(--primary)' : 'var(--border)'),
          borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-sans)',
        }}
      >
        <span style={{
          width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
          background: 'var(--accent-800)', color: 'var(--accent-100)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em',
        }}>
          {initials}
        </span>
        <span style={{
          fontSize: 12, color: 'var(--text-2)', maxWidth: 120,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {local || 'Account'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 36, right: 0, minWidth: 220, zIndex: 40,
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)',
            padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text)', wordBreak: 'break-all' }}>
              {email || 'Signed in'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              Roles are held per workspace
            </span>
          </div>
          <div style={{ height: 1, background: 'var(--border)' }} />
          <button
            onClick={() => { setOpen(false); onLogout(); }}
            style={{
              textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--viz-neg)', fontSize: 12.5, padding: '4px 0',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Sidebar nav item ── */
function SidebarItem({ tool, icon, isActive, onClick }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: isActive ? 600 : 400,
        fontFamily: 'var(--font-sans)',
        color: isActive || hovered ? 'var(--nav-text-active)' : 'var(--nav-text)',
        background: isActive
          ? 'var(--nav-active-bg)'
          : hovered
          ? 'color-mix(in srgb, var(--text) 7%, transparent)'
          : 'transparent',
        transition: 'background 0.12s var(--ease), color 0.12s var(--ease)',
        marginBottom: 1,
        outline: 'none',
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      {/* Active left indicator */}
      {isActive && (
        <span style={{
          position: 'absolute',
          left: 0,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 2,
          height: 16,
          background: 'var(--nav-active-bar)',
          borderRadius: '0 2px 2px 0',
        }} />
      )}
      <span style={{
        flexShrink: 0,
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        marginLeft: isActive ? 6 : 0,
        transition: 'margin-left 0.12s var(--ease)',
      }}>
        {icon}
      </span>
      <span style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {tool.label}
      </span>
      {tool.tag && TAGS[tool.tag] && (
        <span style={{
          marginLeft: 'auto',
          flexShrink: 0,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          padding: '1px 5px',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          background: TAGS[tool.tag].bg,
          color: TAGS[tool.tag].fg,
        }}>
          {TAGS[tool.tag].short || TAGS[tool.tag].label}
        </span>
      )}
    </button>
  );
}
