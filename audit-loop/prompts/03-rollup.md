# Phase C — Cross-domain rollup

All domains have completed. Read every `findings.json` and `verification.json` under
`{{RUNS_ROOT}}` and produce the coverage picture that no single domain can give you.

## Step 1 — Coverage matrix

Build a 96 × N matrix (rules × domains) of fire counts. Write it to
`{{RUNS_ROOT}}/coverage.csv`.

## A property to hold throughout

**A rule that was suppressed must appear in the ledger as suppressed, not as absent.**

Every step below reads a no-fire as evidence of something. That reading is only sound if a
no-fire has one meaning. Today it has three: the rule ran and found nothing, the rule could not
run because its data source is missing, or the rule was skipped and left no trace. The third is
the dangerous one — `orphan-page` and `single-inlink` are gated on `!crawlTruncated`, so on any
capped crawl they produce nothing and nothing records that they were never evaluated. In the
ledger they are indistinguishable from a clean pass.

This is the same distinction Step 5 of Phase A exists to force on the validator: proof of
absence is not the same as absence of proof. The tool does not currently make it on itself.

So: where a run's ledger cannot separate "checked, clean" from "never evaluated", say so and
exclude those rules from every count in this rollup rather than letting them read as exercised
or as silent. A coverage figure built on ambiguous no-fires is a coverage figure that overstates
itself, and it will do so consistently in the same direction.

## Step 2 — Never-fired triage

Before triaging anything, work out how many runs are actually usable as evidence. Read
`coverage_complete` in each run's crawl block: a run marked false is excluded from any
proof-of-absence reasoning regardless of how clean its findings look. Read
`verification.json`'s `status` and `steps_run` the same way — an `incomplete` run is excluded
from any claim that depends on a step it did not run, and a skipped confirmation re-crawl means
its fixes are untested against a live site whatever its suite says. A run whose
crawl did not complete proves nothing about absence — Phase A will have recorded its no-fires
as `UNVERIFIABLE` rather than `NOT_APPLICABLE`, so read each `findings.json` and count the
complete runs separately from the total.

State the real denominator everywhere it matters. "Never fired across 6 complete runs" is a
claim. "Never fired across 10 runs, 4 of which were partial" is a different and much weaker
one, and writing the second as though it were the first is how this rollup would end up
confidently wrong.

A rule that fired zero times across every domain is the loop's blind spot: it looks clean in
every report and has never actually been executed. For each, decide:

- Legitimately silent (eval class is `external_gsc`, `external_analytics`, `delta`, `model`,
  `action`) — needs a connected data source or a second crawl to test at all.
- `fixture_only` rarity — needs a synthetic fixture; a live domain will not produce it.
- Neither of the above, and `rarity` is `common` — a candidate dead detector, and what you
  may claim about it depends entirely on the denominator.

  **State the denominator first, every time**: N complete runs, not N directories under
  `{{RUNS_ROOT}}`. Then report coverage as a union — a rule that fired on ANY complete run is
  exercised, and one run is enough to establish that. Positive evidence does not need a
  quorum; absence does.

  **Below about five complete runs, do not escalate to P1.** Put the rule on the fixture
  backlog instead, ranked by severity and then by rarity, and say what it would take to
  trigger: "common, crawl-class, silent across 2 complete runs — write a fixture". Two or
  three domains cannot distinguish a dead detector from a coverage gap, and with 30
  common-rarity rules unexercised after a single domain, most of that set will be gap rather
  than defect. Filing 30 P1s from two runs would bury the handful that are real.

  **At five or more complete runs**, escalate to P1 only where the domains were deliberately
  chosen to trigger the rule and it stayed silent anyway. Say which domain was supposed to
  trigger it. A rule nothing in the run was ever likely to exercise is still a coverage gap,
  however many runs it survives.

## Step 3 — Defect patterns

Cluster all defects from all domains by root cause rather than by rule. Call out any shared
helper (URL normalisation, header parsing, link graph, canonical resolution, sitemap parsing)
that produced defects across three or more rules — that is where the next block of work
belongs, and it will be worth more than the individual rule fixes already made.

Separately, list any defect type that recurred after being "fixed" on an earlier domain.
Those indicate the earlier fix was a suppression rather than a correction.

## Step 4 — Recommendation quality

Aggregate the five-axis recommendation scores across all fired rules and all domains. Report
the pass rate per axis. The weakest axis is the next thing to systematically improve, and
"specific" is usually the one that fails.

## Step 5 — Output

Write `{{RUNS_ROOT}}/ROLLUP.md`:
- Coverage: rules exercised / rules silent / rules confirmed dead
- Defects found, fixed, deferred — by severity
- Root-cause clusters, ranked by number of rules affected
- Fixture backlog, ranked
- Recommendation quality by axis
- The three things to fix before this tool is shown to a client

Print `ROLLUP_COMPLETE`.
