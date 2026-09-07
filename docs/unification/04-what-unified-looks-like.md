# What unified looks like

## Part 1 — the experience we are aiming at

### Day 1

You sign in with Google. You see your workspace and the clients in it.

You add a client once: a name and a domain. Nothing else. The app immediately starts a crawl and tells you it is running. You go and do something else.

When you come back, the client has a page. On it: a health score, the issues found, the pages that matter, and a short list of what to do first. You did not choose a tool. You chose a client.

### Week 1

You open a client. Every tool is a **tab on that client**, not a separate destination.

- The keywords tab already knows the domain. You never type it.
- The competitors tab already knows who they are, because you added them once.
- The content tab already knows which pages exist, because the crawl found them.
- The AI visibility tab already knows the brand name and its aliases.

You mark six issues as "not a problem for this client". Next week's crawl remembers. It does not ask you again.

You send the client a report. It is one document, covering everything the app knows about them. You did not merge anything by hand.

### Month 1

The app tells you what changed. Not "here is a crawl", but *"three pages that were ranking lost their internal links this month, and here is which of your recommendations would fix it."*

The weekly crawl runs itself. The monitoring runs itself. When something breaks on a client site, you hear about it before the client does.

You have never re-entered a domain, never re-run a crawl for a different tool, never exported from one screen to import into another.

---

### What you should never have to do again

| Never again | Because |
|---|---|
| Type the same domain into a second tool | Every tool reads the client's domains |
| Pick a client from a different list per tool | There is one client list |
| Re-crawl a site because a different tool needs it | One crawl, many readers |
| Re-triage the same issues after a re-crawl | Decisions live on the issue, not on the run |
| Export from one screen to import into another | One report layer |
| Remember which tool holds which data | One client page holds it all |
| Lose work because we shipped an update | Everything is in the database |
| Wonder what a run cost | One usage and budget view |
| Discover a tool by typing its address | One menu, generated from one list |

---

## Part 2 — the design decisions

### The spine: one Client record

Everything hangs off one record: **the Client**, with its domains, its brand names, its competitors and its settings.

We already have this. It is the project record the dashboard and the crawler share. We are not inventing a spine — we are **connecting the other 16 tools to the one we have**.

**Decision:** the project record is the spine. Every tool gains a client reference. Nothing gets its own client list.

**Why this one:** it is the only client concept that already knows about workspaces, permissions, competitor domains and scheduling. The other four are flat lists with no security model at all.

### One crawl, many readers

One crawl produces the page inventory. Every tool that needs to look at pages reads it instead of fetching again.

| Tool | What it needs from the crawl |
|---|---|
| Site Crawler | It *is* the crawl |
| Content Architect | The page list and the links between pages |
| SEO & GEO Audit | The stored page content for the pages you care about |
| On-Page Audit | The same — it should stop being a separate fetcher |
| Agent Readiness Audit | The site-level files only: robots, sitemaps, headers |
| Image Alt Tag Audit | The stored page content, and the images found in it |
| Content Enhancement | The stored page content for one page |
| Article Enhancement | The stored page content for one article |
| AI Visibility | Only the domain and brand names — it looks outward, not at the site |
| Competitor Tracker | Nothing from our crawl — it looks at competitors |
| Market Potential | Nothing — it is about demand, not the site |

Seven tools stop fetching. That removes seven of the fifteen unguarded fetchers on its own.

**Fresh when it matters:** any tool can ask for a fresh fetch of a single page, but it goes through the crawler's fetching layer, so it still obeys robots.txt and paces itself.

### One shape for the five things everyone shares

| Thing | One shape means |
|---|---|
| **Domain** | One cleaned-up form, one record, one place competitors are listed |
| **Page** | One durable page record per client, with a stable address. Every tool's result points at it. |
| **Issue** | One issue record with a stable identity across crawls, so triage sticks. Every tool files issues in this shape. |
| **Keyword** | One keyword list per client. Research writes to it; page builders and audits read it. |
| **Competitor** | One competitor set per client, used by the tracker, the dashboard and AI visibility alike. |

Today there are six page shapes, seven issue shapes and three keyword homes. Reducing those five concepts to five shapes is the whole game.

### One login, already done

Google sign-in, workspaces, roles, a platform administrator and spending limits already work and cover every tool.

**One thing to fix:** each tool works out who you are separately, four different ways. That should happen once, at the front door.

**Decision:** keep exactly what we have. Move identity resolution to the front door.

### One job runner

**Decision:** keep the Site Crawler's queue. Retire the second one.

**Why:** it survives restarts, resumes part-finished work, drains cleanly on shutdown, and is already safe to run on several servers. The second queue was copied from it and is less capable.

Everything that runs in the background — crawls, audits, AI visibility captures, monitoring, competitor refreshes — goes through it. Every "start it and check back" screen reads job state from the database, not from one server's memory.

### One menu

**Decision:** one list of tools, in one file, that drives the sidebar, the client tabs, the run history labels and the parent site's breadcrumb.

Delete the other five lists. Any tool not on the list does not exist; any tool on it appears everywhere.

### One place for settings, limits and quotas

**Decision:** the existing admin limits, extended.

Crawl ceilings, page budgets, spend caps and feature switches all move here — versioned, auditable, changeable without a deploy. The environment file holds credentials and nothing else, and it is documented in full.

### One way to buy outside data

One connection per provider. One cache. One budget that every tool draws from and every tool can see.

**Decision:** budget is checked **before** the call, not reconciled after. That is what AI Visibility already does, and it is the only approach that can actually stop an overspend.

### One report layer

One place that turns "everything we know about this client" into a document — Excel, Word, slides or a link. Tools contribute sections; they do not each build their own exporter.

Today there are 18 separate export builders on the server and 13 more in the browser.

### What to delete

| Delete | Why |
|---|---|
| The old Competitor Analysis Report screen and its parts | Unplugged; the tracker replaced it |
| The unused tool catalogue | Nothing reads it, and it disagrees with the real menu |
| The unfinished team insights screens | Nothing reaches them and nothing documents them |
| The duplicate progress-steps and keyword-parser components | Half-finished moves, both copies still present |
| The committed scraped pages from client sites | 340 files of third-party website content in our code |
| Old status documents that contradict the code | Four documents give four different accounts of what this app is |
| Duplicate credential backup files | Same live keys, twice, for no reason |

### What stays standalone — and why

| Stays separate | Why |
|---|---|
| **GBP QC Agent** | A different application on a different address. Link to it; do not absorb it. |
| **Location + Service Pages** | It is a content *production* line, not an analysis tool. It should share the client, the keywords and the report layer — but its approval workflow and page objects are genuinely its own. |
| **The one-off scripts** | Import and re-classification jobs an engineer runs by hand. They belong in the repository, not in the product. |

Everything else joins the core.

---

## Part 3 — twelve things that become possible only once we unify

These are the reason to do this at all. None of them can be built today.

1. **One client report.** A single document covering technical health, content architecture, competitors, keywords and AI visibility — because for the first time they are all about the same client record.

2. **Triage that sticks.** Mark an issue "won't fix" once. Every future crawl respects it. Today you re-triage every week.

3. **"What changed this month."** Compare this crawl to the last one and say which pages got better, which got worse, and which recommendations moved the needle.

4. **Fix lists that know what they cost.** Rank recommendations by the traffic of the pages they affect — because the audit and the traffic data finally point at the same page record.

5. **Competitor gap on your own pages.** Show, on each of your pages, the keywords a competitor ranks for and you do not — impossible today because the tracker and the crawl share no page identity.

6. **AI visibility tied to real pages.** When ChatGPT cites a competitor instead of you, show which of *your* pages should have won it, and what the audit says is wrong with it.

7. **Brief straight from the gap.** Turn a content gap into an article brief in one click, with the client's brand voice already attached — no re-typing the client, no re-typing the keyword.

8. **Location pages that start from real demand.** Feed the market-potential ranking straight into the page builder, so you build pages for the metros that are actually worth it.

9. **One bill per client.** Show what a client cost this month across every provider, and stop a run before it goes over budget.

10. **Alerts that carry context.** When monitoring finds a live page gone no-index, say what that page is worth and which recommendation it relates to — instead of a bare Slack line.

11. **One crawl feeding six audits.** Crawl once, then run the technical audit, the content clusters, the alt-tag audit, the on-page audit and the readiness audit off the same stored pages. Fewer requests to the client's site, and far faster.

12. **A real client timeline.** Every crawl, audit, capture and approval for one client, on one timeline, in one place — because they finally all record against the same client.

Next: [The plan](05-the-plan.md)
