import { useState, useRef, useEffect, useMemo } from 'react';
import ModuleRuns from '../components/ModuleRuns';
import { InfoTip } from '../components/seoGeo/report/reportKit';
import ProjectReportBar from '../components/project/ProjectReportBar';
import ReportResolving from '../components/project/ReportResolving';
import { useActiveProjectId } from '../lib/activeProject';
import { scoreBandColor } from '../lib/scoreVerdict';
import { InfoDot, Legend } from '../components/explain';

const SC = {
  pass: { label: 'Pass', bg: 'var(--success-soft)', color: 'var(--success)', icon: '✓' },
  fail: { label: 'Fail', bg: 'var(--danger-soft)', color: 'var(--danger)', icon: '✗' },
  info: { label: 'Info', bg: 'var(--warning-soft)', color: 'var(--warning)', icon: 'i' },
};

const EC = {
  done:   { label: 'Completed',   color: 'var(--success)' },
  quick:  { label: 'Quick win',   color: 'var(--info)' },
  medium: { label: 'Medium lift', color: 'var(--warning)' },
  high:   { label: 'Strategic',   color: 'var(--primary)' },
  low:    { label: 'Low lift',    color: 'var(--info)' },
};

// Flag status (visual differentiation from Fail)
const FC = { label: 'Flag', bg: 'var(--warning-soft)', color: 'var(--warning)', icon: '⚑' };

// Effort time ranges
const EFFORT_TIME = {
  done: null,
  quick: '~15 min – 2 hrs',
  medium: '~4 hrs – 2 weeks',
  high: '~2 – 8 weeks',
  low: '~1 – 2 hrs',
};

// Role ownership map
const ROLE_MAP = {
  robots: 'SEO / Content', sitemap: 'SEO / Content', aibots: 'SEO / Content',
  contentsignals: 'SEO / Content', linkheaders: 'SEO / Content',
  markdown: 'Engineering', apicatalog: 'Engineering', oauth: 'Engineering',
  oauthresource: 'Engineering', mcp: 'Engineering', agentskills: 'Engineering',
  webmcp: 'Engineering', webbotauth: 'Engineering', captcha: 'Engineering',
  form_labels: 'Front-End Dev', input_type: 'Front-End Dev', autocomplete: 'Front-End Dev',
  vague_buttons: 'Front-End Dev', interactive_divs: 'Front-End Dev',
  schema_search: 'Front-End Dev', schema_action: 'Front-End Dev',
  js_rendering: 'Front-End Dev', cookie_banner: 'Front-End Dev',
};

// Code snippets for quick-win failing checks
const CODE_SNIPPETS = {
  contentsignals: `# Add to robots.txt
Content-Signal: training=disallow, crawling=allow, summarization=allow`,
  aibots: `# Add to robots.txt
User-agent: GPTBot
Disallow:

User-agent: ClaudeBot
Disallow:

User-agent: anthropic-ai
Disallow:

User-agent: PerplexityBot
Disallow:

User-agent: Google-Extended
Disallow:`,
  linkheaders: `# nginx — add to server block
add_header Link '</sitemap.xml>; rel="sitemap"';

# Apache — add to .htaccess or VirtualHost
Header always set Link "</sitemap.xml>; rel=sitemap"`,
  vague_buttons: `<!-- Before -->
<button type="submit">Submit</button>

<!-- After — use action-specific copy -->
<button type="submit">Request My Appointment</button>
<button type="submit">Confirm and Send Message</button>`,
};

// Level thresholds for tooltip
const LEVELS = [
  { score: '90–100', label: 'Agent Native', level: 4 },
  { score: '75–89', label: 'Agent Ready', level: 3 },
  { score: '50–74', label: 'AI Aware', level: 2 },
  { score: '25–49', label: 'Basic Web Presence', level: 1 },
  { score: '0–24', label: 'Not Indexed', level: 0 },
];

// Scoring weight table for explanation panel
const SCORE_WEIGHTS_TABLE = [
  { cat: 'Discoverability', checks: 3, weight: '20' },
  { cat: 'Content', checks: 1, weight: '10' },
  { cat: 'Bot Access', checks: 3, weight: '20' },
  { cat: 'API / Auth / MCP', checks: 6, weight: '50' },
  { cat: 'On-Page Signals', checks: 5, weight: '34 (when run)' },
  { cat: 'Forms', checks: 5, weight: '29 (when run)' },
];

// Agentic protocol check IDs
const AGENTIC_PROTOCOL_IDS = ['apicatalog', 'oauth', 'oauthresource', 'mcp', 'agentskills', 'webmcp'];

const ROADMAP = [
  {
    tier: 'This week',
    sub: '15 min – 2 hrs each',
    color: 'var(--success)', bg: 'var(--success-soft)',
    checkIds: ['robots', 'aibots', 'contentsignals', 'linkheaders', 'form_labels', 'input_type', 'autocomplete', 'cookie_banner', 'vague_buttons'],
    efforts: { robots: '~15–30 min', aibots: '~30 min', contentsignals: '15 min', linkheaders: '~2 hrs', form_labels: '~1 hr', input_type: '30 min', autocomplete: '30 min', cookie_banner: '30 min', vague_buttons: '1 hr' },
  },
  {
    tier: 'This quarter',
    sub: '1 day – 2 weeks each',
    color: 'var(--info)', bg: 'var(--info-soft)',
    checkIds: ['sitemap', 'markdown', 'apicatalog', 'oauth', 'schema_search', 'schema_action', 'js_rendering', 'interactive_divs'],
    efforts: { sitemap: '~half a day', markdown: '1–3 days', apicatalog: '3–5 days', oauth: '1–2 wks', schema_search: '~1 day', schema_action: '~1 day', js_rendering: '1–2 wks', interactive_divs: '~1 day' },
  },
  {
    tier: 'Strategic horizon',
    sub: '2–8 weeks each',
    color: 'var(--primary)', bg: 'var(--primary-soft)',
    checkIds: ['mcp', 'agentskills', 'webmcp', 'captcha'],
    efforts: { mcp: '2–4 wks', agentskills: '4–6 wks', webmcp: '4–8 wks', captcha: '2–4 wks' },
  },
];

// Weight map for priority sorting
const WEIGHT_MAP = {
  robots: 7, sitemap: 7, linkheaders: 6, markdown: 10, aibots: 11, contentsignals: 9,
  webbotauth: 0, apicatalog: 8, oauth: 8, oauthresource: 8, mcp: 10, agentskills: 10, webmcp: 6,
  form_labels: 10, input_type: 6, autocomplete: 6, schema_search: 5, schema_action: 5,
  captcha: 8, cookie_banner: 6, js_rendering: 8, vague_buttons: 4, interactive_divs: 5,
};

// ─── CodeSnippet component ────────────────────────────────────────────────────
function CodeSnippet({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div style={{ position: 'relative', marginTop: 10, background: '#1E1E2E', borderRadius: 8, padding: '12px 14px' }}>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code snippet"
        style={{ position: 'absolute', top: 8, right: 8, background: copied ? 'var(--success)' : 'var(--text)', color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
      >
        {copied ? '✓ Copied' : '⎘ Copy'}
      </button>
      <pre style={{ margin: 0, fontSize: 12, color: 'var(--border)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', paddingRight: 60 }}>
        {code}
      </pre>
    </div>
  );
}

// ─── ScoreRing component (animated) ──────────────────────────────────────────
function ScoreRing({ score, checkCount, size = 128 }) {
  const [displayScore, setDisplayScore] = useState(0);
  const animationRef = useRef(null);
  const r = 52, cx = 64, cy = 64;
  const circ = 2 * Math.PI * r;

  useEffect(() => {
    // Check prefers-reduced-motion
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setDisplayScore(score); return; }

    const start = performance.now();
    const duration = 800;

    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(eased * score));
      if (t < 1) animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); };
  }, [score]);

  const offset = circ * (1 - displayScore / 100);
  // The dashboard's bands (80 / 60), so this ring and the dashboard card draw
  // the same score in the same colour. It used to switch at 70 / 45.
  const ringColor = scoreBandColor(score) || 'var(--text-3)';

  return (
    <svg width={size} height={size} viewBox="0 0 128 128"
      aria-label={`Agent readiness score: ${score} out of 100`} role="img">
      <title>Agent readiness score: {score} out of 100</title>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={ringColor} strokeWidth="8"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform="rotate(-90 64 64)"
        style={{ transition: 'none' }} />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="28" fontWeight="500" fill={ringColor}
        style={{ fontFamily: 'var(--font-mono)' }}>{displayScore}</text>
      <text x={cx} y={cy + 16} textAnchor="middle" fontSize="12" fill="var(--text-3)">/ 100</text>
    </svg>
  );
}

// ─── CatBar component ─────────────────────────────────────────────────────────
// ─── Score explanation ───────────────────────────────────────────────────────
// The level steps, low to high, with the score each starts at (levelFromScore
// in server/routes/agentReadinessAudit.js).
const LADDER = [
  { min: 0, short: 'Not indexed' },
  { min: 25, short: 'Basic' },
  { min: 50, short: 'AI aware' },
  { min: 75, short: 'Agent ready' },
  { min: 90, short: 'Agent native' },
];

/** Five steps, the current one lit, and the points to the next level. */
function LevelLadder({ score }) {
  const at = LADDER.reduce((idx, l, i) => (score >= l.min ? i : idx), 0);
  const next = LADDER[at + 1];
  const color = score >= 75 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
        {LADDER.map((l, i) => (
          <span key={l.min} title={`Level ${i} — ${l.short} (${l.min}+)`}
            style={{ height: i === at ? 8 : 5, marginTop: i === at ? 0 : 1.5, borderRadius: 3, background: i <= at ? color : 'var(--border)', opacity: i < at ? 0.45 : 1 }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
        {LADDER.map((l, i) => (
          <span key={l.min} style={{ fontSize: 9.5, textAlign: 'center', lineHeight: 1.2, color: i === at ? 'var(--text)' : 'var(--text-3)', fontWeight: i === at ? 700 : 500 }}>
            {l.short}
          </span>
        ))}
      </div>
      {next && (
        <span style={{ fontSize: 11.5, textAlign: 'center', color: 'var(--text-2)' }}>
          <strong style={{ color: 'var(--text)' }}>{next.min - score} pts</strong> to Level {at + 1} — {next.short}
        </span>
      )}
    </div>
  );
}

/** The "i": the formula, the weights, and this audit's own category scores. */
function ReadinessExplainer({ score, cats = [], hasOnPage }) {
  // Only the categories this audit actually scored (a Forms category with no
  // form URL never ran); falls back to the always-run ones without that list.
  const ran = new Set(cats.map((c) => c.id));
  const weights = SCORE_WEIGHTS_TABLE.filter((w) => (ran.size ? ran.has(w.cat) : (hasOnPage || !/when run/.test(w.weight))));
  const maxW = Math.max(...weights.map((w) => parseInt(w.weight, 10) || 0), 1);
  const head = (t) => (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{t}</span>
  );
  const bar = (label, value, max, right, color = 'var(--primary)') => (
    <span key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 34px', alignItems: 'center', gap: 8 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ height: 5, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: color, borderRadius: 999 }} />
      </span>
      <span style={{ textAlign: 'right', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{right}</span>
    </span>
  );
  return (
    <>
      <strong style={{ color: 'var(--text)', fontSize: 13.5 }}>How the Agent Readiness score works</strong>
      <span>How easily AI agents can find, read and act on this site — from crawl access to protocols like MCP and OAuth.</span>
      <span>Every check carries points for its business impact. A pass earns its points; the score is <strong>points earned ÷ points possible</strong>.</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        13 web checks (100 pts) always run; 10 on-page checks add up to 63 pts when an action page or form URL is given.
      </span>
      {head('Points by category')}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {weights.map((w) => bar(w.cat, parseInt(w.weight, 10) || 0, maxW, parseInt(w.weight, 10) || 0))}
      </span>
      {cats.length > 0 && head('This audit')}
      {cats.length > 0 && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {cats.map((c) => bar(c.id, c.score, 100, c.score,
            c.score >= 70 ? 'var(--success)' : c.score >= 45 ? 'var(--warning)' : 'var(--danger)'))}
        </span>
      )}
      <span style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2, var(--surface))', border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text)', fontWeight: 600 }}>
        Overall: {score}/100
      </span>
      {head('Levels')}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5 }}>
        {LEVELS.map((l) => (
          <span key={l.level} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span>Level {l.level} — {l.label}</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{l.score}</span>
          </span>
        ))}
      </span>
    </>
  );
}

// ─── Executive summary, easy to scan ────────────────────────────────────────
// The brief is the model's prose; this lays it out to be read in seconds:
// the headline, one takeaway line (the rest folded), the audit's own results as
// working / needs-work / blocking chips, and three cards led by a short title.
// Briefs written before the titles existed fall back to a clamped sentence.
const firstSentence = (t) => {
  const m = String(t || '').match(/^.+?[.!?](\s|$)/);
  return m ? m[0].trim() : String(t || '');
};

function BriefView({ brief, cats = [] }) {
  const [more, setMore] = useState(false);
  const lead = firstSentence(brief.summary);
  const rest = String(brief.summary || '').slice(lead.length).trim();
  const working = cats.filter((c) => c.score >= 70);
  const middle = cats.filter((c) => c.score >= 45 && c.score < 70);
  const blocking = cats.filter((c) => c.score < 45);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 21, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
          {brief.headline}
        </p>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-2)', lineHeight: 1.55, maxWidth: 820 }}>
          {lead}
          {rest && !more && (
            <button type="button" onClick={() => setMore(true)}
              style={{ marginLeft: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-text)', fontSize: 13, fontWeight: 600 }}>
              Read more
            </button>
          )}
          {rest && more && <> {rest}</>}
        </p>
      </div>

      {/* At a glance, from the checks themselves — not the model's words. */}
      {cats.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <GlanceGroup tone="success" mark="✓" title="Working" cats={working} empty="Nothing scoring 70+ yet" />
          {middle.length > 0 && <GlanceGroup tone="warning" mark="!" title="Needs work" cats={middle} />}
          <GlanceGroup tone="danger" mark="✕" title="Blocking AI agents" cats={blocking} empty="Nothing blocking" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }} className="ara-brief-grid">
        <BriefCard tone="danger" icon="risk" label="Top risk" title={brief.riskTitle} text={brief.risk} />
        <BriefCard tone="primary" icon="up" label="60-day opportunity" title={brief.opportunityTitle} text={brief.opportunity} />
        <BriefCard tone="neutral" icon="compete" label="Competitive context" title={brief.competitiveTitle} text={brief.competitive} />
      </div>
    </div>
  );
}

function GlanceGroup({ tone, mark, title, cats, empty = null }) {
  const color = `var(--${tone})`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color }}>
        <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${color} 16%, var(--card))`, fontSize: 11 }}>{mark}</span>
        {title}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {cats.length ? cats.map((c) => (
          <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 9px', borderRadius: 999, background: 'var(--card)', border: `1px solid color-mix(in srgb, ${color} 30%, var(--border))`, color: 'var(--text)' }}>
            {c.id}
            <strong style={{ color, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{c.score}</strong>
          </span>
        )) : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{empty}</span>}
      </div>
    </div>
  );
}

const BRIEF_ICONS = {
  risk: <><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17v.5" /></>,
  up: <><path d="M4 17l6-6 4 4 6-7" /><path d="M14 8h6v6" /></>,
  compete: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" /></>,
};

function BriefCard({ tone, icon, label, title, text }) {
  const [open, setOpen] = useState(false);
  const color = tone === 'neutral' ? 'var(--text-2)' : tone === 'primary' ? 'var(--primary-text, var(--primary))' : `var(--${tone})`;
  const tint = tone === 'neutral' ? 'var(--text-3)' : tone === 'primary' ? 'var(--primary)' : `var(--${tone})`;
  const clamp = !title && !open;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 16px 14px', borderRadius: 12,
      background: `color-mix(in srgb, ${tint} 8%, var(--card))`, border: `1px solid color-mix(in srgb, ${tint} 28%, var(--border))`,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color, background: `color-mix(in srgb, ${tint} 16%, var(--card))` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{BRIEF_ICONS[icon]}</svg>
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color }}>{label}</span>
      </span>
      {title && <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3 }}>{title}</span>}
      <span style={{
        fontSize: 13, color: title ? 'var(--text-2)' : 'var(--text)', lineHeight: 1.5,
        ...(clamp ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}),
      }}>
        {text}
      </span>
      {!title && String(text || '').length > 110 && (
        <button type="button" onClick={() => setOpen((v) => !v)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary-text)', fontSize: 12, fontWeight: 600 }}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

// ─── The two halves of the score ────────────────────────────────────────────
// HTTP readiness: the 13 site-level checks, points earned of 100. On-page
// readiness: the 10 page-level checks run on the action page / form URL, points
// earned of up to 63. The overall score pools both sets of points
// (server/routes/agentReadinessAudit.js: (httpScore + onPageEarned) / (100 + onPageMax)).
const HALF = {
  http: {
    title: 'Site-level readiness',
    tag: 'HTTP',
    question: 'Can AI agents reach and understand your site from the outside?',
    what: 'Checks made against the site itself — the files and headers an agent reads before it ever opens a page.',
    cats: ['Discoverability', 'Content', 'Bot Access', 'API / Auth / MCP'],
    points: '100 points',
    icon: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  },
  onpage: {
    title: 'Page-level readiness',
    tag: 'On-page',
    question: 'Can AI agents read and use your pages — forms, buttons and structured data?',
    what: 'Checks made on the action page or form you gave — what an agent meets when it tries to do something there.',
    cats: ['On-Page Signals', 'Forms'],
    points: 'up to 63 points',
    icon: <><path d="M5 3h10l4 4v14H5z" /><path d="M9 13h6M9 17h4M8.5 9h3" /></>,
  },
};
const toneOf = (score) => (score >= 70 ? 'success' : score >= 45 ? 'warning' : 'danger');
const RATING = { success: 'Good', warning: 'Needs work', danger: 'Weak' };

function MiniRing({ score, size = 68 }) {
  const stroke = 7; const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const color = `var(--${toneOf(score)})`;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(Math.max(0, Math.min(100, score)) / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color }}>
        {score}
      </span>
    </div>
  );
}

const CHECK_TONE = { pass: 'var(--success)', fail: 'var(--danger)', info: 'var(--warning)' };

function ReadinessHalf({ kind, score, checks = [], cats = [] }) {
  const h = HALF[kind];
  const tone = toneOf(score);
  const myCats = cats.filter((c) => h.cats.includes(c.id));
  const scored = checks.filter((c) => !c.flagOnly);
  const passed = scored.filter((c) => c.status === 'pass').length;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', borderRadius: 14,
      background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span aria-hidden="true" style={{
            width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--primary-text)', background: 'color-mix(in srgb, var(--primary) 12%, var(--card))',
          }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{h.icon}</svg>
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{h.title}</span>
            <span style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.04em' }}>
              {h.tag} · {scored.length} {kind === 'http' ? 'site' : 'page'} check{scored.length === 1 ? '' : 's'} ran
            </span>
          </span>
        </span>
        <InfoTip label={`How ${h.title.toLowerCase()} is scored`} align="right">
          <HalfExplainer kind={kind} score={score} checks={scored} />
        </InfoTip>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <MiniRing score={score} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <span style={{
            alignSelf: 'flex-start', fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
            color: `var(--${tone})`, background: `color-mix(in srgb, var(--${tone}) 14%, var(--card))`,
          }}>{RATING[tone]}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>{h.question}</span>
        </div>
      </div>

      {/* One dot per check: green pass, red fail, amber advisory. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {scored.map((c) => (
            <span key={c.id} title={`${c.label || c.id}: ${c.status}`}
              style={{ width: 11, height: 11, borderRadius: '50%', background: CHECK_TONE[c.status] || 'var(--border)' }} />
          ))}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          <strong style={{ color: 'var(--text)' }}>{passed} of {scored.length}</strong> checks pass
        </span>
      </div>

      {myCats.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          {myCats.map((c) => (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 90px 34px', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.id}</span>
              <span style={{ height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${c.score}%`, background: `var(--${toneOf(c.score)})`, borderRadius: 999 }} />
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 600, textAlign: 'right', color: `var(--${toneOf(c.score)})` }}>{c.score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The "i" for one half: what it measures, every check with its result, the formula. */
function HalfExplainer({ kind, score, checks }) {
  const h = HALF[kind];
  return (
    <>
      <strong style={{ color: 'var(--text)', fontSize: 13.5 }}>{h.title} ({h.tag})</strong>
      <span>{h.what}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
        The {checks.length} checks
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {checks.map((c) => (
          <span key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-hidden="true" style={{ width: 16, textAlign: 'center', fontWeight: 800, color: CHECK_TONE[c.status] || 'var(--text-3)' }}>
              {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '!'}
            </span>
            <span style={{ fontSize: 12 }}>{c.label || c.id}</span>
          </span>
        ))}
      </span>
      <span>Each check is worth points for its business impact; a pass earns them. This score is <strong>points earned ÷ points possible</strong> = <strong>{score}</strong>.</span>
      <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        The overall score pools both halves’ points — site-level checks are worth 100, page-level up to 63 — so site-level readiness weighs more.
      </span>
    </>
  );
}

function CatBar({ cat }) {
  const barColor = scoreBandColor(cat.score) || 'var(--text-3)';
  const textColor = barColor;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{cat.id}</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: textColor }}>{cat.score}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${cat.score}%`, background: barColor, borderRadius: 3 }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{cat.passed} of {cat.total} checks passed</div>
    </div>
  );
}

// ─── CheckRow component ───────────────────────────────────────────────────────
function CheckRow({ check, open, onToggle, isLast }) {
  const isFlag = check.flagOnly;
  const badge = isFlag ? FC : (SC[check.status] || SC.info);
  const badgeLabel = isFlag ? 'Flag' : badge.label;
  const e = EC[check.effort] || EC.medium;

  return (
    <div style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border)' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%', background: 'none', border: 'none', padding: '13px 0',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
        }}
      >
        <span
          style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: badge.bg, color: badge.color }}
          title={isFlag ? 'Advisory — this check is informational and does not affect your score.' : undefined}
        >
          {badge.icon} {badgeLabel}
        </span>
        <span style={{ flex: 1, fontSize: 14, color: 'var(--text)' }}>{check.label}</span>
        <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-3)', marginRight: 2 }}>{check.cat}</span>
        <span style={{ flexShrink: 0, fontSize: 11, color: e.color, border: `0.5px solid ${e.color}`, padding: '2px 7px', borderRadius: 4 }}>
          {e.label}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 12, marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ paddingBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5, fontWeight: 500 }}>
                Technical finding
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
                {check.tech}
              </p>
            </div>
            <div style={{ background: 'var(--surface)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5, fontWeight: 500 }}>
                Business impact
              </div>
              <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.6 }}>
                {check.business}
              </p>
            </div>
          </div>

          {check.status !== 'pass' && check.detail && check.detail !== check.tech && (
            <div style={{ background: 'var(--warning-soft)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, borderLeft: '3px solid var(--warning)' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                Specific issues found
              </div>
              <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.6, fontFamily: 'var(--font-mono)' }}>{check.detail}</p>
            </div>
          )}

          {check.action && (
            <div style={{ background: 'var(--info-soft)', borderRadius: 8, padding: '10px 12px', borderLeft: '3px solid var(--info)' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--info)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                Recommended action
              </div>
              <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.6 }}>{check.action}</p>
            </div>
          )}

          {check.effort === 'quick' && check.status !== 'pass' && CODE_SNIPPETS[check.id] && (
            <CodeSnippet code={CODE_SNIPPETS[check.id]} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── SkeletonLine component ───────────────────────────────────────────────────
function SkeletonLine({ w = '100%' }) {
  return <div style={{ height: 13, background: 'var(--border)', borderRadius: 4, marginBottom: 7, width: w }} />;
}

// ─── Main page component ──────────────────────────────────────────────────────
export default function AgentReadinessAuditPage() {
  // Which screen to draw: 'loading' until ProjectReportBar has worked out
  // whether this client has a stored report, then 'report' or 'none'. Starting
  // at 'loading' is the point — the input form used to render on mount and be
  // replaced a moment later.
  const [reportState, setReportState] = useState('loading');
  // Opened within a project, the project's own bar above (ProjectReportBar) is
  // how you run or re-run an audit — "Run it now", page picker, "Analyze
  // another page". The manual URL form below is for standalone use only; inside
  // a project it would be a second, redundant way to start the same audit.
  const [activeProjectId] = useActiveProjectId();
  const [urlHomepage, setUrlHomepage] = useState('');
  const [urlAction, setUrlAction]     = useState('');
  const [urlForm, setUrlForm]         = useState('');
  const [loading, setLoading]         = useState(false);
  const [pdfLoading, setPdfLoading]   = useState(false);
  const [error, setError]             = useState('');
  const [result, setResult]           = useState(null);
  const [expanded, setExpanded]       = useState(null);
  const [filterCat, setFilterCat]     = useState('all');

  // New state
  const [sortMode, setSortMode]               = useState('priority');
  const [scorePanelOpen, setScorePanelOpen]   = useState(false);
  const [levelTooltipOpen, setLevelTooltipOpen] = useState(false);
  // The report answers to two readers. 'summary' is the one a CXO needs —
  // score, what it costs, what a week of work buys. 'details' is the same
  // audit for whoever has to do the work: every check, and the roadmap.
  const [view, setView] = useState('summary');
  const [delta, setDelta]                     = useState(null);
  const [actionSuggestions, setActionSuggestions] = useState([]);
  const [formSuggestions, setFormSuggestions] = useState([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [copiedRoadmap, setCopiedRoadmap]     = useState(false);
  const [sharedBrief, setSharedBrief]         = useState(false);
  const debounceRef = useRef(null);

  // ── URL auto-discovery ────────────────────────────────────────────────────
  async function discoverLinks(url) {
    if (!url || !url.trim()) return;
    setDiscoverLoading(true);
    try {
      const res = await fetch(`/api/agent-readiness-audit/discover-links?url=${encodeURIComponent(url.trim())}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setActionSuggestions(data.actionCandidates || []);
        setFormSuggestions(data.formCandidates || []);
      }
    } catch {}
    setDiscoverLoading(false);
  }

  // ── finishAudit (shared between stream and fallback) ──────────────────────
  function finishAudit(data) {
    setResult(data);
    setLoading(false);
    // Store delta
    try {
      const domain = new URL(data.site.full).hostname;
      const storageKey = `ara_last_${domain}`;
      const prev = localStorage.getItem(storageKey);
      if (prev) {
        const prevData = JSON.parse(prev);
        const diff = data.site.score - prevData.score;
        setDelta({ diff, prevScore: prevData.score, prevDate: prevData.date });
      }
      localStorage.setItem(storageKey, JSON.stringify({
        score: data.site.score,
        level: data.site.level,
        date: data.site.date,
      }));
    } catch {}
  }

  // ── handleAudit (with SSE streaming + fallback) ───────────────────────────
  async function handleAudit(e) {
    e.preventDefault();
    if (!urlHomepage.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    setView('summary');
    setExpanded(null);
    setFilterCat('all');
    setDelta(null);

    try {
      const resp = await fetch('/api/agent-readiness-audit/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          url_homepage: urlHomepage.trim(),
          url_action: urlAction.trim() || undefined,
          url_form: urlForm.trim() || undefined,
        }),
      });

      if (!resp.ok || !resp.body) throw new Error('stream_unavailable');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = null;
      let streamResult = null;

      const processEvents = (text) => {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'complete') {
                streamResult = data;
              }
            } catch {}
            currentEvent = null;
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processEvents(decoder.decode(value, { stream: true }));
      }

      if (streamResult) {
        finishAudit(streamResult);
      } else {
        throw new Error('stream_incomplete');
      }
    } catch (streamErr) {
      // Fallback to non-streaming endpoint
      try {
        const res = await fetch('/api/agent-readiness-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            url_homepage: urlHomepage.trim(),
            url_action: urlAction.trim() || undefined,
            url_form: urlForm.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Audit failed');
        }
        const data = await res.json();
        finishAudit(data);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }
  }

  // ── handleDownloadPdf ─────────────────────────────────────────────────────
  async function handleDownloadPdf() {
    if (!result) return;
    setPdfLoading(true);
    try {
      const res = await fetch('/api/agent-readiness-audit/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(result),
      });
      if (!res.ok) throw new Error('PDF generation failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent-readiness-${result.site.url}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setPdfLoading(false);
    }
  }

  // ── shareSummary ──────────────────────────────────────────────────────────
  function shareSummary() {
    if (!result?.cmoBrief) return;
    const payload = {
      brief: result.cmoBrief,
      url: result.site.url,
      full: result.site.full,
      score: result.site.score,
      level: result.site.level,
      date: result.site.date,
    };
    const encoded = btoa(JSON.stringify(payload));
    const shareUrl = `${window.location.origin}/agent-readiness-audit/summary?d=${encoded}`;
    navigator.clipboard.writeText(shareUrl);
    setSharedBrief(true);
    setTimeout(() => setSharedBrief(false), 2000);
  }

  // ── copyRoadmap ───────────────────────────────────────────────────────────
  function copyRoadmap() {
    const lines = [`## Agent Readiness Roadmap — ${result.site.url}`, `Scanned ${result.site.date} · Score: ${result.site.score}/100`, ''];
    for (const tier of ROADMAP) {
      const tierChecks = tier.checkIds.map(id => allChecks.find(c => c.id === id)).filter(Boolean);
      const failing = tierChecks.filter(c => c.status !== 'pass');
      if (failing.length === 0) continue;
      lines.push(`### ${tier.tier}`);
      for (const c of failing) {
        const role = ROLE_MAP[c.id] || 'Team';
        const time = EFFORT_TIME[c.effort] || tier.efforts[c.id] || '–';
        lines.push(`- [ ] ${c.label} (${role} · ${time})`);
      }
      lines.push('');
    }
    const passing = allChecks.filter(c => c.status === 'pass');
    if (passing.length > 0) {
      lines.push('### Already Done ✓');
      passing.forEach(c => lines.push(`- [x] ${c.label}`));
    }
    navigator.clipboard.writeText(lines.join('\n'));
    setCopiedRoadmap(true);
    setTimeout(() => setCopiedRoadmap(false), 2000);
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const httpChecks    = result?.checks || [];
  const onPageChecks  = result?.onPageChecks || [];
  const allChecks     = [...httpChecks, ...onPageChecks];
  const passCount     = allChecks.filter(c => c.status === 'pass').length;
  const failCount     = allChecks.filter(c => c.status === 'fail').length;
  const infoCount     = allChecks.filter(c => c.status === 'info').length;
  const catFilters    = ['all', ...(result?.cats || []).map(c => c.id)];
  const hasOnPage     = onPageChecks.length > 0;
  const checkCount    = allChecks.length;
  // The figures the info icons and the legend quote — this report's own.
  const explainCtx = result ? {
    score: result.site.score,
    checkCount,
    cats: (result.cats || []).map((c) => c.id),
    level: result.site.level,
    passCount,
    failCount,
    infoCount,
  } : null;

  // Sorted + filtered checks
  const filtered = useMemo(() => {
    const base = filterCat === 'all' ? allChecks : allChecks.filter(c => c.cat === filterCat);
    if (sortMode === 'priority') {
      return [...base].sort((a, b) => {
        const aFail = a.status !== 'pass' ? 0 : 1;
        const bFail = b.status !== 'pass' ? 0 : 1;
        if (aFail !== bFail) return aFail - bFail;
        return (WEIGHT_MAP[b.id] || 0) - (WEIGHT_MAP[a.id] || 0);
      });
    }
    return base;
  }, [allChecks, filterCat, sortMode]);

  // Detect if all agentic protocol checks are failing
  const agenticAllFailing = useMemo(() => {
    if (allChecks.length === 0) return false;
    return AGENTIC_PROTOCOL_IDS.every(id => {
      const c = allChecks.find(ch => ch.id === id);
      return c && c.status !== 'pass';
    });
  }, [allChecks]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '2rem 1.5rem' }}>
        {/* The report renders entirely from `result`, so handing the stored run
            to setResult reproduces an individual run exactly. */}
        <ProjectReportBar
          moduleKey="agent_readiness"
          onOpenReport={(native) => setResult(native)}
          onResolved={setReportState}
        />

        {/* Agent importance one-liner — the report's summary tab makes this
            same point in its own card, so it shows only before there is one. */}
        {!result && <div style={{ background: 'var(--primary)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⚡</span>
          <p style={{ fontSize: 13, color: '#fff', margin: 0, lineHeight: 1.5 }}>
            <strong style={{ color: '#fff' }}>AI agents are replacing browsers as the primary interface to the web.</strong>{' '}
            Sites optimized for agents get found, cited, and transacted with — those that aren't get bypassed entirely. By 2027, agents will initiate the majority of commercial queries.
          </p>
        </div>}

        {/* URL Inputs — standalone use only; see the note by activeProjectId above. */}
        {!activeProjectId && <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: '1.5rem', marginBottom: '1.5rem', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>Audit a website's AI agent readiness</h2>
          <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 20px' }}>
            Provide up to three URLs for a full audit: 13 HTTP checks run on all sites; 10 additional on-page checks require the action and form URLs.
          </p>
          <form onSubmit={handleAudit}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Homepage <span style={{ color: 'var(--danger)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={urlHomepage}
                  onChange={e => {
                    setUrlHomepage(e.target.value);
                    if (debounceRef.current) clearTimeout(debounceRef.current);
                    debounceRef.current = setTimeout(() => discoverLinks(e.target.value), 800);
                  }}
                  onBlur={e => {
                    if (debounceRef.current) clearTimeout(debounceRef.current);
                    discoverLinks(e.target.value);
                  }}
                  placeholder="https://example.com"
                  disabled={loading}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    border: '1px solid var(--border)', borderRadius: 8,
                    padding: '8px 14px', fontSize: 13,
                    color: 'var(--text)', background: 'var(--card)',
                    outline: 'none',
                  }}
                />
                {discoverLoading && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px solid var(--primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                    Discovering links…
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }} className="ara-form-grid">
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Key action page <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)', textTransform: 'none' }}>optional — product / service page</span>
                  </label>
                  <input
                    type="text"
                    value={urlAction}
                    onChange={e => setUrlAction(e.target.value)}
                    placeholder="https://example.com/product"
                    disabled={loading}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      border: '1px solid var(--border)', borderRadius: 8,
                      padding: '8px 14px', fontSize: 13,
                      color: 'var(--text)', background: 'var(--card)',
                      outline: 'none',
                    }}
                  />
                  {actionSuggestions.length > 0 && !urlAction && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {actionSuggestions.map(s => (
                        <button key={s.full} type="button"
                          onClick={() => setUrlAction(s.full)}
                          style={{ fontSize: 11, color: 'var(--primary-text)', background: 'var(--primary-soft)', border: '0.5px solid var(--primary)', borderRadius: 20, padding: '3px 10px', cursor: 'pointer' }}>
                          → {s.path} <span style={{ opacity: 0.6, marginLeft: 3 }}>suggested</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Form / checkout page <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)', textTransform: 'none' }}>optional — contact / checkout</span>
                  </label>
                  <input
                    type="text"
                    value={urlForm}
                    onChange={e => setUrlForm(e.target.value)}
                    placeholder="https://example.com/contact"
                    disabled={loading}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      border: '1px solid var(--border)', borderRadius: 8,
                      padding: '8px 14px', fontSize: 13,
                      color: 'var(--text)', background: 'var(--card)',
                      outline: 'none',
                    }}
                  />
                  {formSuggestions.length > 0 && !urlForm && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {formSuggestions.map(s => (
                        <button key={s.full} type="button"
                          onClick={() => setUrlForm(s.full)}
                          style={{ fontSize: 11, color: 'var(--primary-text)', background: 'var(--primary-soft)', border: '0.5px solid var(--primary)', borderRadius: 20, padding: '3px 10px', cursor: 'pointer' }}>
                          → {s.path} <span style={{ opacity: 0.6, marginLeft: 3 }}>suggested</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || !urlHomepage.trim()}
              style={{
                background: 'var(--primary)', color: '#fff',
                border: 'none', borderRadius: 8,
                padding: '9px 20px', fontSize: 13, fontWeight: 500,
                cursor: loading || !urlHomepage.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !urlHomepage.trim() ? 0.5 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {loading ? 'Running audit…' : 'Run Audit'}
            </button>
          </form>

          {loading && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
              <div style={{ width: 16, height: 16, border: '2px solid var(--primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Running {urlAction || urlForm ? '23' : '13'} checks
              {(urlAction || urlForm) && ' including browser-rendered on-page checks'}… (~{urlAction || urlForm ? '35' : '15'}s)
            </div>
          )}
          {error && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--danger)', background: 'var(--danger-soft)', borderRadius: 8, padding: '8px 14px' }}>{error}</div>
          )}
        </div>}

        {/* Resolved before drawn — see ReportResolving. */}
        {reportState === 'loading' && !result && !loading && <ReportResolving maxWidth={960} />}

        {/* Within a project with nothing stored yet, ProjectReportBar's own bar
            above already says so and offers "Run it now" — this empty state is
            only for standalone use, where there is a form to point at. */}
        {!activeProjectId && !result && !loading && reportState !== 'loading' && (
          <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--text-3)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
            <p style={{ fontSize: 13, margin: '0 0 4px' }}>Enter a URL above to audit its agent readiness.</p>
            <p style={{ fontSize: 12, margin: 0 }}>Add the action and form URLs for on-page checks.</p>
          </div>
        )}

        {result && (
          <div style={{ paddingBottom: '1.5rem' }}>
            {/* Site header — the audit's identity, and the two things you do
                with a finished one: take it elsewhere, or open the page. */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }} className="ara-header-row">
              <div>
                <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--primary-text)', marginBottom: 5 }}>
                  Agent Readiness Audit
                </div>
                <h1 style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 4px', color: 'var(--text)' }}>
                  {result.site.url}
                </h1>
                <div style={{ fontSize: 13, color: 'var(--text-2)', position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    onMouseEnter={() => setLevelTooltipOpen(true)}
                    onMouseLeave={() => setLevelTooltipOpen(false)}
                    style={{ cursor: 'help', borderBottom: '1px dashed var(--text-3)' }}
                  >
                    {result.site.level}
                  </span>
                  &nbsp;&middot;&nbsp; Scanned {result.site.date}
                  {hasOnPage && <span style={{ marginLeft: 6, fontSize: 11, background: 'var(--primary-soft)', color: 'var(--primary-text)', padding: '1px 7px', borderRadius: 10 }}>+10 on-page checks</span>}
                  {levelTooltipOpen && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, background: 'var(--card)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '8px 12px', zIndex: 50, boxShadow: 'var(--shadow-md)', minWidth: 220 }}>
                      {LEVELS.map(l => (
                        <div key={l.level} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0', color: result.site.level.includes(l.label) ? 'var(--primary)' : 'var(--text-2)', fontWeight: result.site.level.includes(l.label) ? 600 : 400 }}>
                          <span>Level {l.level} &mdash; {l.label}</span>
                          <span style={{ color: 'var(--text-3)' }}>{l.score}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={handleDownloadPdf}
                  disabled={pdfLoading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    height: 34, padding: '0 14px',
                    fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                    color: 'var(--text)', background: 'transparent',
                    border: '1px solid var(--border)', borderRadius: 8,
                    cursor: 'pointer', opacity: pdfLoading ? 0.6 : 1,
                  }}
                >
                  {pdfLoading
                    ? <><span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Generating&hellip;</>
                    : <>Download PDF</>}
                </button>
                <a href={result.site.full} target="_blank" rel="noreferrer"
                  style={{ fontSize: 12, color: 'var(--primary-text)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {result.site.full} &#8599;
                </a>
              </div>
            </div>

            {/* One audit, two readers. */}
            <div role="tablist" style={{ display: 'flex', gap: 22, borderBottom: '1px solid var(--border)', marginBottom: 22 }}>
              {[['summary', 'Summary'], ['details', 'More Tech Details']].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  id={`view-${id}`}
                  onClick={() => setView(id)}
                  style={{
                    padding: '0 0 12px', marginBottom: -1,
                    fontFamily: 'var(--font-sans)', fontSize: 15,
                    fontWeight: view === id ? 600 : 400,
                    color: view === id ? 'var(--text)' : 'var(--text-3)',
                    background: 'none', border: 'none',
                    borderBottom: `2px solid ${view === id ? 'var(--primary)' : 'transparent'}`,
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ══════════════════════ SUMMARY ══════════════════════ */}
            <Legend screen="agent" ctx={explainCtx} />

            {view === 'summary' && (
              <div role="tabpanel" aria-labelledby="view-summary" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20, alignItems: 'stretch' }} className="ara-score-grid">
                  <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '20px 20px 18px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>
                    {/* The "i": how the number is made, from this audit's own figures. */}
                    <span style={{ position: 'absolute', top: 12, right: 12 }}>
                      <InfoTip label="How the Agent Readiness score is calculated" align="left">
                        <ReadinessExplainer score={result.site.score} cats={result.cats} hasOnPage={hasOnPage} />
                      </InfoTip>
                    </span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
                      Agent readiness
                    </span>
                    <ScoreRing score={result.site.score} checkCount={checkCount} size={140} />
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{result.site.level}</span>
                    <LevelLadder score={result.site.score} />
                    <span style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center' }}>
                      Based on {hasOnPage ? '23 checks across 6 categories' : '13 HTTP checks across 4 categories'}
                    </span>
                    {/* Movement since the last audit of this host. */}
                    {delta && (
                      <div style={{ marginTop: 2, width: '100%', fontSize: 11, padding: '3px 8px', borderRadius: 6,
                        background: delta.diff > 0 ? 'var(--success-soft)' : delta.diff < 0 ? 'var(--warning-soft)' : 'var(--surface)',
                        color: delta.diff > 0 ? 'var(--success)' : delta.diff < 0 ? 'var(--warning)' : 'var(--text-2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                        <span>{delta.diff > 0 ? `↑ ${delta.diff} pts` : delta.diff < 0 ? `↓ ${Math.abs(delta.diff)} pts` : 'No change'} since {delta.prevDate}</span>
                        {/* Wrapped like the read and write of this same key above:
                            accessing localStorage THROWS outright when site data is
                            blocked, so an unguarded removeItem here threw inside the
                            click handler. React does not route event-handler errors to
                            an error boundary, so it surfaced as an uncaught exception
                            while the dismissal appeared to half-work. */}
                        <button type="button" onClick={() => { setDelta(null); try { localStorage.removeItem(`ara_last_${new URL(result.site.full).hostname}`); } catch { /* storage blocked — the dismissal still applies to this view */ } }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12, padding: 0, lineHeight: 1 }}>&times;</button>
                      </div>
                    )}
                  </div>

                  <div style={{
                    position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16,
                    padding: '26px 30px', borderRadius: 14, boxShadow: 'var(--shadow-md)',
                    background: 'linear-gradient(135deg, var(--primary) 0%, color-mix(in srgb, var(--primary) 78%, #000) 100%)',
                  }}>
                    {/* A large, faint agent mark behind the copy. */}
                    <svg aria-hidden="true" width="220" height="220" viewBox="0 0 24 24" fill="none" stroke="var(--text-on-primary)" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round"
                      style={{ position: 'absolute', right: -30, bottom: -40, opacity: 0.08 }}>
                      <rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M9 12h.01M15 12h.01M9.5 15.5h5" /><circle cx="12" cy="3" r="1" />
                    </svg>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                      <span aria-hidden="true" style={{
                        width: 32, height: 32, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--text-on-primary) 16%, transparent)', color: 'var(--text-on-primary)',
                      }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="4" y="7" width="16" height="12" rx="3" /><path d="M12 7V4M9 12h.01M15 12h.01" />
                        </svg>
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-on-primary)', opacity: 0.9 }}>
                        Why this matters
                      </span>
                    </span>
                    <p style={{ position: 'relative', margin: 0, fontSize: 19, fontWeight: 500, color: 'var(--text-on-primary)', lineHeight: 1.45, maxWidth: 640 }}>
                      AI agents are replacing browsers as the primary interface to the web.
                    </p>
                    <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
                      {[
                        ['Found & cited', 'Sites built for agents get recommended and quoted.'],
                        ['Transacted with', 'Agents can book, buy and fill forms on them.'],
                        ['Or bypassed', 'Sites agents can’t read get skipped entirely.'],
                      ].map(([title, text]) => (
                        <div key={title} style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--text-on-primary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--text-on-primary) 18%, transparent)' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-on-primary)' }}>{title}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-on-primary)', opacity: 0.85, lineHeight: 1.45, marginTop: 2 }}>{text}</div>
                        </div>
                      ))}
                    </div>
                    <span style={{ position: 'relative', fontSize: 12, color: 'var(--text-on-primary)', opacity: 0.8 }}>
                      By 2027, agents will initiate the majority of commercial queries.
                    </span>
                  </div>
                </div>

                <div data-explain-box style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '24px 26px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span className="explain-label-row">
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--primary-text)' }}>
                        Executive summary
                      </span>
                      <InfoDot explainKey="a_brief" ctx={explainCtx} />
                    </span>
                    {result.cmoBrief && (
                      <button type="button" onClick={shareSummary} className="ara-share-btn"
                        style={{ fontSize: 11, color: 'var(--primary-text)', background: 'transparent', border: '1px solid var(--primary)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
                        {sharedBrief ? '✓ Link copied!' : 'Share summary'}
                      </button>
                    )}
                  </div>
                  {result.cmoBrief ? (
                    <BriefView brief={result.cmoBrief} cats={result.cats} />
                  ) : (
                    <div>
                      <SkeletonLine w="55%" />
                      <div style={{ height: 8 }} />
                      <SkeletonLine w="100%" /><SkeletonLine w="90%" /><SkeletonLine w="70%" />
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>Executive Summary unavailable (check OPENAI_API_KEY)</div>
                    </div>
                  )}
                </div>

                {/* The projection comes from the server, computed with the same
                    weights and the same combined-score formula the score uses.
                    It replaced a hard-coded "score + 16". */}
                {result.site.quickWinCount > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px 24px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 240 }}>
                      <span style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--text)' }}>
                        Quick wins this week could raise the score to{' '}
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--primary-text)', fontWeight: 700 }}>
                          {result.site.quickWinScore}/100
                        </span>
                      </span>
                      <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                        {result.site.quickWinCount} {result.site.quickWinCount === 1 ? 'fix' : 'fixes'}, each under 2 hours &mdash; see More Tech Details for the roadmap.
                      </span>
                    </div>
                    <button type="button" onClick={() => setView('details')}
                      style={{ flexShrink: 0, height: 40, padding: '0 18px', fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--primary-text)', background: 'transparent', border: '1px solid var(--primary)', borderRadius: 8, cursor: 'pointer' }}>
                      See the technical detail &rarr;
                    </button>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }} className="ara-sub-scores">
                  {[
                    { label: 'Checks passed', value: passCount, color: 'var(--primary-text)' },
                    { label: 'Checks failed', value: failCount, color: 'var(--danger)' },
                    { label: 'Advisory flags', value: infoCount, color: 'var(--warning)' },
                  ].map(t => (
                    <div key={t.label} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 18, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
                      <span style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{t.label}</span>
                      <span style={{ fontSize: 28, fontWeight: 700, color: t.color, fontFamily: 'var(--font-mono)' }}>{t.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ══════════════════ MORE TECH DETAILS ══════════════════ */}
            {view === 'details' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 22, marginBottom: 22 }}>
                {/* The two halves of the score, when the on-page half ran. */}
                {hasOnPage && result.site.onPageScore !== null && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }} className="ara-sub-scores">
                    <ReadinessHalf kind="http" score={result.site.httpScore} checks={httpChecks} cats={result.cats} />
                    <ReadinessHalf kind="onpage" score={result.site.onPageScore} checks={onPageChecks} cats={result.cats} />
                  </div>
                )}

                <div data-explain-box style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '22px 24px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <span className="explain-label-row explain-label-row--title">
                      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Score by category</span>
                      <InfoDot explainKey="a_sub" ctx={explainCtx} />
                    </span>
                    <button type="button" aria-label="How is this score calculated?"
                      onClick={() => setScorePanelOpen(o => !o)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 13, padding: 0, lineHeight: 1 }}>
                      How is this scored?
                    </button>
                  </div>
                  {result.cats.map(cat => <CatBar key={cat.id} cat={cat} />)}
                </div>

                {/* What the score is made of — kept because a weighted score
                    nobody can audit is a number to be argued with. */}
                {scorePanelOpen && (
                  <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 14 }}>
                    <p style={{ fontSize: 12, color: 'var(--text)', margin: '0 0 10px', lineHeight: 1.7 }}>
                      <strong>How this score is calculated</strong><br />
                      The overall score combines up to 23 checks across 6 categories. Each check carries a weight based on its business impact. HTTP checks (13 total) run on every audit and form the foundation score. On-page checks (10 additional) only run when an action page or form URL is provided.
                    </p>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 10 }}>
                      <thead>
                        <tr>{['Category', 'Checks', 'Total Weight'].map(h => <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {SCORE_WEIGHTS_TABLE.map(row => (
                          <tr key={row.cat}>
                            <td style={{ padding: '4px 8px', color: 'var(--text)' }}>{row.cat}</td>
                            <td style={{ padding: '4px 8px', color: 'var(--text-2)' }}>{row.checks}</td>
                            <td style={{ padding: '4px 8px', color: 'var(--text)', fontWeight: 500 }}>{row.weight}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ fontSize: 11, color: 'var(--text-3)', margin: 0 }}>On-page checks add up to 63 points of possible additional signal. Add your action and form URLs to unlock the full audit.</p>
                  </div>
                )}

                <span data-explain-box className="explain-label-row explain-label-row--title" style={{ alignSelf: 'flex-start', borderRadius: 'var(--r-sm)' }}>
                  <h6 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                    Every check &mdash; {allChecks.length}
                  </h6>
                  <InfoDot explainKey="a_checks" ctx={explainCtx} />
                </span>
              </div>
            )}

            {/* Findings tab */}
            {view === 'details' && (
              <div>
                {/* Sort controls + filter chips row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {catFilters.map(c => (
                      <button key={c} type="button"
                        aria-pressed={filterCat === c}
                        onClick={() => setFilterCat(c)}
                        style={{
                          fontSize: 12, padding: '4px 11px', borderRadius: 20, cursor: 'pointer',
                          border: '0.5px solid var(--border)',
                          background: filterCat === c ? 'var(--text)' : 'var(--surface)',
                          color: filterCat === c ? '#fff' : 'var(--text-2)',
                          fontWeight: filterCat === c ? 500 : 400,
                        }}>
                        {c === 'all' ? `All (${allChecks.length})` : c}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[['priority', 'By priority'], ['category', 'By category']].map(([mode, label]) => (
                      <button key={mode} type="button" onClick={() => setSortMode(mode)}
                        style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, border: '0.5px solid var(--border)', cursor: 'pointer',
                          background: sortMode === mode ? 'var(--text)' : 'var(--surface)', color: sortMode === mode ? '#fff' : 'var(--text-2)' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Findings legend */}
                <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  {[
                    { bg: 'var(--success-soft)', color: 'var(--success)', label: 'Pass' },
                    { bg: 'var(--danger-soft)', color: 'var(--danger)', label: 'Fail' },
                    { bg: 'var(--warning-soft)', color: 'var(--warning)', label: 'Flag (advisory)' },
                    { bg: 'var(--warning-soft)', color: 'var(--warning)', label: 'Info' },
                  ].map(b => (
                    <span key={b.label} style={{ fontSize: 10, background: b.bg, color: b.color, padding: '2px 7px', borderRadius: 4, fontWeight: 500 }}>
                      {b.label}
                    </span>
                  ))}
                </div>

                {/* Agentic Protocol callout (when all failing) */}
                {agenticAllFailing && (filterCat === 'all' || filterCat === 'API / Auth / MCP') && (
                  <div style={{ background: 'var(--warning-soft)', border: '0.5px solid var(--warning)', borderRadius: 8, padding: '10px 14px', marginBottom: 10, borderLeft: '3px solid var(--warning)' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>Agentic Protocol Setup — None configured</div>
                    <p style={{ fontSize: 12, color: 'var(--text)', margin: 0, lineHeight: 1.6 }}>
                      <strong>None of these protocols are configured.</strong> These are emerging standards for AI agent integration. They're not required today, but sites that adopt them early will have a significant advantage as agent traffic grows. Start with API catalog — it's a medium lift and unlocks the most downstream value.
                    </p>
                  </div>
                )}

                <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '0 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  {filtered.map((check, i) => (
                    <CheckRow
                      key={check.id}
                      check={check}
                      open={expanded === check.id}
                      isLast={i === filtered.length - 1}
                      onToggle={() => setExpanded(expanded === check.id ? null : check.id)}
                    />
                  ))}
                </div>
                {!hasOnPage && (
                  <div style={{ marginTop: 10, padding: '8px 14px', background: 'var(--warning-soft)', borderRadius: 8, fontSize: 12, color: 'var(--warning)' }}>
                    Add an action page and form page URL above to unlock 10 additional on-page checks covering forms, schema markup, CAPTCHA, and rendering gaps.
                  </div>
                )}
              </div>
            )}

            {/* Roadmap tab */}
            {view === 'details' && (
              <div style={{ marginTop: 22 }}>
                {/* The roadmap's own heading, sharing its row with the one
                    thing you do with a roadmap: take it somewhere else. */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Priority roadmap</span>
                  <button type="button" onClick={copyRoadmap}
                    style={{ fontSize: 12, color: 'var(--primary-text)', background: 'var(--primary-soft)', border: '0.5px solid var(--primary)', borderRadius: 7, padding: '6px 12px', cursor: 'pointer' }}>
                    {copiedRoadmap ? '✓ Copied!' : '⎘ Copy as checklist'}
                  </button>
                </div>

                <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '0 0 1rem', lineHeight: 1.6 }}>
                  Prioritized by impact-to-effort ratio. Quick wins deliver immediate governance and discoverability signal; the strategic horizon positions you for the AI agent economy.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }} className="ara-roadmap-grid">
                  {ROADMAP.map(tier => {
                    const tierChecks = tier.checkIds
                      .map(id => allChecks.find(c => c.id === id))
                      .filter(Boolean);
                    if (tierChecks.length === 0) return null;
                    return (
                      <div key={tier.tier} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                        <div style={{ background: tier.bg, padding: '14px 16px' }}>
                          <span style={{ fontSize: 14, fontWeight: 500, color: tier.color }}>{tier.tier}</span>
                          <div style={{ fontSize: 12, color: tier.color, marginTop: 2, opacity: 0.8 }}>{tier.sub}</div>
                        </div>
                        <div style={{ padding: '12px 16px' }}>
                          {tierChecks.map((check, i) => (
                            <div key={check.id} style={{
                              paddingBottom: i < tierChecks.length - 1 ? 12 : 0,
                              marginBottom: i < tierChecks.length - 1 ? 12 : 0,
                              borderBottom: i < tierChecks.length - 1 ? '0.5px solid var(--border)' : 'none',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: SC[check.status]?.bg, color: SC[check.status]?.color }}>
                                  {check.status === 'pass' ? '✓ Done' : check.flagOnly ? '⚑ Flag' : '✗ Missing'}
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{check.label}</span>
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.4, marginBottom: 5 }}>
                                {check.action ? check.action.split('.')[0] + '.' : 'Already implemented.'}
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, flexWrap: 'wrap' }}>
                                {check.status === 'pass' ? (
                                  <span style={{ fontSize: 11, color: 'var(--success)', background: 'var(--success-soft)', padding: '2px 7px', borderRadius: 3 }}>✓ Done</span>
                                ) : (
                                  <>
                                    <span style={{ fontSize: 11, color: tier.color, background: tier.bg, padding: '2px 7px', borderRadius: 3 }}>
                                      {EC[check.effort]?.label || 'Medium lift'} · {EFFORT_TIME[check.effort] || tier.efforts[check.id] || '–'}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'var(--text-2)', background: 'var(--surface)', padding: '2px 7px', borderRadius: 10 }}>
                                      {ROLE_MAP[check.id] || 'Team'}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: '1rem', padding: '10px 14px', background: 'var(--surface)', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Effort estimates assume a developer familiar with your stack. WebMCP is not checkable via HTTP — marked fail by default. On-page checks require the action/form URLs to be provided. Score gain estimates are approximate.
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        <ModuleRuns toolId="agent-readiness-audit" />
      </main>

      {/* The 640px rules that used to live here now sit with the other report
          modules in index.css, so this page's layout is findable in the same
          place as the rest. The keyframe stays: it is used only by this page's
          spinners and is defined nowhere else. */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
