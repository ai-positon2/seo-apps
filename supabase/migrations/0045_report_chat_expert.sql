-- ── Report chat: the SEO expert's answers ───────────────────────────────────
--
-- The report assistant now answers general SEO / GEO questions too, searching
-- the web for anything time-sensitive, and offers a Position2 specialist under
-- answers that give advice. Each answer records:
--
--   offer_expert  whether the "talk to a Position2 specialist" notice is shown
--                 under it, so a reloaded conversation shows the same notice
--   sources       the web pages a search cited, as [{ title, url }], shown as
--                 the answer's sources (null when it did not search)
--   web_searches  how many searches it ran, so their cost is visible beside
--                 the token counts
--
-- server/modules/reportChat/store.js keeps working without these columns
-- until this is applied.
alter table report_chat_messages
  add column if not exists offer_expert boolean not null default false,
  add column if not exists sources jsonb,
  add column if not exists web_searches integer not null default 0;
