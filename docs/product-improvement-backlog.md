# Delivery backlog and acceptance criteria

Companion to the [product roadmap](product-improvement-plan.md). All items are **proposed**, not implemented or externally assigned. IDs are stable so they can be imported into an issue tracker later. Ranges are engineering days; dependencies refer to these IDs. P0 = correctness/continuity; P1 = core value; P2 = demand-led extension.

## Release index

| ID | Deliverable | Release | Priority | Days | Main dependency |
|---|---|---|---|---:|---|
| B01 | Runtime, storage, and baseline inventory | R0 | P0 | 2–3 | None |
| B02 | Project context and legacy identity mapping | R0 | P0 | 4–6 | B01 |
| B03 | Durable pilot knowledge and content artifacts | R0 | P0 | 4–6 | B01–02 |
| B04 | Explicit SERP provider and migration path | R0 | P0 | 2–4 | B01 |
| B05 | Versioned question campaigns and run plans | R1 | P0 | 4–6 | B02 |
| B06 | Resumable, idempotent visibility captures | R1 | P0 | 4–6 | B05 |
| B07 | Shared metered-use reservations and ledger | R1 | P0 | 4–6 | B01–02, B05 |
| B08 | Repeat sampling and comparable surface configuration | R1 | P1 | 3–5 | B05–07 |
| B09 | Metric consistency and historical report basis | R1 | P0 | 4–6 | B05–06 |
| B10 | Brand/alias review improvements | R1 | P1 | 2–3 | B02, B05 |
| B11 | Source-backed brand profile | R1 | P1 | 3–5 | B02–03, B07, B10 |
| B12 | Versioned strategy and explicit capability gates | R1 | P1 | 2–3 | B11 |
| B13 | Buyer-question coverage beyond existing pages | R2 | P1 | 3–5 | B05, B07, B11–12 |
| B14 | Evidence-linked opportunities | R2 | P1 | 3–5 | B08–10 |
| B15 | Content work items and delivery lifecycle | R2 | P1 | 3–5 | B02, B14 |
| B16 | Briefs seeded by measured citations | R2 | P1 | 4–6 | B03, B07, B11–12, B15 |
| B17 | Brief-linked drafts, review, and versions | R2 | P1 | 4–6 | B16 |
| B18 | Publication records and follow-up measurements | R2 | P1 | 2–4 | B08–09, B17 |
| B19 | Reproducible client report snapshots | R2 | P1 | 3–5 | B09, B15–18 |
| B20 | Effective crawler access checks | R0 | P1 | 2–3 | B01 |
| B21 | Shared crawl evidence and diagnostic coverage | R3 | P1 | 3–5 | B02–03, B20 |
| B22 | Applicable editorial rubric and unified findings | R3 | P1 | 4–6 | B07, B12, B21 |
| B23 | Finding-linked passage fixes | R3 | P1 | 3–5 | B17, B22 |
| B24 | Read-only Search Console ingestion | R3 | P1 | 6–10 | B02; authorized property |
| B25 | Measured delivery outcomes | R3 | P1 | 3–5 | B09, B18, B24 for search metrics |
| B26 | Useful recurring schedules and anomaly inbox | R3 | P1 | 2–4 | B07–09, B18 |
| B27 | Citation-based off-site research work | R3 | P1 | 2–3 | B09, B15–16 |
| B28 | Remaining legacy-store migration | Later | P2* | 5–9 | B01–03 |
| B29 | Additional capture surfaces | Later | P2 | 3–5 per adapter | B06–09; provider spike |
| B30 | Consensus topic/section extraction | Later | P2 | 2–4 | B09, B16 |
| B31 | Calibrated sentiment and theme review | Later | P2 | 2–4 | B07, B09–10 |
| B32 | Explicit CMS draft handoff | Later | P2 | 4–8 per CMS | B17–18 |
| B33 | Portfolio reporting and export polish | Later | P2 | 2–4 | B19, B25 |

*B28 becomes P0 for affected modules if B01 discovers unprotected production files. Re-plan capacity rather than assuming these migrations can be added for free. Its range covers an initial migration tranche; re-estimate the remainder after the first store, especially concurrent file writers and ambiguous client mappings.*

R0 total: **14–22** days. R1: **26–40**. R2: **22–36**. R3: **23–38**. Core total: **85–136**. Optional provider/CMS work is not included.

## R0 stories

### B01 — Establish what is actually running

**Story:** As the operator, I need a verified inventory of schema, workers, storage, and service configuration so the team improves the real deployment without losing work or depending on an unavailable feature.

**Owner role:** Engineering/operations. **Reuse:** dataRoot, featureFlags, moduleWorker, migration files, existing deployment configuration.

Acceptance criteria:

- Record each module's storage backend, effective root or table, project/client key, backup mechanism, worker mode, and migration prerequisites. Record availability only; exclude credential values.
- Identify pilot file records and the existing Location Page Builder migration work. Produce a mapping/reconciliation plan before any import or root switch.
- In a controlled environment, save a representative artifact, restart the relevant process, and recover it; restore a backup into an isolated target and compare checksums/content.
- Distinguish code availability, configuration availability, and successfully demonstrated operation in the inventory. Missing access is an explicit unknown.
- Record pilot baseline preparation time and current capture success/cost/duration from permitted evidence; label unavailable baseline data instead of estimating it as fact.

### B02 — Keep the selected client consistent

**Story:** As a strategist, I want the active project's domain, market, brand, and KB to follow me into research and content work so I do not accidentally generate work for another client.

**Owner role:** Full-stack engineering. **Reuse:** activeProject, projectAccess, workspaceContext, kbLoader, existing module client adapters.

Acceptance criteria:

- Introduce an explicit project-context contract containing workspace/project IDs, primary domain, market/locale, reviewed brand, KB references, and context version IDs; server membership checks govern access.
- Resolve existing KB/client slugs through a reviewed mapping table. Ambiguous or unmatched records appear in a resolution list and are never assigned by fuzzy name match alone.
- Switching project clears pending client-specific UI data and changes subsequent generation inputs. A late response from the old project cannot overwrite the new project's screen.
- A cross-project read/write/job request is rejected server-side. Missing mandatory project identity produces an actionable error before a metered call.
- Existing standalone tools remain reachable; newly connected entry points are prefilled and disclose their source project.

### B03 — Preserve pilot knowledge and deliverables

**Story:** As an editor, I want my reviewed brand information and saved content to survive reloads and deployments so I can safely return to work.

**Owner role:** Backend engineering. **Reuse:** kbStore API, Supabase store adapter where appropriate, storage/version patterns in Location Page Builder.

Acceptance criteria:

- Protect existing pilot KB files with verified durable storage/backup, then introduce durable versioned storage behind the existing interface or an explicit adapter. Preserve original IDs, metadata, and content during import.
- Re-running import creates no duplicates; reconciliation identifies every missing/changed/ambiguous record. Original files remain available for rollback.
- Provide a durable artifact interface for B16/B17 with project ownership and version checks; full content does not rely on a sanitized `tool_runs` payload.
- Two editors saving the same prior version receive a conflict rather than silent last-write-wins loss.
- A failed storage write does not show “saved”; restart/restore and unauthorized-project fixtures pass before enabling pilot writes.

### B04 — Make search-provider selection dependable

**Story:** As a researcher, I need SERP-based tools to continue working when a provider is unavailable or retired, with the source clearly identified.

**Owner role:** Backend engineering. **Reuse:** googleSearch.js and its existing Serper fallback.

Acceptance criteria:

- Add an explicit configured primary provider and capability check; do not repeatedly call a known-unavailable Custom Search service before using the configured fallback.
- Normalize results while retaining provider, market, language, timestamp, and rank provenance. An empty successful result is distinguishable from an authentication or quota failure.
- Test primary success, 403/429, timeout, fallback unavailable, and both providers failing with deterministic fixtures. Return an actionable failure without an infinite retry chain.
- Inspect all current wrapper consumers, including keyword research, enhancement, article briefs, and Location Page Builder; validate their required response shape.
- Update setup/help text and run a capped acceptance test on the selected provider before cutover. Target 30 November 2026; Google's stated transition deadline is 1 January 2027, as sourced in the roadmap.

### B20 — Report actual crawler permissions

**Story:** As a technical SEO specialist, I need to know whether a specific page is allowed for a relevant crawler so I can make a justified robots change.

**Owner role:** Backend engineering plus SEO reviewer. **Reuse:** Agent Readiness, robots-parser dependency, CrawlScope fetch guards.

Acceptance criteria:

- Evaluate effective rules for a requested URL and user agent, including wildcard groups, path specificity, Allow/Disallow conflicts, and robots fetch outcomes according to the documented parser/RFC behavior.
- A file containing an agent name with `Disallow: /` cannot pass as “accessible” merely because the name is present. A valid permissive wildcard rule does not fail solely for lacking a named agent.
- Show observed URL, agent, robots fetch time/status, matched rule, and an allowed/denied/unknown verdict. Agent-purpose metadata is maintained separately from the parsing rule.
- Proposed directives are reviewable downloads/previews; running an audit does not modify a site's robots file.
- Optional guidance/protocol checks show applicability and informational status. Fixture tests cover blocked, allowed, malformed, and unavailable robots responses.

## R1 stories

### B05 — Freeze the questions and configuration being measured

**Story:** As an analyst, I need versioned question campaigns so edits cannot make a historical comparison appear to improve by changing the test.

**Owner role:** Full-stack engineering. **Reuse:** ai_visibility_prompts, promptLifecycle, existing prompt review UI.

Acceptance criteria:

- Campaigns support a name, scope, market/locale, question membership, and draft/approved revisions. Manual and generated questions use the same review path.
- Editing approved question text creates a new revision; old captures retain their exact text and revision. Existing captures without revision data are identified as legacy rather than assigned invented history.
- Before enqueueing, persist a run plan containing campaign/brand/context versions, surfaces, repetitions, and the full requested task matrix. The worker uses that plan rather than today's mutable defaults.
- Show the planned count and budget estimate before execution. Unavailable surfaces, exclusions, and over-budget questions remain visible in the plan.
- Only authorized roles activate a campaign revision; generation alone never triggers a measurement run.

### B06 — Resume interrupted measurements safely

**Story:** As the operator, I want a run to retain completed samples and resume remaining tasks after a crash so I do not lose evidence or blindly purchase it again.

**Owner role:** Backend engineering. **Reuse:** moduleQueue, moduleWorker, moduleExecutors, captureScheduler, saveCaptures.

Acceptance criteria:

- Persist each completed capture and its provenance incrementally; use a unique logical task key and separate attempt records. A retry cannot produce two accepted samples for the same planned task.
- A worker killed after sample 7 resumes from the persisted state; samples 1–7 remain reportable and are not recaptured simply because the process restarted.
- Check lease ownership before each metered operation, evidence write, and terminal transition. A reclaimed worker stops dispatching work and cannot overwrite the new owner's result.
- Use provider idempotency/status retrieval when supported. A timeout after a potentially charged request becomes an explicit uncertain state if recovery is impossible; do not promise exactly-once provider billing.
- Cancellation/deadline/budget stops retain partial results and counts. Retry limits and backoff are bounded and testable.

### B07 — Account for concurrent metered work

**Story:** As an account owner, I want a cost estimate and enforceable shared budget so scheduled jobs and manual runs cannot silently overspend.

**Owner role:** Backend engineering. **Reuse:** existing AI guard, module limits, provider cost fields, audit events.

Acceptance criteria:

- Reserve estimated metered spend transactionally at workspace/project level before dispatch; two simultaneous jobs competing for the remaining budget cannot both reserve it.
- Settle actual provider charges, release unused reservations, and append adjustments with reason, currency, provider/action, and source job. Replayed completion events do not double-charge the ledger.
- A charged failure remains spend; releasing an unused reservation is not labeled a provider refund. Unknown charges remain unresolved, not silently zero.
- An unavailable authoritative budget/ledger prevents new budget-governed paid work; stored-data reports remain usable. Document any intentionally unlimited project setting.
- Include generation and extraction calls as well as collection. Initially separate infrastructure estimates from direct API charges rather than pretending to reconcile unavailable line items.
- Display estimated, reserved, spent, and unresolved values and reconcile a pilot ledger to available provider usage evidence.

### B08 — Sample repeatability without overstating coverage

**Story:** As a strategist, I want repeat observations across selected surfaces so I can distinguish a consistent omission from a single unusual answer.

**Owner role:** Backend engineering plus SEO measurement owner. **Reuse:** surface registry, captureScheduler, current availability/provenance contract.

Acceptance criteria:

- Support configurable repetitions, with three as a proposed monitoring default and one explicitly labeled exploratory; validate against budget and run-duration limits.
- Record repetition index, timing policy, requested/actual timestamps, locale/market, provider/access method, and model version when available. Space samples according to the approved capture policy rather than assuming simultaneous outputs are independent.
- Distinguish surfaces from providers and adapters. Switching from a consumer capture to a direct API or another provider creates a different comparison cohort.
- For a fully collected/extracted sample, compute all/some/none observed presence. An incomplete sample cannot receive a “consistently absent” or “consistently present” label over the requested plan.
- A disabled or blocked surface remains visible with a reason. No automatic provider substitution silently changes the measurement claim.

### B09 — Make every displayed number reproducible

**Story:** As an account lead, I want run cards, reports, and exports to use clearly defined metrics so I can defend the figures sent to a client.

**Owner role:** Backend/full-stack engineering. **Reuse:** metrics/core, metrics/period, metrics/reports, scoring, extractionPass.

Acceptance criteria:

- Define one versioned metric contract and reconcile legacy run summaries with normalized mention/citation reports. Any retained difference in scope or formula is explicitly labeled.
- Keep planned, attempted, captured, in-scope, and extracted counts distinct. In a ten-answer fixture with five processed answers, the other five are pending analysis, not five brand absences.
- Derive mentions/citations as an atomic extraction batch or publish a version only after it is complete. A half-written extraction cannot look like a valid negative result.
- Compare compatible prompt revisions, brand sets, surface/access/market settings, and analysis versions. No intersection means no delta; a narrowed intersection shows its size and reason.
- Preserve current-question-set exploration, but provide a frozen historical basis for saved reports. Editing/retiring a prompt or changing an alias does not rewrite a saved client figure.
- UI and export reproduce the same fixture numerators/denominators, rounding, missing states, and source citations. Include a user-readable methodology view/help panel.

### B10 — Improve entity and alias review

**Story:** As a strategist, I want correct brand identities and aliases so unrelated names do not inflate visibility or split one competitor into several entries.

**Owner role:** Full-stack engineering plus SEO reviewer. **Reuse:** project_brands, brandAliases, existing Brands tab and review routes.

Acceptance criteria:

- Show proposed aliases with source evidence and example matches; preserve the existing human approval gate.
- Flag ambiguous/generic aliases and conflicting brand mappings. A person can reject or correct them without losing the proposal's provenance.
- Support reviewed duplicate resolution with a stable canonical brand and versioned mapping. Existing saved reports retain their old measured-set basis.
- Keep publishers, products, concepts, and unreviewed discovered names distinguishable from the approved competitor set; discovery does not automatically change share-of-voice denominators.
- Fixtures cover short names, punctuation, legitimate trading names, unrelated substring matches, and merged competitors.

### B11 — Build an editable, source-backed brand profile

**Story:** As an editor, I want a shared brand profile with traceable claims so every generated brief starts from the client's actual positioning.

**Owner role:** Full-stack engineering plus editorial reviewer. **Reuse:** KB loader/store, project_brands, stored crawl pages.

Acceptance criteria:

- Suggest summary, offerings, audience, voice, differentiators, and claims from a bounded set of existing crawl pages/KB documents. Show source references and extraction date per claim or group.
- Fetch missing source pages only when needed and permitted, using existing URL safety, timeout, and size constraints; expose collection failures and offer manual text entry.
- Separate machine-proposed and human-reviewed values. Re-extraction proposes a new version without overwriting reviewed text.
- Downstream briefs/drafts record the profile and KB versions used. Unsupported claims receive an explicit review flag rather than being presented as verified facts.
- Empty/thin/blocked sites produce useful missing-input states; no authoritative-looking profile is fabricated from the domain name alone.

### B12 — Apply commercial strategy consistently

**Story:** As a strategist, I want audience, objectives, market, intent, and voice to guide content work so recommendations fit the client's business.

**Owner role:** Full-stack engineering plus product/SEO. **Reuse:** project settings and KB completeness patterns.

Acceptance criteria:

- Save versioned audience, business model, buying intents, objectives, planning horizon, market/language, and voice/context references; retain edit history.
- Calculate completeness from stated required fields, not a model's confidence claim. Show exactly which fields are missing.
- A downstream check names the missing inputs that disable it; unrelated checks continue to work.
- Missing GSC does not block a brief or a qualitative intent review. Traffic-based weighting and performance claims remain unavailable until measured data exists.
- Previously generated work remains tied to its original strategy version; changing settings offers explicit regeneration, without silently altering approved content.

## R2 stories

### B13 — Cover questions the current site does not answer

**Story:** As a strategist, I want to add buyer questions about unmet needs so our current page inventory does not define the limits of our growth plan.

**Owner role:** Full-stack engineering plus SEO. **Reuse:** page prompt generation and common review/lifecycle.

Acceptance criteria:

- Keep the existing select-pages generation path. Add topic/opportunity-driven candidates and a validated CSV import path using the same draft review table.
- A new question may have no target page. Store topic, funnel/intent, geography, scope, and proposed new-page/update intent without inventing a URL.
- Detect exact duplicates and flag likely semantic duplicates for review. Imported row errors are downloadable/visible; valid rows do not disappear silently.
- Show a coverage matrix by topic/intent and identify gaps; the user chooses which candidates enter the approved campaign.
- Preview the downstream run size/cost before approval. No automatic measurement follows import/generation.

### B14 — Turn gaps into a prioritized action list

**Story:** As a strategist, I want one explained list of opportunities so I know what to do next and which evidence supports it.

**Owner role:** Full-stack engineering plus SEO. **Reuse:** AI gaps, project findingIndex/backlog, recommendations.fromFinding.

Acceptance criteria:

- Derive overlapping labels for absent-with-competitor, declining, near-top-placement, observed consistent presence, competitive density, and reputation review. Explain each rule and its evidence window.
- Apply repeat/comparability/coverage requirements before issuing a label. Reputation review requires actual scored evidence; unavailable sentiment does not imply neutral or safe.
- “Competitive density” means approved competitors observed in answers; it is not labeled search volume or market demand.
- Each row includes question/topic, source run, evidence links, target page if known, scope, measured counts, proposed action, and why it sorts there. Allow business-priority overrides with rationale.
- Repeated derivation updates the opportunity's evidence without creating duplicate work items or reopening accepted decisions automatically.
- “Create work item” transfers the evidence and permits new page, update, technical fix, or off-site research.

### B15 — Track content work through existing decisions

**Story:** As a team lead, I want accountable work items with owners and review state so measured opportunities become scheduled delivery.

**Owner role:** Full-stack engineering plus product. **Reuse:** recommendations lifecycle and capability checks.

Acceptance criteria:

- Add/link owner, reviewer, due date, target URL, new/update intent, brief/draft references, source opportunity/run, and acceptance notes. Authoritative ownership stays project-scoped.
- Keep approval status separate from production progress: for example planned, brief ready, drafting, in review, ready to publish, published. Do not equate “generated” with “approved.”
- Existing recommendation approval roles, rejection reasons, and material-edit invalidation continue to work. Approval binds the actual content version, not just the work-item title.
- Provide a list/board with owner, status, due-date, and project filters. A simple date view is sufficient for the initial calendar need.
- Duplicate clicks/job retries yield one linked work item. Every state transition retains actor/time and an intelligible history.

### B16 — Generate briefs from the sources behind the gap

**Story:** As an editor, I want the brief to use the sources assistants actually cited so the research responds to measured visibility evidence.

**Owner role:** Backend/full-stack engineering plus editorial. **Reuse:** Article Recommendation generation, KB context, citation reports, existing queue.

Acceptance criteria:

- Extract the reusable brief service from the current request/SSE route; allow both the existing SERP path and the new project work-item path to call it.
- Assemble campaign/question, brand/strategy versions, relevant answers, citation evidence, and optional stored crawl/SERP data. Rank sources by disclosed citation evidence and topical relevance, not an unexplained “authority” score.
- Preserve domain-only citations as domain-only. Any discovered page gets separate provenance and is never mislabeled as the URL the assistant cited. Unreachable sources carry a limitation; no source URL is invented.
- Generate and validate structured objective, intent, audience, angle, heading hierarchy, per-section directives, entity coverage, research links, CTA guidance, and unresolved-claim notes. Image generation is a separate explicit action.
- Store the full brief version and source links durably. Reopening after reload/restart works; retrying a completed job does not silently buy another generation.
- Reusing stored visibility evidence causes no fresh visibility capture. Any extra source search/fetch or LLM generation is disclosed and budgeted.
- An editor can revise and approve the brief; source/context changes create a new version. Review quality against the pilot brief acceptance rubric.

### B17 — Draft, review, and preserve content versions

**Story:** As an editor, I want a draft based on an approved brief with preserved versions so changes are reviewable and recoverable.

**Owner role:** Full-stack engineering plus editorial. **Reuse:** current enhancement services and Location Page Builder version/approval patterns through adapters.

Acceptance criteria:

- Generate from an explicitly selected approved brief version. Store title, description, heading structure, body, language, sources, generation settings, and version number.
- Validate required brief sections, heading hierarchy, and source references; report omissions and unsupported claims for review. Do not imply an LLM check proves factual accuracy.
- Honor generation flags: an image-disabled request makes no image call and incurs no image charge. Treat title/description lengths as configurable editorial guidance, not universal ranking guarantees.
- Save/edit/reload and version comparison work with optimistic concurrency. Restoring content creates a new version and retains the old history.
- Approval names the reviewer and exact version. A material edit requires renewed approval; generation never publishes externally.
- Export approved or draft content with its state visible. Existing location-specific workflows remain usable while sharing the compatible artifact/approval contract.

### B18 — Record publication and close the measurement loop

**Story:** As an account lead, I want to record what went live and schedule a comparable recheck so delivery can be evaluated.

**Owner role:** Full-stack engineering. **Reuse:** recommendation shipped date, module schedules, campaign revisions.

Acceptance criteria:

- Record the published URL, timestamp, approved content version, responsible person, and optional deployment evidence. Manual publication recording works without a CMS connector.
- Saving publication does not assert that a live fetch matches; an optional bounded verification records match/mismatch/unavailable separately.
- Associate the pre-publication baseline and configured follow-up campaign. Display the date/cadence and estimated cost; do not immediately trigger an uncontrolled chain of paid runs.
- A changed question/model/market configuration explains why the follow-up is not directly comparable. Allow an explicitly labeled new baseline.
- The item shows pending, collected, comparable, or inconclusive follow-up status. An external publish retry cannot produce duplicate publication events.

### B19 — Save reports that retain their meaning

**Story:** As an account lead, I want a stable report showing evidence and delivered work so the figures remain trustworthy after the team edits settings.

**Owner role:** Full-stack engineering plus account lead. **Reuse:** project XLSX report and existing AI report builders.

Acceptance criteria:

- Snapshot project/period/filter/cohort/version IDs, metric payload, missing-data notes, relevant evidence links, and delivery status when saving a report.
- Include visibility, opportunities/actions, technical coverage, published work, and follow-up status as selected sections; missing sections state what is unavailable.
- The app and first export format (existing XLSX) use the same snapshot payload. Reopening a report after campaign/alias/strategy edits preserves its values.
- Report generation reads stored evidence and makes no collection/generation purchase. A separately requested narrative generation, if later added, must be separately budgeted.
- A new reanalysis/report is distinguishable from the original. Export access is project-authorized and does not expose credentials or another client's artifacts.

## R3 stories

### B21 — Reuse crawl evidence and explain diagnostic coverage

**Story:** As a technical SEO specialist, I want diagnostics to share the same stored crawl evidence so counts agree and we do not fetch pages unnecessarily.

**Owner role:** Backend engineering. **Reuse:** CrawlScope results/links, crawlToArchitect, per-page module evidence, on-page and SEO/GEO auditors.

Acceptance criteria:

- Define a shared page-evidence input containing crawl/run ID, URL/final URL, fetch method/time/status, available content/metadata, and completeness flags. Adapt selected audit checks to it.
- Reuse available evidence; checks needing a live or rendered fetch state that need and record a separate fetch rather than implicitly re-crawling the site.
- Preserve confirmed broken, access-blocked, rate-limited, robots-denied, transient failure, and unknown states; an ambiguous HTTP status is not assigned an unsupported cause.
- Every diagnostic area reports evaluated/eligible/omitted counts and reasons. Resource, page, template, and performance-sample denominators may differ but cannot be silently interchanged.
- Separate raw versus rendered schema evidence and field versus lab performance, including URL/origin granularity. Partial crawl link analysis cannot assert complete orphan coverage.
- Retain existing run history and links; rebuilding a derived report from stored evidence does not initiate another crawl.

### B22 — Add an editorial rubric with honest applicability

**Story:** As an editor, I want content findings appropriate to the page type and available evidence so an informational article is not penalized for failing to behave like a sales page.

**Owner role:** Backend/full-stack engineering plus editorial. **Reuse:** pageTypeDetector, existing manual states, SEO/GEO findings, brand/strategy context.

Acceptance criteria:

- Classify page type with an editable override and record the source of the classification. A 404/error page short-circuits editorial scoring and produces the blocking technical finding.
- Evaluate intent alignment, voice, conversion, positioning, natural language, editorial quality, clarity, structure, and claim support only when applicable. Show unavailable/not applicable separately from a poor grade.
- Commercial dimensions require a commercial page; voice requires reviewed voice/context; traffic-weighted intent requires search evidence. A qualitative intent review can use an approved target without GSC but is labeled accordingly.
- Every finding carries provenance (deterministic/model/human), evidence/span, severity, dimension, applicability, source version, and action type: advice, passage proposal, or human verification.
- Technical and editorial results retain distinct methodologies. Unverifiable factual claims are not marked accurate merely because a model found them plausible.
- Validate on a reviewed set spanning article, service/location, product, thin, inaccessible, and error pages; product/editorial owners review disagreement cases before pilot exposure.

### B23 — Suggest bounded passage changes

**Story:** As an editor, I want a precise proposed change for a finding so I can review what changes without losing meaning or approved claims.

**Owner role:** Full-stack engineering plus editorial. **Reuse:** article enhancement services, draft versions, finding contract.

Acceptance criteria:

- Anchor a proposal to an exact span plus source-version/hash. If the passage changed, reject application and request a new proposal rather than replacing a similar-looking fragment.
- Show current/proposed text and a word-level diff. Changes outside the authorized span are rejected.
- Human-verification findings cannot enter automatic rewriting. Check preservation of entities, numbers, qualifications, links, and CTAs; flag semantic uncertainty for a person rather than claiming automated guarantees.
- Accept/discard/revise actions create a versioned decision; acceptance produces a draft version and invalidates any approval of materially different content.
- Applying the same accepted proposal twice is idempotent; exports clearly indicate approval state.

### B24 — Bring in authorized search performance

**Story:** As a strategist, I want actual client search performance alongside visibility evidence so priority can reflect observed traffic exposure.

**Owner role:** Backend/full-stack engineering plus client lead. **Reuse:** project permissions, Google auth dependencies, integration-settings patterns.

Acceptance criteria:

- Connect an authorized Search Console property with read-only access; validate its relationship to the project domain. Credentials are encrypted at rest and are absent from browser responses, reports, and logs.
- Ingest an initial bounded history and incremental page/query/date/device/country data where available; persist cursors, ingestion runs, freshness, and source granularity.
- Repeated imports are idempotent. Aggregate clicks/impressions before deriving CTR, retain the documented meaning of position, and avoid assuming query-level rows reproduce all property totals.
- Handle revoked access, empty data, quota errors, lag, and partial retrieval explicitly. Map URLs conservatively and report unmapped traffic.
- Disconnect prevents future collection; authorized retention/deletion behavior is stated. Missing GSC keeps AI/content features operational without fake traffic multipliers.

### B25 — Explain what changed after delivery

**Story:** As an account lead, I want a before/after view of shipped work so I can report observed outcomes and decide what to do next.

**Owner role:** Full-stack engineering plus analytics/SEO. **Reuse:** campaign comparisons, publication records, GSC facts, report snapshots.

Acceptance criteria:

- Show approved change, publication date, baseline window, follow-up window, and question/page cohort alongside visibility and available search metrics.
- Use compatible cohorts; surface provider/model, campaign, geography, extraction, and page-mapping changes. Missing comparable data produces “inconclusive,” not zero improvement.
- AI outcomes can be evaluated without GSC. Search metrics appear only after authorized ingestion and sufficient data.
- Show observed deltas with sample sizes and annotations for concurrent changes/seasonality; do not label a correlation as incremental revenue or caused uplift.
- Save the outcome assessment into a new report/work-item history event, preserving earlier snapshots and the analyst's interpretation.

### B26 — Schedule useful checks and control alert noise

**Story:** As a strategist, I want recurring measurement and a small actionable inbox so I can notice meaningful changes without repeatedly opening every project.

**Owner role:** Backend/full-stack engineering plus product/SEO. **Reuse:** moduleScheduler, moduleQueue, existing notification integrations where relevant.

Acceptance criteria:

- Configure cadence, timezone, campaign revision, budget, and next-run date; show estimated monthly work/spend and pause/resume controls.
- A schedule advances atomically and cannot enqueue duplicates across scheduler replicas. Missed runs, worker delays, and budget stops are visible.
- Detect changes only on compatible, sufficiently covered cohorts. Require a documented persistence/confirmation rule and configurable threshold; a one-off failed capture is not a reputation alert.
- Deduplicate alerts by project/campaign/rule/evidence window; support dismiss/snooze and an explanation linking underlying answers.
- Start with an in-app inbox. Email/Slack delivery is optional configuration with explicit recipients and test controls; creating this backlog does not send messages.

### B27 — Turn cited domains into research tasks

**Story:** As a strategist, I want to identify relevant external sources influencing answers so I can investigate earned-coverage opportunities.

**Owner role:** Full-stack engineering plus SEO/PR reviewer. **Reuse:** Sources reports, citation classification, work items.

Acceptance criteria:

- Rank external sources by distinct citing answers/questions/surfaces over a stated period, with topical filters and raw evidence links. Deduplicate repeated references within the defined denominator.
- Distinguish own, reviewed competitor, publisher, and other sources. A domain-only citation cannot become a fabricated page-level target.
- Do not infer whether the external page mentions the client from the assistant answer alone; use a separately recorded page observation or show “not checked.”
- Create an assigned research/outreach work item with rationale and source evidence; record subsequently obtained public coverage URLs manually.
- No placement purchasing or automatic outreach is part of this story. Existing backlink data can enrich research only with source/date/cost clearly identified.

## Later stories and decision triggers

### B28 — Migrate the remaining legacy stores

**Story:** As the operator, I want remaining durable client state under a supported persistence model so storage is manageable across deployment and team growth.

**Trigger:** B01 shows unsafe persistence, file contention, recovery difficulty, or a core user journey depends on these stores. **Owner:** Backend/operations.

Acceptance criteria:

- Select the first tranche from Competitor Analysis, Content Architect, on-page audits, robots monitoring, and Market Potential based on measured risk and usage; confirm Location Page Builder's in-progress migration status.
- Preserve each module API through adapters, add explicit project mapping/scoping, and use paginated imports/reads with counts/checksums and idempotency.
- Cut over one store at a time with a tested rollback and a single authoritative writer. Ambiguous client records remain recoverable for review.
- Re-estimate remaining modules after the first migration; do not assume their different sidecar/history shapes cost the same.

### B29 — Add a justified measurement surface

**Story:** As a strategist, I want a requested additional assistant/search surface when it provides reliable evidence relevant to our clients.

**Trigger:** Pilot demand and a successful bounded provider feasibility study. **Owner:** Backend plus measurement owner.

Acceptance criteria:

- Establish supported access method, market, citation fidelity, model visibility, operational constraints, unit cost, and success rate before committing the adapter.
- Implement the existing surface contract and fixtures; preserve raw/normalized evidence and distinguish absence, no answer, blockage, and failure.
- Add the surface as a new explicit cohort with availability and budget controls; do not merge its history with another method/provider.
- Reject or defer an adapter that fails the pilot reliability/evidence gate. The 3–5 day estimate is per integration after feasibility, not a promise for unknown acquisition work.

### B30 — Extract recurring sections and concepts

**Story:** As an editor, I want a summary of recurring answer topics so I can assess brief coverage quickly.

**Trigger:** Editors repeatedly assemble this manually. **Owner:** Backend/editorial.

Acceptance criteria:

- Derive suggestions from stored eligible answers, with frequency denominators and links to examples; keep organizations distinct from concepts/products.
- Cluster near-duplicate suggestions but preserve examples and the analysis version. A generated heading is labeled a suggestion, not an observed verbatim quotation.
- Feed suggestions into the editable brief; weak evidence cannot become a compulsory section automatically.

### B31 — Calibrate sentiment and perception themes

**Story:** As an account lead, I want reviewed sentiment signals so negative narratives can be investigated without treating model guesses as facts.

**Trigger:** Sufficient client demand and a human-labeled evaluation set. **Owner:** Measurement/SEO plus engineering.

Acceptance criteria:

- Evaluate the existing optional extraction on a representative labeled set, proposed minimum 100 captures, including neutral directory listings, negation, mixed sentiment, and ambiguous brand references.
- Set and document release thresholds for precision/disagreement before enabling client-facing alerts; retain reviewer examples and error analysis.
- Display scored/eligible counts, evidence snippets, and unscored states. Cluster similar themes without erasing distinct evidence.
- Version analysis and meter its cost; failed calibration keeps the feature internal/experimental rather than implying neutrality.

### B32 — Hand off an approved draft to a CMS

**Story:** As an editor, I want an approved content version delivered to the client's CMS draft area so I can finish publication in the client's normal workflow.

**Trigger:** Manual export is a demonstrated bottleneck; choose one CMS first. **Owner:** Integration engineering/editorial.

Acceptance criteria:

- Bind credentials and destination to a project with appropriate permissions; show destination and exact version before handoff.
- Create/update a CMS draft with metadata and source/version linkage; use idempotency to avoid duplicate posts.
- Preserve formatting through a round-trip acceptance fixture and handle credential/validation failures without marking publication complete.
- Public publication requires a separate explicit workflow decision. A CMS draft handoff records an external draft ID, not a false published event.

### B33 — Improve portfolio reporting when usage warrants it

**Story:** As an account director, I want a portfolio view of delivery and measurement quality so I can direct attention across clients.

**Trigger:** Several projects actively complete the core workflow. **Owner:** Full-stack/product.

Acceptance criteria:

- Show per-project freshness, coverage, blocked work, due approvals, and delivered items, respecting workspace permissions.
- Do not average unlike module scores or compare clients with different question cohorts as if they share a benchmark.
- Add the export format most requested in the pilot using saved report payloads; validate layout and data parity. Do not build a configurable widget system by default.

## Cross-story release checks

These checks supplement each story's criteria and should be attached to the affected implementation tickets:

- **Permissions:** server-side project isolation for reads, writes, jobs, evidence, downloads, and integrations; existing approval roles continue to apply.
- **Durability:** reload/restart recovery, failed-save messaging, idempotent retry, version conflict, backup restoration, and import reconciliation.
- **Evidence:** source IDs and versions survive the path from question/crawl to finding, work item, brief, draft, publication, and report.
- **Measurement:** missing/partial/unknown states remain distinguishable; identical snapshots yield identical values; changed methodology is disclosed.
- **Operations:** bounded timeouts/retries, cancellation, worker-lease checks, capacity limits, and reconciled metered usage.
- **Usability:** pilot users can complete the story's task with keyboard-accessible controls and clear empty/progress/failure states; implementation details stay in operator views.

Before committing a sprint, split any story that cannot be demonstrated within the sprint into independent outcomes while retaining its parent ID and acceptance scope. Review every two weeks against pilot evidence, not the number of completed tickets.
