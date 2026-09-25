# Plan: one set of building blocks (audit fix 7)

**What this fixes.** From [the audit](01-audit.md): APP-2, APP-6, APP-8 (partly), APP-10, APP-14, KW-1, ARC-1, IMG-1, ENH-2, LOC-2 and ACC-6. Screens are built from three different kits of buttons, cards, tabs and tables, and 19 screens hand-build their own. Moving between tools feels like moving between different apps.

**Status (25 Sep 2026): foundations done, and the first screens moved.** Not deployed. Nothing here needs a data change.

**Done:**
- **Studio kit folded in.** Studio `Btn`, `Tag` and `Spinner` now render `ui/Button`, `ui/Badge` and the new `ui/Spinner`, keeping their names, so Home, Projects, Admin and AI Visibility share the tools' look without editing each screen. Studio's outlined "primary" button is now the one filled primary style.
- **New shared parts.** `ui/PageFrame` gives each page its title, purpose line, a single main action and a standard width. `ui/Spinner` replaces the text-only "Loading…".
- **Toasts** run on **Sonner** behind the unchanged `useToast()` API. Errors now stay 10 seconds, toasts are announced to screen readers and have exit motion, and Robots Monitor's second toast is gone.
- **`ui/Modal`** runs on **base-ui**'s Dialog, with the same props. It now has the dialog role, focus trap and focus return, and a matching 200ms enter and 150ms exit.
- **Design tokens** in `index.css`:
  - muted text passes contrast in both themes (dark `#848C8F` at 4.8:1, light `#636368`)
  - a six-step type scale (`--fs-xs` … `--fs-2xl`)
  - `--ease-out`
  - `--dur-std`, which was referenced by a component but never defined
  - one global keyboard-focus ring
  - one `spin` keyframe
  - an app-wide reduced-motion rule
- **`PageFrame` applied** to Keyword Research, Content Research, Article Recommendation, Image Alt Tag Audit, both Article Enhancers, the Knowledge Base and the new Location Pages front page. The second breadcrumb bars are gone.

**Still to do** (steps 2–6 below, minus the screens above):
- Move the remaining hand-built screens onto `ui/` parts, including their 366 hand-made buttons and 54 tables.
- Put the other tool pages in `PageFrame`.
- Adopt the type scale inside individual screens.
- Remove the ~20 per-component spinner keyframes, which are now redundant.

---

## The decision: one kit, and which one

**Keep `client/src/ui/`.** It is already the most used kit: 94 imports, against 9 for `components/studio/primitives.jsx` and 6 for the two SEO & GEO kits. It also has the most parts: Button, Card, Badge, DataTable, Drawer, EmptyState, Field, Modal, Tabs, Toast, ScoreRing, ProgressSteps, Skeleton, SectionHeader and MetricCard.

**Fold the others into it.** Nothing new is invented; each part that exists twice becomes one.

| Today (elsewhere) | Becomes (in `ui/`) |
|---|---|
| studio `Btn` | `Button` (add the `size="sm"` look Btn has) |
| studio `Tag` | `Badge` (same tones: accent, warn, neg, muted) |
| studio `Kicker`, the ALL-CAPS labels | `SectionHeader` eyebrow, used sparingly (the audit's APP-10) |
| studio `Spinner` (the word "Loading…") | `Skeleton` for content; `Button loading` for actions |
| `seoGeo/primitives.jsx`, `seoGeo/report/reportKit.jsx` | the matching `ui/` parts; SEO & GEO keeps only its charts |
| Hand-built tables (54 raw `<table>`s) | `DataTable` |
| Hand-built buttons (366 raw `<button>`s) | `Button` |

**Two library swaps**, from the pick-ui-library check in the audit's Appendix B:
- **Toasts:** use **Sonner** instead of `ui/Toast` and Robots Monitor's second toast. It brings screen-reader announcement, longer-lasting error toasts, and exit motion.
- **Modals and menus:** build `ui/Modal` and the header menus (client switcher, account menu) on **base-ui**. It brings focus trapping, the dialog role and dismissal.

## One page frame for every tool

Add `ui/PageFrame` and use it on every tool page. It holds:
- **Title:** the same words as the menu item.
- **Purpose:** one plain-English line on what the tool does and what you get.
- **Primary action:** always in the same place, top right, one only.
- **Width:** the same content width everywhere (the audit found four different widths on the account screens alone).

The **no-title tools** (Keyword Research, Content Research, Article Recommendation, Image Alt Audit) get a title and a purpose line for free.

The **second breadcrumb bars** (Article Enhancer, Knowledge Base) go, because the app header already does that job.

## Order of work

Highest traffic first, one tool per session. Each ships on its own.

1. **Foundations.** Takes 2 sessions.
   - Fold studio parts into `ui/`.
   - Add `PageFrame`.
   - Swap in Sonner and base-ui.
   - Set a type scale in `index.css` of six sizes (currently 32 are in use) and apply it inside the kit.
2. **Home, Projects, Workspaces, Run history, Admin.** Takes 2 sessions. These are studio-kit screens, so this is mostly renaming.
3. **Crawler and crawl report.** Takes 1 session. They are already `ui/`, so this is `PageFrame` plus the tables.
4. **Keyword Research, Content Research, Article Recommendation, Image Alt Audit.** Takes 2–3 sessions. Hand-built today, so this is the biggest visible gain.
5. **Competitor Analysis, Market Potential, AI Visibility (both), SEO & GEO, Agent Readiness.** Takes 3 sessions.
6. **Content Writer, Content Architect, Knowledge Base, Location Pages, Robots Monitor, Content Enhancement.** Takes 3–4 sessions. Location Pages is best done after the [one-client plan](02-plan-one-client.md), which replaces its three separate wizards.

## How you'll know it worked

- **Same frame everywhere.** Open any two tools one after the other: title, purpose line, main button position, table style and loading style all match.
- **The component count moves.** Re-run the component census from the audit. It counts raw `<button>`, raw `<table>`, inline styles and hard-coded colours per screen. Those numbers should fall with each tool moved, and the "no kit" list should end empty.
- **Contrast passes.** The dark theme's muted text passes the contrast check (the audit found an average of 12–13 failures per screen, mostly the muted grey). Fix the token once in `index.css`, then check a sample of screens.

## What not to do while this is under way

- **No new hand-built buttons, tables, modals or toasts.** New screens use `ui/` and `PageFrame` from day one.
- **No changes to the AI Visibility "measure" polling.** An earlier clean-up there broke the "run finished" signal. It was fixed separately in this batch and should be left alone.
