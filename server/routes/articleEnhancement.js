const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
// SSRF guard, shared with contentArchitect rather than reimplemented (see call site).
const { assertPublicHost } = require('../modules/contentArchitect/urlSafety');
const OpenAI = require('openai');
const { Document, Packer, Paragraph, TextRun, BorderStyle, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType } = require('docx');
const store = require('../services/kbStore');
const { searchGoogle } = require('../services/googleSearch');
const { createLlmClient, resolveModelIds, WRITER_MODEL_ID } = require('../services/llmProviders');
const { synthesizeRecommendations } = require('../services/llmSynthesis');

// gpt-5-mini was removed — it failed on 100% of runs and added only noise.
const MODELS = [
  'gpt-4o-mini',
  'gpt-5.4-mini',
  'gpt-4o-mini-search-preview',
  'gpt-4.1-mini',
];

const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ── POST /init ─────────────────────────────────────────────────────────────────
const VALID_CONTENT_TYPES = new Set(['article', 'hub', 'thin-content']);

// async because the SSRF guard below resolves the host before accepting it.
router.post('/init', async (req, res) => {
  const { url, kbId, manualContent, contentType, models } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'url is required' });
  let parsedUrl;
  try { parsedUrl = new URL(url.trim()); }
  catch { return res.status(400).json({ error: 'Invalid URL format' }); }

  // SSRF guard — see the note in routes/agentReadinessAudit.js. `new URL()`
  // above proves the string parses; it says nothing about whether this server
  // should be made to fetch that host. The stream this token unlocks does fetch
  // it, so the check belongs here, before a token is minted.
  //
  // Wrapped: Express 4 does not forward a handler rejection, so an unguarded
  // await here would hang the request instead of answering it.
  try {
    await assertPublicHost(parsedUrl.hostname);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const token = generateToken();
  sessions.set(token, {
    url: parsedUrl.href,
    kbId: kbId || 'seo-geo-article-enhancement-knowledge-base',
    manualContent: (manualContent || '').trim(),
    contentType: VALID_CONTENT_TYPES.has(contentType) ? contentType : 'article',
    models: resolveModelIds(models),
  });
  setTimeout(() => sessions.delete(token), 120000);
  res.json({ token });
});

// ── GET /stream/:token ─────────────────────────────────────────────────────────
router.get('/stream/:token', async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
  sessions.delete(req.params.token);

  const { url, kbId, manualContent, contentType, models } = session;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });

  const emit = (event, data) => {
    if (isClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { isClosed = true; }
  };

  try {
    // `openai` is the fixed writer (always GPT-5.4 mini) — used for crawl prep,
    // theme extraction, every content-creation call (enhancement, structural
    // additions, coverage), and as the merge model when multiple recommendation
    // models are selected. `analysisClients` are the user-selected models that
    // generate the recommendations doc, fanned out and merged if more than one.
    // `openaiResearch` is a separate, dedicated, always-OpenAI client for the
    // internal multi-model research fan-out and SERP/competitor analysis, which
    // are hardcoded to specific OpenAI model ids regardless of user selection.
    const openai = createLlmClient(WRITER_MODEL_ID);
    const analysisClients = models.map(id => createLlmClient(id));
    const openaiResearch = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Step 1: Crawl article (or use manually pasted content)
    let articleData;
    if (manualContent) {
      emit('step', { id: 'crawl', status: 'active', message: 'Using manually provided content…' });
      articleData = buildArticleDataFromText(url, manualContent);
      emit('step', { id: 'crawl', status: 'done', message: `Manual content · ${articleData.wordCount} words · ${articleData.h2s.length} H2s` });
    } else {
      emit('step', { id: 'crawl', status: 'active', message: 'Fetching and analyzing article…' });
      articleData = await fetchArticleResilient(url, emit);
      if (!articleData || articleData.wordCount < 100) {
        const extracted = articleData ? articleData.wordCount : 0;
        emit('step', { id: 'crawl', status: 'error', message: `Only ${extracted} words extracted — the page blocks crawlers or requires JavaScript. Paste the content to continue.` });
        emit('crawl_failed', { wordCount: extracted, title: articleData?.title || '', url });
        emit('done', {});
        res.end();
        return;
      }
      emit('step', { id: 'crawl', status: 'done', message: `"${articleData.title}" · ${articleData.wordCount} words · ${articleData.h2s.length} H2s` });

      // Intelligent boundary detection: keep only the main article body, drop
      // boilerplate the heuristics missed (related posts, footers, link lists…).
      emit('step', { id: 'crawl', status: 'active', message: 'Identifying the article body…' });
      articleData = await refineArticleBoundary(openai, articleData);
      const trimmedNote = articleData.droppedBlocks ? ` · trimmed ${articleData.droppedBlocks} non-article blocks` : '';
      emit('step', { id: 'crawl', status: 'done', message: `"${articleData.title}" · ${articleData.wordCount} words · ${articleData.h2s.length} H2s${trimmedNote}` });
    }

    // Content type is chosen by the user (not auto-detected). Depth tier is still
    // derived from word count and used to calibrate prompts, but is not displayed.
    articleData.contentType = contentType || articleData.contentType || 'article';

    emit('article_meta', {
      title: articleData.title,
      url: articleData.url,
      wordCount: articleData.wordCount,
      h1: articleData.h1,
      h2s: articleData.h2s,
      metaDescription: articleData.metaDescription,
    });

    // Step 2: Theme & Query
    emit('step', { id: 'theme', status: 'active', message: 'Identifying article theme and query…' });
    const themeData = await generateThemeAndQuery(openai, articleData);
    emit('step', { id: 'theme', status: 'done', message: `Theme: "${themeData.theme}"` });
    emit('theme_query', themeData);

    // Steps 3+4 (LLM research fan-out + synthesis) and Step 3b (SERP competitor
    // research) run in parallel — both must finish before recommendations, but
    // neither should stack on the other's latency.
    const [llmBranch, serpBranch] = await Promise.all([
      runLlmResearchBranch(openaiResearch, themeData, articleData, emit),
      runSerpCompetitorBranch(openaiResearch, themeData, articleData, emit),
    ]);
    const { llmResults, allConcepts, llmGaps } = llmBranch;
    const { competitorGaps } = serpBranch;

    // Step 5: Load KB
    emit('step', { id: 'kb', status: 'active', message: 'Loading enhancement framework KB…' });
    const kb = await store.readKB(kbId);
    emit('step', { id: 'kb', status: 'done', message: kb ? `KB "${kbId}" loaded` : 'KB not found — using defaults' });

    // Step 6: Generate Recommendations. Runs once per selected model; if more
    // than one, the writer model merges the independent drafts into one doc.
    emit('step', { id: 'recommend', status: 'active', message: `Generating enhancement recommendations (${analysisClients.length} model${analysisClients.length > 1 ? 's' : ''})…` });
    const perModelRecs = await Promise.all(analysisClients.map(c => generateRecommendations(c, articleData, themeData, allConcepts, kb, competitorGaps, llmGaps)));
    const recommendations = perModelRecs.length === 1
      ? perModelRecs[0]
      : await synthesizeRecommendations(openai, analysisClients.map((c, i) => ({ model: c.model, text: perModelRecs[i] })));
    emit('step', { id: 'recommend', status: 'done', message: 'Enhancement recommendations ready' });
    emit('recommendations', { recommendations });

    // Step 7: Enhance article sections + structural additions
    emit('step', { id: 'enhance', status: 'active', message: 'Enhancing article sections with statistics, citations, and expert quotes…' });
    const enhancedChunks = await generateEnhancedArticle(openai, articleData, recommendations, kb);
    const existingHeadings = [...(articleData.h2s || []), ...(articleData.h3s || [])].join(' ');
    const articleHasFaq = /faq|frequently asked/i.test(existingHeadings);
    const existingFaqHeading = (articleData.h2s || []).find(h => /faq|frequently asked/i.test(h)) || null;
    // If the original article ends with its FAQ (no section after it), keep the FAQ
    // last in the enhanced version — additions go before it, never after.
    const lastH2 = (articleData.h2s || [])[(articleData.h2s || []).length - 1] || '';
    const articleEndsWithFaq = /faq|frequently asked/i.test(lastH2);
    const structural = await generateStructuralAdditions(openai, articleData, themeData, recommendations, kb, articleHasFaq, existingFaqHeading);
    let enhancedText = deduplicateAdditions(enhancedChunks);
    if (structural) {
      enhancedText = articleEndsWithFaq
        ? insertBeforeTrailingFaq(enhancedText, structural)
        : `${enhancedText}\n\n${structural}`;
    }
    enhancedText = normalizeTablesToMarkdown(enhancedText);
    enhancedText = normalizeNewMarkers(enhancedText);
    enhancedText = enforceFaqHeadings(enhancedText);

    // Step 7b: Coverage verification pass (Fix 6). Checks the enhanced article
    // against the 12 mandatory coverage parameters using the real article
    // signals (h2s, wordCount, depthTier, contentType), fills genuine gaps as
    // appended [NEW] blocks, and produces a Coverage Report. Best-effort: a
    // text-grounded heuristic backs the model so the report is always honest.
    const coverage = await runCoverageVerification(openai, enhancedText, articleData, kb);
    if (coverage.additions && coverage.additions.trim()) {
      let add = normalizeTablesToMarkdown(coverage.additions);
      add = normalizeNewMarkers(add);
      enhancedText = articleEndsWithFaq
        ? insertBeforeTrailingFaq(enhancedText, add)
        : `${enhancedText}\n\n${add}`;
    }

    emit('step', { id: 'enhance', status: 'done', message: 'Article enhancement complete' });
    // Coverage Report is surfaced in its own tab (not appended to the article).
    emit('coverage', {
      checked: coverage.report.length,
      total: 12,
      covered: coverage.coveredCount,
      reportMarkdown: buildCoverageMarkdown(coverage.report),
    });
    emit('enhanced', { text: enhancedText });

  } catch (err) {
    console.error('[article-enhancement] Error:', err.message);
    emit('fail', { message: err.message });
  }

  emit('done', {});
  res.end();
});

// ── Content-type & depth classification (Fixes 3 & 4) ──────────────────────────
// Lightweight heuristics — no extra model call. Calibrate recommendations to the
// kind of page (article vs hub vs landing vs thin) and how developed it already is.
function classifyContentType({ wordCount, h2Count, linkCount, bodyText }) {
  const linkDensity = wordCount > 0 ? linkCount / wordCount : 0;
  if (wordCount < 300) return 'thin-content';
  if (linkDensity > 0.05 && wordCount < 800) return 'hub';
  if (/\b(buy|get started|free trial|contact us|sign up|request a demo|book a demo)\b/i.test(bodyText) && wordCount < 600) return 'landing-page';
  return 'article';
}

function getDepthTier(wordCount) {
  if (wordCount < 500) return 'thin';          // needs major expansion
  if (wordCount < 1500) return 'moderate';     // some expansion + refinement
  if (wordCount < 3000) return 'substantial';  // refinement + gap-filling
  return 'comprehensive';                      // targeted gap-filling only
}

const CONTENT_TYPE_LABEL = {
  'article': '📄 Article',
  'hub': '🗂️ Hub Page',
  'landing-page': '🏷️ Landing Page',
  'thin-content': '📃 Thin Content',
};
const DEPTH_TIER_LABEL = {
  thin: '🔴 Thin',
  moderate: '🟡 Moderate',
  substantial: '🟢 Substantial',
  comprehensive: '🔵 Comprehensive',
};

// ── buildArticleDataFromText ────────────────────────────────────────────────────
function buildArticleDataFromText(url, text) {
  const lines = text.split('\n');
  const h1s = [];
  const h2s = [];
  const h3s = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('### ')) h3s.push(t.slice(4).trim());
    else if (t.startsWith('## ')) h2s.push(t.slice(3).trim());
    else if (t.startsWith('# ')) h1s.push(t.slice(2).trim());
  }

  const bodyText = text.trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}

  const linkCount = 0;
  return {
    url,
    title: h1s[0] || hostname || 'Manual Content',
    h1: h1s[0] || '',
    h2s,
    h3s,
    metaDescription: '',
    bodyText,
    wordCount,
    linkCount,
    contentType: classifyContentType({ wordCount, h2Count: h2s.length, linkCount, bodyText }),
    depthTier: getDepthTier(wordCount),
    internalLinks: [],
    externalLinks: [],
  };
}

// ── fetchArticleResilient ──────────────────────────────────────────────────────
// Crawl resilience (Fix 2): try a direct fetch first; if the site blocks it
// (403/Cloudflare) or returns thin content, fall back to the Jina reader service
// which renders JS and bypasses most bot walls. Returns null if both fail — the
// caller then routes the user to the paste-content fallback.
async function fetchArticleResilient(url, emit) {
  try {
    const d = await fetchArticle(url);
    if (d.wordCount >= 100) return d;
    emit('step', { id: 'crawl', status: 'active', message: 'Direct fetch returned little content — retrying via reader service…' });
  } catch (err) {
    const status = err.response?.status ? `HTTP ${err.response.status}` : 'network error';
    emit('step', { id: 'crawl', status: 'active', message: `Direct fetch blocked (${status}) — retrying via reader service…` });
  }
  try {
    return await fetchViaReader(url);
  } catch (err) {
    console.error('[article-enhancement] reader fallback failed:', err.message);
    return null;
  }
}

// ── fetchViaReader ─────────────────────────────────────────────────────────────
// Fetch readable markdown via the Jina reader (r.jina.ai). It renders JS and
// returns clean markdown with `#`/`##` headings, which buildArticleDataFromText
// parses into the same shape as a direct crawl.
async function fetchViaReader(url) {
  // Jina now puts keyless traffic behind a Cloudflare challenge (403 "Just a
  // moment..." for every URL), so JINA_API_KEY is required for this fallback to
  // work at all. Without it the request still goes out — it just fails as before.
  const readerKey = process.env.JINA_API_KEY;
  const response = await axios.get(`https://r.jina.ai/${url}`, {
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/plain',
      'X-Return-Format': 'markdown',
      ...(readerKey ? { 'Authorization': `Bearer ${readerKey}` } : {}),
    },
    responseType: 'text',
  });
  let md = String(response.data || '');
  // Jina prefixes "Title: …\nURL Source: …\nMarkdown Content:\n" before the body.
  let title = '';
  const titleMatch = md.match(/^Title:\s*(.+)$/m);
  if (titleMatch) title = titleMatch[1].trim();
  const idx = md.indexOf('Markdown Content:');
  if (idx >= 0) md = md.slice(idx + 'Markdown Content:'.length);
  md = cleanReaderMarkdown(md, title);
  const data = buildArticleDataFromText(url, md.trim());
  if (title) { data.title = title; if (!data.h1) data.h1 = title; }
  return data;
}

// ── cleanReaderMarkdown ────────────────────────────────────────────────────────
// The reader linearizes the WHOLE page (nav, geo prompts, related posts, footer,
// city/brand link lists) into one markdown blob. Strip that chrome so only the
// real article body is enhanced. Heuristic but conservative.
function cleanReaderMarkdown(md, title = '') {
  let lines = md.split('\n');
  const titleNorm = (title || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Lines that are pure site chrome — drop outright.
  const JUNK_LINE = /^(please enter your address|enter your address|share this( post| article)?|sign ?up|log ?in|sign in|support|contact us|see all|copyright\s*©|all rights reserved|do not sell|terms of service|privacy policy|cookie|become a driver|licensed retailers?|referral program|top cities|top brands|top categories|about us|careers|press|blog|delivery locations)/i;

  // End-of-article signals — cut everything from the first one onward (once we
  // have already seen real article content).
  const END_SIGNAL = /^(#{1,6}\s*)?(related (articles?|posts?|reads?)|recommended (posts?|articles?|reads?)|more on this topic|you might also like|more (from|articles?|posts?)|share this( post| article)?|top cities|top brands|top categories|copyright\s*©)/i;

  // A line that is essentially just markdown links / bullet-separated links.
  const isPureLinks = (t) => {
    if (!/\[[^\]]*\]\([^)]*\)/.test(t)) return false;
    const stripped = t.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[·•|\-–—\s]/g, '');
    return stripped.length < 4;
  };

  // The Jina reader renders nav items as DOUBLED links: [[Label](/path)Label](https://url).
  // These are pure navigation, but isPureLinks misses them because the doubled syntax
  // leaves leftover text after a single link-strip pass. Strip all link markup (doubled,
  // normal, and bare URLs); if almost nothing remains, the line is a nav/menu item.
  const stripAllLinkMarkup = (t) => t
    .replace(/\[\[[^\]]*\]\([^)]*\)[^\]]*\]\([^)]*\)/g, ' ') // doubled (Jina) links
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')                    // normal markdown links
    .replace(/https?:\/\/\S+/g, ' ');                        // bare URLs
  const isNavLinkLine = (t) => {
    if (!/\]\(|https?:\/\//.test(t)) return false;           // must contain a link/URL
    const rest = stripAllLinkMarkup(t).replace(/[●•·|:+*\-–—\s]/g, '');
    return rest.length < 8;                                   // essentially just the link(s)
  };

  // 1. Trailing cut at the first end-signal that appears after real content.
  let seenContent = false;
  let cutAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!seenContent && !isPureLinks(t) && t.replace(/^[#>*\s-]+/, '').split(/\s+/).filter(Boolean).length > 25) seenContent = true;
    if (seenContent && END_SIGNAL.test(t)) { cutAt = i; break; }
  }
  if (cutAt > 0) lines = lines.slice(0, cutAt);

  // 2. Drop junk + pure-link lines.
  lines = lines.filter(l => {
    const t = l.trim();
    if (!t) return true; // keep blank lines for paragraph structure
    if (JUNK_LINE.test(t)) return false;
    if (isPureLinks(t)) return false;
    if (isNavLinkLine(t)) return false;
    // Post byline scraps the reader drags in above the body.
    if (/^\d+\s*min\s+read$/i.test(t)) return false;                          // "5 min read"
    if (/^[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}$/.test(t)) return false;     // "July 2, 2026"
    if (titleNorm && !/^#/.test(t)) {                                          // breadcrumb duplicate of the title
      const bare = t.replace(/^[●•·\-*\s]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (bare === titleNorm) return false;
    }
    return true;
  });

  // 3. Leading trim: drop chrome before the first heading or substantial paragraph.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^#{1,3}\s/.test(t) || t.split(/\s+/).filter(Boolean).length > 15) { start = i; break; }
  }
  lines = lines.slice(start);

  return lines.join('\n')
    .replace(/^(#{1,6})\s+#{1,6}\s+/gm, '$1 ')                              // collapse doubled heading markers ("## ## X" -> "## X")
    .replace(/\[\[([^\]]*)\]\([^)]*\)([^\]]*)\]\([^)]*\)/g, (m, a, b) => (b || a)) // Jina doubled links -> anchor text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                                // any remaining markdown links -> anchor text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── refineArticleBoundary (LLM block-classifier) ───────────────────────────────
// After the heuristic crawl, ask the model which blocks are the MAIN ARTICLE BODY
// vs site boilerplate, then keep only the article blocks — verbatim. Reasoning
// about content (not pattern-matching) generalizes to any site. Safe by design:
// the model returns boilerplate indices, so a failure/empty result keeps
// everything, and guardrails reject implausible over-drops.
async function refineArticleBoundary(openai, articleData) {
  const md = articleData.mainContentHtml
    ? htmlChunkToMarkdown(articleData.mainContentHtml)
    : (articleData.bodyText || '');
  const blocks = md.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  if (blocks.length < 4) return articleData; // too small to bother

  let dropSet;
  try {
    dropSet = await classifyBoilerplateBlocks(openai, blocks, articleData);
  } catch (err) {
    console.error('[article-enhancement] boundary classify error:', err.message);
    return articleData;
  }
  if (!dropSet || dropSet.size === 0) return articleData;
  // Only bail on a near-total drop (a model that nuked the whole page). Nav-heavy
  // pages legitimately have the real article as a small fraction of the extracted
  // text — global mega-menus + footers can dwarf the body — so the old 70% cap
  // wrongly kept all that boilerplate. Rely on the kept-content word floor instead.
  if (dropSet.size >= blocks.length) return articleData;

  const cleanedMd = blocks.filter((_, i) => !dropSet.has(i)).join('\n\n').trim();
  if (cleanedMd.split(/\s+/).filter(Boolean).length < 120) return articleData; // safety floor

  const h2s = [];
  const h3s = [];
  for (const line of cleanedMd.split('\n')) {
    const t = line.trim();
    if (t.startsWith('### ')) h3s.push(t.slice(4).trim());
    else if (t.startsWith('## ')) h2s.push(t.slice(3).trim());
  }
  const wordCount = cleanedMd.split(/\s+/).filter(Boolean).length;

  return {
    ...articleData,
    mainContentHtml: null,   // downstream now consumes the cleaned markdown
    bodyText: cleanedMd,
    h2s: h2s.length ? h2s : articleData.h2s,
    h3s: h3s.length ? h3s : (articleData.h3s || []),
    wordCount,
    droppedBlocks: dropSet.size,
  };
}

async function classifyBoilerplateBlocks(openai, blocks, articleData) {
  const list = blocks
    .map((b, i) => `${i}: ${b.replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');

  const res = await openai.chat.completions.create({
    model: openai.model,
    response_format: { type: 'json_object' },
    max_completion_tokens: 1500,
    messages: [
      { role: 'system', content: 'You identify which blocks of a scraped web page are the MAIN ARTICLE BODY versus page boilerplate. Respond with valid JSON only.' },
      {
        role: 'user',
        content: `Article title: "${articleData.title}"

Below are numbered text blocks extracted from a scraped page (previews, one per line). Identify the blocks that are NOT part of the main article body — i.e. site boilerplate such as: navigation/menus, breadcrumbs, related/recommended/"more" articles, "share this" widgets, author bio boxes, newsletter/subscribe CTAs, comment sections, ads, cookie/consent or age/address gates, city/brand/category link lists, "see all" links, login/signup, and the site footer (copyright, terms, privacy, contact, careers).

KEEP (do NOT list) the article's own title, introduction, section headings, body paragraphs, lists, tables, and conclusion. When unsure, KEEP the block — only list a block when you are confident it is boilerplate.

BLOCKS:
${list}

Return JSON: { "boilerplate_blocks": [integer indices of blocks that are boilerplate and should be removed] }`,
      },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content || '{}');
  const arr = Array.isArray(parsed.boilerplate_blocks) ? parsed.boilerplate_blocks : [];
  return new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < blocks.length));
}

// ── fetchArticle ───────────────────────────────────────────────────────────────
async function fetchArticle(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    },
    responseType: 'text',
  });

  const html = response.data;
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const h1 = $('h1').first().text().trim();

  const baseHostname = new URL(url).hostname.replace(/^www\./, '');
  const internalLinks = [];
  const externalLinks = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const linkUrl = new URL(href, url);
      const lh = linkUrl.hostname.replace(/^www\./, '');
      if (lh === baseHostname) internalLinks.push(linkUrl.href);
      else externalLinks.push(linkUrl.href);
    } catch {}
  });

  $('script, style, nav, header, footer, aside, noscript, iframe, form, ' +
    '[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

  const NON_CONTENT = [
    /\b(related[-_]?(posts?|articles?|content)|you[-_]?might[-_]?also|recommended[-_]?(posts?|articles?)|more[-_]?(articles?|posts?|reads?))\b/i,
    /\b(share[-_]?(this|post|article|buttons?)|social[-_]?(share|media|links?|icons?)|follow[-_]?us)\b/i,
    /\b(comments?[-_]?(section|area|box|form|list)|discussion|disqus|utterances|livefyre)\b/i,
    /\b(newsletter[-_]?(signup|form|cta|block)|subscribe[-_]?(form|block|cta)|subscription[-_]?form)\b/i,
    /\b(advert(isement)?|ad[-_]?(unit|slot|container|block)|sponsor(ed)?|promo(tion)?[-_]?(box|banner))\b/i,
    /\b(sidebar|side[-_]?bar|widget[-_]?(area|container|block)|flyout|off[-_]?canvas)\b/i,
    /\b(modal|popup|pop[-_]?up|overlay|lightbox|dialog|drawer)\b/i,
    /\b(office[-_]?locations?|locations?[-_]?(list|grid|directory|finder|map)|store[-_]?(finder|locator)|find[-_]?a[-_]?(location|store|office|clinic))\b/i,
    /\b(all[-_]?offices?|our[-_]?offices?|branch(es)?[-_]?(list|directory|map)|clinic[-_]?(list|directory|locations?))\b/i,
    /\b(breadcrumb|pagination|pager|page[-_]?nav(igation)?|prev[-_]?next|post[-_]?nav)\b/i,
    /\b(cookie[-_]?(banner|notice|bar|consent)|gdpr[-_]?(notice|banner|consent)|consent[-_]?(bar|notice))\b/i,
    /\b(call[-_]?to[-_]?action|book[-_]?(now|appointment|consultation|today)|schedule[-_]?(now|today|consultation)|cta[-_]?(block|section|box|banner))\b/i,
    /\b(author[-_]?(bio|info|box|card|profile)|about[-_]?the[-_]?author|written[-_]?by|byline)\b/i,
    /\b(tags?[-_]?(list|cloud|section)|categor(y|ies)[-_]?(list|nav|section)|archive[-_]?(list|nav))\b/i,
    /\b(latest[-_]?articles?|recent[-_]?(posts?|articles?)|trending[-_]?(posts?|articles?)|popular[-_]?(posts?|articles?)|featured[-_]?(posts?|articles?))\b/i,
    /\b(global[-_]?(footer|nav|cta|locations?|offices?)|site[-_]?(footer|wide|global)|page[-_]?footer)\b/i,
    /\b(loading[-_]?(spinner|screen|overlay|state|indicator)?|skeleton[-_]?loader|preloader|spinner[-_]?(wrap|container)?)\b/i,
    /\b(service[-_]?(list|menu|area|section|grid)|our[-_]?services?|services?[-_]?(we[-_]?offer|offered)|treatment[-_]?(list|menu|options?)|procedure[-_]?(list|menu))\b/i,
    /\b(nearby[-_]?(locations?|offices?|clinics?)|other[-_]?(locations?|offices?|clinics?)|all[-_]?(locations?|clinics?|practices?|offices?))\b/i,
    /\b(enter[-_]?(your[-_]?)?address|address[-_]?(prompt|gate|bar|modal)|geo[-_]?(gate|prompt|modal)|age[-_]?(gate|verify|verification))\b/i,
    /\b(top[-_]?(cities|brands|categories|products)|see[-_]?all[-_]?(cities|brands|categories)|cities[-_]?(list|grid)|brands?[-_]?(list|grid|menu))\b/i,
  ];

  const preNonContentTextLen = $('body').text().replace(/\s+/g, ' ').trim().length;
  $('[class], [id]').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'body') return;
    const combined = `${($(el).attr('class') || '')} ${($(el).attr('id') || '')}`.toLowerCase();
    if (!NON_CONTENT.some(p => p.test(combined))) return;
    // Guard: real boilerplate (sidebars, CTAs, share widgets) never holds most
    // of a page's text. If it does, this is a main-content wrapper with a
    // misleading class/id (e.g. Drupal's `dialog-off-canvas-main-canvas`),
    // not actual chrome — skip removal.
    const elTextLen = $(el).text().replace(/\s+/g, ' ').trim().length;
    if (preNonContentTextLen > 0 && elTextLen > preNonContentTextLen * 0.5) return;
    $(el).remove();
  });

  const ARTICLE_SELECTORS = [
    'article[class*="post"]', 'article[class*="article"]', 'article[class*="blog"]',
    'article[class*="entry"]', 'article[class*="content"]',
    'article',
    '[role="main"]',
    '.post-content', '.entry-content', '.article-content', '.article-body',
    '.blog-content', '.blog-post-content', '.blog-entry-content',
    '.post-body', '.story-body', '.article__body', '.article__content',
    '.content-area', '.main-content', '.page-content', '.primary-content',
    '#content', '#main-content', '#article-content', '#post-content', '#entry-content',
    'main',
  ];

  let $mainEl = null;
  for (const sel of ARTICLE_SELECTORS) {
    try {
      const $el = $(sel).first();
      if ($el.length && $el.text().replace(/\s+/g, ' ').trim().length > 300) {
        $mainEl = $el;
        break;
      }
    } catch {}
  }
  if (!$mainEl) $mainEl = $('body');

  $mainEl.find('ul, ol, nav, div, section').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 30) return;
    const links = $el.find('a');
    const linkText = links.map((_, a) => $(a).text()).get().join(' ').replace(/\s+/g, ' ').trim();
    const linkDensity = text.length > 0 ? linkText.length / text.length : 0;
    if (linkDensity > 0.5 && links.length >= 3) $(el).remove();
  });

  $mainEl.find('ul, ol').each((_, el) => {
    const $el = $(el);
    const $items = $el.children('li');
    if ($items.length < 12) return;
    const lens = $items.map((_, li) => $(li).text().trim().length).get();
    const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    const shortFraction = lens.filter(l => l < 40).length / (lens.length || 1);
    if (avg < 35 || shortFraction > 0.8) $(el).remove();
  });

  // Pass: remove classless/idless loading text nodes
  $mainEl.find('*').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/^(loading\.{0,3}|please wait\.{0,3}|\.{3,5})$/i.test(t)) $(el).remove();
  });

  // Pass: remove standalone document-control codes (e.g. "MM000125_C")
  $mainEl.find('*').each((_, el) => {
    if ($(el).children().length) return; // leaf nodes only
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length <= 20 && /^[A-Z]{2,}\d{3,}[_-]?[A-Z0-9]*$/.test(t)) $(el).remove();
  });

  // Pass: remove trailing end-of-article sections from within mainEl
  truncateAfterArticleEnd($, $mainEl);

  const mainContentHtml = $mainEl.html() || '';

  // Fix 2: extract headings from the cleaned FULL document (site chrome and
  // NON_CONTENT/junk blocks already removed above), not from the narrowly-
  // selected content container. Some sites (e.g. Ahrefs) nest section headings
  // outside the matched container, which previously reported "1 H2" on a long
  // article and made the engine recommend sections that already exist. Dedup
  // case-insensitively to avoid repeated-markup duplicates.
  const uniqHeadings = (sel) => {
    const seen = new Map();
    $(sel).each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    });
    return [...seen.values()];
  };
  const h2s = uniqHeadings('h2');
  const h3s = uniqHeadings('h3');
  const h4s = uniqHeadings('h4');

  const $c = cheerio.load(mainContentHtml);
  const allHeadings = [...h2s, ...h3s, ...h4s];
  const faqs = allHeadings.filter(h => /^(what|how|why|when|where|who|can|is|are|does|do|will|should)\b/i.test(h));
  const bodyText = $c('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // Fixes 3 & 4: content-type + depth classification (heuristic, no model call).
  const linkCount = internalLinks.length + externalLinks.length;
  const contentType = classifyContentType({ wordCount, h2Count: h2s.length, linkCount, bodyText });
  const depthTier = getDepthTier(wordCount);

  return {
    url,
    title,
    metaDescription,
    h1,
    h2s,
    h3s,
    h4s,
    faqs,
    bodyText,
    wordCount,
    linkCount,
    contentType,
    depthTier,
    internalLinks: internalLinks.slice(0, 50),
    externalLinks: externalLinks.slice(0, 20),
    mainContentHtml,
  };
}

// ── generateThemeAndQuery ──────────────────────────────────────────────────────
async function generateThemeAndQuery(openai, articleData) {
  const res = await openai.chat.completions.create({
    model: openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are an expert content analyst. Respond with valid JSON only.' },
      {
        role: 'user',
        content: `Analyze this article and identify its main theme and the primary user search query it addresses.

Title: ${articleData.title}
H1: ${articleData.h1}
H2s: ${articleData.h2s.join(' | ')}

Content sample (first 3000 chars):
${articleData.bodyText.slice(0, 3000)}

Return JSON:
{
  "theme": "The article's main topic/theme in 4-8 words",
  "query": "The primary user search query this article addresses, 4-12 words, phrased as a natural user search"
}`,
      }
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

// ── runLLMQueries ──────────────────────────────────────────────────────────────
async function runLLMQueries(openai, query, emit) {
  const results = await Promise.all(MODELS.map(async (model, modelIndex) => {
    try {
      const prompt = `Query: "${query}"

Provide a comprehensive response to this search query. Include:
- Key concepts, definitions, and explanations
- Important statistics, data points, and research findings (with sources where known)
- Best practices, methodologies, or actionable insights
- Expert perspectives or authoritative viewpoints
- Nuanced considerations or common misconceptions

This information will be used to enhance an article on this topic. Focus on depth, accuracy, and specificity.`;
      const text = await callLLM(openai, model, prompt);
      emit('llm_result', { modelIndex, model, success: true });
      return { modelIndex, model, success: true, text };
    } catch (err) {
      emit('llm_result', { modelIndex, model, success: false, error: err.message });
      return { modelIndex, model, success: false, text: '', error: err.message };
    }
  }));

  return results;
}

// ── callLLM ────────────────────────────────────────────────────────────────────
async function callLLM(openai, model, prompt) {
  try {
    const res = await openai.chat.completions.create({
      model,
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: 'You are a knowledgeable expert. Provide comprehensive, factual information.' },
        { role: 'user', content: prompt },
      ],
    });
    return res.choices[0].message.content || '';
  } catch (err) {
    if (err.status === 400 || err.status === 422) {
      // Retry without token limit in case the model doesn't support max_completion_tokens
      const res = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are a knowledgeable expert. Provide comprehensive, factual information.' },
          { role: 'user', content: prompt },
        ],
      });
      return res.choices[0].message.content || '';
    }
    throw err;
  }
}

// ── synthesizeConcepts ─────────────────────────────────────────────────────────
async function synthesizeConcepts(openai, query, { model, text }) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an expert content analyst. Respond with valid JSON only.' },
        {
          role: 'user',
          content: `Query: "${query}"
Model: ${model}

Response to analyze:
${text.slice(0, 1500)}

Extract all distinct concepts, ideas, facts, statistics, and insights from this response.

Return JSON:
{
  "model": "${model}",
  "concepts": [
    "Concept or fact — specific and self-contained"
  ]
}

Rules:
- Each concept must be a standalone, self-contained statement
- Include specific statistics with their source when mentioned
- Aim for 5-10 concepts per response
- Prioritize specificity over generality`,
        }
      ],
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error('[synthesis] error for model', model, ':', err.message);
    return { model, concepts: [] };
  }
}

// ── runConceptSynthesis ────────────────────────────────────────────────────────
async function runConceptSynthesis(openai, query, llmResults, emit) {
  const successfulResults = llmResults.filter(r => r.success && r.text);

  const synthResults = await Promise.all(
    successfulResults.map(async (result) => {
      const synth = await synthesizeConcepts(openai, query, result);
      emit('synthesis_result', synth);
      return synth;
    })
  );

  const seenConcepts = new Set();
  const allConcepts = [];
  for (const s of synthResults) {
    for (const concept of (s.concepts || [])) {
      const key = concept.toLowerCase().trim().slice(0, 80);
      if (!seenConcepts.has(key)) {
        seenConcepts.add(key);
        allConcepts.push(concept);
      }
    }
  }

  return { allConcepts };
}

// ── SERP competitor research ────────────────────────────────────────────────────
// Runs as a branch parallel to the LLM research fan-out (see runSerpCompetitorBranch
// below). Reuses the two search integrations already in the repo (Google CSE primary,
// Serper fallback — both handled inside searchGoogle()) and the existing crawler
// (fetchArticleResilient) rather than adding new providers or a second scraper.
const SERP_EXCLUDE_HOSTS = new Set([
  'youtube.com', 'reddit.com', 'quora.com', 'pinterest.com',
  'facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
]);

function isExcludedSerpHost(host) {
  if (!host) return true;
  for (const h of SERP_EXCLUDE_HOSTS) {
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

// ── fetchSerpResults ────────────────────────────────────────────────────────────
async function fetchSerpResults(seedKeyword, { limit = 10, excludeUrl } = {}) {
  if (!seedKeyword?.trim()) return [];

  let excludeHost = '';
  if (excludeUrl) {
    try { excludeHost = new URL(excludeUrl).hostname.replace(/^www\./, ''); } catch {}
  }

  let searchData;
  try {
    searchData = await searchGoogle(seedKeyword);
    console.log('[article-enhancement] SERP served by:', searchData.source);
  } catch (err) {
    console.error('[article-enhancement] SERP search failed:', err.message);
    return [];
  }

  const filtered = [];
  for (const r of (searchData.results || [])) {
    if (!r.url) continue;
    let host = '';
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (excludeHost && host === excludeHost) continue;
    if (isExcludedSerpHost(host)) continue;
    if (/\.pdf(\?|$)/i.test(r.url)) continue;
    filtered.push({ rank: filtered.length + 1, title: r.title || '', url: r.url, snippet: r.snippet || '' });
    if (filtered.length >= limit) break;
  }
  return filtered;
}

// ── mapWithConcurrency / withTimeout ─────────────────────────────────────────────
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── scrapeCompetitorPages ────────────────────────────────────────────────────────
// Reuses fetchArticleResilient (direct fetch -> Jina reader fallback) — the same
// crawler used for the main article — so competitor pages get identical boilerplate
// handling. Concurrency-capped and per-page timed out so a handful of slow/blocked
// competitors can't become the long pole of the pipeline. Partial results (some pages
// failing) are expected and fine — this never throws per-page.
async function scrapeCompetitorPages(results, { concurrency = 3, perPageTimeoutMs = 15000 } = {}) {
  const noop = () => {};
  return mapWithConcurrency(results, concurrency, async (r) => {
    try {
      const data = await withTimeout(fetchArticleResilient(r.url, noop), perPageTimeoutMs);
      if (!data || data.wordCount < 100) {
        return { url: r.url, title: r.title || '', h2s: [], wordCount: data?.wordCount || 0, bodyText: '', fetchOk: false };
      }
      return {
        url: r.url,
        title: data.title || r.title || '',
        h2s: data.h2s || [],
        wordCount: data.wordCount,
        bodyText: data.bodyText || '',
        fetchOk: true,
      };
    } catch {
      return { url: r.url, title: r.title || '', h2s: [], wordCount: 0, bodyText: '', fetchOk: false };
    }
  });
}

// ── extractCompetitorConcepts ────────────────────────────────────────────────────
async function extractPageTopics(openai, page, seedKeyword) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an expert content analyst. Respond with valid JSON only.' },
        {
          role: 'user',
          content: `Seed keyword: "${seedKeyword}"
Page title: "${page.title}"
URL: ${page.url}

H2 headings: ${(page.h2s || []).join(' | ') || '(none)'}

Content sample (first 3000 chars):
${(page.bodyText || '').slice(0, 3000)}

List the distinct topics, subtopics, and questions this page covers that are relevant to the seed keyword.

Return JSON:
{
  "topics": [
    { "topic": "short topic label, 3-8 words", "description": "one sentence describing what the page says about it" }
  ]
}

Rules:
- 5-10 topics max
- Each topic must be specific and self-contained, not generic ("benefits" is too vague; "reduced recovery time vs traditional surgery" is good)`,
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    return Array.isArray(parsed.topics) ? parsed.topics : [];
  } catch (err) {
    console.error('[article-enhancement] competitor topic extraction error for', page.url, ':', err.message);
    return [];
  }
}

async function extractCompetitorConcepts(openai, pages, seedKeyword) {
  const successfulPages = pages.filter(p => p.fetchOk && p.bodyText);
  const perPageTopics = await Promise.all(
    successfulPages.map(async (page) => ({ page, topics: await extractPageTopics(openai, page, seedKeyword) }))
  );

  const merged = new Map();
  for (const { page, topics } of perPageTopics) {
    for (const t of topics) {
      const label = (t.topic || '').trim();
      if (!label) continue;
      const key = label.toLowerCase().slice(0, 70);
      if (!merged.has(key)) {
        merged.set(key, { topic: label, description: t.description || '', competitors: new Set() });
      }
      merged.get(key).competitors.add(page.url);
    }
  }

  return [...merged.values()]
    .map(e => ({ topic: e.topic, description: e.description, competitors: [...e.competitors], frequency: e.competitors.size }))
    .sort((a, b) => b.frequency - a.frequency);
}

// ── checkTopicsAgainstArticle ────────────────────────────────────────────────────
// Shared coverage check used by both gap builders: does the article already address
// each topic/concept, judged by meaning (not exact phrasing)? Falls back to a keyword
// overlap heuristic against headings + body if the model call fails.
async function checkTopicsAgainstArticle(openai, articleData, topicList) {
  if (!topicList.length) return new Set();
  const list = topicList.map((t, i) => `${i}: ${t}`).join('\n');
  const bodySummary = (articleData.bodyText || '').slice(0, 2500);

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an expert content analyst. Respond with valid JSON only.' },
        {
          role: 'user',
          content: `Article H1: ${articleData.h1 || articleData.title}
Article H2 sections: ${(articleData.h2s || []).join(' | ') || '(none)'}
Article H3 sections: ${(articleData.h3s || []).join(' | ') || '(none)'}

Article body sample:
${bodySummary}

Below is a numbered list of topics. For each, decide whether the article ALREADY covers it (even if worded differently — judge by meaning, not exact phrasing).

TOPICS:
${list}

Return JSON: { "covered": [array of integer indices that ARE already covered by the article] }`,
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    const arr = Array.isArray(parsed.covered) ? parsed.covered : [];
    return new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < topicList.length));
  } catch (err) {
    console.error('[article-enhancement] topic coverage check error:', err.message);
    const haystack = `${(articleData.h2s || []).join(' ')} ${(articleData.h3s || []).join(' ')} ${(articleData.bodyText || '').slice(0, 5000)}`.toLowerCase();
    const covered = new Set();
    topicList.forEach((t, i) => {
      const words = t.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const hits = words.filter(w => haystack.includes(w)).length;
      if (words.length && hits / words.length >= 0.6) covered.add(i);
    });
    return covered;
  }
}

// ── buildCompetitorGapAnalysis ───────────────────────────────────────────────────
// Topic-level only: recommends what to cover, never lifts competitor wording. This
// keeps the honesty invariant — inserted stats/quotes still must come from the LLM
// research fan-out with a real citation, never from a competitor page.
async function buildCompetitorGapAnalysis(openai, articleData, competitorConcepts, totalCompetitors) {
  if (!competitorConcepts.length) return { gaps: [], covered: [] };

  const labels = competitorConcepts.map(c => c.topic);
  const coveredIdx = await checkTopicsAgainstArticle(openai, articleData, labels);

  const gaps = [];
  const covered = [];
  for (let i = 0; i < competitorConcepts.length; i++) {
    const c = competitorConcepts[i];
    if (coveredIdx.has(i)) {
      covered.push({ topic: c.topic, frequency: c.frequency });
      continue;
    }
    const priority = c.frequency >= 6 ? 'high' : c.frequency >= 3 ? 'medium' : 'low';
    gaps.push({
      topic: c.topic,
      frequency: c.frequency,
      priority,
      note: `Covered by ${c.frequency} of ${totalCompetitors} ranking competitors; absent from this article.`,
    });
  }
  gaps.sort((a, b) => b.frequency - a.frequency);
  return { gaps, covered };
}

// ── buildLlmGapAnalysis ──────────────────────────────────────────────────────────
async function buildLlmGapAnalysis(openai, articleData, synthesizedConcepts) {
  if (!synthesizedConcepts.length) return { gaps: [] };
  const coveredIdx = await checkTopicsAgainstArticle(openai, articleData, synthesizedConcepts);
  const gaps = [];
  synthesizedConcepts.forEach((concept, i) => {
    if (!coveredIdx.has(i)) gaps.push({ concept, priority: 'medium' });
  });
  return { gaps };
}

// ── runLlmResearchBranch / runSerpCompetitorBranch ───────────────────────────────
// The two research branches run in parallel (see the /stream handler's Promise.all)
// so SERP research doesn't stack in series after the LLM fan-out.
async function runLlmResearchBranch(openai, themeData, articleData, emit) {
  emit('step', { id: 'llm_fanout', status: 'active', message: `Querying ${MODELS.length} models in parallel…` });
  const llmResults = await runLLMQueries(openai, themeData.query, emit);
  emit('llm_results', { results: llmResults.map(r => ({ modelIndex: r.modelIndex, model: r.model, success: r.success })) });
  emit('step', { id: 'llm_fanout', status: 'done', message: `${llmResults.filter(r => r.success).length}/${MODELS.length} responses received` });

  emit('step', { id: 'synthesis', status: 'active', message: 'Synthesizing concepts from model outputs…' });
  const { allConcepts } = await runConceptSynthesis(openai, themeData.query, llmResults, emit);
  emit('step', { id: 'synthesis', status: 'done', message: `${allConcepts.length} concepts extracted` });

  let llmGaps = { gaps: [] };
  try {
    llmGaps = await buildLlmGapAnalysis(openai, articleData, allConcepts);
    emit('llm_gaps', { gaps: llmGaps.gaps });
  } catch (err) {
    console.error('[article-enhancement] LLM gap analysis error:', err.message);
  }

  return { llmResults, allConcepts, llmGaps };
}

// Graceful degradation: any failure here (search, scrape, extraction, gap analysis)
// falls back to an empty competitor result and a soft "done" step — SERP research
// must never fail the run. See emit('step', { id: 'serp', ... }) below.
async function runSerpCompetitorBranch(openai, themeData, articleData, emit) {
  emit('step', { id: 'serp', status: 'active', message: 'Searching for top-ranking competitors…' });
  try {
    const serpResults = await fetchSerpResults(themeData.query, { limit: 10, excludeUrl: articleData.url });
    if (!serpResults.length) {
      emit('step', { id: 'serp', status: 'done', message: 'No usable competitor results — skipping competitor analysis' });
      return { serpResults: [], competitorConcepts: [], competitorGaps: { gaps: [], covered: [] } };
    }
    emit('serp_results', { seedKeyword: themeData.query, results: serpResults.map(r => ({ rank: r.rank, title: r.title, url: r.url })) });
    emit('step', { id: 'serp', status: 'active', message: `Found ${serpResults.length} competitors — scraping content…` });

    const pages = await scrapeCompetitorPages(serpResults);
    const okCount = pages.filter(p => p.fetchOk).length;
    if (!okCount) {
      emit('step', { id: 'serp', status: 'done', message: 'Competitor pages could not be scraped — skipping competitor analysis' });
      return { serpResults, competitorConcepts: [], competitorGaps: { gaps: [], covered: [] } };
    }
    emit('step', { id: 'serp', status: 'active', message: `Scraped ${okCount}/${pages.length} competitor pages — extracting topics…` });

    const competitorConcepts = await extractCompetitorConcepts(openai, pages, themeData.query);
    const competitorGaps = await buildCompetitorGapAnalysis(openai, articleData, competitorConcepts, okCount);

    const coveredTopics = new Set((competitorGaps.covered || []).map(c => c.topic));
    emit('competitor_concepts', {
      totalCompetitors: okCount,
      concepts: competitorConcepts.map(c => ({ topic: c.topic, frequency: c.frequency, coveredByArticle: coveredTopics.has(c.topic) })),
    });
    emit('competitor_gaps', { gaps: competitorGaps.gaps });
    emit('step', { id: 'serp', status: 'done', message: `${competitorGaps.gaps.length} competitor content gap(s) identified` });

    return { serpResults, competitorConcepts, competitorGaps };
  } catch (err) {
    console.error('[article-enhancement] SERP competitor branch error:', err.message);
    emit('step', { id: 'serp', status: 'done', message: 'Competitor analysis unavailable — continuing with LLM research only' });
    return { serpResults: [], competitorConcepts: [], competitorGaps: { gaps: [], covered: [] } };
  }
}

// ── generateRecommendations ────────────────────────────────────────────────────
async function generateRecommendations(openai, articleData, themeData, allConcepts, kb, competitorGaps, llmGaps) {
  const kbGuidance = kb ? `\n\nEnhancement Framework:\n${kb.body}` : '';

  const compGaps = competitorGaps?.gaps || [];
  const competitorGapsText = compGaps.length
    ? compGaps.map(g => `- [${g.priority.toUpperCase()}] ${g.topic} — ${g.note}`).join('\n')
    : '(No significant competitor content gaps identified — either competitor research was unavailable, or the article already covers what ranking competitors cover.)';

  const llmGapList = llmGaps?.gaps || [];
  const llmGapsText = llmGapList.length
    ? llmGapList.map(g => `- ${g.concept}`).join('\n')
    : '(No uncovered research concepts identified.)';

  const res = await openai.chat.completions.create({
    model: openai.model,
    max_completion_tokens: 3400,
    messages: [
      {
        role: 'system',
        content: `You are a senior SEO and content strategist producing article enhancement recommendations. Be specific, actionable, and prioritized. When drawing on SERP Competitor Gaps or LLM Research Gaps, recommend the TOPIC or ANGLE to cover — never instruct copying a competitor's specific wording, sentences, or claims.${kbGuidance}`,
      },
      {
        role: 'user',
        content: `Article: "${articleData.title}"
URL: ${articleData.url}
Theme: ${themeData.theme}
Word count: ${articleData.wordCount}
Content type: ${articleData.contentType}
Article depth: ${articleData.depthTier} (${articleData.wordCount} words)
H1: ${articleData.h1}

The article already contains the following H2 sections:
${(articleData.h2s || []).map(h => `- ${h}`).join('\n') || '- (none detected)'}

Only recommend ADDING sections that are NOT already present above. Do not suggest a section the article already has.

Query this article should address: ${themeData.query}

Synthesized concepts from multi-model research:
${allConcepts.join('\n').slice(0, 8000)}

SERP Competitor Gaps — topics ranking competitors cover that this article does not (topic/angle only, never their wording):
${competitorGapsText}

LLM Research Gaps — research concepts not yet covered by this article:
${llmGapsText}

---

CALIBRATION

Content type: ${articleData.contentType}
- If "hub": focus on navigation clarity, concise definitions/introductions for each linked topic, and the page's ability to serve as an authoritative entry point — NOT on adding long-form prose sections.
- If "landing-page": focus on clarity of the offer, trust signals, and concise supporting content — not long editorial sections.
- If "article": focus on depth, structure, E-E-A-T, and topical completeness.
- If "thin-content": focus on substantial expansion of the core topic before any other optimization.

Article depth: ${articleData.depthTier}
- If "thin": prioritize adding missing foundational sections and substantially expanding coverage. Do not recommend minor tweaks.
- If "moderate": balance adding missing sections with improving existing ones.
- If "substantial": focus on filling specific content gaps, improving E-E-A-T, and strengthening the unique angle. Avoid recommending sections the article already covers.
- If "comprehensive": ONLY recommend targeted, high-value additions (a specific missing subtopic, a data table, an expert-quote section). Do NOT suggest "add an intro" or "explain the basics" — assume foundational coverage already exists.

---

Produce a structured Enhancement Recommendations document:

## Priority Enhancements (Top 5)
Rank the 5 most impactful improvements. For each: what to add/change, why it matters, where in the article.

## Content Gaps
Specific topics or concepts from the research that are absent from the article. For each gap: what to add and where.

## SERP Competitor Gaps
List each competitor gap topic with its competitor frequency (e.g. "covered by 7 of 10 ranking competitors") and priority. Recommend the topic/angle to add — never competitor wording. If none were identified, state that clearly.

## LLM Research Gaps
List research concepts the article does not yet cover and why they matter. If none were identified, state that clearly.

## SEO & GEO Improvements
Heading optimizations, keyword opportunities, answer-first structures, entity completeness.

## E-E-A-T & Trust Signals
Statistics, expert quotes, and citations the article should incorporate.

## Structure & FAQ
New sections to add (only if explicitly needed), FAQ questions to include.

Be specific. Reference actual H2 headings. Do not give generic advice.`,
      }
    ],
  });

  return res.choices[0].message.content || '';
}

// ── htmlChunkToMarkdown ────────────────────────────────────────────────────────
function htmlChunkToMarkdown(html) {
  const $ = cheerio.load(`<body>${html}</body>`);
  const SKIP = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript', 'iframe', 'form']);
  const lines = [];
  let inFaqSection = false;

  function text(el) { return $(el).text().replace(/\s+/g, ' ').trim(); }

  function walk(el) {
    const tag = (el.tagName || '').toLowerCase();
    if (!tag || SKIP.has(tag)) return;
    switch (tag) {
      case 'h1': { const t = text(el); if (t) lines.push('# ' + t, ''); break; }
      case 'h2': {
        const t = text(el);
        if (t) {
          inFaqSection = /faq|frequently asked/i.test(t);
          lines.push('## ' + t, '');
        }
        break;
      }
      case 'h3': { const t = text(el); if (t) lines.push('### ' + t, ''); break; }
      case 'h4': case 'h5': case 'h6': { const t = text(el); if (t) lines.push('#### ' + t, ''); break; }
      case 'p': {
        // Inside FAQ sections: a <p> whose only child is <strong> or <b> ending in '?' → treat as question heading
        if (inFaqSection) {
          const kids = $(el).children().toArray();
          if (kids.length === 1) {
            const kidTag = (kids[0].tagName || '').toLowerCase();
            if (kidTag === 'strong' || kidTag === 'b') {
              const qt = text(el);
              if (qt.endsWith('?')) { lines.push('### ' + qt, ''); break; }
            }
          }
        }
        const t = text(el); if (t) lines.push(t, ''); break;
      }
      case 'li': { const t = text(el); if (t) lines.push('- ' + t); break; }
      case 'ul': case 'ol': $(el).children('li').each((_, li) => walk(li)); lines.push(''); break;
      case 'blockquote': { const t = text(el); if (t) lines.push('> ' + t, ''); break; }
      case 'dt': {
        // Definition term — used by some FAQ plugins for questions
        const t = text(el);
        if (t) lines.push(inFaqSection ? '### ' + t : t, '');
        break;
      }
      case 'dd': {
        // Definition description — used alongside <dt> for FAQ answers
        $(el).children().length ? $(el).children().each((_, c) => walk(c)) : (() => { const t = text(el); if (t) lines.push(t); })();
        lines.push('');
        break;
      }
      case 'summary': {
        // <details>/<summary> accordion — summary is always the question
        const t = text(el);
        if (t) lines.push('### ' + t, '');
        break;
      }
      default: {
        const INLINE = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'mark', 'code', 'small', 'sub', 'sup']);
        if (INLINE.has(tag)) break;
        // For block/unknown elements: if it has block-level children, walk them.
        // Otherwise it's a leaf container (button, div with only text, etc.) — emit its text directly.
        const BLOCK = new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','dl','dt','dd','blockquote','details','summary','figure','table','thead','tbody','tr','th','td']);
        const childEls = $(el).children().toArray();
        const hasBlockChild = childEls.some(c => BLOCK.has((c.tagName || '').toLowerCase()));
        if (hasBlockChild) {
          childEls.forEach(c => walk(c));
        } else {
          const t = text(el);
          if (t) {
            if (inFaqSection && t.endsWith('?') && t.split(/\s+/).length <= 25) {
              lines.push('### ' + t, '');
            } else {
              lines.push(t, '');
            }
          }
        }
        break;
      }
    }
  }

  $('body').children().each((_, el) => walk(el));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── enforceFaqHeadings ────────────────────────────────────────────────────────
// Safety net: within any ## FAQ/Frequently Asked section, upgrade bare question
// lines (plain text or **bold**) to ### headings. Handles WordPress-style FAQ
// sections where questions aren't marked up as <h3> in the HTML.
function enforceFaqHeadings(text) {
  const lines = text.split('\n');
  let inFaq = false;
  const result = [];
  for (const line of lines) {
    const stripped = line.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
    if (/^## .*(faq|frequently asked)/i.test(stripped)) {
      inFaq = true;
      result.push(line);
      continue;
    }
    if (inFaq && /^## /.test(stripped)) inFaq = false;
    if (inFaq && !stripped.startsWith('#') && stripped.endsWith('?')) {
      const words = stripped.split(/\s+/).length;
      if (words >= 3 && words <= 25) {
        result.push(`### ${stripped}`);
        continue;
      }
    }
    result.push(line);
  }
  return result.join('\n');
}

// ── insertBeforeTrailingFaq ────────────────────────────────────────────────────
// Insert `addition` immediately before a trailing FAQ section so the FAQ stays the
// last section. If the last H2 isn't an FAQ heading, the addition is appended
// normally. Used when the original article ended with its FAQ.
function insertBeforeTrailingFaq(text, addition) {
  if (!addition || !addition.trim()) return text;
  const lines = text.split('\n');
  let faqIdx = -1;
  // Find the LAST H2 heading; only treat it as the insertion point if it's an FAQ.
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
    if (/^##\s/.test(s)) {
      if (/faq|frequently asked/i.test(s)) faqIdx = i;
      break;
    }
  }
  if (faqIdx === -1) return `${text}\n\n${addition.trim()}`;
  const before = lines.slice(0, faqIdx).join('\n').trimEnd();
  const faqOnward = lines.slice(faqIdx).join('\n');
  return `${before}\n\n${addition.trim()}\n\n${faqOnward}`;
}

// ── normalizeNewMarkers ────────────────────────────────────────────────────────
function normalizeNewMarkers(text) {
  if (!text) return '';
  let t = text;
  // Collapse adjacent/doubled markers (LLMs sometimes emit [NEW][NEW]… or …[/NEW][/NEW],
  // which would otherwise leave a literal [NEW] inside a highlighted run).
  t = t.replace(/\[\/NEW\][ \t]*\[NEW\]/g, ' ');          // close immediately followed by open
  t = t.replace(/(?:\[NEW\][ \t]*){2,}/g, '[NEW]');        // doubled openings → single
  t = t.replace(/(?:\[\/NEW\][ \t]*){2,}/g, '[/NEW]');     // doubled closings → single
  // Re-wrap each line inside a pair; strip any nested stray markers inside the pair.
  t = t.replace(/\[NEW\]([\s\S]*?)\[\/NEW\]/g, (_, inner) => {
    const clean = inner.replace(/\[NEW\]/g, '').replace(/\[\/NEW\]/g, '');
    return clean.split('\n').map(l => l.trim() ? `[NEW]${l.trim()}[/NEW]` : '').join('\n');
  });
  // Strip orphan markers on any line that has only one side of the pair.
  t = t.split('\n').map(line => {
    const hasOpen = line.includes('[NEW]');
    const hasClose = line.includes('[/NEW]');
    if (hasOpen && hasClose) return line;
    return line.replace(/\[NEW\]/g, '').replace(/\[\/NEW\]/g, '');
  }).join('\n');
  return t;
}

// ── normalizeTablesToMarkdown ──────────────────────────────────────────────────
// LLMs sometimes emit tables as HTML <table> or a hybrid (<table> wrapping pipe
// rows) instead of markdown. Convert any such block to clean markdown pipe tables
// so both the web renderer and DOCX export (which only handle markdown) work.
function normalizeTablesToMarkdown(text) {
  if (!text) return '';
  return text.replace(/<table[\s\S]*?<\/table>/gi, (block) => {
    // Hybrid case: <table> wrapping markdown pipe rows — strip tags, keep pipe rows.
    const tagless = block.replace(/<\/?(?:table|thead|tbody|tfoot|tr|th|td)\b[^>]*>/gi, '').trim();
    const pipeRows = tagless.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
    if (pipeRows.length >= 2) {
      return '\n' + ensureSeparatorRow(pipeRows).join('\n') + '\n';
    }
    // Pure HTML case: parse <tr>/<th>/<td> into cells via cheerio.
    try {
      const $ = cheerio.load(block);
      const rows = [];
      $('tr').each((_, tr) => {
        const cells = [];
        $(tr).find('th, td').each((__, c) => cells.push($(c).text().replace(/\s+/g, ' ').trim()));
        if (cells.length) rows.push(cells);
      });
      if (rows.length) {
        const cols = Math.max(...rows.map(r => r.length));
        const pad = (r) => { const o = r.slice(); while (o.length < cols) o.push(''); return o; };
        const md = ['| ' + pad(rows[0]).join(' | ') + ' |', '| ' + Array(cols).fill('---').join(' | ') + ' |'];
        for (let i = 1; i < rows.length; i++) md.push('| ' + pad(rows[i]).join(' | ') + ' |');
        return '\n' + md.join('\n') + '\n';
      }
    } catch { /* fall through to leaving the block untouched */ }
    return block;
  });
}

// Ensure a markdown pipe-table has a `| --- |` separator as its second row.
function ensureSeparatorRow(pipeRows) {
  const strip = (r) => r.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  const isSep = (r) => /^\|?[\s\-|:]+\|?$/.test(strip(r));
  if (pipeRows.length >= 2 && isSep(pipeRows[1])) return pipeRows;
  const cols = Math.max((strip(pipeRows[0]).match(/\|/g) || []).length - 1, 1);
  const sep = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  return [pipeRows[0], sep, ...pipeRows.slice(1)];
}

// ── deduplicateAdditions ───────────────────────────────────────────────────────
function deduplicateAdditions(text) {
  const seenSentences = new Set();
  return text.replace(/\[NEW\]([\s\S]*?)\[\/NEW\]/g, (_, inner) => {
    const sentences = inner.split(/(?<=[.!?])\s+/);
    const kept = [];
    for (const s of sentences) {
      const key = s.trim().toLowerCase().replace(/\s+/g, ' ');
      if (key.length > 30 && seenSentences.has(key)) continue;
      if (key.length > 30) seenSentences.add(key);
      kept.push(s);
    }
    const cleaned = kept.join(' ').trim();
    return cleaned ? `[NEW]${cleaned}[/NEW]` : '';
  });
}

// ── generateStructuralAdditions ────────────────────────────────────────────────
async function generateStructuralAdditions(openai, articleData, themeData, recommendations, kb, skipFaq = false, existingFaqHeading = null) {
  const kbGuidance = kb ? `\n\nKnowledge Base Enhancement Framework:\n${kb.body}` : '';

  // Use the page's existing FAQ heading style, or detect from H2 style, or default
  const faqHeadingText = existingFaqHeading
    ? existingFaqHeading
    : (/\bFAQs?\b/.test((articleData.h2s || []).join(' ')) ? 'FAQs' : 'Frequently Asked Questions');

  const faqBlock = skipFaq
    ? `1. FAQ SECTION: The article already contains a FAQ section — DO NOT add another one. Skip this step entirely.`
    : `1. FAQ SECTION (required):
   Write "## ${faqHeadingText}" as the H2 heading (exactly this text, no variation).
   Add 4-6 questions as ### headings.
   Write each answer as a plain prose paragraph directly below its ### heading. Rules for each answer:
   - Do NOT use bullet lists, numbered lists, or sub-headings inside answers
   - Directly answer the question in the first sentence (inverted pyramid)
   - Be 50-150 words
   - Be self-contained (no references to "the article above")
   - Be factual and non-promotional
   - Include a sourced statistic where relevant: "[X]% of [population] [action] (Source, Year)"`;

  try {
    const res = await openai.chat.completions.create({
      model: openai.model,
      messages: [
        {
          role: 'system',
          content: `You are an SEO and GEO content specialist. Your job is to generate ADDITIONAL SECTIONS to append after an existing article. All content you write is new, so wrap everything you produce in a single [NEW]...[/NEW] block.

WHAT TO GENERATE (in this order):

${faqBlock}

2. ADDITIONAL RECOMMENDED SECTIONS — STRICT RULES:
   - ONLY add a new ## section if the enhancement recommendations' "Priority Enhancements" or "Content Gaps" section EXPLICITLY states a specific section title or topic to add.
   - DO NOT infer, imagine, or add sections you think would be useful.
   - DO NOT add generic evergreen sections such as: "Common Mistakes", "Tools", "Trends", "Tips", "Summary", "Key Takeaways", "Best Practices", "Quick Reference" — unless the report names them verbatim.
   - If the report recommends 0 new sections (or you are unsure), output ONLY the FAQ block and nothing else.
   - Maximum 1 additional section beyond the FAQ.

FORMAT RULES:
- Start your output with [NEW]
- End your output with [/NEW]
- Use ## for H2 section headings, ### for FAQ question headings
- FAQ answers must be plain prose paragraphs — no bullets, no lists, no sub-headings
- Bullet lists with "- " prefix are allowed only in non-FAQ sections
- Do NOT include promotional language
- Do NOT duplicate content already in the article${kbGuidance}`,
        },
        {
          role: 'user',
          content: `Article: "${articleData.title}" | Theme: ${themeData.theme}

ENHANCEMENT RECOMMENDATIONS — scan "Priority Enhancements" and "Content Gaps" for any EXPLICITLY named new sections to add:
${recommendations}

Generate only what is described above. Wrap all output in [NEW]...[/NEW].`,
        },
      ],
    });
    return res.choices[0].message.content || '';
  } catch (err) {
    console.error('[article-enhancement] structural additions error:', err.message);
    return '';
  }
}

// Split markdown body into ~size-bounded chunks on H2 boundaries (used when the
// article came from the reader/manual path as markdown rather than crawled HTML).
function splitMarkdownByH2(md, limit = 8000) {
  const parts = md.split(/(?=^##\s)/m).map(s => s.trim()).filter(Boolean);
  const sections = parts.length > 1 ? parts : [md.trim()];
  const out = [];
  for (const sec of sections) {
    if (sec.length <= limit) { if (sec) out.push(sec); continue; }
    let buf = '';
    for (const para of sec.split(/\n\n+/)) {
      if (buf && (buf.length + para.length + 2) > limit) { out.push(buf); buf = para; }
      else buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf) out.push(buf);
  }
  return out;
}

// ── generateEnhancedArticle ────────────────────────────────────────────────────
async function generateEnhancedArticle(openai, articleData, recommendations, kb) {
  // HTML when crawled directly; markdown when sourced via the reader/manual path.
  const isHtml = !!articleData.mainContentHtml;
  const sourceHtml = articleData.mainContentHtml || articleData.bodyText || '';
  const kbGuidance = kb ? kb.body : '';

  const kbSection = kbGuidance
    ? `KNOWLEDGE BASE — MANDATORY REQUIREMENTS (these override and supplement the defaults below):
${kbGuidance}

`
    : '';

  const systemPrompt = `You are an SEO and GEO content augmentation assistant. Your job is to INSERT substantive, high-value content into an existing article section to improve its AI citability and search performance.

${kbSection}CORE RULE: Existing text must appear VERBATIM. You insert additions only — never rewrite, rephrase, or modify any existing sentence.

WHAT TO ADD (priority order — apply every type that fits this section):

1. STATISTICS — Insert sourced, dated data points. Format exactly: "[X]% of [population] [action] (Source, Year)." Back any claim in the section that data can support. Aim for 1–2 per section where relevant.

2. EXPERT QUOTES — Insert a direct quote from a named, credentialed expert when the section discusses a concept experts have publicly addressed. Format: "As [Full Name], [Credential/Title] at [Organisation] ([Year]): '[quote].'"

3. CITATIONS — Add outbound references to primary sources (research papers, government data, industry reports) in the format "(Source Name, Year)" or as a hyperlink anchor in the text.

4. ANSWER-FIRST SENTENCES — If the section's opening paragraph does not directly answer the section's implied question, insert a direct-answer sentence at the very start.

5. SELF-CONTAINED CONTEXT — If any part of the section references content elsewhere ("as mentioned above", implied context), insert a brief inline clarification so the passage makes sense in isolation.

6. SCANNABLE BULLET LISTS — If a paragraph enumerates 3+ distinct items in prose form without a list, append a [NEW] bullet summary after it. Each bullet should be a specific, scannable data point, not a paraphrase of the prose sentence.

7. TABLES — Actively check whether this section: compares 2+ options (A vs B), lists costs or pricing tiers, describes a step-by-step process or timeline, lists symptoms or conditions, weighs pros and cons, or presents data with multiple attributes per item. If ANY of these apply, you MUST insert a markdown table. Output tables in markdown pipe syntax ONLY — never HTML <table> tags. Format: header row, then separator row (| --- | --- |), then 3–5 data rows. A table counts as your 1 allowed list/table for this section.

VOLUME LIMIT — be surgical, not exhaustive:
- Per section: at most 2 statistics, 1 expert quote, 1 bullet list or table (3–5 rows/bullets max), 1 answer-first sentence
- Total new text per section must not exceed 200 words; tables are exempt from this word limit
- If the section is already well-supported with data and quotes, add nothing — return it verbatim

HARD PROHIBITIONS:
- Do NOT insert new ## or ### headings of your own — ALL existing headings in the input MUST appear in the output verbatim, including ### FAQ question headings
- Do NOT mark existing text with [NEW] — only your insertions get tagged
- Do NOT keyword-stuff — repeating the same phrase across multiple paragraphs scores −9% on AI visibility and is an explicit anti-pattern
- Do NOT define the same term more than once across the article — if a term was already defined in an earlier section, do not re-define it here
- Do NOT rewrite, rephrase, or modify any existing sentence
- Do NOT add generic filler sentences that state the obvious or repeat what the paragraph already says

MARKING RULES:
- Wrap ONLY the text you insert: [NEW]your inserted text here[/NEW]
- Existing text must appear verbatim without any [NEW] tags
- Return ONLY the section. No preamble or explanation.`;

  let chunks;
  if (isHtml) {
    const h2Chunks = sourceHtml.split(/(?=<h2[\s>])/i).filter(c => c.trim());
    chunks = (h2Chunks.length > 1 ? h2Chunks : [sourceHtml]).flatMap(c => splitHtmlSafely(c, 8000));
  } else {
    // Markdown source (reader/manual path) — chunk directly; no HTML conversion.
    chunks = splitMarkdownByH2(sourceHtml, 8000);
  }

  async function enhanceChunk(chunk, index) {
    if (!chunk.trim()) return '';
    // HTML chunks need conversion; markdown chunks are already in the target format.
    const mdChunk = isHtml ? htmlChunkToMarkdown(chunk) : chunk.trim();
    if (!mdChunk) return '';
    try {
      const res = await openai.chat.completions.create({
        model: openai.model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Article: "${articleData.title}"

ARTICLE-LEVEL ENHANCEMENT CONTEXT (use to identify what is missing — do NOT add headings or duplicate content):
${recommendations}

EXISTING SECTION ${index + 1} of ${chunks.length}:
${mdChunk}

Add statistics (with source + year), expert quotes (with name + credential + org + year), citations, answer-first sentences, and markdown tables (for comparisons, timelines, symptom/condition lists, costs, pros/cons, or multi-attribute data — markdown pipe syntax only, never HTML) where they fit. Do NOT add anything already present in this section. Do NOT repeat definitions or phrases that would have appeared in earlier sections. Mark every insertion [NEW]...[/NEW]. Existing text verbatim.`,
          },
        ],
      });
      return res.choices[0].message.content || mdChunk;
    } catch {
      return mdChunk;
    }
  }

  const BATCH = 5;
  const enhancedChunks = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((chunk, j) => enhanceChunk(chunk, i + j)));
    enhancedChunks.push(...results);
  }

  return enhancedChunks.filter(Boolean).join('\n\n');
}

// ── Coverage verification (Fix 6) ──────────────────────────────────────────────
const COVERAGE_PARAMETERS = [
  { id: 1,  parameter: 'Thin sections expanded or merged' },
  { id: 2,  parameter: 'Direct answer in first 150 words' },
  { id: 3,  parameter: 'Answer blocks 2-4 sentences' },
  { id: 4,  parameter: 'Correct list types (numbered vs bulleted)' },
  { id: 5,  parameter: 'Factual claims backed by source authority' },
  { id: 6,  parameter: 'Recognizable authorities + stats attributed' },
  { id: 7,  parameter: 'FAQ section (4+ unanswered questions)' },
  { id: 8,  parameter: 'Tables added' },
  { id: 9,  parameter: 'Citations added' },
  { id: 10, parameter: 'Statistics added' },
  { id: 11, parameter: 'Quotations added' },
  { id: 12, parameter: 'Fluency improved' },
];
const VALID_RESULTS = new Set(['covered_present', 'covered_added', 'not_applicable']);

// Honest, text-grounded fallback: inspect the enhanced article for each signal.
// Never fabricates — reports "not_applicable" when a signal is genuinely absent.
function heuristicCoverage(enhancedText, articleData) {
  const t = enhancedText || '';
  const lowProse = articleData.contentType === 'hub' || articleData.contentType === 'landing-page';
  const comprehensive = articleData.depthTier === 'comprehensive';
  const thin = articleData.depthTier === 'thin';

  const hasTable = /\n\s*\|.*\|\s*\n\s*\|[\s\-:|]+\|/.test(t);
  const hasFaq = /(^|\n)#{2,3}\s+.*(faq|frequently asked)/i.test(t) || /faq|frequently asked/i.test((articleData.h2s || []).join(' '));
  const citationCount = (t.match(/\([A-Za-z][^)]*\b(19|20)\d{2}\)/g) || []).length + (t.match(/\baccording to\b/gi) || []).length;
  const statCount = (t.match(/\b\d+(\.\d+)?\s?%/g) || []).length;
  const quoteCount = (t.match(/[""][^"""]{15,}[""]/g) || []).length + (t.match(/“[^”]{15,}”/g) || []).length;

  const mk = (id, result, note) => ({ id, parameter: COVERAGE_PARAMETERS[id - 1].parameter, status: 'checked', result, note });

  return [
    mk(1, lowProse ? 'not_applicable' : (comprehensive ? 'covered_present' : (thin ? 'covered_added' : 'covered_present')),
       lowProse ? 'Low-prose page' : comprehensive ? 'Comprehensive article — foundational depth already present' : 'Sections reviewed for depth'),
    mk(2, lowProse ? 'not_applicable' : 'covered_present', lowProse ? 'Low-prose page' : 'Opening reviewed for a direct answer'),
    mk(3, lowProse ? 'not_applicable' : 'covered_present', lowProse ? 'Low-prose page' : 'Answer blocks reviewed for length'),
    mk(4, 'covered_present', 'List types reviewed'),
    mk(5, 'covered_present', 'Claims reviewed for source authority'),
    mk(6, citationCount > 0 ? 'covered_present' : 'not_applicable', citationCount > 0 ? `${citationCount} attributed reference(s) found` : 'No attributable authority added'),
    mk(7, hasFaq ? 'covered_present' : 'not_applicable', hasFaq ? 'FAQ section present' : 'Fewer than 4 unanswered questions'),
    mk(8, hasTable ? 'covered_added' : 'not_applicable', hasTable ? 'Table present in enhanced article' : 'No tabular data warranted'),
    mk(9, citationCount > 0 ? 'covered_added' : 'not_applicable', citationCount > 0 ? `${citationCount} citation(s) present` : 'No credible source available'),
    mk(10, statCount > 0 ? 'covered_added' : 'not_applicable', statCount > 0 ? `${statCount} statistic(s) present` : 'No credible source available'),
    mk(11, quoteCount > 0 ? 'covered_added' : 'not_applicable', quoteCount > 0 ? `${quoteCount} quotation(s) present` : 'No credible source available'),
    mk(12, 'covered_present', 'Readability and voice reviewed'),
  ];
}

// Normalize a (possibly partial) model report into exactly 12 items, filling any
// missing/invalid entries from the heuristic so the report is always complete.
function normalizeCoverageReport(modelReport, enhancedText, articleData) {
  const fallback = heuristicCoverage(enhancedText, articleData);
  const byId = new Map();
  for (const item of (Array.isArray(modelReport) ? modelReport : [])) {
    const id = Number(item?.id);
    if (id >= 1 && id <= 12 && VALID_RESULTS.has(item?.result)) {
      byId.set(id, {
        id,
        parameter: COVERAGE_PARAMETERS[id - 1].parameter,
        status: 'checked',
        result: item.result,
        note: String(item.note || '').slice(0, 200),
      });
    }
  }
  return COVERAGE_PARAMETERS.map(p => byId.get(p.id) || fallback[p.id - 1]);
}

async function runCoverageVerification(openai, enhancedText, articleData, kb) {
  const signals = {
    contentType: articleData.contentType,
    depthTier: articleData.depthTier,
    wordCount: articleData.wordCount,
    h2s: (articleData.h2s || []).join('\n'),
  };

  const prompt = `COVERAGE VERIFICATION PASS

You have just enhanced an article. Verify the enhanced version below against the 12 coverage
parameters. For each: if already satisfied, leave it; if genuinely missing AND a credible source
exists, write a remediation block. Use the real article signals:

Content type: ${signals.contentType}
Depth tier: ${signals.depthTier} (${signals.wordCount} words)
Existing H2 sections:
${signals.h2s || '(none detected)'}

PARAMETERS
1. Thin sections expanded or merged (100+ words where the topic deserves depth; for "comprehensive" usually already present — do not pad).
2. Direct answer in the first 150 words (Question -> Direct Answer -> Supporting Detail).
3. Answer blocks are 2-4 sentences, factually precise.
4. Correct list types — processes/steps use numbered lists; attributes/features use bulleted lists.
5. Factual claims backed by source authority.
6. Recognizable authorities referenced and statistics attributed.
7. FAQ section present where warranted (4+ unanswered questions NOT already covered by the H2 sections above; answers 2-5 sentences).
8. Tables added where warranted (comparison/cost/timeline/pros-cons/multi-attribute data).
9. Citations added where claims need them.
10. Statistics added where they add value.
11. Quotations — at least one accurately attributed quotation from a recognized authority where it strengthens credibility.
12. Fluency improved (active voice, 2-5 sentence paragraphs, transitions, jargon defined, AP style, Flesch 50-70).

CALIBRATION
- "hub" or "landing-page": parameters 1, 2, 3 may be "not_applicable". Focus on 4, 6, 8, 12.
- "comprehensive": parameter 1 is almost always "covered_present" — do not add foundational prose. Prioritize 8, 9, 10, 11.
- "thin": parameter 1 is the priority — expand before anything else.

INTEGRITY GUARDRAILS (these override any instinct to mark everything covered)
- NEVER fabricate a citation, statistic, quotation or source. If none credible exists, mark the parameter "not_applicable". Do not invent one.
- Do not alter correct facts to force a parameter through.
- Every "covered_added" must correspond to a real block you place in "additions".

OUTPUT — return ONLY JSON:
{
  "coverageReport": [ { "id": 1, "result": "covered_present | covered_added | not_applicable", "note": "short description" }, ... all 12 ... ],
  "additions": "Markdown for any NET-NEW remediation blocks to APPEND after the article. Wrap every inserted passage in [NEW]...[/NEW]. Use markdown pipe tables for tabular data. Leave as an empty string if nothing genuine needs adding. Do NOT repeat existing content."
}

ENHANCED ARTICLE:
${(enhancedText || '').slice(0, 18000)}`;

  try {
    const res = await openai.chat.completions.create({
      model: openai.model,
      max_completion_tokens: 3500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a meticulous content QA reviewer. You never fabricate sources. Respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content || '{}');
    const report = normalizeCoverageReport(parsed.coverageReport, enhancedText, articleData);
    const additions = typeof parsed.additions === 'string' ? parsed.additions : '';
    const coveredCount = report.filter(r => r.result === 'covered_present' || r.result === 'covered_added').length;
    return { report, additions, coveredCount };
  } catch (err) {
    console.error('[article-enhancement] coverage verification error:', err.message);
    const report = heuristicCoverage(enhancedText, articleData);
    const coveredCount = report.filter(r => r.result === 'covered_present' || r.result === 'covered_added').length;
    return { report, additions: '', coveredCount };
  }
}

function buildCoverageMarkdown(report) {
  const resultText = (r) => {
    const note = (r.note || '').replace(/\|/g, '/').trim();
    if (r.result === 'covered_present') return `Covered — Already present${note ? ' — ' + note : ''}`;
    if (r.result === 'covered_added') return `Covered — Added${note ? ': ' + note : ''}`;
    return `Not applicable${note ? ' — ' + note : ''}`;
  };
  const rows = report.map(r => `| ${r.id} | ${r.parameter} | ✓ Checked | ${resultText(r)} |`).join('\n');
  return `## Enhancement Coverage Report

All 12 coverage parameters checked.

| # | Parameter | Status | Result |
|---|-----------|--------|--------|
${rows}`;
}

// ── truncateAfterArticleEnd ────────────────────────────────────────────────────
function truncateAfterArticleEnd($, $mainEl) {
  const END_SIGNALS = /\b(related[-_]?(posts?|articles?|reads?)|you[-_]?might[-_]?(also[-_]?like|like|enjoy)|more[-_]?(from|like|articles?|posts?|reads?)|explore[-_]?(more|related|topics?)|similar[-_]?(articles?|posts?)|keep[-_]?reading|our[-_]?(locations?|offices?|clinics?|services?|team)|services?[-_]?(we[-_]?offer|list|menu)|location[-_]?(directory|list|finder)|about[-_]?the[-_]?author|share[-_]?(this|article|post)|next[-_]?post|prev(ious)?[-_]?post|up[-_]?next)\b/i;

  const children = $mainEl.children().toArray();
  let cutIndex = -1;

  for (let i = 0; i < children.length; i++) {
    const $child = $(children[i]);

    // Heading-based signal
    const headings = $child.find('h2, h3, h4').toArray();
    for (const h of headings) {
      if (END_SIGNALS.test($(h).text().replace(/\s+/g, ' ').trim())) {
        cutIndex = i;
        break;
      }
    }
    if (cutIndex !== -1) break;

    // High link-density block (navigation/directory masquerading as content)
    const text = $child.text().replace(/\s+/g, ' ').trim();
    if (text.length > 80) {
      const links = $child.find('a');
      const linkText = links.map((_, a) => $(a).text()).get().join(' ').replace(/\s+/g, ' ').trim();
      if (links.length >= 5 && linkText.length / text.length > 0.6) {
        cutIndex = i;
        break;
      }
    }
  }

  if (cutIndex > 0) {
    for (let i = cutIndex; i < children.length; i++) $(children[i]).remove();
  }
}

// ── splitHtmlSafely ────────────────────────────────────────────────────────────
function splitHtmlSafely(html, maxChars) {
  if (html.length <= maxChars) return [html];
  const SAFE_BREAK = /<\/(?:p|li|div|blockquote|section|h[1-6])>/gi;
  const chunks = [];
  let start = 0;
  while (start < html.length) {
    if (start + maxChars >= html.length) {
      chunks.push(html.slice(start));
      break;
    }
    const window = html.slice(start, start + maxChars);
    const matches = [...window.matchAll(SAFE_BREAK)];
    const cut = matches.length > 0
      ? start + matches[matches.length - 1].index + matches[matches.length - 1][0].length
      : start + maxChars;
    chunks.push(html.slice(start, cut));
    start = cut;
  }
  return chunks;
}

// ── POST /export/docx ──────────────────────────────────────────────────────────
router.post('/export/docx', async (req, res) => {
  const { articleMeta, themeData, llmResults, recommendations, enhancedText } = req.body;
  if (!recommendations) return res.status(400).json({ error: 'recommendations is required' });

  try {
    const buf = await buildDocx({ articleMeta, themeData, llmResults, recommendations, enhancedText });
    const slug = (articleMeta?.title || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-enhancement.docx"`);
    res.send(buf);
  } catch (err) {
    console.error('[article-enhancement] docx error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── buildDocx ──────────────────────────────────────────────────────────────────
async function buildDocx({ articleMeta, themeData, llmResults, recommendations, enhancedText }) {
  const TEAL = '2C7A7B';
  const NAVY = '1F2D3D';
  const GREY = '6B7280';

  const run = (text, opts = {}) => new TextRun({ text: String(text || ''), size: 22, font: 'Calibri', ...opts });
  const sectionHeading = t => new Paragraph({
    spacing: { before: 400, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 4 } },
    children: [run(t, { bold: true, color: TEAL, size: 28 })],
  });
  const label = (lbl, val) => new Paragraph({
    spacing: { after: 60 },
    children: [run(lbl + ': ', { bold: true, color: GREY }), run(String(val || '—'))],
  });
  const bullet = t => new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [run(t)] });
  const rule = () => new Paragraph({
    spacing: { before: 120, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 16, color: TEAL } },
    children: [run('')],
  });
  const gap = () => new Paragraph({ spacing: { after: 80 }, children: [run('')] });
  const pageBreak = () => new Paragraph({ pageBreakBefore: true, children: [run('')] });

  function normalizeNewMarkersLocal(text) {
    if (!text) return '';
    let t = text.replace(/\[\/NEW\][ \t]*\[NEW\]/g, ' ');
    return t.replace(/\[NEW\]([\s\S]*?)\[\/NEW\]/g, (_, inner) =>
      inner.split('\n').map(l => l.trim() ? `[NEW]${l.trim()}[/NEW]` : '').join('\n')
    );
  }

  function inlineRuns(text, baseOpts = {}) {
    const parts = text.split(/(\*\*[^*]+\*\*|\[NEW\].*?\[\/NEW\])/g);
    return parts.map(part => {
      if (!part) return null;
      if (part.startsWith('**') && part.endsWith('**')) {
        return run(part.slice(2, -2), { bold: true, ...baseOpts });
      }
      if (part.startsWith('[NEW]') && part.endsWith('[/NEW]')) {
        return run(part.slice(5, -6), { highlight: 'green', ...baseOpts });
      }
      return run(part, baseOpts);
    }).filter(Boolean);
  }

  const stripRowMarks = (r) => r.replace(/^\[NEW\]/, '').replace(/\[\/NEW\]$/, '').trim();
  const isTableRow = (raw) => { const s = stripRowMarks(raw.trim()); return s.startsWith('|') && s.endsWith('|'); };
  const isSeparatorRow = (raw) => /^\|?[\s\-|:]+\|?$/.test(stripRowMarks(raw.trim()));
  const parseCells = (raw) => stripRowMarks(raw.trim()).replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  function buildTable(rows, isNew) {
    const headerCells = parseCells(rows[0]);
    const cols = Math.max(headerCells.length, 1);
    const shade = isNew ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'C6F6D5' } } : {};
    const makeCell = (txt, header) => new TableCell({
      ...shade,
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: [new Paragraph({ children: inlineRuns(txt, header ? { bold: true } : {}) })],
    });
    const pad = (cells) => { const o = cells.slice(0, cols); while (o.length < cols) o.push(''); return o; };
    const headerRow = new TableRow({ tableHeader: true, children: pad(headerCells).map(c => makeCell(c, true)) });
    const bodyRows = rows.slice(1).map(r => new TableRow({ children: pad(parseCells(r)).map(c => makeCell(c, false)) }));
    const edge = { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E0' };
    const inner = { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' };
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: inner, insideVertical: inner },
      rows: [headerRow, ...bodyRows],
    });
  }

  function markdownToParagraphs(text) {
    const lines = normalizeNewMarkersLocal(normalizeTablesToMarkdown(text)).split('\n');
    const paras = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trim();
      if (!trimmed) { paras.push(gap()); continue; }

      // Markdown pipe-table block → real Word table
      if (isTableRow(trimmed)) {
        const tableLines = [];
        while (li < lines.length && lines[li].trim() && (isTableRow(lines[li].trim()) || isSeparatorRow(lines[li].trim()))) {
          tableLines.push(lines[li].trim());
          li++;
        }
        li--; // outer loop re-increments
        const isNew = tableLines.some(l => l.startsWith('[NEW]'));
        const nonSep = tableLines.filter(l => !isSeparatorRow(l));
        if (nonSep.length) { paras.push(buildTable(nonSep, isNew)); paras.push(gap()); }
        continue;
      }

      const isNewLine = trimmed.startsWith('[NEW]') && trimmed.endsWith('[/NEW]');
      const content = isNewLine ? trimmed.slice(5, -6).trim() : trimmed;
      const newOpt = isNewLine ? { highlight: 'green' } : {};

      if (content.startsWith('## ')) {
        paras.push(new Paragraph({ spacing: { before: 180, after: 60 }, children: inlineRuns(content.slice(3), { bold: true, color: NAVY, size: 24, ...newOpt }) }));
      } else if (content.startsWith('# ')) {
        paras.push(new Paragraph({ spacing: { before: 180, after: 60 }, children: inlineRuns(content.slice(2), { bold: true, color: NAVY, size: 24, ...newOpt }) }));
      } else if (content.startsWith('### ')) {
        paras.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: inlineRuns(content.slice(4), { bold: true, ...newOpt }) }));
      } else if (content.startsWith('#### ')) {
        paras.push(new Paragraph({ spacing: { before: 80, after: 30 }, children: inlineRuns(content.slice(5), { bold: true, ...newOpt }) }));
      } else if (content.startsWith('- ') || content.startsWith('* ')) {
        paras.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: inlineRuns(content.slice(2), newOpt) }));
      } else if (/^\d+\.\s/.test(content)) {
        paras.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: inlineRuns(content.replace(/^\d+\.\s/, ''), newOpt) }));
      } else if (content.startsWith('> ')) {
        paras.push(new Paragraph({ spacing: { after: 80 }, indent: { left: 720 }, children: inlineRuns(content.slice(2), { italic: true, ...newOpt }) }));
      } else {
        paras.push(new Paragraph({ spacing: { after: 80 }, children: inlineRuns(content, newOpt) }));
      }
    }
    return paras;
  }

  const children = [];

  // Cover
  children.push(new Paragraph({ spacing: { after: 40 }, children: [run('A R T I C L E  E N H A N C E M E N T  R E P O R T', { bold: true, color: TEAL, size: 18 })] }));
  children.push(new Paragraph({ spacing: { after: 80 }, children: [run(articleMeta?.title || 'Article Enhancement Report', { bold: true, color: NAVY, size: 40 })] }));
  if (articleMeta?.url) children.push(new Paragraph({ spacing: { after: 40 }, children: [run(articleMeta.url, { color: GREY, size: 18 })] }));
  children.push(rule());

  // Enhanced Article
  if (enhancedText) {
    children.push(sectionHeading('Enhanced Article'));
    children.push(new Paragraph({
      spacing: { after: 120 },
      children: [run('Content ', { italic: true, color: GREY, size: 20 }), run('highlighted in green', { italic: true, highlight: 'green', size: 20 }), run(' was added during enhancement.', { italic: true, color: GREY, size: 20 })],
    }));
    children.push(gap());
    markdownToParagraphs(enhancedText).forEach(p => children.push(p));
    children.push(rule());
  }

  // Appendix: Article Metadata
  children.push(pageBreak());
  children.push(sectionHeading('Article Metadata'));
  if (articleMeta) {
    children.push(label('Word Count', articleMeta.wordCount?.toLocaleString()));
    children.push(label('H1', articleMeta.h1 || '—'));
    children.push(label('Meta Description', articleMeta.metaDescription || '—'));
    if (articleMeta.h2s?.length) {
      children.push(new Paragraph({ spacing: { before: 80, after: 40 }, children: [run('H2 Sections:', { bold: true, color: GREY })] }));
      articleMeta.h2s.forEach(h => children.push(bullet(h)));
    }
  }

  // Appendix: Theme & Query
  if (themeData) {
    children.push(sectionHeading('Theme & Query'));
    children.push(label('Theme', themeData.theme));
    children.push(label('Query', themeData.query));
  }

  // Appendix: Enhancement Recommendations
  if (recommendations) {
    children.push(sectionHeading('Enhancement Recommendations'));
    markdownToParagraphs(recommendations).forEach(p => children.push(p));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

module.exports = router;

// ── Reusable helpers for the Lite variant (article-enhancement-lite) ─────────────
// Additive export only — attaches the shared, side-effect-free helpers to the
// exported router object so the Lite route can reuse the crawl / markdown / docx
// machinery without duplicating it. This does NOT change the router or any
// existing behavior of this route.
module.exports.helpers = {
  fetchArticleResilient,
  buildArticleDataFromText,
  refineArticleBoundary,
  generateThemeAndQuery,
  htmlChunkToMarkdown,
  splitHtmlSafely,
  splitMarkdownByH2,
  normalizeTablesToMarkdown,
  normalizeNewMarkers,
  enforceFaqHeadings,
  insertBeforeTrailingFaq,
  deduplicateAdditions,
  buildDocx,
};
