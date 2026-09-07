---
description: Phase A — crawl one domain and validate every detection and recommendation (no source edits)
argument-hint: [domain]
allowed-tools: Bash, Read, Write, Glob, Grep, WebFetch, TodoWrite
---

Run Phase A of the audit validation loop for domain: **$1**

## Setup

1. Read `audit-loop/config.json`. Resolve `audit_cmd`, `run_status_cmd`, `findings_cmd` and
   `results_cmd` by substituting `{{DOMAIN}}` = `$1`, `{{LIMIT}}` = `url_limit`,
   `{{RUN_DIR}}` = the run directory below. `{{RUN_ID}}` cannot be resolved yet — it comes
   from `audit_cmd`'s 201 response at `.run.id`, so substitute it once step 2 has run.

   Do **not** resolve `reeval_cmd`. It is `null`, and Phase A never re-evaluates anything, so
   it was inert here even before it went null.
2. Run directory: `<runs_root>/<today YYYYMMDD>/<domain slug>`. Create it.
3. Read `audit-loop/prompts/01-run-and-validate.md`. **That file is your instructions.**
   Follow all eight steps in order, using the values resolved above wherever it references
   `{{DOMAIN}}`, `{{LIMIT}}`, `{{RUN_DIR}}`, `{{RULE_MAP}}` or `{{AUDIT_CMD}}`.

## Constraints for this phase

You have no Edit tool by design. If you find a crawler bug, record it in `findings.json` and
keep going — fixing happens in `/audit-fix`, in a separate context, after I have read your
findings. Do not use Write to modify source files as a workaround; Write is for output under
the run directory only.

Use TodoWrite to track the eight steps so I can see where you are. Step 5 (the false-negative
triage across all 96 rules) is the one that gets truncated when context runs short — if you
are running low, tell me rather than compressing it.

## On finishing

1. Append a row to `audit-loop/PROGRESS.md` under the current run: domain, phase A, date,
   defect counts by severity, and the path to `findings.json`.
2. Print the defect summary and the single defect you would fix first.
3. Tell me to read `findings.md`, then run `/clear` followed by `/audit-fix $1`.

Do not start fixing. Do not move to another domain.
