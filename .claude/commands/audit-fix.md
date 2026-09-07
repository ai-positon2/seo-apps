---
description: Phase B — fix the crawler defects found by /audit-run, then re-crawl and verify
argument-hint: [domain]
---

Run Phase B of the audit validation loop for domain: **$1**

## Setup

1. Read `audit-loop/config.json`. Resolve `audit_cmd` and `test_cmd` with `{{DOMAIN}}` = `$1`,
   `{{LIMIT}}` = `url_limit`, and `{{RUN_DIR}}` = this domain's run directory under
   `runs_root`. `audit_cmd` is for the single confirmation re-crawl in step 4 — do not run it
   until every fix is committed.

   Do **not** resolve `reeval_cmd`. It is `null`, and deliberately so: there is no way to
   re-run the rule engine against a stored crawl in this repo. `buildFindings()` has one
   production caller, inside the crawl completion path, using in-memory state that is never
   fully persisted — `resourceEdges` and `sitemapMembership` are not stored at all,
   `siteDiagnostics` is absent from the rolled summary, and `crawl_run_links` keeps 5 of the
   19 edge fields the analyzer reads while dropping external edges entirely. See
   `reeval_missing` in config.json. A replay built on that data would silently disagree with
   the crawl it claims to reproduce, which is why step 4 re-crawls instead.
2. Locate `<run_dir>/findings.json`. If it is missing, stop and tell me to run
   `/audit-run $1` first — do not re-derive the defects yourself.
3. Read `audit-loop/prompts/02-fix-and-verify.md`. **That file is your instructions.**
   Follow all six steps in order.

## Constraints for this phase

One defect, one commit. Failing test before every fix. Never suppress a detection to make a
false positive go away unless you can state why the new behaviour is correct in general.

Use TodoWrite with one item per defect so I can watch the order. Work P1 first, and within a
tier fix false negatives before false positives.

If a fix turns out to be larger than this loop should absorb — a schema change, a crawl
architecture change, a new data source — do not start it. Write it up in
`<run_dir>/deferred.md` and move to the next defect.

## On finishing

1. Write `<run_dir>/verification.json` exactly as the prompt file specifies. `status` is
   `pass` only if the suite is green, every rule-level count difference between the
   confirmation re-crawl and the Phase A run is explained, and no P1 is left unfixed. A
   `fail` here is the correct outcome when things are unresolved — do not upgrade it to keep
   the loop moving.
2. Update `audit-loop/PROGRESS.md`: mark phase B done for this domain, with status, commits,
   and anything deferred.
3. Print a one-line summary per defect and the verification status.
4. If status is `pass`, tell me to run `/clear` then `/audit-run <next domain>` from the
   domains list in config.json. If status is `fail`, tell me what needs my decision.

Do not start the next domain yourself.
