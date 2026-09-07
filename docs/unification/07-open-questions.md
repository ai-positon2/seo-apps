# Open questions

Decisions only you can make. Each has options and a recommendation. **Blocking** ones stop work; the rest can be answered as we go.

---

## Blocking — answer before Stage 1

### 1. Is the server's disk actually wiped, or is there a mounted volume?

Five tools and the Knowledge Base write to folders that are excluded from the shipped application. Whether that data survives depends on hosting settings that are not in this repository.

| Option | Consequence |
|---|---|
| **A. No volume — data is lost on every deploy** | Confirms the worst case. Stage 1 becomes urgent and we must warn users that historic data is already gone. |
| **B. A volume is mounted** | Data survives today, but the tools still cannot be run on more than one server, and the data is still not backed up with the database. Stage 1 stays, but loses its urgency. |

**Recommendation: check this today.** It changes whether Stage 1 is a fix or an emergency. Either way we still do Stage 1 — one place for data is the point.

### 2. Do the Location Pages tables exist in the live database?

That tool reads and writes ten tables that no file in this repository creates. Its code refers to an initial setup file that is not here.

| Option | Consequence |
|---|---|
| **A. They exist, created by hand** | We must capture their real structure before touching anything. |
| **B. They do not exist and the tool is failing** | The tool is broken in production and we should know now. |

**Recommendation: check, then bring them under version control either way.** A live tool running on undocumented tables is the single largest unknown in the audit.

### 3. Where is the specification?

Twenty-six server files cite section numbers from a product requirements document. That document is not in the repository.

| Option | Recommendation |
|---|---|
| **A. It exists elsewhere** | Bring a copy in, or the citations are unfollowable for anyone new. |
| **B. It no longer exists** | Strip the citations during Stage 7 so they stop implying a document you cannot read. |

**Recommendation: find it and commit it.** Roughly a tenth of the server is written against a document nobody can open.

---

## Blocking — answer before Stage 2

### 4. Which client concept is canonical, and how do we map the Knowledge Base?

We recommend the project record. The open part is the Knowledge Base: it uses six client names written out five times by hand, with no link to your projects.

| Option | Trade-off |
|---|---|
| **A. Map each Knowledge Base client to a project *(recommended)*** | One client everywhere. Needs a one-time mapping and a decision for names with no matching project. |
| **B. Keep the Knowledge Base global and per-name** | Less work now. Keeps a second client concept forever, and the writing tools stay disconnected. |

**Recommendation: A.** But you must tell us what to do with Knowledge Base entries that match no project — archive them, or create projects for them?

### 5. Is the Neuro Wellness page pipeline still live?

The Location Pages tool holds two separate pipelines. One is the front door. The other has one client id typed permanently into the code and **nothing in the app links to it** — you can only reach it by typing the address.

| Option | Consequence |
|---|---|
| **A. Retired — delete it** | Removes a 325-line screen and a hardcoded client id. |
| **B. Still live for that client** | It must get a real client reference in Stage 2, and a menu entry. |

**Recommendation: A, unless that client is still being served.** A tool reachable only by typing a URL is not a tool.

### 6. Are the hidden tools hidden on purpose?

Robots Monitor and Content Enhancement have no menu entry and nothing links to them. Because the menu also tells the parent website which tool you are on, both also break its breadcrumb.

| Option | Consequence |
|---|---|
| **A. An oversight — add them to the menu *(recommended)*** | Two working tools become discoverable. |
| **B. Deliberately hidden for a public embedded view** | Fine, but they still need to be in the one tool list, marked hidden. |

**Recommendation: A.** Robots Monitor is a genuinely valuable agency tool that nobody can find.

---

## Product decisions — answer before the stage that needs them

### 7. Delete or restore the old Competitor Analysis Report? *(Stage 7)*

Its screen was unplugged, but its seven server endpoints still exist, and one button on the dead screen calls an address that no longer answers.

| Option | Trade-off |
|---|---|
| **A. Delete it *(recommended)*** | Removes 6 dead files and 7 orphan endpoints. Loses its PDF and slide export. |
| **B. Restore it** | Two competitor tools with different permissions and different data. |
| **C. Keep only its PDF and slide export** | Folds into the Stage 7 report layer. |

**Recommendation: C, then A.** Move the export formats into the shared report, then delete the rest.

### 8. What are the unfinished team screens? *(Stage 7)*

Six substantial screens exist that nothing reaches and no document mentions.

| Option | Recommendation |
|---|---|
| **A. Abandoned — delete** | Recommended unless someone claims them |
| **B. Awaiting a route — finish** | Then they need a place in the plan |

**Recommendation: ask the team who wrote them.** They look deliberate, not accidental.

### 9. Two fully-built features have no screen. Build the screens, or delete? *(Stage 4)*

- A complete page-inventory interface exists on the server — read, edit, exclude, include, history, sync — and nothing calls it.
- A complete issue-triage write path exists — single and bulk, with a 5,000-row cap — and its screen was removed.

| Option | Trade-off |
|---|---|
| **A. Build the screens *(recommended for triage)*** | Triage that survives re-crawls is a headline benefit of Stage 4, and the hard half is already written |
| **B. Delete both** | Simpler, but throws away working code |

**Recommendation: build the triage screen in Stage 4; decide on page inventory then.**

### 10. Should crawl limits live in the database or in environment settings? *(Stage 6)*

Both exist. The database version's own notes say its crawl-size limit does not actually control a crawl today, and that the two defaults must be kept equal by hand.

| Option | Trade-off |
|---|---|
| **A. Database limits *(recommended)*** | Versioned, auditable, changeable without a deploy, per workspace |
| **B. Environment settings** | Simpler, but needs a deploy to change and cannot vary per client |

**Recommendation: A.** You are already paying for the table; it just is not wired up.

### 11. Should the budget stop a run, or record it afterwards? *(Stage 6)*

Three different answers exist today: one checks before spending, one only estimates, one reconciles after.

| Option | Trade-off |
|---|---|
| **A. Check before spending *(recommended)*** | The only option that can actually prevent an overspend. Some runs will be refused. |
| **B. Record after** | Never blocks work. Cannot stop a surprise bill. |

**Recommendation: A**, with a clear message naming the client and the limit.

### 12. Is the web tier ever run on more than one server? *(Stage 6)*

Four "start a job and check progress" features, two scheduled jobs and eleven live-progress streams all assume a single server.

| Answer | Consequence |
|---|---|
| **One server today** | The bugs are latent. Stage 6 removes them before you scale. |
| **More than one already** | Some of these are failing intermittently right now, silently. |

**Recommendation: tell us which**, because it changes Stage 6 from prevention to repair.

### 13. Does anything stay standalone besides the GBP tool?

We recommend keeping the GBP QC Agent as an external link, and letting Location + Service Pages keep its own approval workflow while sharing the client, keywords and reports.

| Option | Trade-off |
|---|---|
| **A. Only those two *(recommended)*** | Everything else joins the core |
| **B. Also keep Market Potential separate** | It is the least connected tool and serves one vertical — but it would stay a data island |

**Recommendation: A.** Market Potential is small; connecting it is cheap and unlocks feeding demand data into the page builder.

---

## Housekeeping — do these whenever

### 14. Can we delete the committed scraped client pages?

340 scraped pages from third-party client websites are committed to the repository, alongside a scraper that nothing references.

**Recommendation: delete both.** Storing other companies' website content in your codebase carries no benefit and some risk. Confirm nobody needs the archive first.

### 15. Can we delete the duplicate credential backups?

Two timestamped backup files hold the same live keys as the main settings file, including a private key. All three are correctly excluded from the repository and the shipped app.

**Recommendation: delete both backups, and rotate the keys** if there is any doubt about who has had access to that machine.

### 16. Should we fix the migration numbering collision?

Two migration files share the number 0009. A previous collision was already resolved by renumbering; this one was not.

**Recommendation: leave it and document it.** Renumbering a file that has already been applied somewhere risks more than it fixes. Add a note so the next person is not confused.

### 17. Can we drop the unused styling framework?

A CSS framework is configured but essentially unused — 17 usages, no utility colours — with about 105 lines of override rules for classes that no longer appear anywhere.

**Recommendation: drop both in Stage 7.** They are pure noise.

### 18. Which of the 22 unused documented settings are real?

The settings file documents 22 values that no code reads, including a set whose own comment claims they are enforced inside the database.

**Recommendation: verify the database-enforced ones, delete the rest.** In the same pass, document the 59 settings that the code reads but the file does not mention.

---

## A note on the brief

The brief you gave had placeholders for the app name, the module list and which modules already work together. Those were left unfilled, so we derived all of it from the code rather than asking. Two things worth confirming:

1. **The app has three names.** The interface says *SEO Studio*, the code package says *seo-automation*, and the readme says *SERP Content Researcher*. Pick one.
2. **We found 21 tools.** If your own list is shorter, the difference is the interesting part — it means tools exist that you did not know were still there.

Back to: [Read me first](00-read-me-first.md) · [The plan](05-the-plan.md)
