const OpenAI = require('openai');
const { searchGoogle } = require('./googleSearch');
const { scrapeUrlsDetailed } = require('./scraper');
const { loadKBContext } = require('./kbLoader');

// Roughly this many words of substance per H2, so an outline is never planned
// thinner than it can be written.
const WORDS_PER_SECTION = 200;
const MIN_SECTIONS = 4, MAX_SECTIONS = 12;
// Scraped body text carries some navigation noise, so the derived target is clamped.
const MIN_AUTO_WORDS = 600, MAX_AUTO_WORDS = 3000;
const countWords = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;
const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const sectionsFor = words => Math.min(MAX_SECTIONS, Math.max(MIN_SECTIONS, Math.round(words / WORDS_PER_SECTION)));

// Shared Article Recommendation pipeline for both modules.
// targetWords is optional: omit it for the original behaviour, pass a number to
// size the outline to it, or 'auto' to size it to the competitors that rank.
async function generateArticleBrief({ keyword, client, feedbackKbIds, targetWords }, emit = () => {}, deps = {}) {
    emit('step', { id: 'search', status: 'active', message: `Searching Google US for "${keyword}"…` });

    const searchData = await (deps.searchGoogle || searchGoogle)(keyword);
    const top10 = searchData.results.slice(0, 10);

    emit('step', { id: 'search', status: 'done', message: `Found ${top10.length} ranking pages` });
    emit('urls', { urls: top10 });

    // ── Step 2: Scrape pages ─────────────────────────────────────────────
    emit('step', { id: 'scrape', status: 'active', message: `Scraping pages (0/${top10.length})…` });

    let doneCount = 0;
    const scraped = await (deps.scrapeUrlsDetailed || scrapeUrlsDetailed)(
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

    const openai = deps.openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      kbContext = await (deps.loadKBContext || loadKBContext)('article-recommendation', client, feedbackKbIds || null);
      if (kbContext.skipped.length > 0) {
        emit('warning', {
          message: `Some knowledge base context could not be loaded: ${kbContext.skipped.join(', ')}. Brief will continue with available context.`,
          type: 'kb'
        });
      }
      console.log(`[article-recommendation] KB confidence: ${kbContext.confidence}, loaded: ${kbContext.loaded.length}, skipped: ${kbContext.skipped.length}`);
    }

    const sourceUrls = top10.map((u, i) => `- [${i + 1}] ${u.url}`).join('\n');

    // Resolve the length target. Callers that pass nothing keep the original prompt.
    let resolvedWords = null;
    if (targetWords === 'auto') {
      const lengths = successful.map(p => countWords(p.bodyText)).filter(Boolean);
      resolvedWords = lengths.length
        ? Math.min(MAX_AUTO_WORDS, Math.max(MIN_AUTO_WORDS, median(lengths)))
        : MIN_AUTO_WORDS;
      emit('step', { id: 'brief', status: 'active',
        message: `Sizing the brief to ${resolvedWords} words, the median length of the pages that rank…` });
    } else if (Number(targetWords) > 0) {
      resolvedWords = Math.round(Number(targetWords));
    }
    const sectionCount = resolvedWords ? sectionsFor(resolvedWords) : null;
    const lengthNote = resolvedWords
      ? `\n\nThis article has a target length of ${resolvedWords} words, so each H2 must carry roughly `
        + `${Math.round(resolvedWords / sectionCount)} words of substance. Fewer, deeper sections are better than `
        + `many thin ones: never plan a section that could not be written to that depth.`
      : '';
    // Replace the fixed section count rather than contradicting it further down the prompt.
    const sectionCountRule = resolvedWords
      ? `Repeat this H2 pattern for exactly ${sectionCount} H2 sections, not counting the Frequently Asked Questions section.`
      : 'Repeat this H2 pattern for all recommended sections (aim for 8–12 H2 sections total).';

    // Shared brief structure/rules template — reused for both the initial
    // generation and the realignment pass below, so the two never drift apart.
    const briefStructurePrompt = (extraNote = '') =>
      `You are an expert SEO content strategist. Based on the analysis of the top 10 ranking pages provided, generate a detailed article content brief. The brief must follow this exact structure:`
      + (kbContext?.systemPromptSuffix || '') + lengthNote + extraNote + `

# H1: [Recommended article title]

## H2: [Section Name]
**Writing Instructions:**
- Bullet point instructions for the writer covering what to include in this section

**Keywords:** keyword1, keyword2, keyword3

### H3: [Subsection Name]
- Sub-bullet guidance for this subsection

#### H4: [Sub-subsection Name, only where the top pages genuinely nest this deep]
- Sub-bullet guidance for this sub-subsection

**[Visual Opportunity: Describe any recommended table, chart, comparison, or image for this section]**

${sectionCountRule}

---

## H2: Frequently Asked Questions
- List 5–8 FAQ questions recommended based on patterns found across the top 10 pages
- Instruct the writer to give every question its own complete answer of roughly 40–80 words that answers directly in the first sentence

**Reference Blog URLs:**
${sourceUrls}

Rules:
- Every H2 must include Writing Instructions and Keywords
- Add H3 subsections wherever the top pages show consistent sub-topics, and H4 only where a sub-topic genuinely divides further
- Never skip a heading level: an H4 must sit under an H3, which must sit under an H2
- The Frequently Asked Questions section is mandatory and must always be present
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

    return { brief, sourceUrls: top10, targetWords: resolvedWords };
}

module.exports = { generateArticleBrief };
