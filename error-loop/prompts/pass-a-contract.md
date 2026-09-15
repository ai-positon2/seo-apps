# Pass A — Contract and wiring

Area: `{{AREA}}`  ·  Scope: `{{SCOPE}}`  ·  Loop `{{N}}` of 28

Read `error-loop/PROGRESS.md` first. If this loop is already marked complete,
stop and report that.

## Lens

Does this code connect to everything it claims to? You are not judging what the
code computes — that is Pass B. You are checking that every edge it depends on
is real.

Work through the scope file by file, end to end. For each file:

1. **Imports/exports.** Every `require` resolves; every destructured name is
   actually exported. (`require-graph.js` covers the server; still read for
   dynamic requires it cannot see.)
2. **Call sites.** Arity and argument order match the definition. The caller
   uses the shape the callee actually returns — check the return statements,
   not the JSDoc.
3. **Routes.** Every route is mounted where the client expects it. Path
   params declared match the ones read. Middleware order puts auth before the
   handler it protects.
4. **Async.** Every promise-returning call is awaited or deliberately
   fire-and-forget with a `.catch`. No `await` inside a `forEach`. No async
   function whose rejection has nowhere to go.
5. **Data contracts.** Column and table names in SQL exist in
   `supabase/migrations/`. Keys read off a row match what the query selects.
   `process.env` keys exist in `.env.example`.
6. **Error paths.** A thrown error reaches a handler that responds. No
   `catch {}` that drops a failure the caller needed to know about.
7. **Cleanup.** Anything opened — a client, a stream, a timer, a browser page —
   is released on the failure path as well as the success path.

## Rules

- **Confirm before fixing.** A candidate becomes a finding only when you can
  write the concrete input or state that triggers it and the wrong output or
  crash that results. No failure scenario means it goes in
  "Unconfirmed / rejected", not in the fix list. Detectors produce false
  positives — the first draft of `require-graph.js` produced 36 of them.
- **Fix P1 and P2 in this pass.** Small local P3s too. Defer the rest.
- **Defects only.** No refactors, renames, dependency bumps or style changes.
- Match the surrounding code's idiom, naming and comment density.

## Gate — all four must pass before this loop is complete

```
node --check <each file you touched>
node error-loop/tools/require-graph.js
npm test --prefix server
npm run build --prefix client
```

If a fix cannot be made green inside this pass, revert it and record the
finding as deferred with the reason.

## Finish

Update `error-loop/PROGRESS.md`:
- the ledger row for this loop — grade counts, fixed, deferred, gate, status
- one "Confirmed findings" entry per defect, each with its failure scenario
- anything rejected, under "Unconfirmed / rejected candidates"

Then report: findings by grade, what was fixed, what was deferred, gate result.
