// ── Tool catalog ────────────────────────────────────────────────────────────
// The long-form description of every tool: badge, tagline, what it does, and
// what it produces. Extracted verbatim from HomePage.jsx when the home screen
// became a project dashboard — the launcher moved below the dashboard rather
// than being deleted, so none of this content was lost and nothing became
// unreachable.
//
// Status tags stay in toolsMeta.js, which also drives the sidebar; a card looks
// its tag up by tool id so the two surfaces can never drift.

import { createElement as h } from 'react';

// Line icons, 20px, matching the sidebar's set. Written as createElement calls
// rather than JSX so this stays a plain .js data module.
const icon = (...paths) =>
  h('svg', {
    width: 20, height: 20, fill: 'none', viewBox: '0 0 24 24',
    stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, ...paths.map((d, i) => h('path', { key: i, d })));

export const TOOL_CATALOG = [
  {
    id: 'content-writer', path: '/content-writer', badge: 'Writing', group: 'Build',
    label: 'Content Writer', tagline: 'From researched brief to editable article',
    description: 'Build a SERP-based brief, shape the outline, and write a source-checked draft. Edit and save your work to a project, then export to Word or JSON.',
    features: ['Editable H2/H3 brief', 'GPT-5.4 mini drafting', 'CSQAF and source checks', 'Project saving · DOCX / JSON'],
    icon: icon('M12 20h9M16.5 3.5a2.12 2.12 0 013 3L9 17l-4 1 1-4L16.5 3.5z'),
  },
  {
    id: 'keyword-research', path: '/keyword-research', badge: 'Keywords', group: 'Research',
    label: 'Keyword Research', tagline: 'AI-powered keyword shortlisting',
    description: 'Enter a seed keyword, find the top ranking competitors, pull their real keyword rankings via SEMrush, and let AI shortlist 2 primary and 10 secondary keywords for your campaign.',
    features: ['Top competitor analysis', 'SEMrush keyword data', 'AI filtering & ranking', '2 primary + 10 secondary keywords'],
    icon: icon('M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z'),
  },
  {
    id: 'content-research', path: '/content-research', badge: 'Content', group: 'Research',
    label: 'Content Research', tagline: 'Competitor-based content briefs',
    description: 'Scrape the top 10 ranking pages for any keyword, extract their structure, and generate a ready-to-use content brief with H2 recommendations and competitor insights.',
    features: ['Top 10 SERP analysis', 'Competitor H2 mapping', 'Word count benchmarks', 'Export to Word (.docx)'],
    icon: icon('M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z'),
  },
  {
    id: 'article-recommendation', path: '/article-recommendation', badge: 'Briefs', group: 'Research',
    label: 'Article Recommendation', tagline: 'Structured content briefs from SERP data',
    description: 'Analyze the top 10 ranking pages for any keyword and generate a complete article brief with H1/H2/H3 structure, writing instructions, keywords per section, and FAQ recommendations.',
    features: ['Top 10 SERP scraping', 'H2/H3 structure analysis', 'FAQ pattern extraction', 'Export to .docx'],
    icon: icon('M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6V7.5z'),
  },
  {
    id: 'market-potential', path: '/market-potential', badge: 'Market Intel', group: 'Research',
    label: 'Healthcare Market Potential', tagline: 'Rank metros by commercial search demand',
    description: 'Enter your home market(s) and a service, then compare commercial-intent search demand across adjacent metros — indexed against your current market, with per-capita, CPC, competition and 12-month trend.',
    features: ['Agent-proposed, frozen keyword baskets', 'Geo-targeted volume (DataForSEO)', 'Adjacency suggestions + home index', 'Ranked table + US bubble map'],
    icon: icon('M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7'),
  },
  {
    id: 'content-enhancement', path: '/content-enhancement', badge: 'AEO', group: 'Optimize',
    label: 'Content Enhancement', tagline: 'Structure & authority recommendations',
    description: 'Analyze a live URL or pasted HTML, research the top 10 ranking blogs for the topic, and generate copy-ready upgrades for structure, authority, citations, FAQs, schema, and AI-search readiness.',
    features: ['URL or pasted HTML input', 'Copy-ready FAQ and answer blocks', 'Citation & expert quote gaps', 'Author byline guidance'],
    icon: icon('M9 12.75h6m-6 3h6m2.25 4.5H6.75A2.25 2.25 0 014.5 18V6A2.25 2.25 0 016.75 3.75h5.379c.597 0 1.17.237 1.591.659l1.871 1.871c.422.422.659.994.659 1.591V18a2.25 2.25 0 01-2.25 2.25z'),
  },
  {
    id: 'article-enhancement', path: '/article-enhancement', badge: 'Enhance', group: 'Optimize',
    label: 'Enhance Existing Article', tagline: 'Multi-LLM + SERP competitor enhancement',
    description: 'Crawl a live article URL, run 5 specialized LLM analyses in parallel against SERP competitor data, and generate an enhanced HTML article with all new content visually highlighted.',
    features: ['5-model LLM fanout (SEO · GEO · Intent · E-E-A-T · UX)', 'SERP competitor crawl & gap analysis', 'Unified enhancement report', 'Enhanced HTML with highlights'],
    icon: icon('M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10'),
  },
  {
    id: 'article-enhancement-lite', path: '/article-enhancement-lite', badge: 'Verified', group: 'Optimize',
    label: 'Article Enhancer', tagline: 'Preserves every word; adds only what’s provable',
    description: 'Enhances an existing article using only its own content plus SEO/AEO best practices — no SERP, competitor, or search-API data — and never inserts statistics, expert quotes, or citations. Every highlighted change is grounded in and verifiable against your original article.',
    features: ['No SERP / SEMrush / web research', 'Never fabricates stats, quotes, or citations', 'Answer-first, lists & tables from existing content', 'FAQ answerable from the article itself'],
    icon: icon('M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z'),
  },
  {
    icon: icon('M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'),
  },
  {
    id: 'seo-geo-audit', path: '/seo-geo-audit', badge: 'SEO+GEO', group: 'Optimize',
    label: 'SEO & GEO Audit', tagline: '200+ checks · scored · AI recommendations',
    description: 'Run a full SEO and Generative Engine Optimization audit on any URL or pasted HTML. 200+ checks across title, meta, headings, content, schema, E-E-A-T, technical, and GEO signals.',
    features: ['200+ checks across 21 categories', 'CSQAF & GEO readiness score', 'E-E-A-T & content recommendations', 'Instant AI expert analysis'],
    icon: icon('M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'),
  },
  {
    icon: icon('M3 3v18h18M8 17V9m4 8V5m4 12v-6'),
  },
  {
    id: 'agent-readiness-audit', path: '/agent-readiness-audit', badge: 'AI Audit', group: 'Optimize',
    label: 'Agent Readiness Audit', tagline: "Score any site's AI agent readiness in 15s",
    description: 'Run 13 automated checks across discoverability, content negotiation, bot access rules, and protocol support (MCP, OAuth, Agent Skills). Get a 0–100 score with GPT-generated CMO brief.',
    features: ['robots.txt, sitemap & Link headers', 'MCP server card detection', 'OAuth / OIDC discovery', 'GPT-4o CMO executive brief'],
    icon: icon('M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z'),
  },
  {
    id: 'image-alt-audit', path: '/image-alt-audit', badge: 'Images', group: 'Optimize',
    label: 'Image Alt Tag Audit', tagline: 'Bulk alt tag generation for location pages',
    description: 'Scrape 100+ location pages, classify every image by type, generate SEO-optimised alt tags and clean filenames, and export a colour-coded Excel workbook.',
    features: ['Batch scrape 100+ pages', 'GPT-4o vision for hero banners', 'RENAME_CRITICAL flagging', 'Export to 4-sheet .xlsx'],
    icon: icon('M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z'),
  },
  {
    id: 'location-page-builder', path: '/location-page-builder', badge: 'Local SEO', group: 'Build',
    label: 'Location + Service Pages', tagline: 'Composed, approved, dev-ready location pages',
    description: 'For a Client × Service × Location, produce an approved page package — keywords, competitor analysis, layer-composed content, FAQs, internal links and schema.',
    features: ['Three-layer composition engine', 'Keyword pipeline (SERP + SEMrush + AI)', 'Approval workflow & audit trail', 'Export to JSON / Markdown / DOCX'],
    icon: icon('M15 10.5a3 3 0 11-6 0 3 3 0 016 0z', 'M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z'),
  },
  {
    id: 'content-architect', path: '/content-architect', badge: 'Site Architecture', group: 'Build',
    label: 'Content Architect', tagline: 'Map a whole site into topic clusters and hubs',
    description: 'Discover every URL on a domain from its sitemap, group them into templates, then crawl the pages you confirm and cluster them by what they are actually about — surfacing the hub each cluster needs, the orphans, and the topics the site is missing.',
    features: ['Sitemap discovery with crawl fallback', 'URL pattern table you confirm before crawling', 'Term-profile clustering + AI cluster naming', 'Hub, orphan & content-gap diagnostics', 'Excel workbook or Markdown narrative export'],
    icon: icon('M9 6.75V15m6-6v8.25m.503-13.036L20.25 6.75V19.5l-5.747-2.036M8.503 3.964L3.75 6.75v12.75l5.747-2.036m0-13.5l6-2.036'),
  },
  {
    id: 'knowledge-base', path: '/kb', badge: 'Knowledge', group: 'Build',
    label: 'Knowledge Base', tagline: 'Client & industry context management',
    description: 'Create and maintain knowledge base entries for clients, industries, and best practices. KB context is automatically injected into AI tools when a client is selected.',
    features: ['Brand & voice guidelines per client', 'Industry compliance rules', 'Client feedback versioning', 'Auto-injected into AI tools'],
    icon: icon('M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25'),
  },
  {
    id: 'crawl-scope', path: '/crawl-scope', badge: 'Technical SEO', group: 'Monitor',
    label: 'Site Crawler', tagline: 'Full technical crawl, audited against 100+ checks',
    description: 'Crawl a whole site (or audit a URL list), watch every response land live, then triage the findings and export a formatted Excel audit. Schedule the same crawl weekly and it re-runs itself and emails the workbook.',
    features: ['100+ check audit catalog across 8 categories', 'Live crawl view with pause, resume and stop', 'Issue review with saved status and notes', 'Weekly scheduled crawls, emailed as Excel', 'robots.txt respected; identifies as CrawlScope'],
    icon: icon('M12 21a9 9 0 100-18 9 9 0 000 18zm0 0V3m0 18c-2.5-2.2-4-5.4-4-9s1.5-6.8 4-9m0 18c2.5-2.2 4-5.4 4-9s-1.5-6.8-4-9M3.6 9h16.8M3.6 15h16.8'),
  },
  {
    id: 'robots-monitor', path: '/robots-monitor', badge: 'Technical SEO', group: 'Monitor',
    label: 'Robots Monitor', tagline: 'Daily noindex health checks across client domains',
    description: 'Automatically crawl sitemaps, sample pages by type, and verify noindex signals on production and staging domains. Get Slack alerts the moment a production page goes dark.',
    features: ['Sitemap discovery + URL sampling', 'X-Robots-Tag & meta robots checks', 'Daily scheduled + manual runs', '90-day run history'],
    icon: icon('M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5'),
  },
  {
    id: 'gbp-qc-agent', href: 'https://gbp-qc-agent-production.up.railway.app', badge: 'GBP', group: 'GBP',
    label: 'GBP QC Agent', tagline: 'Quality control & content generation for GBP posts',
    description: 'Review GBP post content against client brand guidelines, generate location-specific posts from a base template, and export ready-to-publish content for all locations.',
    features: ['3-stage QC workflow (base → expanded → published)', 'Location content generator for all branches', 'Brand guideline enforcement per client', 'Export to Excel for all locations'],
    icon: icon('M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z'),
  },
];

export const TOOL_CATALOG_GROUPS = ['Research', 'Optimize', 'Build', 'Monitor', 'GBP'];
