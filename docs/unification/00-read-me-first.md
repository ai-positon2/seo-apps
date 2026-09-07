# Read me first

**What this is.** An audit of SEO Studio as it stands today, and a staged plan to turn it into one app. Read this page; everything else is detail.

1. **You already own the hard part.** One login, one sidebar, one address, one deploy. The shell is real and it works. This is not a merge of separate products — it is finishing a job that is about 40% done.

2. **You have 21 tools and 5 shared foundations. Only 5 tools hang off the shared project.** Everything else asks the user for a domain again, from scratch, every time.

3. **Nine tools save nothing at all.** When you close the tab, the work is gone. Keyword Research, Content Research, Article Recommendation, both Article Enhancers, Content Enhancement, Image Alt Audit, Agent Readiness and SEO & GEO Audit all hold results in the server's short-term memory. A restart or a deploy loses them mid-run.

4. **Five more tools save to files on the server's own disk — and that disk is wiped on every deploy.** On-Page Audit, Robots Monitor, Market Potential, Competitor Tracker and Content Architect keep their client lists and results there. So do the Knowledge Base documents your team edits. This is the single most urgent thing on the list.

5. **"A client" means five different things.** The project you pick in the header, the Knowledge Base's own hardcoded client list, Competitor Tracker's client list, Robots Monitor's client list, and one client id typed permanently into the Location Pages tool. Switching client in the header changes nothing on four of the biggest tools.

6. **We crawl the same site up to five times.** There are two full site crawlers, three separate sitemap readers, five separate ways to launch a browser, and fifteen places that fetch a page from the open web. Only one of them obeys robots.txt and rate limits. Only one checks the address is safe to fetch.

7. **The same page, issue and run are stored in incompatible shapes.** Six ways to say "page", six ways to say "site", seven ways to say "issue", five separate records of "a run". Nothing joins them, so no tool can read another tool's answer.

8. **Two tools are invisible.** Robots Monitor and Content Enhancement have no entry in the sidebar and nothing links to them. You can only reach them by typing the address. One tool page and 15 other files are dead code nobody can reach.

9. **We buy the same data more than once.** Four separate connections to SEMrush, two to DataForSEO, two to PageSpeed, ten to the AI models — each with its own spending cap that does not know about the others. There is no single bill, no single cache, and no shared budget.

10. **The plan is six stages, and the first one is not a UI change.** Stage 1 moves every tool's saved work into the shared database so nothing is lost on deploy. Stage 2 makes every tool hang off the one project. After that, each tool moves over on its own and ships on its own. Only one stage is a big bang, and it is Stage 2.

---

**The one thing to do first:** move the five file-based tools and the Knowledge Base into the shared database. Until that is done, every deploy silently destroys customer work, and every other improvement is built on sand.

**The three biggest risks:** losing data on deploy (happening now), running two crawlers that both hit the same site, and third-party bills nobody can see in one place.

Next: [What we have](01-what-we-have.md) · [How it connects today](02-how-it-connects-today.md) · [What's in the way](03-whats-in-the-way.md) · [What unified looks like](04-what-unified-looks-like.md) · [The plan](05-the-plan.md)
