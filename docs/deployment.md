# Deploying this app

Two settings decide whether a deployment works correctly and whether it feels
fast. Neither is in code — both are platform configuration — and the first one
fails silently, which is what makes it worth writing down.

---

## 1. Persistent storage — required, or modules lose their data on every deploy

**Set `APP_DATA_ROOT` to a mounted volume.** Without it, six modules are reset
to empty on every deploy.

Six modules predate the move to Postgres and still store their state as JSON
files on disk:

| module | what it loses |
|---|---|
| Content Architect | hub-and-spoke projects |
| Competitor Analysis | saved comparisons |
| Market Potential | saved analyses and usage counters |
| On-Page Audit | stored audits |
| Robots Monitor | monitor history |
| CrawlScope | generated report workbooks |

By default each resolves its directory to a path *inside the deployed code tree*
(`server/services/dataRoot.js`). On a laptop that is fine — the files sit on
your disk and persist. On a container platform the image is rebuilt on every
deploy, and `data` is in `.dockerignore`, so the directory ships **empty**.
Every deploy is a factory reset.

**The symptom is not an error, which is why this is expensive to diagnose.** The
module runs, reports success, and writes its result. After the next deploy its
screen says "not found" or "nothing here yet" — because the run's evidence row
survived in Postgres and the JSON file beside it did not. The page renders
normally; only the data is missing.

### The fix

1. Attach a volume to the service, mounted at `/data`.
2. Set `APP_DATA_ROOT=/data`.
3. Redeploy.

`server/services/dataRoot.js` resolves each module to `<APP_DATA_ROOT>/<slug>`.
Per-module overrides (`CONTENT_ARCHITECT_DATA_ROOT`, `LPB_DATA_ROOT`, and the
others in `.env.example`) still win, so a deployment that already pinned one is
not moved by adding `APP_DATA_ROOT`.

> **This does not migrate anything.** Pointing an existing deployment at a new
> root gives it an empty one. Data already lost to previous deploys is gone and
> those runs must be repeated. Set this up before it matters, not after.

---

## 2. Put the app in the same region as its database

**The app is latency-bound, not CPU-bound.** It issues several sequential
queries per request, so every millisecond between the server and the database is
multiplied by four to twelve on every page.

Measured from a workstation in India against a Neon instance in `us-east-2`:

| | one `select 1` | a 12-query dashboard build |
|---|---|---|
| database ~13,000 km away | **264 ms** | **~3.2 s** |
| database on the same machine | **0.22 ms** | **~3 ms** |

That 264 ms is not query time. `select 1` does no work; it is the round trip.
A well-indexed query and a badly-indexed one cost almost the same when the
network dominates, which is why "add an index" is usually the wrong first move
here — reducing the *number* of sequential round trips is the right one.

**So: host the app in the same region as the database.** If the two are
co-located the server-to-database hop is ~1-5 ms, those same twelve queries cost
under 60 ms, and a browser anywhere in the world pays one round trip to the
server rather than twelve to the database.

If most users are far from both, moving the app *and* the database closer to
them helps again — but move them together. Splitting them is what produces the
first row of the table above.

### For local development

Running the server on a laptop while the database is on another continent
reproduces the slow case exactly: your laptop *is* the server, so it pays the
full round trip on every query. A local Postgres removes it. Point
`DATABASE_URL` at a local instance and keep the hosted URL alongside it so
switching back is one edit.

---

## 3. Workers (optional)

By default the CrawlScope crawler and the module worker run **inside the web
process** (`CRAWLSCOPE_WORKER=in-process`, `MODULE_WORKER=in-process`). The
module worker drives headless Chrome at 150-300 MB per page, up to
`AIV_MAX_BROWSERS`, on the same event loop that serves requests.

`server/package.json` already has `worker` and `module-worker` scripts, and both
loops are safe to run as separate replicas. Setting `MODULE_WORKER=external` and
running `npm run module-worker` as its own service moves that load off the web
process. It reverts by setting the variable back.

One caveat: crawls with `trigger: 'manual'` still execute in the web process —
`modules/crawlScope/worker/index.js` deliberately refuses to reclaim them,
because nothing else would pick them up. Moving the worker out does not move
those.

---

## Checklist

- [ ] Volume mounted, `APP_DATA_ROOT` set to it
- [ ] App region matches the database region
- [ ] `DATABASE_URL` uses the **pooled** endpoint for the web process
      (migrations need the direct one — see `.env.example`)
- [ ] `PUBLIC_BASE_URL` set (report links are signed against it)
