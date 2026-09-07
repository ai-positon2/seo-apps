# Audit loop progress

The commands update this file. It is the only state that survives `/clear`, so read it first
if you have lost track of where you are.

## Run: 20260905

| # | Domain | Phase A | Defects (P1/P2/P3) | Phase B | Status | Notes |
|---|--------|---------|--------------------|---------|--------|-------|
| 1 | www.iana.org | ☑ | 0/4/2 | ☐ | coverage-incomplete | 18 rules fired, 7,298 instances. No P1 detection defects; bodyTruncated re-ranked P1. NOT_APPLICABLE verdicts NOT usable for Phase C dead-detector claims. |
| 2 |        | ☐       |                    | ☐       |        |       |
| 3 |        | ☐       |                    | ☐       |        |       |
| 4 |        | ☐       |                    | ☐       |        |       |
| 5 |        | ☐       |                    | ☐       |        |       |
| 6 |        | ☐       |                    | ☐       |        |       |
| 7 |        | ☐       |                    | ☐       |        |       |
| 8 |        | ☐       |                    | ☐       |        |       |
| 9 |        | ☐       |                    | ☐       |        |       |
|10 |        | ☐       |                    | ☐       |        |       |

Rollup: ☐

## Deferred across the run

Anything Phase B decided was too large to absorb. Review this before the rollup — a defect
deferred on three separate domains is not a deferral, it is the next piece of work.

## Notes to self between sessions

Free text. Worth recording when you overrode a verdict or accepted a fix you were unsure
about — future you will not remember which ones were judgement calls.
