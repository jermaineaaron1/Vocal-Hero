-- Vocal Hero: Songs
create table if not exists vh_songs (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  artist text default '',
  arranged_by text default '',
  prim_lang text default 'en',
  trans_lang text default 'none',
  duration int default 180,
  tags text default '',
  status text default 'draft',
  parts jsonb default '[]'::jsonb,
  timed_lyrics jsonb default '[]'::jsonb,
  pipeline_log text default '',
  created_at timestamptz default now()
);

-- Vocal Hero: Game sessions
create table if not exists vh_game_sessions (
  id uuid primary key default gen_random_uuid(),
  room_code text unique not null,
  song_id uuid references vh_songs(id),
  status text default 'lobby',
  host_id text default '',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now()
);

-- Vocal Hero: Session players
create table if not exists vh_session_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references vh_game_sessions(id) on delete cascade,
  player_name text not null,
  part_index int default 0,
  score int default 0,
  accuracy int default 0,
  joined_at timestamptz default now()
);

-- Vocal Hero: Score events (streamed via Realtime)
create table if not exists vh_score_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references vh_game_sessions(id) on delete cascade,
  player_id uuid references vh_session_players(id) on delete cascade,
  delta int default 0,
  ts timestamptz default now()
);

-- Vocal Hero: High scores
create table if not exists vh_high_scores (
  id uuid primary key default gen_random_uuid(),
  song_id uuid references vh_songs(id) on delete cascade,
  part_index int default 0,
  player_name text not null,
  score int default 0,
  achieved_at timestamptz default now(),
  unique(song_id, part_index, player_name)
);

-- increment_player_score function
create or replace function vh_increment_player_score(p_id uuid, delta int)
returns void language plpgsql as $$
begin
  update vh_session_players
  set score = score + delta
  where id = p_id;
end;
$$;

-- finalise_session function
create or replace function vh_finalise_session(s_id uuid)
returns void language plpgsql as $$
begin
  update vh_game_sessions
  set status = 'ended', ended_at = now()
  where id = s_id;

  insert into vh_high_scores (song_id, part_index, player_name, score)
  select
    gs.song_id,
    sp.part_index,
    sp.player_name,
    sp.score
  from vh_session_players sp
  join vh_game_sessions gs on gs.id = sp.session_id
  where sp.session_id = s_id
    and sp.score > 0
  on conflict (song_id, part_index, player_name)
  do update set
    score = greatest(vh_high_scores.score, excluded.score),
    achieved_at = now();
end;
$$;

-- Discrete note events for per-note scoring (Phase 1) — already
-- read/written by application code; declared here to match reality.
alter table vh_songs add column if not exists notes jsonb default '[]'::jsonb;

-- Tempo data (Phase 3a) — previously local-only editor UI state that reset
-- on every reload; now persisted so the chord chart can lay out real bars.
alter table vh_songs add column if not exists bpm int default 120;
alter table vh_songs add column if not exists time_sig int default 4;

-- Vocal Hero: recorded instrumentalist takes (Phase 3b) — pure capture, no
-- comparison/feedback yet (that's a later phase). One row per take.
create table if not exists vh_recordings (
  id uuid primary key default gen_random_uuid(),
  song_id uuid references vh_songs(id) on delete cascade,
  part_index int default -1,
  source text default 'midi',
  notes jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

-- Enable Realtime
alter publication supabase_realtime add table vh_session_players;
alter publication supabase_realtime add table vh_score_events;

-- RLS policies — this app has no auth system; every vh_* table is read and
-- written directly from the browser with the anon key (same model the
-- legacy single-file game used). Without these, RLS-enabled tables with no
-- policy silently return zero rows to anon instead of erroring, which is
-- why the host page showed "No ready songs yet" despite songs existing.
alter table vh_songs enable row level security;
alter table vh_game_sessions enable row level security;
alter table vh_session_players enable row level security;
alter table vh_score_events enable row level security;
alter table vh_high_scores enable row level security;
alter table vh_recordings enable row level security;

drop policy if exists vh_songs_public_all on vh_songs;
create policy vh_songs_public_all on vh_songs for all using (true) with check (true);

drop policy if exists vh_game_sessions_public_all on vh_game_sessions;
create policy vh_game_sessions_public_all on vh_game_sessions for all using (true) with check (true);

drop policy if exists vh_session_players_public_all on vh_session_players;
create policy vh_session_players_public_all on vh_session_players for all using (true) with check (true);

drop policy if exists vh_score_events_public_all on vh_score_events;
create policy vh_score_events_public_all on vh_score_events for all using (true) with check (true);

drop policy if exists vh_high_scores_public_all on vh_high_scores;
create policy vh_high_scores_public_all on vh_high_scores for all using (true) with check (true);

drop policy if exists vh_recordings_public_all on vh_recordings;
create policy vh_recordings_public_all on vh_recordings for all using (true) with check (true);
