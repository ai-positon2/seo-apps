# Audit loop progress

The commands update this file. It is the only state that survives `/clear`, so read it first
if you have lost track of where you are.

## Run: 20260905

| # | Domain | Phase A | Defects (P1/P2/P3) | Phase B | Status | Notes |
|---|--------|---------|--------------------|---------|--------|-------|
| 1 | www.iana.org | ☑ | 0/4/2 | ☐ | coverage-incomplete | 18 rules fired, 7,298 instances. No P1 detection defects; bodyTruncated re-ranked P1. NOT_APPLICABLE verdicts NOT usable for Phase C dead-detector claims. |
| 2 | www.brushandfloss.com | ☑ | 1/5/10 | ☑ | Phase B pass | Phase A 2026-09-23 (run dir 20260923). 30 rules fired, 6,312 instances; 51 of 89 error instances real. Crawled in-process with no DB, so nothing is stored in production. Findings: `.audit-runs/20260923/www.brushandfloss.com/findings.json`. `replay.js` in the run dir re-runs the analyzer offline (6,312 = 6,312). **Phase B 2026-09-23: 13 fixed, 13 commits be81a70..fef5baf (not pushed); deferred D7, D6, D11 (deferred.md); re-crawl overlap 649/650, every count change explained, 6,312 → 5,725 instances; suite 65/65, crawlScope 215 → 235 tests. verification.json.** |
| 3 | www.nc.gov (government) | ☑ | error check only | ☑ | pass | 2026-09-23, complete crawl (169 internal). 44 errors: 37 real, 7 false (canonical variants → M3). Re-crawl: 37 errors, 37 real. |
| 4 | www.allbirds.com (Shopify) | ☑ | error check only | ☑ | pass | 68 errors: 4 real, 64 false (HTTP 429 throttling reported as broken → M1 retries default NaN, M2 429 = not crawled). Re-crawl: 4 errors, 4 real; no 429 left; crawl 260 s → 1,891 s (backoff never decays, deferred). |
| 5 | vercel.com (Next.js) | ☑ | error check only | ☑ | pass | 13 errors: 11 real, 2 false (M3). Re-crawl: 11 errors, 11 real. |
| 6 | www.aspendental.com (healthcare) | ☑ | error check only | ☑ | pass | 237 errors: 210 real, 25 false (9 M3; 16 = body-read timeout judged as empty page → M4), 2 flapping 404s. Re-crawl: 224 errors, 213 real, 0 false, 11 transient (7 slow downloads, 2 pages flapping 404). |
| 7 | techcrunch.com (WordPress news) | ☑ | error check only | ☑ | pass | 87 errors: 20 real, 53 false (47 in sitemap docs past the 200-doc cap → M5, 6 canonical → M3), 14 News-sitemap overlap (→ M6). Full 2,060-doc sitemap read; sitemap-page-966.xml malformed. Re-crawl after M6: 12 errors, 12 real (News sitemap recognised). 8 real "missing from sitemap" pages now "not evaluated" (deferred). |
| 8 |        | ☐       |                    | ☐       |        |       |
| 9 |        | ☐       |                    | ☐       |        |       |
|10 |        | ☐       |                    | ☐       |        |       |

Rollup: ☐

## Deferred across the run

Anything Phase B decided was too large to absorb. Review this before the rollup — a defect
deferred on three separate domains is not a deferral, it is the next piece of work.

- www.brushandfloss.com D7 (P3): asset rules cannot see an off-origin asset CDN (Webflow/Shopify/Squarespace). Crawl-scope change; D8 reports those checks as not evaluated meanwhile.
- www.brushandfloss.com D6 (P3): one pagination cause reported under title/meta/h1-duplicate. Needs a grouped finding (catalog change).
- www.brushandfloss.com D11 (P3): robots-blocked warns about a deliberately blocked /search. No generally correct fix without project-declared blocked paths.
- www.brushandfloss.com decision: sitemap-missing-indexable severity (error vs warning) after D2. Catalog decision; it moves the 27/54/15 split.
- Five-domain round (2026-09-23): fixes M1–M6, commits 2e9fbab..25d0012. Deferred in `.audit-runs/20260923/five-domain-deferred.md`: low-word-count counts template text (needs boilerplate detection), full sitemap read for very large sitemaps (TechCrunch 2,059 docs), per-host backoff never decays (Allbirds 260 s → 1,891 s).

## Notes to self between sessions

Free text. Worth recording when you overrode a verdict or accepted a fix you were unsure
about — future you will not remember which ones were judgement calls.
