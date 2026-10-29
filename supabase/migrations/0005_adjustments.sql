-- =====================================================================
-- Manual team adjustments (injuries, suspensions, etc.). Run once in the
-- Supabase SQL Editor. Safe to run more than once.
-- =====================================================================
create table if not exists team_adjustments (
  id          bigserial primary key,
  sport       text not null default 'cfb',       -- 'cfb' | 'cbb'
  team_id     integer not null,
  points      numeric not null,                  -- rating change in points (negative = weaker, e.g. -7 for a QB out)
  note        text,
  start_date  date not null default current_date,
  end_date    date,                              -- null = until removed
  created_at  timestamptz default now()
);
create index if not exists team_adjustments_lookup on team_adjustments(sport, team_id);
alter table team_adjustments enable row level security;

-- Record what was applied to each prediction
alter table predictions     add column if not exists adj_home numeric default 0;
alter table predictions     add column if not exists adj_away numeric default 0;
alter table predictions     add column if not exists adj_note text;
alter table cbb_predictions add column if not exists adj_home numeric default 0;
alter table cbb_predictions add column if not exists adj_away numeric default 0;
alter table cbb_predictions add column if not exists adj_note text;
