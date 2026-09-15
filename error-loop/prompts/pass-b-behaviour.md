# Pass B — Behaviour and regression

Area: `{{AREA}}`  ·  Scope: `{{SCOPE}}`  ·  Loop `{{N}}` of 28

**Precondition:** Pass A for this area is complete, its fixes are landed, and
the gate was green. Check `error-loop/PROGRESS.md` and stop if it is not — the
second run is only worth paying for against already-corrected code.

## Lens

Pass A asked whether the code connects. This pass asks whether it is *right*.
Read for what happens at runtime on real inputs.

1. **Null and undefined.** Trace the values that reach each dereference. What
   happens on an empty array, a missing row, a `null` JSON column, an API that
   returned an error object instead of data?
2. **Boundaries.** Off-by-one in slicing, pagination, retry counts, limits.
   What happens at 0, at 1, at exactly the cap, one past it?
3. **Operators and conditions.** Inverted checks, `&&` where `||` was meant,
   `==` against a falsy value, a truthiness test on a number that can be 0 or a
   string that can be empty.
4. **Tenancy and authorization.** Every read and write scoped to the right
   workspace, project and user. A row from another workspace must not be
   reachable — check the query, not just the route guard.
5. **Concurrency.** Two runs of the same thing at once. Check-then-act races,
   shared mutable state across requests, a cache written from several paths,
   unbounded parallelism against a rate-limited API.
6. **Resource growth.** Queries without a limit, arrays that accumulate for the
   life of a process, a map keyed by something unbounded.
7. **Swallowed failures.** A `catch` that logs and continues where the caller
   then proceeds on empty or partial data as if it were complete.

## Regression duty

Re-read **every line Pass A changed in this area** (the ledger lists them).
A fix that made the gate green can still be wrong. Confirm each one does what
its finding claimed, and that it did not change behaviour on a path the finding
did not mention.

## Rules

Identical to Pass A: confirm with a written failure scenario before fixing, fix
P1/P2 and small P3s, defects only, match surrounding idiom.

## Gate — all four must pass

```
node --check <each file you touched>
node error-loop/tools/require-graph.js
npm test --prefix server
npm run build --prefix client
```

## Finish

Update `error-loop/PROGRESS.md` exactly as in Pass A, and mark the **area**
complete once both passes are green.

Then report: findings by grade, regressions found in Pass A's work, what was
fixed, what was deferred, gate result.
