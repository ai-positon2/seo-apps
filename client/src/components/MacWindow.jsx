import { useState } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { TOOL_GROUPS, TAGS, getToolByPath } from '../toolsMeta';
import SemrushBalanceBadge from './SemrushBalanceBadge';

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
  'on-page-audit': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  'seo-geo-audit': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  'seo-geo-snapshot': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18M8 17V9m4 8V5m4 12v-6" />
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
  'gbp-qc': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
      <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
    </svg>
  ),
  'location-page-builder': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
      <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
    </svg>
  ),
  'hub-spoke': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 3M21 7.5H7.5" />
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
  'team-insights': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
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
  'comp-res-beta': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20V13M22 20V7" />
    </svg>
  ),
  'gsc-explorer': (
    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18M7 14l4-4 3 3 5-6" />
    </svg>
  ),
};

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

  const isHome = pathname === '/';
  const currentTool = getToolByPath(pathname);

  const filteredGroups = search.trim()
    ? TOOL_GROUPS
        .map(g => ({
          ...g,
          tools: g.tools.filter(t =>
            t.label.toLowerCase().includes(search.toLowerCase())
          ),
        }))
        .filter(g => g.tools.length > 0)
    : TOOL_GROUPS;

  // Chrome-less embed: only the tool content, for public framed use.
  if (EMBED_MODE) {
    return (
      <div style={{ minHeight: '100vh', overflowY: 'auto', background: 'var(--bg)' }}>
        <Outlet />
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
          {/* Brand block — aligned to sidebar width */}
          <div style={{
            width: 248,
            flexShrink: 0,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: 10,
            borderRight: '1px solid var(--border)',
            boxSizing: 'border-box',
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>
            <span style={{
              fontWeight: 700,
              fontSize: 14,
              color: 'var(--text)',
              letterSpacing: '-0.015em',
              userSelect: 'none',
            }}>
              SEO Studio
            </span>
          </div>

          {/* Breadcrumb / page title */}
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 20px',
          }}>
            {!isHome && (
              <button
                onClick={() => navigate('/')}
                title="All Tools"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  color: 'var(--text-3)',
                  outline: 'none',
                  transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
                  flexShrink: 0,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--surface)';
                  e.currentTarget.style.color = 'var(--text)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'none';
                  e.currentTarget.style.color = 'var(--text-3)';
                }}
              >
                <ChevronLeftIcon />
              </button>
            )}
            {!isHome && (
              <span style={{ fontSize: 12, color: 'var(--text-3)', userSelect: 'none' }}>
                All Tools
              </span>
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
              {isHome ? 'SEO Tools' : (currentTool ? currentTool.label : 'SEO Studio')}
            </span>
          </div>

          {/* Right controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 16 }} />
        </div>

        {/* ── Body: sidebar + content ── */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

          {/* ── Sidebar (navy gradient) ── */}
          <div style={{
            width: 248,
            flexShrink: 0,
            background: 'linear-gradient(180deg, var(--nav-bg-top) 0%, var(--nav-bg-bot) 100%)',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* Semrush balance */}
            <div style={{ padding: '12px 12px 0' }}>
              <SemrushBalanceBadge />
            </div>

            {/* Search */}
            <div style={{ padding: '12px 12px 8px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                padding: '6px 10px',
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(199,210,224,0.7)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
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
                    color: 'var(--nav-text-active)',
                    width: '100%',
                  }}
                />
              </div>
            </div>

            {/* Nav groups */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 20px' }}>
              {filteredGroups.map(group => (
                <div key={group.label} style={{ marginBottom: 20 }}>
                  {/* Group label */}
                  <div style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'rgba(255,255,255,0.40)',
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
            <Outlet />
          </div>
        </div>
      </div>
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
        color: isActive ? 'var(--nav-text-active)' : hovered ? '#e8edf5' : 'var(--nav-text)',
        background: isActive
          ? 'var(--nav-active-bg)'
          : hovered
          ? 'rgba(255,255,255,0.06)'
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
