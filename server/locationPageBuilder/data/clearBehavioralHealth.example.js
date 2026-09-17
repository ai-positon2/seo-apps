// ── Reference data — the shape, not a client's facts ─────────────────────────
//
// Copy to `clearBehavioralHealth.js` in this folder and replace every value
// with what the CLIENT supplied. This file is a template on purpose: the
// addresses, phone numbers and service availability below are placeholders,
// and lsPages treats all three as factual claims that end up on a published
// page and inside JSON-LD. §13.18 forbids inventing service availability;
// guessing a street address or a phone number is the same mistake with a
// larger blast radius.
//
// The blanks are the design. `buildLocations` records every unsupplied NAP
// field in `nap_todo`, `lsCompose` turns that into a visible "REQUIRED FROM
// CLIENT" flag on the page and in the export, and `schemaGenerator` omits the
// field from JSON-LD rather than emitting an empty one. A location you have
// nothing but a city for is therefore SAFE to seed — it produces a page that
// says what it is missing. A location with a plausible-looking invented
// address is not.
//
// Seeding is re-runnable. Services are replaced wholesale; locations are
// merged, and any NAP field entered by hand in the UI beats this file's blank
// (see lsSeed's mergeLocation). So extending SERVICE_DEFS and re-seeding is
// cheap and does not cost the team's data entry.

// Must match the CLIENT_ID the front end sends — for this brand,
// client/src/pages/ClearBehavioralHealthPage.jsx.
const CLIENT_ID = 'client_clear_behavioral_health';

// The client row. `brand_rules` is what the QA gates in lsQa read.
const CLIENT = {
  id: CLIENT_ID,
  name: 'Clear Behavioral Health',
  website: 'https://www.example.com',
  industry: 'behavioral-health',
  brand_rules: {
    // Your-Money-or-Your-Life. Tightens the QA gates: no unsourced outcome
    // claims, no medical advice framing, a named reviewer where the template
    // asks for one.
    ymyl: true,
    // Phrases the writer must never produce. lsQa fails the page on a match,
    // as a Critical, so keep these specific — a word this list bans is banned
    // everywhere on every page.
    prohibited_claims: [
      'guaranteed recovery',
      'cure',
      '100% success',
      'permanent results',
      'best in the country',
    ],
    tone: 'Plain, warm, non-stigmatising. Person-first language throughout.',
  },
};

// The one template every page of this client is composed from.
const GLOBAL_TEMPLATE = {
  id: 'gt_clear_behavioral_health',
  client_id: CLIENT_ID,
  name: 'Clear Behavioral Health — Location + Service',
};

// [name, slug, category, conditions_treated]
//   slug        optional; slugify(name) when omitted. It is part of the URL,
//               so changing it later moves every page built from it.
//   category    'program' | 'condition' | 'therapy'. Decides the H2 ladder
//               ("What Is a Partial Hospitalization Program?" vs "What Is
//               OCD?") — see lsLadder.
//   conditions  the acronyms/terms the ladder may use verbatim.
const SERVICE_DEFS = [
  ['Partial Hospitalization Program (PHP)', 'php', 'program', []],
  ['Intensive Outpatient Program (IOP)', 'iop', 'program', []],
  ['Anxiety Treatment', 'anxiety-treatment', 'condition', ['anxiety']],
];

// [location_name, city, state_abbreviation, opts]
//
// One row per CITY per brand — two rows sharing a city give two pages the same
// URL, and the test suite fails the seed for it. A client running two
// buildings in one city needs two distinct location_names AND an explicit
// `locationSlug` on at least one.
//
// Everything in `opts` is optional. Supply only what the client confirmed:
//   region        groups sibling links ("South Bay"). Worth setting even when
//                 nothing else is known — it is what orders the links.
//   street, zip, phone, servingAreas, agesServed, directionsUrl
//                 client-verified facts. Leave out what you do not have.
//   pagePath      the location's own page on the client's site, for the
//                 breadcrumb. Never guess one: a breadcrumb pointing at a 404
//                 is worse than a shorter breadcrumb.
//   serviceSlugs  which services this location offers. OMIT IT and the
//                 location offers the full catalogue, which is the right
//                 default for a single-site client. An unknown slug is an
//                 error, not a silently shorter list.
const LOCATION_DEFS = [
  ['Example City', 'Example City', 'CA', { region: 'South Bay' }],
  ['Second City', 'Second City', 'CA', { region: 'South Bay' }],
];

// Abbreviation → full name, for the `state` field and the schema.
const STATE_NAMES = { CA: 'California' };

module.exports = {
  CLIENT_ID, CLIENT, GLOBAL_TEMPLATE, SERVICE_DEFS, LOCATION_DEFS, STATE_NAMES,
};
