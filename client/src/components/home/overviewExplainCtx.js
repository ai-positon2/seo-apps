// ── The overview's figures, for the header stats and the info icons ─────────
//
// ProfileStats prints these, and the info icons and legend explain them with
// worked examples. Both read this one function, so an explanation can never
// quote a different count from the number printed beside it.

/**
 * @param {object} params
 * @param {object} params.composite  overview.composite
 * @param {Array}  params.modules    overview.modules (every module, carded or not)
 * @param {object?} params.insights  the insight layer's answer, or null
 */
export function overviewExplainCtx({ composite, modules = [], insights }) {
  // ── To fix ──────────────────────────────────────────────────────────────
  const totals = insights?.backlog?.totals || null;
  const toFix = Number.isFinite(totals?.actions)
    ? { actions: totals.actions, templateWide: totals.templateWide || 0 }
    : null;

  // ── Pages crawled ───────────────────────────────────────────────────────
  //
  // The crawl's own internal-page count, from the same field the Tech Audit card
  // and the crawl report divide by. Read from the module rather than recounted,
  // or the header and the card would eventually publish two figures for one
  // crawl — the single most damaging thing this dashboard can do to itself.
  //
  // Labelled "crawled", not "audited": the page-level modules score a selection
  // of these, so calling it audited would overstate what ran.
  //
  // The fallback matters more than it looks. While a crawl is running the Tech
  // Audit card drops its evidence block on purpose — the previous crawl's counts
  // printed on a card about this one get misread — so reading only that field
  // made this stat say "no completed crawl yet" about a client that has crawled
  // every week for a month, for as long as a crawl was in flight. The insight
  // layer counts the last TERMINAL crawl, through the same helper, so it is the
  // right thing to fall back to and cannot disagree with the card.
  const technical = modules.find((m) => m.key === 'technical') || null;
  const cardPages = Number.isFinite(technical?.evidence?.pagesCrawled)
    ? technical.evidence.pagesCrawled
    : null;
  const storedPages = Number.isFinite(totals?.crawledPages) ? totals.crawledPages : null;

  // ── Coverage ────────────────────────────────────────────────────────────
  // "Has this module produced anything for this client", which is not the same
  // question as "did it score" — Hub and Spoke reports findings and has no
  // rubric, and counting it as uncovered would be wrong.
  const neverRun = modules.filter((m) => m.status === 'not_run');

  return {
    modules,
    composite,
    toFix,
    technical,
    cardPages,
    pagesCrawled: cardPages === null ? storedPages : cardPages,
    neverRun,
    coverage: { covered: modules.length - neverRun.length, total: modules.length },
  };
}
