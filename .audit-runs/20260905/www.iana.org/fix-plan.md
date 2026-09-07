# Phase B — fix plan, www.iana.org

Order per the prompt: P1, then P2, then P3; within a tier, under-reporting before
over-reporting. Step 4 (confirmation re-crawl) is deliberately not run — no database.

| # | Defect | Sev | Root cause | Files | Gate |
|---|---|---|---|---|---|
| D1 | `bodyTruncated` unflagged in findings | P1 | `MAX_BODY_BYTES = 5_000_000`; `bodyTruncated` lands on the *result*, nothing propagates it to findings derived from that result | `analyzer.js` | failing test |
| D2 | `broken-external-link` on HEAD timeout | P2 | GET fallback keyed on `status === 405 \|\| 501`; a timeout throws before that line and lands in the catch at `crawler.js:2692` | `crawler.js` | failing test (injected fetch) |
| D3 | `title-multiple` counts SVG titles | P2 | `documentElements()` filters only `isInTemplateContents`; `$("title")` still matches `<svg><title>` | `crawler.js` | failing test (injected fetch) |
| D4 | `/findings` serves instances, rollup unused | P2 | endpoint returns `listAllRunFindingInstances`; `crawl_run_findings` exists and `overview.js:214` reads it | `api/routes.js` | **before/after measurement — BLOCKED, needs DB** |
| D5 | Empty `detail`/`detectedValue` | P3 | two `add()` call sites pass no evidence payload | `analyzer.js` | failing test |

## Notes per defect

**D1** — the fix is not to raise the cap. A cap is correct; publishing a precise count derived
from a truncated document as though it were complete is not. Findings whose source result has
`bodyTruncated` should say so, so a reader can tell "3,830 nameless anchors" from "at least
3,830, measured on the first 5 MB of 14.4 MB". Fixture is a synthesised body just over the
cap — not the 14 MB page.

**D2** — extend the existing fallback intent rather than inventing one. The comment at
`crawler.js:2520` already says the GET fallback exists for servers that mishandle HEAD; a
server that *hangs* on HEAD is the same class as one that 405s. Retry once with GET in the
catch before recording a failure, for external jobs only.

**D3** — fix in `documentElements`, not at the `title` call site. No document-level metadata
element (`title`, `meta[name=description]`, hreflang links) is ever legitimately inside
`<svg>`, so excluding SVG descendants is correct for every caller of the helper, and fixing
only `title` would leave the same trap for the next selector.

**D4** — cannot be gated here. The measurement is payload size and load time against a real
run, which needs the database and a populated crawl. Deferred to `deferred.md` with the
measurement method specified so it can be run the moment Step 4 has a database.

**D5** — smallest of the five and the least interesting, but it is what makes the other
findings actionable: an issue record with no observed value gives a developer nothing to
locate.

## Not attempted

Nothing in this list requires a schema change, a crawl-architecture change, or a new data
source, so nothing goes to `deferred.md` on those grounds. D4 is deferred only for want of a
database, not because it is too large.
