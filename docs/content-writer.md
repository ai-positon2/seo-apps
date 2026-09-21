# Content Writer

Open **Build → Content Writer** (`/content-writer`). Select a project, enter a primary keyword, and build a brief. Audience, tone, language, target word count, secondary keywords, custom instructions and client knowledge base are optional.

The brief uses `server/services/articleBrief.js`, the same implementation as Article Recommendation: Google US top-ten search, scraping, pattern analysis, knowledge-base context, brief generation, and keyword alignment/realignment. The editor converts that output into a title and one card per heading, preserving instructions, keywords, visual guidance, FAQs and references.

Headings run from H2 to H6. Each card carries a level selector showing its own tag; levels that would skip a step in the outline are disabled, so a heading can only sit one level below the heading above it. Changing a level moves the headings nested under it by the same amount, keeping the group's shape. Indentation on the card reflects the level.

Cards are reordered by dragging the handle or with the per-card move buttons. A heading owns the deeper headings beneath it, so both methods move the whole group rather than stranding subheadings under the wrong parent. While dragging, the source card dims and a line marks where the group will land: dropping on the upper half of a card places the group before it, the lower half after it.

Every generated brief includes a Frequently Asked Questions section. When the model omits one, `ensureFaqSection` appends it with guidance to write 5-8 questions and a complete answer for each. It is an ordinary card after that: delete it with the card's × and nothing puts it back.

**Length drives the outline.** `generateArticleBrief` takes an optional `targetWords`. Content Writer passes the word count you typed, or `auto` when you left it blank — `auto` resolves to the median length of the top-ten pages that already rank, clamped to 600-3000 words to absorb navigation noise in the scrape. The brief then plans `round(target / 200)` H2 sections, clamped to 4-12, plus the mandatory FAQ, and each section states the depth it must be written to. Fewer, deeper sections are preferred over many thin ones. Article Recommendation passes no `targetWords`, so its prompt is unchanged and still asks for 8-12 sections; a test pins this.

**One planning pass, on Claude Sonnet 5.** After the outline is built, `modules/contentWriter/briefPlan.js` makes a single `claude-sonnet-5` call that decides two things together: where citations, statistics, a quotation and tables genuinely earn their place, and which of your secondary keywords belong to which section. Whole-article budgets apply (at most 8 citations, 2-4 statistics, one quotation, two tables); most sections get nothing, and no table or quotation is ever placed on the FAQ. Chosen sections gain a `CSQAF:` block in their guidance that you can edit or delete like any other text.

Keywords are not force fitted. A secondary keyword is assigned only where it is genuinely what that section is about; one that has no natural home is left out and reported in a warning naming it, so you can add a section for it or drop it. Each keyword is placed at most once.

This is the only Anthropic caller in Content Writer — everything else runs on OpenAI, and the two stay in separate files. It needs `ANTHROPIC_API_KEY`, and **without it brief generation fails rather than producing an unplanned brief**. The key is checked before the pipeline starts, so a missing key costs nothing: it fails immediately instead of after a search, ten page fetches and four model calls.

**Handoff from Keyword Research.** The "Recommend Article" button in Keyword Research and in the Content Architect Hub & Spoke report opens Content Writer at `/content-writer?keyword=…&secondary=…&client=…` instead of Article Recommendation. The first primary keyword becomes the article keyword; any second primary plus every selected secondary keyword fills the Secondary keywords field; the client selection carries into the client knowledge base. It always begins a fresh unsaved article, so nothing already open is overwritten — work in progress is flushed by the page's own unmount save — and nothing is written until you press Build brief. The handoff parameters are dropped from the URL once applied.

**Generate draft** uses the current saved edits. It performs additional research, retrieves source pages, checks extracted evidence against actual page text, writes with `gpt-5.4-mini`, and audits the draft against the retrieved sources. A failed audit triggers one correction and a second audit. CSQAF guidance covers citations, dated statistics, supported short expert quotations, authority and fluent answer-first writing. Unavailable evidence and missing author/reviewer information appear in Sources & CSQAF notes; identities or reviews must not be invented. These are AI source checks, not a guarantee of factual accuracy. Manual edits change the source-check status and are not automatically reverified.

The writer reproduces each brief heading at its own level and must give every heading body text. FAQ questions are written as headings one level below the FAQ heading, each followed by a complete answer; a question with no answer beneath it is not acceptable output.

Table requests travel to the writer as their own input rather than inside the section guidance, because the guidance blob is the thing the writer is told to strip — that is why tables used to disappear. The word count is a requirement, not a guideline. After the first draft, one deterministic check counts tables and words; if a requested table is missing or the length is outside ±10%, a single corrective rewrite is issued naming every fault at once, so a draft that misses both still costs only one extra call.

Evidence is matched with typography folded — curly quotes, apostrophes and long dashes are compared as their ASCII equivalents. Pages are typeset with those characters while a model re-emitting the text through JSON straightens them, and before this every statistic and quotation carrying an apostrophe silently failed to verify. Folding is strictly one character to one character, because `removeExcerpt` maps folded offsets back onto raw text nodes.

If the second audit still rejects the draft, the article is delivered with the unverified material removed rather than discarded. The checker names the block and exact text behind each rejection, and only those passages are cut; unverified links are removed together with their sentence. Every cut is widened to the sentences it touches, so a rejected clause never leaves a fragment like "but the rest of the claim." behind. A heading whose content is removed entirely goes with it, rather than leaving a question standing with no answer.

**Only claims credited to a source are removed.** Removal requires the passage to name a study, survey, publication, organisation, speaker or expert. Ordinary wording that merely contains a number — a price, a duration, a frequency, a quantity — is not a sourced claim and is never touched: "most people need a cleaning every six months" stays, while "according to the ADA, 42% of adults skip cleanings" must be supported or go. The same rule governs both the checker's prompt and the deterministic fallback used when the checker cannot run; a reporting verb alone is not attribution, so a named subject is required before it.

Note the consequence: **an unattributed figure is no longer verified.** A statistic the model invents without crediting anyone will ship. The source check covers what the article claims to have taken from somewhere, not everything it asserts. Read a draft before publishing it. Where the checker rejects the draft without naming passages, or cannot complete at all, every statistic, quotation and cited claim is removed instead, because there is no way to tell which ones were sound. The status becomes `Unverified claims removed after AI source check`, and each removed passage and its reason is listed in Sources & CSQAF notes. Review those notes before publishing — a stripped article is unverified general explanation, not a checked one. The one case that still fails outright is a draft that stripping leaves empty; the error reports the checker's reasons and the saved brief and existing draft are untouched.

Briefs and drafts autosave to the selected project and can be reopened from Project articles. A Save button is also provided. An optimistic revision counter prevents simultaneous edits from overwriting each other; it does not store historical versions. Regeneration replaces the relevant current brief/draft. Existing drafts are marked stale when the brief changes. Export JSON before discarding local changes after a save conflict.

Drafts support formatted text, links, lists, headings, undo/redo and tables. The paragraph-style menu covers H1 to H6, and every heading in the draft carries its tag as a small badge in the left gutter, in both edit and preview. The badge is drawn in CSS and is not part of the article, so it never reaches the DOCX or JSON export. Preview disables editing. DOCX exports the currently selected brief or draft; JSON exports the whole current document, preferences and source-check details. Exports include unsaved local edits. No Refine, Publish or version-history features are included.

## Setup

- Install the updated client/server dependencies.
- Apply `supabase/migrations/0031_content_writer.sql` using the repository migration runner (`cd server`, then `node scripts/migrate.js`). Review pending migrations with `--status` before deploying.
- Use the existing PostgreSQL/project authentication, `OPENAI_API_KEY`, Google search provider and browser scraping configuration used by Article Recommendation.
- Set `ANTHROPIC_API_KEY` as well. Brief planning runs on `claude-sonnet-5`; without the key, brief generation refuses up front.
- All article APIs check project membership/capabilities via `projectAccess`. Content Writer retains only the current document; it does not copy generated article bodies into the workspace run-history store.

## Verification

```text
cd server
node --test modules/contentWriter/__tests__/contentWriter.test.js
node config/__tests__/registry.test.js
node config/__tests__/moduleRuns.test.js
```

Build the client first, then run `node modules/contentWriter/__tests__/browserSmoke.js` from `server`. The browser smoke test hosts the production client against an isolated in-memory fixture API; it checks editing, generation handoff, autosave/reopen, table editing, DOCX and mobile layout without using real projects or paid providers. Set `CHROME_PATH` if no standard browser installation is available.
