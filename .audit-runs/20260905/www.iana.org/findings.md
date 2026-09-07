# Phase A — www.iana.org

Run `a0743a84-bc4e-4ac6-84f3-dd7b2822b95b` · commit `e4b3a72` · 2026-09-05
650 URLs fetched (500 internal, 150 external) · cap hit · completed in 355s
**Coverage: INCOMPLETE — see the note at the end before using this run in Phase C.**

---

## Counting grain — read this first

This crawl produced **18 rules that fired** and **7,298 instances of them**. Two tables, two
grains, and the difference is a factor of 400:

| Store | Rows | Grain |
|---|---|---|
| `crawl_run_findings` | **18** | one per rule, carrying a `count` column |
| `crawl_run_finding_instances` | **7,298** | one per occurrence |

`findings_cmd` (`GET /runs/:id/findings`) returns the **7,298 instances**.

**Every per-rule number below is an INSTANCE count unless it says otherwise.** So
"`anchor-missing` 3,831" means one rule with 3,831 occurrences — not 3,831 problems. The
rule-level summary of this run is: 18 rules fired on a 500-page crawl, producing 5 crawler
defects and 0 P1 detection defects.

`run.summary.counts` (error 486 / warning 5,840 / notice 972) is a severity breakdown of
**instances**. It reconciles against 7,298 and never against 18.

---

## Reconciliation

| Check | Result |
|---|---|
| findings endpoint vs `summary.findingsCount` | 7,298 = 7,298 |
| ledger instance sum vs findings returned | 7,298 = 7,298 |
| per-severity vs `summary.counts` | exact match |
| findings carrying a ruleId absent from the catalog | none |
| `lostResultRows` | 0 |

The read-back returned all 7,298 across eight pages. A truncating read would have shown here.

---

## Defects — at rule level

### D1 · P1 · `bodyTruncated` silently caps parsing at 5 MB
**Crawl layer, not a single rule.** `/domains/idn-tables` is 14,383,618 bytes; the crawler
stored `bodyTruncated: true, decodedSize: 5,000,000` and parsed the first 5 MB. Six rules
produced findings on that page and every one of them inherited the partial document:
`anchor-missing`, `sitemap-missing-indexable`, `meta-missing`, `h1-title-duplicate`,
`open-graph-incomplete`, `slow-page`.

The flag is recorded on the *result*; the findings derived from it carry no marker, so a
knowably-partial count is published as though it were complete. Measured effect: 3,830
reported against **11,113** anchors genuinely lacking an accessible name (verified by fetching
the page and counting). One of 650 results was truncated on this domain, so blast radius here
is one page — the exposure is general.
*Evidence:* `evidence/anchor-missing__1.http`

### D2 · P2 · `broken-external-link` false positive — HEAD times out, GET succeeds
966 of 1,021 instances report `Timed out` for two icann.org footer links. They are not broken:

```
HEAD /privacy/policy → timed out, 20s, 0 bytes
GET  /privacy/policy → 301 in 0.8s
```

External checks probe with `HEAD`, and the GET fallback triggers only on `405/501` — not on a
timeout. icann.org behind Cloudflare accepts GET and hangs on HEAD, so the single (correctly
deduped) HEAD stores `status: 0` and the rule fires on `!target.status`.

**Not a dedupe problem.** `externalSeen` already gates enqueue: two URLs, two fetches. The
966 is per-(source page, target) fan-out at instance grain, which is by design.
**Fix:** widen the GET fallback to cover timeout/abort as well as 405/501.
*Evidence:* `evidence/broken-external-link__1.http`

### D3 · P2 · `title-multiple` counts SVG `<title>` as document titles
`/performance` records `titleCount: 49`. It has exactly **one** document title
(`"Performance"`); the other 48 are `<title>` elements inside inline `<svg>` — chart
accessibility labels reading `"August 2025: 100%"`. Same on `/dnssec/tcrs` (41).
The selector needs to exclude `svg title`.
*Evidence:* `evidence/title-multiple__1.http`

### D4 · P2 · `/runs/:id/findings` serves instances; the rule-level rollup exists and is unused
The endpoint returns all **7,298 instances — 2.0 MB, 9.8 s**. The report page then groups them
client-side to render "N distinct causes" and its tab counts, re-deriving what the database
already holds.

`aggregateFindings` writes `crawl_run_findings` — 18 rows keyed by `ruleId`, each with a
`count` — on every completed run. **`overview.js:214` already reads it correctly**, its own
comment calling it *"the rollup `crawl_run_findings` already holds"*. So the aggregation is
built, correct, and consumed elsewhere; only this endpoint doesn't offer it.

**The fix is to serve the rollup, not to build one.** This is also the whole of the report's
~18 s time-to-usable (findings 2.0 MB / 9.8 s plus results 1.5 MB / 6.0 s).

This supersedes what an earlier draft framed as an emission defect. `scope` is fully populated
on every finding (`sitemap-missing-indexable` 484 × `template`, `meta-missing` 484 ×
`template`, `external-403` 483 × `template`, zero unset), so nothing is misclassified. The
per-page repetition is instance grain working as intended.

### D5 · P3 · Empty evidence payloads on two rules
`sitemap-missing-indexable` (484 instances) and `meta-missing` (484) both emit `detail: ""`
and `detectedValue: ""`. Both detections are correct — iana.org publishes no sitemap
(`robots.txt` declares none, `/sitemap.xml` 404s) and the pages genuinely carry no meta
description — but an issue record with no observed value gives a developer nothing to locate.
*Evidence:* `evidence/sitemap-missing-indexable__1.http`, `__2.http`, `evidence/meta-missing__1.http`

---

## Defects in this prompt, not in the crawler

### P1 · Step 3 did not require the counting grain to be established
The entire first draft of this report was written in instance counts without saying so.
"484 of 486 errors" described **one rule counted 484 times**; a Phase B fixer working from it
would have hunted volume that was never a defect. It also produced a wrong conclusion — that
finding emission needed collapsing — when the collapse already existed (D4).
**Fixed:** Step 3 now requires `grain.json` and demands every count be labelled.

### P2 · Step 5 accepted proofs citing fields that do not exist
A census keyed on `result.hreflang` — the real field is `hreflangs` — read `undefined` on
every row, counted zero, and produced *"zero hreflang attributes across 500 results"* as
proof for three rules. The conclusion happened to be right; the method was worthless. The same
typo also suppressed real coverage, reading 53 rules as unproven where 29 were provable.
**Fixed:** Step 5 now requires `result-schema.json`, a positive control, and shared
preconditions stated once.

### P2 · Step 2 did not dump raw results, making this run un-re-auditable
Without `results.json`, the positive-control check cannot run after the crawl store is
cleaned — which is why this run is coverage-incomplete.
**Fixed:** Step 2 now dumps `results.json`.

---

## Verified correct — not defects

- **`external-403`** — icann.org really does return 403 behind Cloudflare, and the rule's
  wording is exactly right: *"proves request refusal, not that the destination is missing."*
- **`anchor-missing`** detection — real, and *under*-reported (see D1), not over-firing.
- **`sitemap-missing-indexable`** detection — the site genuinely publishes no sitemap.
- **`meta-missing`**, **`open-graph-incomplete`**, **`heading-hierarchy-skipped`**,
  **`title-multiple`** (2 pages do have >1 `<title>` element — the defect is *which* elements
  it counts, not that it fired).

## Non-firing rules probed

| Rule | Verdict | Basis |
|---|---|---|
| `title-long` | NOT_APPLICABLE | Exhaustive: 484/484 titles measured, max length **39** vs a 60 threshold |
| `title-duplicate` | NOT_APPLICABLE | Exhaustive: **484 distinct titles across 484 pages**, zero duplicates |
| `broken-internal-links` | NOT_APPLICABLE | 40 internal links from 8 pages, zero ≥400; consistent with zero 4xx across all 500 internal results |

Both title verdicts are full censuses, not samples. 35 of the 38 SUSPECTED_FALSE_NEGATIVE
rules remain **triaged on inspection with zero probes** — the weakest part of this run.

---

## Coverage — do not use this run for dead-detector claims

`coverage_complete: false`. Step 5's positive-control check could not run: `results.json` was
never written and the crawl store has been cleaned. The 29 `NOT_APPLICABLE` verdicts cannot be
re-audited, so **they must not count toward a never-fired escalation in Phase C**. The two
title verdicts above are the exception — they rest on a fresh exhaustive census.

## What to fix first

**D2.** It is a one-condition change (widen the GET fallback beyond 405/501), it is correct in
general rather than for this domain, and it removes 966 of 7,298 instances — 13% of the audit —
that assert live links are broken. Any client reading this report would have chased them.
