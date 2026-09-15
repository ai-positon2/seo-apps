'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
// SSRF guard, shared with contentArchitect rather than reimplemented (see call site).
const { assertPublicHost } = require('../modules/contentArchitect/urlSafety');
const OpenAI = require('openai');
const { runContentEnhancementChecks } = require('../checks/contentEnhancementChecks');
const { searchGoogle } = require('../services/googleSearch');
const { scrapeUrlsDetailed } = require('../services/scraper');

const router = express.Router();
const PRIMARY_MODEL = 'gpt-5.4-mini';
const FALLBACK_MODEL = 'gpt-4o-mini';

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

function normalizeUrl(value) {
  if (!value || !value.trim()) return null;
  const withProtocol = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  return new URL(withProtocol).href;
}

async function fetchHtml(url) {
  const started = Date.now();
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ContentEnhancementBot/1.0)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  return {
    html: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
    status: response.status,
    finalUrl: response.request?.res?.responseUrl || url,
    fetchTimeMs: Date.now() - started,
  };
}

function stripNoiseText(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript, nav, header, footer, aside, iframe, svg').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function extractPassages(text, patterns, limit = 3) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 420);
  const passages = [];
  for (const sentence of sentences) {
    if (patterns.some(pattern => pattern.test(sentence))) {
      const score = [
        /\d+\.?\d*\s*%/.test(sentence) ? 8 : 0,
        /\d+\.?\d*\s*(to|-|–)\s*\d+\.?\d*/.test(sentence) ? 5 : 0,
        /preval/i.test(sentence) ? 4 : 0,
        /incidence/i.test(sentence) ? 3 : 0,
        /hypodontia|congenitally missing teeth|dental agenesis/i.test(sentence) ? 2 : 0,
      ].reduce((a, b) => a + b, 0);
      passages.push({ sentence, score });
    }
  }
  return passages
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.sentence);
}

async function enrichEvidenceResult(result, type) {
  try {
    const response = await axios.get(result.url, {
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ContentEnhancementBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
    });
    const text = stripNoiseText(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
    const patterns = type === 'statistics'
      ? [/\d+\.?\d*\s*%/, /\d+\.?\d*\s*(to|-|–)\s*\d+\.?\d*/, /preval/i, /incidence/i, /hypodontia/i, /missing teeth/i]
      : [/hypodontia/i, /missing teeth/i, /treatment/i, /cause/i, /diagnos/i];
    return {
      ...result,
      evidencePassages: extractPassages(text, patterns),
    };
  } catch {
    return { ...result, evidencePassages: [] };
  }
}

function compactFindings(findings) {
  return {
    meta: findings.meta,
    scores: findings.scores,
    signals: {
      h1s: findings.signals.h1s,
      h2s: findings.signals.h2s.slice(0, 20),
      h3s: findings.signals.h3s.slice(0, 20),
      faqs: findings.signals.faqs,
      schemaTypes: findings.signals.schemaTypes,
      authorText: findings.signals.authorText,
      reviewerText: findings.signals.reviewerText,
      credentials: findings.signals.credentials,
      dateSignals: findings.signals.dateSignals,
      authoritativeCitations: findings.signals.authoritativeCitations,
      tableCount: findings.signals.tableCount,
      directAnswerOpening: findings.signals.directAnswerOpening,
      takeawaySignal: findings.signals.takeawaySignal,
      statisticsCount: findings.signals.statisticsCount,
      expertQuoteCount: findings.signals.expertQuoteCount,
      internalLinks: findings.signals.internalLinks,
      entityCoverage: findings.signals.entityCoverage,
    },
    failedChecks: findings.checks.filter(c => c.status !== 'pass').map(c => ({
      id: c.id,
      category: c.category,
      name: c.name,
      severity: c.severity,
      detail: c.detail,
      recommendation: c.recommendation,
    })),
    topFixes: findings.recommendations.topFixes,
  };
}

function inferResearchTopic(findings, primaryKeyword, pageType) {
  const topic = primaryKeyword
    || findings.meta?.h1
    || findings.meta?.title
    || pageType
    || '';
  return cleanResearchTopic(topic);
}

function cleanResearchTopic(value) {
  let topic = String(value || '').replace(/\s+/g, ' ').trim();
  topic = topic
    .replace(/^(comprehensive|complete|ultimate|definitive|patient'?s?)\s+guide\s+to\s+/i, '')
    .replace(/^guide\s+to\s+/i, '')
    .replace(/\s*\|\s*.*$/, '')
    .replace(/\s+-\s+.*$/, '');
  if (topic.includes(':')) topic = topic.split(':')[0].trim();
  topic = topic
    .replace(/\b(benefits|application|cost|costs|procedure|treatment|complete guide|comprehensive guide)\b/gi, '')
    .replace(/[,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return topic || String(value || '').replace(/\s+/g, ' ').trim();
}

async function researchTopRankingContent(topic) {
  if (!topic) return null;

  const cleanTopic = topic.replace(/"/g, '').trim();
  const queryTopic = cleanTopic.length <= 80 ? `"${cleanTopic}"` : cleanTopic;
  const searchQuery = `${queryTopic} guide article blog -site:sciencedirect.com -site:pubmed.ncbi.nlm.nih.gov -site:ncbi.nlm.nih.gov -site:researchgate.net`;
  const searchData = await searchGoogle(searchQuery);
  const top10 = (searchData.results || []).slice(0, 10);
  const scraped = await scrapeUrlsDetailed(top10.map(r => r.url));
  const successful = scraped.filter(page => page.success);
  const profile = getTopicProfile(cleanTopic);
  const evidenceQueries = [
    {
      type: 'statistics',
      query: profile.kind === 'dental_sealants'
        ? `${queryTopic} effectiveness cavities children CDC ADA study`
        : `${queryTopic} prevalence statistics study`,
      useFor: profile.kind === 'dental_sealants'
        ? 'Find effectiveness, cavity-prevention, and age/tooth-surface data to cite.'
        : 'Find specific prevalence, incidence, risk, or treatment outcome data to cite.',
    },
    {
      type: 'authoritative_citations',
      query: profile.kind === 'dental_sealants'
        ? `${queryTopic} CDC ADA dental association`
        : `${queryTopic} NIH NIDCR ADA dental association`,
      useFor: 'Find authoritative sources the content team can cite.',
    },
    {
      type: 'expert_quote_angles',
      query: profile.kind === 'dental_sealants'
        ? `${queryTopic} dentist explains benefits cost application`
        : `${queryTopic} dentist explains causes treatment`,
      useFor: 'Find common expert explanation angles and misconceptions to ask a credentialed reviewer about.',
    },
  ];
  const evidenceResults = [];
  for (const evidenceQuery of evidenceQueries) {
    try {
      const result = await searchGoogle(evidenceQuery.query);
      const initialResults = (result.results || []).slice(0, 5);
      const enrichedTopResults = await Promise.all(
        initialResults.slice(0, 3).map(item => enrichEvidenceResult(item, evidenceQuery.type))
      );
      const enrichedByUrl = new Map(enrichedTopResults.map(item => [item.url, item]));
      evidenceResults.push({
        ...evidenceQuery,
        results: initialResults.map(item => enrichedByUrl.get(item.url) || item),
      });
    } catch (err) {
      evidenceResults.push({
        ...evidenceQuery,
        error: err.message,
        results: [],
      });
    }
  }

  return {
    topic,
    searchQuery,
    evidenceQueries: evidenceResults,
    searchResults: top10,
    scraped,
    successfulCount: successful.length,
    competitorSummary: scraped.map((page, index) => {
      const searchResult = top10[index] || {};
      if (!page.success) {
        return {
          position: index + 1,
          title: searchResult.title || '',
          url: page.url,
          success: false,
          error: page.error,
        };
      }

      return {
        position: index + 1,
        title: page.title || searchResult.title || '',
        url: page.url,
        h1: page.h1 || '',
        h2s: (page.h2s || []).slice(0, 12),
        h3s: (page.h3s || []).slice(0, 10),
        faqs: (page.faqs || []).slice(0, 8),
        excerpt: (page.bodyText || '').substring(0, 1200),
        success: true,
      };
    }),
  };
}

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function sourceTypeFor(url) {
  const host = hostname(url);
  if (host.includes('nih.gov') || host.includes('ncbi.nlm.nih.gov') || host.includes('pubmed.ncbi.nlm.nih.gov')) return 'NIH / PubMed';
  if (host.includes('nidcr.nih.gov')) return 'NIDCR';
  if (host.includes('ada.org')) return 'ADA';
  if (host.endsWith('.gov')) return 'Government health website';
  if (host.includes('biomedcentral') || host.includes('springer') || host.includes('journal') || host.includes('pmc.ncbi')) return 'Peer-reviewed literature';
  if (host.includes('dental')) return 'Dental education website';
  return 'Research source';
}

function flattenEvidenceResults(research, type = null) {
  return (research?.evidenceQueries || [])
    .filter(group => !type || group.type === type)
    .flatMap(group => (group.results || []).map(result => ({ ...result, evidenceType: group.type, useFor: group.useFor })))
    .filter(result => result.url);
}

function evidenceRelevanceScore(source, topic) {
  const haystack = [
    source?.title,
    source?.snippet,
    ...(source?.evidencePassages || []),
  ].join(' ').toLowerCase();
  const cleanTopic = String(topic || '').toLowerCase();
  let score = 0;
  for (const token of cleanTopic.split(/\s+/).filter(t => t.length > 3)) {
    if (haystack.includes(token)) score += 4;
  }
  if (/hypodontia/i.test(haystack)) score += 12;
  if (/congenitally missing teeth|tooth agenesis|dental agenesis|missing teeth/i.test(haystack)) score += 10;
  if (source?.evidencePassages?.some(p => /\d+\.?\d*\s*%/.test(p))) score += 10;
  if (/supernumerary teeth/i.test(haystack) && !/hypodontia|missing teeth|tooth agenesis|dental agenesis/i.test(haystack)) score -= 30;
  return score;
}

function pickEvidenceSource(research, type, fallbackIndex = 0, topic = '') {
  const sources = flattenEvidenceResults(research, type);
  const scored = sources.map(source => {
    const host = hostname(source.url);
    const score = [
      evidenceRelevanceScore(source, topic),
      host.includes('nih.gov') ? 10 : 0,
      host.includes('ncbi.nlm.nih.gov') || host.includes('pubmed') ? 9 : 0,
      host.includes('ada.org') ? 8 : 0,
      source.evidencePassages?.length ? 3 : 0,
    ].reduce((a, b) => a + b, 0);
    return { source, score };
  }).sort((a, b) => b.score - a.score);
  return scored[fallbackIndex]?.source || sources[fallbackIndex] || null;
}

function topicLabel(topic, findings) {
  return topic || findings?.meta?.primaryKeyword || findings?.meta?.h1 || findings?.meta?.title || 'this topic';
}

function displayTopic(topic) {
  const clean = String(topic || '').replace(/\s+/g, ' ').trim();
  if (/hypodontia/i.test(clean) && /missing teeth/i.test(clean)) return 'Hypodontia (congenitally missing teeth)';
  if (/dental sealants?/i.test(clean)) return 'Dental sealants';
  return clean || 'this topic';
}

function getTopicProfile(topic) {
  const clean = String(topic || '').toLowerCase();
  if (/dental sealants?/.test(clean)) {
    return {
      kind: 'dental_sealants',
      schemaType: 'MedicalWebPage',
      directAnswer: 'Dental sealants are thin protective coatings painted onto the chewing surfaces of back teeth to help block food and bacteria from settling into deep grooves. They are most commonly recommended for children and teens once permanent molars come in, but some adults can benefit too. A dentist can usually apply sealants in one quick visit without drilling or numbing.',
      priorityTable: {
        title: 'Dental Sealants: Benefits, Application, Cost, and Best-Fit Patients',
        why_it_helps: 'This table answers the core patient questions in one scan-friendly block and gives AI platforms structured facts to summarize.',
        columns: ['Patient question', 'Recommended answer to add', 'Why it matters'],
        rows: [
          ['Who benefits most?', 'Children and teens with newly erupted permanent molars; adults with deep grooves and no decay may also be candidates.', 'Targets the highest-intent reader question and clarifies age/candidacy.'],
          ['How are sealants applied?', 'The dentist cleans and dries the tooth, prepares the surface, paints on the sealant, and hardens it with a curing light.', 'Explains the process clearly and reduces anxiety about pain or drilling.'],
          ['How long do they last?', 'Sealants can last for years, but dentists should check them during regular visits and repair or replace them if worn.', 'Adds practical maintenance guidance.'],
          ['How much do they cost?', 'Cost varies by office, tooth, insurance coverage, and whether the patient is a child or adult.', 'Addresses commercial intent without inventing pricing.'],
          ['Are sealants worth it?', 'They are most valuable for cavity prevention on molars with deep pits and fissures, especially in children at higher cavity risk.', 'Connects benefit to use case instead of overpromising.'],
        ],
      },
      secondaryTable: {
        title: 'Dental Sealants vs. Fluoride: What Each Preventive Treatment Does',
        why_it_helps: 'A comparison table clarifies that sealants and fluoride are complementary, not interchangeable.',
        columns: ['Preventive option', 'Primary role', 'Best for', 'Limitations'],
        rows: [
          ['Dental sealants', 'Creates a physical barrier over grooves in back teeth', 'Molars and premolars with deep pits/fissures', 'Does not protect between teeth or replace brushing/flossing'],
          ['Fluoride', 'Strengthens enamel and helps resist acid attacks', 'All teeth, especially patients at cavity risk', 'Does not physically fill deep chewing-surface grooves'],
          ['Regular dental cleanings', 'Removes plaque/tartar and checks sealant condition', 'Ongoing prevention and early detection', 'Does not replace daily home care'],
        ],
      },
      faqs: [
        {
          question: 'Are dental sealants worth it for kids?',
          answer: 'Dental sealants are often worth considering for children once permanent molars erupt because those back teeth have grooves that are harder to clean and more likely to trap food and bacteria.',
        },
        {
          question: 'Do dental sealants hurt?',
          answer: 'Sealant placement is typically painless. The dentist cleans and dries the tooth, paints on the sealant material, and hardens it without drilling or numbing in most cases.',
        },
        {
          question: 'How long do dental sealants last?',
          answer: 'Sealants can last for years, but they should be checked during routine dental visits. A dentist can repair or replace a sealant if it chips, wears down, or no longer fully covers the grooves.',
        },
        {
          question: 'Can adults get dental sealants?',
          answer: 'Some adults can get sealants if their molars have deep grooves and do not already have decay or large restorations on the chewing surface. A dentist can confirm candidacy during an exam.',
        },
        {
          question: 'How much do dental sealants cost?',
          answer: 'The cost of dental sealants varies by location, dental office, number of teeth, and insurance coverage. Content teams should add local or practice-specific pricing guidance if available.',
        },
      ],
      outline: [
        'H2: What are dental sealants?',
        'H2: Who should get dental sealants?',
        'H2: Benefits of dental sealants for cavity prevention',
        'H2: How dental sealants are applied',
        'H2: Dental sealants cost and insurance considerations',
        'H2: Dental sealants vs. fluoride',
        'H2: How long dental sealants last',
        'H2: Frequently asked questions about dental sealants',
      ],
      expertQuote: {
        credential_to_request: 'DDS/DMD reviewer, ideally a family dentist or pediatric dentist',
        placement: 'After the application/process section or before the cost section',
        sample_quote_prompt: 'Ask the reviewer: "Which patients benefit most from sealants, and what misconception should parents understand before deciding?"',
        sample_quote_format: '"Sealants are most useful on molars with deep grooves because those surfaces are harder for children to clean well. They do not replace brushing, flossing, fluoride, or regular dental visits, but they can add a strong layer of cavity prevention for the right patient." - [Reviewer Name], DDS/DMD',
      },
      sourceClaims: [
        'sealants reduce cavity risk on molars',
        'sealants are recommended for children/teens when permanent molars erupt',
        'application is non-invasive and usually does not require drilling',
        'sealants need periodic dental checks',
      ],
    };
  }

  return {
    kind: 'generic_dental',
    schemaType: 'MedicalWebPage',
    directAnswer: `${displayTopic(topic)} is a dental topic that should be explained with a short definition, who it applies to, how the procedure or condition is handled, and when a patient should talk to a dentist.`,
    priorityTable: {
      title: `${displayTopic(topic)}: Key Decisions for Patients`,
      why_it_helps: 'This table turns broad advice into a clear decision aid for readers and AI answer engines.',
      columns: ['Patient question', 'What to add', 'Why it matters'],
      rows: [
        ['What is it?', 'Add a plain-language definition in 1-2 sentences.', 'Creates an answer-ready opening.'],
        ['Who needs it?', 'Describe best-fit patients and exceptions.', 'Improves usefulness and reduces overgeneralized claims.'],
        ['What happens next?', 'Explain appointment steps, timeline, or treatment path.', 'Makes the page actionable.'],
      ],
    },
    secondaryTable: null,
    faqs: [
      { question: `What is ${displayTopic(topic)}?`, answer: `Add a concise answer that defines ${displayTopic(topic)} in patient-friendly language.` },
      { question: `Who is a good candidate for ${displayTopic(topic)}?`, answer: 'Explain which patients benefit most and when a dentist should evaluate the situation.' },
      { question: `How much does ${displayTopic(topic)} cost?`, answer: 'Explain the factors that affect cost and tell readers how to confirm exact pricing or insurance coverage.' },
    ],
    outline: [
      `H2: What is ${displayTopic(topic)}?`,
      `H2: Who needs ${displayTopic(topic)}?`,
      `H2: Benefits and limitations`,
      `H2: Cost and insurance considerations`,
      `H2: Frequently asked questions`,
    ],
    expertQuote: {
      credential_to_request: 'DDS/DMD reviewer',
      placement: 'Near the main recommendation or treatment section',
      sample_quote_prompt: `Ask the reviewer: "What should patients understand before making a decision about ${displayTopic(topic)}?"`,
      sample_quote_format: `"The right choice depends on the patient's oral health, risk factors, and long-term goals. A dentist can explain whether ${displayTopic(topic)} is appropriate after an exam." - [Reviewer Name], DDS/DMD`,
    },
    sourceClaims: [`definition and clinical context for ${displayTopic(topic)}`],
  };
}

function firstUsefulPassage(source) {
  return source?.evidencePassages?.[0] || source?.snippet || '';
}

function buildBaselineRecommendations(findings, research, context = {}) {
  const topic = topicLabel(context.researchTopic, findings);
  const readableTopic = displayTopic(topic);
  const profile = getTopicProfile(topic);
  const statsSource = pickEvidenceSource(research, 'statistics', 0, topic);
  const citationSource = pickEvidenceSource(research, 'authoritative_citations', 0, topic) || statsSource;
  const expertSource = pickEvidenceSource(research, 'expert_quote_angles', 0, topic) || citationSource;
  const statPassage = firstUsefulPassage(statsSource);
  const citationPassage = firstUsefulPassage(citationSource);
  const h1 = findings?.meta?.h1 || topic;
  const needsAuthor = findings?.checks?.some(c => c.id === 'AUTH1' && c.status !== 'pass');
  const needsFaq = findings?.checks?.some(c => c.id === 'CSA7' && c.status !== 'pass');
  const needsTable = findings?.checks?.some(c => c.id === 'CSA6' && c.status !== 'pass');
  const needsDirectAnswer = findings?.checks?.some(c => c.id === 'CSA4' && c.status !== 'pass');

  const citationTargets = citationSource ? [
    {
      source_title: citationSource.title,
      source_url: citationSource.url,
      source_type: sourceTypeFor(citationSource.url),
      claim_to_support: profile.sourceClaims?.[0] || `${readableTopic} definition and clinical context`,
      where_to_add: 'Introduction or first explanatory section',
      draft_sentence: `Add after the opening definition: "${profile.sourceClaims?.[0] ? `Use this source to support the claim that ${profile.sourceClaims[0]}.` : `${readableTopic} should be explained with source-backed clinical context.`}" Cite ${citationSource.title} (${citationSource.url}).${citationPassage ? ` Supporting source note: ${citationPassage}` : ''}`,
    },
  ] : [];

  const statisticsToAdd = statsSource ? [
    {
      claim_or_stat_needed: profile.kind === 'dental_sealants'
        ? 'Dental sealant effectiveness or cavity-prevention statistic'
        : `${readableTopic} prevalence or incidence in the general population`,
      recommended_source_title: statsSource.title,
      recommended_source_url: statsSource.url,
      recommended_source_type: sourceTypeFor(statsSource.url),
      where_to_place: profile.kind === 'dental_sealants'
        ? 'Benefits section, immediately after explaining cavity prevention'
        : 'First 150 words, immediately after the direct answer definition',
      sample_sentence_template: profile.kind === 'dental_sealants'
        ? `Add: "Research from ${statsSource.title} supports using sealants as a preventive tool for cavity-prone chewing surfaces; insert the exact cavity-reduction or effectiveness figure after verifying the source." Source: ${statsSource.url}.${statPassage ? ` Research note: ${statPassage}` : ''}`
        : `Add: "Population studies report that ${readableTopic} prevalence varies by study group and tooth type; use the exact prevalence figure from ${statsSource.title} and cite it here." Source: ${statsSource.url}.${statPassage ? ` Research note: ${statPassage}` : ''}`,
    },
    {
      claim_or_stat_needed: profile.kind === 'dental_sealants'
        ? 'Age group or tooth surfaces most likely to benefit from sealants'
        : `Most commonly missing teeth or common patterns connected to ${readableTopic}`,
      recommended_source_title: statsSource.title,
      recommended_source_url: statsSource.url,
      recommended_source_type: sourceTypeFor(statsSource.url),
      where_to_place: profile.kind === 'dental_sealants' ? 'Who should get dental sealants section' : 'Symptoms or Diagnosis section',
      sample_sentence_template: profile.kind === 'dental_sealants'
        ? `Add: "Sealants are most often discussed for cavity prevention on permanent molars; verify and cite the age/tooth-surface guidance from ${statsSource.title}." Source: ${statsSource.url}.`
        : `Add: "When discussing symptoms, include which teeth are most commonly affected and cite ${statsSource.title}." Source: ${statsSource.url}.`,
    },
  ] : [];

  const directAnswer = {
    missing: Boolean(needsDirectAnswer),
    recommended_block: profile.directAnswer,
  };

  const htmlTables = needsTable
    ? [profile.priorityTable, profile.secondaryTable].filter(Boolean)
    : [profile.priorityTable].filter(Boolean);

  const faqBlock = {
    why_it_helps: 'These questions target patient intent and give AI platforms concise, extractable answers.',
    questions: profile.faqs,
  };

  const expertQuoteIntegration = profile.expertQuote;

  const authorBio = {
    needed: Boolean(needsAuthor),
    recommendation: 'Add both a writer byline and a medically reviewed byline. For healthcare content, include credentials, review date, and a short reviewer bio.',
    sample_byline: 'Written by [Content Writer Name] | Medically reviewed by [Dentist Name], DDS/DMD | Last reviewed: [Month Day, Year]',
    sample_bio: '[Dentist Name], DDS/DMD, is a licensed dentist with experience in preventive dentistry, restorative planning, and patient education. This article was reviewed for clinical accuracy and clarity.',
  };

  const csqafRecommendations = [
    citationSource && {
      element: 'Citations',
      specific_action: `Add a citation-backed sentence about ${readableTopic} in the introduction and cite the researched source.`,
      draft_copy: citationTargets[0]?.draft_sentence || profile.directAnswer,
      source_title: citationSource.title,
      source_url: citationSource.url,
      placement: 'Introduction',
    },
    statsSource && {
      element: 'Statistics',
      specific_action: profile.kind === 'dental_sealants'
        ? 'Add one effectiveness or cavity-prevention statistic from the researched source.'
        : 'Add one prevalence sentence using an exact figure from the researched source.',
      draft_copy: statisticsToAdd[0]?.sample_sentence_template || `Add one verified, source-backed statistic about ${readableTopic}.`,
      source_title: statsSource.title,
      source_url: statsSource.url,
      placement: 'Introduction or Causes section',
    },
    {
      element: 'Quotations',
      specific_action: 'Request and add one reviewer quote that clarifies patient expectations and prevents overclaiming.',
      draft_copy: expertQuoteIntegration.sample_quote_format,
      source_title: '',
      source_url: '',
      placement: expertQuoteIntegration.placement,
    },
    {
      element: 'Authoritativeness',
      specific_action: 'Add a reviewed-by block with a named DDS/DMD reviewer and review date.',
      draft_copy: authorBio.sample_byline,
      source_title: '',
      source_url: '',
      placement: 'Below title and again in author/reviewer bio box',
    },
    {
      element: 'Fluency',
      specific_action: 'Add a short answer-first block and break practical guidance into a table.',
      draft_copy: directAnswer.recommended_block,
      source_title: '',
      source_url: '',
      placement: 'Immediately below H1',
    },
  ].filter(Boolean);

  const sourceUrls = [
    ...(research?.searchResults || []).slice(0, 5).map(source => ({
      title: source.title,
      url: source.url,
      use_for: 'Competitor structure and topic coverage pattern',
    })),
    ...flattenEvidenceResults(research).slice(0, 5).map(source => ({
      title: source.title,
      url: source.url,
      use_for: source.useFor || 'Evidence and citation support',
    })),
  ];

  return {
    executive_summary: {
      verdict: `The page needs source-backed authority signals and copy-ready answer assets to compete for ${readableTopic} in AI/search results.`,
      readiness: findings?.scores?.overall >= 70 ? 'moderate' : 'weak',
      highest_impact_fix: `Add a direct-answer intro, cite ${citationSource?.title || 'a researched authoritative source'}, and add the treatment-options table.`,
    },
    priority_recommendations: [
      {
        title: 'Add a source-backed direct answer intro',
        why_it_matters: 'AI systems often extract short answer blocks; the current page needs an immediately quotable definition plus evidence.',
        how_to_fix: `Place the direct answer block directly below the H1 and cite ${citationSource?.title || 'an authoritative source'} in the same section.`,
        example_copy: directAnswer.recommended_block,
        effort: 'low',
        priority: 1,
      },
      {
        title: 'Add a treatment decision table',
        why_it_matters: 'A structured table helps users compare options and helps AI platforms summarize treatment paths accurately.',
        how_to_fix: 'Insert the recommended treatment table before the FAQ section.',
        example_copy: htmlTables[0]?.rows?.map(row => row.join(' | ')).join('\n') || '',
        effort: 'medium',
        priority: 2,
      },
      {
        title: 'Add reviewed-by authority signals',
        why_it_matters: 'Dental content is YMYL-adjacent; named reviewer credentials and review dates improve trust and reduce AI-citation risk.',
        how_to_fix: authorBio.recommendation,
        example_copy: `${authorBio.sample_byline}\n\n${authorBio.sample_bio}`,
        effort: 'low',
        priority: 3,
      },
    ],
    research_summary: {
      topic: readableTopic,
      competitor_patterns: [
        `${readableTopic} content should answer what it is, who it helps, how it works, cost considerations, and limitations.`,
        'Patient-facing pages benefit from question-led headings and short treatment comparisons.',
        'Evidence-backed pages cite dental associations, public health sources, or clinical literature for benefits and preventive value.',
      ],
      content_gaps: [
        `Add a practical table specific to ${readableTopic}, not a generic dental treatment table.`,
        'Add exact source-backed benefit or effectiveness guidance where available.',
        'Add a reviewer quote that clarifies candidacy, limitations, and what patients should expect.',
      ],
      source_urls: sourceUrls,
    },
    content_structure: {
      recommended_outline_changes: profile.outline,
      answer_blocks_to_add: [
        directAnswer.recommended_block,
        `Key Takeaways: define ${readableTopic}, explain who benefits, summarize the process, note limitations, and tell readers how to confirm candidacy/cost with a dentist.`,
      ],
      faq_questions: faqBlock.questions.map(item => item.question),
    },
    direct_answer_formatting: directAnswer,
    html_comparison_tables: htmlTables.length ? htmlTables : [
      {
        title: `${readableTopic}: Recommended Comparison Table`,
        why_it_helps: 'The current page already has table support; expand it with topic-specific decision detail.',
        columns: ['Question', 'Recommended content'],
        rows: [['What should readers compare?', 'Benefits, candidacy, process, cost factors, limitations, and next steps']],
      },
    ],
    faq_block: needsFaq ? faqBlock : { ...faqBlock, why_it_helps: 'Use these to strengthen the existing FAQ block.' },
    authority: {
      citation_targets: citationTargets,
      expert_signal_recommendations: [
        authorBio.sample_byline,
        'Add reviewer profile link and reviewer credential schema where possible.',
        'Add visible reviewed date and update date near the byline.',
      ],
      statistics_to_add: statisticsToAdd,
      expert_quote_integration: expertQuoteIntegration,
      author_bio_byline: authorBio,
    },
    csqaf: {
      missing_elements: ['Citations', 'Statistics', 'Quotations', 'Authoritativeness', 'Fluency'].filter(element => {
        if (element === 'Citations') return findings?.signals?.authoritativeCitations?.length < 2;
        if (element === 'Statistics') return findings?.signals?.statisticsCount < 2;
        if (element === 'Quotations') return findings?.signals?.expertQuoteCount < 1;
        if (element === 'Authoritativeness') return needsAuthor;
        if (element === 'Fluency') return needsDirectAnswer || needsTable;
        return false;
      }),
      recommendations: csqafRecommendations,
    },
    schema: {
      missing_or_improved_schema: [
        'Add Article or MedicalWebPage schema with headline, author, reviewedBy, datePublished, dateModified, and citation URLs.',
        'If the FAQ block is added visibly on page, add matching FAQPage schema.',
      ],
      starter_json_ld: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': profile.schemaType,
        headline: h1,
        reviewedBy: {
          '@type': 'Person',
          name: '[Dentist Name]',
          honorificSuffix: 'DDS/DMD',
        },
        dateReviewed: '[YYYY-MM-DD]',
        citation: citationTargets.map(c => c.source_url).filter(Boolean),
      }, null, 2),
    },
    _baseline_generated: true,
  };
}

function compactResearch(research) {
  if (!research) return null;
  return {
    topic: research.topic,
    searchQuery: research.searchQuery,
    successfulCount: research.successfulCount,
    evidenceQueries: (research.evidenceQueries || []).map(group => ({
      type: group.type,
      query: group.query,
      useFor: group.useFor,
      error: group.error || null,
      results: (group.results || []).map(r => ({
        position: r.position,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        displayUrl: r.displayUrl,
      })),
    })),
    searchResults: research.searchResults.map(r => ({
      position: r.position,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    })),
    competitorSummary: research.competitorSummary,
  };
}

const SYSTEM_PROMPT = `You are a senior GEO/AEO and SEO content strategist.

Analyze a page against a "Content Structure & Authority" standard for AI-search readiness.
You will receive:
1. The target page audit findings
2. Google top-10 competitor/blog research for the content topic

Focus on whether the target page is answer-first, well sectioned, entity-clear, evidence-backed, credentialed, cited, and machine-readable.
Use the competitor research to produce specific recommendations that add real user value, not generic advice.

Return valid JSON only with this shape:
{
  "executive_summary": {
    "verdict": "one concise sentence",
    "readiness": "strong | moderate | weak",
    "highest_impact_fix": "one specific fix"
  },
  "priority_recommendations": [
    {
      "title": "short recommendation title",
      "why_it_matters": "specific SEO/GEO/AEO impact",
      "how_to_fix": "clear implementation guidance",
      "example_copy": "optional copy or section example",
      "effort": "low | medium | high",
      "priority": 1
    }
  ],
  "research_summary": {
    "topic": "researched topic",
    "competitor_patterns": ["specific patterns found across top-ranking content"],
    "content_gaps": ["valuable gaps the target page can fill"],
    "source_urls": [{"title":"ranking page title","url":"ranking page URL","use_for":"what insight this URL contributed"}]
  },
  "content_structure": {
    "recommended_outline_changes": ["specific H2/H3/section additions or rewrites"],
    "answer_blocks_to_add": ["direct answer/key takeaway/table/FAQ blocks"],
    "faq_questions": ["recommended FAQ questions"]
  },
  "direct_answer_formatting": {
    "missing": true,
    "recommended_block": "copy-ready 2-4 sentence direct answer block tailored to the target topic"
  },
  "html_comparison_tables": [
    {
      "title": "table title",
      "why_it_helps": "how this helps users and AI/search engines",
      "columns": ["Column A", "Column B"],
      "rows": [["cell", "cell"]]
    }
  ],
  "faq_block": {
    "why_it_helps": "specific reason",
    "questions": [
      {"question": "copy-ready FAQ question", "answer": "copy-ready concise answer"}
    ]
  },
  "authority": {
    "citation_targets": [
      {
        "source_title": "exact source title from research",
        "source_url": "exact source URL from research",
        "source_type": "NIH/NIDCR/ADA/peer-reviewed/competitor/etc.",
        "claim_to_support": "specific claim this source should support",
        "where_to_add": "specific section placement",
        "draft_sentence": "copy-ready citation sentence with bracketed placeholder if exact stat is not in snippet"
      }
    ],
    "expert_signal_recommendations": ["author/reviewer/credential/date recommendations"],
    "statistics_to_add": [
      {
        "claim_or_stat_needed": "specific data point to add",
        "recommended_source_title": "exact source title from research if available",
        "recommended_source_url": "exact source URL from research if available",
        "recommended_source_type": "source type or named source",
        "where_to_place": "target section",
        "sample_sentence_template": "copy-ready sentence with [insert stat] placeholder"
      }
    ],
    "expert_quote_integration": {
      "credential_to_request": "specific expert credential",
      "placement": "where the quote should go",
      "sample_quote_prompt": "question to ask the expert",
      "sample_quote_format": "copy-ready quote format with placeholders"
    },
    "author_bio_byline": {
      "needed": true,
      "recommendation": "what author/reviewer/byline fields to add",
      "sample_byline": "copy-ready byline template",
      "sample_bio": "copy-ready bio template"
    }
  },
  "csqaf": {
    "missing_elements": ["Citations|Statistics|Quotations|Authoritativeness|Fluency"],
    "recommendations": [
      {
        "element": "Citations|Statistics|Quotations|Authoritativeness|Fluency",
        "specific_action": "copy-ready implementation action",
        "draft_copy": "exact copy/template to add",
        "source_title": "source title when relevant",
        "source_url": "source URL when relevant",
        "placement": "where content team should add it"
      }
    ]
  },
  "schema": {
    "missing_or_improved_schema": ["schema recommendations"],
    "starter_json_ld": "minimal JSON-LD example if useful, otherwise empty string"
  }
}

Rules:
- Be practical and page-specific.
- Prefer concrete copy/section examples over generic advice.
- Do not return vague bullets like "Add citations from authoritative sources" or "Include sourced statistics."
- Every Citation Target must include an exact URL from the research payload and a draft sentence showing how to use it.
- Every Statistics item must name the exact data point to find, the exact source URL to check when available, where to place it, and a sentence template.
- CSQAF recommendations must be copy-ready actions. Example: "In the opening section, add: '[draft sentence]' and cite [source title] ([source URL])."
- Expert Signal Recommendations must include a specific byline/reviewer block template, not just "add reviewer."
- If HTML Comparison Tables are missing, provide at least one fully structured table with useful columns and rows.
- If FAQ Block Implementation is missing, provide a copy-ready FAQ block with concise answers.
- If Direct Answer Formatting is missing, provide copy-ready direct answer copy.
- If Statistics & Data Density is weak, provide specific data points to source and sentence templates with placeholders.
- If Expert Quote Integration is missing, provide credential, placement, and quote prompt/format.
- If Author Bio & Byline Optimization is missing, explicitly ask to add author, reviewer, credentials, bio, and reviewed/updated dates.
- If any CSQAF element is missing, include a specific recommendation for it.
- For healthcare, legal, or finance content, treat author, reviewer, credentials, dates, and citations as high-priority.
- Do not invent exact statistics or fake citations. Use placeholders like [insert prevalence from NIH/NIDCR] and name source types.
- Use competitor research to identify valuable content patterns, but do not copy competitor text.
- If the input came from pasted HTML, do not complain about not being able to fetch the URL.`;

async function generateAiRecommendations(findings, context) {
  if (!process.env.OPENAI_API_KEY) return null;
  const { research, baselineRecommendations, ...contextWithoutResearch } = context || {};

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        context: contextWithoutResearch,
        findings: compactFindings(findings),
        research: compactResearch(research),
        baseline_recommendations: baselineRecommendations,
      }),
    },
  ];

  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const completion = await getOpenAI().chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        temperature: 0.25,
        max_tokens: 2600,
        messages,
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
      parsed._model_used = completion.model || model;
      parsed._preferred_model = PRIMARY_MODEL;
      parsed._fallback_used = model !== PRIMARY_MODEL;
      return parsed;
    } catch (err) {
      const canFallback = model === PRIMARY_MODEL && (
        err.code === 'model_not_found' ||
        err.status === 403 ||
        /does not have access to model|model.*not found/i.test(err.message || '')
      );
      if (!canFallback) throw err;
      console.warn(`[content-enhancement] ${PRIMARY_MODEL} unavailable, falling back to ${FALLBACK_MODEL}: ${err.message}`);
    }
  }

  return null;
}

function isWeakText(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return /^(add|include|integrate|establish|ensure)\s+(citations|sourced statistics|expert quotes|authoritativeness|fluency|a medically reviewed byline)/i.test(text)
    && text.length < 140;
}

function hasUsableCitationTargets(ai) {
  return (ai?.authority?.citation_targets || []).some(item =>
    item?.source_url && item?.draft_sentence && !isWeakText(item.draft_sentence)
  );
}

function hasUsableStatistics(ai) {
  return (ai?.authority?.statistics_to_add || []).some(item =>
    item?.recommended_source_url && item?.sample_sentence_template && !isWeakText(item.sample_sentence_template)
  );
}

function hasUsableCsqaf(ai) {
  return (ai?.csqaf?.recommendations || []).some(item =>
    item?.draft_copy && !isWeakText(item.draft_copy)
  );
}

function hasUsableTables(ai) {
  return (ai?.html_comparison_tables || []).some(table =>
    table?.columns?.length >= 2 && table?.rows?.length >= 2
  );
}

function hasUsableFaq(ai) {
  return (ai?.faq_block?.questions || []).some(item => item?.question && item?.answer);
}

function mergeRecommendations(ai, baseline) {
  if (!baseline) return ai;
  if (!ai) return baseline;

  const merged = {
    ...baseline,
    ...ai,
    research_summary: {
      ...baseline.research_summary,
      ...(ai.research_summary || {}),
      source_urls: ai.research_summary?.source_urls?.length ? ai.research_summary.source_urls : baseline.research_summary.source_urls,
    },
    content_structure: {
      ...baseline.content_structure,
      ...(ai.content_structure || {}),
      recommended_outline_changes: ai.content_structure?.recommended_outline_changes?.length ? ai.content_structure.recommended_outline_changes : baseline.content_structure.recommended_outline_changes,
      answer_blocks_to_add: ai.content_structure?.answer_blocks_to_add?.length ? ai.content_structure.answer_blocks_to_add : baseline.content_structure.answer_blocks_to_add,
      faq_questions: ai.content_structure?.faq_questions?.length ? ai.content_structure.faq_questions : baseline.content_structure.faq_questions,
    },
    authority: {
      ...baseline.authority,
      ...(ai.authority || {}),
      citation_targets: hasUsableCitationTargets(ai) ? ai.authority.citation_targets : baseline.authority.citation_targets,
      statistics_to_add: hasUsableStatistics(ai) ? ai.authority.statistics_to_add : baseline.authority.statistics_to_add,
      expert_signal_recommendations: ai.authority?.expert_signal_recommendations?.some(item => !isWeakText(item))
        ? ai.authority.expert_signal_recommendations
        : baseline.authority.expert_signal_recommendations,
      expert_quote_integration: ai.authority?.expert_quote_integration?.sample_quote_format
        ? ai.authority.expert_quote_integration
        : baseline.authority.expert_quote_integration,
      author_bio_byline: ai.authority?.author_bio_byline?.sample_byline
        ? ai.authority.author_bio_byline
        : baseline.authority.author_bio_byline,
    },
    csqaf: {
      ...baseline.csqaf,
      ...(ai.csqaf || {}),
      recommendations: hasUsableCsqaf(ai) ? ai.csqaf.recommendations : baseline.csqaf.recommendations,
    },
    schema: {
      ...baseline.schema,
      ...(ai.schema || {}),
      starter_json_ld: ai.schema?.starter_json_ld || baseline.schema.starter_json_ld,
    },
  };

  merged.direct_answer_formatting = ai.direct_answer_formatting?.recommended_block
    ? ai.direct_answer_formatting
    : baseline.direct_answer_formatting;
  merged.html_comparison_tables = hasUsableTables(ai) ? ai.html_comparison_tables : baseline.html_comparison_tables;
  merged.faq_block = hasUsableFaq(ai) ? ai.faq_block : baseline.faq_block;
  merged.priority_recommendations = ai.priority_recommendations?.some(item => item?.example_copy && !isWeakText(item.example_copy))
    ? ai.priority_recommendations
    : baseline.priority_recommendations;
  merged._baseline_available = true;
  merged._baseline_used_for = {
    citations: !hasUsableCitationTargets(ai),
    statistics: !hasUsableStatistics(ai),
    csqaf: !hasUsableCsqaf(ai),
    tables: !hasUsableTables(ai),
    faq: !hasUsableFaq(ai),
  };
  return merged;
}

router.post('/run', async (req, res) => {
  const { inputMode, url, html, primaryKeyword, pageType, clientContext } = req.body || {};
  const mode = inputMode === 'url' ? 'url' : 'html';

  // SSRF guard — see the note in routes/agentReadinessAudit.js. The URL is
  // fetched by this server, so a parseable string is not the same as a host this
  // server should be made to reach: 169.254.169.254 (cloud instance metadata)
  // and every private range are refused here rather than fetched.
  if (mode === 'url' && url) {
    try {
      await assertPublicHost(new URL(String(url).startsWith('http') ? url : `https://${url}`).hostname);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  try {
    let rawHtml = '';
    let pageUrl = null;
    let fetch = null;

    if (mode === 'url') {
      pageUrl = normalizeUrl(url);
      if (!pageUrl) return res.status(400).json({ error: 'URL is required.' });
      fetch = await fetchHtml(pageUrl);
      rawHtml = fetch.html;
      pageUrl = fetch.finalUrl || pageUrl;
      if (!rawHtml || rawHtml.trim().length < 80) {
        return res.status(422).json({ error: 'Fetched HTML is empty or too short to analyze.' });
      }
    } else {
      rawHtml = String(html || '');
      pageUrl = url ? normalizeUrl(url) : null;
      if (!rawHtml.trim() || rawHtml.trim().length < 80) {
        return res.status(400).json({ error: 'Paste at least 80 characters of HTML.' });
      }
    }

    const findings = runContentEnhancementChecks(rawHtml, {
      pageUrl,
      primaryKeyword: primaryKeyword || '',
      inputType: mode === 'url' ? 'url' : 'html_paste',
    });

    let research = null;
    let researchError = null;
    const researchTopic = inferResearchTopic(findings, primaryKeyword || '', pageType || '');
    try {
      research = await researchTopRankingContent(researchTopic);
    } catch (err) {
      researchError = err.message;
      console.warn('[content-enhancement] Research failed:', err.message);
    }
    const baselineRecommendations = buildBaselineRecommendations(findings, research, { researchTopic });

    let ai = null;
    let aiError = null;
    try {
      ai = await generateAiRecommendations(findings, {
        inputMode: mode,
        pageUrl,
        primaryKeyword: primaryKeyword || '',
        pageType: pageType || '',
        clientContext: clientContext || '',
        researchTopic,
        research,
        baselineRecommendations,
      });
      ai = mergeRecommendations(ai, baselineRecommendations);
    } catch (err) {
      aiError = err.message;
      console.warn('[content-enhancement] AI failed:', err.message);
      ai = baselineRecommendations;
    }

    res.json({
      fetch,
      research,
      researchError,
      baselineRecommendations,
      findings,
      ai,
      aiError,
    });
  } catch (err) {
    console.error('[content-enhancement] Error:', err.message);
    res.status(500).json({ error: err.message || 'Unexpected error.' });
  }
});

module.exports = router;
module.exports._private = {
  buildBaselineRecommendations,
  mergeRecommendations,
  isWeakText,
  researchTopRankingContent,
};
