const express = require('express');
const router = express.Router();
const axios = require('axios');
const { createLlmClient } = require('../services/llmProviders');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const fs = require('fs');
const { runOnPageChecks } = require('../checks/onpage');
const { discoverLinks } = require('../utils/linkDiscovery');
// The SSRF guard. Lives under contentArchitect because that module needed it
// first, but it is generic (assertPublicHost / isBlockedIp / UnsafeUrlError) and
// is imported here rather than reimplemented — see the note at its call site.
const { assertPublicHost } = require('../modules/contentArchitect/urlSafety');

function findLocalBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ── Scoring weights (must sum to 100, webbotauth = 0 = informational) ────────
const WEIGHTS = {
  robots: 7, sitemap: 7, linkheaders: 6,
  markdown: 10,
  aibots: 11, contentsignals: 9, webbotauth: 0,
  apicatalog: 8, oauth: 8, oauthresource: 8, mcp: 10, agentskills: 10, webmcp: 6,
};

// ── The quick-win projection ────────────────────────────────────────────────
//
// "Fixing this week's quick wins would take you to N/100" — the one number in
// the report a non-technical reader acts on. It lives here rather than in the
// client because it needs the weights above AND the combined-score formula: an
// audit with on-page checks scores (httpScore + onPageEarned) / (100 +
// onPageMax), so projecting it is not a matter of adding up weights.
//
// Only status 'fail' counts. An 'info' check is an advisory flag, not a failure,
// and webbotauth carries weight 0 — counting either would promise a gain that
// fixing them cannot deliver.
function quickWinProjection({ rawHttpChecks, httpScore, onPageChecks, onPageMax, onPageEarned }) {
  let gain = 0;
  let count = 0;

  for (const [id, result] of Object.entries(rawHttpChecks || {})) {
    if (result.status !== 'fail') continue;
    if (CHECK_META[id]?.effort !== 'quick') continue;
    gain += WEIGHTS[id] || 0;
    count += 1;
  }

  for (const check of onPageChecks || []) {
    if (check.status !== 'fail') continue;
    if (check.effort !== 'quick') continue;
    gain += (check.maxScore || 0) - (check.score || 0);
    count += 1;
  }

  // httpMax is always 100, so totalMax is never 0 and this is the same
  // expression totalScore uses.
  const totalMax = 100 + (onPageMax || 0);
  const projected = Math.round(((httpScore + gain) + (onPageEarned || 0)) / totalMax * 100);

  return { quickWinScore: Math.min(100, projected), quickWinCount: count };
}

const CATEGORIES = {
  Discoverability:     ['robots', 'sitemap', 'linkheaders'],
  Content:             ['markdown'],
  'Bot Access':        ['aibots', 'contentsignals', 'webbotauth'],
  'API / Auth / MCP':  ['apicatalog', 'oauth', 'oauthresource', 'mcp', 'agentskills', 'webmcp'],
};

const ONPAGE_CATEGORIES = {
  'On-Page Signals': ['schema_search', 'schema_action', 'captcha', 'cookie_banner', 'js_rendering'],
  'Forms':           ['form_labels', 'input_type', 'autocomplete', 'vague_buttons', 'interactive_divs'],
};

const ONPAGE_WEIGHTS = {
  form_labels: 10, input_type: 6, autocomplete: 6,
  schema_search: 5, schema_action: 5, captcha: 8, cookie_banner: 6, js_rendering: 8,
  vague_buttons: 4, interactive_divs: 5,
};

function levelFromScore(score) {
  if (score >= 90) return 'Level 4 — Agent Native';
  if (score >= 75) return 'Level 3 — Agent Ready';
  if (score >= 50) return 'Level 2 — AI Aware';
  if (score >= 25) return 'Level 1 — Basic Web Presence';
  return 'Level 0 — Not Indexed';
}

async function safeFetch(url, opts = {}) {
  try {
    const r = await axios.get(url, {
      timeout: 8000,
      validateStatus: () => true,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentReadinessBot/1.0)', ...opts.headers },
      ...opts,
    });
    return { status: r.status, headers: r.headers, data: r.data };
  } catch (e) {
    return { status: null, headers: {}, data: null, error: e.message };
  }
}

async function runHttpChecks(inputUrl) {
  const origin = new URL(inputUrl).origin;

  const [robotsResp, homeResp, mdResp] = await Promise.all([
    safeFetch(`${origin}/robots.txt`),
    safeFetch(inputUrl),
    safeFetch(inputUrl, { headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } }),
  ]);

  const robotsText = typeof robotsResp.data === 'string' ? robotsResp.data : '';
  const checks = {};

  // 1. robots.txt
  const robotsOk = robotsResp.status === 200 && (robotsResp.headers['content-type'] || '').includes('text/plain');
  checks.robots = {
    status: robotsOk ? 'pass' : 'fail',
    tech: robotsOk
      ? `Valid robots.txt returned (${robotsResp.status}, ${(robotsResp.headers['content-type'] || '').split(';')[0]})`
      : `robots.txt returned ${robotsResp.status || 'no response'}`,
  };

  // 2. XML sitemap
  let sitemapFound = false, sitemapTech = '';
  const sitemapDeclared = robotsText.match(/^Sitemap:\s*(.+)$/im);
  if (sitemapDeclared) {
    const r = await safeFetch(sitemapDeclared[1].trim());
    sitemapFound = r.status === 200;
    sitemapTech = sitemapFound
      ? `Sitemap found at ${new URL(sitemapDeclared[1].trim()).pathname}`
      : `Sitemap declared in robots.txt but returned ${r.status}`;
  } else {
    for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap/']) {
      const r = await safeFetch(`${origin}${p}`);
      if (r.status === 200) { sitemapFound = true; sitemapTech = `Sitemap found at ${p}`; break; }
    }
    if (!sitemapFound) sitemapTech = 'No sitemap found in robots.txt or common paths';
  }
  checks.sitemap = { status: sitemapFound ? 'pass' : 'fail', tech: sitemapTech };

  // 3. Link headers
  const linkHeader = homeResp.headers['link'] || '';
  checks.linkheaders = {
    status: linkHeader ? 'pass' : 'fail',
    tech: linkHeader
      ? `Link header found: ${linkHeader.substring(0, 120)}`
      : 'No Link header present in HTTP response',
  };

  // 4. Markdown negotiation
  const mdCt = mdResp.headers['content-type'] || '';
  checks.markdown = {
    status: mdCt.includes('text/markdown') ? 'pass' : 'fail',
    tech: mdCt.includes('text/markdown')
      ? 'Site correctly returned text/markdown content'
      : `Site returned ${mdCt.split(';')[0] || 'unknown'} when agent sent Accept: text/markdown`,
  };

  // 5. AI bot rules
  const aiBots = ['GPTBot', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'cohere-ai', 'Google-Extended'];
  const foundBots = aiBots.filter(b => robotsText.toLowerCase().includes(b.toLowerCase()));
  checks.aibots = {
    status: foundBots.length > 0 ? 'pass' : 'fail',
    tech: foundBots.length > 0
      ? `AI-specific bot rules detected: ${foundBots.join(', ')}`
      : 'No AI-specific bot rules found in robots.txt',
  };

  // 6. Content signals
  const hasContentSignal = /Content-Signal/i.test(robotsText);
  checks.contentsignals = {
    status: hasContentSignal ? 'pass' : 'fail',
    tech: hasContentSignal
      ? 'Content-Signal directive found in robots.txt'
      : 'No Content-Signal directives in robots.txt',
  };

  const [wbAuth, apiCat, oidc, oauthAs, opr] = await Promise.all([
    safeFetch(`${origin}/.well-known/http-message-signatures-directory`),
    safeFetch(`${origin}/.well-known/api-catalog`),
    safeFetch(`${origin}/.well-known/openid-configuration`),
    safeFetch(`${origin}/.well-known/oauth-authorization-server`),
    safeFetch(`${origin}/.well-known/oauth-protected-resource`),
  ]);

  const [mcp1, mcp2, mcp3] = await Promise.all([
    safeFetch(`${origin}/.well-known/mcp/server-card.json`),
    safeFetch(`${origin}/.well-known/mcp/server-cards.json`),
    safeFetch(`${origin}/.well-known/mcp.json`),
  ]);

  const [skills1, skills2] = await Promise.all([
    safeFetch(`${origin}/.well-known/agent-skills/index.json`),
    safeFetch(`${origin}/.well-known/agent-skills.json`),
  ]);

  // 7. Web bot auth (informational)
  checks.webbotauth = {
    status: wbAuth.status === 200 ? 'pass' : 'info',
    tech: wbAuth.status === 200
      ? 'HTTP message signatures directory found'
      : `/.well-known/http-message-signatures-directory returned ${wbAuth.status || 'no response'} (informational only)`,
  };

  // 8. API catalog
  checks.apicatalog = {
    status: apiCat.status === 200 ? 'pass' : 'fail',
    tech: apiCat.status === 200
      ? '/.well-known/api-catalog found'
      : `/.well-known/api-catalog returned ${apiCat.status || 'no response'}`,
  };

  // 9. OAuth / OIDC
  const oauthFound = oidc.status === 200 || oauthAs.status === 200;
  checks.oauth = {
    status: oauthFound ? 'pass' : 'fail',
    tech: oauthFound
      ? 'OAuth/OIDC discovery endpoint found'
      : `Both /.well-known/openid-configuration and oauth-authorization-server returned ${oidc.status || 'no response'}`,
  };

  // 10. OAuth protected resource
  checks.oauthresource = {
    status: opr.status === 200 ? 'pass' : 'fail',
    tech: opr.status === 200
      ? '/.well-known/oauth-protected-resource found'
      : `/.well-known/oauth-protected-resource returned ${opr.status || 'no response'}`,
  };

  // 11. MCP server card
  const mcpPass = [mcp1, mcp2, mcp3].find(r => r.status === 200);
  checks.mcp = {
    status: mcpPass ? 'pass' : 'fail',
    tech: mcpPass
      ? 'MCP server card found'
      : 'All MCP card paths returned 404 (server-card.json, server-cards.json, mcp.json)',
  };

  // 12. Agent skills index
  const skillsPass = skills1.status === 200 || skills2.status === 200;
  checks.agentskills = {
    status: skillsPass ? 'pass' : 'fail',
    tech: skillsPass ? 'Agent skills index found' : 'Both agent-skills index paths returned 404',
  };

  // 13. WebMCP
  checks.webmcp = {
    status: 'fail',
    tech: 'WebMCP requires browser-side evaluation of navigator.modelContext (not detectable via HTTP)',
  };

  let score = 0;
  for (const [id, check] of Object.entries(checks)) {
    if (check.status === 'pass') score += WEIGHTS[id] || 0;
  }

  return { checks, httpScore: score };
}

// ── Static check metadata ─────────────────────────────────────────────────────
const CHECK_META = {
  robots:         { cat: 'Discoverability',   label: 'robots.txt',                effort: 'quick',  business: "Without an accessible robots.txt, agents and crawlers have no documented crawl rules to follow — many treat a missing or misconfigured robots.txt as a signal to skip the site's discovery process entirely, so your content may never get indexed by AI-driven search and citation systems.", action: 'Ensure /robots.txt exists at your domain root and is served with Content-Type: text/plain — some CMS/proxy setups serve it as text/html or return a 404 by default. ~15–30 min for a developer.' },
  sitemap:        { cat: 'Discoverability',   label: 'XML sitemap',               effort: 'medium', business: 'Without a discoverable XML sitemap, agents can only find pages by following links from your homepage — pages more than a few clicks deep, or not linked in navigation at all, may never be discovered or indexed.', action: 'Generate an XML sitemap (most CMS platforms have a built-in option or plugin) and either declare it in robots.txt with "Sitemap: https://yoursite.com/sitemap.xml" or publish it at a common path like /sitemap.xml. ~half a day, less with an existing CMS.' },
  linkheaders:    { cat: 'Discoverability',   label: 'Link headers (RFC 8288)',   effort: 'quick',  business: 'Without Link headers, agents cannot auto-discover your API or documentation endpoints. They rely on guesswork instead of following your signposts — adding friction to every automated interaction.', action: 'Add Link: </.well-known/api-catalog>; rel="api-catalog" to your server\'s HTTP response headers. ~1–2 hours with a developer.' },
  markdown:       { cat: 'Content',           label: 'Markdown negotiation',      effort: 'medium', business: 'AI agents parse raw HTML including nav menus and footers — not your actual content. This degrades how AI tools summarize and cite your information, creating risk of misquotation or incomplete representation.', action: 'Enable Markdown for Agents via Cloudflare or server middleware. When a request includes Accept: text/markdown, respond with Content-Type: text/markdown. ~1–3 days of dev time.' },
  aibots:         { cat: 'Bot Access',        label: 'AI bot rules',              effort: 'quick',  business: "Without explicit AI-specific rules, your site has no documented stance on AI crawler access — it defaults to whatever your general robots.txt rules already allow, leaving partners, platforms, and regulators with no visible signal that access is a deliberate, managed decision.", action: 'Add explicit User-agent rules for AI crawlers (GPTBot, ClaudeBot, anthropic-ai, PerplexityBot, Google-Extended) to robots.txt — even an explicit "allow everything" rule signals deliberate, managed access rather than undefined default behavior. ~15–30 min for a developer.' },
  contentsignals: { cat: 'Bot Access',        label: 'Content signals',           effort: 'quick',  business: "You haven't declared whether your content can be used for AI training. That's an IP governance gap — and increasingly one partners, distributors, and regulators will ask about.", action: 'Add one line to robots.txt: Content-Signal: ai-train=no, search=yes, ai-input=yes. 15 minutes. No developer needed.' },
  webbotauth:     { cat: 'Bot Access',        label: 'Web bot auth',              effort: 'low',    business: "Your server can't cryptographically identify itself for agent-to-agent trust verification. Not urgent today — will matter as authenticated agent networks mature in 2026–27.", action: 'Backlog for H2 2026. Publish a JWKS at /.well-known/http-message-signatures-directory.' },
  apicatalog:     { cat: 'API / Auth / MCP',  label: 'API catalog (RFC 9727)',    effort: 'medium', business: "Agents and AI platforms can't auto-discover your APIs or developer resources. Your tools, integrations, and documentation are dark to the AI ecosystem.", action: 'Create /.well-known/api-catalog as application/linkset+json with service-desc and service-doc relations for any existing API. ~3–5 days.' },
  oauth:          { cat: 'API / Auth / MCP',  label: 'OAuth / OIDC discovery',    effort: 'medium', business: "AI agents can't programmatically authenticate with any protected resources you offer — blocking agentic access to portals, dashboards, or any authenticated endpoints.", action: 'If you have protected APIs, publish /.well-known/openid-configuration with auth endpoint details. If no public APIs exist yet, deprioritize.' },
  oauthresource:  { cat: 'API / Auth / MCP',  label: 'OAuth protected resource',  effort: 'medium', business: "Agents can't discover which authorization servers grant access to your resources. Pair this fix with OAuth / OIDC discovery.", action: 'Publish /.well-known/oauth-protected-resource alongside the OAuth discovery setup.' },
  mcp:            { cat: 'API / Auth / MCP',  label: 'MCP server card',           effort: 'high',   business: 'You have zero MCP presence. As Claude, ChatGPT, and other AI agents use MCP to interact with tools and services, you\'re not in the room. Competitors who publish an MCP card get invoked — you don\'t.', action: 'Publish /.well-known/mcp/server-card.json with serverInfo, transport endpoint, and capabilities. Strategic priority for 2026.' },
  agentskills:    { cat: 'API / Auth / MCP',  label: 'Agent skills index',        effort: 'high',   business: 'No declared capabilities for AI agents. Competitors with Agent Skills can be invoked directly by AI assistants. You can only be found passively via web search.', action: 'Publish /.well-known/agent-skills/index.json. Define skills for key user intents specific to your business.' },
  webmcp:         { cat: 'API / Auth / MCP',  label: 'WebMCP',                    effort: 'high',   business: 'Your website cannot expose interactive capabilities to in-browser AI agents. As Chrome and Safari ship native AI APIs, sites with WebMCP registered tools will surface above those without.', action: 'Implement navigator.modelContext.provideContext() for key site actions. Q3/Q4 2026 priority.' },
};

// ── CMO brief ─────────────────────────────────────────────────────────────────
// Claude Sonnet via the shared factory. Memoised because the streaming route
// and the plain route both write briefs.
let _briefClient = null;
function briefClient() {
  if (!_briefClient) _briefClient = createLlmClient('claude-sonnet-5');
  return _briefClient;
}

async function generateCmoBrief(siteUrl, score, level, checks, openai, cats) {
  const passed = Object.entries(checks).filter(([, c]) => c.status === 'pass').map(([id]) => id);
  const failed = Object.entries(checks).filter(([, c]) => c.status === 'fail').map(([id]) => id);

  const prompt = `You are a senior digital strategist advising CMOs on AI readiness.

Site: ${siteUrl}
Agent-readiness score: ${score}/100 (${level})
Scan date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}

Passing (${passed.length}): ${passed.join(', ') || 'none'}
Failing (${failed.length}): ${failed.join(', ') || 'none'}

Category scores:
${cats ? cats.map(c => `${c.id}: ${c.score}/100 (${c.passed}/${c.total} passed)`).join('\n') : 'not available'}

Guidance:
- If Bot Access = 0 AND API/Auth/MCP = 0: lead with AI discoverability risk
- If Forms score is low AND On-Page Signals score is low: lead with conversion and agent interaction risk
- If HTTP score is high but on-page score is low: note the gap between infrastructure and user-facing agent readiness
- If score >= 75: shift tone from risk to optimization opportunity

Generate an executive summary. Be specific to this site's industry based on its domain. Address the CMO directly as "you". Plain language — no technical jargon. Return ONLY this JSON object, no markdown or preamble:
{
  "headline": "A punchy 10-15 word headline capturing the core risk or opportunity",
  "summary": "2-3 sentences explaining what this score means for the business, the competitive context, and what is at stake",
  "risk": "1 sentence naming the single most important business risk from this scan",
  "opportunity": "1 sentence on the top opportunity available if they act within the next 60 days",
  "competitive": "1 sentence on competitive positioning specific to their industry"
}`;

  const response = await openai.chat.completions.create({
    model: 'claude-sonnet-5',
    // 600 tokens of prose is plenty, but a reasoning model would spend the whole
    // budget thinking and return nothing — see the note in routes/seoGeoAudit.js.
    thinking: { type: 'disabled' },
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  return JSON.parse(response.choices[0].message.content);
}

// ── PDF generation ────────────────────────────────────────────────────────────

// Roadmap tier definitions (hard-coded to match client ROADMAP constant)
const ROADMAP_TIERS = {
  'This week':         ['robots', 'aibots', 'contentsignals', 'linkheaders', 'form_labels', 'input_type', 'autocomplete', 'cookie_banner', 'vague_buttons'],
  'This quarter':      ['sitemap', 'markdown', 'apicatalog', 'oauth', 'schema_search', 'schema_action', 'js_rendering', 'interactive_divs'],
  'Strategic horizon': ['mcp', 'agentskills', 'webmcp', 'captcha'],
};

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

const EFFORT_TIME_MAP = {
  robots: '~15–30 min', aibots: '~30 min',
  contentsignals: '~15 min', linkheaders: '~2 hrs', form_labels: '~1 hr', input_type: '30 min',
  autocomplete: '30 min', cookie_banner: '30 min', vague_buttons: '1 hr',
  sitemap: '~half a day',
  markdown: '1–3 days', apicatalog: '3–5 days', oauth: '1–2 wks', schema_search: '~1 day',
  schema_action: '~1 day', js_rendering: '1–2 wks', interactive_divs: '~1 day',
  mcp: '2–4 wks', agentskills: '4–6 wks', webmcp: '4–8 wks', captcha: '2–4 wks',
};

// Everything interpolated into the template below arrives as `data` from
// POST /pdf, which passes `req.body` through verbatim — so it is
// caller-controlled text being written into HTML that puppeteer then renders,
// with --no-sandbox whenever a local Chrome is used. Unescaped, a body like
//   { site: {...}, checks: [{ detail: "<img src=x onerror=fetch('http://169.254.169.254/…')>" }] }
// executed in that browser context, and `waitUntil: 'networkidle0'` politely
// waited for the injected request to finish. The same applied inside style
// attributes (`width:${w}%`, `color:${col}`), where a crafted value breaks out
// of the attribute.
//
// Values DERIVED here — badge colours, the bar colour from a numeric score —
// come from literal palettes and are safe; everything that originates in `data`
// is escaped, and anything used in a numeric CSS position is coerced to a number.
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function buildPdfHtml(data) {
  const { site, cats, checks, cmoBrief, onPageChecks } = data;
  const allChecks = [...(checks || []), ...(onPageChecks || [])];
  const pass = allChecks.filter(c => c.status === 'pass').length;
  const fail = allChecks.filter(c => c.status === 'fail').length;

  const statusColor = { pass: '#3B6D11', fail: '#A32D2D', info: '#854F0B' };
  const statusBg    = { pass: '#EAF3DE', fail: '#FCEBEB', info: '#FAEEDA' };
  const statusIcon  = { pass: '✓', fail: '✗', info: 'i' };
  const scoreColor  = site.score >= 70 ? '#3B6D11' : site.score >= 40 ? '#EF9F27' : '#E24B4A';

  const EFFORT_LABEL = { quick: 'Quick', medium: 'Medium', high: 'High' };

  // Full per-check detail card — mirrors the on-screen expandable check row
  // (technical finding, business impact, specific issues, recommended action)
  // instead of the old single-line "finding" summary table.
  const checkCards = allChecks.map(c => {
    const isFlag = !!c.flagOnly;
    const badgeColor = isFlag ? '#185FA5' : statusColor[c.status];
    const badgeBg = isFlag ? '#E6F1FB' : statusBg[c.status];
    const badgeLabel = isFlag ? 'FLAG' : c.status.toUpperCase();
    const badgeIcon = isFlag ? 'i' : statusIcon[c.status];
    const effort = EFFORT_LABEL[c.effort] || c.effort || '';
    const showDetail = c.status !== 'pass' && c.detail && c.detail !== c.tech;

    return `
    <div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px 16px;margin-bottom:10px;page-break-inside:avoid;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <span style="background:${badgeBg};color:${badgeColor};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;white-space:nowrap;">${badgeIcon} ${esc(badgeLabel)}</span>
        <span style="font-weight:600;font-size:13px;flex:1;">${esc(c.label)}</span>
        <span style="font-size:11px;color:#6B7280;white-space:nowrap;">${esc(c.cat || '')}</span>
        ${effort ? `<span style="font-size:10px;color:#6B7280;border:1px solid #D1D5DB;padding:1px 6px;border-radius:3px;white-space:nowrap;">${esc(effort)} effort</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;${showDetail || c.action ? 'margin-bottom:8px;' : ''}">
        <div style="background:#F9FAFB;border-radius:6px;padding:8px 10px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;font-weight:600;">Technical finding</div>
          <div style="font-size:11px;color:#374151;line-height:1.5;">${esc(c.tech || '—')}</div>
        </div>
        <div style="background:#F9FAFB;border-radius:6px;padding:8px 10px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;font-weight:600;">Business impact</div>
          <div style="font-size:11px;color:#374151;line-height:1.5;">${esc(c.business || '—')}</div>
        </div>
      </div>
      ${showDetail ? `
      <div style="background:#FAEEDA;border-left:3px solid #EF9F27;border-radius:6px;padding:8px 10px;${c.action ? 'margin-bottom:8px;' : ''}">
        <div style="font-size:9px;font-weight:600;color:#92400E;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Specific issues found</div>
        <div style="font-size:11px;color:#374151;line-height:1.5;">${esc(c.detail)}</div>
      </div>` : ''}
      ${c.action ? `
      <div style="background:#E6F1FB;border-left:3px solid #185FA5;border-radius:6px;padding:8px 10px;">
        <div style="font-size:9px;font-weight:600;color:#185FA5;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Recommended action</div>
        <div style="font-size:11px;color:#374151;line-height:1.5;">${esc(c.action)}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  const catBars = cats.map(cat => {
    const w = cat.score;
    const col = w >= 70 ? '#639922' : w >= 40 ? '#EF9F27' : '#E24B4A';
    return `
    <div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:12px;color:#6B7280;">${esc(cat.id)}</span>
        <span style="font-size:12px;font-weight:500;color:${col};">${esc(cat.score)}</span>
      </div>
      <div style="height:6px;border-radius:3px;background:#F3F4F6;overflow:hidden;">
        <div style="height:100%;width:${num(w)}%;background:${col};border-radius:3px;"></div>
      </div>
      <div style="font-size:11px;color:#9CA3AF;margin-top:2px;">${esc(cat.passed)} of ${esc(cat.total)} passed</div>
    </div>`;
  }).join('');

  const brief = cmoBrief ? `
    <div style="background:#EEEDFE;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <div style="font-size:10px;font-weight:600;color:#534AB7;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">✦ Executive Summary</div>
      <p style="font-size:16px;font-weight:500;color:#111827;margin:0 0 8px;line-height:1.4;">${esc(cmoBrief.headline)}</p>
      <p style="font-size:12px;color:#6B7280;margin:0 0 12px;line-height:1.7;">${esc(cmoBrief.summary)}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div style="background:#FCEBEB;border-radius:6px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:600;color:#A32D2D;margin-bottom:4px;">TOP RISK</div>
          <p style="font-size:11px;color:#791F1F;margin:0;line-height:1.5;">${esc(cmoBrief.risk)}</p>
        </div>
        <div style="background:#EAF3DE;border-radius:6px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:600;color:#3B6D11;margin-bottom:4px;">60-DAY OPPORTUNITY</div>
          <p style="font-size:11px;color:#27500A;margin:0;line-height:1.5;">${esc(cmoBrief.opportunity)}</p>
        </div>
        <div style="background:#E6F1FB;border-radius:6px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:600;color:#185FA5;margin-bottom:4px;">COMPETITIVE CONTEXT</div>
          <p style="font-size:11px;color:#0C447C;margin:0;line-height:1.5;">${esc(cmoBrief.competitive)}</p>
        </div>
      </div>
    </div>` : '';

  // ── Priority Roadmap table ──────────────────────────────────────────────────
  const tierOrder = ['This week', 'This quarter', 'Strategic horizon'];
  const tierColors = {
    'This week':         { bg: '#FEF3C7', text: '#92400E', dot: '#F59E0B' },
    'This quarter':      { bg: '#DBEAFE', text: '#1E40AF', dot: '#3B82F6' },
    'Strategic horizon': { bg: '#EDE9FE', text: '#5B21B6', dot: '#8B5CF6' },
  };

  // Collect failing checks with tier info, sorted by tier then by weight
  const allWeights = { ...WEIGHTS, ...ONPAGE_WEIGHTS };
  const roadmapRows = [];
  const passingCount = allChecks.filter(c => c.status === 'pass').length;

  for (const tier of tierOrder) {
    const tierIds = ROADMAP_TIERS[tier] || [];
    // Find failing checks that belong to this tier
    const tierChecks = allChecks
      .filter(c => c.status !== 'pass' && tierIds.includes(c.id))
      .sort((a, b) => (allWeights[b.id] || 0) - (allWeights[a.id] || 0));

    for (const c of tierChecks) {
      roadmapRows.push({ tier, check: c });
    }
  }

  const roadmapTableRows = roadmapRows.map(({ tier, check }) => {
    const tc = tierColors[tier];
    const effort = EFFORT_TIME_MAP[check.id] || '—';
    const owner = ROLE_MAP[check.id] || '—';
    return `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #F3F4F6;">
        <span style="background:${tc.bg};color:${tc.text};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;white-space:nowrap;">${tier}</span>
      </td>
      <td style="padding:7px 10px;border-bottom:1px solid #F3F4F6;font-weight:500;font-size:12px;">${check.label || check.id}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #F3F4F6;color:#6B7280;font-size:11px;">${check.cat || ''}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #F3F4F6;color:#374151;font-size:11px;">${owner}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #F3F4F6;color:#374151;font-size:11px;">${effort}</td>
    </tr>`;
  }).join('');

  const roadmapSection = roadmapRows.length > 0 ? `
  <div style="margin-bottom:24px;">
    <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Priority Roadmap</div>
    ${passingCount > 0 ? `<div style="font-size:11px;color:#6B7280;margin-bottom:8px;">${passingCount} check${passingCount !== 1 ? 's' : ''} already passing — focus effort below.</div>` : ''}
    <table>
      <thead>
        <tr>
          <th style="width:110px;">Priority</th>
          <th>Check</th>
          <th style="width:130px;">Category</th>
          <th style="width:110px;">Owner</th>
          <th style="width:80px;">Effort</th>
        </tr>
      </thead>
      <tbody>${roadmapTableRows}</tbody>
    </table>
  </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #111827; padding: 32px 40px; font-size: 13px; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #9CA3AF; padding: 8px 10px; border-bottom: 2px solid #E5E7EB; font-weight: 600; }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #E5E7EB;">
    <div>
      <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">Agent Readiness Audit</div>
      <h1>${esc(site.url)}</h1>
      <div style="font-size:13px;color:#6B7280;margin-top:4px;">${esc(site.level)} &nbsp;·&nbsp; Scanned ${esc(site.date)}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:36px;font-weight:600;color:${scoreColor};line-height:1;">${esc(site.score)}</div>
      <div style="font-size:11px;color:#9CA3AF;">out of 100</div>
      <div style="margin-top:6px;font-size:11px;">
        <span style="color:#3B6D11;">✓ ${pass} passed</span> &nbsp;
        <span style="color:#A32D2D;">✗ ${fail} failed</span>
      </div>
    </div>
  </div>

  ${brief}

  <div style="margin-bottom:24px;">
    <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px;">Score by category</div>
    ${catBars}
  </div>

  ${roadmapSection}

  <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">All Findings</div>
  <div>${checkCards}</div>

  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #E5E7EB;">
    <p style="font-size:12px;color:#6B7280;line-height:1.6;">This report covers ${allChecks.length} checks across HTTP discoverability, bot access, API/auth/MCP protocols, and on-page agent signals. Scores are weighted by business impact. On-page checks require browser rendering and are only available when additional URLs are provided. Generated by Arena · ${esc(site.date)}</p>
  </div>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/discover-links', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    let parsed;
    try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); }
    catch { return res.status(400).json({ error: 'Invalid URL' }); }
    const result = await discoverLinks(parsed.href);
    res.json(result);
  } catch (e) {
    res.json({ actionCandidates: [], formCandidates: [] });
  }
});

/**
 * The agent-readiness audit, callable without an HTTP request.
 *
 * Extracted from the route handler rather than reimplemented, so a project-scoped
 * run and an ad-hoc run share one code path and cannot drift into producing
 * different scores for the same site (PRD §32: prefer service extraction over
 * parallel replacement). The route below is now a thin wrapper over this.
 *
 * @param {object}  input
 * @param {string}  input.url_homepage  (or legacy `url`)
 * @param {string} [input.url_action]
 * @param {string} [input.url_form]
 * @param {boolean}[input.skipBrief]    skip the LLM-written CMO brief. A
 *                                      project run that only needs the score and
 *                                      the checks should not spend a model call
 *                                      on prose nobody asked for.
 * @returns {Promise<object>} { site, cats, checks, onPageChecks, cmoBrief }
 * @throws  an Error with a `status` for bad input
 */
async function runAgentReadiness({ url, url_homepage, url_action, url_form, skipBrief = false } = {}) {
  // Accept { url_homepage, url_action, url_form } or legacy { url }
  const homepageRaw = url_homepage || url;
  if (!homepageRaw) throw Object.assign(new Error('url_homepage is required'), { status: 400 });

  let parsedUrl;
  try { parsedUrl = new URL(homepageRaw.startsWith('http') ? homepageRaw : `https://${homepageRaw}`); }
  catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }

  const parseOptional = (u) => {
    if (!u || !u.trim()) return null;
    try { return new URL(u.startsWith('http') ? u : `https://${u}`).href; }
    catch { return null; }
  };

  const urls = {
    url_homepage: parsedUrl.href,
    url_action: parseOptional(url_action),
    url_form: parseOptional(url_form),
  };

  // SSRF guard. Everything below fetches these URLs from the server, and
  // safeFetch() is deliberately permissive — validateStatus: () => true and
  // maxRedirects: 3 — so a 401 or a redirect into a private network still comes
  // back as status, headers and body, and the check results carry that outward.
  //
  // Without this a signed-in caller could aim the audit at
  // http://169.254.169.254/latest/meta-data/ (the cloud instance-metadata
  // address, and 169.254.0.0/16 is one of the ranges blocked below), or at any
  // internal host the container can route to and their own browser cannot. That
  // is a privilege boundary, not merely an odd input.
  //
  // Reuses modules/contentArchitect/urlSafety rather than adding a third
  // implementation — the repo already has that one and crawlScope's
  // net/guard.js, both tested. It resolves the name and rejects if ANY returned
  // address is private, which a hostname allowlist alone would not catch.
  // Redirects remain a gap here: axios follows up to 3 hops itself, so a public
  // host that 302s to a private one is still reachable. Closing that needs
  // fetchSafe()'s per-hop validation, which is a larger change to safeFetch().
  await Promise.all(
    Object.values(urls).filter(Boolean).map(async (u) => {
      try {
        await assertPublicHost(new URL(u).hostname);
      } catch (e) {
        throw Object.assign(new Error(e.message), { status: 400 });
      }
    }),
  );

  try {
    // Run HTTP checks and on-page checks in parallel
    const hasOnPage = urls.url_action || urls.url_form || urls.url_homepage;
    const [httpResult, rawOnPageChecks] = await Promise.all([
      runHttpChecks(parsedUrl.href),
      hasOnPage
        ? runOnPageChecks(urls).catch(e => { console.warn('[on-page checks]', e.message); return []; })
        : Promise.resolve([]),
    ]);

    const { checks: rawHttpChecks, httpScore } = httpResult;

    // Build full HTTP check list with metadata
    const httpChecks = Object.entries(rawHttpChecks).map(([id, result]) => ({
      id,
      ...CHECK_META[id],
      status: result.status,
      tech: result.tech,
    }));

    // Combined scoring
    const httpMax = 100;
    const onPageMax = rawOnPageChecks.reduce((s, c) => s + (c.maxScore || 0), 0);
    const onPageEarned = rawOnPageChecks.reduce((s, c) => s + (c.score || 0), 0);
    const totalMax = httpMax + onPageMax;
    const totalScore = totalMax > 0
      ? Math.round((httpScore + onPageEarned) / totalMax * 100)
      : httpScore;

    // Build categories — HTTP cats first
    const httpCats = Object.entries(CATEGORIES).map(([name, ids]) => {
      const maxPts = ids.reduce((s, id) => s + (WEIGHTS[id] || 0), 0);
      const earned = ids.reduce((s, id) =>
        s + (rawHttpChecks[id]?.status === 'pass' ? WEIGHTS[id] || 0 : 0), 0);
      const passed = ids.filter(id => rawHttpChecks[id]?.status === 'pass').length;
      return { id: name, score: maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0, passed, total: ids.length };
    });

    // On-page categories — only include if checks ran
    const onPageCats = rawOnPageChecks.length > 0
      ? Object.entries(ONPAGE_CATEGORIES).map(([name, ids]) => {
          const ranChecks = rawOnPageChecks.filter(c => ids.includes(c.id));
          if (ranChecks.length === 0) return null;
          const maxPts = ranChecks.reduce((s, c) => s + (c.maxScore || 0), 0);
          const earned = ranChecks.reduce((s, c) => s + (c.score || 0), 0);
          const passed = ranChecks.filter(c => c.status === 'pass').length;
          return { id: name, score: maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0, passed, total: ranChecks.length };
        }).filter(Boolean)
      : [];

    const allCats = [...httpCats, ...onPageCats];

    // CMO brief (HTTP checks only for the prompt). A failure here is logged and
    // left null — the score and the checks are the measurement, the brief is
    // commentary on it, and losing the commentary must not lose the audit.
    let cmoBrief = null;
    if (!skipBrief) {
      try {
        cmoBrief = await generateCmoBrief(
          parsedUrl.href, totalScore, levelFromScore(totalScore), rawHttpChecks,
          briefClient(), allCats,
        );
      } catch (e) {
        console.warn('[agent-readiness] CMO brief failed:', e.message);
      }
    }

    return {
      site: {
        url: parsedUrl.hostname,
        full: parsedUrl.href,
        score: totalScore,
        level: levelFromScore(totalScore),
        date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        httpScore,
        onPageScore: onPageMax > 0 ? Math.round((onPageEarned / onPageMax) * 100) : null,
        onPageMax,
        ...quickWinProjection({
          rawHttpChecks, httpScore, onPageChecks: rawOnPageChecks, onPageMax, onPageEarned,
        }),
      },
      cats: allCats,
      checks: httpChecks,
      onPageChecks: rawOnPageChecks,
      cmoBrief,
    };
  } catch (err) {
    console.error('[agent-readiness] Error:', err.message);
    throw err;
  }
}

// POST /api/agent-readiness-audit — the HTTP face of runAgentReadiness.
router.post('/', async (req, res) => {
  try {
    res.json(await runAgentReadiness(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── SSE streaming endpoint ────────────────────────────────────────────────────
router.post('/stream', async (req, res) => {
  const { url, url_homepage, url_action, url_form } = req.body;
  const homepageRaw = url_homepage || url;
  if (!homepageRaw) { res.status(400).json({ error: 'url_homepage is required' }); return; }

  let parsedUrl;
  try { parsedUrl = new URL(homepageRaw.startsWith('http') ? homepageRaw : `https://${homepageRaw}`); }
  catch { res.status(400).json({ error: 'Invalid URL' }); return; }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();

  const emit = (eventType, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Handle client disconnect
  let disconnected = false;
  req.on('close', () => { disconnected = true; });

  try {
    const parseOptional = (u) => {
      if (!u || !u.trim()) return null;
      try { return new URL(u.startsWith('http') ? u : `https://${u}`).href; }
      catch { return null; }
    };

    const urls = {
      url_homepage: parsedUrl.href,
      url_action: parseOptional(url_action),
      url_form: parseOptional(url_form),
    };

    // Run HTTP checks
    const httpResult = await runHttpChecks(parsedUrl.href);
    const { checks: rawHttpChecks, httpScore } = httpResult;

    // Emit each HTTP check result
    for (const [id, result] of Object.entries(rawHttpChecks)) {
      if (disconnected) return;
      emit('check', { id, ...CHECK_META[id], status: result.status, tech: result.tech });
    }

    // Emit HTTP score
    if (!disconnected) emit('score', { httpScore });

    // Run on-page checks
    const hasOnPage = urls.url_action || urls.url_form || urls.url_homepage;
    let rawOnPageChecks = [];
    if (hasOnPage && !disconnected) {
      try {
        rawOnPageChecks = await runOnPageChecks(urls);
        // Emit each on-page check as it comes
        for (const c of rawOnPageChecks) {
          if (disconnected) return;
          emit('check', c);
        }
      } catch (e) {
        console.warn('[on-page checks/stream]', e.message);
      }
    }

    if (disconnected) return;

    // Build full HTTP check list with metadata
    const httpChecks = Object.entries(rawHttpChecks).map(([id, result]) => ({
      id,
      ...CHECK_META[id],
      status: result.status,
      tech: result.tech,
    }));

    // Combined scoring
    const httpMax = 100;
    const onPageMax = rawOnPageChecks.reduce((s, c) => s + (c.maxScore || 0), 0);
    const onPageEarned = rawOnPageChecks.reduce((s, c) => s + (c.score || 0), 0);
    const totalMax = httpMax + onPageMax;
    const totalScore = totalMax > 0
      ? Math.round((httpScore + onPageEarned) / totalMax * 100)
      : httpScore;

    // Build categories
    const httpCats = Object.entries(CATEGORIES).map(([name, ids]) => {
      const maxPts = ids.reduce((s, id) => s + (WEIGHTS[id] || 0), 0);
      const earned = ids.reduce((s, id) =>
        s + (rawHttpChecks[id]?.status === 'pass' ? WEIGHTS[id] || 0 : 0), 0);
      const passed = ids.filter(id => rawHttpChecks[id]?.status === 'pass').length;
      return { id: name, score: maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0, passed, total: ids.length };
    });

    const onPageCats = rawOnPageChecks.length > 0
      ? Object.entries(ONPAGE_CATEGORIES).map(([name, ids]) => {
          const ranChecks = rawOnPageChecks.filter(c => ids.includes(c.id));
          if (ranChecks.length === 0) return null;
          const maxPts = ranChecks.reduce((s, c) => s + (c.maxScore || 0), 0);
          const earned = ranChecks.reduce((s, c) => s + (c.score || 0), 0);
          const passed = ranChecks.filter(c => c.status === 'pass').length;
          return { id: name, score: maxPts > 0 ? Math.round((earned / maxPts) * 100) : 0, passed, total: ranChecks.length };
        }).filter(Boolean)
      : [];

    const allCats = [...httpCats, ...onPageCats];

    // CMO brief
    let cmoBrief = null;
    try {
      cmoBrief = await generateCmoBrief(
        parsedUrl.href, totalScore, levelFromScore(totalScore), rawHttpChecks,
        briefClient(), allCats,
      );
    } catch (e) {
      console.warn('[agent-readiness/stream] CMO brief failed:', e.message);
    }

    if (disconnected) return;

    // Emit complete event with full result object (identical to POST /)
    emit('complete', {
      site: {
        url: parsedUrl.hostname,
        full: parsedUrl.href,
        score: totalScore,
        level: levelFromScore(totalScore),
        date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        httpScore,
        onPageScore: onPageMax > 0 ? Math.round((onPageEarned / onPageMax) * 100) : null,
        onPageMax,
        ...quickWinProjection({
          rawHttpChecks, httpScore, onPageChecks: rawOnPageChecks, onPageMax, onPageEarned,
        }),
      },
      cats: allCats,
      checks: httpChecks,
      onPageChecks: rawOnPageChecks,
      cmoBrief,
    });

    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('[agent-readiness/stream] Error:', err.message);
    if (!disconnected && !res.writableEnded) {
      emit('error', { message: err.message });
      res.end();
    }
  }
});

// ── PDF export ────────────────────────────────────────────────────────────────
router.post('/pdf', async (req, res) => {
  const data = req.body;
  if (!data?.site) return res.status(400).json({ error: 'Invalid audit data' });

  const localBrowser = findLocalBrowser();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: localBrowser || (await chromium.executablePath()),
      headless: true,
      args: localBrowser ? ['--no-sandbox', '--disable-setuid-sandbox'] : chromium.args,
      defaultViewport: localBrowser ? { width: 1280, height: 800 } : chromium.defaultViewport,
    });
    const page = await browser.newPage();
    const html = buildPdfHtml(data);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    await browser.close();

    const filename = `agent-readiness-${(data.site.url || 'report').replace(/[^a-z0-9]/gi, '-')}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdf.length,
    });
    res.send(pdf);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[agent-readiness/pdf]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Named export for the project-scoped runner (modules/projects/moduleRunners.js).
// Attached to the router the way crawlScope/api/routes.js exports its manager,
// so server.js's `app.use(...)` keeps working unchanged.
module.exports.runAgentReadiness = runAgentReadiness;
module.exports.levelFromScore = levelFromScore;
