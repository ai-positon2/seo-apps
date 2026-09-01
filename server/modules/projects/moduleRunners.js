// ── Running a module against a project (PRD phase 3) ─────────────────────────
//
// One runner per module. Each does exactly three things:
//
//   1. Works out what to measure from the PROJECT — its primary domain and its
//      country — instead of asking the user to paste a URL. That is the whole
//      point of a project: the target is already known.
//   2. Calls the module's own extracted service. No module logic is
//      reimplemented here; if a score exists, it is the module's score, computed
//      by the module's code (PRD §6.2, §32).
//   3. Normalises the result into findings + an optional score for
//      moduleEvidence, which stores it against the project.
//
// What is deliberately NOT here: any fallback that invents a number when a
// module fails or returns nothing. A failed run is recorded as failed, and a run
// with nothing to measure is recorded as 'insufficient_data'. Both render as an
// honest card; neither renders as a zero (PRD §16.11).

const moduleEvidence = require('./moduleEvidence');
const adminLimits = require('../../services/adminLimits');
const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');

// Modules whose evidence this file can produce. 'technical' is absent because
// CrawlScope owns its own richer tables and writes evidence there.
const RUNNABLE = ['seo_geo', 'agent_readiness', 'competitor', 'hub_spoke', 'ai_visibility'];

// Modules that spend a third-party metered budget, with the cost per unit of
// work. Everything else fetches pages and calls free-tier APIs; these bill.
//
// Declared as data rather than buried in a route so one place answers "what
// does this cost", and so the UI can state the estimate before somebody clicks.
const METERED = {
  competitor: {
    unit: 'SEMrush units',
    // From competitorAnalysis/unitCosts.js: domain_rank (10) +
    // backlinks_overview (45) + keywords (1000) + AIO (500) + branded (400).
    perDomain: 1955,
    // Charged for the client's own domain as well as each competitor.
    countsPrimaryDomain: true,
  },
};

/** What one run of a module would cost, given how many domains it touches. */
function estimateCost(moduleKey, { competitorCount = 0 } = {}) {
  const meter = METERED[moduleKey];
  if (!meter) return null;
  const domains = competitorCount + (meter.countsPrimaryDomain ? 1 : 0);
  return { unit: meter.unit, domains, estimate: domains * meter.perDomain };
}

// The default set for "Run Full Audit": everything that does NOT bill.
//
// Metered modules are excluded on purpose. "Run Full Audit" is a button people
// press repeatedly — after a fix, to check something, to show a client — and
// each press would otherwise spend thousands of SEMrush units. Excluding it
// costs a reader nothing: the card says what it needs and offers its own Run.
const DEFAULT_AUDIT_MODULES = RUNNABLE.filter((key) => !METERED[key]);

function invalid(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * What a module should point at, derived from the project.
 *
 * The primary domain's origin, or — for a project that predates migration 0011's
 * backfill — the legacy url column. Throws rather than guessing: a module that
 * silently audits the wrong host produces evidence that looks real and is not.
 */
function targetFor(project, domains = []) {
  const primary = domains.find((d) => d.role === 'primary' && d.status === 'active');
  const origin = primary?.normalized_origin || project.url;
  if (!origin) {
    throw invalid(
      'This project has no primary domain, so there is nothing to audit. Set one in project settings.',
      'no_primary_domain',
    );
  }
  return { origin, host: primary?.host || null, fromLegacyColumn: !primary };
}

// ── Per-page audits ─────────────────────────────────────────────────────────
//
// One function per module, each auditing ONE url and returning that page's own
// report. runAcrossCrawledPages drives them over the pages the crawl found and
// rolls the scores up; the module runners below are thin wrappers over it.
//
// Every one of these calls the module's own extracted service and stores that
// module's own report under payload.native, so a page's report is byte-for-byte
// what an individual run of that tool produces (PRD §32: service extraction, not
// a parallel implementation).

/**
 * SEO & GEO: 200+ rule-based checks plus the module's own AI analysis.
 *
 * This module DOES score itself — bucket scores, a weighted composite, capped by
 * blocking issues — and that figure is stored as-is. The AI layer runs because it
 * writes the report's recommendation sections, and a report missing them is
 * visibly not the report an individual run produces.
 */
async function auditPageSeoGeo({ url, keywords }) {
  const { runSeoGeoAudit } = require('../../routes/seoGeoAudit');

  const result = await runSeoGeoAudit({ url, keywords: keywords || [], skipAi: false });
  const scores = result.findings?.scores || {};
  const overall = Number(scores.overall);
  const hasScore = Number.isFinite(overall);

  const findings = (result.findings?.checks || [])
    .filter((c) => ['error', 'warning', 'notice'].includes(String(c.severity || '').toLowerCase()))
    .map((c) => ({
      ruleId: `seogeo-${c.id}`,
      title: c.title || c.name || c.id,
      severity: c.severity,
      category: c.category || null,
      count: 1,
      detail: c.detail || null,
      recommendation: c.recommendation || null,
    }));

  return {
    score: hasScore ? overall : null,
    scoreMax: 100,
    scoreBasis: hasScore ? SCORE_BASIS.seo_geo : null,
    // scores.band is an object here ({ label, blurb }); the column is text, so
    // storing it whole once put raw JSON on a card.
    band: typeof scores.band === 'string' ? scores.band : (scores.band?.label || null),
    findings,
    payload: {
      native: { findings: result.findings, ai: result.ai || null },
      aiAnalysisPresent: Boolean(result.ai && Object.keys(result.ai).length),
      scores,
      bandBlurb: typeof scores.band === 'object' ? scores.band?.blurb || null : null,
    },
  };
}

/**
 * Agent readiness: weighted HTTP checks plus on-page checks, 0-100 with a level.
 *
 * The CMO brief runs: it is a section of this module's report, and skipping it
 * would leave that section empty when the report is opened from a project.
 */
async function auditPageAgentReadiness({ url }) {
  const { runAgentReadiness: run } = require('../../routes/agentReadinessAudit');

  const result = await run({ url_homepage: url, skipBrief: false });

  const findings = [...(result.checks || []), ...(result.onPageChecks || [])]
    .filter((c) => c.status && c.status !== 'pass')
    .map((c) => ({
      ruleId: `agent-${c.id}`,
      title: c.label || c.title || c.name || c.id,
      severity: c.status === 'fail' ? 'error' : 'notice',
      category: c.category || null,
      count: 1,
      detail: c.tech || c.detail || null,
      recommendation: c.recommendation || c.fix || null,
    }));

  const score = Number(result.site?.score);
  const hasScore = Number.isFinite(score);

  return {
    score: hasScore ? score : null,
    scoreMax: 100,
    scoreBasis: hasScore ? SCORE_BASIS.agent_readiness : null,
    band: result.site?.level || null,
    findings,
    payload: {
      native: result,
      site: result.site || null,
      cats: result.cats || [],
    },
  };
}

// ── The module runners ──────────────────────────────────────────────────────
// Thin: the work is per-page, and the driver owns iterating and rolling up.

async function runSeoGeo({ access, run, project, keywords }) {
  return runAcrossCrawledPages({ access, moduleKey: 'seo_geo', run, project, keywords });
}

async function runAgentReadiness({ access, run, project, keywords }) {
  return runAcrossCrawledPages({ access, moduleKey: 'agent_readiness', run, project, keywords });
}

// ── competitor ──────────────────────────────────────────────────────────────
// A real comparison against the project's tracked competitors, using the
// competitor module's own SEMrush-backed fetcher and gap analysis. Nothing is
// reimplemented here: the keyword gap is computed by competitorAnalysis/
// gapAnalysis.js, the same code the standalone screen uses.
//
// The client shape is built from the PROJECT — its primary domain, its country,
// its competitor domains from project_domains. The competitor module also keeps
// its own client records on local disk (data/clients.json); those are left alone.
// This reads nothing from them and writes nothing to them, so the two models do
// not have to be reconciled for a project to get a comparison.
//
// THIS ONE COSTS MONEY. Every domain is roughly 1,955 SEMrush units
// (unitCosts.js: domain_rank + backlinks_overview + three keyword reports), so a
// client with four competitors is close to 10,000 units per run. That is why it
// is excluded from the default "Run Full Audit" set — see routes.js — and run
// deliberately instead. A button people click repeatedly must not quietly spend
// a metered budget.
/**
 * Runs the same SEMrush + AI discovery "Find Competitors For Me" offers on the
 * standalone Competitor Research screen (competitorAnalysis/discovery.js), but
 * unattended: the top candidates are persisted as tracked competitors
 * directly, with no review step, instead of held for a human to confirm.
 * Called two ways: automatically inside runCompetitor (only when a project
 * with the setup toggle on still has zero tracked competitors), and on demand
 * from the Domains panel's "Find competitors with AI" button regardless of
 * that toggle or how many competitors already exist — see
 * routes.js POST /:projectId/domains/competitors/discover.
 *
 * `existingCompetitors` (hosts already tracked or proposed) is passed through
 * to discovery so it never re-suggests one already on the project — without
 * it, a re-suggested duplicate silently fails to add and the caller sees
 * nothing happen.
 *
 * Still routed through the same manageCompetitors capability the manual
 * add-competitor route enforces (§7.2) — a contributor's auto-discovered picks
 * land as 'proposed', same as if they had typed the domains in by hand, rather
 * than auto-discovery quietly granting rights a manual entry would not have had.
 */
async function autoDiscoverCompetitors({ access, project, primary, existingCompetitors = [] }) {
  const verdict = access.can('manageCompetitors');
  if (!verdict) {
    return {
      competitors: [],
      reason: 'not_authorized',
      note: 'Your role cannot add competitors, so none were found automatically. ',
    };
  }

  const { hasSemrushKey } = require('../competitorAnalysis/provider');
  if (!hasSemrushKey()) {
    return {
      competitors: [],
      reason: 'no_semrush_key',
      note: 'SEMRUSH_API_KEY is not configured, so no competitors could be found automatically. Add them manually instead. ',
    };
  }

  const { discoverCompetitorsForClient, DEFAULT_DISCOVERY_LIMIT } = require('../competitorAnalysis/discovery');
  const store = require('./store');
  const hostOf = (d) => d?.host || d?.normalized_origin;

  const pseudoClient = {
    name: project.name || hostOf(primary) || project.url,
    domain: hostOf(primary) || project.url,
    country: project.country_code,
    // Told about every domain already tracked or proposed on this project —
    // not just active ones — so discovery excludes them from its suggestions
    // (discovery.js) instead of re-suggesting one that then fails to add as a
    // duplicate. Harmless to pass [] when called with zero tracked
    // competitors (runCompetitor's case), but wrong once this also runs
    // on-demand from the Domains panel against a project that already has some.
    competitors: existingCompetitors.map((host) => ({ domain: host })),
  };

  let discovery;
  try {
    discovery = await discoverCompetitorsForClient(pseudoClient, { limit: DEFAULT_DISCOVERY_LIMIT });
  } catch (e) {
    return {
      competitors: [],
      reason: 'discovery_failed',
      note: `Auto-discovery found no competitors: ${e.message} `,
    };
  }

  // 'accepted': this candidate was suggested by discovery AND accepted, just
  // accepted by the setup toggle rather than by a person reviewing it — the
  // distinction project_domains_source_check exists to preserve.
  const status = verdict === 'propose' ? 'proposed' : 'active';
  const added = [];
  for (const candidate of discovery.candidates) {
    try {
      added.push(await store.addCompetitor({ access, domain: candidate.domain, status, source: 'accepted' }));
    } catch (e) {
      // One candidate failing to save (a duplicate, a transient DB error) is
      // not a reason to discard the others.
      console.warn(`[competitor] auto-discovery could not add ${candidate.domain}: ${e.message}`);
    }
  }

  if (!added.length) {
    return {
      competitors: [],
      reason: 'discovery_found_none',
      note: 'Auto-discovery found candidates, but none could be added (likely already tracked). ',
    };
  }

  if (status === 'proposed') {
    // Proposed, not active: nothing for THIS run to compare against yet, same
    // as if a contributor had typed these domains in by hand — an approver or
    // administrator still has to accept them (§7.2).
    return {
      competitors: [],
      reason: 'competitors_pending_approval',
      note: `Auto-discovery proposed ${added.length} competitor(s) — ${added.map((d) => d.host).join(', ')} — `
        + 'on this project. An approver or administrator has to accept them before a comparison can run. ',
    };
  }

  return {
    competitors: added,
    note: `Auto-discovered and added ${added.length} competitor${added.length === 1 ? '' : 's'} for this comparison — `
      + `${added.map((d) => d.host).join(', ')}. Edit them anytime in project settings. `,
  };
}

async function runCompetitor({ access, project, domains }) {
  let competitors = (domains || []).filter((d) => d.role === 'competitor' && d.status === 'active');
  const primary = (domains || []).find((d) => d.role === 'primary' && d.status === 'active');

  // "Find competitors for me" from Project Setup does not run at setup time —
  // it runs HERE, the first time this metered comparison is actually started,
  // which is what keeps a toggle flipped at setup from spending a SEMrush
  // budget before anyone asked to run anything (same reasoning as this module
  // being excluded from "Run Full Audit" below). Gated on the project still
  // having zero active competitors: once any exist — auto-discovered or typed
  // in — this never overrides what the analyst has since curated.
  let autoDiscoveryNote = '';
  if (!competitors.length && project.settings?.autoFindCompetitors) {
    const knownCompetitors = (domains || [])
      .filter((d) => d.role === 'competitor')
      .map((d) => d.host || d.normalized_origin)
      .filter(Boolean);
    const discovered = await autoDiscoverCompetitors({ access, project, primary, existingCompetitors: knownCompetitors });
    if (!discovered.competitors.length) {
      return {
        status: 'insufficient_data',
        score: null,
        findings: [],
        payload: { competitorCount: 0, reason: discovered.reason },
        note: discovered.note,
      };
    }
    competitors = discovered.competitors;
    autoDiscoveryNote = discovered.note;
  }

  if (!competitors.length) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { competitorCount: 0, reason: 'no_competitors_tracked' },
      note: 'No competitors are tracked on this project, so there is nothing to compare against.',
    };
  }

  const { hasSemrushKey } = require('../competitorAnalysis/provider');
  if (!hasSemrushKey()) {
    // The module falls back to a mock provider so its own screen still works,
    // clearly labelled "simulated". Storing simulated numbers as project
    // evidence is a different matter: they would sit on a client dashboard and
    // in an exported report as if measured. So this refuses rather than storing.
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { competitorCount: competitors.length, reason: 'no_semrush_key' },
      note:
        'SEMRUSH_API_KEY is not configured. The competitor module can run on simulated data for '
        + 'its own screen, but simulated numbers are not stored as project evidence — they would '
        + 'appear in the dashboard and the exported report as if they had been measured.',
    };
  }

  const { fetchClientDashboardData } = require('../competitorAnalysis/dataFetcher');
  const caStore = require('../competitorAnalysis/store');
  const { estimateDomainCost, MAX_UNITS_PER_RUN } = require('../competitorAnalysis/unitCosts');
  const { resolveDatabase } = require('../../utils/countryToDatabase');

  // Which SEMrush database the comparison runs against — i.e. which country's
  // search results. Resolved strictly and up front, because the lenient helper
  // defaults to 'us': a project in a market SEMrush has no database for would
  // otherwise spend its whole unit budget and come back with US rankings, with
  // nothing in the result saying so.
  const database = resolveDatabase(project.country_code);
  if (!database) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: {
        reason: 'unsupported_country',
        country: project.country_code || null,
        competitorCount: competitors.length,
      },
      note:
        `SEMrush has no search database for ${project.country_code || 'the country on this project'}, `
        + 'so a comparison would have to be measured in a different market than the project is set '
        + 'to. Nothing was spent. Set the project country to a market SEMrush covers.',
    };
  }

  const hostOf = (d) => d.host || d.normalized_origin;

  // The shape fetchClientDashboardData expects, assembled from the project.
  const client = {
    name: project.name || hostOf(primary) || project.url,
    domain: hostOf(primary) || project.url,
    // The market every comparison is measured in. A project cannot exist without
    // a country (§AC-004), so this is never a silent default.
    country: project.country_code,
    competitors: competitors.map((d) => ({ domain: hostOf(d), label: hostOf(d) })),
  };

  // The competitor module keeps its own client records, and its dashboard reads
  // them. Mirroring this project into that store is what lets "open the full
  // report" land on this project's comparison rather than an empty client picker.
  //
  // Reused when it already exists, matched on domain: creating a second record
  // for the same site every run would fill that store with duplicates and leave
  // the dashboard ambiguous about which one is current.
  let clientRecord = null;
  try {
    const existing = (await caStore.getClients().catch(() => []))
      .find((c) => sameSite(c.domain, client.domain));

    clientRecord = existing || await caStore.createClient({
      name: client.name,
      domain: client.domain,
      country: project.country_code,
      brandName: client.name,
    });

    // Keep its competitor list in step with project_domains, which is the source
    // of truth for who this project is compared against.
    const known = new Set((clientRecord.competitors || []).map((c) => c.domain.toLowerCase()));
    for (const competitor of client.competitors) {
      if (known.has(competitor.domain.toLowerCase())) continue;
      try {
        await caStore.addCompetitor(clientRecord.id, competitor);
      } catch (e) {
        // MAX_COMPETITORS in that module is 4 and a project can track more.
        // Hitting it is a real limit, not a failure of this run.
        console.warn(`[competitor] could not mirror ${competitor.domain}: ${e.message}`);
      }
    }
    clientRecord = (await caStore.getClient(clientRecord.id)) || clientRecord;
  } catch (e) {
    // A disk-store failure must not cost the comparison the units already paid
    // for. The card still works; only the deep link into that module is lost.
    console.error('[competitor] client record not mirrored:', e.message);
  }

  const snapshot = await fetchClientDashboardData(client, null, MAX_UNITS_PER_RUN);

  // The snapshot its dashboard reads, saved under that module's own client id.
  if (clientRecord) {
    try {
      await caStore.saveSnapshot(clientRecord.id, snapshot);
    } catch (e) {
      console.error('[competitor] snapshot not saved to the competitor module:', e.message);
    }
  }

  const gap = snapshot.keywordGap || { strikingDistance: [], untapped: [], missing: [] };
  const findings = [];

  // Each of the three gap classes is a different action, so each is its own
  // finding rather than one merged "keyword gap" number.
  if (gap.missing.length) {
    findings.push({
      ruleId: 'competitor-missing-keywords',
      title: 'Keywords a competitor ranks for and this site does not',
      severity: 'warning',
      category: 'Keyword gap',
      count: gap.missing.length,
      detail: gap.missing.slice(0, 10)
        .map((k) => `${k.keyword} (vol ${k.searchVolume}, ${k.bestCompetitorDomain} at #${k.bestCompetitorPosition})`)
        .join('; '),
      recommendation: 'Highest-volume first: decide which of these deserve a page, and which are not this business.',
    });
  }

  if (gap.strikingDistance.length) {
    findings.push({
      ruleId: 'competitor-striking-distance',
      title: 'Keywords ranking 11–50 where a competitor is ahead',
      severity: 'warning',
      category: 'Keyword gap',
      count: gap.strikingDistance.length,
      detail: gap.strikingDistance.slice(0, 10)
        .map((k) => `${k.keyword} (#${k.clientPosition} vs ${k.bestCompetitorDomain} #${k.bestCompetitorPosition})`)
        .join('; '),
      recommendation:
        'These already rank — improving an existing page is usually cheaper than a new one.',
    });
  }

  if (gap.untapped.length) {
    findings.push({
      ruleId: 'competitor-untapped-keywords',
      title: 'Keywords ranking beyond 50 where a competitor is ahead',
      severity: 'notice',
      category: 'Keyword gap',
      count: gap.untapped.length,
      detail: gap.untapped.slice(0, 10)
        .map((k) => `${k.keyword} (#${k.clientPosition} vs #${k.bestCompetitorPosition})`)
        .join('; '),
      recommendation: null,
    });
  }

  // A domain the run could not afford or could not fetch is reported, not
  // silently dropped — a comparison against three of four competitors is a
  // different claim from a comparison against all of them.
  if ((snapshot.skipped || []).length) {
    findings.push({
      ruleId: 'competitor-domains-skipped',
      title: 'Competitor domains not included in this comparison',
      severity: 'notice',
      category: 'Coverage',
      count: snapshot.skipped.length,
      detail: snapshot.skipped
        .map((sk) => (typeof sk === 'string' ? sk : `${sk.domain || 'unknown'}${sk.reason ? ` — ${sk.reason}` : ''}`))
        .join('; '),
      recommendation: 'The per-run unit budget or a provider error left these out.',
    });
  }

  const clientDomain = (snapshot.domains || []).find((d) => d.isClient);
  const trafficScore = competitorTrafficScore(snapshot.domains);

  return {
    // Scored on organic traffic relative to the strongest tracked competitor.
    //
    // This said "no score: a single number for how you compare would be a scoring
    // methodology invented here". That was true of the shape being considered at
    // the time — some blend of keyword counts and gaps — but it is not true of
    // this one. Traffic share is a ratio of two measured figures SEMrush already
    // returns, with no weights and nothing to tune, and §6.2 forbids inventing a
    // methodology rather than dividing one measurement by another.
    //
    // Null when there is nothing to compare against, never 0: a site with no
    // competitors tracked is not a site with no traffic.
    score: trafficScore ? trafficScore.score : null,
    scoreMax: 100,
    scoreBasis: trafficScore ? SCORE_BASIS.competitor : null,
    band: trafficScore
      ? `${trafficScore.clientTraffic.toLocaleString('en-US')} vs `
        + `${trafficScore.strongestTraffic.toLocaleString('en-US')} monthly visits`
      : `${competitors.length} competitor${competitors.length === 1 ? '' : 's'}`,
    findings,
    payload: {
      capturedAt: snapshot.capturedAt,
      country: project.country_code,
      // The market actually queried. Recorded because it is the one thing a
      // reader cannot recover from the numbers afterwards.
      semrushDatabase: database,
      // So the panel can open that module's own dashboard on this data.
      competitorClientId: clientRecord?.id || null,
      reportRef: clientRecord?.id || null,
      usedUnits: snapshot.usedUnits,
      capUnits: snapshot.capUnits,
      perDomainUnitCost: estimateDomainCost(),
      competitorCount: competitors.length,
      skipped: snapshot.skipped || [],
      gapCounts: {
        missing: gap.missing.length,
        strikingDistance: gap.strikingDistance.length,
        untapped: gap.untapped.length,
      },
      // Trimmed to the comparative headline per domain; the full keyword tables
      // stay in the competitor module, which is built to display them.
      domains: (snapshot.domains || []).map((d) => ({
        domain: d.domain,
        isClient: d.isClient,
        keywordBuckets: d.keywordBuckets || null,
        // Already fetched and already paid for — it is part of the 10-unit
        // domainRank call this run makes for every domain. It simply was not
        // carried across, so the one comparative figure a non-specialist
        // understands was sitting in the competitor module's own store.
        organicTraffic: Number.isFinite(Number(d.domainRank?.organicTraffic))
          ? Number(d.domainRank.organicTraffic) : null,
        organicKeywords: Number.isFinite(Number(d.domainRank?.organicKeywords))
          ? Number(d.domainRank.organicKeywords) : null,
      })),
      clientKeywordBuckets: clientDomain?.keywordBuckets || null,
      trafficShare: trafficScore,
    },
    note:
      autoDiscoveryNote
      + (clientRecord ? '' : 'The comparison ran but could not be mirrored into the competitor module, so its own dashboard will not show it. ')
      + `Compared against ${competitors.length} competitor(s) in ${project.country_code} `
      + `(SEMrush "${database}" database) using `
      + `${snapshot.usedUnits} SEMrush units. Keyword gap computed by the competitor module's own `
      + 'gap analysis; no score, because comparative standing has no rubric.',
  };
}

/** Same site? Compared on host, so scheme and www differences do not miss. */
function sameSite(a, b) {
  const hostOf = (value) => {
    try {
      return new URL(String(value)).host.replace(/^www\./, '').toLowerCase();
    } catch {
      return String(value || '').replace(/^https?:\/\//, '').replace(/^www\./, '')
        .split('/')[0].toLowerCase();
    }
  };
  const left = hostOf(a);
  return Boolean(left) && left === hostOf(b);
}

// ── hub_spoke — Content Architect, run on the crawl's stored pages ──────────
//
// CrawlScope has already discovered the site's sitemaps, fetched every internal
// page, and stored the titles, headings, word counts, depths and link graph that
// Content Architect's clustering needs. So this generates the hub-and-spoke
// analysis directly from that crawl:
//
//   stored crawl  ->  crawlToArchitect (reshape, no fetching)
//                 ->  contentArchitect/fullAnalysis.analyzeCrawledPages
//                 ->  clusters, hubs, gaps, diagnostics
//
// It runs the SAME pipeline the standalone tool runs — the analysis half was
// extracted for exactly this, so both paths cluster identically. Nothing is
// re-crawled (§32), and the URL-pattern review step is unnecessary because the
// crawl already decided what is internal, reachable and not an asset.
//
// The result is saved back into Content Architect's own store, so /content-
// architect shows the same analysis rather than a parallel one.
//
// Naming and content-relevance judgements run on Claude Sonnet, through the
// shared provider factory. Both are optional: every cluster has a mechanical
// name if the model is unavailable, and the pipeline completes regardless.
async function runHubSpoke({ project, domains }) {
  const crawlToArchitect = require('./crawlToArchitect');
  const { analyzeCrawledPages } = require('../contentArchitect/fullAnalysis');
  const caStore = require('../contentArchitect/store');

  const primary = (domains || []).find((d) => d.role === 'primary' && d.status === 'active');
  const origin = primary?.normalized_origin || project.url;
  if (!origin) {
    throw invalid(
      'This project has no primary domain, so there is nothing to analyse.',
      'no_primary_domain',
    );
  }

  const crawl = await crawlToArchitect.latestCompletedCrawl(project.id);
  if (!crawl) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { reason: 'no_completed_crawl' },
      note:
        'No completed crawl for this project yet. Hub and Spoke is generated from the crawl\'s '
        + 'stored pages, so run a site crawl first — then this analyses it without fetching anything again.',
    };
  }

  const input = await crawlToArchitect.buildFromCrawl(crawl.id, {
    maxUrls: crawl.options?.maxUrls || null,
  });
  if (input.tooSmall) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { reason: 'too_few_pages', pageCount: input.pageCount, minimum: input.minimum, crawlRunId: crawl.id },
      note:
        `That crawl stored ${input.pageCount} usable internal page(s). Clustering needs at least `
        + `${input.minimum} — a cluster is three pages minimum, so below that there is nothing to `
        + 'group. Raise the crawl URL cap and re-crawl.',
    };
  }

  // Content Architect's project record for this domain, created if this is the
  // first time. Its `vertical` (detected in that tool) is passed through when
  // known, because term profiling strips practice-type words per vertical.
  const existing = (await caStore.listProjects().catch(() => []))
    .find((cand) => sameSite(cand.domain, origin));
  const caProject = existing || await caStore.createProject({
    domain: origin,
    host: (() => { try { return new URL(origin).host; } catch { return origin; } })(),
  });

  const analysis = await analyzeCrawledPages(
    input.crawlResult,
    { domain: origin, vertical: caProject.vertical || null },
    { linkGraph: input.linkGraph },
  );

  // Hand it to Content Architect so its own screens show this analysis rather
  // than a stale or absent one. Failing to save is not failing the analysis: the
  // card's evidence is stored separately by the caller.
  try {
    await caStore.saveFullAnalysis(caProject.id, analysis);
    await caStore.updateProject(caProject.id, {
      workflowState: 'analyzed',
      crawlMode: 'crawlscope',
      sitemapSource: 'crawlscope',
      stats: {
        urlsFound: input.meta.pageCount,
        urlsSelected: input.meta.pageCount,
        urlsAnalyzed: (analysis.pages || []).length,
        urlsExcluded: 0,
        clusterCount: (analysis.clusters || []).length,
        gapHubCount: (analysis.clusters || []).filter((c) => c.isGap).length,
        orphanCount: 0,
        unassignedCount: (analysis.unassignedPages || []).length,
        meanHealth: null,
      },
    });
  } catch (e) {
    console.error('[hub_spoke] analysis computed but not saved to Content Architect:', e.message);
  }

  const clusters = analysis.clusters || [];
  const pages = analysis.pages || [];
  const unassigned = analysis.unassignedPages || [];

  // Page flags are strings in the stored analysis and objects in the diagnostics
  // pass that builds it, so both shapes are read rather than assuming one.
  const hasFlag = (page, type) => (page.flags || [])
    .some((f) => (typeof f === 'string' ? f === type : f?.type === type));

  const gapClusters = clusters.filter((c) => c.isGap);
  const orphans = pages.filter((p) => hasFlag(p, 'orphan'));
  const buried = pages.filter((p) => hasFlag(p, 'buried'));
  const thin = pages.filter((p) => hasFlag(p, 'thin-or-stale'));
  const ambiguous = clusters.filter((c) => c.ambiguous);
  const cannibalPairs = (analysis.cannibalization || [])
    .reduce((sum, entry) => sum + (entry.pairs?.length || 0), 0);

  // The module's own formula, copied from contentArchitect/exporter.js so the
  // card and that tool's export cannot disagree about the same number.
  const meanHealth = clusters.length
    ? Math.round(clusters.reduce((sum, c) => sum + (c.health || 0), 0) / clusters.length)
    : null;

  const findings = [];

  if (gapClusters.length) {
    findings.push({
      ruleId: 'architect-gap-hubs',
      title: 'Topic clusters with no page broad enough to be the hub',
      severity: 'warning',
      category: 'Content architecture',
      count: gapClusters.length,
      detail: gapClusters.slice(0, 10)
        .map((c) => `${c.name}${c.gapSuggestion?.title ? ` → suggested: ${c.gapSuggestion.title}` : ''}`)
        .join('; '),
      recommendation:
        'These are the clearest content gaps: the spokes exist, the page that should tie them '
        + 'together does not. Content Architect suggests a title for each.',
    });
  }

  // Orphan detection needs a complete crawl. On a capped one, a page with no
  // inbound link is almost always linked from a page that was never fetched —
  // calling it an orphan would be a false claim about the site, so the finding is
  // withheld and the reason is carried in `limitations`.
  if (orphans.length && !input.meta.capped) {
    findings.push({
      ruleId: 'architect-orphan-pages',
      title: 'Pages with no internal links pointing to them',
      severity: 'error',
      category: 'Internal linking',
      count: orphans.length,
      detail: orphans.slice(0, 15).map((p) => p.url).join(', '),
      recommendation: 'Link these from their cluster hub, or retire them.',
    });
  }

  if (unassigned.length) {
    findings.push({
      ruleId: 'architect-unassigned-pages',
      title: 'Pages that joined no topic cluster',
      severity: 'notice',
      category: 'Content architecture',
      count: unassigned.length,
      detail: unassigned.slice(0, 15).map((p) => p.url || p).join(', '),
      recommendation:
        'No cluster met the similarity bar for these. The threshold is deliberately strict — a '
        + 'wrongly merged cluster costs more trust than an honestly unassigned page.',
    });
  }

  if (buried.length) {
    findings.push({
      ruleId: 'architect-buried-pages',
      title: 'Pages buried deep in the click path',
      severity: 'warning',
      category: 'Internal linking',
      count: buried.length,
      detail: buried.slice(0, 15).map((p) => p.url).join(', '),
      recommendation: null,
    });
  }

  if (thin.length) {
    findings.push({
      ruleId: 'architect-thin-pages',
      // "Thin" only: staleness needs published/modified dates, which the crawl
      // does not record. Claiming "thin or stale" would overstate what was checked.
      title: 'Pages with thin content',
      severity: 'notice',
      category: 'Content quality',
      count: thin.length,
      detail: thin.slice(0, 15).map((p) => p.url).join(', '),
      recommendation: null,
    });
  }

  if (cannibalPairs) {
    findings.push({
      ruleId: 'architect-possible-cannibalization',
      // "Possible", not "confirmed" — the module labels it that way deliberately,
      // and hardening the claim here would misrepresent its own diagnostics.
      title: 'Possible keyword cannibalization between pages in a cluster',
      severity: 'notice',
      category: 'Content architecture',
      count: cannibalPairs,
      detail: `${cannibalPairs} page pair(s) across ${(analysis.cannibalization || []).length} cluster(s)`,
      recommendation: 'Review each pair — similar pages are not always competing ones.',
    });
  }

  if (ambiguous.length) {
    findings.push({
      ruleId: 'architect-ambiguous-hubs',
      title: 'Clusters where the hub choice was ambiguous',
      severity: 'notice',
      category: 'Content architecture',
      count: ambiguous.length,
      detail: ambiguous.slice(0, 10).map((c) => c.name).join('; '),
      recommendation: 'Two or more pages scored within a hair of each other — worth a human decision.',
    });
  }

  return {
    score: meanHealth,
    scoreMax: 100,
    scoreBasis: meanHealth === null ? null
      : 'Content Architect: mean cluster health — hub present 30, hub term coverage 20, '
        + 'spoke count in range 15, link density 20, click depth 15 (config.js)',
    band: clusters.length
      ? `${clusters.length} cluster${clusters.length === 1 ? '' : 's'}`
      : 'No clusters',
    findings,
    payload: {
      source: 'crawlscope_run',
      crawlRunId: crawl.id,
      crawledAt: crawl.finished_at || crawl.created_at,
      contentArchitectProjectId: caProject.id,
      // The id this module's own report is keyed by. Projected onto the
      // dashboard card so opening the module goes straight there rather than to
      // a page with a button on it.
      reportRef: caProject.id,
      pagesAnalyzed: pages.length,
      edgeCount: input.meta.edgeCount,
      hasLinkGraph: input.meta.hasLinkGraph,
      clusterCount: clusters.length,
      gapHubCount: gapClusters.length,
      // Reported as null rather than 0 on a capped crawl: 0 would claim there are
      // none, and the truth is that it could not be determined.
      orphanCount: input.meta.capped ? null : orphans.length,
      orphanDetectionWithheld: input.meta.capped,
      pagesWithNoInboundLink: orphans.length,
      unassignedCount: unassigned.length,
      meanHealth,
      crawlCapped: input.meta.capped,
      urlCap: input.meta.urlCap,
      // Named so a reader can tell what was not checked from what was checked
      // and found clean.
      limitations: input.limitations,
      clusters: clusters.slice(0, 20).map((c) => ({
        name: c.name,
        isGap: c.isGap,
        spokes: (c.spokeIds || []).length,
        health: c.health ?? null,
        hubConfidence: c.hubConfidence ?? null,
      })),
    },
    note:
      `Generated from the crawl of ${input.meta.pageCount} page(s) on `
      + `${(crawl.finished_at || crawl.created_at || '').slice(0, 10)} — `
      + `${clusters.length} cluster(s), ${gapClusters.length} with no hub. `
      + (input.meta.capped
        ? `That crawl stopped at its ${input.meta.urlCap}-URL cap, so orphan detection is withheld `
          + 'and cluster health covers only the pages crawled. '
        : '')
      + 'Nothing was re-fetched; the analysis also appears in Content Architect.',
  };
}

// ── Auditing every page the crawl found ─────────────────────────────────────
//
// SEO & GEO, On-Page and Agent Readiness each audit ONE page. A project has many,
// so these three run across the pages of the latest crawl and store a report per
// page (project_module_page_runs, migration 0014). The run's score is the mean of
// the pages that scored.
//
// Three properties this driver is responsible for:
//
//   1. A page that fails does not fail the audit. It becomes a failed page, and
//      the other pages still produce a report.
//   2. Pages are audited SEQUENTIALLY. They are all on one host, and firing ten
//      audits at a site at once is the opposite of the politeness the crawler is
//      careful about.
//   3. The page budget is stated, never silent. `maxPagesPerModuleAudit` bounds
//      the work — a full pass over 50 pages with all three modules is about two
//      and a half hours — and the result always says how many of the crawled
//      pages it covered.

// Per-page audit functions. Each takes { url, keywords, project } and returns the
// same shape a single-page run returns: { score, scoreBasis, band, findings,
// payload } where payload.native is the module's own report for that page.
const PAGE_AUDITS = {
  seo_geo: auditPageSeoGeo,
  agent_readiness: auditPageAgentReadiness,
};

/** Keywords configured for one URL, if any. */
function keywordsForUrl(project, url, requestKeywords) {
  if (Array.isArray(requestKeywords) && requestKeywords.length) return requestKeywords;
  const configured = Array.isArray(project?.settings?.pageKeywords) ? project.settings.pageKeywords : [];
  return configured.find((p) => p.url === url)?.keywords || [];
}

async function runAcrossCrawledPages({ access, moduleKey, run, project, keywords }) {
  const crawledPages = require('./crawledPages');
  const projectPages = require('./pages');
  const audit = PAGE_AUDITS[moduleKey];

  const crawl = await crawledPages.listCrawledPages(project.id, {
    workspaceId: project.workspace_id,
  });

  // canonical key -> project_pages id, read once rather than per page. Empty when
  // the inventory does not exist yet (migration 0015 unapplied), in which case
  // page rows simply carry no page_id and everything else works unchanged.
  const pageIds = await projectPages.keyToId(project.id).catch((e) => {
    console.error(`[${moduleKey}] page inventory unavailable:`, e.message);
    return new Map();
  });

  if (!crawl.crawl) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { reason: 'no_completed_crawl' },
      note:
        'No completed crawl for this project yet. These audits run across the pages the crawl '
        + 'finds, so run a site crawl first.',
    };
  }

  if (!crawl.pages.length) {
    return {
      status: 'insufficient_data',
      score: null,
      findings: [],
      payload: { reason: 'no_usable_pages', crawledCount: crawl.crawledCount, excluded: crawl.excluded },
      note:
        `That crawl stored no page this module can audit (${crawl.excluded.asset || 0} asset(s), `
        + `${crawl.excluded.notOk || 0} non-200 response(s)). Re-crawl and try again.`,
    };
  }

  const pageResults = [];
  for (const page of crawl.pages) {
    const pageRun = await moduleEvidence.startPageRun({
      access,
      runId: run.id,
      moduleKey,
      url: page.url,
      ordinal: page.ordinal,
      pageId: pageIds.get(crawledPages.canonicalKey(page.url)) || null,
    });

    try {
      const result = await audit({
        url: page.url,
        keywords: keywordsForUrl(project, page.url, keywords),
        project,
      });
      pageResults.push(await moduleEvidence.completePageRun({
        pageRunId: pageRun.id,
        status: result.status || 'completed',
        score: result.score ?? null,
        scoreMax: result.scoreMax ?? 100,
        band: result.band ?? null,
        findings: result.findings || [],
        payload: result.payload || null,
      }));
    } catch (e) {
      // One page's failure is one page's failure.
      console.error(`[${moduleKey}] ${page.url} failed:`, e.message);
      pageResults.push(await moduleEvidence.completePageRun({
        pageRunId: pageRun.id,
        status: 'failed',
        error: e.message,
      }));
    }
  }

  const rollup = moduleEvidence.aggregatePages(pageResults);
  const scoreBasis = SCORE_BASIS[moduleKey];

  return {
    score: rollup.mean,
    scoreMax: 100,
    // The mean is a new number, so it says exactly what it is a mean OF and what
    // produced each input. §6.2 forbids inventing a methodology; averaging a
    // module's own per-page scores is arithmetic on its methodology, and the
    // basis has to make that legible.
    scoreBasis: rollup.mean === null ? null
      : `Mean of ${rollup.scoredPages} page score(s) from ${scoreBasis}`,
    band: `${rollup.totalPages} page${rollup.totalPages === 1 ? '' : 's'} audited`,
    findings: rollup.findings,
    payload: {
      pagesAudited: rollup.totalPages,
      pagesScored: rollup.scoredPages,
      pagesFailed: rollup.failedPages,
      pagesCrawled: crawl.crawledCount,
      pageBudget: crawl.limit,
      pagesSkipped: crawl.skipped,
      crawlCapped: crawl.capped,
      // How the audited pages were chosen, so a partial pass is readable as one.
      pageSelection: crawl.capped
        ? (crawl.linkGraph
          ? 'shallowest pages first, then the most internally linked'
          : 'shallowest pages first (no stored link graph for this crawl)')
        : 'every crawled page',
      linkGraph: crawl.linkGraph,
      crawlRunId: crawl.crawl.id,
      crawledAt: crawl.crawl.finished_at || crawl.crawl.created_at,
      excluded: crawl.excluded,
      // The per-page list the report's page picker renders. Reports themselves
      // live in the child rows, one fetch at a time.
      pages: pageResults.map((p) => ({
        pageRunId: p.id,
        url: p.url,
        status: p.status,
        score: p.score === null || p.score === undefined ? null : Number(p.score),
        band: p.band || null,
        counts: p.counts || {},
        findings: Array.isArray(p.findings) ? p.findings.length : 0,
      })),
    },
    note:
      `${rollup.totalPages} of ${crawl.crawledCount} crawled page(s) audited`
      + (crawl.skipped
        ? ` — the ${crawl.limit} ${crawl.linkGraph ? 'most internally linked' : 'shallowest'},`
          + ` leaving ${crawl.skipped} unaudited`
        : '')
      + (rollup.failedPages ? `, ${rollup.failedPages} failed` : '')
      + (rollup.mean === null
        ? '. This module reports findings rather than a score.'
        : `. The score is the mean of the ${rollup.scoredPages} page(s) that scored.`),
  };
}

// What produced each per-page score, named once so the run's basis and the
// per-page reports cannot describe it differently.
/**
 * Share of the strongest competitor's organic traffic.
 *
 * The one comparative number that means something to somebody who does not read
 * SERPs: not "how many keywords do we rank for" but "how big are we next to the
 * biggest player we chose to measure ourselves against". On the live project it
 * is 102,880 visits against Aspen Dental's 1,475,172 — a 7.
 *
 * Measured against the STRONGEST competitor rather than the average, because an
 * average is gameable by adding weak competitors, and the honest question is what
 * the ceiling looks like. Which competitors were chosen is a human decision the
 * card names, so the reader can judge the comparison.
 *
 * Capped at 100. A client ahead of every competitor it tracks scores 100, and the
 * raw ratio is kept in the payload so "ahead" and "level" stay distinguishable.
 *
 * Null — never 0 — when there is nothing to compare against: no competitors, or
 * traffic figures SEMrush did not return. A zero would read as a site with no
 * traffic at all, which is a completely different statement (§16.11).
 */
function competitorTrafficScore(domains) {
  const withTraffic = (domains || [])
    .map((d) => ({
      domain: d.domain,
      isClient: Boolean(d.isClient),
      traffic: Number(d.domainRank?.organicTraffic),
    }))
    .filter((d) => Number.isFinite(d.traffic));

  const client = withTraffic.find((d) => d.isClient);
  const rivals = withTraffic.filter((d) => !d.isClient);
  if (!client || !rivals.length) return null;

  const strongest = rivals.reduce((best, d) => (d.traffic > best.traffic ? d : best), rivals[0]);
  // A competitor with no measured traffic cannot be a denominator.
  if (!strongest.traffic) return null;

  const ratio = client.traffic / strongest.traffic;
  return {
    score: Math.min(100, Math.round(ratio * 100)),
    ratio,
    clientTraffic: client.traffic,
    clientDomain: client.domain,
    strongestDomain: strongest.domain,
    strongestTraffic: strongest.traffic,
    aheadOfAll: ratio >= 1,
  };
}

const SCORE_BASIS = {
  ai_visibility: 'the share of measured prompts in which an answer engine names the brand, over the prompts that were actually captured',
  seo_geo: 'the SEO & GEO audit (rule-based bucket scores, weighted composite, capped by blocking issues)',
  agent_readiness: 'the agent readiness audit (weighted HTTP plus on-page checks)',
  competitor: 'this site\'s estimated monthly organic traffic as a share of the tracked '
    + 'competitor with the most, from SEMrush',
};

/**
 * AI Visibility.
 *
 * Lives in its own module because it measures somebody else's product rather
 * than the client's site. Long-running — each ChatGPT capture is 25-110s and a
 * 20-prompt run over two surfaces is well over half an hour — so it is a
 * background job, not something a request should wait on.
 */
async function runAiVisibility({
  access, run, project, domains,
}) {
  const { runAiVisibility: execute } = require('../aiVisibility/run');
  const { projectView } = require('./store');
  // aiVisibility/run.js is written against projectView (camelCase primaryDomain,
  // competitors, countryCode) — runModule only hands runners the raw crawl_projects
  // row plus domains separately, so the view has to be built here or brand.domain
  // and competitors silently resolve to nothing every single run.
  return execute({ access, project: projectView(project, domains), run });
}

const RUNNERS = {
  seo_geo: runSeoGeo,
  agent_readiness: runAgentReadiness,
  competitor: runCompetitor,
  hub_spoke: runHubSpoke,
  ai_visibility: runAiVisibility,
};

/**
 * Runs one module against one project and stores the result.
 *
 * The evidence row is opened before the module starts and closed whatever
 * happens, so a crash leaves a failed run rather than a card that looks like it
 * was never run.
 *
 * @param {object} input
 * @param {object} input.access     from projectAccess.requireProject
 * @param {string} input.moduleKey
 * @param {Array}  input.domains    project_domains rows for the project
 * @param {string} [input.trigger]
 * @param {boolean} [input.detached]  return the OPEN run row immediately and
 *   let the module keep working in the background — for a module whose own
 *   runner documents it can take minutes (ai_visibility: 25-110s PER capture,
 *   serially), holding the caller's request open until completion is exactly
 *   what a reverse proxy's own timeout exists to kill. Every other module
 *   finishes in seconds and is unaffected — this is opt-in per call.
 */
async function runModule({
  access, moduleKey, domains, trigger = 'manual', keywords = null, detached = false,
}) {
  if (!RUNNABLE.includes(moduleKey)) {
    throw invalid(
      `${moduleKey} cannot be run from here. Runnable modules: ${RUNNABLE.join(', ')}.`,
      'module_not_runnable',
    );
  }

  const project = access.project;

  // Keywords passed in apply to the PRIMARY page only — the per-page mapping in
  // settings.pageKeywords is where each other page's terms live, and runOnPage
  // reads it directly. Nothing is flattened into a project-wide list: that was
  // the wrong model, because the implants page and the pricing page do not share
  // a target term.
  const requestKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : null;

  // Which modules need a resolvable primary domain up front:
  //   • hub_spoke reads a stored crawl.
  //   • The three per-page modules audit the URLs the crawl found, and a project
  //     with a crawl has pages whether or not its primary domain row survived.
  // Both would fail on targetFor for no reason, so only the site-level modules
  // that actually fetch the primary domain resolve one.
  const NEEDS_TARGET = ['competitor'];
  const target = NEEDS_TARGET.includes(moduleKey)
    ? targetFor(project, domains)
    : { origin: null, host: null, fromLegacyColumn: false };

  // The page budget decides how long this run may legitimately take, and the
  // sweeper judges it against that rather than one global cutoff. Read here so
  // the run's recorded deadline reflects the limit in force when it started.
  const pageBudget = moduleEvidence.PAGE_MODULE_KEYS.includes(moduleKey)
    ? await adminLimits.limit('maxPagesPerModuleAudit', {
      workspaceId: project.workspace_id,
    }).catch(() => null)
    : null;

  const run = await moduleEvidence.startRun({
    access,
    moduleKey,
    targetUrl: target.origin,
    trigger,
    pageBudget,
  });

  const finish = async () => {
    try {
      const result = await RUNNERS[moduleKey]({
        access, run, target, project, domains, keywords: requestKeywords,
      });
      return await moduleEvidence.completeRun({
        access,
        runId: run.id,
        status: result.status || 'completed',
        score: result.score ?? null,
        scoreMax: result.scoreMax ?? 100,
        scoreBasis: result.scoreBasis ?? null,
        band: result.band ?? null,
        findings: result.findings || [],
        payload: result.note ? { ...(result.payload || {}), note: result.note } : result.payload,
      });
    } catch (error) {
      await moduleEvidence.failRun({ access, runId: run.id, error });
      throw error;
    }
  };

  if (detached) {
    finish().catch((e) => console.error(`[moduleRunners.runModule] ${moduleKey} failed to close cleanly:`, e.message));
    return run; // still 'running' — the caller polls moduleEvidence/the overview for completion
  }

  return finish();
}

/**
 * Audit pages as a crawl discovers them, rather than after it finishes.
 *
 * Lives here so the per-page audit functions stay private to this module and
 * streamingAudit is handed them rather than reaching in for them.
 */
async function runFollowingCrawl({ access, project, crawlRunId, moduleKeys, keywords, trigger }) {
  const streamingAudit = require('./streamingAudit');
  return streamingAudit.followCrawl({
    access,
    project,
    crawlRunId,
    moduleKeys: (moduleKeys || Object.keys(PAGE_AUDITS)).filter((k) => PAGE_AUDITS[k]),
    audits: PAGE_AUDITS,
    keywords,
    trigger,
  });
}

module.exports = {
  RUNNABLE,
  METERED,
  competitorTrafficScore,
  PAGE_AUDITS,
  SCORE_BASIS,
  runFollowingCrawl,
  DEFAULT_AUDIT_MODULES,
  estimateCost,
  RUNNERS,
  targetFor,
  runModule,
  autoDiscoverCompetitors,
};
