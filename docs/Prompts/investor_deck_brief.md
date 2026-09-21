Build: Investor deck — "SEO Studio", Position² · strategic/corporate audience, 20–30 minute slot, M&A optics

---

## How to use this file

You are building a presentation. This file contains everything you need — the audience,
the argument, the exact on-slide copy, the speaker notes, and the facts you are permitted
to cite. Do not go looking for more material. Do not invent numbers.

Produce **one `.pptx`, 16:9 widescreen**, containing three parts:

| Part | Slides | Who sees it |
| --- | --- | --- |
| 1 — Investor deck | 16 | The room |
| 2 — Demo runbook | 6 | The presenter only |
| 3 — Objection annex | 5 | The presenter only |

Parts 2 and 3 live in the same file, after a divider slide reading **"Internal — do not
present."** The CEO prints them or reads them on a second screen. They are never projected.

Every Part 1 slide carries speaker notes. Put them in the notes field, not on the slide.

---

## The frame — hold this throughout

**Who is in the room.** Strategic and corporate investors: martech companies, or agency
holding groups. They are operators, not financial buyers. They already understand SEO.
They do not need the category explained — they need to know what we have that they don't.

**What we are.** An agency that rebuilt its own delivery on AI agents. Not a SaaS company.
Revenue comes from services. That is not a weakness to hide — it is the thing that makes
the software real, because it was built against live client work rather than a roadmap.

**The argument in one line.** *The agency is what you'd buy. The platform is why it's worth
more than an agency.*

**The ask.** M&A optics — a strategic investment or a combination. We are not naming a
number in this room. We are making the asset legible and opening the conversation.

**Tone.** The existing Position² deck has a voice — "You think the page is fine. The
bloodwork disagrees." Keep that voice. Short declarative headlines. No adjective stacking.
No "leverage", "synergy", "revolutionary", "cutting-edge", "game-changing". If a sentence
would survive being read aloud by a sceptical CEO to a sceptical buyer, it stays.

**Reading level.** Non-technical throughout Part 1. A slide that requires knowing what a
crawler is has failed. Numbers may be technical; explanations may not.

---

## Facts you may cite

Verified against the codebase. Every number on a slide must come from this table or be a
`[FILL]` token. Nothing else.

### The platform

| Fact | Note for the presenter |
| --- | --- |
| **Six audit modules** run against one client project | SEO & GEO, Agent Readiness, Competitor, Hub & Spoke, AI Visibility, AI Visibility Lite |
| **Fifteen+ standalone tools** alongside them | Sixteen are visible in the product today; say "fifteen" and be pleasantly precise if asked |
| **One project = one client site**; modules share it | Pick the client once |
| **Workspaces, projects and roles are real** | Multiple client brands, multiple workspaces, multiple users per workspace |
| **Four roles plus platform admin, 22 distinct permissions** | Contributor / approver / admin / owner |
| Sign-in is Google OAuth and **fails closed** | No allow-list configured means nobody gets in |
| The dashboard **refuses to show a figure for a module that hasn't run** | It says so rather than showing a zero |

### The checks

| Fact | Note for the presenter |
| --- | --- |
| **96 rules** in the site crawl | **89 of the 96 have detection code**; 7 are defined but not yet wired. If pressed, say so — see Annex 5 |
| **200+ checks per page** in the SEO & GEO Audit | The verified count is **266** (252 plus 14 keyword checks). Slide says 200+ to match the existing deck; over-deliver if challenged |
| **77 checks across 23 sections** in the On-Page audit | |
| **13 checks and 4 maturity levels** in the Agent Readiness audit | Measures whether AI agents can use the site at all — see slide 15 |

### AI Visibility

| Fact | Note for the presenter |
| --- | --- |
| Measured across **ChatGPT, Gemini and Google's AI answers** | Two paths exist — one reads the consumer surfaces, one queries the model APIs with live web search. **Do not explain this distinction on a slide.** Annex 3 has it if asked |
| **Up to 20 questions per project**, ten written automatically | |
| The generated question is **never allowed to name the client** | Strong methodology point — Annex 3 |
| **Mentioned** and **cited** are recorded as separate signals | |
| Every descriptor the system reports **must carry a verbatim quote** from a stored answer, or it is discarded | The single best anti-hallucination proof point in the product |
| A full run takes **about three minutes** | The older consumer-surface path takes 10–35 minutes |

### Time compression — from the existing Position² deck

| Agent | Figure |
| --- | --- |
| Keyword Research | 30 min → 5 min |
| Article Recommendation | 1 hr → 10 min |
| Article Enhancer | 3 hrs → 10 min |
| Competitor Analysis | 5 hrs → 5 min |
| SEO & GEO Audit | 200+ checks → minutes |

These are **internal benchmarks** — our team, our accounts. Not audited. Say so if asked.

### Two details worth knowing verbatim

- **Keyword Research returns exactly two primary keywords and ten secondaries**, then runs a
  second pass to validate its own choices. This is why the existing deck says *"Most tools
  hand you a hundred. This picks two."* — it is literally true.
- **Article Enhancer is forbidden from inventing.** It will not insert a statistic, an
  expert quote, a citation, a study or a date. Every change must be grounded in the
  article's own text. This is a hard constraint in the code, not a guideline.

## Claims you must NOT make

This deck goes to people who will run technical diligence. Anything here that diligence
contradicts costs more than it buys. Do not write:

- "Fully unified platform" — six modules share the project spine; several tools do not yet
- "Enterprise-grade", "production-hardened", "battle-tested"
- Any client count, logo, revenue figure, retention rate, margin number or headcount —
  unless it replaces a `[FILL]` token and the CEO supplied it
- Any market size, TAM or growth statistic — we have not sourced one
- "Proprietary data" — we license third-party data and say so on slide 14
- **Any suggestion we integrate Ahrefs.** We do not. Semrush, DataForSEO, Google PageSpeed,
  Google Search Console and the model APIs are the real sources
- "All 96 rules" — 89 are wired
- "Replaces your SEO team" — slide 11 argues the opposite
- Any claim that an agent's output ships without human review
- Comparative performance claims against a named competitor ("faster than X")

Where a number would strengthen a slide but we don't have it, write a visible
`[FILL: what's needed]` token. Do not estimate, and do not use a plausible-looking
placeholder like "40%" — the CEO must see at a glance what is unfilled.

---

## Design direction

Match the existing Position² deck the CEO already presents from:

- **Covers and section breaks:** blue → purple gradient, left to right. Large white display
  type, bold, left-aligned in the right two-thirds. Translucent overlapping circles behind
  it on the left.
- **Content slides:** white background, `p²` mark top-right, footer rule reading
  `© Position², 2026` left and `www.position2.com` right, slide number bottom-right.
- **Headline:** deep blue, bold, large. **Sub-headline:** medium blue, one line, directly
  beneath.
- **Cards and panels:** light blue-grey fill, thin blue border, solid blue or navy header
  bar with white type — as on the existing "Why It Matters / Why We Built It" slides.
- **Minimum body size 18pt.** Projected in a room, not read on a laptop.
- No stock photography. No icons beyond the simple marks already used for the five agents
  (🔍 📝 ✨ 📊 🛠).

*Note for whoever runs this:* the org's `organic-competitor-analysis` skill specifies a
different Position² palette (Poppins, red `#D3342E`, navy `#245E9E`, `#161616` title
backgrounds). **The existing deck is canonical here** — the CEO has presented from it and
the audience may have seen it. Use the gradient identity above. Flag the conflict; do not
blend the two.

---

# PART 1 — THE INVESTOR DECK

Sixteen slides. About 90 seconds each leaves real headroom for questions in a 30-minute
slot, and the deck still works if it gets cut to 20.

---

## Slide 1 — Cover

**On slide**

> # SEO Studio
> **The agency delivery system, rebuilt on AI agents**
>
> Position² · 2026

Gradient cover treatment.

**Speaker notes**

Open on the business, not the product. Thirty seconds:

"We're an SEO and performance agency. Two years ago we had the problem every agency has —
revenue capped by how many hours our people can work. So we rebuilt how we deliver. What
I'm going to show you is the system we built, and why we think it's worth more in somebody
else's hands than it is in ours alone."

That last clause is the reason they took the meeting. Say it in the first thirty seconds.

---

## Slide 2 — The shift

**On slide**

> # Search stopped sending traffic.
> ## It started giving answers.
>
> - A user asks. The engine answers. The click never happens.
> - The brand is either **inside that answer** — or it is invisible.
> - This is not a forecast. It is already how a growing share of search behaves.

**Speaker notes**

Forty seconds, no more. This room already believes this — do not sell it. The only job of
this slide is to establish that you and they work from the same map, so that when you
disagree with them later it lands as expertise rather than naivety.

Do not quote a statistic. We have not sourced one, and this audience will know if you get
it wrong.

If someone challenges the premise, that is a good sign — they are engaged. Agree the timing
is debated; say the direction is not.

---

## Slide 3 — What it breaks for brands

**On slide**

> # You can rank #1 and still not exist.
> ## The answer layer doesn't publish a leaderboard.
>
> Brands can see their Google rank. They cannot see:
>
> - Whether an AI answer mentions them at all
> - Whether it cites them, or a competitor, or a review site
> - What the answer actually says about them
> - Whether any of it moved after they spent money on it

**Speaker notes**

The customer's pain, stated as a CMO would state it. Lead with the discomfort, not the
technology.

"Every marketing director I talk to has the same blind spot. They have twelve dashboards
for Google. They have nothing for the thing that's replacing Google."

The last bullet is the commercial one — *they cannot prove ROI on work they cannot measure.*
That is what makes this a budget line rather than a curiosity. Land it.

**Likely objection here:** "Isn't everyone building this?" → Annex 2.

---

## Slide 4 — What it breaks for agencies

**On slide**

> # Agencies sell hours.
> ## Answers don't care how many you have.
>
> - The surface area to cover just multiplied — every engine, every answer, every question
> - Client budgets did not multiply
> - An agency's margin is capped by headcount. Always has been.
> - So the work either doesn't get done, or it gets done unprofitably

**Speaker notes**

The pivot slide. You have described a market problem; now you describe *your* problem — and
by extension theirs, because an agency holdco or a martech vendor serving agencies has
exactly this constraint.

Plainly: "We could see the work tripling and the budgets flat. You cannot hire your way out
of that. We decided to build our way out of it."

If the audience is a holding company, pause here. This is the slide they feel personally.
Let them react before moving on.

---

## Slide 5 — What we built

**On slide**

> # So we stopped selling hours.
> ## SEO Studio — one platform, built against live client work
>
> - **Six audit modules** that run on one client site, together or on their own
> - **Fifteen standalone tools** for research, optimisation and build work
> - **One project** — pick the client once; the modules work from it
> - Built for **multiple brands, multiple teams, multiple client workspaces** from the start
> - Built inside a working agency, on real accounts, not as a product roadmap

**Speaker notes**

The reveal. Slow down — this is the first time they see the asset.

The fourth bullet matters more to a strategic than it looks, and it is the one to say out
loud: "This was never built as a tool for one team. There are proper workspaces, proper
client projects, and a real permissions model underneath — four roles, twenty-two separate
permissions, and sign-in that fails closed if you haven't explicitly allowed someone in.
That's there because we run client data through it."

An acquirer is silently asking *"could this hold my client book?"* This bullet answers it
before they ask.

The last bullet is the credibility bullet: "It wasn't built by a product team guessing at
what practitioners need. It was built by the people doing the work, against accounts that
were paying us at the time. Everything in it exists because someone's Tuesday was too long."

Do not claim it is finished. Read Annex 5 before you present — you must know the honest
maturity answer before someone asks for it.

---

## Slide 6 — How it works

**On slide**

> # One site in. Six modules. One answer.
> ## A partner should be able to read the output without an analyst in the room.
>
> A simple left-to-right flow of three boxes:
>
> `One client site` → `Six modules run` → `One executive summary`
>
> Beneath the summary box, smaller:
> *What state the site is in · which way it moved since last time · how much of it is one
> template fix · the three things to start with*

**Speaker notes**

Fifty seconds. The point is not the architecture — it is that the output is a decision, not
a data dump.

"Most SEO tools give you four thousand issues and wish you luck. What we cared about was
the last box. A client should open this and know the three things to do on Monday."

Worth adding, because it is unusual and it signals discipline: the dashboard will not show
a number for a module that hasn't run. It says so instead of showing a zero. Small detail,
but it tells an operator a great deal about how the thing was built.

**Design note:** three boxes, no more. Any additional box makes this a technical slide,
which fails the non-technical test.

---

## Slide 7 — The specifics

**On slide**

> # The numbers that are actually ours.
>
> Three large stat panels:
>
> | **96** | **200+** | **3** |
> | --- | --- | --- |
> | rules in the site crawl | checks per page, traditional search and AI answers | answer engines measured — ChatGPT, Gemini, Google AI answers |

**Speaker notes**

Thirty seconds. Do not narrate the numbers — they are on the slide and the room can read.

Use the time for the point behind them: "These aren't marketing numbers. That's the actual
rule count and the actual check count. I can show you the registry."

The offer to show the registry is the move. Strategics assume deck numbers are inflated.
Offering the source, unprompted, buys credibility for every other number in the deck.

**Two things to have ready, because offering the registry means someone may take you up on
it:**
- The real per-page check count is **266**, not 200. The slide says 200+ because the deck
  you've shown before says 200+. Being *under* your own number is a good place to be.
- Of the 96 crawl rules, **89 have detection code**; 7 are defined in the catalogue and not
  yet wired — they need a backlinks or Search Console feed we don't currently pull. If it
  comes up, say that. It is a small, specific, honest answer and it makes the other 89
  believable.

**Likely objection here:** "Is this a GPT wrapper?" → Annex 1. Slide 7 is usually where that
question arrives, because check counts sound like rules and rules sound like software. Good
— you want it here, where the answer is strongest.

---

## Slide 8 — The five agents

**On slide**

Reuse the existing five-card grid with the time-compression figures:

> # Five agents. The work of a week, done between meetings.
>
> | 🔍 **Keyword Research** | 📝 **Article Recommendation** | ✨ **Article Enhancer** |
> | --- | --- | --- |
> | Align investment with real demand | Find the gap, build to beat it | Close competitor and AI-answer gaps |
> | **30 min → 5 min** | **1 hr → 10 min** | **3 hrs → 10 min** |
>
> | 📊 **Competitor Analysis** | 🛠 **SEO & GEO Audit** |
> | --- | --- |
> | Benchmark, and find the undefended ground | 200+ checks, ranked by impact |
> | **5 hrs → 5 min** | **200+ checks → minutes** |

**Speaker notes**

This is the slide they will photograph. Give it time.

Do not walk all five. Pick two and move — the grid does the rest. "I'll show you two of
these properly; the pattern holds across all five."

One line worth using on Keyword Research, because it is literally true rather than
rhetorical: "It returns exactly two primary keywords and ten secondaries, and then it runs
a second pass to argue with its own answer. Most tools hand you a hundred keywords. The job
was never finding keywords."

If asked where the time figures come from, be straight: internal benchmarks, our team, our
accounts, measured against how the same work used to take. Honest, not audited. Saying so
costs nothing and protects every other number in the deck.

**Likely objection here:** "Those savings sound convenient." → Annex 4.

---

## Slide 9 — Spotlight: SEO & GEO Audit

**On slide**

> # You think the page is fine.
> ## The bloodwork disagrees.
>
> - A full diagnostic on one page, in about a minute
> - 200+ checks covering both traditional search and AI answer engines
> - Checks whether search engines **and AI crawlers** can actually reach the page
> - Output ranked by impact and severity — not an alphabetical list of complaints

**Speaker notes**

The headline is from the existing deck and it works. Use it verbatim and pause after it.

Sixty seconds. The third bullet is what separates this from a 2019 SEO tool: "Everyone
checks whether Google can crawl the page. Almost nobody checks whether the AI crawlers can.
Those are different questions now, and the answer is different more often than you'd think."

**Demo cue:** if the room is warm and you have a screen, this is the one to show live. Fast,
visual, self-explanatory. See Part 2, Demo 5 — including what not to open.

---

## Slide 10 — Spotlight: AI Visibility

**On slide**

> # We ask the engines what they say about you.
> ## Then we show you how to change the answer.
>
> - Real buying questions, asked the way a customer would ask them
> - Put to **ChatGPT, Gemini and Google's AI answers** — with live search running
> - We record two separate signals: whether you were **mentioned**, and whether you were **cited**
> - Run it again after the work, and see whether the answer moved

**Speaker notes**

The differentiator slide. If they remember one thing, make it this one.

"Everything else in this deck makes existing work faster. This one does something that
wasn't possible before. We're not modelling AI visibility or inferring it from rankings —
we're asking, with search switched on, the way a customer would ask, and recording what
comes back."

Two methodology points, either of which is worth thirty seconds:

- **The question is never allowed to name the client.** "If you ask an engine about
  Position², of course it talks about Position². We ask the question a buyer would actually
  type, and then see who shows up. That constraint is enforced in the system, not left to
  whoever wrote the prompt."
- **Mentioned and cited are different things.** Being talked about and being linked to have
  different commercial value and need different fixes. Most tools conflate them.

The last bullet is the commercial close: it makes the work measurable, which makes it
billable, which makes it a retainer line rather than a project.

**One thing to keep off the slide:** there are two ways this runs under the hood — one reads
the consumer products, one queries the model APIs directly. Both are real and both ship.
Annex 3 has the distinction if someone technical asks. It does not belong on a slide.

**Likely objection here:** "How do you know those numbers are real?" → Annex 3. The sharpest
question in the deck, and you should want it.

---

## Slide 11 — The quality answer

**On slide**

> # Agents do the work.
> ## Experts hold the gates.
>
> - No agent output reaches a client site unreviewed
> - Every gate has a named owner and produces a **decision**, not a status update
> - The system is built so it **cannot invent** — no made-up statistics, quotes or citations
> - The agent removes the hours. It does not remove the judgement.

**Speaker notes**

Three jobs, and all matter more than the slide's plainness suggests.

**One: it kills the quality objection before it is asked.** Nobody in this room believes
AI-generated SEO content is safe to ship unreviewed. Agree with them out loud, first, and
the rest of the deck stops being suspect.

**Two: the third bullet is a hard technical constraint, not a policy.** Use it: "Our Article
Enhancer is forbidden from inserting a statistic, an expert quote, a citation, a study or
even a date. Every change it makes has to be grounded in the article's own text. That's
enforced in the code. And on the AI Visibility side, every observation we report has to
carry a word-for-word quote from a real answer or the system throws it away. If it can't
quote it, it doesn't say it."

That is the most concrete anti-hallucination answer in the deck. Most companies in this
space answer that question with reassurance. Answer it with a constraint.

**Three: it explains the business model.** A strategic will ask why we don't just sell this
as software. This is the answer — the gates are the product, the agent is the cost
structure.

"We're not claiming the machine does the job. We're claiming it does the *hours*. What our
people do now is decide, and that's a better use of a strategist than pulling a keyword
export."

---

## Slide 12 — What it does to the economics

**On slide**

> # Same team. More clients.
> ## That is the entire business case.
>
> - The hours come out of delivery — the judgement stays in
> - Capacity per strategist rises without headcount rising
> - Research too expensive to run for smaller accounts becomes viable
>
> `[FILL: accounts per strategist — before and after]`
> `[FILL: delivery hours removed per month across the book]`
> `[FILL: gross margin on agent-assisted accounts vs. traditional]`

**Speaker notes**

**Read this before the meeting.** Those three tokens are the numbers a strategic buyer cares
about most, and the deck does not have them. That is deliberate — inventing them is worse.
But it makes this the soft spot in the deck, and the CEO must be ready to answer aloud.

If the numbers exist before the pitch, put them in. If they do not, remove the tokens from
the slide and say this:

"I'm not going to put a margin number on a slide when I can't hand you the workings. What I
will tell you directionally is what we see: delivery hours on a standard SEO retainer have
come down substantially, and the ceiling on how many accounts a strategist can hold has
moved. I'd rather walk you through the actual account data in the next conversation than
show you a number here you'd have to take on faith."

That answer is strong *because* it declines to bluff. This audience has been shown invented
margin numbers before. Declining to is a differentiator.

Then move. Do not linger on the slide you are weakest on.

**Likely objection here:** "So what *is* the margin improvement?" → Annex 4.

---

## Slide 13 — Why this is hard to copy

**On slide**

> # Everyone owns a piece. Nobody owns the line.
>
> | Who | What they have | What they don't |
> | --- | --- | --- |
> | **Semrush, Ahrefs** | The data, the scale, the distribution | The delivery layer — they sell the tool, not the outcome |
> | **Conductor, Profound** | Real AI-visibility measurement | The rest of the workflow around it |
> | **Agency holding groups** | Clients and scale | An AI-native delivery system; they are retrofitting |
> | **AI-native challengers** | Speed, no legacy | Live accounts to build and prove against |
>
> **What we have: the whole line, built inside a working agency.**

**Speaker notes**

Be generous about the competition. It reads as confidence, and this room knows these
companies — several may be their partners, customers or investors.

"Semrush could build our audit module. They'd be mad not to. What they can't easily build is
an agency that has already reorganised its delivery around it, with the client relationships
and the people who know how to run it."

If the company in the room is in that table, address it first and directly: "You'll notice
you're on this list. That's the point — I think we're the piece you don't have."

That is the sentence the whole deck is built to earn. Do not rush it.

**Likely objection here:** "Why won't Semrush just build this?" → Annex 2.

---

## Slide 14 — On the data

**On slide**

> # We license data. We're not pretending otherwise.
>
> - Third-party sources underneath: Semrush, DataForSEO, Google PageSpeed, Search Console, the model APIs
> - What's ours is what sits **on top** — the rules, the checks, the workflow, the gates
> - Data vendors are substitutable. We have swapped sources before.
> - The agents are the asset. The pipes are rented, deliberately.

**Speaker notes**

Put this on a slide rather than waiting to be asked. A buyer who discovers a dependency in
diligence treats it as a finding. A buyer told on slide 14 treats it as maturity.

"Every company in this space rents data from somebody. The question isn't whether you
license it — it's whether your value dies if the licence does. Ours doesn't. The rules and
the workflow are ours; the sources underneath are replaceable, and we've replaced them."

The last claim is true and worth making concretely: the system already runs a primary search
source with an automatic fallback to a second provider, and the market-sizing work can run
off either of two different data vendors. That is substitutability demonstrated, not
asserted.

If pressed on vendor cost or concentration, do not improvise a figure. Say the spend is
consolidating as the platform unifies, and offer to take them through it properly.

**Likely objection here:** "What happens when a vendor reprices you?" → Annex 2.

---

## Slide 15 — Where it goes

**On slide**

> # What a partner accelerates.
>
> - **Unify** — one shared spine under every tool, so each module reads every other's work
> - **Scale** — the multi-client foundation exists; hardening it for someone else's book is the work
> - **Extend** — measurement is the wedge: more engines, more markets, more verticals
> - **Get further ahead** — we already audit whether **AI agents** can use a site at all. Almost nobody is measuring that yet.

**Speaker notes**

This slide answers "why are you talking to us."

On the second bullet, be accurate and be honest — it will be tested. The multi-tenant
foundation is genuinely there: workspaces, client projects, roles, per-workspace limits.
What is not done is that several of the standalone tools don't yet sit on that shared spine.
Say it that way: "The foundation for running many clients across many teams is built. What's
left is bringing the remaining tools onto it. That's known work with a written plan, and
it's exactly the work a partner makes go faster."

The fourth bullet is the forward-looking one and it is underrated. "There's an audit in
there that scores whether an AI agent — not a search crawler, an actual agent acting for a
user — can read and use a site. Thirteen checks, four maturity levels. In twelve months
every brand will want that number. Today almost nobody can produce it."

Framing the roadmap as *what a partner unlocks* rather than *what we'll do anyway* turns
the gaps into a reason to transact. That is the point of the slide.

Read Annex 5 before presenting this one.

---

## Slide 16 — The close

**On slide**

> # What we're looking for.
>
> Three panels, left to right:
>
> | **Commercial** | **Strategic investment** | **Combination** |
> | --- | --- | --- |
> | You put the agents in front of your clients; we run the delivery | Capital and distribution to take this beyond our own book | The agency, the platform and the team, inside your group |
>
> Beneath:
> *`[FILL: which of the three you actually want with this specific party]`*
>
> Contact: info@position2.com · 800-725-5507 · Santa Clara, CA

**Speaker notes**

Do not present all three as equal. Pick the one you want with *this* party before you walk
in, lead with it, and let the other two show you have considered the alternatives.

Naming a range is not required today and probably counterproductive. The goal of this
meeting is a second meeting — with their corp-dev or their practice lead — and the account
data from slide 12 comes with you to that one.

Close on the sentence from slide 13: *"I think we're the piece you don't have."*

Then stop talking. The first person to speak after that sentence should be them.

---

# DIVIDER SLIDE

> # Internal — do not present.
> Everything after this slide is for the presenter.

Gradient treatment, no other content.

---

# PART 2 — THE DEMO RUNBOOK

Six slides, presenter-facing, plain layout. No gradient, no branding — working documents.

**Universal rules — put these on the first runbook slide:**

- Run every demo on a project that is **already saved with a completed run**. Never start a
  fresh run in front of an audience.
- **Do not refresh the browser mid-demo.** Several tools hold results in memory; a refresh
  loses them. Losing client work on screen in front of an acquirer is worse than no demo.
- Have screenshots of every output as a fallback. Assume the wifi fails.
- Two agents maximum. The deck does the rest.

One slide per agent, each with the same four blocks:

### Demo 1 — Keyword Research
- **Show:** a saved project for a recognisable brand, and the final shortlist
- **The 40-second story:** "Most tools hand you a hundred keywords. The job was never finding
  keywords — it was deciding which two matter. This returns exactly two, plus ten
  supporting, and then argues with its own answer before showing you."
- **The aha:** the collapse from hundreds of candidates to two, each with a written reason
- **Do not:** start a new research run live; do not refresh

### Demo 2 — Article Recommendation
- **Show:** a completed competitive teardown and the brief it produced
- **The 40-second story:** "It reads the pages currently beating you and hands back the
  blueprint to beat them. An hour of a strategist's afternoon, in ten minutes."
- **The aha:** the gap analysis — the sections every competitor has that the client doesn't
- **Do not:** demo on a niche the room doesn't recognise; the point is lost

### Demo 3 — Article Enhancer
- **Show:** a before/after on a real article
- **The 40-second story:** "This was written for Google in 2022. This is what it takes to
  make it work for the engines that answer. And it is not allowed to invent anything — no
  statistics, no quotes, no citations it can't ground in the original."
- **The aha:** the specific concrete changes — not a score going up
- **Do not:** claim the output ships unedited. Slide 11 says the opposite.

### Demo 4 — Competitor Analysis
- **Show:** a finished benchmark against tracked rivals
- **The 40-second story:** "Five hours of spreadsheet cross-checking. Now it's the first five
  minutes of the engagement, which means strategy starts on day one."
- **The aha:** the undefended ground — where nobody is competing
- **Do not:** let this become a tour of the data. Show the conclusion.

### Demo 5 — SEO & GEO Audit  ← **the one to demo if you only demo one**
- **Show:** a completed audit on a URL the room knows. Ideally theirs, if the relationship
  can take it.
- **The 40-second story:** "A full diagnostic on one page, in about a minute. Two hundred
  checks, sorted by what actually costs you money."
- **The aha:** the crawler-access check — an AI engine cannot reach a page they assumed was
  fine
- **Do not:** run it live on a slow site. Have the completed run already open.

---

# PART 3 — THE OBJECTION ANNEX

Five slides. Written out in full, because the CEO should read these rather than improvise.

### 1. "Isn't this just a GPT wrapper?"

The sharpest version of the question. The answer is specificity.

"A wrapper is a prompt box with a logo. Under this there are 96 crawl rules and 266 per-page
checks that are deterministic code, not model output. The models get used where language is
the right tool and not where it isn't — the crawler doesn't ask an LLM whether a page is
reachable, it checks. And the part that is model-driven isn't asking a model to guess at
visibility. It's putting real questions to three engines with live search on and recording
what came back. That's measurement, not generation."

Then offer the registry. Again. It ends the conversation every time.

### 2. "Why won't Semrush or Ahrefs just build this? What if a vendor cuts you off?"

Two questions, one answer: we compete on the delivery layer, not the data layer.

"They might build the tooling — honestly, they should. But they sell tools to practitioners.
They don't run the accounts. What we've built isn't a better keyword tool; it's an agency
that has already reorganised delivery around agents, with the people and the client
relationships that make it work. That isn't a feature they can ship."

On repricing: "We've swapped data sources before — our search layer already falls over to a
second provider automatically, and parts of the system run off either of two vendors. A
vendor can make our costs worse. They can't make our product stop working."

### 3. "How do you know the AI visibility numbers are real?"

Answer with method, not confidence.

"Because we're not modelling it. We put real buying questions — phrased the way a customer
would phrase them, with nothing in the prompt steering the answer toward us — to the
engines, with live search enabled. We capture the response and the citations separately,
because being mentioned and being cited are different things. Then we run it again after the
work and see whether it moved.

"Two constraints are worth knowing. The generated question is never permitted to name the
client — if you ask an engine about us, of course it talks about us. And every observation
we report has to carry a word-for-word quote from a stored answer, or the system discards
it. If it can't quote it, it doesn't say it.

"Where I'd push back on the industry is the tools that estimate AI visibility from ranking
data. That's a proxy. This is the answer the model actually gave."

**If someone technical asks how it's measured:** there are two paths. One reads the consumer
products the way a person sees them. The other queries the model APIs directly with search
switched on, which is faster — about three minutes for a full run against ten to thirty-five
for the first path — and is the one we default to now. Both ship. It is fine to explain this;
it just doesn't belong on a slide.

**If they raise variance** — that answers differ between runs — concede it immediately and
specifically: yes, which is exactly why it's tracked across repeated runs rather than read as
a single score. Conceding a real limitation is what makes the rest credible.

### 4. "What's the actual margin improvement? Those time savings sound convenient."

**The weakest point in the deck. Do not bluff it.**

"They're internal benchmarks — our team, our accounts, measured against how the same work
used to take. They're honest and they're not audited, and I'm not going to present them as
though they were.

"What I can do is take you through the actual account data: hours booked before and after,
per account, and what happened to the number of accounts a strategist can hold. That's a real
conversation with real workings, and it's the one I'd like to have next."

Then stop. Do not fill the silence with estimates. Turning a weakness into a specific
invitation for the next meeting is the best available outcome, and it is a good one.

### 5. "How mature is this really? What would we actually be acquiring?"

The honest answer is stronger than the polished one, because they will find out anyway.

"Here's the straight version. The foundation is real — one login, one sidebar, one deploy,
proper client workspaces with a real permissions model, six modules running against a shared
client project. Beyond those six, around fifteen more tools work today but don't all sit on
that shared spine yet; some still ask for the domain again, and some don't persist results
the way they need to. We have a written, staged plan to close that, and I'll give you the
document — it's an internal audit we wrote against ourselves and it's blunt.

"What you'd be acquiring is the agency, the client relationships, the people who built this,
and a working system further along than anything you could start today — with a known,
costed list of what's left. I'd rather hand you that list than have you find it."

**Why this works:** handing over a self-critical internal audit is the most credible move
available in a diligence conversation. It converts every future finding from a discovery into
a confirmation of something you already told them.

**Two specifics to have ready, because a technical diligence team will find both:**
- Several tools currently keep their data as files on the server rather than in the database,
  which means a deploy can reset them. It is the first item on the written plan, and it is
  being fixed.
- Seven of the 96 crawl rules are defined but not yet wired, because they need a backlinks or
  Search Console feed we don't currently pull. 89 are live.

Neither is a surprise to us. Say so, in those words.

---

## Constraints — must follow exactly

1. **Do not invent a single number.** Every figure comes from "Facts you may cite" or is a
   visible `[FILL]` token. If you are tempted to add a market size, a client count or a
   percentage — don't.
2. **Do not write anything listed under "Claims you must NOT make."** In particular, never
   imply an Ahrefs integration and never say "all 96 rules."
3. **Parts 2 and 3 are never presented.** They sit behind the "Internal — do not present"
   divider and carry no Position² branding.
4. **Speaker notes go in the notes field**, via the notes API — never on the slide.
5. **Minimum 18pt body, 28–36pt titles.** This is projected.
6. **Sixteen Part 1 slides.** Not eighteen. If a slide feels thin, cut it and fold the
   content upward — do not pad.
7. **Keep the voice.** Short declarative headlines. The line borrowed from the existing deck
   — "You think the page is fine. The bloodwork disagrees." — stays verbatim.
8. **Non-technical throughout Part 1.** No slide may require knowing what a crawler, an API,
   a spine or a rule registry is. Numbers may be technical; explanations may not.
9. **Never put the two-path AI Visibility distinction on a slide.** It lives in Annex 3.
10. `[FILL]` tokens must be **visually obvious** in the rendered deck — bracketed, coloured,
    impossible to present by accident.

## Before drafting

1. Confirm the five agent names and the time-compression figures against the existing
   Position² deck. They must match exactly — the audience may have seen it.
2. Re-confirm 96, 200+ and the three named answer engines against `README.md` before putting
   them on slide 7. If the README has changed, the README wins and this brief is stale.
3. Decide the palette question (gradient identity vs. the `organic-competitor-analysis`
   brand rules) and state which you used. Do not blend them.
4. Draft slides 12 and 16 with the `[FILL]` tokens in place. Do not resolve them yourself and
   do not quietly drop them — they are a deliberate prompt to the CEO.
5. Produce the outline first — sixteen headlines, one line each — and show it before building
   the full deck. Sixteen headlines in sequence should read as a coherent argument on their
   own. If they don't, the deck won't either.
