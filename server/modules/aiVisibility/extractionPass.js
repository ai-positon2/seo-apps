// ── Extraction: turning a stored answer into countable rows ─────────────
//
// Not `extract.js` — that name is taken by the provider-response reader that
// pulls answer text and sources out of a DataForSEO payload. This is the
// layer above it: it reads an answer we have already STORED and turns it into
// mention, citation and attribute rows.
//
// METRICS.md §2 is explicit that extraction happens AT INGEST, never at query
// time. Two reasons, and both are about trust rather than speed:
//
//   • A metric must be reproducible from stored rows months later (§11). If
//     the numbers were derived at read time, every rule change would silently
//     rewrite every past period.
//   • The LLM pass costs money per capture. Running it per page view would
//     make the cost of a report proportional to how often it is looked at.
//
// The order is fixed and the reason is §2.1: the DETERMINISTIC matcher decides
// which brands were named, and the LLM only scores and flags what it is given.
// A model deciding membership would make the headline number unreproducible
// between two runs over the same answer.
//
// Nothing here throws for one bad capture. A capture that cannot be extracted
// stays pending (`extracted_at` is left null) rather than being marked done
// with nothing behind it — so a fixed bug means a re-run picks it back up.

const store = require('./store');
const mentionExtract = require('./captureEngines/mentionExtract');
const llmExtract = require('./captureEngines/llmExtract');
const domainClassify = require('./captureEngines/domainClassify');

/** Everything the extraction pass stamps on a capture, in one place. */
// m2, not m1. The mention matcher changed twice in ways that move a number:
//
//   • prose ordinals are numbered from the LAST MAP CARD, not from the count of
//     cards we matched — so a brand mentioned only in prose after 30 cards now
//     ranks 31st where it used to rank 2nd, and §3.5's mean position moves with
//     it
//   • map-card names match on whole words, not raw substring, so a generic
//     alias no longer claims an unrelated business's rank
//
// Leaving the tag at m1 would let rows produced by both rulesets claim the same
// classifier, and §11 requires a past period to stay reproducible under the
// rules that produced it. Rows already stamped m1 keep it: they were computed
// the old way and now say so.
const EXTRACTION_VERSION = `m2+c${domainClassify.RULESET_VERSION}+l${llmExtract.EXTRACTION_VERSION}`;

/**
 * Map cards, if this capture has them.
 *
 * Card order is the ranking in a local answer, and every client here is a local
 * business. Reading only the prose would record a practice sitting in a map
 * card on screen as absent — the failure mode that would have corrupted the
 * headline metric product-wide.
 */
function mapCardsOf(capture) {
  const cards = capture?.raw?.mapCards || capture?.mapCards;
  if (!Array.isArray(cards)) return [];
  return cards
    .filter((c) => c && c.name)
    .map((c, i) => ({ name: c.name, position: c.position ?? i + 1 }));
}

/**
 * Classify a capture's citations for storage.
 *
 * The adapters set `domain` to the host minus `www`, which is the HOST not the
 * registrable domain — `adanews.ada.org` would never roll up to `ada.org` in
 * the Domains report. Re-derive here so both columns mean what §5.1 says.
 *
 * `isRetrieved` is true for everything we can see, and that is a limit worth
 * stating: a scraped surface shows only the sources it chose to display, so
 * "retrieved but not surfaced" is unobservable to us. §5's retrieval metrics
 * are therefore a floor, not a total.
 */
function classifyCitations(citations, sets) {
  const out = [];
  const seen = new Set();

  for (const c of citations || []) {
    const info = domainClassify.classifyCitation(
      { url: c.url, host: c.host || c.domain, title: c.title },
      sets,
    );
    if (!info.host || !info.domain) continue;

    // 0018 makes (capture_id, coalesce(url, host)) unique; collapsing here
    // means a duplicate merges its count instead of failing the whole insert.
    const key = info.url || info.host;
    const existing = seen.has(key) ? out.find((r) => (r.url || r.host) === key) : null;
    if (existing) {
      existing.occurrences += c.occurrences || 1;
      existing.isInlineCited = existing.isInlineCited || Boolean(c.isInlineCited);
      continue;
    }
    seen.add(key);

    out.push({
      url: info.url,
      host: info.host,
      domain: info.domain,
      title: c.title || null,
      isInlineCited: Boolean(c.isInlineCited),
      isRetrieved: true,
      position: typeof c.index === 'number' ? c.index : null,
      occurrences: c.occurrences || 1,
      urlType: info.urlType,
      domainType: info.domainType,
      rulesetVersion: info.rulesetVersion,
    });
  }
  return out;
}

/**
 * Extract one capture and persist its entity rows.
 *
 * @param {object} input
 * @param {object} input.access   project access context
 * @param {object} input.capture  a captureView row (needs `id` and `answerText`)
 * @param {Array}  input.brands   the APPROVED measured set (store.measuredSet)
 * @param {object} [input.prompt] the prompt row, for the geography check
 * @param {boolean} [input.useLlm=true]
 * @returns {Promise<{captureId, mentions, citations, offGeo, llmError, skipped}>}
 */
async function extractCapture({
  access, capture, brands = [], prompt = null, useLlm = true,
}) {
  const projectId = access.project.id;
  const result = {
    captureId: capture.id,
    mentions: 0,
    citations: 0,
    offGeo: false,
    llmError: null,
    proposed: [],
    skipped: null,
  };

  // A failed capture has no answer to read. It is still marked extracted, or it
  // would sit in the pending queue forever being retried at cost — and the
  // absence of mention rows is correct: §16.11's `mentioned: null` already
  // records that nothing was measured, and no entity row asserts otherwise.
  if (capture.status !== 'captured' || !capture.answerText) {
    await store.markExtracted({ captureId: capture.id, version: EXTRACTION_VERSION });
    result.skipped = capture.status !== 'captured' ? 'not_captured' : 'no_answer_text';
    return result;
  }

  // 1. Deterministic: which brands were named.
  const mentions = mentionExtract.extractMentions({
    answerText: capture.answerText,
    brands,
    mapCards: mapCardsOf(capture),
  });

  // 2. Confirming pass: sentiment, negation, geography. Never blocks storage —
  //    an unscored mention is a mention, and sentiment stays null.
  let scored = mentions.map((m) => ({ ...m, sentiment: null, negated: false }));
  if (useLlm && mentions.length) {
    const pass = await llmExtract.scoreMentions({
      answerText: capture.answerText,
      mentions,
      prompt: capture.prompt || prompt?.text || '',
      location: prompt?.location || null,
    });
    scored = pass.mentions;
    result.offGeo = pass.offGeo;
    result.llmError = pass.error;
    result.proposed = pass.proposed;
  }

  // 3. Citations, classified as of ingest so past periods stay reproducible.
  const sets = {
    clientDomains: brands.filter((b) => b.isClient).map((b) => b.domain).filter(Boolean),
    competitorDomains: brands.filter((b) => !b.isClient).map((b) => b.domain).filter(Boolean),
  };
  const citations = classifyCitations(capture.citations, sets);

  // 4. Persist, THEN stamp. A crash between the two leaves the capture pending,
  //    which a re-run corrects; the reverse would lose the rows silently.
  // In parallel: they are independent tables and each was costing its own
  // round trip per capture. markExtracted stays strictly after both — the
  // stamp is what says "this capture has rows", and writing it first would
  // leave a crash looking like a completed extraction with nothing behind it.
  await Promise.all([
    store.saveMentions({ projectId, captureId: capture.id, mentions: scored }),
    store.saveCitations({ projectId, captureId: capture.id, citations }),
  ]);
  // `features` is deliberately not passed: it was written at capture time and
  // markExtracted only overwrites when given a value. Passing the row's own
  // value back would be harmless; passing null would erase it.
  await store.markExtracted({
    captureId: capture.id,
    version: EXTRACTION_VERSION,
    offGeo: result.offGeo,
  });

  result.mentions = scored.length;
  result.citations = citations.length;
  return result;
}

/**
 * Work the pending queue for one project.
 *
 * Serial on purpose: the LLM pass is one call per capture and a burst of
 * parallel calls buys a rate-limit failure across the whole batch instead of a
 * slower batch that finishes.
 *
 * Returns per-capture outcomes rather than a bare count, because "extracted 40"
 * and "extracted 40, 38 of them unscored because the key expired" are very
 * different results and only one of them is fine.
 */
async function extractPending({
  access, limit = 50, useLlm = true, brands = null, maxBatches = 20,
} = {}) {
  const projectId = access.project.id;
  const measured = brands || await store.measuredSet(projectId);

  const summary = {
    considered: 0, extracted: 0, skipped: 0, failed: 0, unscored: 0, proposed: [], errors: [],
  };

  // With no approved brands there is nothing to measure against. Extracting
  // anyway would stamp every capture as done with zero mentions, and those
  // stamps would read as measured absences forever after.
  if (!measured.length) {
    summary.errors.push({ code: 'no_measured_set', message: 'No approved brands for this project.' });
    return summary;
  }

  // Keep going until nothing is pending.
  //
  // capturesPendingExtraction orders OLDEST first, so a single batch against a
  // backlog extracts old captures and leaves the ones just measured. The run
  // that paid for those then reports "extracted: 25", looks successful, and its
  // own answers stay uncounted and invisible in every report.
  //
  // `limit` is the BATCH size; `maxBatches` bounds the total so a large
  // backlog cannot turn one run into an unbounded job. A batch that fails
  // every row would otherwise loop for ever, since nothing gets stamped — so
  // a batch making no progress ends the pass.
  // Ids tried in this pass. A capture that throws is left unstamped on
  // purpose, so it comes back in the next fetch — without this it would be
  // retried every batch, and `considered` and `failed` would count the same
  // row up to maxBatches times.
  const attempted = new Set();

  for (let batch = 0; batch < maxBatches; batch += 1) {
    // eslint-disable-next-line no-await-in-loop
    const fetched = await store.capturesPendingExtraction(projectId, {
      limit,
      // Skip what this pass has already tried. Without it a batch that all
      // failed came back as the oldest rows for ever and nothing newer was
      // ever reached.
      excludeIds: [...attempted],
    });
    const pending = fetched.filter((c) => !attempted.has(c.id));
    if (!pending.length) break;
    pending.forEach((c) => attempted.add(c.id));
    summary.considered += pending.length;

    for (const capture of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await extractCapture({
          access, capture, brands: measured, useLlm,
        });
        if (r.skipped) summary.skipped += 1;
        else summary.extracted += 1;
        if (r.llmError) summary.unscored += 1;
        for (const p of r.proposed) {
          if (!summary.proposed.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) {
            summary.proposed.push(p);
          }
        }
      } catch (e) {
        // Left pending deliberately — a re-run picks it back up once fixed.
        summary.failed += 1;
        summary.errors.push({ captureId: capture.id, message: e.message });
      }
    }

    if (fetched.length < limit) break;
  }

  return summary;
}

module.exports = {
  EXTRACTION_VERSION,
  mapCardsOf,
  classifyCitations,
  extractCapture,
  extractPending,
};
