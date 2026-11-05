// Auto-discovers organic competitors for a client already saved in the
// store. Pure request/response — this never touches clients.json. The
// caller (routes.js) is responsible for persisting any candidates the user
// actually confirms, via the existing store.addCompetitor, one call per
// candidate — which is what makes this compose with the already-working
// "editable anytime via Manage Client" flow instead of replacing it.
const semrushCA = require('../../services/semrushCA');
const gptAnalysis = require('../../services/gptAnalysisCA');
const { getDatabase } = require('../../utils/countryToDatabase');
const { hasSemrushKey } = require('./provider');
const { DISCOVERY_DISPLAY_LIMIT, UNITS_PER_LINE } = require('./unitCosts');

const DEFAULT_DISCOVERY_LIMIT = 3;

// Additional GPT judging criterion, specific to this dashboard's client base
// (multi-location service businesses this app also builds Location+Service
// pages for) — NOT added to the shared prompt unconditionally, only passed
// in here via validateCompetitors' optional extraCriteria arg.
const LOCATION_SERVICE_CRITERION = `
5. This brand may run a multi-location service business (e.g. dental, HVAC, home services, legal, medical chains) built around "[Service] in [City]" location + service landing pages. Where relevant, additionally weigh whether the candidate:
   - Offers a similar PRIMARY service or service line (not just adjacent/aggregator content)
   - Appears to serve multiple physical locations/cities with dedicated location pages, if the brand itself does
   - Targets the same local/regional service-area search intent rather than purely informational or national-brand content
`.trim();

// Semrush's candidates are sites that share ranking keywords, which for a
// brand is mostly the shops that sell it and the blogs that write about it:
// Nike got Foot Locker, Hibbett and Champs; Beta Bionics got a nutritionist.
// A competitor is a company selling the same kind of product or service to
// the same buyers, so everything else is excluded — by this instruction, and
// again by competitorType below in case the model keeps one anyway.
const DIRECT_RIVAL_CRITERION = `
6. Keep ONLY companies that make or sell the same kind of product or service as the brand, to the same buyers, so a buyer would choose between them. EXCLUDE (status "exclude"):
   - retailers, resellers, distributors, marketplaces and dealers that sell the brand's products or its category (e.g. a shoe shop is not a competitor of a shoe maker)
   - suppliers, service providers or clinics that use or prescribe the product rather than sell a rival one
   - directories, review/comparison sites, aggregators, publishers, news, blogs, forums, wikis and informational or educational sites
   - social networks and general platforms
   When unsure, exclude. Use competitorType "direct" only for a company selling a rival product or service.
`.trim();

// Only these types are ever attached; aggregators, informational sites and
// "indirect" rivals (often resellers) are dropped even when kept by the model.
const KEPT_TYPES = new Set(['direct']);

function isDirectRival(candidate) {
  return candidate.status === 'keep' && KEPT_TYPES.has(String(candidate.competitorType || '').toLowerCase());
}

function hasOpenAIKey() {
  return !!process.env.OPENAI_API_KEY;
}

// gptAnalysisCA's getClient() throws BEFORE its own try/catch when the key
// is missing, so its internal fallback never fires in that case — these
// wrappers give discovery the same graceful-degradation behavior the rest
// of this module has for a missing SEMrush key.
async function safeValidate(brandName, targetUrl, country, candidates) {
  if (!hasOpenAIKey()) {
    return candidates.map((r) => ({
      domain: r.domain, status: 'keep', competitorType: 'direct',
      reason: 'GPT validation unavailable (OPENAI_API_KEY not configured) — included based on Semrush competition score.',
    }));
  }
  try {
    return await gptAnalysis.validateCompetitors(brandName, targetUrl, country, candidates, `${LOCATION_SERVICE_CRITERION}\n${DIRECT_RIVAL_CRITERION}`);
  } catch (err) {
    console.error('[discovery] validateCompetitors failed:', err.message);
    return candidates.map((r) => ({
      domain: r.domain, status: 'keep', competitorType: 'direct',
      reason: 'GPT validation unavailable — included based on Semrush competition score.',
    }));
  }
}

async function safeSummary(brandName, country, kept) {
  if (!hasOpenAIKey() || !kept.length) return '';
  try {
    return await gptAnalysis.generateCompetitorSummary(brandName, country, kept);
  } catch {
    return '';
  }
}

// Joins the model's verdicts onto Semrush's candidates and keeps the direct
// rivals, strongest overlap first. A candidate the model did not mention is
// excluded (it used to default to a kept "direct" rival).
function pickDirectRivals(candidates, validation, limit) {
  const norm = (d) => String(d || '').replace(/^www\./, '').toLowerCase();
  const verdicts = Array.isArray(validation) ? validation : [];
  return candidates
    .map((c) => {
      const v = verdicts.find((x) => norm(x?.domain) === norm(c.domain)) || {};
      return { ...c, status: v.status || 'exclude', reason: v.reason || '', competitorType: v.competitorType || null };
    })
    .filter(isDirectRival)
    .sort((a, b) => b.competitionLevel - a.competitionLevel)
    .slice(0, limit);
}

// Discovers, validates, ranks and slices organic competitors for a client.
async function discoverCompetitorsForClient(client, { limit = DEFAULT_DISCOVERY_LIMIT } = {}) {
  if (!hasSemrushKey()) {
    const err = new Error('Auto-discovery requires a live SEMrush connection. Add competitors manually instead.');
    err.status = 400;
    throw err;
  }

  const database = getDatabase(client.country);
  const brandName = client.brandName || client.name;
  const norm = (d) => (d || '').replace(/^www\./, '').toLowerCase();
  const clientNorm = norm(client.domain);
  const existing = new Set(client.competitors.map((c) => norm(c.domain)));

  const raw = await semrushCA.discoverCompetitors(client.domain, database, DISCOVERY_DISPLAY_LIMIT);
  const unitsUsed = raw.length * UNITS_PER_LINE;

  const candidates = raw.filter((r) => {
    const d = norm(r.domain);
    return d !== clientNorm && !existing.has(d);
  });

  if (!candidates.length) {
    const err = new Error(`No new organic competitors found for ${client.domain} in the ${client.country} database. Try manual entry.`);
    err.status = 422;
    throw err;
  }

  const validation = await safeValidate(brandName, client.domain, client.country, candidates);
  const kept = pickDirectRivals(candidates, validation, limit);

  const gptSummary = await safeSummary(brandName, client.country, kept);

  return { candidates: kept, gptSummary, database, unitsUsed };
}

module.exports = { discoverCompetitorsForClient, pickDirectRivals, DEFAULT_DISCOVERY_LIMIT, DIRECT_RIVAL_CRITERION };
