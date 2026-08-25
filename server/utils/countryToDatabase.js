const COUNTRY_TO_DATABASE = {
  'Afghanistan': 'af', 'Albania': 'al', 'Algeria': 'dz', 'Argentina': 'ar',
  'Australia': 'au', 'Austria': 'at', 'Azerbaijan': 'az', 'Bahrain': 'bh',
  'Bangladesh': 'bd', 'Belarus': 'by', 'Belgium': 'be', 'Bolivia': 'bo',
  'Bosnia and Herzegovina': 'ba', 'Brazil': 'br', 'Bulgaria': 'bg',
  'Cambodia': 'kh', 'Canada': 'ca', 'Chile': 'cl', 'China': 'cn',
  'Colombia': 'co', 'Costa Rica': 'cr', 'Croatia': 'hr', 'Cyprus': 'cy',
  'Czech Republic': 'cz', 'Denmark': 'dk', 'Dominican Republic': 'do',
  'Ecuador': 'ec', 'Egypt': 'eg', 'El Salvador': 'sv', 'Estonia': 'ee',
  'Finland': 'fi', 'France': 'fr', 'Georgia': 'ge', 'Germany': 'de',
  'Ghana': 'gh', 'Greece': 'gr', 'Guatemala': 'gt', 'Honduras': 'hn',
  'Hong Kong': 'hk', 'Hungary': 'hu', 'India': 'in', 'Indonesia': 'id',
  'Ireland': 'ie', 'Israel': 'il', 'Italy': 'it', 'Jamaica': 'jm',
  'Japan': 'jp', 'Jordan': 'jo', 'Kazakhstan': 'kz', 'Kenya': 'ke',
  'Kuwait': 'kw', 'Latvia': 'lv', 'Lebanon': 'lb', 'Lithuania': 'lt',
  'Luxembourg': 'lu', 'Malaysia': 'my', 'Malta': 'mt', 'Mexico': 'mx',
  'Moldova': 'md', 'Morocco': 'ma', 'Netherlands': 'nl', 'New Zealand': 'nz',
  'Nicaragua': 'ni', 'Nigeria': 'ng', 'Norway': 'no', 'Oman': 'om',
  'Pakistan': 'pk', 'Panama': 'pa', 'Paraguay': 'py', 'Peru': 'pe',
  'Philippines': 'ph', 'Poland': 'pl', 'Portugal': 'pt', 'Qatar': 'qa',
  'Romania': 'ro', 'Russia': 'ru', 'Saudi Arabia': 'sa', 'Serbia': 'rs',
  'Singapore': 'sg', 'Slovakia': 'sk', 'Slovenia': 'si', 'South Africa': 'za',
  'South Korea': 'kr', 'Spain': 'es', 'Sri Lanka': 'lk', 'Sweden': 'se',
  'Switzerland': 'ch', 'Taiwan': 'tw', 'Thailand': 'th', 'Trinidad and Tobago': 'tt',
  'Tunisia': 'tn', 'Turkey': 'tr', 'Ukraine': 'ua', 'United Arab Emirates': 'ae',
  'United Kingdom': 'uk', 'United States': 'us', 'Uruguay': 'uy',
  'Venezuela': 've', 'Vietnam': 'vn',
};

// Every database code above, for recognising an ISO alpha-2 code that already
// matches one. Most do — 'de', 'fr', 'ca' — which is why this derivation is
// safer than a second hand-written table that could drift from the first.
const KNOWN_DATABASES = new Set(Object.values(COUNTRY_TO_DATABASE));

// ISO alpha-2 codes whose SEMrush database code is NOT just the lowercased code.
// SEMrush uses the legacy 'uk' rather than ISO's 'GB'.
const ISO_OVERRIDES = { GB: 'uk' };

/**
 * ISO alpha-2 -> SEMrush database, or null when there is no database for it.
 *
 * This exists because the table above is keyed on country NAMES, while projects
 * store ISO codes (AC-004 requires alpha-2). Passing 'DE' to the name lookup
 * matched nothing and fell through to the 'us' default, so a German project
 * would have been measured against US search results — silently, and after
 * spending roughly 1,955 SEMrush units per domain to get the wrong market.
 *
 * Returns null rather than guessing: which market a comparison was measured in
 * is the one thing a reader cannot recover from the numbers afterwards.
 */
function databaseForIso(code) {
  const iso = String(code || '').trim().toUpperCase();
  if (iso.length !== 2) return null;
  if (ISO_OVERRIDES[iso]) return ISO_OVERRIDES[iso];
  const lower = iso.toLowerCase();
  return KNOWN_DATABASES.has(lower) ? lower : null;
}

/**
 * Strict resolution for callers that must not measure the wrong market.
 * Accepts an ISO alpha-2 code or a country name. Returns null when neither
 * matches, so the caller can refuse instead of quietly defaulting.
 */
function resolveDatabase(country) {
  if (!country) return null;
  const iso = databaseForIso(country);
  if (iso) return iso;

  const direct = COUNTRY_TO_DATABASE[country];
  if (direct) return direct;

  const lower = String(country).toLowerCase();
  const match = Object.entries(COUNTRY_TO_DATABASE).find(([k]) => k.toLowerCase() === lower);
  return match ? match[1] : null;
}

/**
 * Lenient resolution, defaulting to 'us'.
 *
 * Kept for the existing call sites that were written against it, but it now
 * understands ISO codes too — previously every one of them landed on the
 * default. Prefer resolveDatabase() anywhere the market matters.
 */
function getDatabase(country) {
  return resolveDatabase(country) || 'us';
}

const COUNTRY_LIST = Object.keys(COUNTRY_TO_DATABASE).sort();

module.exports = { getDatabase, COUNTRY_LIST, resolveDatabase, databaseForIso, COUNTRY_TO_DATABASE };
