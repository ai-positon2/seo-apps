# Repo-wide error loop — 28 loops, 14 areas, 2 runs each

## Why this shape

Every cheap mechanical gate in this repo is already green:

| Gate | Result |
|---|---|
| `node --check` on all 348 server files | 0 errors |
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | builds, 1231 modules |
| `error-loop/tools/require-graph.js` | 0 unresolved, 0 missing exports |

So the bugs still in this repo are **not** the kind a linter finds. There is no
ESLint, no TypeScript, no Prettier anywhere (root, server, client) — a fact
already recorded in `audit-loop/config.json`. The loop therefore has to be
semantic review, area by area, with purpose-built detectors supplying hard
evidence wherever a class of defect can be detected mechanically.

The repo is also mid-merge: 25 modified and 10 untracked files sit uncommitted
on `unified-app`. Merge seams — a client calling a route that moved, a query
naming a column a migration renamed — are the highest-yield place to look, and
they are exactly what a test suite of unit tests does not cover.

## The two-run rule

Each area gets two passes with **different lenses**, so run 2 is a genuine
second look rather than a repeat of run 1.

**Pass A — Contract and wiring.** Does this code connect to everything it
claims to? Imports/exports, route registration and mounting, client-to-server
API agreement, DB columns against migrations, `process.env` keys against
`.env.example`, function arity and return shape at each call site, `await` on
promise-returning calls, error paths that actually throw, resource cleanup.

**Pass B — Behaviour and regression.** With Pass A's fixes landed, re-read for
defects in what the code *does*: null/undefined dereference on real inputs,
off-by-one and boundary errors, inverted or wrong operators, workspace/tenancy
scoping holes, race conditions and unguarded concurrency, unbounded queries or
memory growth, `catch {}` swallowing a real failure — plus a regression check
on everything Pass A touched.

**The gate between them is mandatory.** Pass A's findings are fixed and the
full gate is green *before* Pass B on that area starts. Pass B then re-reviews
code that is already corrected, which is what makes the second look worth
paying for.

## The gate

Run after every pass. All four must be green before the next loop begins.

```
node --check <each touched file>
node error-loop/tools/require-graph.js
npm test --prefix server
npm run build --prefix client
```

A pass is not complete while any gate is red. If a fix cannot be made green
within the pass, it is reverted and the finding moves to `DEFERRED` in
`PROGRESS.md` with the reason.

## Verification rule (learned the hard way)

While building the first detector it reported 36 defects. **All 36 were false
positives** — one `require` that existed only inside a comment, and an
export-list parser whose overlapping regex swallowed every other name. The
corrected detector reports zero.

So: **no finding is a bug until it is confirmed by reading the code.** Every
entry in the ledger carries a concrete failure scenario — the input or state
that triggers it and the wrong output or crash that results. A finding that
cannot be given one is recorded as `UNCONFIRMED` and not "fixed". This is the
single most important rule in the loop; the fastest way to damage a green repo
is to start fixing phantom defects.

## Severity and what gets fixed

| Grade | Meaning | Action |
|---|---|---|
| **P1** | Wrong behaviour on a production path, data loss, auth/tenancy hole | Fix in the same pass |
| **P2** | Wrong behaviour on an edge path, or a user-visible defect | Fix in the same pass |
| **P3** | Latent, robustness, or cosmetic | Fix only if the change is small and local; otherwise defer |

Refactors, renames, dependency bumps and style changes are **out of scope**.
This loop fixes defects; it does not tidy. Anything tempting goes to `DEFERRED`.

## The 14 areas

Ordered so the foundations are correct before the code that sits on them, and
so the highest merge-risk surfaces come early.

| Loop | Area | Scope | Approx LOC |
|---|---|---|---|
| 1 / 2 | **HTTP boundary & auth** | `server/routes/`, `server/middleware/` | 11.1k |
| 3 / 4 | **Platform services** | `server/services/` | 7.7k |
| 5 / 6 | **Config, bootstrap & workers** | `server/config/`, `server/jobs/`, `server.js`, `worker-module.js` | 0.8k |
| 7 / 8 | **Database layer** | `supabase/migrations/` + every SQL string in `server/` | 24 migrations |
| 9 / 10 | **Projects module** | `server/modules/projects/` | 13.0k |
| 11 / 12 | **CrawlScope** | `server/modules/crawlScope/` | 11.6k |
| 13 / 14 | **AI Visibility** | `server/modules/aiVisibility/` | 10.9k |
| 15 / 16 | **Location Page Builder** | `server/locationPageBuilder/` | 9.9k |
| 17 / 18 | **Checks & scripts** | `server/checks/`, `server/scripts/` | 5.9k |
| 19 / 20 | **Content Architect** | `server/modules/contentArchitect/` | 3.9k |
| 21 / 22 | **Competitor Analysis** | `server/modules/competitorAnalysis/` | 3.1k |
| 23 / 24 | **Small modules** | `onPageAudit/`, `marketPotential/`, `robotsMonitor/` | 5.2k |
| 25 / 26 | **Client API & state** | `client/src/lib/`, `hooks/`, `context/` | ~6k |
| 27 / 28 | **Client pages & components** | `client/src/pages/`, `components/`, `ui/` | ~45k |

28 loops total.

## Detectors

`error-loop/tools/` holds the mechanical checks. One exists; three more get
built when their area comes up, because each is cross-cutting evidence that a
read-through alone cannot produce reliably.

| Tool | Built | Finds |
|---|---|---|
| `require-graph.js` | done, self-tested | Unresolved relative requires; destructured names the target never exports |
| `api-contract.js` | loop 25 | Client `fetch` paths with no matching Express route, and the reverse |
| `sql-refs.js` | loop 7 | Table/column names in server SQL that no migration defines |
| `env-refs.js` | loop 5 | `process.env` keys absent from `.env.example` |

Each detector is **self-tested before use**: a known-bad case is injected, the
detector must fire on it, and the case is removed. A detector that reports zero
without having been proven to fire is treated as broken, not as good news.

## Per-loop procedure

1. **Read** the area in full. Not grep-and-skim — the files, end to end.
2. **Run** the detectors relevant to the area.
3. **Confirm** each candidate by reading the code and writing its failure
   scenario. Discard anything that cannot get one.
4. **Fix** every confirmed P1 and P2, and small P3s.
5. **Gate.** All four checks green.
6. **Record** in `PROGRESS.md`: findings by grade, what was fixed, what was
   deferred, and the gate result.

Pass B repeats 1–6 with the behaviour lens, and additionally re-reads every
line Pass A changed.

## State

`PROGRESS.md` is the ledger and the only state that survives a context reset.
It is updated at the end of every pass, so the loop can be resumed from it
alone.

## Recommended before starting

The working tree has 25 modified and 10 untracked files. Committing that as a
checkpoint first would make each pass's diff reviewable and individually
revertible. Nothing here commits anything without being asked.
