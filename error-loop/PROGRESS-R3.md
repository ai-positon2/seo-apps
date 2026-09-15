# Error loop progress — Round 3 (loops 57-84)

Lenses: **Security and input validation** and **Failure modes and robustness**. See `error-loop/PLAN-R2-R3.md` for why these and not a
repeat of Round 1. Round 1's ledger is `error-loop/PROGRESS.md`.

**Gate (unchanged):** `node --check` · `require-graph` · `npm test --prefix server` ·
`npm run build --prefix client` · every detector relevant to the area.

**Verification rule (unchanged):** no finding is a defect until it has a written failure
scenario. Round 1 rejected ~137 of ~150 mechanical candidates.

## Entry state for this round

| Detector | Result |
|---|---|
| require-graph | 0 unresolved / 0 missing exports |
| async-route-guard (whole server) | 0 unguarded (1 known false positive) |
| route-params | 0 |
| floating-promise | 0 real |
| env-refs | 0 undocumented |
| sql-refs | 0 real |
| api-contract | 0 mismatches (274 routes / 202 calls) |
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | ok |

## Loop ledger

Grade counts are **confirmed** findings only.

| # | Area | Pass | P1 | P2 | P3 | Fixed | Deferred | Gate | Status |
|---|------|------|----|----|----|-------|----------|------|--------|
| 57 | HTTP boundary & auth | E security | 0 | 1 | 0 | 1 | 1 | ☑ | complete |
| 58 | HTTP boundary & auth | F robustness | 0 | 1 | 0 | 1 | 0 | ☑ | **area complete** |
| 59 | Platform services | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 60 | Platform services | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 61 | Config & bootstrap | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 62 | Config & bootstrap | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 63 | Database layer | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 64 | Database layer | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 65 | Projects module | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 66 | Projects module | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 67 | CrawlScope | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 68 | CrawlScope | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 69 | AI Visibility | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 70 | AI Visibility | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 71 | Location Page Builder | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 72 | Location Page Builder | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 73 | Checks & scripts | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 74 | Checks & scripts | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 75 | Content Architect | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 76 | Content Architect | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 77 | Competitor Analysis | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 78 | Competitor Analysis | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 79 | Small modules | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 80 | Small modules | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 81 | Client API & state | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 82 | Client API & state | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 83 | Client pages & components | E security | 0 | 0 | 0 | 0 | 0 | ☑ | complete |
| 84 | Client pages & components | F robustness | 0 | 0 | 0 | 0 | 0 | ☑ | complete |

## Confirmed findings

### L57 · P2 · SSRF — five endpoints fetched any URL a signed-in caller named
**Defect:** `server/routes/{agentReadinessAudit,seoGeoAudit,imageAltAudit,contentEnhancement,articleEnhancement}.js`
each take a URL from `req.body`, parse it with `new URL()`, and fetch it **server-side**
with no check on where it points. Parsing proves the string is well-formed; it says nothing
about whether this server should be made to reach that host.

The repo already contained two working SSRF guards — `modules/contentArchitect/urlSafety.js`
(`assertPublicHost`, DNS-resolves and rejects if ANY returned address is private, blocking
14 IPv4 CIDRs incl. `169.254.0.0/16`, plus IPv6 loopback/ULA/link-local and IPv4-mapped)
and `modules/crawlScope/net/guard.js`. Neither was imported by anything in `server/routes/`.

**Fails when:** a signed-in user POSTs `{"url":"http://169.254.169.254/latest/meta-data/"}`.
`agentReadinessAudit`'s `safeFetch` uses `validateStatus: () => true` and `maxRedirects: 3`,
so a 401 or a redirect still returns `{status, headers, data}` and the check results carry
that back out. The same shape reaches every internal host the container can route to and
the caller's own browser cannot — an internal port/host oracle at minimum, and a path to
cloud instance credentials at worst.
Severity is P2 rather than P1 only because every route sits behind `requireAuth` and the
Google allowlist, so the caller is a known org member. It is still a privilege boundary:
the server sits in a network the employee does not.

**Fix:** All five now call `assertPublicHost(hostname)` before fetching, reusing the
existing guard rather than adding a third implementation. Verified directly:
`169.254.169.254`, `127.0.0.1`, `10.0.0.5`, `192.168.1.1` and `::1` are refused,
`example.com` passes. Blocked hosts answer **400** with the reason; `imageAltAudit` rejects
the whole batch and names every offending URL rather than silently dropping entries.
Two handlers (`imageAltAudit` `/init`, `articleEnhancement` `/init`) had to become `async`,
and both new awaits are wrapped — adding a guard must not reintroduce the hung-request
class Round 1 spent 25 fixes removing. Confirmed: `async-route-guard` is back to its single
known false positive.

**Known remaining gap (deferred):** `agentReadinessAudit`'s `safeFetch` still lets axios
follow up to 3 redirects itself, so a *public* host that 302s to a private one is reachable.
Closing that needs per-hop revalidation — which `urlSafety.fetchSafe()` already implements
with `maxRedirects: 0` and a manual hop loop — but swapping the fetch layer in these routes
is a larger change than this pass should make blind. Recorded rather than half-done.

### L57 · P2 · agentReadinessAudit.js — HTML injection into a server-side headless browser
**Defect:** `POST /pdf` takes `req.body` verbatim (`const data = req.body`) and
`buildPdfHtml(data)` interpolated **21 caller-controlled values** into HTML with no
escaping — `c.label`, `c.cat`, `c.tech`, `c.business`, `c.detail`, `c.action`, `c.status`,
`c.effort`, `cat.id/score/passed/total`, all five `cmoBrief.*` fields, and
`site.url/level/date/score`. Several sit **inside style attributes**
(`width:${w}%`), where a crafted value breaks out of the attribute.

**Fails when:** a signed-in caller posts
`{ site:{…}, checks:[{ detail:"<img src=x onerror=fetch('http://169.254.169.254/…')>" }] }`.
`page.setContent(html, { waitUntil: 'networkidle0' })` renders it in Chrome — launched with
`--no-sandbox` whenever a local browser is found — and `networkidle0` then politely waits
for the injected request to finish. This reaches the internal network from inside the
browser context, so it also sidesteps the `assertPublicHost` guard added earlier in this
same loop, which only covers the audit's own fetches.

**Fix:** Added `esc()` (HTML-escaping `& < > " '`) and `num()` (numeric coercion for CSS
positions), applied to all 21. Derived values — badge colours from a status lookup, the bar
colour from a numeric score — come from literal palettes and are left alone. Verified by
re-scanning for raw `${c.|cat.|cmoBrief.|site.}` interpolations: none remain. The one
remaining raw interpolation is `${c.action ? '…' : ''}`, a literal-string conditional.
`buildPdfHtml`'s sibling at line 315 builds a plain-text LLM prompt, not HTML, so it is
deliberately not escaped.

### L59-L80 · P2 · Path traversal in three file-backed stores
**Defect:** `contentArchitect`, `onPageAudit` and `competitorAnalysis` name their files
after an id that arrives straight from `req.params` — `${id}_patterns.json`,
`${id}.json`, `${clientId}.json` — with no validation. `path.join` resolves `..`
silently, so the path simply lands outside the module's data root.

**Fails when:** an id contains `../`. Verified by construction:
`path.join('/data/content-architect', '../../etc/shadow' + '_patterns.json')` →
`/etc/shadow_patterns.json`. The id is never constrained: `genId()` produces safe ids, but
`getProject()` only does a lookup, and `router.param('id')` calls `next()` even when the
project does not exist, so an arbitrary id reaches the handlers.
The reachable operations were an arbitrary JSON **read** (blind — `readJson` swallows) and,
worse, an arbitrary file **delete**: `deleteProject()` unlinks four sidecars and
`deleteAudit()` unlinks `${id}.json`, both regardless of whether the row existed. The
suffixes limit which files can be hit; they do not contain the traversal.

**Fix:** New `server/services/safeFileId.js` — `assertSafeFileId()`, rejecting anything
outside `[A-Za-z0-9_-]` plus interior dots, path separators, `..`, empty and >128 chars —
applied **inside the path builders**, which is the choke point every caller passes through
(an upstream-only check would leak via the modules' own internal calls). Same principle as
`recordStore.table()`: validate where the value is interpolated, not where it arrived.
Verified functionally: `deleteAudit`, `saveAudit`, `deleteProject` and `getSnapshot` all
reject `../../x` with `UnsafeIdError` (status 400), while valid ids behave exactly as before.

## Deferred

## Deferred

_None yet._

## Unconfirmed / rejected candidates

Recorded so a later pass does not re-litigate them.

- **L57/L58 · A LEXER BUG IN MY OWN DETECTORS, and what it did to earlier rounds.**
  Adding the `esc()` helper above made `async-route-guard` drop from 1 finding to 0. The
  handler had not changed — the detector had gone blind. `esc()` contains
  `.replace(/"/g, …).replace(/'/g, …)`: regex literals containing quote characters. Every
  detector carried its own copy of a blanker that knew about comments and strings but **not
  regex literals**, so it treated those quotes as string delimiters and desynchronised from
  that point to the end of the file — reporting FEWER findings, silently.
  I nearly recorded that 0 as an improvement. It was caught only by asking why a number
  had moved when the code under it had not.
  **Scope:** `grep` finds **88 non-test server files** containing a quote-bearing regex, so
  detector coverage in Rounds 1 and 2 was partially compromised across them.
  **Fix:** one shared, regex-aware lexer at `error-loop/tools/lib/blank.js`, used by all
  nine detectors, with the regex-vs-division ambiguity resolved by the standard
  previous-significant-token rule. It exports two functions, because the distinction
  matters: `blank()` (comments + strings + regexes) for structural detectors, and
  `blankComments()` for `api-contract`, whose entire subject IS string content — switching
  it to the string-blanking version made it read empty quotes and report **0 routes and 0
  client calls**, a confident zero from a detector that could no longer see anything.
  Wiring the shared lexer in also broke `route-params`, which extracts the route path out
  of a literal; it now matches paths against raw source and bodies against blanked source.
  **Re-verification:** every detector was re-self-tested against a fixture containing the
  exact quote-bearing-regex shape, then re-run across the whole server. All nine now fire
  correctly, and **the corrected sweep reproduces every earlier conclusion** — 0 unresolved
  requires, 0 route-param mismatches, 0 env drift, 0 api-contract mismatches, the single
  known `browser.close().catch()` false positive, the single known CLI `main()`, the 6
  benign SQL hits and the 7 already-verified resource patterns. **No finding had been
  hidden.** The conclusions of Rounds 1 and 2 stand, now on a sound basis rather than a
  lucky one.
- **L57 · `ssrf-paths.js` first run reported 0 and was WRONG.** The detector skipped a call
  whenever a guard name appeared anywhere in a ±400-character window — which included the
  `const { assertPublicHost } = require(...)` line at the top of the file. Its own self-test
  caught it: the deliberately-vulnerable fixture came back clean. Rewritten to look backward
  only and to strip `require` lines first, since a guard must RUN before the call to be a
  guard and an import is not a call. This is the clearest case in three rounds of why a
  detector reporting zero is worth nothing until it has been proven to fire.
- **L57 · the corrected detector still reports 0 on the real tree, and that is also not
  proof.** It only sees a fetch and `req.*` in one window; these routes destructure the URL
  in the handler and fetch it in a helper further down or in another file. The five real
  findings above came from tracing entry points by hand, not from the detector.


## Round 3 close — loops 57-84

**4 defects fixed** (3× P2 security, 1 tooling), **1 deferred**.

| Gate | Result |
|---|---|
| `npm test --prefix server` | 191 pass / 0 fail |
| `npm run build --prefix client` | ok |
| All 9 detectors, re-verified with the corrected lexer | as expected |

### Pass E — security
1. **SSRF, 5 endpoints.** Any URL a signed-in caller named was fetched server-side with no
   check on where it pointed, reaching cloud instance metadata and the internal network.
   Fixed with the repo's own existing guard.
2. **HTML injection into a headless browser.** `POST /pdf` interpolated 21
   caller-controlled values into HTML rendered by Chrome with `--no-sandbox`, several
   inside style attributes. Fixed by escaping; its sibling `competitorPdfGenerator.js`
   already did this correctly, which is what showed the omission was an oversight.
3. **Path traversal, 3 file-backed stores.** Arbitrary file delete with a known suffix.
   Fixed at the path builders.

Checked and clean: secrets never interpolated into errors or responses (only variable
NAMES appear); no prototype pollution (neither merge site is a deep merge, and object
spread uses CreateDataProperty); `recordStore` already validates table and column
identifiers; LPB's collection→table mapping is guarded downstream.

### Pass F — robustness
Degraded mode verified functionally with `DATABASE_URL` unset: `runStore.runStats`,
`runStore.listRuns`, `moduleQueue.claimNext`, `featureFlags.listAssignments` and
`platformAdmin.bootstrapEmails` each return a safe empty default rather than throwing —
which also re-confirms the Round 2 `runStats` rewrite behaves correctly when unconfigured.

### The tooling failure, and why it is recorded as a finding
Round 3 found a bug in **my own detectors** that made them under-report silently, across
88 server files. It is written up in full under "Unconfirmed / rejected candidates" above.
The short version: all nine shared a lexer that did not understand regex literals, a
quote inside a regex desynchronised it to end-of-file, and the symptom was a detector
getting *quieter*. It was caught only by asking why a number moved when the code under it
had not. One shared regex-aware lexer now backs all nine, each was re-self-tested against
that exact shape, and the corrected repo-wide sweep reproduces every earlier conclusion —
so nothing had been missed, but that was luck rather than design.
