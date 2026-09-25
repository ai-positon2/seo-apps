# Plan: one client, everywhere (audit fix 1)

**What this fixes.** From [the audit](01-audit.md): APP-1, CRS-1, CMP-1, CW-1, LOC-1, KB-3, HID-1 and CAR-2. You pick a client in the header, but five tools keep their own client lists and ignore it.

**How it relates to earlier plans.** This is **Stage 2** of [the unification plan](../unification/05-the-plan.md#stage-2--one-client-everywhere-the-one-big-bang), unchanged in intent. This page adds the screen-by-screen detail the audit found, and the order to do it in. The rule from Stage 2 still holds: **do it in one push**. A half-migrated client concept is worse than either end state.

**Status (25 Sep 2026): partly done, and blocked on one decision.** The code has not been deployed, and the migration has not been run.

**Done in the code:**
- **Tools now follow the header** without any data change:
  - **Content Writer** no longer has its own project picker, and never changes the header. A link to another client's article offers an explicit "Switch to …" instead.
  - **Content Research's** brand defaults to the header client's Knowledge Base brand. "Use a different brand" stays available as an override.
  - **The Knowledge Base list** opens filtered to the header client, and keeps the shared "global" entries visible.
  - **Location + Service Pages** opens the header client's own builder. A client without one gets a plain explanation, with the three set-up clients listed.
  - **The Content Architect report** prefills competitors from the project when it has none of its own.
  - **Competitor Analysis** says when its competitor list differs from the project's, and offers "Use the project's competitors".
- **The migration is written:** `supabase/migrations/0038_client_lists_project_link.sql` adds a nullable `project_id` to the three client-list tables. It was checked in PGlite: it re-runs safely, and deleting a project clears the link without deleting the record. **It has not been applied.**
- **Step 1, the match report, is built and was run read-only:** `node server/scripts/clientListInventory.js --out report.json`. The script locks its own session to read-only.

**What the match report found:**

| List | Records | Matched to exactly one project | Needs a decision |
|---|---|---|---|
| Competitor Analysis | 9 | 1 | 8: 3 "ambiguous", 5 with no project at all (Palo Alto Networks, Beta Bionics, Hyster, Amazon, Flipkart) |
| Knowledge Base brands | 6 | 0 | 6: Riccobene and Gentle Dental ambiguous; Great Lakes, Clear Behavioral Health, Neuro Wellness Spa, New Life House have no project |
| Location Pages | 0 | — | The table is empty, which is why both wizards say the client isn't set up |
| Robots Monitor | 0 | — | Nothing to move |

**The decision needed before step 2's fill:** the same client exists as separate projects in several people's personal workspaces. Riccobene is in three, Acalvio in three, Gentle Dental in two. The tools' own lists are shared by everyone, so each record must be tied to one **canonical** project. Pick one of these:
- **(a) A shared "clients" workspace.** Move each client's project there and delete the personal copies.
- **(b) Keep personal copies.** Nominate one as canonical per client.

Option (a) matches "one client, everywhere". Either way, the five tracker clients with no project need a project created, or they get archived.

**Still to do:**
- **Fill the new column** from the reviewed report, as a reviewed script run by a person, not from a laptop whose `.env` points at production.
- **Switch the reads.** Competitor Analysis should read `project_id` instead of matching by domain.
- **Give Knowledge Base entries a `project_id`** in the file index.
- **Connect Robots Monitor to projects.**
- **Remove the old lists** a release later.

---

## What the reader will notice when it's done

- **The header decides the client.** Pick "Riccobene" in the header, and every tool opens on Riccobene. You never pick the client a second time.
- **One competitor list per client.** Home, Competitor Analysis and Content Architect all show the same competitors.
- **Gaps are listed, not hidden.** Tools that can't yet find a client's data show a "needs assigning" message, not another client's numbers.

## The separate client lists today

| Tool | Where its list lives | What happens today | What it becomes |
|---|---|---|---|
| Content Research | "Brand" picker on the page, fed by the Knowledge Base's brand names | You pick the brand again, and "No client (generic)" is the default | Brand = the header's project. The picker goes. |
| Competitor Analysis | Its own `clients` records (server `modules/competitorAnalysis/store.js`) matched to projects by domain | Own "Client" dropdown; Riccobene is compared with a different set of competitors from Home's | Each tracker client belongs to one project. Competitors come from the project's competitor list. The dropdown goes. |
| Knowledge Base | Hard-coded brand names in the client code (`BRANDS` / `CLIENTS` in `KBEditorPage.jsx`, `CreateKBPage.jsx`, `ClientFeedbackPage.jsx`) and the file index | Its own "All clients" filter; brand names don't match project names | Each brand and feedback entry is attached to a project. The filter defaults to the header client. |
| Location + Service Pages | Client ids hard-coded per route (`client_gentle_dental`, `client_clear_behavioral_health`, Neuro) | The menu item opens "Gentle Dental Pages" whatever the header says | One entry point that opens the header client's wizard, or says this client has no location-page setup. |
| Robots Monitor | Its own client list (`modules/robotsMonitor/monitorStore.js`) | Separate list, not in the menu | Monitored domains come from projects. A client is monitored or not, from its project. |
| Content Writer | Already per project, but has its own "Project" picker and rewrites the header's choice when an article opens | Opening an article silently switched the header client | Follows the header. It never changes the header on its own. |
| Content Architect report | Asks for competitor domains again | Re-entering data the project already has | Reads the project's competitors. |

## Order of work

1. **Inventory and match.** Takes 1–2 sessions.
   - For every record in the five lists, find its project by domain. Where there's no match, add it to the "needs assigning" list.
   - Output a report for review; nothing is written.
   - This is where the Knowledge Base's hard-coded names get mapped.
2. **Add the reference.** Takes 1 session.
   - Give each of those records a `project_id`, as a migration that only adds a column.
   - Fill it from the reviewed match report.
   - The old lists stay, read-only, for one release (the Stage 2 rollback).
3. **Switch the tools over,** one per session, in this order (highest traffic first):
   1. Competitor Analysis
   2. Content Research
   3. Knowledge Base
   4. Content Writer (the smallest change)
   5. Content Architect's competitor field
   6. Location Pages
   7. Robots Monitor

   Each switch removes that tool's own picker and reads the header's project.
4. **Remove the old lists** a release later, once the "needs assigning" list is empty.

## What could break, and the check for each

| Risk | Check |
|---|---|
| A tracker client or KB entry that matches no project disappears from its tool | The "needs assigning" list must be empty before step 4. Until then, the old lists stay readable. |
| The AI writing tools lose a client's brand voice if its KB entry isn't mapped | Compare, before and after, each writing tool's inputs for each client (it names the brand and industry entries it used). |
| Location Pages' two pipelines (Gentle Dental wizard, template wizard) behave differently | Run both wizards end to end on a test client before switching the menu entry. |
| A bookmark to a tool with no client selected lands on an empty screen | Every tool shows "Pick a client in the header" in that case (Content Architect already does this). |

## How you'll know it worked

- **Every screen follows the header.** Switch client in the header, then visit every tool in the menu: each one is about that client, with no typing.
- **Home and Competitor Analysis agree** on the client's competitors.
- **Nothing is left unassigned:** the "needs assigning" list is empty.
