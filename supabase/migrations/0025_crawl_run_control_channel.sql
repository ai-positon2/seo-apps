-- ═══════════════════════════════════════════════════════════════════════════
-- 0025 — a control channel for runs the web process is not executing
--
-- Why this exists
-- ────────────────
-- Pause, resume and stop act on the RunManager held in the process that
-- receives the request:
--
--   const ok = manager[action](run.id);
--   if (!ok) return res.status(409)
--     .json({ error: "This run is not being executed by this instance." });
--
-- A manual "run now" executes in the web process, so those buttons work. A
-- PROJECT run — everything "Run Full Audit" queues, and every scheduled crawl —
-- is executed by the worker, a separate process. The web process has no crawler
-- for it, so Stop returned a 409 whose message named an implementation detail
-- and offered nothing to do about it. The crawl kept going.
--
-- The limitation was known and written down in api/routes.js: "pause/resume/stop
-- only reach a run hosted in the receiving process ... To scale web
-- horizontally, add a DB-mediated control channel or sticky routing." What it
-- did not say is that the split already existed vertically — web versus worker —
-- so the gap was not a future scaling concern, it was the normal path for every
-- project crawl.
--
-- This is that control channel, and it is deliberately the smallest one that
-- works. The web process records a request; the worker notices it and acts.
--
-- Why these two columns and not a table
-- ──────────────────────────────────────
-- A request is not history. There is at most one outstanding request per run,
-- it is consumed within seconds, and the fact that somebody stopped a crawl
-- is already recorded where such things belong — the run reaches a terminal
-- status, and audit_events carries the actor. A queue table would add rows
-- nothing reads and a cleanup job nobody writes.
--
-- `control_requested_at` records when the request was made, for the UI and for
-- anyone reading the row later.
--
-- What it deliberately does NOT do is expire a request. A stop survives the
-- death of the worker that was meant to apply it: repo.requeueRun clears the
-- dead attempt's status, error and summary but leaves this column, so when the
-- reaper hands the run to a new worker it reads the stop and stops. That is
-- the faithful outcome — somebody asked for the crawl to stop, and a process
-- crashing in between is not consent to keep crawling. Adding an age check
-- here would quietly resume a crawl its owner had already stopped.
--
-- How it is consumed
-- ───────────────────
-- run/manager.js polls it on its own timer, RUN_CONTROL_POLL_MS (3s by
-- default), reading exactly one narrow row: `select control_request where id`.
-- It applies the request through the same crawler.pause/resume/stop() methods
-- the in-process buttons use, then clears the column with a compare-and-clear
-- (`eq('control_request', <what it read>)`) so a newer request written in
-- between is not swallowed.
--
-- The first version of this rode the 30-second heartbeat instead, because
-- repo.updateRun already returned the row and the read was free. It was the
-- wrong trade: it meant up to half a minute of a crawl that had been told to
-- stop still fetching pages, and the expensive thing here is the crawling, not
-- the polling. One narrow indexed read every 3s is ~0.3 reads/second per
-- running crawl, against a crawler making many requests per second in the same
-- window. The poll stops itself once the crawler is stopped, and writes
-- nothing at all unless a request is waiting.
--
-- crawler.stop() aborts the root controller and clears the queue, so once
-- noticed it takes effect immediately — and the run still finishes through the
-- normal completion path, storing the findings for the pages it did reach. A
-- stopped crawl is a partial audit, not a lost one.
-- ═══════════════════════════════════════════════════════════════════════════

-- 'pause' | 'resume' | 'stop', or null when nothing is outstanding. Text rather
-- than an enum: the set of controls is a property of the crawler, not of the
-- schema, and adding one should not need a migration.
alter table crawl_runs add column if not exists control_request text;
alter table crawl_runs add column if not exists control_requested_at timestamptz;

comment on column crawl_runs.control_request is
  'A pause/resume/stop asked for by a process that is not executing this run. '
  'Read and cleared by the executing worker on its own short poll, and left in '
  'place across a requeue so a stop outlives the worker that died before '
  'applying it. See 0025.';
comment on column crawl_runs.control_requested_at is
  'When control_request was recorded. Informational — it does not expire a '
  'request; see 0025 for why. See 0025.';

-- Only requests that are still outstanding are ever read, and there are very
-- few of them at any moment, so this stays small.
create index if not exists idx_crawl_runs_control_request
  on crawl_runs (control_request)
  where control_request is not null;

-- ── Verification ───────────────────────────────────────────────────────────
--
--   -- the columns exist and default to null
--   select control_request, control_requested_at from crawl_runs limit 1;   -- null, null
--
--   -- nothing outstanding on a quiet system
--   select count(*) from crawl_runs where control_request is not null;      -- 0
--
--   -- end to end, against a running PROJECT crawl: press Stop in the UI, then
--   -- within about RUN_CONTROL_POLL_MS this goes from 'stop' to null and the
--   -- run reaches a terminal status with its findings stored.
--   select id, status, control_request, control_requested_at
--     from crawl_runs where status in ('running','queued','paused');
--
-- Rollback: drop both columns and the index. Pause/resume/stop then go back to
-- returning 409 for any run the receiving process is not executing, which is
-- the behaviour this replaces — no data is lost, because a control request is
-- transient by design.
--
--   drop index if exists idx_crawl_runs_control_request;
--   alter table crawl_runs drop column if exists control_request;
--   alter table crawl_runs drop column if exists control_requested_at;
