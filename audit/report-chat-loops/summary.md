# Report chat: 20 test loops (2026-11-03)

These loops ran real questions against real production projects. The data access was read-only: nothing was saved to prod. The model was gpt-5.4-mini, with live web search, going through the same answer loop as the route. Total spend was **$2.58** of the $5 budget. After each loop I fixed what it found, then built the next loop's questions to re-test those fixes.

**Projects:** LogicGate and Soteri Skin for Tech Audit, and Soteri Skin for every other screen. No project has a scraped AI Visibility report, so that screen was only checked in code.

## The loops

| Loop | What it tested | What it found → fix |
|---|---|---|
| 1 | Tech Audit deep maths (LogicGate) | **Error total:** worked out as "40 × 169 pages"; the right total is the sum of the 5 rules. → Each severity's total is now spelled out. **Unasked advice:** calculation answers got advice too. → Rule: answer only what was asked. **Specialist card on the wrong answers.** → It's now decided per answer. |
| 2 | SEO & GEO + regressions | **Error total showed 4.92, not 4.91:** it summed rounded parts. → Exact sum. **Internal jargon:** answers named internal fields and check ids like "T11". → No-jargon rule. |
| 3 | Agent Readiness, AI Visibility | **Missing card:** advice answers without the specialist card. → Any "In general" advice section now shows the card. **Contradiction:** "Gemini cites most… actually Anthropic". → No-self-correction rule. **Wrong total:** the SEO & GEO check total was given as 11.18 instead of 16.13. → Totals by area and by status are precomputed. |
| 4 | Competitor, Hub & Spoke | **Hub:** named the 65 cluster weakest, then a 64 one. → Clusters are sorted weakest first, with each health sum written out. **Competitor:** 4.16% vs 4.17% in different answers. → Exact percentage precomputed. **Made-up attribution:** "According to recent coverage" without a search. → Only allowed after a search. |
| 5 | General SEO expertise | **Local SEO declined as off-topic.** → Scope widened. **Mental arithmetic:** a traffic gap worked out by hand, corrected mid-answer, then cut off. → Gaps precomputed per competitor. |
| 6 | Current events (web search) | **Card dropped after a search.** → A final-check message now comes last. **Upsell endings:** "If you want, I can…". → Removed. **Tracking junk in source links.** → Stripped. |
| 7 | Safety and manipulation | All held. **Page vs module score:** confirming a false "97" answered with 75 (module) instead of 84 (page). → A score-on-screen section now names both. |
| 8 | Multi-turn threads | **Mislabel:** "errors cost 35 points" (that's all severities). → The total loss is spelled out by severity. **Agent 41 vs 42.** → Score-on-screen section. |
| 9 | Overview / project level | **False promise** on pages it can't read ("open it and I'll…"). **Top problems** listed in mixed order. → Rules are now sorted by cost. |
| 10 | UI, every API call mocked | **Dropped connection:** left a silent empty bubble. → Now shows "The answer was cut off". 22/22 checks pass. |
| 11 | Tech Audit on a second site | All maths exact. **"Top 3"** order clarified. |
| 12 | Phrasing robustness (typos, Spanish, one word, angry) | **Double negative** ("not named in 0 of 60"). **Second list** in a different order. → Top-5-by-points list precomputed. |
| 13 | Hallucination traps | All traps held. **Fix list:** a 0-point 4XX item was implied to hurt the score. → Fix-list items on the Tech screen now carry their points. |
| 14 | Navigation and links | **Mislabelled link:** "Google docs" linked to "/". **Wrong decline:** "how do I add a competitor" got "SEO only". → Link and app-usage rules. |
| 15 | Arithmetic stress | **Right number, wrong reasoning:** "21 more points" reached by subtracting scores. **Drifting sums** in the reach-80 walk-through. → Fewest-fixes-to-reach and points-to-earn precomputed. |
| 16 | Vague CMO questions | **False comparison:** "You trail competitors" when all three were at 0%. → Brand comparison line that names ties as ties. |
| 17 | AI Visibility and Hub depth | **"Biggest"** read as "weakest". → Size-word rule. |
| 18 | Real route end to end (in-memory store) | 13/13 pass: validation, 404, 429, SSE order, history, tampered screen copy, unknown screen, new conversation. |
| 19 | Sweep of every earlier failure | 10/11 fixed. **Mislabelled link, again.** → Client guard: an app link labelled as an outside site renders as text. |
| 20 | Consistency (each question twice) | **One run used rounded bars instead of exact figures. One run invented a "No H1" cap.** → Caps-on-this-page line plus a final check. The confirmation re-run was consistent 4/4. |

## Where it stands

- **Tests:**
  - Server: 6 of 7 report-chat suites pass. storeDb needs the local test Postgres on port 5433, which is down as usual, and store.js was not changed.
  - Client: 110 tests pass.
  - UI: 22/22 checks pass on a fresh build.
- **Still model-dependent, but much rarer now:**
  - the specialist card is now and then missed on borderline answers;
  - an intermediate sum can drift by 0.02 when the model skips the calculator, though final figures were right in every late loop.
- **Out of scope:** see recommendations.md.
