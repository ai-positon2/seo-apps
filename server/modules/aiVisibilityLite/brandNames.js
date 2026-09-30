// ── Which names count as a mention of the business ──────────────────────────
//
// The business profile (businessProfile.js) reads the client's own site and
// lists names to match in answers. It over-collects: alongside real names it
// returns brands the business merely OFFERS — a dental practice's page listing
// "Invisalign", "CareCredit" and "Sunbit" put all three in its name list, and
// every answer explaining clear aligners or dental financing then counted as
// naming the practice. On one project that was 12 of 13 "mentions".
//
// No word rule separates the cases. "ShadowPlex" is Acalvio's own platform and
// "Air Jordan" is Nike's own line: an answer naming either IS visibility for
// that company. "Invisalign" is Align Technology's product, not the practice's.
// And "S2" or "Voice Library" are too generic to match safely at all. So each
// candidate is sorted once by a model into:
//
//   business      another name for the business itself — a short form, a
//                 former name, a branch                              KEEP
//   own_product   a product or brand the business itself owns        KEEP
//   third_party   another company's brand it sells, accepts or uses  DROP
//   generic       a common word or code that would match unrelated   DROP
//                 text
//
// The business's own name and the project's name are never sent — they are
// kept unconditionally. The result is cached per exact input, so it is one
// small call per project per process, not per page load. If the call fails the
// names are kept as they were: a transient outage must not make a business
// suddenly read as never mentioned.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');
const { brandFrom, competitorsFrom } = require('../aiVisibility/run');

const MODEL = process.env.AIVL_DESCRIBE_MODEL || 'gpt-4o-mini';
const KINDS = ['business', 'own_product', 'third_party', 'generic'];
const KEEP = new Set(['business', 'own_product']);

const SYSTEM = `You decide which names should count as an AI answer mentioning a business.

You get the business's name, its website, what it offers, and candidate names. Classify
EVERY candidate as exactly one of:

  business      another name for this business itself: a short form, abbreviation,
                former name, or one of its own branches or locations
  own_product   a product, platform or brand that this business itself owns and makes
  third_party   a brand owned by ANOTHER company that this business sells, offers,
                accepts or uses — e.g. a treatment system, a payment or financing plan,
                a device or software brand
  generic       a common word, phrase or short code that would appear in answers that
                have nothing to do with this business. A feature or plan name made
                only of everyday words ("Voice Library", "Story Studio", "membership
                plan") is generic, even if this business uses it.

When unsure between business and own_product, either is fine. When a name could be
a third-party brand, it is third_party unless the business clearly owns it.

Return ONLY raw JSON: {"names": [{"name": "the candidate, exactly as given", "kind": "..."}]}`;

const cache = new Map();

/**
 * Short codes with a digit ("S2", "V3") match version numbers, model names and
 * part numbers in unrelated answers whatever the model thinks of them.
 */
function isShortCode(name) {
  const compact = String(name).replace(/[^a-z0-9]/gi, '');
  return compact.length <= 3 && /\d/.test(compact);
}

/**
 * The model's reply, applied to the candidates. Anything it did not classify,
 * or classified as something unknown, is KEPT — the failure this guards
 * against is losing a real name, not keeping a doubtful one.
 */
function interpretVetting(parsed, candidates) {
  const kindOf = new Map();
  for (const item of parsed?.names || []) {
    const name = String(item?.name || '').trim().toLowerCase();
    if (name && KINDS.includes(item?.kind)) kindOf.set(name, item.kind);
  }
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    if (isShortCode(c)) { dropped.push({ name: c, kind: 'generic' }); continue; }
    const kind = kindOf.get(String(c).trim().toLowerCase());
    if (kind && !KEEP.has(kind)) dropped.push({ name: c, kind });
    else kept.push(c);
  }
  return { kept, dropped };
}

async function vetAliases({ name, domain, candidates, offers }) {
  if (!candidates.length) return { kept: [], dropped: [] };
  const key = JSON.stringify([name, domain, candidates, offers]);
  if (!cache.has(key)) {
    const job = (async () => {
      try {
        const client = createLlmClient(MODEL);
        const res = await client.chat.completions.create({
          model: client.model,
          response_format: { type: 'json_object' },
          ...chatParams(client.model, { maxTokens: 700, temperature: 0 }),
          messages: [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content: JSON.stringify({
                business: name, website: domain || null, offers: offers.slice(0, 30), candidates,
              }),
            },
          ],
        });
        const text = String(res.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/g, '').trim();
        return interpretVetting(JSON.parse(text), candidates);
      } catch (e) {
        console.warn(`[aiVisibilityLite] name check skipped for ${name} (${e.message}); keeping every name`);
        cache.delete(key);
        return { kept: candidates, dropped: [] };
      }
    })();
    cache.set(key, job);
  }
  return cache.get(key);
}

/**
 * The identity to measure: the business's name, plus only those alternative
 * names that really are the business or its own brands.
 *
 * The project's own name is kept as an alias when the site's fuller name
 * replaces it ("Gentle Dental" beside "Gentle Dental of New England") — it is
 * usually the name answers actually write.
 *
 * @returns {Promise<{brand, competitors, nameCheck: {kept: string[], dropped: Array<{name, kind}>}}>}
 */
async function identityFor(project, profile) {
  const base = brandFrom(project);
  const name = profile?.businessName || base.name;

  const always = [base.name, ...base.aliases].filter(Boolean);
  const seen = new Set([name, ...always].map((a) => String(a).toLowerCase()));
  const candidates = [];
  for (const alias of profile?.brandAliases || []) {
    const k = String(alias).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(alias);
  }

  const vetted = await vetAliases({
    name,
    domain: base.domain,
    candidates,
    offers: [...(profile?.products || []), ...(profile?.services || [])],
  });

  const aliases = [...always.filter((a) => String(a).toLowerCase() !== String(name).toLowerCase()), ...vetted.kept];

  const configured = competitorsFrom(project);
  const known = new Set(configured.map((c) => String(c.name).toLowerCase()));
  const competitors = [...configured];
  for (const competitor of profile?.competitors || []) {
    if (known.has(String(competitor).toLowerCase())) continue;
    known.add(String(competitor).toLowerCase());
    competitors.push({ name: competitor, domain: null, aliases: [] });
  }

  return {
    brand: { name, domain: base.domain, aliases },
    competitors,
    nameCheck: { kept: [name, ...aliases], dropped: vetted.dropped },
  };
}

module.exports = {
  identityFor, vetAliases, interpretVetting, isShortCode, KINDS,
};
