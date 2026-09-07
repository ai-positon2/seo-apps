# What we have

SEO Studio is **21 tools** plus **5 shared foundations**. One login covers all of them. One address serves all of them. Beyond that, they mostly do not know each other exists.

**Distance from unified** is scored 1 to 5.
**1** = already part of the shared core. **5** = a separate app wearing our badge.

---

## The 21 tools

| # | Tool | What you use it for | How you reach it | Health | Distance |
|---|---|---|---|---|---|
| 1 | **Project Dashboard** | The home screen. Pick a client, see their site's scores, run audits, read the backlog. | Home page | Working | 1 |
| 2 | **Site Crawler** | Crawl a whole site, watch it live, triage 96 technical checks, export an Excel audit, schedule it weekly. | Sidebar | Working | 2 |
| 3 | **AI Visibility** | Measure whether the brand shows up in ChatGPT, Gemini and Google's AI answers. | Sidebar | Working | 2 |
| 4 | **SEO & GEO Audit** | Score one page on 200+ SEO and AI-answer checks and get written recommendations. | Sidebar | Partly working | 2 |
| 5 | **Agent Readiness Audit** | Score a site out of 100 on how ready it is for AI agents and crawlers. | Sidebar | Partly working | 2 |
| 6 | **Run History** | See what your team ran, when, and against what. | Header | Partly working | 2 |
| 7 | **Content Architect** | Map a whole site into topic clusters, find the hubs, the orphans and the content gaps. | Sidebar | Working | 3 |
| 8 | **Location + Service Pages** | Build approved, dev-ready location pages for a client, service and town. | Sidebar | Working | 4 |
| 9 | **Knowledge Base** | Hold each client's brand voice, industry rules and feedback, and feed them to the AI tools. | Sidebar | Partly working | 4 |
| 10 | **Competitor Tracker** | Track a client's competitors, their keywords, their content and their page speed. | Sidebar | Partly working | 4 |
| 11 | **On-Page Audit** | Audit a set of pages on one site and store the results. | Only inside the SEO & GEO Audit screen | Partly working | 4 |
| 12 | **Market Potential** | Rank nearby metros by commercial search demand for a healthcare service. | Sidebar | Partly working | 5 |
| 13 | **Robots Monitor** | Watch client domains daily and alert on Slack when a live page goes no-index. | **Type the address — no link anywhere** | Partly working | 5 |
| 14 | **Content Enhancement** | Rewrite a page for structure, authority, FAQs and AI-answer readiness. | **Type the address — no link anywhere** | Partly working | 5 |
| 15 | **Keyword Research** | Find competitors for a seed keyword, pull their rankings, shortlist primary and secondary keywords. | Sidebar | Partly working | 5 |
| 16 | **Content Research** | Scrape the top 10 ranking pages for a keyword and build a content brief. | Sidebar | Partly working | 5 |
| 17 | **Article Recommendation** | Turn a keyword's top 10 results into a full article brief with headings and FAQs. | Sidebar | Partly working | 5 |
| 18 | **Article Enhancement** | Crawl a live article, run five AI analyses against competitors, return an enhanced version. | Sidebar | Partly working | 5 |
| 19 | **Article Enhancer (lite)** | Improve an article using only its own words — never invents stats or quotes. | Sidebar | Partly working | 5 |
| 20 | **Image Alt Tag Audit** | Scrape 100+ pages, write alt tags and filenames, export a colour-coded workbook. | Sidebar | Partly working | 5 |
| 21 | **Competitor Analysis Report** | The older competitor report with its own PDF and slide export. | **Nowhere — the screen was unplugged** | Broken | 5 |

There is also a **GBP QC Agent** listed in an old, unused menu. It is a link out to a completely different application on another address. It is not part of this app and this plan does not cover it.

---

## What each tool needs, makes, and keeps

| Tool | Needs to start | Produces | Where the result lives | Uses the shared project? | Uses the shared crawl? |
|---|---|---|---|---|---|
| Project Dashboard | A client and a domain | Scores, backlog, recommendations | **Database** | Yes — it *is* the project | Yes |
| Site Crawler | A domain, or a list of addresses | Live crawl, 96 checks, Excel audit | **Database** | Yes | It *is* the crawl |
| AI Visibility | A project and approved prompts | Mentions, citations, share of voice | **Database** | Yes | No — its own capture |
| Run History | Nothing | A list of past runs | **Database** | Partly | No |
| SEO & GEO Audit | One address, or pasted page code | Score, category breakdown, AI advice | **Nothing is saved** from its own screen | Only when run from the dashboard | No — refetches the page |
| Agent Readiness Audit | A domain | Score out of 100, executive brief | **Nothing is saved** from its own screen | Only when run from the dashboard | No — refetches the site |
| Content Architect | A domain | Clusters, hubs, orphans, gaps, workbook | **Files on the server's disk** | Partly — can reuse crawl pages | Partly — has its own crawler too |
| Location + Service Pages | A client, service and location | Approved page package, export | **Database tables that this repo does not define** | No — its own client list | No |
| Knowledge Base | A client name | Brand, industry and feedback documents | **Files on the server's disk** | No — its own hardcoded client list | No |
| Competitor Tracker | A client and competitor domains | Keyword gaps, content map, speed scores | **Files on the server's disk** | No — its own client list | No |
| On-Page Audit | A domain and page list | Per-page audit records | **Files on the server's disk** | No | No — its own fetcher |
| Market Potential | A service and home metros | Ranked metro table and map | **Files on the server's disk** | No — its own service list | No |
| Robots Monitor | Client domains and a Slack address | Daily no-index report, Slack alerts | **Files on the server's disk** | No — its own client list | No — its own sitemap reader |
| Content Enhancement | One address or pasted page code | Copy-ready upgrades | **Nothing is saved** | No | No — its own fetcher |
| Keyword Research | A seed keyword | Primary and secondary keyword shortlist | **Nothing is saved** | No | No |
| Content Research | A keyword | Content brief, Word export | **Nothing is saved** | No | No — its own scraper |
| Article Recommendation | A keyword | Article brief, Word export | **Nothing is saved** | No | No — its own scraper |
| Article Enhancement | An article address | Enhanced article with highlights | **Nothing is saved** | No | No — its own fetcher |
| Article Enhancer (lite) | An article address or text | Enhanced article with highlights | **Nothing is saved** | No | No — its own fetcher |
| Image Alt Tag Audit | A list of page addresses | Alt tags, filenames, Excel workbook | **Nothing is saved** | No | No — its own scraper |
| Competitor Analysis Report | A client and competitors | PDF and slide report | Unreachable | No | No |

---

## The 5 shared foundations

| Foundation | What it does | Health | Distance |
|---|---|---|---|
| **Login, workspaces and admin** | One Google sign-in, workspaces, roles, a platform administrator, spending limits. | Working | 1 |
| **Run history and the job runner** | Records what ran and executes scheduled work in the background. | Partly working — there are two separate job runners and eight separate records of "a run" | 3 |
| **The look and feel** | The sidebar, the window frame, the shared buttons and cards. | Partly working — seven competing sets of the same components | 3 |
| **Buying outside data** | Keyword data, AI-answer data, page-speed scores, AI model calls. | Partly working — no shared connection, cache or budget | 4 |
| **Legacy scripts and scraped files** | Old one-off scrapers, import scripts and 340 committed scraped pages from client sites. | Dead code | 5 |

---

## The headline counts

| What | How many |
|---|---|
| Tools | 21 |
| Shared foundations | 5 |
| Tools that hang off the shared project | 5 |
| Tools that save nothing at all | 9 |
| Tools that save to a disk that is wiped on every deploy | 6 (including the Knowledge Base) |
| Tools you can only reach by typing the address | 2 |
| Screens that exist but nothing links to | 1 |
| Files nothing can reach | 16 |
| Separate ways the app says "who the client is" | 5 |
| Separate lists of "what tools exist" | 6 |
| Separate records of "a run" | 8 |
| Separate background job systems | 12 |
| Separate technical checks in the crawler | 96 |

Next: [How it connects today](02-how-it-connects-today.md)
