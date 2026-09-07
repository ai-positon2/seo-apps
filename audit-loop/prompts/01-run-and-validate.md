# Phase A — Audit run and validation (READ-ONLY on source)

You are validating a site-audit crawler that is under development. Your job in this phase is
to run one audit and produce evidence about whether the crawler's **detections** and its
**fix recommendations** are correct. You are NOT fixing anything in this phase.

## Run parameters

- DOMAIN: `{{DOMAIN}}`
- URL_LIMIT: `{{LIMIT}}`
- RUN_DIR: `{{RUN_DIR}}` (all output you write goes here, nowhere else)
- AUDIT_CMD: `{{AUDIT_CMD}}` — starts the crawl. Responds 201; the run id is at `.run.id`.
- RUN_STATUS_CMD: `{{RUN_STATUS_CMD}}` — poll for `run.status` until terminal.
- FINDINGS_CMD: `{{FINDINGS_CMD}}` — every finding for the run, each carrying `ruleId`.
- RESULTS_CMD: `{{RESULTS_CMD}}` — every fetched URL. Paginated; page with `offset`.
- RULE_MAP: `{{RULE_MAP}}` (all 96 rules with severity, eval class, expected rarity)

All three read-back commands need `{{RUN_ID}}`, which does not exist until step 2 has run.

## Hard constraints

1. **Do not edit, create, or delete any file outside `{{RUN_DIR}}`.** No source changes, no
   test changes, no config changes. If you find a bug, you write it down and move on.
2. **Do not trust the crawler's own output as evidence that the crawler is right.** Every
   verdict you record must be backed by something you fetched or inspected independently
   (curl, WebFetch, reading the raw stored response body).
3. If a step cannot be completed, record it as `BLOCKED` with the reason. Never fabricate a
   verdict, a URL, or an instance count. An honest `UNVERIFIABLE` is worth more than a guess.
4. Budget your verification: cap at 3 sampled instances per fired rule and at 6 independent
   HTTP probes per not-fired rule. Breadth across rules beats depth on one.
5. **Log every judgement call as you make it**, to `{{RUN_DIR}}/assumptions.md` (step 7 gives
   the shape). A judgement call is anything you decided that I did not specify and that a
   different reasonable person could have decided otherwise. Write it down when you make it,
   not at the end — by then the ones that felt obvious at the time are exactly the ones you
   will not remember making.

---

## Step 1 — Preflight

- Record the current git commit SHA and confirm the working tree is clean. If it is dirty,
  record the diff summary in `preflight.json` and continue.
- Load `issue-catalog.json` from the repo. Confirm it contains exactly 96 rules and that the
  severity split is 27 error / 54 warning / 15 notice. Any mismatch between the catalog and
  `{{RULE_MAP}}` is itself a defect — record it as `catalog_drift`.
- Confirm every rule id in the catalog has a corresponding implementation reachable by the
  rule engine (registry lookup, not a filename guess). Rules present in the catalog but not
  wired into the engine are `DEAD_RULE` defects — these are the single most likely cause of a
  silent no-fire, so find them before the crawl, not after.

## Step 2 — Run the audit

- Execute AUDIT_CMD. Capture stdout, stderr, exit code and wall-clock time to
  `{{RUN_DIR}}/crawl.log`.
- Capture the run id from the 201 response at `.run.id` and write it to `{{RUN_DIR}}/run-id`.
  Every read-back command needs it. If the response carries a non-null `budgetClamped`, the
  crawl is smaller than `{{LIMIT}}` asked for — record that, and read every count below
  against the budget that was granted, not the one you requested.
- Poll RUN_STATUS_CMD until `run.status` is terminal: `completed`, `failed` or `stopped`.
  A `stopped` run is a partial audit rather than a failed one — it still stores everything it
  reached, so carry on, but say so in the crawl block and treat every no-fire in step 5 as
  suspect.
- Record: URLs requested, URLs fetched, URLs skipped and why, status-code histogram, bytes
  stored, peak memory if available.
- **Write the fetched URL list to `{{RUN_DIR}}/urls.txt`** — one URL per line, sorted — from
  RESULTS_CMD. Page with `offset` until a response returns fewer rows than you asked for: the
  default page size is smaller than a capped crawl produces, so a single unpaged request
  truncates the list without saying so. This file is not bookkeeping. Phase B's confirmation
  re-crawl diffs its own fetched set against it, and without it a changed issue count cannot
  be told apart from the two crawls having reached different pages.
- **Dump the raw result rows to `{{RUN_DIR}}/results.json`**, paged the same way as
  urls.txt. Not a convenience: step 5's positive-control check needs to know whether a field
  is populated anywhere in the run, and the crawl store may be cleaned up before anyone asks.
  A run without this file can never have its no-fire verdicts re-audited — the first run of
  this loop lost exactly that ability and its 29 NOT_APPLICABLE verdicts became unre-checkable
  the moment the database was emptied.
- **Every census in step 5 reads `results.json`. Never re-fetch the site to compute one.**
  The stored result carries 90 fields per page — title, titleLength, metaDescription, h1Count,
  hreflangs, schemaTypes, canonical, status, depth and the rest — so any "how many pages have
  X" question is a pass over a local file. The first run of this loop re-fetched all 484 URLs
  to count titles; at 10,000 that is ninety-six minutes of extra crawling to answer a question
  the crawl already answered, and it doubles the load on a site that did nothing to deserve it.
  Re-fetch only to verify a specific sampled instance in step 4, never to build an aggregate.
- Confirm the {{LIMIT}} cap was respected exactly. Then record **two separate facts**, because
  they can disagree:
  - `cap_hit` — did the crawl stop because it reached {{LIMIT}}, or because the site ran out?
  - `truncated` — what `summary.truncated` actually says.

  These are not the same question. `truncated` is also set when sitemap seeding reaches 80% of
  the budget, when a template trips trap suppression, and when the depth limit is hit — so a
  crawl that fully exhausted a site can still come back `truncated: true`, and a run that
  reports "(b), exhausted" while carrying that flag will draw conclusions it has not earned.
  If they disagree, say so plainly and treat `truncated` as authoritative: it is what the
  analyzer gates on.
- Record what the crawl actually persists, as a **fact in the crawl block, not a defect**.
  This crawler stores extracted signals: each response body is parsed and then discarded, and
  only a handful of named headers survive as fields on the stored result. Write
  `"persistence": "signals-only"` in the crawl block. Do not file it as a defect — it is a
  known property of the tool, it will be identically true on all ten domains, and a P1 that
  fires every time teaches whoever reads these reports to skim past P1s.

  It is, however, the reason step 4 saves its own evidence and the reason Phase B builds
  fixtures instead of replaying. If you ever find a crawl that persists MORE than this — full
  bodies, a complete header map — say so, because it would let Phase B stop re-crawling.

## Step 3 — Build the fire ledger

**Establish the counting grain first, and write it down.** Fetch FINDINGS_CMD, then answer
one question before anything else: does a row represent a RULE that fired, or a single
OCCURRENCE of that rule? Count the rows, count the distinct `ruleId` values, and compare both
against what the storage layer holds. Record all three in
`{{RUN_DIR}}/grain.json` as `{ rows, distinct_rule_ids, grain: "rule" | "instance" }`.

Then label every number you write for the rest of this phase as one or the other. "7,298
findings" and "18 findings" can describe the same run, and a reader who assumes the wrong one
misreads the audit by two orders of magnitude. On the first run of this loop the whole report
was written in instance counts without saying so: "484 of 486 errors" described one rule
counted 484 times, and a Phase B fixer reading it would have gone hunting for volume that was
never a defect.

Two specific traps. A per-rule rollup may exist alongside the per-occurrence table — check for
one before concluding the grouping does not exist, because building what already exists is a
worse outcome than the mislabelling. And `run.summary.counts` is a severity breakdown of
INSTANCES, so it reconciles against the instance count and never against the rule count.

**Page the instance grain.** `findings_cmd` returns every occurrence, and the unpaged read
materialises the whole set three times over in the web process — roughly 150MB for a
46,000-finding run. Pass `?limit=2000` and walk `offset` until a short page comes back, the
same way you page `/results`. At 500 URLs the unpaged read is merely wasteful; at 10,000 it
is an out-of-memory crash, and the crawl it would lose took an hour and a half.

If you only need per-rule counts for the ledger, `?grain=rule` returns them directly — 17 rows
instead of 6,147, and it reconciles against the instance total.

Group the findings by `ruleId`. That endpoint is the only per-rule source there is: `run.summary.counts` breaks down by severity alone and cannot tell
you which of the 96 rules fired.

Produce a row for all 96 rules: `rule_id, category, severity, fired (bool), instance_count`.
Write it to `{{RUN_DIR}}/ledger.csv`. Every rule in the catalog appears, including the ones
that fired zero times — those zero rows are the entire input to step 5, so a ledger listing
only what fired is useless for the half of this phase that matters most.

Reconcile before going further: the summed instance counts must equal the number of findings
the endpoint returned, and the per-severity totals must match `run.summary.counts`. A
mismatch means either the read-back truncated mid-way or the crawler's own counts disagree
with the rows it stored. Both are defects, and both make every step after this one
unreliable — so resolve it here rather than building on it.

## Step 4 — Verify what fired (false-positive hunt)

**Every rule that fired gets sampled.** The cap of 3 is per rule, not a budget to spend on
the biggest ones. Ranking by instance count and covering the top N leaves the rest reported as
neither confirmed nor refuted, while the report reads as though the whole run was checked.

On the first run of this loop only 5 of 18 fired rules were sampled, chosen by volume on the
assumption that volume indicates risk — the same assumption that turned out to be wrong on the
largest rule in the run. Thirteen rules went unverified and their absence from the defect list
meant "not checked", not "checked and clean".

If there are more fired rules than you can cover, **say so and stop**. An honest "18 rules
fired, I verified 6, here are the 12 I did not reach" is usable. A silent ranking is not, and
one instance from every rule beats three from a third of them.

Within each rule, sample up to 3 instances — prefer the highest-impact URL, one median
instance, and one edge case (odd URL shape, query string, non-ASCII path).

For each sampled instance, independently confirm the condition really holds.

**Where the crawler had a choice of method, use a different one.** A verification that mirrors
the implementation can only ever confirm the implementation's blind spots. The crawler probes
external URLs with `HEAD` and falls back to `GET` only on 405/501; checking with `GET`
is what revealed that a host answering `301` to GET hangs on HEAD, and that 966 findings
called live links broken. Had the check used HEAD too, both would have agreed and the bug
would have survived the audit.

So: different HTTP method, different client, different parser, a fresh fetch rather than the
stored response — whichever axis the crawler committed to, cross it. Where you cannot (there
is only one way to ask), say so on the verdict, because that instance is confirmed only as far
as the crawler's own method reaches.

Examples of what "independently" means:

- `page-4xx` → re-request the URL yourself and check the live status code
- `canonical-to-noindex` → fetch the canonical target and read its robots meta and X-Robots-Tag
- `redirect-chain` → follow the chain with `curl -sIL` and count the hops yourself
- `orphan-page` → search the stored link graph for any inbound internal link
- `image-oversized` → check the actual byte size and rendered dimensions, not just the
  attribute values in the HTML
- `duplicate-*` → confirm the two pages really are duplicates, after normalisation

Every time you re-fetch something to check it, save the full response — status line, all
response headers, a blank line, then the body — to
`{{RUN_DIR}}/evidence/<rule-id>__<n>.http`, where `<n>` is the sample index (1, 2, 3). Save
it whatever the verdict turns out to be: a response that disproves a detection is worth more
than one that confirms it.

**These files are the fixtures.** Phase B builds its failing tests from them, and nothing else
in this repo keeps a raw response — the crawler parses each one into extracted signals and
discards the body, and only about ten named headers survive as scalar fields. Skip this and
Phase B has nothing to reproduce a defect against, so every fix needs a fresh crawl.

Strip anything you would not want committed to the repo — cookies, auth headers, session ids,
anything resembling personal data — but leave the headers the rule actually reads, or the
fixture cannot exercise it.

Verdict per instance: `TRUE_POSITIVE` / `FALSE_POSITIVE` / `UNVERIFIABLE`.

Also check, per fired rule:
- **Instance-count sanity** — does the reported count match the number of matching URLs in the
  crawl store? Off-by-N counts usually mean URL normalisation is inconsistent between the
  crawl store and the rule engine.
- **Overlap** — is this same underlying problem also being reported by another rule? Note the
  pair. Two rules firing on one root cause is a UX defect, not a detection defect, but log it.
- **Evidence completeness** — does each issue record carry the URL, the offending element or
  header, and the observed value? An issue a developer cannot locate is not actionable.

## Step 5 — Triage what did NOT fire (false-negative hunt)

This is the more important half of the phase, and the half that gets skipped. Work through
every non-firing rule and assign exactly one.

**Before the gates: know which kind of run this is, because it changes what Step 5 is worth.**

If `truncated` is **false**, this run saw the whole site, and it is the only kind of run whose
`NOT_APPLICABLE` verdicts carry real proof of absence — every capped run can only ever say
"absent from the part we reached". Such a run is disproportionately valuable to Phase C, which
needs proof-of-absence to distinguish a dead detector from a coverage gap, and it is the only
kind where `orphan-page` and `single-inlink` can fire at all.

So **spend your probe budget here**, not evenly. On an uncapped run, work the
`SUSPECTED_FALSE_NEGATIVE` list hard and convert as many as you can into proven verdicts; a
probe spent here is worth several spent on a capped run, where the strongest available claim is
scoped to a subset either way. If `orphan-page` or `single-inlink` fire, verify them with
particular care in Step 4 — no other run in the loop will get the chance.

If `truncated` is **true**, do the reverse: keep Step 5 proportionate, scope every claim to the
crawled subset, and spend the effort on Step 4 instead.

**First, a gate.** If the crawl did not complete — `run.status` came back `stopped` or
`failed`, or the step 3 reconciliation did not balance — then this run cannot prove the
absence of anything. Record every non-firing rule as `UNVERIFIABLE`, with the reason, and do
not use `NOT_APPLICABLE` at all in this run. The two verdicts read almost identically and
mean entirely different things: `NOT_APPLICABLE` claims the condition does not exist on this
site, while a crawl that ended early establishes only that it did not see the condition in the
part it reached.

That distinction does not stay local. Phase C treats a rule that never fired on any domain as
a probable dead detector, and that inference is sound only if the runs behind it finished. Ten
partial crawls agreeing they saw nothing is not evidence that there was nothing to see — it is
ten copies of the same unanswered question.

**Second, the schema.** Before you compute any census, fetch one real result record and
write its full key list to `{{RUN_DIR}}/result-schema.json`. Every proof of absence you write
must cite a field **from that list**, by name.

This is not ceremony. A proof that counts `result.hreflang` when the field is actually
`hreflangs` reads `undefined` on every row, counts zero, and produces "zero hreflang
attributes across 500 results" — a sentence that looks like evidence and is generated entirely
by a typo. A field name that does not appear in `result-schema.json` invalidates the proof
that rests on it; re-derive it or record `UNVERIFIABLE`.

**Third, positive control.** A census of zero only proves absence if the field is populated
*somewhere*. If no result in the run carries a non-null value for that field, you cannot
distinguish "the condition is absent from this site" from "the crawler never populates this
field" — and those two have completely different consequences, one being a clean site and the
other a dead detector. With no positive control anywhere in the run, the verdict is
`UNVERIFIABLE`, not `NOT_APPLICABLE`. Say which of the two you could not rule out.

**Fourth, shared preconditions are stated once.** Where one census figure underwrites several
rules — "zero 3xx responses across 500 internal results" carries every redirect rule at once —
record it as ONE finding with its dependants listed, not as N independently-worded proofs. N
restatements of a single measurement read as N pieces of evidence and are one. If that single
measurement is wrong, every verdict resting on it is wrong together, and the report should
make that visible rather than hide it behind repetition.

- `NOT_APPLICABLE` — the site condition genuinely does not exist. **You must prove it**, e.g.
  "zero `hreflang` attributes across 500 stored documents" or "no HTTP subresources on any
  HTTPS page". A no-fire with no proof is not NOT_APPLICABLE, it is SUSPECTED_FALSE_NEGATIVE.
  Scope the claim to what was actually crawled: if step 2 recorded case (a), the cap was hit
  and the site has more URLs than you saw, so the proof covers the crawled subset and has to
  say so rather than reading as a statement about the whole site.
- `STRUCTURALLY_SILENT` — the rule's eval class in {{RULE_MAP}} is `external_gsc`,
  `external_analytics`, `delta`, `model` or `action`, and that data source is not connected.
  Correct behaviour. But confirm the rule reports "no data source" rather than "0 issues" —
  silently passing a check you never ran is a reporting defect, and a client will read it as
  a clean bill of health.
- `SUSPECTED_FALSE_NEGATIVE` — the condition plausibly exists on this site but nothing fired.
  Spend up to 6 probes hunting one concrete counter-example URL. If you find one, this
  becomes `CONFIRMED_FALSE_NEGATIVE` and you record the exact URL and the observed evidence.
- `FIXTURE_ONLY` — rarity is `fixture_only` in {{RULE_MAP}}. Not expected to fire on a healthy
  public site. Add to the fixture backlog rather than treating it as verified.
- `UNVERIFIABLE` — you could not establish which of the above applies, or the gate at the top
  of this step applies because the crawl did not finish. Record the rule and the reason in
  `unverifiable` in findings.json. This is an honest verdict and always better than a guess —
  but on a COMPLETE run it is not a free pass. If you are reaching for it on more than a
  handful of rules, the problem is your method, not the site.

## Step 6 — Validate the fix recommendations

For every fired rule, read the recommendation text the crawler produced and score it on five
axes, each `pass` or `fail` with a one-line reason:

1. **Specific** — names the actual URL, element, header or value. "Fix your canonical tags"
   fails. "The canonical on /products/x points to /products/y, which returns 404" passes.
2. **Correct** — technically accurate, and accurate *for this stack*. Advice that would break
   something (e.g. telling them to remove a noindex that is deliberately protecting a staging
   path, or to canonicalise paginated pages to page 1) is a `fail` and a high-priority defect.
3. **Actionable** — a developer could execute it without further research. Names the file,
   template, header or CMS setting where the change lands, or says plainly that it depends on
   the stack.
4. **Scoped** — matches the instance count. "Fix all 400 pages" when 3 fired is a fail, and so
   is the reverse.
5. **Severity-appropriate** — the assigned severity matches the real-world impact on this
   instance. A `notice` that is actually blocking indexation here, or an `error` that is
   cosmetic, is a mis-severity defect.

Then two cross-cutting checks:
- **Boilerplate detection** — diff recommendation strings across rules. If the same paragraph
  appears under unrelated rules, flag `TEMPLATED_RECOMMENDATION`.
- **Hallucinated references** — any URL, file path, header name or spec reference in the
  recommendation must exist. Check them. Invented references are the worst class of defect
  here because they survive review and reach a client.

## Step 7 — Write findings

First, check `{{RUN_DIR}}/evidence/`. If it is absent, or empty, record a defect with
`"type": "NO_EVIDENCE_CAPTURED"` and `"severity": "P1"` against this run. Phase B builds
every failing test from those files; with none of them, each fix in the next phase is written
blind against a defect nobody can reproduce. This is the one defect that is about the run
rather than about the crawler, and it is still a P1, because it invalidates the phase that
follows this one.

Set `"coverage_complete"` in the crawl block. It is `true` only when the crawl reached a
terminal `completed` state, the step 3 reconciliation balanced, AND step 5's positive-control
check was actually runnable (`results.json` exists). A run that fails any of those still
produces useful defects, but its NOT_APPLICABLE verdicts cannot support a dead-detector claim
in Phase C, and Phase C reads this field to decide whether to count the run in its denominator.

Then write `{{RUN_DIR}}/findings.json` with exactly this shape:

```json
{
  "domain": "example.com",
  "commit": "abc1234",
  "crawl": {
    "urls_fetched": 500,
    "cap_hit": true,
    "duration_s": 0,
    "exit_code": 0,
    "persistence": "signals-only"
  },
  "ledger": { "fired": 0, "not_fired": 0, "total": 96 },
  "defects": [
    {
      "id": "D1",
      "rule_id": "canonical-to-noindex",
      "type": "FALSE_POSITIVE | FALSE_NEGATIVE | WRONG_RECOMMENDATION | MIS_SEVERITY | BAD_EVIDENCE | COUNT_MISMATCH | DEAD_RULE | CATALOG_DRIFT | CRASH | PERF | NO_EVIDENCE_CAPTURED",
      "severity": "P1 | P2 | P3",
      "evidence_url": "https://…",
      "observed": "what the crawler said",
      "expected": "what is actually true, and how you confirmed it",
      "repro": "exact command or fixture path that reproduces this offline"
    }
  ],
  "verified_ok": ["rule ids whose detection AND recommendation both passed"],
  "unverifiable": [{ "rule_id": "…", "reason": "…" }],
  "fixture_backlog": ["rule ids needing a synthetic fixture"]
}
```

Severity ranking for `defects`, in this order:
- **P1** — false positives on `error` rules, confirmed false negatives on `error` rules,
  crashes, dead rules, recommendations that would break a live site, and an absent or empty
  `{{RUN_DIR}}/evidence/` directory.
- **P2** — false positives/negatives on `warning` rules, wrong or hallucinated recommendation
  content, count mismatches, mis-severity.
- **P3** — notices, boilerplate wording, duplicate reporting, cosmetic evidence gaps.

Also write `{{RUN_DIR}}/findings.md`: a short human-readable summary — what fired, what you
confirmed, the defect list ranked, and the one thing you would fix first.

### `{{RUN_DIR}}/assumptions.md`

Every judgement call you made without me. One line each, scannable in a minute:

```
- <the call> — <why you made it> (alternative: <what you rejected>)
```

A call qualifies if I did not specify it and a different reasonable person could have chosen
otherwise. It qualifies **whether or not it turned out to be correct** — a guess that happens
to be right is still a guess, and I cannot tell which is which if only the wrong ones get
written down.

What this covers, from the first run of this loop, all of which were volunteered in prose and
none of which were collected anywhere:

- a threshold you supplied rather than read from the code (title-long was assumed to be 60
  characters; it does turn out to be `titleLength > 60` in the analyzer, and that is exactly
  the kind of correct-by-luck call this file exists to surface)
- how many of the non-firing rules you probed versus triaged on inspection, and why you
  stopped where you did
- any grouping or ranking you invented — the 38 suspected false negatives were sorted into
  seven categories that appear nowhere in the rule map
- deciding a detection is working-as-designed rather than a defect, especially where volume
  makes it look wrong (per-source-page fan-out; 429 and 403 responses from rate-limiting hosts)
- sampling choices: how many pages, chosen how, and what the sample cannot exclude
- anything you stripped from evidence before writing it (`set-cookie` was dropped from every
  captured response)
- which findings you filed as defects versus listed as verified-correct, where that was a
  judgement rather than a measurement

If a call later turns out to have been load-bearing — a verdict, a severity, a defect that
exists or does not because of it — say so on the line. Those are the ones I will want to
check first.

## Step 8 — Stop

Print `PHASE_A_COMPLETE` and the defect counts by severity. Do not start fixing. Phase B is a
separate invocation with a clean context and different permissions.
