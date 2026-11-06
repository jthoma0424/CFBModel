-- In-house play-by-play ratings (cfbscrapR-style), source key 'tcc_epa'.

-- One row per team per game: that team's offense, non-garbage scrimmage plays only.
create table if not exists team_game_pbp (
  game_id    bigint not null references games(id) on delete cascade,
  team_id    integer not null,   -- offense
  opp_id     integer not null,   -- defense
  season     integer not null,
  week       integer not null,
  is_home    boolean not null,
  neutral    boolean not null default false,
  plays      integer not null,
  epa        numeric,            -- sum of EPA (CFBD ppa)
  success    integer,            -- successful plays
  succ_epa   numeric,            -- EPA on successful plays (explosiveness)
  rush_plays integer, rush_epa numeric,
  pass_plays integer, pass_epa numeric,
  fetched_at timestamptz default now(),
  primary key (game_id, team_id)
);
create index if not exists team_game_pbp_season on team_game_pbp(season, week);

-- Which weeks of play-by-play have been pulled (so each week costs one API call).
create table if not exists pbp_weeks (
  season      integer not null,
  week        integer not null,
  season_type text not null default 'regular',
  fetched_at  timestamptz not null default now(),
  games       integer,
  primary key (season, week, season_type)
);

alter table team_game_pbp enable row level security;
alter table pbp_weeks enable row level security;

insert into rating_sources (key, name, origin, scale, weight, url, notes) values
  ('tcc_epa', 'In-house EPA (play-by-play)', 'internal', 60.0, 1.0, null, 'Opp-adjusted net EPA/play from CFBD play-by-play, garbage time removed; x ~60 plays')
on conflict (key) do nothing;
