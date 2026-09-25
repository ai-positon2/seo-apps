# What makes Position² agents different: deep-dive slide content

**For:** Nikhil, to build into the Google Slides deck *What Makes P2 Agents Different*. Rajiv presents it to investors.
**Covers:** Content Enhancer, Keyword Research, Article Recommender, Location + Service pages.
**Checked against:** the code on branch `unified-fast-aivisibility`, 24 September 2026. Every claim traces to a file. The references are in the appendix, so anyone doing diligence can check them.

---

## Part 0: Read this before you build (for you, not the slides)

### 0.1 How each slide is written up

Every slide below has the same blocks:

- **Headline / sub-headline.** Short, declarative, in the voice of the existing deck.
- **On slide.** The copy that goes on the slide. It is kept to one message and groups of three, with nothing smaller than 18pt, per the Position² brand rules.
- **Visual.** The layout, using the existing deck's cards and process flows.
- **Speaker notes.** The "teach me" layer Rajiv asked for. This is where the depth lives. The slides stay clean.
- **If asked.** Likely questions and the true answer.

Each agent gets three main slides:
1. The problem, and what we learned.
2. How it works.
3. What it's worth.

Each agent also has appendix slides for diligence. Three opening slides answer Rajiv's cross-cutting questions: *why not just ask ChatGPT*, *where does the data come from*, and *how much is the model versus us*.

### 0.2 Fix these before Rajiv sees the deck

These are ranked by how much damage each would do in diligence. The investor brief (`docs/Prompts/investor_deck_brief.md`) says the audience "will run technical diligence". Each item below is something a diligence team would find in an afternoon.

#### 1. The Content Enhancer case study describes a different tool, and the tool you named can invent quotes

The case study slide (slide 6) describes `/content-enhancement`, not `/article-enhancement`. That slide lists:
- "Diagnose: Structure / Authority / Schema / Entity, scored"
- "A · Baseline, deterministic"
- "B · AI pass"
- "merges per section, falls back to A"
- "Citations: real URLs"
- "Expert-quote script"
- "Author bio" and "JSON-LD"

`/content-enhancement` is a separate tool. It is not in the sidebar, it was last changed in June, and its research is written for dental topics: it has a hard-coded "dental sealants" profile and uses CDC/ADA search terms. None of the parts listed above exist in `/article-enhancement`.

`/article-enhancement` does something different, and it is good work:
- It researches two ways: it reads the Google top 10, and it asks four AI models the same question.
- It works out what the page is missing.
- It inserts only the missing pieces into the existing article. Every original sentence is kept, and every addition is highlighted.

The problem: its writer prompt tells the model to insert statistics "(Source, Year)" and direct quotes "As [Full Name], [Credential] at [Organisation]". Nothing supplies those facts, and nothing checks them (`server/routes/articleEnhancement.js:1598-1602, 1659`).

So "Nothing invented: every source is fetched, not generated" is the **opposite** of what this code does. Run it on one article and you will get a quote that nobody said. That is a risk to clients, not just to the deck.

- **What I did:** the Content Enhancer slides below describe `/article-enhancement` as it really works. Where a claim depends on a fix, both versions are given: **say today** and **say after the fix**.
- **The fix (engineering):**
  - **Option a, small:** copy the no-invention guard from the hidden Lite version (`server/routes/articleEnhancementLite.js`). The model may mark where a statistic or quote is needed, but may not write one.
  - **Option b, stronger:** bring over `/content-enhancement`'s evidence search, so statistics and citations come from pages it actually fetched, with the URL attached.
  - Do option a before the pitch. Option b gives the better story.

#### 2. Claims to reword

| Slide | Current wording | What the code does | Use instead |
|---|---|---|---|
| 2 (Content Enhancer) | "what AI engines surface" / "today's AI answers" | Asks four OpenAI models the same question through the API. It does not look at ChatGPT the product, Perplexity or Google AI Overviews. | "what AI models say when asked the same question" |
| 6 (Content Enhancer) | "Diagnose: Structure / Authority / Schema / Entity, scored pass/fail + severity" | Not in this tool (it is `/content-enhancement`) | "Finds the gaps: topics the top 10 pages cover that this page doesn't, and ideas AI models raise that it misses" |
| 6 | "A · Baseline, deterministic" / "B · AI pass" / "merges per section, falls back to A" | Not in this tool | "Keeps every original sentence, adds only highlighted insertions, then checks the result against 12 answer-engine criteria" |
| 6 | "Citations: real URLs", "Statistics: real sources", "Expert-quote script", "Author / reviewer bio", "JSON-LD schema" | None of these are produced, and the page's existing JSON-LD is stripped when it is read | "Direct answers · comparison tables · FAQ block · answer-first openings". After the fix, add: "marked slots for sources and expert quotes, filled by your team" |
| 6 | "Nothing invented: every source is fetched, not generated" | Contradicted by the code | Remove until the fix ships |
| 3 (Keyword Research) | "two primary keywords that belong together on one page" | Nothing tests whether the two belong together. The model is told to make them *distinct angles* on the same seed. | "two primary keywords that match the searcher's exact intent, chosen from real competitor ranking data" |
| 4 (Article Recommender) | "what AI engines reference" / "concepts AI answers include" | No AI answers are used. People Also Ask questions are fetched and then thrown away. | "what the top 10 pages agree on, and what they all miss" |
| 4 | "one blueprint better than all of them put together" | Not measured | "covers what most of the top 10 cover, plus the gaps none of them fill" |
| 7 (GeoScale) | "WP Render" | No WordPress publishing. It exports a Word doc, HTML, JSON and schema. | "Client doc · Page JSON · HTML" |
| 7 | "renders directly into the existing design system" | The JSON is shaped for a CMS import, but no renderer exists | "structured JSON, ready for CMS import" |
| 7 | "1 agent · 3 engines · 4 human gates" | The four named gates exist only in the older Neuro Wellness engine. The Gentle Dental flow has three human checkpoints: choose the page, approve keywords (saved), review the page. | "1 agent · 26 steps · 20 quality checks · 3 human checkpoints" |
| 7 | "Local demand" | Search volume for city-named searches, from US-wide data (not city-targeted results) | "Local demand: search volume for this city's searches" |

#### 3. The knowledge base is mostly empty templates

Rajiv asked how much is "our KB". Here is where it stands:

- **Empty templates.** Every brand file (Gentle Dental, Clear Behavioral Health, Great Lakes, Neuro Wellness Spa, New Life House, Riccobene), both industry files, and the keyword and article best-practice files hold only `<!-- Add: ... -->` placeholders. The Gentle Dental client-feedback file contains the word "test".
- **One real KB.** The **SEO/GEO article enhancement framework** (about 1,400 words) is used by the Content Enhancer.
- **Keyword Research and Article Recommender** load a KB only when a client is passed in the URL. The client selector was removed in July, so normal runs load none.
- **Location + Service** never reads the KB.

The honest answer to Rajiv: **our expertise sits in the rules, not the KB.** It is in rules written into the code (filters, scoring, limits, quality checks) and in rules the SEO team wrote into the prompts. The slides below say exactly that, and it holds up. Don't claim a brand knowledge base per client until the files are filled in.

I could only check the repo. If the team has filled KBs on the production server through the KB editor, confirm with whoever maintains it.

#### 4. Names, and a stray line of text

- **"P2" should be "Position²"** (brand rule). This affects the title slide and the "P2 AGENT" labels on the cards.
- **The deck says "Arena" and "GeoScale"**, but the product and the investor brief say **"SEO Studio"**. Pick one name before Rajiv presents.
- **Slide 7 has a hidden text box that reads "ChatGPT can make mistakes. Check important info."** It was pasted from ChatGPT. It doesn't show when the slide is rendered, but it is in the file, and it shows up in text exports. Delete it.
- **Maturity tags in the product.** `/article-enhancement` is tagged "Internal Only" and Location + Service is tagged "Internal Testing". If there's a live demo, those tags will be on screen.

#### 5. Numbers

- **All time figures are your team's estimates**, as you confirmed. Every slide below labels them "estimated".
- **I kept the deck's figures**, so the deck agrees with itself and with the investor brief:
  - Keyword research: 30 → 5 min
  - Brief: 60 → 10 min
  - Content writing: 120 → 15 min
  - Content Enhancer: 2–3 hours → about 10 min
- **You said "20 minutes"** for how long Keyword Research and Article Recommender take by hand. That conflicts with the 30 and 60 minutes already in the deck and the brief. **Tell me if 20 minutes should replace one of them.**
- **Run times are logged.** Production records every run's duration (`tool_runs.duration_ms`). One read-only query would turn "about 10 minutes" from an estimate into a measured median. Do this before diligence.

### 0.3 Engineering fixes that would make stronger claims true

These are ranked by value to the pitch. The first one is a must. The others upgrade a "say today" line into a stronger one.

1. **Content Enhancer: stop the model writing statistics and quotes.**
   - Copy the Lite guard.
   - Better still, bring over `/content-enhancement`'s fetched-evidence search.
2. **Article Recommender: feed in AI answers and People Also Ask.**
   - The search provider already returns People Also Ask questions, but the code throws them away.
   - The Content Enhancer already has the code that asks four AI models.
   - Together these make "concepts AI answers include" true.
3. **Keyword Research: move rules out of the prompt and into code.**
   - Re-join the chosen keywords to the SEMrush data in code, so the volumes shown can't drift.
   - Add the gates the Location agent's keyword engine already has: a primary keyword must contain the seed's terms, plus a separate reviewer call.
4. **Location + Service: tighten the Gentle Dental flow.**
   - Save the page approval (today "Confirm" is not stored).
   - Wire the Gentle Dental prohibited-claims list, which is already seeded, into the prompt and the quality checks.
   - Add the duplicate-content check the Neuro engine already has.
5. **Fill the brand KBs** for the clients named in the case studies.

### 0.4 Suggested running order

This is 15 main slides, about 90 seconds each, which fits a 20–25 minute slot with room for questions.

| # | Slide | Replaces in the current deck |
|---|---|---|
| 1 | Title: *What Makes Position² Agents Different* | Slide 1 (fix "P2") |
| 2 | 1.1 Why not just ask ChatGPT? | New |
| 3 | 1.2 Where the data comes from, and how every agent works | New |
| 4 | 1.3 How much is the model? | New |
| 5 | 2.1 Content Enhancer: the problem | Slide 2 |
| 6 | 2.2 Content Enhancer: how it works | Slide 6 (upper half) |
| 7 | 2.3 Content Enhancer: what it's worth | Slide 6 (results and chart) |
| 8 | 3.1 Keyword Research: the problem | Slide 3 |
| 9 | 3.2 Keyword Research: how it works | New |
| 10 | 3.3 Keyword Research: what it's worth | New |
| 11 | 4.1 Article Recommender: the problem | Slide 4 |
| 12 | 4.2 Article Recommender: how it works and what it's worth | New |
| 13 | 5.1 Location + Service: the problem | Slide 7 (bottleneck) |
| 14 | 5.2 Location + Service: how it works | Slide 7 (the run) |
| 15 | 5.3 Location + Service: what it's worth | Slide 7 (results and chart) |
| 16 | Close: Let's Connect | Slide 8 |
| A1–A8 | Appendix | New, and never projected |

The "Case Studies" divider (current slide 5) is no longer needed. Each agent now carries its own proof.

---

## Part 1: Opening section (3 slides)

Put these right after the title slide. They answer Rajiv's three questions once, so the agent slides don't have to repeat them.

---

### Slide 1.1: Why not just ask ChatGPT?

**Headline:** Anyone can ask a chatbot.
**Sub-headline:** It sounds right. It doesn't know what ranks.

**On slide.** Three cards. Each has a failure on top and our answer below.

| It guesses | It invents | It grades its own work |
|---|---|---|
| Writes from memory, not from what ranks today. So everyone gets the same generic page. | Makes up statistics, quotes and sources that read exactly like real ones. | Asked to choose *and* check, it approves itself. It can't count its own words. |
| **Ours start from live evidence:** the current Google top 10, the pages themselves, and real ranking data. | **Ours keep facts where they belong:** office addresses and phones come from the record, keyword candidates from SEMrush, and edits are highlighted for a person to verify. | **Ours check in code:** separate reviewer calls, measured limits, and a person who approves. |

**Visual.** A 3-card grid, using the existing "MOST TOOLS / P2 AGENT" card style stacked vertically in each card: grey failure on top, blue gradient answer below.

**Speaker notes**

"Before I show you the agents, here is the problem they solve. Every one of these failures is something we hit in live client work, and each one changed the code.

- **Generic.** A chatbot answers from what it learned in training. It has never seen today's search results for your keyword, so it writes the average page. Average pages don't rank, and AI answers don't quote them.
- **Invented facts.** Our engineers wrote a note in the code that says it exactly: *invented facts read exactly like real ones.* A made-up statistic looks the same as a real one. On a healthcare client's page, that is a liability. So on location pages, the address and phone number come from the office record, never from the model. The model is told it may not write prices, credentials or patient reviews, and any missing fact is flagged for the client to supply. *(Say "every agent works this way" only after the Content Enhancer fix in Part 0 ships.)*
- **Self-approval.** When we asked one model call to choose keywords and then confirm its choice, it kept confirming itself. The code comment reads: *a single call asked to both choose and vouch for its choice reliably self-approves.* We even caught the checker marking a keyword list 'OK' while listing its failures. So the checker is now a separate call, and code re-derives its verdict.
- **It can't count.** Our own prompt's arithmetic asked for up to 1,023 words on a page capped at 900. Meta descriptions came back cut off mid-sentence: '... Ask our.' The lesson, written in the code: *models cannot count their own output reliably, but they correct well when handed the real numbers.* So code measures, and the model only corrects.
- **Drift.** A Derry, New Hampshire page picked up the keyword 'veneers manchester nh', a rival city. A 'Veneers' page pulled in 'vanguard dental'. A keyword quota produced sentences like 'Invisalign Boston patients trust…'. Each of these is now a rule in code: rival cities blocked, topic terms required, no keyword quota."

**If asked**

- *"Couldn't a good prompt fix all this?"* Some of it, and we use good prompts. But a prompt is a request, and code is a guarantee. Where a rule can be measured (length, city names, rival cities, keyword placement), we moved it into code, because the model ignored prompts often enough to matter.
- *"Aren't you just using ChatGPT underneath?"* We use OpenAI and Anthropic models the way a car uses an engine. The next two slides show what surrounds them.

---

### Slide 1.2: Where the data comes from, and how every agent works

**Headline:** The model is one step. The method is the rest.
**Sub-headline:** Every agent runs the same line: evidence first, writing last, checks after.

**On slide.** A five-step process flow, colour-coded by who does the work:

1. **Fetch** *(our code)*: live Google results, the competitor pages themselves, SEMrush ranking data.
2. **Filter** *(our code)*: our rules drop what doesn't belong. Directories, rival cities, off-topic pages.
3. **Decide** *(model, inside our rules)*: picks, plans and prioritises from the evidence we hand it.
4. **Write** *(model, to our limits)*: drafts copy to fixed structures and word budgets.
5. **Check** *(code, then a reviewer model, then a person)*: nothing ships without a human.

Strip along the bottom, "Data we license": **SEMrush** (keyword volumes and rankings) · **Google search results** (Google's search API, with Serper as automatic backup) · **live competitor pages** (read directly) · **OpenAI and Anthropic models**.

**Visual.** Use the existing numbered-box flow from slide 6/7. Colours: code steps in Endeavour blue, model steps in Royal Purple, the human step in Elf Green. Put a legend under the flow: *blue = our code · purple = model · green = person*.

**Speaker notes**

"Here is the whole architecture in one line. It's the same for all four agents.

- **Fetch:** code, before any AI runs. We pull the live Google top 10 for the search, open those pages and read them, and pull SEMrush data on what each competitor page ranks for. That gives the model hundreds of real data points, not a blank page.
- **Filter:** our rules, in code. This is where twenty years of SEO judgement becomes mechanical. Directory sites like Yelp and Healthgrades get down-weighted, because they're not real competitors for a clinic's page. A dental page in Derry can't target Manchester keywords. 'Near me' keywords are dropped, on our rule that a real local keyword with low volume beats a high-volume 'near me' one. What the filter removes never reaches the model.
- **Decide:** this is where we do use the model's judgement, on purpose. Choosing which two keywords a page should target is a language judgement. But the model chooses from our filtered list, under written rules, and its answer is checked afterwards.
- **Write:** comes last. By the time the model writes a sentence, the structure, the keywords, the headings and the word budget are already fixed.
- **Check:** code first wherever the rule can be measured. A second, separate model call where it can't. Then a person. No agent publishes anything.

On data: we license it and we say so. SEMrush for keyword data, Google's search API for results, with a second provider that takes over automatically when Google's quota runs out. What's ours is the method on top. The sources are replaceable, and we've already built the fallback."

**If asked**

- *"Do you use Ahrefs?"* No. Our data comes from SEMrush and the Google search results. (Don't imply an Ahrefs integration; the investor brief rules it out.)
- *"Is any of this proprietary data?"* No, and we don't claim it is. What's proprietary is the rules and the workflow. The data is licensed and replaceable.
- *"What market do the numbers cover?"* US English search, today. That's a setting, not an architectural limit.

---

### Slide 1.3: How much is the model?

**Headline:** About three-quarters of each agent is our code.
**Sub-headline:** The model writes in a handful of steps, from evidence we fetched, under rules we wrote.

**On slide.** Two large stat callouts, then a small table.

- **73–85%** of each agent's code is our own logic: fetching, filtering, scoring, limits, checks.
- **~15% or less** of the steps in any agent are the model writing copy.

| Agent | Steps | Model writes copy | Model makes a guided choice | Person approves |
|---|---|---|---|---|
| Content Enhancer | 26 | 4 | 8 | editor reviews every change |
| Keyword Research | 14 | 0 (one-line reasons only) | 4 | strategist edits the picks |
| Article Recommender | 13 | 2 | 2 | writer uses the brief |
| Location + Service | 26 | 2 | 3 | 3 checkpoints |

**Visual.** A large-stat callout pair (60–72pt numbers) over a four-row table. Header row in Endeavour, row labels bold.

**Speaker notes**

"You asked how much is a straight model query and how much is us. Here it is, measured from the code, not estimated.

- **We counted two ways.** First, every step each agent runs. Second, every line of code, split into our logic and the text of the prompts we send the model.
- **Our logic is 73 to 85 percent of the code** in every agent. It fetches the search results, reads the pages, scores competitors, applies our filters, measures the output and runs the quality checks.
- **The model writes copy in about 15 percent of the steps or fewer.** In the location-page agent it's two steps out of 26.

I want to be precise about what that doesn't mean. The model does more than write. In a few steps we deliberately use it for judgement: choosing the two keywords, deciding which competitor headings are worth covering, spotting gaps. Those are language judgements, and a model is good at them. But it makes them from evidence we fetched and filtered, under rules our SEO team wrote, and a separate step checks the result.

So the honest summary: the model is the engine; the car is ours. Swap OpenAI for Anthropic and the agent still works. We've already done that in places. Take away our rules and you have a chatbot."

**If asked**

- *"Earlier you said 80/20."* That was about content writing, and it holds: writing is about 15 percent of the steps or fewer in every agent. The code split is 73–85 percent ours. The appendix has the method, so anyone can recount it.
- *"Where exactly does your expertise live?"* In three places. Rules in code: filters, scoring weights, limits, 20 quality checks on location pages. Rules the SEO team wrote into the prompts: what a primary keyword must satisfy, what an FAQ answer must do. And an SEO/GEO enhancement framework the Content Enhancer applies to every page.
- *"What if the model provider raises prices or changes the model?"* Switching models is a small change, not a rebuild. The location agent already uses an Anthropic model to plan and an OpenAI model to write, and the Content Enhancer can draft its recommendations with OpenAI, Anthropic or Google models.

---

## Part 2: Content Enhancer (3 slides)

These slides replace deck slides 2 and 6. The tool is `/article-enhancement`, labelled **"Enhance Existing Article"** in the product.

---

### Slide 2.1: The problem, and what we learned

**Headline:** The page already ranks. AI answers still skip it.
**Sub-headline:** The Content Enhancer adds what's missing, and leaves what works alone.

**On slide.** One line on the problem, then the existing two-card comparison:

> An existing page has earned its rankings and its links. AI answers still pass it over. It has no direct answer up top, no table, no FAQ, and it skips topics its competitors cover. Fixing one by hand takes 2–3 hours, so the backlog never clears.

| MOST TOOLS | POSITION² AGENT |
|---|---|
| Score the page against the top results and leave the fix to a writer. Or rewrite sections for you, including text that was already working. | Keeps every original sentence. Adds only what's missing, based on two kinds of evidence, and highlights every addition so an editor reviews the changes, not the whole page. |

**Visual.** Same layout as the current slide 2: body text on top, grey card left, gradient card right.

**Speaker notes**

"Most content work isn't new pages. It's the hundreds of pages a client already has, pages that took years to rank.

**Why we only add, and never rewrite.** A page that ranks has signals Google already trusts. A wholesale rewrite throws those away, and it forces an editor to re-read every word. So our rule is blunt: existing text stays word for word. The model may only insert, and every insertion is marked. The editor's job shrinks from reviewing a page to reviewing the green.

**What 'missing' means. We use two kinds of evidence:**
1. **What the Google top 10 covers.** We read up to ten competitor pages, list the topics each one covers, and count. If six or more competitors cover a topic and we don't, that's a high-priority gap. Three or more is medium.
2. **What AI models say.** We ask four different AI models the question a searcher would type. We pull out the ideas each answer raises, and check which ones our page already covers. That's our read on what an AI answer expects to find.

Why both? Google rewards covering what ranks. AI answers reward pages that answer directly and are easy to quote. A page can pass one test and fail the other.

**What we learned building it.** These are real, and each is fixed in the code:
- **Headings and highlighting.** Early versions re-added the same headings three or four times, and marked whole articles as new. Now the model isn't allowed to add headings, and it may tag only its own insertions.
- **The framework.** This is our SEO/GEO enhancement framework, the rules our SEO team wrote. At first it was being cut to 6 percent of its length before it reached the model. When we fixed that, the model ignored it, because it sat at the end of the prompt. It now goes first, marked mandatory.
- **Messy pages.** One blog read as 3,406 words when the article itself was about 1,300. The rest was menus and widgets, and the model wrote an FAQ about the navigation. Reading a page now takes four stages, plus a check that errs on the side of keeping text.
- **Keyword stuffing.** A prompt that opened with restrictions produced stuffed pages. Opening with a priority list of what to add fixed it."

**If asked**

- *"Surfer and Semrush already rewrite pages."* True. Surfer's Auto-Optimize rewrites intros and facts, and Semrush has an Optimize button. Ours is a different design choice: we never rewrite an existing sentence, we only insert and highlight. For a page that already ranks, that's the safer default, and it makes review faster.
- *"Is 'what AI models say' the same as what ChatGPT shows users?"* Not exactly. We ask the models directly, through their APIs, not the ChatGPT app or Google's AI Overviews. It tells us which ideas the models associate with the question. Our separate AI Visibility module measures what the consumer products actually show.

---

### Slide 2.2: How it works

**Headline:** Two kinds of evidence. One set of rules. Only green changes.
**Sub-headline:** One page in. The same page out, with every addition marked.

**On slide.** A six-step flow:

1. **Read the page** *(code)*. Strip menus, widgets and footers, and keep the article.
2. **Research** *(code + model, run in parallel)*. Read the Google top 10 competitor pages, and ask four AI models the searcher's question.
3. **Find the gaps** *(code counts, model compares)*. Topics competitors cover that we don't, ranked by how many cover them. Ideas AI answers raise that we miss.
4. **Insert** *(model, under our rules)*. Our SEO/GEO framework comes first. Per section: at most 2 data points, 1 quote, 1 table or list, and 200 new words. No new headings.
5. **Add structure** *(model)*. An FAQ of 4–6 questions, answer first, if the page has none.
6. **Check** *(model + code, then an editor)*. 12 answer-engine criteria. An editor reviews every highlighted line.

Strip along the bottom: **Per page:** 1 article read · up to 10 competitor pages read · 4 AI models asked · ~32 model calls · 12 criteria checked

**Visual.** The numbered-box flow from current slide 6. Use the colour legend from slide 1.2.

**Speaker notes**

"Step by step:

- **Reading the page is harder than it sounds.** Real pages are full of menus, sidebars, cookie banners and 'related posts'. Four passes of code strip them. A final check, done by the model, can only remove a block when it's sure. When in doubt, it keeps the text.
- **Research runs two ways at once.** The Google side reads the actual competitor pages, not just their titles. We drop social sites, forums and PDFs, because they aren't the competition for an article. The AI side asks four models and extracts 5–10 concrete ideas from each.
- **Code counts the gaps.** A topic 6 of 10 competitors cover is 'high'. The model only judges whether our page already covers something, by meaning rather than exact words.
- **Insertion follows our framework.** A few of its rules:
  - Answer the page's question in the first 150 words.
  - Snippet-style answers of 40–60 words.
  - Keyword density between 0.5 and 1.5 percent.
  - Reading ease in the 50–70 band.
  - Add a table whenever a section compares options, lists costs, describes a process or timeline, lists symptoms, or weighs pros and cons.
- **Why the caps.** Without them, the model 'improves' every paragraph and the page bloats. 'Be surgical, not exhaustive' is written into the rules.
- **Why one writing model.** Up to three models (OpenAI, Anthropic, Google) can draft the recommendations, and we merge them. But only one model edits the page, because merging several models' edits broke the word-for-word guarantee.
- **What comes back:**
  - the enhanced article, with every addition in green
  - a Word file with the highlights and real tables
  - an analysis tab showing what competitors cover versus us, with counts
  - the recommendations
  - a 12-point coverage table"

**Statistics and quotes: choose the line that matches the code on the day**
- **Say today:** "Where a section needs a data point or an expert view, the draft proposes one, highlighted. The editor must verify it against a real source, or delete it, before anything publishes."
- **Say after fix a** (Lite guard): "The model isn't allowed to write a statistic, a quote or a citation. It marks where one belongs, and our team supplies a real one."
- **Say after fix b** (evidence search): "Statistics and citations come only from pages the agent fetched, with the URL attached."
- **Don't say "nothing invented" today** (see Part 0, item 1).

**If asked**

- *"How do you know it didn't change the original text?"* Every insertion is highlighted, so a reviewer sees exactly what was added. The rule itself is in the model's instructions today. Our Lite version already enforces it in code: it reverts any section where more than 12 percent of the original sentences go missing. We're bringing that guard into this tool.
- *"Which market?"* US English Google results today.

---

### Slide 2.3: What it's worth

**Headline:** 2–3 hours of research and drafting, down to about 10 minutes.
**Sub-headline:** Our team's estimate. The editor's review stays.

**On slide**

Three stat panels:
- **2–3 hrs**: by hand (estimated)
- **~10 min**: agent run (estimated)
- **Up to 14 sources**: 10 competitor pages and 4 AI models, checked for every page

Card, "What stays human": the editor reviews every highlighted addition, verifies any data point or quote, and approves. Nothing publishes itself.

Small capability table. This compares what each tool does, not how fast or how well:

| | Keeps every original sentence | Uses the top-ranking pages | Uses AI-model answers | Writes changes into the page |
|---|---|---|---|---|
| **Position² Content Enhancer** | Yes, insert-only by design | Yes (top 10, read in full) | Yes (4 models) | Yes, highlighted |
| Surfer (Auto-Optimize) | No, rewrites intro and facts | Yes (top 20 for Facts) | Yes | Yes, accept or reject |
| Semrush (Content Optimizer) | No, automatic rewrites | Yes (top 10) | Partial | Yes |
| Clearscope · MarketMuse · Ahrefs AI Content Helper | n/a: they score, you write | Yes | Partial / not documented | No |

**Visual.** Stat panels on the left, like the "THE RESULTS" bar on current slide 6. Table on the right in the brand table style: Endeavour header row, alternating grey rows.

**Speaker notes**

"The time figure is our team's estimate.

- **By hand**, the job is: read the page, open ten competitors, note what each covers, check what AI tools say, draft the additions, then format the tables and FAQ. That's two to three hours. For context, Orbit Media's 2026 survey of 1,042 bloggers puts the average blog post at 3 hours 20 minutes to write. Improving an existing page is less than writing one, and our estimate sits below that.
- **With the agent**, it's about ten minutes of machine time, plus the editor's review.

On a backlog of 100 pages, saving about two and a half hours a page frees roughly 250 hours of strategist time. That's an illustrative figure from our estimate, not a measured one.

**Why it matters.** This is third-party research, and we cite it as such:
- Ahrefs found a top-ranking page gets 58 percent fewer clicks when an AI Overview appears (February 2026).
- Seer Interactive found that on informational searches, brands cited in the AI Overview got about twice the click-through of brands that weren't (April 2026).
- The GEO research paper (Princeton and collaborators, KDD 2024) found that adding statistics, quotations and citations raised a page's visibility inside AI answers by 30–40 percent.

That last finding is exactly why those additions must be real. A fabricated one is a liability.

**On the competition, be generous.** Surfer and Semrush now write changes into pages too, and Surfer draws facts from AI answers. Our choices differ: we insert rather than rewrite, we highlight every change, and we base gaps on counted competitor coverage plus four AI models, under our own framework. I'd rather show you the output side by side than claim it's better."

**If asked**

- *"Is 10 minutes measured?"* It's our team's estimate. Every run's duration is logged, so we can give you the measured median. `[FILL: median run time for article-enhancement from tool_runs]`
- *"What does it cost to run?"* `[FILL: if Rajiv wants it. Not tracked per run today.]`

---

## Part 3: Keyword Research (3 slides)

These slides replace deck slide 3.

---

### Slide 3.1: The problem, and what we learned

**Headline:** Most tools hand you a hundred keywords. This picks two.
**Sub-headline:** The job was never finding keywords. It's deciding which two a page should own.

**On slide**

> A keyword export has hundreds of rows. The expensive part is the judgement: which searches share one intent, which ones drop half the topic, which "competitors" are really directories or blogs. Get it wrong and the page chases two jobs and does neither.

| MOST TOOLS | POSITION² AGENT |
|---|---|
| List, filter and sort. The best tools group keywords by shared search results and suggest one per group. The page decision is left to you. | Reads who actually ranks, pulls what they rank for, and commits: **2 primary and 10 secondary keywords**, a reason for each primary. It says so when the data can't support a good pick. |

**Visual.** Same layout as current slide 3.

**Speaker notes**

"**Why two.** A primary keyword is the search you want this page to win. Two covers the two most common phrasings of one intent. More than that, and the page starts serving different searchers. `[Nikhil: confirm this wording of the 'why two' rule with the SEO team.]`

**The classic mistakes. We hit every one of these, and each is now a rule:**
1. **Wrong intent.** A 'how to choose X' page got matched to 'best X' comparison keywords. Same noun, different searcher. The rule now reads: *a shared topic noun is not a shared intent.*
2. **Half the topic.** For a seed like 'forklift battery', a keyword about 'battery' alone drops the part that makes the page specific. Now every part of the seed must survive.
3. **Fake competitors.** For a service search, the top 10 is crowded with directories (Yelp, Healthgrades, Zocdoc) and blog posts. They aren't the competition for a clinic's service page, so our scoring discounts them before any keyword is pulled.

**Where we started.** The first version was essentially the ChatGPT approach: three search results, ten keywords from each, one prompt saying 'select the best keywords'. It picked plausible keywords with the wrong intent. Everything since is what we added on top."

**If asked**

- *"Keyword Insights and Semrush already cluster keywords and pick one."* Yes. Clustering by shared search results and picking a 'best keyword per cluster' both exist, and we credit them. The difference is the output. They give you a map and leave the page decision to you, and their own docs say so. Ours commits to a decision for one page, with reasons, and it can refuse.
- *"Where do the volumes come from?"* SEMrush's US database. The model is handed the volumes; it doesn't estimate them.

---

### Slide 3.2: How it works

**Headline:** From six searches to two keywords.
**Sub-headline:** Our code narrows the field. The model decides inside our rules. A second check argues back.

**On slide.** A funnel, wide at the top:

1. **6 searches.** Your keyword plus 5 variations the model writes, strictly inside the chosen intent.
2. **~60 results → 10 real competitors** *(code)*. Scored on position, page type, keyword match and buying signals. At most 2 per site. Directories and blogs are discounted.
3. **300 keywords they rank for** *(SEMrush)*. The top 30 per competitor page, with volume and difficulty.
4. **40 best matches** *(model scores meaning, code ranks)*. 80% meaning, 20% volume.
5. **2 primary + 10 secondary** *(model, under our rules)*.
6. **Second check** *(a separate model call)*. Re-checks every pick word by word. It replaces failures, or warns.
7. **Strategist edits and approves** *(person)*.

**Visual.** A vertical funnel with numbers large (6 → 60 → 10 → 300 → 40 → 2 + 10). Use the slide 1.2 colour legend.

**Speaker notes**

"**The competitor scoring** is our formula, in code:
- 35 percent search position, 30 percent page type, 20 percent how many of your words appear, 15 percent buying signals such as 'cost', 'price', 'book' and 'near me'.
- On page type, directory sites score 0.2.
- Blog-style addresses score 0.4.
- Titles that start 'what is' or 'how to' score 0.3, even when the address looks like a service page.

**The keyword ranking** leans heavily on meaning: 80 percent how closely the keyword matches the seed's meaning, 20 percent volume. That weighting has been through three versions. It now leans so far toward meaning that a big but loosely related keyword can't win on volume alone.

**The rules for a primary keyword:**
1. Same core intent: a 'process' search is not a 'comparison' search.
2. Every part of the topic survives.
3. Right intent.
4. The two primaries must be genuinely different angles, not near-duplicates.

**Secondaries** have banned words by intent. A commercial page can't take 'what is', 'how to', 'guide', 'statistics' or 'news'. An informational page can't take 'price', 'buy' or 'near me'.

**Seven hard rejections the model must apply:**
1. Branded or competitor keywords
2. Navigational searches
3. Intent mismatches
4. Near-duplicates
5. Implausibly low demand
6. Volume traps
7. Anything out of the industry

**The second check** is told to return 'insufficient' rather than settle for the least-bad option. When it does, the strategist sees a warning instead of a weak pick.

**What the strategist sees** is every candidate in three tiers:
- **Core:** three or more competitor pages rank for it.
- **Relevant:** two do.
- **Discovery:** one does.

One click sends the primary keyword to our Content Writer."

**If asked**

- *"Does the second check really catch anything?"* It re-checks each pick against the four rules, and it's allowed to reject all of them. Today it's the same model reviewing. Our location-page agent goes further, with a separate reviewer plus code gates, and we're bringing that design here.
- *"Is it the same every run?"* Close, not identical. The data is the same, but the model's choice can vary between runs. That's why a strategist approves the final two.

---

### Slide 3.3: What it's worth

**Headline:** 30 minutes of judgement, done in about 5.
**Sub-headline:** Our team's estimate. Every run also reads more of the market than a person would.

**On slide**

Three stat panels:
- **30 → 5 min**: estimated
- **300**: real keywords weighed per run
- **10**: competitor pages scored, across 6 searches

Capability table (capabilities only; "NF" means not found in public documentation):

| | Groups keywords | Picks a primary | Decides what one page targets | Says when data is too thin |
|---|---|---|---|---|
| **Position² Keyword Research** | Decides per page instead | Yes: 2 primary + 10 secondary, with reasons | Yes | Yes |
| Semrush (Keyword Strategy Builder) | Yes, by shared results | Left to you | Left to you | NF |
| Ahrefs (Keywords Explorer) | Yes (Parent Topic) | Parent Topic | Partial | NF |
| Keyword Insights | Yes, by shared results | Yes, a "best" keyword per cluster | Left to you | Flags irrelevant clusters |

**Visual.** Stat panels on top, table below.

**Speaker notes**

"Rajiv, you asked about insight as well as time. Here's the insight part.

In about five minutes the agent runs six searches, scores sixty results, reads what ten competitor pages rank for, and weighs three hundred real keywords. A strategist with thirty minutes usually checks one search and one export.

The tiers are the insight. Keywords that three or more competitors all rank for are the core of the topic. The ones only a single page ranks for are discoveries worth a look.

The time figure is our team's estimate. Run times are logged, so we can show the measured median."

**If asked**

- *"What stops it picking a keyword with no real demand?"* One of the seven rejections is 'implausibly low demand'. The volume comes from SEMrush, and the strategist sees it next to every pick.

---

## Part 4: Article Recommender (2 slides)

These slides replace deck slide 4. The investor story here is the chain of agents, not this agent alone. Multi-page briefs are standard: Frase reads 20 results, Clearscope 30, MarketMuse thousands. Say that before an investor does.

---

### Slide 4.1: The problem, and what we learned

**Headline:** Copy the top result and you finish second.
**Sub-headline:** The Article Recommender builds from what the whole top 10 agrees on.

**On slide**

> A good brief takes an hour: open ten tabs, note every heading, spot the pattern, find what nobody covers. The shortcuts are worse. Copy the #1 page, or ask a chatbot for an outline written from memory.

| MOST TOOLS | POSITION² AGENT |
|---|---|
| Read the top results and list their headings, terms and questions. You assemble the brief. | Reads the top 10 and keeps a topic only if at least 3 pages cover it. Adds what none cover well. Hands back a writer-ready brief, then checks it for drift. |

**Visual.** Same layout as current slide 4.

**Speaker notes**

"**Why consensus.** If three of the top ten pages cover a topic, Google evidently expects it. A topic only one page has is that page's quirk. So the rule is: a section topic needs three or more pages behind it, and a subtopic needs two.

**Why a brief, not an outline.** Writer-ready means:
- **Each section comes with instructions:** what to say, and which keywords to use.
- **The FAQ follows a strict form:** five to eight questions, each answered in 40 to 80 words, with the answer in the first sentence. That's the shape AI answers like to quote.
- **Headings stay in order:** no skipped levels.

**What we learned.** Briefs were picking up a competitor's tangent as a whole section. A second model call now checks that every heading is a direct part of the keyword's topic. If one isn't, the brief is rewritten using only what the ten pages actually said.

**The chain.** This is the part I'd stress:
1. Keyword Research decides what to target.
2. This agent builds the brief.
3. Our Content Writer drafts from the brief, with its own evidence checks.
4. The Content Enhancer keeps the page current.

Other companies own a piece of that line. We run the whole line."

**If asked**

- *"Does it use AI answers?"* Not yet. It uses the Google top 10. `[After fix 2 in Part 0, say: "It adds People Also Ask questions and what four AI models say, as a separate set of topics to cover."]`
- *"How do you prove the three-page rule?"* The model applies it to the headings we pull from all ten pages. We're moving the counting into code so it can be audited.
- *"Isn't this what Frase or Surfer do?"* Broadly, yes. Reading the top results is standard. What we add is the finished, writer-ready format, the drift check, and the chain into writing.

---

### Slide 4.2: How it works, and what it's worth

**Headline:** Ten pages read. One brief. About ten minutes.
**Sub-headline:** Our team's estimate: an hour of a strategist's afternoon.

**On slide.** A five-step flow, then the chain:

1. **Search** *(code)*: the Google top 10 for the keyword.
2. **Read** *(code)*: each page's headings, FAQ questions and body text. Menus and footers are stripped.
3. **Find the pattern** *(model)*: topics on 3+ pages, subtopics on 2+, recurring angles, common questions, gaps.
4. **Write the brief** *(model, fixed template)*: 8–12 sections, each with instructions and keywords, plus an FAQ of 5–8 questions with 40–80-word answers.
5. **Check** *(a second model call)*: every heading on topic. If not, it rewrites from the ten pages only.

Stat panels: **1 hr → 10 min** (estimated) · **10** pages read per brief

Chain strip underneath: **Keyword Research → Article Recommender → Content Writer → Content Enhancer**

**Visual.** The process flow on top, and the chain as four linked rounded boxes along the bottom.

**Speaker notes**

"**It's a short line, deliberately.** Search, read ten pages, find the pattern, write, check. Three or four model calls in all.

**It warns you when the evidence is thin.** If fewer than five of the ten pages can be read, you get a warning.

**What you get back:**
- the brief, formatted and ready to copy or export to Word
- the ten source pages
- which of those pages were read successfully

**The same engine powers our Content Writer.** The Content Writer adds a planning step, and a drafting step that checks its evidence."

---

## Part 5: Location + Service pages, "GeoScale" (3 slides)

These slides replace deck slide 7. They describe the Gentle Dental flow (`/location-page-builder`). The same engine is set up for Clear Behavioral Health; that brand's facts and limits are data, not new code.

---

### Slide 5.1: The problem, and what we learned

**Headline:** Locations × services = hundreds of pages. Every one has to be local.
**Sub-headline:** Swap the city name on a template, and Google calls it a doorway page.

**On slide**

> **Gentle Dental: 50 offices × 40 services = 2,000 possible pages.** Every one needs its own local research, structure, brand rules, copy and review. That's 3.5 hours each by hand (estimated). The shortcut, one template with the city name swapped, is what Google's spam policy calls doorway pages.

| MOST TOOLS | POSITION² AGENT |
|---|---|
| Location platforms fill a template from listing data (address, hours). AI writers generate pages at scale with little local research. | Researches every location + service pair on its own, with its own local searches and its own competitors, and writes to that. Addresses and phone numbers come from the office record. 20 checks run before a person reviews the page. |

**Visual.** Same layout as the other agent slides. Add a small "50 × 40 = 2,000" graphic: a grid of dots.

**Speaker notes**

"**This is the multiplication problem.** Fifty offices times forty services is two thousand pages. Each one has to be genuinely about that service in that town.

**Why not use a template?** Google's spam policy names it directly. Its definition of doorway abuse includes 'substantially similar pages' targeted at 'specific regions or cities'. Google's March 2024 update cut low-quality, unoriginal content in results by 45 percent, and its scaled-content policy covers AI-written and human-written content alike. So the question isn't how many pages you can make. It's whether each one earns its place.

**What makes a page local in our system:**
- **Its own keyword research.** For example, 'dental crowns derry nh', not a national keyword with the city pasted on.
- **Its own competitors.** The top five pages for that local keyword, excluding the client's own site.
- **Localised FAQs, only where the answer would really differ in another city.** Our rule is literally 'the answer would be different in another city'.
- **The city must appear meaningfully** in the body and in at least two FAQs.

**What we learned. Every item here is a real page and a real fix:**
- A **Derry, New Hampshire** page picked up 'veneers manchester nh', a rival city. The code now blocks other cities, but allows the office's own region and cities inside its name, so 'Boston' is fine within 'South Boston'.
- A **Veneers** page pulled in 'vanguard dental', because nothing checked the topic. Every service now has its own list of on-topic terms.
- **Headings read 'Sealants in Manchester Elm Street, NH'.** Office sub-area labels now resolve to the real city.
- **'Near me' keywords kept winning on volume.** Our rule now: a real local keyword with low volume beats a high-volume 'near me' one.
- **A keyword quota produced 'Invisalign Boston patients trust…'.** The quota is gone. The keyword has to read as English, and code checks it.
- **Meta descriptions came back cut off: '... Ask our.'** Code now trims at a sentence boundary.
- **The reviewer approved its own picks.** It's now a separate call, and code checks its verdict.

**Where 'two decades of expertise' shows up.** It's the rules our team wrote down from twenty years of multi-location healthcare work:
- 'Dental' is added to ambiguous service names like 'Sealants', 'Crowns' and 'Braces', so the search finds dentistry.
- Each page has 6–7 sections, written in the order a patient learns, with one section written specifically for the city.
- AP style throughout.
- Commercial intent without hype: no superlatives, no promised outcomes."

**If asked**

- *"Is this safe from Google's doorway policy?"* We don't claim 'Google-safe', and nobody should. We build each page from its own research, so it's genuinely different, and a person approves it. `[Nikhil: an automated cross-page similarity check exists in the older Neuro engine but not in the Gentle Dental flow; see Part 0 fix 4.]`
- *"What about healthcare claims?"* The model is told it may not write addresses, phone numbers, hours, prices, dentist names or patient reviews, and may not promise outcomes. Addresses and phone numbers come from the office record. The quality checks catch placeholder text. For the behavioral-health client, code also flags prohibited and unverified claims such as prices, insurance, success rates and guarantees.

---

### Slide 5.2: How it works

**Headline:** One location and one service in. A reviewed page out.
**Sub-headline:** 26 steps. The model writes in two of them.

**On slide.** Keep the deck's five coloured columns, with accurate contents:

| 1 INPUT | 2 RESEARCH | 3 BLUEPRINT | 4 CONTENT | 5 CHECK & HAND OFF |
|---|---|---|---|---|
| Location | Local searches: Google top 10 | URL, title, H1, breadcrumb *(code)* | Hero, body, 4–6 FAQs, meta description *(model, fixed budgets)* | 20 quality checks → verdict |
| Service | Competitor keywords: SEMrush, up to 300, plus the client's own list | Office details from the record *(code)* | Code measures, and hands back the real numbers for one correction | **Person reviews, edits, regenerates sections** |
| Brand rules | Our filters → 2 primary + 10 secondary → separate reviewer → **person approves** | Outline from the top 5 local competitors *(model plans, code repairs)*; links to 3 sibling offices | 5 schema blocks *(code)* | Word doc · HTML · JSON · schema |

Bar above the columns: **THE RUN · 1 AGENT · 26 STEPS · 20 QUALITY CHECKS · 3 HUMAN CHECKPOINTS**

**Visual.** The existing five-column layout from slide 7. Mark the two person steps with the green "person" colour.

**Speaker notes**

"Walking the line left to right:

**Input.** A strategist picks the office and the service. The tool shows the page address and title up front, and warns if the page already exists, so the same page isn't built twice.

**Research.** It searches Google, then pulls what the top pages rank for from SEMrush, and adds the client's own keyword list. Our filters then remove:
- rival cities
- off-topic terms for that service
- 'near me'

The model picks two primary and ten secondary keywords. Code then enforces the hard rule: a primary keyword must name both the city and the service. That's not left to the model. A separate reviewer call checks the picks, and code applies its verdict. **Then a person approves the keywords, and that approval is saved.**

**Blueprint.** The address, title, main heading and office details are built by code from the records. The model never writes an address or a phone number.

For the outline, we read the headings of the top five local competitors. The model grades them and plans six or seven sections. Its instruction: *model their subject matter only — never reuse their phrasing, brand names, dentist names or reviews.* If the competitor headings are poor, code falls back to one of three section 'ladders' our team wrote: general, clinical, or practitioner.

**Content.** The model writes to fixed budgets:
- **Paragraphs:** 30–40 words.
- **Page length:** 500–900 words.
- **Meta description:** 150–160 characters.
- **FAQs:** four to six, at least two localised.

Code measures the draft. If it's out of range, the real numbers go back to the model for one correction.

**Check.** Twenty checks, graded critical, major or minor, ending in a verdict: fail, revisions required, conditional pass, or pass. A person then reviews, edits, and can regenerate any single section.

**Hand-off.** A Word document for the client, the page as HTML and as structured JSON, and the schema markup, ready for the site."

**If asked**

- *"Does it publish to WordPress?"* Not directly today. It exports a Word doc, HTML and structured JSON for the web team. The JSON is shaped for a CMS import, and that integration is on the roadmap.
- *"Which models?"* An Anthropic model (Claude Sonnet) picks the keywords and plans the outline. An OpenAI model (GPT-5.4 mini) writes. Swapping either one is a configuration change.

---

### Slide 5.3: What it's worth

**Headline:** A 3.5-hour workflow in about 30 minutes.
**Sub-headline:** 7x faster. 86% fewer expert minutes. The reviewer stays.

**On slide**

Keep the deck's "Time per Page" chart and label it **"Expert minutes per page, estimated"**:
- **Keyword research:** 30 → 5
- **Brief:** 60 → 10
- **Content writing:** 120 → 15

Stat bar: **7x** faster per page · **−86%** expert minutes · **2,000** possible Gentle Dental pages

Capability table (capabilities only; "NF" means not found in public documentation):

| | Research per location + service | Unique body copy per page | Human approval |
|---|---|---|---|
| **Position² Location + Service** | Yes | Yes | Yes: keywords and full page |
| Yext Pages | NF | Template fields, AI-assisted | Yes (review queue) |
| SEOmatic | Partial (Search Console data) | Yes | Yes |
| Agency or freelancer | If scoped and paid for | Yes | Yes |

**Visual.** The chart on the right, as on current slide 7. Stat bar across the bottom. Table in the middle.

**Speaker notes**

"The math behind the headline:
- **Totals:** 210 expert minutes by hand, 30 with the agent.
- **7x:** 210 divided by 30 is seven.
- **−86%:** 180 of 210 minutes saved is 86 percent.

These are our team's estimates, and we label them that way.

**What that means for capacity** (illustrative, from the same estimate): at 30 expert minutes a page, a strategist can finish about twelve pages in a focused six-hour day. A hundred pages is about 50 expert hours instead of 350.

**Cost context.** Freelance writing alone runs about 16 to 40 cents a word (Verblio's 2025 pricing; the Editorial Freelancers Association's 2026 rate chart). That's roughly $80 to $360 for a 500- to 900-word page, before any local research, keyword mapping or review.

**Where others are strong, and I'd say it plainly:**
- Yext and Birdeye bring hosting and a healthcare compliance posture.
- SEOmatic already combines approvals with WordPress publishing.

What we did not find in anyone's public documentation is research per location and service, with the keyword map, local competitors and healthcare rules applied to the body copy itself. That combination is ours."

**If asked**

- *"Where does '100s of pages a month' come from?"* It's arithmetic from the estimate: 30 expert minutes per page, times the team's reviewing hours. It's capacity, not pages shipped to date. `[FILL: pages actually produced to date, from the production database]`
- *"Is it tested?"* The location engine has about 200 automated test cases in the repo.

## Part 6: Appendix slides (for diligence and Q&A)

These sit after the close. Each appendix slide is laid out as a table or tight list: they're read, not presented. They include file references, so a technical reviewer can check any line.

---

### Appendix A1: How we measured "model versus us"

**Headline:** How the 73–85% was counted.

**Two measures, applied the same way to all four agents:**

1. **Steps.** Every stage the agent runs, in order, is classed as one of:
   - **Code:** fetch, parse, score, filter, validate, assemble.
   - **Model, choosing:** plan, extract, classify, select.
   - **Model, writing:** customer-facing copy.
   - **Model, checking:** a model call that judges output.
   - **Person:** a human approval step.
2. **Lines of code.** Non-blank, non-comment lines in each agent's server files, split into two groups:
   - our logic;
   - prompt text plus the code that builds prompts and calls the model.

   Tests and the user interface are excluded.

| Agent | Steps | Code | Model: choosing | Model: checking | Model: writing | Person | Model calls per run | Our share of code lines |
|---|---|---|---|---|---|---|---|---|
| Content Enhancer | 26 | 14 | 7 | 1 | 4 | editor review (not a step in code) | ~32 (about 20 choosing, 11 writing, 1 checking) | 74% (70% excluding Word export and security guard) |
| Keyword Research | 14 | 10 | 3 | 1 | 0 (one-line reasons inside a choosing step) | edit and approve (in the UI) | 4 | 73% of lines (56% by characters, because prompts are long) |
| Article Recommender | 13 | 9 | 1 | 1 | 2 (one only if drift is found) | none in code | 3–4 | 75% |
| Location + Service (Gentle Dental) | 26 | 18 | 2 | 1 | 2 (one only if a correction is needed) | 3 | 4–5 | 85% (whole module: 86%) |

**What the numbers do and don't say**

- **They measure where the work is written, not the running time or the cost.**
- **The model does more than write.** In each agent it also makes guided choices:
  - Keyword Research: which two keywords.
  - Article Recommender: which topics are common.
  - Content Enhancer: what is missing.

  Those choices are made from evidence the code fetched, under rules the team wrote.
- **The Content Enhancer is the most model-heavy of the four:** about 32 calls, most of them analysing the research.
- **The Location agent is the most code-heavy:** its rules sit in code, not prompts.

**Files counted**
- Content Enhancer: `server/routes/articleEnhancement.js`, `server/services/llmProviders.js`, `llmSynthesis.js`, `googleSearch.js`, `kbStore.js`, `modules/contentArchitect/urlSafety.js`
- Keyword Research: `server/routes/keywordResearch.js`, `server/services/googleSearch.js`, `semrush.js`, `intentVocabulary.js`, `kbLoader.js`
- Article Recommender: `server/services/articleBrief.js`, `server/routes/articleRecommendation.js`, `googleSearch.js`, `scraper.js`, `kbLoader.js`, `kbStore.js`
- Location + Service: `server/locationPageBuilder/*.js`, excluding `__tests__` and `data/`

---

### Appendix A2: Content Enhancer in detail

#### The line, stage by stage

| # | Stage | Who | Detail |
|---|---|---|---|
| 1 | Accept the URL | Code | Blocks private or internal addresses. Issues a 2-minute session. |
| 2 | Read the page | Code | Direct fetch. Strips site chrome with 21 boilerplate pattern groups and a 26-selector search for the article container. Prunes link-heavy blocks and cuts at end-of-article signals. |
| 3 | Fallback reader | Code | Uses a reader service for JavaScript-heavy pages. If the page still can't be read, the user can paste the text. |
| 4 | Too-short gate | Code | Under 100 words, the run stops and asks for the text to be pasted. |
| 5 | Boundary check | Model + code | The model names boilerplate blocks. Code keeps everything else word for word, and keeps everything if the model would drop too much. |
| 6 | Depth tier | Code | Under 500 words is thin, under 1,500 moderate, under 3,000 substantial, otherwise comprehensive. Each tier gets its own instructions. |
| 7 | Topic and search query | Model | Written from the title, headings and opening text. |
| 8a | Ask 4 AI models | Model | The same searcher question goes to four OpenAI models. Each answer yields 5–10 concepts. |
| 8b | Google top 10 | Code | Drops the client's own site, social sites, forums and PDFs. Reads up to 10 pages, 3 at a time. |
| 8c | Competitor topics | Model + code | The model lists each page's topics. Code merges them, counts them, and tiers gaps: 6 or more pages is high, 3 or more is medium. |
| 8d | Covered or not | Model, with a code fallback | Judges whether the page covers each topic or concept, by meaning. If the model call fails, it falls back to word overlap. |
| 9 | Load the framework | Code | The SEO/GEO enhancement framework, placed first in the prompt as mandatory. |
| 10–11 | Recommendations | Model | Seven fixed sections. Up to 3 models can draft; the drafts are then merged. |
| 12–13 | Insert, section by section | Model, one writing model | Original text is kept word for word, and every addition is tagged. Caps per section are listed below. |
| 14–15 | FAQ and structure | Code + model | An FAQ is added only if none exists, plus at most one new section. |
| 16 | Clean-up | Code | De-duplicates sentences, normalises tables and markers, keeps the FAQ at the end. |
| 17–18 | Coverage check | Model + code | Grades the 12 criteria below as present, added, or not applicable. |
| 19 | Export | Code | Word file with highlighted additions and real tables. |

#### The rules our team wrote

**Per-section caps.** At most:
- 2 statistics
- 1 expert quote
- 1 list or table (3–5 rows)
- 1 answer-first sentence
- 200 new words

No new headings, no re-defining a term already defined, no keyword stuffing.

**Tables are required** when a section compares options, lists costs, describes a process or timeline, lists symptoms, weighs pros and cons, or has data with several attributes per item.

**FAQ.** 4–6 questions. Answers are 50–150 words and answer-first, with no lists. Skipped if the page already has an FAQ.

**The framework's standards** (`knowledge-base/best-practices/seo-geo-article-enhancement-knowledge-base.md`):
- Title 50–60 characters; meta description 145–155 characters.
- 2–5 internal links.
- A section under 100 words counts as thin.
- The direct answer comes within the first 150 words; answer blocks are 2–4 sentences.
- Snippet answers of 40–60 words.
- 5–10 People-Also-Ask-style questions.
- Keyword density 0.5–1.5%.
- Reading ease (Flesch) 50–70.

**The 12 coverage criteria:**
1. Thin sections expanded or merged
2. Direct answer in the first 150 words
3. Answer blocks of 2–4 sentences
4. Correct list types
5. Factual claims backed by source authority
6. Recognisable authorities, with statistics attributed
7. FAQ section
8. Tables added
9. Citations added
10. Statistics added
11. Quotations added
12. Fluency improved

#### Data and models

- **Page reading:** direct fetch, with the Jina reader as fallback.
- **Search results:** Google's search API, US English, top 10, with Serper as backup.
- **Research models:** gpt-4o-mini, gpt-5.4-mini, gpt-4o-mini-search-preview, gpt-4.1-mini.
- **Writing model:** gpt-5.4-mini.
- **Optional recommendation models:** Claude Sonnet 5 and Gemini 3.5 Flash.

#### Open items to know before diligence

- **Invented facts.** The writer prompt asks for statistics, named-expert quotes and citations, and nothing retrieves or checks them (`articleEnhancement.js:1598-1602, 1659`). This is Part 0 fix 1.
- **Word-for-word preservation** is enforced by the prompt and by highlighting, not by code. The hidden Lite tool has a code guard.
- **The coverage badge in the page header always reads 12/12**, because it shows the number checked, not the number covered (`ArticleEnhancementPage.jsx:818`).
- **The tool catalogue text is out of date.** It still describes a "5-model fan-out (SEO · GEO · Intent · E-E-A-T · UX)" (`client/src/toolCatalog.js:67-68`).
- **Outputs are not saved server-side.** The run history keeps the input and the duration only.

---

### Appendix A3: Keyword Research in detail

#### The line, stage by stage

| # | Stage | Who | Detail |
|---|---|---|---|
| 1 | Accept the seed and intent | Code | Intent is commercial or informational. |
| 2 | Write 5 search variations | Model | Strictly inside the intent. The seed is always search #1. |
| 3 | Google top 10 for each of the 6 searches | Code | 3 at a time, cached for 24 hours. |
| 4 | Score and pick 10 competitor URLs | Code | Uses the rubric below. At most 2 URLs per site. |
| 5 | SEMrush | Code | Top 30 keywords per URL (volume, CPC, difficulty), US database. |
| 6 | Clean the pool | Code | De-duplicates, and counts how many competitor pages rank for each keyword. |
| 7 | Meaning score | Model | Scores every keyword 0–10 for match to the seed. |
| 8 | Composite ranking | Code | 0.8 × meaning + 0.2 × volume. The top 40 go forward. |
| 9 | Pick 2 primary + 10 secondary | Model | Under the rules below, with a one-line reason per primary. |
| 10 | Second check | Model | Word-by-word re-check against the seed. Replaces only the failures, or returns "insufficient" with a warning. Code accepts replacements only when the counts are exactly 2 and 10. |
| 11 | Strategist edits | Person, in the UI | Capped at 2/10. Keywords are tiered Core (3+ competitor pages), Relevant (2) or Discovery (1). |

#### The URL rubric (code)

**Score** = 0.35 × position + 0.30 × page type + 0.20 × seed-word overlap + 0.15 × buying signals.

**Page-type discounts:**
- 17 directory domains (Yelp, Healthgrades, Zocdoc, Avvo and others): 0.2.
- Blog, news and dated addresses: 0.4.
- "What is / how to" titles: 0.3.
- "Explained / overview / FAQ / trends" titles: 0.45.

**Buying words** (13 of them): cost, price, book, near me, best, and others.

#### The selection rules (prompt, written by the SEO team)

**Primary keywords** must pass all four:
1. The same core intent: process is not comparison.
2. Topical completeness: every part of a multi-part seed survives.
3. Intent alignment.
4. The two primaries are genuinely distinct angles.

**Secondary keywords** have banned modifiers by intent:
- **Commercial pages** exclude: what is, how to, why, when, news, trends, statistics, report, study, explained, meaning, definition, overview, introduction, guide.
- **Informational pages** exclude: pricing, cost, buy, near me, hire, quote, booking.

**Seven hard rejections:**
1. Branded or competitor-branded (unless the seed is branded)
2. Navigational
3. Intent mismatch
4. Near-duplicates
5. Implausibly low demand
6. Volume traps
7. Out of the industry

#### Open items to know before diligence

- **The selection rules are prompt rules**, not code gates. The Location agent's keyword engine has code gates, and they could be reused here.
- **"Exactly 2 + 10" is an instruction.** Code checks the counts only on the second pass.
- **The keywords and volumes the model returns** are not re-matched to the SEMrush rows in code.
- **"Belong together on one page" isn't computed.** There's no test of shared search results between the two primaries.
- **US only.** No client-site data, no Search Console data.
- **The run history stores a 5-item sample**, not the full result.

---

### Appendix A4: Article Recommender in detail

#### The line, stage by stage

| # | Stage | Who | Detail |
|---|---|---|---|
| 1 | Accept the keyword | Code | |
| 2 | Google top 10 | Code | US English. Serper is the backup. |
| 3 | Read each page | Code, headless browser | Title, H1, H2–H4 and FAQ-style questions (FAQ schema, accordions, `details`/`summary`). Body text has nav, header, footer and sidebars removed. Sequential, 15 seconds per page. |
| 4 | Evidence warning | Code | Warns if fewer than 5 pages were read. |
| 5 | Pack the evidence | Code | Per page: the first 10 H2s, 8 H3s, 5 H4s, 5 FAQs and 1,500 characters of body. |
| 6 | Find the patterns | Model | H2 topics on 3+ pages, H3 on 2+, recurring angles, FAQ patterns, gaps, related terms, structural patterns. |
| 7 | Write the brief | Model, fixed template | See the template rules below. |
| 8 | Drift check | Model | Is every heading a direct facet of the keyword? |
| 9 | Grounded rewrite | Model, only if drift is found | Rewrites using only the scraped content. |
| 10 | Output | Code | Markdown brief, copy or Word export, the 10 source URLs and read status. |

#### Template rules

- 8–12 H2 sections.
- Each H2 has writing instructions and keywords.
- H3s, with H4s only where the top pages go that deep.
- Visual-opportunity callouts.
- A mandatory FAQ of 5–8 questions, each answered in 40–80 words, answer in the first sentence.
- No skipped heading levels.

#### Open items to know before diligence

- **No AI-answer input.** People Also Ask questions come back from the search provider but are discarded.
- **The model applies the "3+ pages" rule.** It isn't counted in code.
- **Pages are weighted equally**, whatever their rank.
- **No knowledge base in normal runs**, because the client selector was removed.
- **Nothing is saved beyond a 600-character preview.**
- **Internal docs rate it "partly working"** (`docs/unification/01-what-we-have.md`).
- **The same engine feeds the Content Writer** (`server/modules/contentWriter`). That tool adds a planning step (Claude Sonnet 5) and evidence-checked drafting.

---

### Appendix A5: Location + Service in detail

#### The line (Gentle Dental), stage by stage

| # | Stage | Who | Detail |
|---|---|---|---|
| 1 | Catalogue | Code | 40 services × 50 offices. Office details are entered by hand and kept when the catalogue is re-seeded. |
| 2 | Pick location + service | **Person** | Previews the URL and title. Checks for an existing page. |
| 3 | Build the search | Code | Adds "dental" to ambiguous service names. Resolves office sub-areas to the city. |
| 4 | Google top 10 | Code | Cached for 7 days. |
| 5 | SEMrush | Code | 30 keywords per competitor page, run in parallel. Cached for 180 days. |
| 6 | Client keyword list | Code | Up to 100 rows from the client's own imported keyword universe. |
| 7 | Filter | Code | Per-service topic terms. Rival cities blocked (own region and contained cities allowed). "Near me" dropped. De-duplicated. Intent tagged. |
| 8 | Pick 2 primary + 10 secondary | Model (Claude Sonnet 5) | "Never invent a keyword that isn't in the proposed lists." |
| 9 | Code gates | Code | A primary must name both the city and the service. Rejected keywords stay rejected. Empty slots are filled with "{service} {city}". |
| 10 | Independent review | Model, separate call | "Judge it against the rules; do not propose replacements." |
| 11 | Apply the verdict | Code | Discards failures that name keywords never submitted. Refills failed primaries. |
| 12 | Approve keywords | **Person** | Saved as approved. |
| 13 | Scaffold | Code | URL `/dental-offices/{state}/{city}/{service}`, canonical, title, H1, breadcrumb, office details, services menu, per-office brand name. |
| 14 | Local competitors | Code | Top 5 non-client pages for the primary keyword. Their H2s, H3s and FAQs. |
| 15 | Heading filter | Code | Removes boilerplate headings, but keeps genuine cost and insurance topics. |
| 16 | Outline | Model (Claude Sonnet 5) | Exactly 6–7 blocks. "Model competitor subject matter only — never reuse their phrasing, brand names, dentist names, or review copy." One localised block. |
| 17 | Outline repair | Code | Tops up from the section ladders. Forces one keyword-bearing H2 and one localised block. Uses the ladder alone if the model fails. |
| 18 | Write | Model (GPT-5.4 mini) | Hero, meta description, body and 4–6 FAQs. |
| 19 | Measure and correct | Code + model | Enforces the outline. Checks words (500–900) and meta description (150–160 characters). One correction pass, using the real numbers. |
| 20 | Repairs | Code | Trims the meta at a sentence boundary, normalises HTML, records the source of each section. |
| 21 | Internal links | Code | 3 sibling offices offering the same service, same region first. |
| 22 | Schema | Code | MedicalWebPage, Dentist, MedicalProcedure, FAQPage and BreadcrumbList. |
| 23 | Quality checks | Code | 20 checks (listed below), with a verdict. |
| 24 | Save | Code | One page per location + service. |
| 25 | Review | **Person** | Inline notes from the checks. Recheck, edit, save (checks re-run), or regenerate one section. |
| 26 | Export | Code | Word doc, HTML, JSON, JSON-LD, Markdown. |

#### The 20 quality checks

- **Critical (6):**
  1. Primary keyword in the H1
  2. Primary keyword in the title
  3. Primary keyword in the meta description
  4. Meta description length
  5. At least 4 FAQs
  6. Schema is valid JSON
- **Major (10):**
  1. Primary keyword in an H2
  2. Body is 500–900 words
  3. Keyword used
  4. Keyword reads naturally
  5. City appears in the body
  6. City appears in 2+ FAQs
  7. FAQ localisation is meaningful
  8. 3+ internal links
  9. 6–7 H2s
  10. Paragraph readability
- **Minor (4):**
  1. AP style
  2. Keyword density at or under 2.5%
  3. No placeholder text
  4. A secondary keyword used

#### Writing budgets and style

- **Paragraphs:** 30–40 words, maximum 45. List items up to 25 words, at most 2 lists.
- **Page:** 500–900 words accepted, 600–860 targeted. Meta description 150–160 characters.
- **FAQs:** 4–6, at least 2 localised, answers up to 40 words.
- **Style and claims:**
  - AP style: no serial comma, numerals for 10 and up, no em dashes.
  - Commercial intent, no superlatives.
  - Answer-first blocks, "because that is how AI answer engines quote it".
  - No invented addresses, phone numbers, hours, prices, dentist names or reviews. No outcome guarantees.

#### Open items to know before diligence

- **No WordPress or CMS publishing.** Export only.
- **Page approval isn't saved in the Gentle Dental flow.** "Confirm" is a screen state, and a failed quality check does not block export. Keyword approval is saved.
- **The four named gates** (SEO → clinical → content → client) exist only in the older Neuro engine.
- **The Gentle Dental prohibited-claims list is seeded but not used** by the Gentle Dental prompt or its checks. The behavioral-health engine does enforce its list.
- **No cross-page similarity check** in the Gentle Dental or behavioral-health flows. The Neuro engine has one: pages that are 80% or more similar are blocked.
- **"Local" demand is US-wide volume for city-named searches.** No city-targeted search results.
- **A failed competitor read is cached as empty for 7 days.**
- **The regenerate-body prompt still asks for the keyword "4-5 times"**, which contradicts the main prompt (`contentGenerator.js:815-816`).
- **Office address and phone start blank** until entered by hand.

---

### Appendix A6: Competitor comparison in full (capabilities only)

Source: public product documentation, read 24 September 2026. **NF** = not found in public docs. No speed or quality claims against named products.

#### Content Enhancer: existing pages

| Tool | Reads a live URL | Uses top results | Uses AI answers | Writes into the page | Adds FAQ / tables | Human gate |
|---|---|---|---|---|---|---|
| **Position²** | Yes | Top 10, read in full | 4 AI models via API | Insert-only, highlighted | Yes | Editor reviews |
| Surfer | Yes | Top 20 (Facts) | ChatGPT, Perplexity, AI Overviews | Rewrites intro and facts | Partial | Accept / reject per section |
| Semrush Content Optimizer | Yes | Top 10 | Partial | Automatic rewrites | Partial | NF |
| Frase (Jan 2026 relaunch) | Yes | Top 20 | 8 AI surfaces tracked | Proposes; you apply | Partial | You decide |
| Clearscope | NF | Top 30 | Marks terms in GPT and Gemini answers | No | Partial | n/a |
| Profound Agents | Yes | Partial | Yes | Generates refreshes, publishes via CMS | Partial | Approval before publishing |
| Peec AI | No | No | Yes | No (by design) | No | n/a |

#### Keyword Research

| Tool | Clusters by shared results | Picks a keyword per group | Decides the page target | Filters off-theme |
|---|---|---|---|---|
| **Position²** | Decides per page instead | 2 primary + 10 secondary, with reasons | Yes | URL rubric (code) plus rules (prompt) |
| Semrush Strategy Builder | Yes | Left to user | Left to user | Partial |
| Ahrefs Keywords Explorer | Partial | Parent Topic | Partial | Partial |
| Keyword Insights | Yes (40%+ shared URLs) | "Best" keyword per cluster | Left to user | Yes (business context) |
| SE Ranking Keyword Grouper | Yes (adjustable) | NF | Partial | Partial |
| LowFruits | Yes | Highest volume | Partial | NF |

#### Article Recommender

| Tool | Results read | Headings | PAA / questions | AI-answer data | Drafts the article |
|---|---|---|---|---|---|
| **Position²** | Top 10 | Yes (H1–H4) | FAQ patterns from pages; PAA discarded | No (yet) | Via Content Writer |
| Frase | Top 20 | Yes | PAA, forums, answer engines | Yes | Yes |
| Surfer | Adjustable | Yes | Yes | Yes (Facts) | Yes |
| Clearscope | Top 30 | Yes | Yes | Partial | Yes |
| MarketMuse | Thousands of pages (topic model) | Partial | NF | NF | Partial |
| Semrush Content Template | Top 10 | Partial | NF | Partial | Yes |

#### Location + Service

| Tool | Location data feed | Research per location | Unique body copy | Approval | Healthcare posture | Publishing |
|---|---|---|---|---|---|---|
| **Position²** | Office records | Yes (search + SEMrush + client list) | Yes | Keywords + page review | Rules against invented facts and outcome claims | Export: doc, HTML, JSON |
| Yext Pages | Yes | NF | Template fields, AI-assisted | Review queue | BAA available | Hosted by Yext |
| SEOmatic | Yes (CSV, Sheets) | Partial | Yes | Yes | NF | WordPress |
| Birdeye | Partial | Partial | Yes (claimed) | NF | HIPAA, third-party verified | NF |
| Uberall, Rio SEO, SOCi | Yes | NF | Templated | Partial | Partial | Hosted or subdomain |
| Agency / freelancer | No | If scoped | Yes | Yes | Varies | Yes |

#### Claims to keep out of the deck

These are contradicted by public documentation:
- "No tool writes into existing pages." Surfer and Semrush do.
- "AI trackers only track." Profound, AthenaHQ and Scrunch now act on what they track.
- "Nobody else clusters keywords or picks a primary." Keyword Insights does both.
- "We don't just copy #1" presented as unique. Every serious brief tool reads 10–30 results.
- Any vendor's uplift percentage presented as fact.

---

### Appendix A7: Third-party data Rajiv can cite

All figures are from named third-party studies. Quote them with the source.

**AI answers are taking the click**
- **Ahrefs, Feb 2026:** a top-ranking page gets **58% fewer clicks** when an AI Overview appears (Dec 2023 vs. Dec 2025). The April 2025 study found 34.5%. [ahrefs.com/blog/ai-overviews-reduce-clicks-update](https://ahrefs.com/blog/ai-overviews-reduce-clicks-update/)
- **Pew Research Center, July 2025:** users clicked a result on **8%** of visits with an AI summary, against 15% without one. [pewresearch.org](https://www.pewresearch.org/short-reads/2025/07/22/google-users-are-less-likely-to-click-on-links-when-an-ai-summary-appears-in-the-results/)
- **Seer Interactive, Apr 2026** (53 brands, 5.47M queries): on informational searches, brands cited in the AI Overview got **2.07% CTR vs. 0.94%** for those not cited. [seerinteractive.com](https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-2026-update)
- **Google I/O, May 2026:** AI Overviews has **over 2.5 billion** monthly users. [blog.google](https://blog.google/innovation-and-ai/sundar-pichai-io-2026/)

**What AI answers reward**
- **GEO paper** (Princeton and collaborators, KDD 2024): adding statistics, quotations and citations raised visibility inside generated answers by **30–40%**. Keyword stuffing didn't help. Caveat: most tests used a simulated engine, and the paper measures visibility inside the answer, not traffic. [arxiv.org/abs/2311.09735](https://arxiv.org/abs/2311.09735)
- **BrightEdge, Sep 2025:** in **healthcare**, **75.3%** of AI Overview citations also rank organically. That's relevant to our dental and behavioral-health clients. [brightedge.com](https://www.brightedge.com/resources/weekly-ai-search-insights/rank-overlap-after-16-months-of-aio)

**Why a chatbot alone isn't enough**
- **Walters & Wilder, *Scientific Reports*, 2023:** **18%** of GPT-4's citations were fabricated, and 24% of the real ones had substantive errors. [nature.com](https://www.nature.com/articles/s41598-023-41032-5)
- **Rao, Wong & Callison-Burch, April 2026** (221K URLs): **3–13%** of URLs cited by AI models were fabricated. Checking the URLs cut unresolvable citations to under 1%. [arxiv.org/abs/2604.03173](https://arxiv.org/abs/2604.03173)
- **SparkToro and Gumshoe, Jan 2026:** asked for brand lists 100 times, AI tools had **less than a 1-in-100 chance** of giving the same list twice. [sparktoro.com](https://sparktoro.com/blog/new-research-ais-are-highly-inconsistent-when-recommending-brands-or-products-marketers-should-take-care-when-tracking-ai-visibility/)

**Google's rules for location pages at scale**
- **Spam policies** (updated Aug 2026): doorway abuse includes "pages targeted at specific regions or cities that funnel users to one page" and "substantially similar pages". [developers.google.com](https://developers.google.com/search/docs/essentials/spam-policies)
- **March 2024 core update:** **45% less** low-quality, unoriginal content in results. The scaled-content policy covers content "whether automation, humans or a combination are involved". [blog.google](https://blog.google/products/search/google-search-update-march-2024/)

**What content costs by hand**
- **Orbit Media 2026 survey** (1,042 bloggers): the average post takes **3 hours 20 minutes** to write. [orbitmedia.com](https://www.orbitmedia.com/blog/blogging-statistics/)
- **Verblio 2025:** human-written content at **$0.16/word**. **Editorial Freelancers Association 2026:** ghostwritten blog posts at **25–40¢/word**. [verblio.com/pricing](https://www.verblio.com/pricing) · [the-efa.org/rates](https://www.the-efa.org/rates/)

---

### Appendix A8: Where each claim comes from

**Code:** branch `unified-fast-aivisibility`, checked 24 September 2026.

| Agent | Key files |
|---|---|
| Content Enhancer | `server/routes/articleEnhancement.js` (see lines 1592-1628 for the insertion rules), `client/src/pages/ArticleEnhancementPage.jsx`, `knowledge-base/best-practices/seo-geo-article-enhancement-knowledge-base.md`, `server/routes/articleEnhancementLite.js` (the no-invention guard), `server/routes/contentEnhancement.js` (the tool the old case study described) |
| Keyword Research | `server/routes/keywordResearch.js` (URL rubric at lines 19-82, selection rules at 359-446, second check at 448-541) |
| Article Recommender | `server/services/articleBrief.js`, `server/routes/articleRecommendation.js`, `server/services/scraper.js` |
| Location + Service | `server/locationPageBuilder/dentalWizard.js`, `keywordAdapter.js`, `keywordRelevance.js`, `dentalOutline.js`, `contentGenerator.js`, `qaEngine.js` (the 20 checks at lines 389-704), `compose.js`, `schemaGenerator.js`, `internalLinks.js`, `exporter.js`, `config.js` |
| Shared | `server/services/googleSearch.js` (Google search with Serper fallback), `server/services/semrush.js` |

**Internal docs used:**
- `docs/Prompts/investor_deck_brief.md`, for the claims guardrails and the time figures
- `docs/PM_PRODUCT_BRIEF.md`
- `docs/unification/01-what-we-have.md`

**Git history:** the "what we learned" stories come from commit messages and code comments. Examples:
- `df90587`: rival-city filter
- `c04da65`: topic filter
- `1b1aafd`: word-count and meta-description fixes
- `d426354`: duplicate headings
- `ab1d33b`: framework truncation
- `3e4ebd6`: framework moved first
- `41af0ad`: navigation extracted as article text
- `48b7d51`: shared noun is not shared intent
- `b3c2626`: second check and drift check
