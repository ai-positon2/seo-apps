# What's in the way

Ten problems, worst first. Each one says how many copies exist, and which copy we keep.

---

## 1. Work disappears on deploy — three different places to save

**In plain English:** the app has three unrelated ways of remembering things, and two of them forget.

| Way of saving | How many tools use it | Survives a deploy? |
|---|---|---|
| The shared database | 6 | **Yes** |
| Files on the server's own disk | 6 | **No** |
| The server's short-term memory | 9 | **No — lost on any restart** |

The disk files are deliberately excluded from the shipped application, so a fresh deploy starts with empty folders. Anything written since the last deploy is gone: client lists, competitor sets, market scenarios, page audits, monitoring history, and every Knowledge Base edit made through the editor.

This is not a background concern. The Project Dashboard itself reads and writes two of those disk stores, so a deploy can leave a project's competitor and cluster data blank with no error shown.

**Keep:** the shared database. It is already workspace-aware, already backed up, already used by the strongest parts of the app.

---

## 2. "A client" means five different things

**In plain English:** the client picker in the header does not control most of the app.

| Where a client is defined | Who uses it |
|---|---|
| The project you pick in the header | Dashboard, Crawler, AI Visibility |
| A hardcoded list of six client names, written out five separate times | Knowledge Base and the four writing tools |
| Competitor Tracker's own client file | Competitor Tracker |
| Robots Monitor's own client file | Robots Monitor |
| One client id typed permanently into the code | Location + Service Pages |

Only 7 places in the whole front end read the header's client. The four biggest tool screens each keep their own idea of who the client is, so switching client in the header changes nothing on them.

Underneath, the site itself is spelled out in **six** different records, and nothing keeps them in step: the project row, the domain list, a separate brand-and-alias record, the page-builder's client, and two client files on disk.

**Keep:** the project and its domain list. It is the only one that knows about workspaces and permissions.

---

## 3. We crawl the same site up to five times

**In plain English:** every tool that needs to look at a web page wrote its own way of fetching it.

| Job | How many copies | Which one is good |
|---|---|---|
| Full site crawler | 2 | The Site Crawler |
| Sitemap reader | 3 | The Site Crawler's |
| robots.txt handling | 12 places reference it, **1** actually obeys it | The Site Crawler's |
| Fetching a page from the open web | 15 | The Site Crawler's |
| Checking an address is safe to fetch | 2 | The Site Crawler's |
| Reading the page's HTML | 14 | No single winner yet |
| Launching a browser | 5 | AI Visibility's — it is the only one that reuses browsers |
| Tidying up a web address | 11 | Content Architect's |

Only the Site Crawler obeys robots.txt, honours crawl delay, paces itself per site, and refuses to fetch an unsafe address. **The other fourteen fetchers do none of that.** Nothing limits how many browsers run at once across the five launchers.

**Keep:** the Site Crawler's fetching layer, and AI Visibility's browser pool. Everything else calls those.

---

## 4. The same thing is stored in incompatible shapes

**In plain English:** two tools can look at the same page and produce records that cannot be compared.

| Concept | Number of incompatible shapes | Why it hurts |
|---|---|---|
| A **site** | 6 | You cannot ask "everything about this domain" |
| A **page** | 6 | Only one of them survives a re-crawl; the rest key off the raw address, spelled differently |
| An **issue or finding** | 7 | Four of them describe the *same crawl*, and the other tools use an untyped free-form list |
| A **run** | 5 | "What did we run for this client" needs three tables with three different status words |
| An **approval step** | 5 | Five approve/reject flows with five different vocabularies |
| A **schedule** | 2 | A project has two cadences that do not know about each other |

The worst of these is the issue. Triage decisions are attached to a single crawl and keyed on a fingerprint of that run, so they do not survive the next crawl. And a crawl finding cannot become a recommendation — the durable recommendations list only accepts findings from the other five modules.

**Keep:** the durable page record (the only one with a stable, cleaned-up address) and the per-occurrence findings table. Widen the recommendations list to accept a crawl finding.

---

## 5. Two job runners, eight records of "a run"

**In plain English:** background work was built twice, and neither one can see the other's jobs.

| What | How many | Detail |
|---|---|---|
| Background job systems | 12 | Built on 4 different mechanisms |
| Queues that claim work from the database | 2 | Same design, written twice, different settings |
| Schedulers | 4 | Two calendar libraries in one app |
| Clean-up sweepers for stuck jobs | 4 | Four different definitions of "stuck", two of them fighting over the same table |
| Records of "a run" | 8 | 3 in the database, 1 on disk, 4 in memory |
| Live-progress streams | 12 | 11 of them die if the connection drops |
| "Start a job, then poll it" mini-systems | 4 | All in memory, so all break with more than one server |

The second queue's own source notes say it was copied from the first "rather than inventing a second one" — but the result is a second one.

**Keep:** the Site Crawler's queue design. It is the more mature of the two — it survives restarts, resumes part-finished work, and drains cleanly on shutdown.

---

## 6. We buy the same data more than once

**In plain English:** there is no single place that talks to a paid provider, so there is no single bill and no shared cache.

| Provider | Separate connections | Separate spending caps |
|---|---|---|
| SEMrush (keyword data) | 4 connections, 5 result parsers | 3 caps, all set to the same number, none aware of the others |
| DataForSEO (AI-answer data) | 2 | 1 — only one of the two tracks cost at all |
| PageSpeed (site speed) | 2 | 0 — one has careful pacing, the other has none and will trip the shared quota |
| AI models | 10 connections | 0 shared |

There is a shared connection for AI models, and 17 places use it — but **9 other places ignore it** and connect directly, bypassing its safety handling.

One documented spending cap in the settings file is read by no code at all.

**Keep:** the AI-model factory that already exists, the careful PageSpeed client, and AI Visibility's spend ceiling — it is the only one that checks the budget *before* spending rather than after.

---

## 7. Six lists of "what tools exist" — and two tools nobody can find

**In plain English:** nobody can answer "what tools does this app have" from one place.

| List | What it drives | How many tools |
|---|---|---|
| The sidebar list | The menu you see | 15 |
| An old catalogue with full descriptions | **Nothing — no code reads it** | 18 (2 of them broken stubs) |
| An icon list in the window frame | Icons | 18 |
| A label list in Run History | Run names | varies |
| The dashboard's module list | The audit cards | 6 |
| The list of what the dashboard can actually run | Real work | 5 |

They already disagree. Robots Monitor and Content Enhancement are missing from the sidebar entirely — you can only reach them by typing the address. Because the sidebar is also what tells the parent website which tool you are on, those two tools also break the breadcrumb of the site that frames us.

**Keep:** the sidebar list, extended to carry the descriptions from the dead catalogue. Delete the other four.

---

## 8. Seven versions of the same button

**In plain English:** the app has a design system, and most screens ignore it.

| What | Count |
|---|---|
| Shared components that exist | 20 |
| Screens that use them | 10 of 36 |
| Rival component sets built inside individual tools | 6 |
| Versions of the score ring | 4 |
| Versions of the status badge | 5 |
| Versions of the metric tile | 6 |
| Shared components nothing uses | 6 |
| Separate ways to talk to the server | 11, plus 19 screens that bypass all of them |

Two components are byte-for-byte copies in different folders. Two more started identical and have already drifted apart.

Only one of the eleven server-talking helpers reports *why* a request failed, so most screens cannot tell "you are logged out" from "the server broke".

**Keep:** the shared component set. Fold the six rival sets into it, starting with the two report kits that are already near-identical.

---

## 9. Settings are scattered, and secrets sit in the working folder

**In plain English:** there is no single settings file, and no single answer to "what does this app need to run".

| What | Count |
|---|---|
| Settings read directly from the environment | 117 |
| Of those, documented in the example settings file | 58 |
| **Undocumented** | 59 |
| Documented but read by no code | 22 |
| Separate places that read settings | 219 |
| Separate settings files per tool | 11 |
| Fixed numbers buried in code that behave like settings | 256 or more |
| Files in the working folder holding live credentials | **3** |

Two of those three credential files are timestamped backups holding the same live keys, including a private key. All three are correctly excluded from the code repository and the shipped app — but they are still sitting on the machine.

The example settings file also documents the wrong port number, which breaks local development for anyone who follows it.

**Keep:** the database-backed admin limits, extended to cover the crawl ceilings. One settings loader, one documented file.

---

## 10. What breaks when two things run at once

These are the failure modes that produce no error message.

| Risk | What happens | Why |
|---|---|---|
| **Two servers** | "Start job, check progress" silently never finishes | 4 job registries live in one server's memory |
| **Two servers** | Daily monitoring runs twice and writes two different histories | Its schedule has no shared lock and writes to local disk |
| **Any deploy** | Six tools lose their data | Their storage is not part of the shipped app |
| **Any restart** | Nine tools lose in-flight work | Results were never written down |
| **Two page-speed jobs** | Both get rate-limited | Two clients, one shared quota, only one paces itself |
| **Five browser launchers** | Memory exhaustion | Nothing caps the total across them |
| **Two crawl schedules** | The same site crawled twice | Two schedulers on one project that do not know about each other |
| **A stuck job** | Healthy 20-minute audits killed early | Two sweepers on the same table, one using a 10-minute cutoff |

The last one has already happened and is worked around in code rather than fixed.

---

## Scoreboard

| Problem | Copies to remove | Difficulty | Damage today |
|---|---|---|---|
| Work disappears on deploy | 6 tools + the Knowledge Base | Medium | **Severe** |
| Five meanings of "client" | 4 | Medium | **Severe** |
| Duplicate crawling and fetching | 14 | Large | High |
| Incompatible data shapes | 20+ | Large | High |
| Two job runners | 1 | Medium | Medium |
| Buying data more than once | 14 | Medium | Medium — and it costs money |
| Six tool lists | 4 | Small | Medium |
| Seven design systems | 6 | Medium | Low, but visible |
| Scattered settings | 10 | Small | Low |
| Same-time collisions | — | Medium | Hidden until it bites |

Next: [What unified looks like](04-what-unified-looks-like.md)
