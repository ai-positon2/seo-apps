const { estimateDomainCost, MAX_UNITS_PER_RUN } = require('./unitCosts');
const { getProvider, hasSemrushKey } = require('./provider');
const { getDatabase } = require('../../utils/countryToDatabase');
const gap = require('./gapAnalysis');
const pageSpeedCA = require('../../services/pageSpeedCA');

const MAX_HISTORY_POINTS = 12;

// PageSpeed Insights is free but slow (~10-30s per domain) and Lighthouse
// scores don't meaningfully shift day to day, so a fetched result is reused
// for a week before being refreshed rather than re-run on every analysis.
const PAGE_SPEED_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// Only runs against the real provider — the mock provider already produces
// its own synthetic pageSpeed data (see mockProvider.js), and PSI has its
// own independent quota/latency that shouldn't apply to simulated runs.
// Fetches every stale domain in parallel (bounded by the slowest single
// domain, not the sum) rather than folding into the per-domain SEMrush loop
// below, which is intentionally sequential for its own unit-budget guard.
// `skipFetch` carries forward whatever's cached with zero live PSI calls —
// used by the main run, which must never block on Page Speed (see below).
async function resolvePageSpeed(domainEntries, previousSnapshot, { force = false, skipFetch = false } = {}) {
  const now = Date.now();
  const prevByDomain = new Map(
    (previousSnapshot?.domains || [])
      .filter((d) => d.pageSpeed && d.pageSpeedFetchedAt)
      .map((d) => [d.domain, d])
  );
  const stale = force
    ? domainEntries.map((e) => e.domain)
    : domainEntries.map((e) => e.domain).filter((domain) => {
        const prev = prevByDomain.get(domain);
        return !prev || (now - new Date(prev.pageSpeedFetchedAt).getTime()) > PAGE_SPEED_CACHE_MS;
      });

  const enabled = !!process.env.GOOGLE_PSI_API_KEY;
  const freshResults = (!skipFetch && enabled && stale.length) ? await pageSpeedCA.getPageSpeedForAllDomains(stale) : [];
  const freshByDomain = new Map(freshResults.map((r) => [r.domain, r]));

  return (domain) => {
    if (freshByDomain.has(domain)) return { data: freshByDomain.get(domain), fetchedAt: new Date(now).toISOString() };
    const prev = prevByDomain.get(domain);
    return prev ? { data: prev.pageSpeed, fetchedAt: prev.pageSpeedFetchedAt } : { data: null, fetchedAt: null };
  };
}

// Refreshes ONLY the pageSpeed field on an existing snapshot's domains —
// spends zero SEMrush units, since it never touches the provider.
async function applyPageSpeedRefresh(previousSnapshot, resolveOpts) {
  if (!previousSnapshot || !previousSnapshot.domains?.length) {
    throw new Error('Run a full analysis first — there is no existing data to attach Page Speed results to.');
  }
  const domainEntries = previousSnapshot.domains.map((d) => ({ domain: d.domain }));
  const pageSpeedFor = await resolvePageSpeed(domainEntries, previousSnapshot, resolveOpts);
  const domains = previousSnapshot.domains.map((d) => {
    const ps = pageSpeedFor(d.domain);
    return { ...d, pageSpeed: ps.data, pageSpeedFetchedAt: ps.fetchedAt };
  });
  return { ...previousSnapshot, domains };
}

// Used by the Page Speed tab's own explicit "Refresh" button — always forces
// a fresh PSI fetch, ignoring the 7-day cache, since that's the point of an
// explicit manual refresh.
function refreshPageSpeedOnly(client, previousSnapshot) {
  return applyPageSpeedRefresh(previousSnapshot, { force: true });
}

// Automatic companion to a main run: fires right after "Run Analysis"
// finishes. Only refetches domains whose cached Page Speed is missing or
// stale — since this now runs after every analysis, it must NOT multiply PSI
// call volume the way a forced refetch would.
function refreshStalePageSpeed(client, previousSnapshot) {
  return applyPageSpeedRefresh(previousSnapshot, {});
}

function appendHistory(previousSnapshot, newSnapshot) {
  const history = (previousSnapshot && Array.isArray(previousSnapshot.history)) ? previousSnapshot.history.slice() : [];
  history.push({
    capturedAt: newSnapshot.capturedAt,
    domains: newSnapshot.domains.map((d) => ({ domain: d.domain, organicTraffic: d.domainRank.organicTraffic, organicKeywords: d.domainRank.organicKeywords })),
  });
  return history.slice(-MAX_HISTORY_POINTS);
}

// Second-level labels that are part of a public suffix ("co.uk", "com.au"),
// so the brand stem of "argos.co.uk" is "argos", not "co".
const SUFFIX_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ltd', 'plc']);

// The registrable name of a domain: "www.footlocker.com" -> "footlocker".
function domainStem(domain) {
  const host = String(domain || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '').replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 1) return labels[0] || '';
  let i = labels.length - 2;
  if (i > 0 && SUFFIX_LABELS.has(labels[i]) && labels[labels.length - 1].length === 2) i -= 1;
  return labels[i];
}

// The term a domain's branded keywords are counted against. Each domain is
// measured against ITS OWN brand: every competitor used to be counted
// against the client's brand name, so Foot Locker's "branded" keywords were
// the ones containing "nike". The client uses its configured brand name; a
// competitor uses its label when that is a name ("Foot Locker"), otherwise
// its domain stem ("footlocker").
function brandTermFor(entry, client) {
  if (entry.isClient && client?.brandName && String(client.brandName).trim()) {
    return String(client.brandName).trim();
  }
  const label = String(entry.label || '').trim();
  const labelIsDomain = !label || /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\/?$/i.test(label);
  return labelIsDomain ? domainStem(entry.domain) : label;
}

// Runs the pipeline for one client. Provider-agnostic budget guard: stops
// fetching new domains the moment the next one would push cumulative
// estimated spend over the hard per-run cap (client is always fetched
// first, so it's never the one skipped).
async function fetchClientDashboardData(client, previousSnapshot, capUnits = MAX_UNITS_PER_RUN) {
  const domainEntries = [
    { domain: client.domain, label: client.name, isClient: true },
    ...client.competitors.map((c) => ({ domain: c.domain, label: c.label, isClient: false })),
  ];

  const provider = getProvider();
  const database = getDatabase(client.country);
  const perDomainCost = estimateDomainCost();
  const ctx = provider.createRunContext(domainEntries.map((d) => d.domain));

  const fetched = [];
  const skipped = [];
  let usedUnits = 0;

  const useLive = hasSemrushKey();
  // Page Speed is deliberately NOT fetched here. Real PSI calls are slow
  // (with the reliability fix's retry/backoff, up to minutes when rate
  // limited) and must never block Overview/Backlinks/Content Analysis. This
  // only carries forward whatever is already cached on the previous
  // snapshot; the actual refresh runs as an independent background job
  // right after this run finishes (frontend chains into POST
  // /run-pagespeed once this run's status is 'done' — see routes.js).
  const pageSpeedFor = useLive ? await resolvePageSpeed(domainEntries, previousSnapshot, { skipFetch: true }) : null;

  for (const entry of domainEntries) {
    if (usedUnits + perDomainCost > capUnits) {
      skipped.push(entry.domain);
      continue;
    }
    const raw = await provider.fetchDomainData(entry.domain, ctx, { database, brandName: brandTermFor(entry, client) || null });
    usedUnits += perDomainCost;
    const ps = useLive ? pageSpeedFor(entry.domain) : { data: raw.pageSpeed, fetchedAt: null };
    fetched.push({
      ...raw,
      label: entry.label,
      isClient: entry.isClient,
      keywordBuckets: gap.computeKeywordPositionBuckets(raw.keywords),
      pageSpeed: ps.data,
      pageSpeedFetchedAt: ps.fetchedAt,
    });
  }

  const clientDomain = fetched.find((d) => d.isClient);
  const competitorDomains = fetched.filter((d) => !d.isClient);

  const keywordGap = clientDomain
    ? gap.computeKeywordGap(clientDomain.keywords, competitorDomains.map((d) => ({ domain: d.domain, keywords: d.keywords })))
    : { strikingDistance: [], untapped: [], missing: [] };

  const keywordDetailTable = gap.computeKeywordDetailTable(fetched.map((d) => ({ domain: d.domain, keywords: d.keywords })));

  const snapshot = {
    capturedAt: new Date().toISOString(),
    usedUnits,
    capUnits,
    skipped,
    domains: fetched,
    keywordGap,
    keywordDetailTable,
  };
  snapshot.history = appendHistory(previousSnapshot, snapshot);

  return snapshot;
}

module.exports = { fetchClientDashboardData, refreshPageSpeedOnly, refreshStalePageSpeed, brandTermFor, domainStem };
