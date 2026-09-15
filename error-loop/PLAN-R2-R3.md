# Rounds 2 and 3 — loops 29-84

## Why the lenses change

Round 1 (loops 1-28) ran two lenses, **contract/wiring** and **behaviour/regression**, and
ended with every mechanical gate clean:

| Detector | End of Round 1 |
|---|---|
| require-graph | 0 / 0 |
| async-route-guard | 0 unguarded |
| route-params | 0 |
| floating-promise | 0 real |
| env-refs | 0 undocumented |
| sql-refs | 0 real |
| api-contract | 0 mismatches (274 routes / 202 calls) |

Re-running those same two lenses would mostly re-confirm green gates. So rounds 2 and 3
keep the identical structure — 14 areas, two passes each, fix before the second pass, gate
between — and change **what is being looked for**.

The new lenses are aimed at what Round 1 explicitly recorded as not covered: the large
files that detectors swept but nobody read line by line (`crawler.js` 3502,
`seoGeoChecks.js` 2712, `analyzer.js` 2033, aiVisibility's `store.js` 1563 and `metrics/`,
projects' `overview.js`/`moduleRunners.js`/`moduleEvidence.js`, LPB's generation and QA
tree), and per-component React semantics across ~51k lines of client code.

## The six lenses

| Round | Loops | Pass | Lens |
|---|---|---|---|
| 1 ✅ | 1-28 | A | Contract and wiring |
| 1 ✅ | 1-28 | B | Behaviour and regression |
| **2** | **29-56** | **C** | **Resource and lifecycle** |
| **2** | **29-56** | **D** | **Data correctness** |
| **3** | **57-84** | **E** | **Security and input validation** |
| **3** | **57-84** | **F** | **Failure modes and robustness** |

### Pass C — Resource and lifecycle
Every acquired thing released on the failure path as well as the success path: pool
clients, browser pages, file handles, streams, timers, intervals, listeners, dispatchers.
Collections that outlive a request and what bounds them. Concurrency: check-then-act races,
shared mutable state, unbounded parallelism against a metered API. Timeouts and their
absence. Retry and backoff — bounded, and not a storm. Process lifecycle: what a SIGTERM
mid-work leaves behind.

### Pass D — Data correctness
The algorithms themselves, in the files Round 1 only swept. Off-by-one and boundary
conditions at 0, 1, exactly-the-cap, one past it. Aggregation and rollup arithmetic —
does a total reconcile against its own parts? Sorting, ranking and tie-breaking.
Deduplication keys. Unit conversion (the Ahrefs-style cents-vs-dollars class). Date and
timezone handling, month arithmetic, DST. Percentage and average denominators. Empty-input
behaviour of every reducer.

### Pass E — Security and input validation
Where caller-controlled input reaches something consequential: SSRF in every outbound
fetch, path traversal in anything that builds a filesystem path, SQL and identifier
injection, prototype pollution on merged objects, unsafe deserialisation. Authorization
edge cases the capability matrix does not cover. Secrets: keys, tokens and connection
strings in logs, responses and generated artefacts. Rate-limit bypass. XSS in generated
HTML, XLSX and PDF output.

### Pass F — Failure modes and robustness
What the system does when something else breaks. A dead upstream, a slow one, one that
returns a 200 with garbage. Partial failure inside a batch — is the result marked partial
or silently short? Poison input that survives a retry. Degraded mode: with no
`DATABASE_URL`, no API key, no worker — is the behaviour correct or merely quiet? Plus a
regression sweep over every change made in rounds 1 and 2.

## Unchanged from Round 1

- **The gate**, run after every pass, all green before the next loop:
  `node --check` · `require-graph` · `npm test --prefix server` · `npm run build --prefix client`
  (plus every detector relevant to the area).
- **The verification rule.** No finding is a defect until a concrete failure scenario is
  written for it. Round 1 rejected roughly 137 of ~150 mechanical candidates; the first
  detector's first run was 36 findings, all phantom. This rule is what protects an
  already-green codebase from being "fixed".
- **Severity.** P1/P2 fixed in the pass that finds them, small local P3s too, everything
  else deferred with a reason. Defects only — no refactors, renames or dependency bumps.
- **The area list** — the same 14, in the same order.

## Ledgers

- Round 1: `error-loop/PROGRESS.md` (complete)
- Round 2: `error-loop/PROGRESS-R2.md`
- Round 3: `error-loop/PROGRESS-R3.md`
