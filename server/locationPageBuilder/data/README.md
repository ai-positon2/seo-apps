# Client reference data

One file per brand: the client's own service taxonomy and location list, which
`lsSeed` turns into the rows the Location + Service wizard works from.

This is **source**, not runtime state. The wizard's file-store lives at the repo
root (`data/location-page-builder`, or `LPB_DATA_ROOT` / `APP_DATA_ROOT` — see
`locationPageBuilder/config.js`); nothing in this folder is written at runtime,
and these files are meant to be committed.

They were not, for a while. The root `.gitignore` carried a bare `data/`, which
Git matches at every depth, so this directory was silently excluded along with
the runtime store it was written for. A fresh clone therefore had no
`clearBehavioralHealth.js`, and the deployed app answered "Sync client list"
with a 500 reading `Cannot find module './data/clearBehavioralHealth'`. The rule
is anchored now (`/data/` plus `server/modules/*/data/`), and
`lsSeed.loadReferenceData` reports an absent file as a 503 that names the file to
add instead of a stack trace.

## Adding a brand

1. Copy `clearBehavioralHealth.example.js` and fill it in from what the client
   actually supplied. The comments in it say which fields are factual claims —
   leave those blank rather than guessing; a blank becomes a visible "REQUIRED
   FROM CLIENT" flag on the page, and an invented address becomes a published
   one.
2. Add a loader beside `seedClearBehavioralHealth` in `lsSeed.js`, and a route
   beside `/seed/clear-behavioral-health` in `routes/lsPages.js`.
3. Point a page at it — `client/src/pages/ClearBehavioralHealthPage.jsx` is the
   whole of the front end for one brand.

Re-seeding is safe at any point: services are replaced, and hand-entered NAP
data in the UI always wins over a blank here.
