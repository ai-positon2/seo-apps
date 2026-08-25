// ── Domain + country normalization (PRD §8.2, §9.1, §3.2.3, §30.1) ──────────
// Pure functions: no database, no network. Everything here is unit-tested in
// server/modules/projects/__tests__/domains.test.js, which is the point of
// keeping it separate from the store.
//
// Origin normalization is deliberately conservative, matching the default
// behaviour PRD §9.1 specifies for normalization version 1:
//   * accept only http(s)
//   * lowercase scheme and host
//   * remove the default port and the fragment
//   * drop path, query and fragment — a domain is an origin, not a URL
//   * preserve the raw input alongside it, always (§8.4: raw discovery evidence
//     is never discarded)
//
// What it does NOT do, because §9.1 reserves these for project-configurable
// versioned rules rather than a hardcoded default: no www stripping, no
// scheme coercion from http to https, no punycode folding of a Unicode host
// into ASCII beyond what the URL parser already does.

// ISO 3166-1 alpha-2. The PRD requires a country on every project (§3.2.3,
// AC-004) and defaults to alpha-2 (§30.1); validating against the real list is
// what stops "XX" or a typo'd "UK" from reaching the rank-tracking provider,
// where it would come back as an unexplained empty result.
const ISO_3166_ALPHA2 = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS ' +
   'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE ' +
   'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
   'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC ' +
   'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
   'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
   'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO ' +
   'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '),
);

// The handful of inputs a user reliably types instead of the code. Kept short on
// purpose — this is a convenience, not a geocoder.
const COUNTRY_ALIASES = {
  UK: 'GB', 'UNITED KINGDOM': 'GB', 'GREAT BRITAIN': 'GB', ENGLAND: 'GB',
  USA: 'US', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', AMERICA: 'US',
  UAE: 'AE', 'UNITED ARAB EMIRATES': 'AE',
  CANADA: 'CA', AUSTRALIA: 'AU', INDIA: 'IN', GERMANY: 'DE', FRANCE: 'FR',
  SPAIN: 'ES', ITALY: 'IT', JAPAN: 'JP', BRAZIL: 'BR', MEXICO: 'MX',
  NETHERLANDS: 'NL', SINGAPORE: 'SG', 'NEW ZEALAND': 'NZ', IRELAND: 'IE',
};

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_input' });
}

/**
 * Normalizes a country to an ISO 3166-1 alpha-2 code.
 * Throws a 400 for anything that isn't a real code or a known alias — silently
 * defaulting to 'US' would hand every non-US client the wrong market.
 *
 * @param {string} input
 * @returns {string} two uppercase letters
 */
function normalizeCountry(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw invalid('A country is required for every project (ISO 3166-1 alpha-2, e.g. US).');

  const upper = raw.toUpperCase();
  // The alias map is consulted first, whatever the input length: "UK" is two
  // characters but is not an assigned ISO code, so a length check would send it
  // straight to the reject path instead of resolving it to GB. No assigned
  // alpha-2 code appears as an alias key, so this can never shadow a real one.
  const candidate = COUNTRY_ALIASES[upper] || upper;

  if (!/^[A-Z]{2}$/.test(candidate) || !ISO_3166_ALPHA2.has(candidate)) {
    throw invalid(`"${raw}" is not a valid ISO 3166-1 alpha-2 country code (e.g. US, GB, IN, AU).`);
  }
  return candidate;
}

/** True for a syntactically plausible registrable host or IPv4 literal. */
function looksLikeHost(host) {
  if (!host || host.length > 253) return false;
  if (/\s/.test(host)) return false;
  // IPv4 literal — allowed (an internal tool is sometimes pointed at one), but
  // the crawler's SSRF guard still decides whether it may be fetched.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // Otherwise: labels separated by dots, at least one dot, letters in the TLD.
  if (!host.includes('.')) return false;
  return /^(?!-)[a-z0-9¡-￿-]{1,63}(\.(?!-)[a-z0-9¡-￿-]{1,63})*\.[a-z¡-￿]{2,}$/i
    .test(host);
}

/**
 * Normalizes user input into a project domain origin.
 *
 * Accepts "example.com", "https://Example.com/", "http://example.com:80/x?y=1"
 * and returns the origin for each. Rejects anything that isn't http(s) or has
 * no usable host.
 *
 * @param {string} input
 * @returns {{normalizedOrigin: string, host: string, scheme: string, raw: string}}
 */
function normalizeOrigin(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw invalid('A domain is required.');

  // A bare host has no scheme; assume https rather than rejecting, because
  // "gentledental.com" is what people type. An explicit scheme is preserved.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalid(`"${raw}" is not a valid domain or URL.`);
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw invalid(`Only http and https are supported — "${raw}" uses ${scheme}.`);
  }

  // url.hostname is already lowercased and punycoded by the URL parser. Strip a
  // trailing root dot ("example.com." and "example.com" are the same origin).
  const host = url.hostname.replace(/\.$/, '');
  if (!looksLikeHost(host)) {
    throw invalid(`"${raw}" does not contain a usable domain name.`);
  }

  const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';
  return {
    normalizedOrigin: `${scheme}://${host}${port}`,
    host,
    scheme,
    raw,
  };
}

/**
 * Normalizes a list of competitor domains: de-duplicated by origin, in input
 * order, and rejected if any of them is the project's own primary domain
 * (§8.2 — "the primary domain cannot also be an active competitor").
 *
 * @param {string[]} inputs
 * @param {object}  [opts]
 * @param {string}  [opts.primaryOrigin] normalized primary origin to exclude
 * @param {number}  [opts.max]           cap on how many are accepted
 */
function normalizeCompetitors(inputs, { primaryOrigin = null, max = 25 } = {}) {
  const list = Array.isArray(inputs) ? inputs : (inputs ? [inputs] : []);
  const seen = new Set();
  const out = [];

  for (const entry of list) {
    if (entry == null || String(entry).trim() === '') continue;
    const domain = normalizeOrigin(entry);

    if (primaryOrigin && domain.normalizedOrigin === primaryOrigin) {
      throw invalid(
        `${domain.host} is this project's primary domain — it cannot also be tracked as a competitor.`,
      );
    }
    if (seen.has(domain.normalizedOrigin)) continue;   // same domain typed twice
    seen.add(domain.normalizedOrigin);
    out.push(domain);

    if (out.length >= max) {
      throw invalid(`A project can track at most ${max} competitor domains.`);
    }
  }
  return out;
}

/** Display form: the host, with a leading "www." kept (it is part of the site). */
function displayName(normalizedOrigin) {
  try {
    return new URL(normalizedOrigin).host;
  } catch {
    return String(normalizedOrigin || '');
  }
}

module.exports = {
  ISO_3166_ALPHA2,
  COUNTRY_ALIASES,
  normalizeCountry,
  normalizeOrigin,
  normalizeCompetitors,
  looksLikeHost,
  displayName,
};
