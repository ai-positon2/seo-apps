// ── The report rail ──────────────────────────────────────────────────────────
//
// Nine reports, grouped, in the order the design sets: what is happening, then
// who says it, then what they were asked, then where the answers came from,
// then the raw evidence. Insights and metrics first; the setup that produced
// them lives at the end of the last report, not at the top of the first.
//
// ── Two reports are renamed from the reference, deliberately ───────────────
//
//   "Prompts" -> Questions   what the module stores IS a question a buyer would
//                            type; calling it a prompt describes our plumbing
//                            rather than the thing being measured.
//   "Chats"   -> Answers     every row here is one API call with web search on,
//                            not a consumer chat session. Migration 0029 is
//                            explicit that the scraped module measures the
//                            consumer surfaces and this one measures the models
//                            directly, and that the two claims must never
//                            merge. Calling these "chats" would merge them.
//
// The rail stat is the one number that report is about, read straight off the
// server's metric envelope — never recomputed here.

/** The stat shown beside each rail item. Null renders as nothing, not as zero. */
const STAT = {
  overview: (r) => r?.headline?.namedRate?.display ?? null,
  insights: (r) => r?.headline?.shareOfMentions?.display ?? null,
  perception: (r, d) => (d?.attributes?.length ? String(d.attributes.length) : null),
  questions: (r) => (r?.byQuestion?.length ? String(r.byQuestion.length) : null),
  gaps: (r) => (r?.gaps ? String(r.gaps.total) : null),
  domains: (r) => (r?.sources ? String(r.sources.domains.length) : null),
  urls: (r) => (r?.urls ? String(r.urls.rows.length) : null),
  answers: (r) => (r?.meta ? String(r.meta.answers) : null),
  run: (r) => r?.headline?.namedRate?.display ?? null,
};

export const REPORTS = [
  {
    id: 'overview',
    name: 'Executive overview',
    blurb: 'Where you stand, and where ground is being lost',
  },
  {
    id: 'insights',
    name: 'Insights',
    blurb: 'How the models compare, and how this is moving',
  },
  {
    id: 'perception',
    name: 'Perception',
    blurb: 'What the models say about the brand, in their own words',
  },
  {
    id: 'questions',
    name: 'Questions',
    blurb: 'Every question measured, and how each one landed',
  },
  {
    id: 'gaps',
    name: 'Gap analysis',
    blurb: 'Sources feeding answers that name a competitor, not you',
  },
  {
    id: 'domains',
    name: 'Sources',
    blurb: 'Which sites the models read to answer',
  },
  {
    id: 'urls',
    name: 'Pages',
    blurb: 'The individual pages pulled into answers',
  },
  {
    id: 'answers',
    name: 'Answers',
    blurb: 'The raw model answers behind every number here',
  },
  {
    id: 'run',
    name: 'Setup & runs',
    blurb: 'The questions, the business profile, and the run budget',
  },
].map((r) => ({ ...r, stat: STAT[r.id] }));

export const REPORT_GROUPS = [
  { label: 'START HERE', ids: ['overview'] },
  { label: 'BRAND', ids: ['insights', 'perception'] },
  { label: 'DEMAND', ids: ['questions'] },
  { label: 'SOURCES', ids: ['gaps', 'domains', 'urls'] },
  { label: 'EVIDENCE', ids: ['answers', 'run'] },
];

export const REPORT_IDS = REPORTS.map((r) => r.id);

export const byId = (id) => REPORTS.find((r) => r.id === id) || REPORTS[0];

// What each source category means, in words a client reads rather than the
// classifier's own keys. `you` and `competitor` are decided by the configured
// domains, never by pattern — see aiVisibility/captureEngines/domainClassify.js.
export const SOURCE_TYPE_LABELS = {
  you: 'This site',
  competitor: 'A competitor',
  corporate: 'Business sites',
  reference: 'Directories',
  institutional: 'Official bodies',
  editorial: 'Press',
  ugc: 'Forums & reviews',
  other: 'Other',
};

export const PAGE_TYPE_LABELS = {
  homepage: 'Homepage',
  profile: 'Profile',
  category: 'Category',
  product: 'Product',
  article: 'Article',
  listicle: 'Listicle',
  discussion: 'Discussion',
  other: 'Other',
};

export const ENGINE_LABELS = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  google: 'Gemini',
};

export const engineLabel = (engine) => ENGINE_LABELS[engine] || engine;
