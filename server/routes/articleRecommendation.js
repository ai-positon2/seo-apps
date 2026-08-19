const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const OpenAI = require('openai');
const { searchGoogle } = require('../services/googleSearch');
const { scrapeUrlsDetailed } = require('../services/scraper');
const { loadKBContext } = require('../services/kbLoader');
const runsStore = require('../services/runsStore');

// In-memory session store (token → params, expires in 5 min)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// POST /init — store keyword + optional KB params, return token
router.post('/init', (req, res) => {
  const { keyword, client, feedbackKbIds } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });

  const token = generateToken();
  sessions.set(token, { keyword: keyword.trim(), client: client || null, feedbackKbIds: feedbackKbIds || null });
  setTimeout(() => sessions.delete(token), 300000); // 5-min TTL
  res.json({ token });
});

// GET /stream/:token — SSE stream
router.get('/stream/:token', async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  sessions.delete(req.params.token);

  const { keyword, client, feedbackKbIds } = session;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });

  const emit = (event, data) => {
    if (isClosed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { isClosed = true; }
  };

  try {
    // ── Step 1: Google Search ────────────────────────────────────────────
    emit('step', { id: 'search', status: 'active', message: `Searching Google US for "${keyword}"…` });

    const searchData = await searchGoogle(keyword);
    const top10 = searchData.results.slice(0, 10);

    emit('step', { id: 'search', status: 'done', message: `Found ${top10.length} ranking pages` });
    emit('urls', { urls: top10 });

    // ── Step 2: Scrape pages ─────────────────────────────────────────────
    emit('step', { id: 'scrape', status: 'active', message: `Scraping pages (0/${top10.length})…` });

    let doneCount = 0;
    const scraped = await scrapeUrlsDetailed(
      top10.map(u => u.url),
      ({ index, total, url, status, error }) => {
        if (status === 'done' || status === 'error') {
          doneCount++;
          emit('scrape_progress', { index, total, url, status, error: error || null, done: doneCount });
          emit('step', { id: 'scrape', status: 'active', message: `Scraping pages (${doneCount}/${total})…` });
        }
      }
    );

    const successful = scraped.filter(p => p.success);
    emit('step', { id: 'scrape', status: 'done', message: `Scraped ${successful.length}/${top10.length} pages successfully` });

    if (successful.length < 5) {
      emit('warning', { message: `Only ${successful.length} of ${top10.length} pages could be scraped. Brief will be based on available data.` });
    }

    // ── Step 3: GPT Analysis ─────────────────────────────────────────────
    emit('step', { id: 'analysis', status: 'active', message: 'Analyzing content patterns across pages…' });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Build compact content summary for analysis call
    const contentSummary = scraped.map((page, i) => {
      if (!page.success) return `URL ${i + 1}: ${page.url}\nStatus: failed (${page.error})\n`;
      return [
        `URL ${i + 1}: ${page.url}`,
        `Title: ${page.title}`,
        `H1: ${page.h1 || 'none'}`,
        `H2s: ${page.h2s.slice(0, 10).join(' | ') || 'none'}`,
        `H3s: ${page.h3s.slice(0, 8).join(' | ') || 'none'}`,
        `H4s: ${page.h4s.slice(0, 5).join(' | ') || 'none'}`,
        `FAQs detected: ${page.faqs.slice(0, 5).join(' | ') || 'none'}`,
        `Body excerpt: ${page.bodyText.substring(0, 1500)}`,
        ''
      ].join('\n');
    }).join('\n---\n');

    const analysisCompletion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are an expert SEO content strategist. Analyze the provided page data and return structured JSON insights. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: `Primary keyword: "${keyword}"

Here is the content extracted from the top ${scraped.length} ranking pages:

${contentSummary}

Analyze these pages and return a JSON object with these exact fields:
{
  "commonH2Topics": ["list of H2 topics appearing across 3+ pages"],
  "commonH3Topics": ["list of H3 subtopics appearing across 2+ pages"],
  "recurringAngles": ["list of recurring content angles, perspectives, or approaches"],
  "faqPatterns": ["list of FAQ questions or question patterns found across pages"],
  "contentGaps": ["topics or angles that are missing or underserved across the top pages"],
  "nlpKeywords": ["semantic and NLP-related keywords used frequently across pages"],
  "structuralPatterns": ["notable structural patterns like numbered lists, comparison tables, step-by-step guides"]
}`
        }
      ]
    });

    const analysis = JSON.parse(analysisCompletion.choices[0].message.content);
    emit('step', { id: 'analysis', status: 'done', message: 'Content patterns identified' });

    // ── Step 4: Brief Generation ─────────────────────────────────────────
    emit('step', { id: 'brief', status: 'active', message: 'Building content brief…' });

    // Load KB context (all optional — warn if any missing, never block)
    let kbContext = null;
    if (client) {
      kbContext = await loadKBContext('article-recommendation', client, feedbackKbIds || null);
      if (kbContext.skipped.length > 0) {
        emit('warning', {
          message: `Some knowledge base context could not be loaded: ${kbContext.skipped.join(', ')}. Brief will continue with available context.`,
          type: 'kb'
        });
      }
      console.log(`[article-recommendation] KB confidence: ${kbContext.confidence}, loaded: ${kbContext.loaded.length}, skipped: ${kbContext.skipped.length}`);
    }

    const sourceUrls = top10.map((u, i) => `- [${i + 1}] ${u.url}`).join('\n');

    // Shared brief structure/rules template — reused for both the initial
    // generation and the realignment pass below, so the two never drift apart.
    const briefStructurePrompt = (extraNote = '') =>
      `You are an expert SEO content strategist. Based on the analysis of the top 10 ranking pages provided, generate a detailed article content brief. The brief must follow this exact structure:`
      + (kbContext?.systemPromptSuffix || '') + extraNote + `

# H1: [Recommended article title]

## H2: [Section Name]
**Writing Instructions:**
- Bullet point instructions for the writer covering what to include in this section

**Keywords:** keyword1, keyword2, keyword3

### H3: [Subsection Name]
- Sub-bullet guidance for this subsection

**[Visual Opportunity: Describe any recommended table, chart, comparison, or image for this section]**

Repeat this H2 pattern for all recommended sections (aim for 8–12 H2 sections total).

---

## H2: Frequently Asked Questions
- List 5–8 FAQ questions recommended based on patterns found across the top 10 pages

**Reference Blog URLs:**
${sourceUrls}

Rules:
- Every H2 must include Writing Instructions and Keywords
- Add H3 subsections wherever the top pages show consistent sub-topics
- Flag Visual Opportunities wherever a table, comparison, or diagram would strengthen the section
- Base all recommendations strictly on patterns found in the top 10 pages`;

    const briefCompletion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      max_completion_tokens: 4000,
      messages: [
        { role: 'system', content: briefStructurePrompt() },
        {
          role: 'user',
          content: `Primary keyword: "${keyword}"

Analysis of top ${scraped.length} ranking pages:

Common H2 topics: ${(analysis.commonH2Topics || []).join(', ')}
Common H3 subtopics: ${(analysis.commonH3Topics || []).join(', ')}
Recurring angles: ${(analysis.recurringAngles || []).join(', ')}
FAQ patterns: ${(analysis.faqPatterns || []).join(', ')}
Content gaps: ${(analysis.contentGaps || []).join(', ')}
NLP keywords: ${(analysis.nlpKeywords || []).join(', ')}
Structural patterns: ${(analysis.structuralPatterns || []).join(', ')}

Generate the full content brief now.`
        }
      ]
    });

    let brief = briefCompletion.choices[0].message.content;
    emit('step', { id: 'brief', status: 'done', message: 'Content brief ready' });

    // ── Step 5: Theme alignment check ──────────────────────────────────
    emit('step', { id: 'alignment', status: 'active', message: 'Checking brief alignment with primary keyword theme…' });

    try {
      const alignmentRes = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an expert SEO editor performing a quality check. Always respond with valid JSON only.' },
          {
            role: 'user',
            content: `Primary keyword: "${keyword}"

Content brief to review:
${brief}

Judge whether every section of this brief stays tightly on-theme for the primary keyword "${keyword}" — each H2/H3 should be a direct facet of this keyword's topic, not a tangential subject that drifted in from a source page covering a different angle.

Return JSON: { "aligned": true|false, "reason": "one-sentence explanation" }`
          }
        ]
      });

      const alignment = JSON.parse(alignmentRes.choices[0].message.content);

      if (alignment.aligned === false) {
        emit('step', { id: 'alignment', status: 'active', message: `Realigning brief with "${keyword}" (${alignment.reason || 'drifted off-theme'})…` });

        const realignCompletion = await openai.chat.completions.create({
          model: 'gpt-5.4-mini',
          max_completion_tokens: 4000,
          messages: [
            {
              role: 'system',
              content: briefStructurePrompt(`\n\nA review pass flagged the previous version of this brief as drifting off-theme from "${keyword}" (reason: "${alignment.reason || 'not specified'}"). Revise it so every section ties back to "${keyword}" directly, using ONLY the scraped competitor content provided by the user as source material — do not invent new facts or statistics.`)
            },
            {
              role: 'user',
              content: `Primary keyword: "${keyword}"

Previous brief (flagged as off-theme):
${brief}

Scraped content from the top ranking pages (source material — ground all revisions in this):
${contentSummary}

Revise and return the FULL corrected content brief now, following the same structure rules, fully aligned with "${keyword}".`
            }
          ]
        });

        brief = realignCompletion.choices[0].message.content;
        emit('step', { id: 'alignment', status: 'done', message: 'Brief realigned with primary keyword theme' });
      } else {
        emit('step', { id: 'alignment', status: 'done', message: 'Brief confirmed aligned with primary keyword' });
      }
    } catch (err) {
      console.error('[article-recommendation] Alignment check error:', err.message);
      emit('step', { id: 'alignment', status: 'done', message: `Alignment check skipped (${err.message})` });
    }

    emit('result', { brief, sourceUrls: top10 });

    runsStore.saveRun({
      userId: req.user?.userId,
      toolId: 'article-recommendation',
      title: `Article Recommendation: ${keyword}`,
      input: { keyword, client },
      output: { brief, sourceUrls: top10 },
    });

  } catch (err) {
    console.error('[article-recommendation] Error:', err.message);
    emit('fail', { message: err.message });
  }

  emit('done', {});
  res.end();
});

module.exports = router;
