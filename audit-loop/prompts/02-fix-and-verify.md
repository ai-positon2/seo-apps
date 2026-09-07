# Phase B — Fix the crawler and verify (SOURCE EDITS ALLOWED)

Phase A ran an audit against `{{DOMAIN}}` and recorded defects in `{{RUN_DIR}}/findings.json`.
Your job is to fix those defects in the crawler and prove the fixes work without breaking
anything else.

## Run parameters

- DOMAIN: `{{DOMAIN}}`
- URL_LIMIT: `{{LIMIT}}` — the same cap Phase A used. The confirmation re-crawl must use it,
  or the diff compares two different page sets.
- RUN_DIR: `{{RUN_DIR}}`
- FINDINGS: `{{RUN_DIR}}/findings.json`
- EVIDENCE: `{{RUN_DIR}}/evidence/` — the `.http` files Phase A saved when it re-fetched each
  sampled instance. This is what you iterate against.
- PHASE_A_URLS: `{{RUN_DIR}}/urls.txt` — every URL Phase A's crawl fetched, one per line.
  Step 4 compares the re-crawl's own fetched set against this before reading any count.
- AUDIT_CMD: `{{AUDIT_CMD}}` — the crawl command. Used exactly once, in step 4, for the
  confirmation re-crawl at the end of the domain. There is no way to re-run the rule engine
  against a stored crawl in this repo, so there is no replay to iterate against.

## Hard constraints

1. **Fix the crawler, not the site.** Every change lands in the audit tool's source.
2. **One defect, one commit.** Never bundle.
3. **Failing test first.** No fix is written before a test exists that fails for the right
   reason. If you cannot write a failing test, you have not understood the defect yet — say so
   and skip to the next one rather than guessing at a fix.
4. **Do not suppress.** Loosening a threshold, adding an allow-list entry, or narrowing a
   selector so a false positive stops firing is only acceptable if you can state why the new
   behaviour is correct in general — not just why it silences this URL. Otherwise it is a
   defect you are hiding, and the next domain will hide it again.
5. If the right fix is larger than this loop should absorb (schema change, crawl architecture,
   new data source), do not attempt it. Record it in `deferred.md` with a sketch of the fix
   and move on.

---

## Step 1 — Plan

Read `findings.json`. Fix in strict order: P1, then P2, then P3. Within a tier, fix
false negatives before false positives — a rule that never fires is invisible in every
subsequent domain's ledger, so it compounds; a false positive at least announces itself.

Before touching code, write `{{RUN_DIR}}/fix-plan.md`: for each defect, the suspected root
cause, the file(s) you expect to change, and the test you will write. If two defects look like
one root cause, say so and plan a single fix.

## Step 2 — Capture fixtures

For each defect you intend to fix, take the minimal reproducing input from
`{{RUN_DIR}}/evidence/` — the `.http` files Phase A wrote, each holding one full response:
status line, headers, blank line, body. Commit it as a test fixture under the repo's fixture
directory, named `<rule-id>__<defect-id>`.

Do not go looking for a crawl store to extract from. There is not one: the crawler parses each
response into extracted signals and discards the body, and only about ten named headers
survive as scalar fields on the stored result. `{{RUN_DIR}}/evidence/` is the only place a
raw response exists.

If a defect has no evidence file — a false negative Phase A never sampled, or a link-graph
defect that is not about a single response — fetch what you need yourself and save it in the
same shape, in the same place, before writing the test.

**A defect gated by measurement takes no fixture at all.** Where the data is correct and the
problem is its shape, size or cost (step 3 explains which gate applies), there is nothing to
reproduce: no input makes the current behaviour wrong. Do not invent a fixture to satisfy the
shape of this step — record in `verification.json` that the defect is measurement-gated and
move on. D4 on the first run of this loop is the type case: an endpoint returning 7,298 correct
rows where a correct 18-row rollup already exists.

This is what makes the loop cumulative. After ten domains you want a fixture corpus that
re-runs in seconds, not ten crawls you have to repeat.

Strip anything host-specific that would make the fixture brittle or that you would not want in
the repo (auth headers, cookies, session ids, anything resembling personal data).

## Step 3 — Fix, one defect at a time

**First decide which gate the defect can carry.** "Failing test first" assumes there is a
wrong answer to assert against. Some defects have none: the data is correct and the problem is
its shape, its size, or its cost. D4 from domain one is the type case — `/runs/:id/findings`
returns 7,298 correct instances where a correct 18-row rollup already exists; no assertion
fails before the fix, because nothing is wrong.

For those, the gate is a **before/after measurement**, recorded in `verification.json`:
payload size and wall-clock load time, measured the same way on the same run, before the
change and after. State the numbers and the method. A fix that cannot show a measured
improvement has not been demonstrated to be a fix, and "it feels faster" is not a gate.

Everything with a wrong answer still takes the failing test. If you are unsure which kind you
have, try to write the failing test first — being unable to is the diagnostic.

For each defect:
1. Write the failing test against the fixture. Run it. Confirm it fails, and confirm it fails
   for the reason you expect — not because of a typo or a missing import.
2. Locate the root cause. Read the rule implementation and the shared helpers it calls. A
   surprising number of rule bugs live in shared URL normalisation, header parsing, or the
   link-graph builder rather than in the rule itself. If the root cause is shared, check which
   other rules touch the same helper and note them — the fix may resolve or break several.
3. Make the smallest correct change.
4. Run the new test. Then the rule's existing tests. Then the full suite.
5. Commit: `fix(<rule-id>): <what changed> [<defect-id>]`.

**If a standing instruction blocks committing**, do not silently skip the record. Say so in
`verification.json` — set `commits_blocked_reason` — and fill `commits` with what each commit
*would* have been: one entry per defect, with the message and the files touched. An empty
`commits` array must mean nothing was done, never that nothing could be written down. A later
reader cannot tell those two apart, and Phase C reads this to reconstruct what changed and
when.

**A fixture reproduces the condition, not the artifact that happened to carry it.** D1 needs a
response body larger than the 5 MB parse cap; it does not need the 14 MB page that revealed it.
Generate the smallest input that crosses the boundary — a synthesised body just over the cap,
with the handful of elements the rule reads — and commit that. Committing the original would
put 14 MB in the repo to test one comparison, and the fixture corpus is meant to re-run in
seconds after ten domains.

The evidence file stays in the run directory as the record of what was actually observed. The
fixture is the distilled reproduction. They are different objects and only the second belongs
in the repo.

For `WRONG_RECOMMENDATION` defects, the fix is to the recommendation generator, and it must
still be correct for instances *other* than the one that triggered the defect. Rewriting the
string to describe this one URL is not a fix.

## Step 4 — Confirmation re-crawl

Once every fix for this domain is committed — not after each one — run AUDIT_CMD a single time
against `{{DOMAIN}}` at the same `{{LIMIT}}`. One re-crawl per domain, at the end.

Diff the resulting issue set against the Phase A issue set at rule level: rules added, rules
dropped, instance counts changed.

Every difference must map to an intended fix. Any unexplained difference is a regression:
find it, and if you cannot explain it within a reasonable effort, revert the commit that
caused it and re-record the defect as deferred. An unexplained count change is a bug you have
not found yet, not noise.

Two things that are not regressions, and that you must check rather than assume — a re-crawl
is not the deterministic replay this step used to be. The site itself may have changed between
the two crawls, and a crawl that stops at the cap need not reach the same URLs twice if
discovery order shifts. So compare the fetched-URL sets first: Phase A wrote its set to
`{{RUN_DIR}}/urls.txt`, and you build the same list from your re-crawl with RESULTS_CMD,
paging with `offset` exactly as Phase A did. Diff the two.

Report the overlap as a number, not an impression. If the sets do not substantially overlap,
say so and stop — a rule-level diff across two different page sets supports no conclusion in
either direction, and reporting one anyway is worse than reporting nothing. Note which URLs
were reached only in Phase A and only now; a rule that "dropped" because its one offending
page was not fetched this time is not a fixed rule.

## Step 5 — Verify

Run the full test suite plus lint/typecheck. Then write `{{RUN_DIR}}/verification.json`:

```json
{
  "domain": "example.com",
  "status": "pass | fail | incomplete",
  "steps_run": [1, 2, 3, 5],
  "commits": ["sha  fix(rule): …"],
  "defects_fixed": ["D1", "D3"],
  "defects_deferred": [{ "id": "D2", "reason": "…" }],
  "fixtures_added": ["path/to/fixture"],
  "diff_vs_phase_a": {
    "rules_added": [], "rules_dropped": [], "counts_changed": [],
    "all_explained": true
  },
  "test_suite": { "passed": 0, "failed": 0 },
  "regressions": []
}
```

`status` has three values and they are not interchangeable:

- `pass` — the suite is green, every rule-level difference in the confirmation re-crawl is
  explained, and no P1 is left unfixed and unexplained. Requires every step to have run.
- `fail` — something broke. A defect could not be fixed, a regression appeared, a P1 stands
  unexplained, or the suite is red.
- `incomplete` — nothing broke, but a step was out of scope. List the steps that DID run in
  `steps_run`. This is the honest verdict for a run that skipped the confirmation re-crawl:
  `pass` would claim a re-crawl diff nobody performed, and `fail` would imply a defect that
  does not exist.

Do not upgrade `incomplete` to `pass` to keep the loop moving, and do not downgrade it to
`fail` because it is not `pass`. Phase C excludes an `incomplete` run from any claim that
depends on the steps it skipped, the same way it excludes a run whose `coverage_complete` is
false. Otherwise `status` is `fail` — the loop will
stop and hand control back, which is the correct outcome. Do not mark `pass` to keep the loop
moving.

## Step 6 — Stop

Print `PHASE_B_COMPLETE status=<pass|fail>` and a one-line summary per defect. Do not start
the next domain — the driver script handles that.
