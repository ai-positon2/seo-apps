// ── The report assistant's pure helpers ─────────────────────────────────────
//
// Everything the chat panel needs that is not React: what to send about the
// screen, which questions to suggest, how to read the answer stream, and how to
// render an answer safely. Plain functions so `node --test` covers them.

import { resolveExplainer, resolveLegend, EXPLAINER_KEYS_BY_SCREEN } from '../explain/explainCopy.js';
import { SCREENS } from '../explain/explainScreens.js';

// ── What the screen tells the assistant ─────────────────────────────────────

/**
 * The screen's explainer and legend text, resolved against the figures the
 * screen has loaded — exactly what its info icons print, worked examples
 * included. Null for a page with no explainers.
 */
export function buildScreenCopy(screen, ctx, working = null) {
  const keys = EXPLAINER_KEYS_BY_SCREEN[screen];
  if (!keys) return null;
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  return {
    explainers: keys.map((k) => safe(() => resolveExplainer(k, ctx || {}))).filter(Boolean),
    legend: safe(() => resolveLegend(screen, ctx || {})) || [],
    // The report's per-item scoring inputs (screenWorking.js), when it has any.
    working: working || null,
  };
}

export const screenName = (screen) => SCREENS[screen] || null;

// Written out per screen: the explainer titles ("Where you stand", "Topic
// clusters") are labels, and do not drop into a sentence.
const HEADLINE_QUESTION = {
  tech: 'How is the site health score calculated?',
  seogeo: 'How is the SEO & GEO score calculated?',
  agent: 'How is the Agent Readiness score calculated?',
  aivisLite: 'How is the AI Visibility score calculated?',
  aivis: 'How is our AI visibility measured?',
  comp: 'How is the competitive score calculated?',
  hub: 'How are the topic clusters worked out?',
};

// One general SEO / GEO question per screen: the assistant answers those too.
const EXPERT_QUESTION = {
  tech: 'What are the technical SEO mistakes that hurt sites most?',
  seogeo: 'How do we get our pages cited in AI answers like ChatGPT and Google AI Overviews?',
  agent: 'Why does agent readiness matter for search now?',
  aivisLite: 'What’s changing in AI search that we should prepare for?',
  aivis: 'What’s changing in AI search that we should prepare for?',
  comp: 'How do sites usually win organic traffic back from competitors?',
  hub: 'What makes a hub-and-spoke content strategy work?',
};
const DEFAULT_EXPERT_QUESTION = 'What’s changing in SEO and AI search that we should prepare for?';

/** Questions a CMO is likely to ask first: three on this screen, one general. */
export function starterQuestions(screen) {
  const general = EXPERT_QUESTION[screen] || DEFAULT_EXPERT_QUESTION;
  if (screen === 'overview') {
    return [
      'How is the overall score calculated?',
      'What should we fix first?',
      'Which areas have not been measured yet?',
      general,
    ];
  }
  if (HEADLINE_QUESTION[screen]) {
    return [
      HEADLINE_QUESTION[screen],
      'What are the top 3 things to fix to improve it?',
      'How does this compare with the rest of the project?',
      general,
    ];
  }
  return [
    'What is the overall state of this project?',
    'What should we fix first?',
    'Which areas have not been measured yet?',
    general,
  ];
}

// ── Links an answer may contain ─────────────────────────────────────────────
//
// The server tells the model which links it may write; this is the second
// check, on the reader's side. Only a path inside this app, under one of its
// own sections, becomes a link. Anything else — another site, a javascript:
// URL, a path the app does not have — is shown as its label in plain text.

const APP_SECTIONS = new Set([
  '', 'content-research', 'keyword-research', 'kb', 'article-recommendation',
  'content-writer', 'image-alt-audit', 'agent-readiness-audit', 'seo-geo-audit',
  'ai-visibility', 'ai-visibility-lite', 'content-enhancement', 'article-enhancement',
  'article-enhancement-lite', 'location-page-builder', 'robots-monitor',
  'market-potential', 'competitor-analysis', 'content-architect', 'crawl-scope',
  'workspaces', 'projects', 'runs',
]);

export function isSafeAppPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  let url;
  try { url = new URL(path, 'https://app.invalid'); } catch { return false; }
  if (url.origin !== 'https://app.invalid') return false;
  return APP_SECTIONS.has(url.pathname.split('/')[1] || '');
}

// ── Rendering an answer ─────────────────────────────────────────────────────
//
// The model is told to use only bold, bullet lists and links, so that is all
// this understands. Output is a token tree the component maps to elements — no
// HTML string is ever built, so nothing in an answer can become markup.

const INLINE = /(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

// An app path under a label that names somewhere else ("Google Search Central —
// Redirects" → /) would send the reader to the wrong place; such a link shows as
// its label. Outside pages reach the reader only through the Sources list.
const OUTSIDE_LABEL = /\b(google|search central|developers?\.|documentation|docs|wikipedia|moz|ahrefs|semrush|search engine (land|journal))\b|\.(com|org|io|net)\b|https?:/i;

/** @returns {Array<{type:'text'|'bold'|'link', text:string, path?:string, safe?:boolean}>} */
export function parseInline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push({ type: 'bold', text: tok.slice(2, -2) });
    } else {
      const [, label, path] = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push({ type: 'link', text: label, path, safe: isSafeAppPath(path) && !OUTSIDE_LABEL.test(label) });
    }
    last = m.index + tok.length;
  }
  if (last < String(text).length) out.push({ type: 'text', text: String(text).slice(last) });
  return out;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** @returns {Array<{type:'p', text:string}|{type:'ul'|'ol', items:string[]}>} */
export function parseBlocks(text) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) blocks.push({ type: 'p', text: para.join(' ') }); para = []; };
  const flushList = () => { if (list) blocks.push(list); list = null; };

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (BULLET.test(line)) {
      flushPara();
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push(line.replace(BULLET, ''));
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

// ── Reading the answer stream ───────────────────────────────────────────────

/**
 * Server-sent events from a fetch body, which arrives in arbitrary pieces.
 * feed() each decoded piece; onEvent(name, data) fires per complete event.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  return function feed(piece) {
    buffer += piece;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      let parsed = null;
      try { parsed = JSON.parse(data.join('\n')); } catch { continue; }
      onEvent(event, parsed);
    }
  };
}
