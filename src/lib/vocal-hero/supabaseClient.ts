import { createClient } from '@supabase/supabase-js';
import type {
  Song,
  GameSession,
  SessionPlayer,
  HighScore,
} from './types';

// ── Browser-side client (anon key) ────────────────────────────────────────
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Server-side client (service role key) — only import in API routes ─────
export function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

// ── Songs ──────────────────────────────────────────────────────────────────

export async function fetchReadySongs(): Promise<Song[]> {
  const { data, error } = await supabase
    .from('vh_songs')
    .select('*')
    .eq('status', 'ready')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Song[];
}

export async function fetchAllSongs(): Promise<Song[]> {
  const { data, error } = await supabase
    .from('vh_songs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Song[];
}

export async function fetchSong(id: string): Promise<Song | null> {
  const { data, error } = await supabase
    .from('vh_songs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as Song;
}

export async function createSongStub(fields: {
  title: string;
  artist?: string;
  prim_lang?: string;
  trans_lang?: string;
  tags?: string;
}): Promise<Song> {
  const { data, error } = await supabase
    .from('vh_songs')
    .insert({ ...fields, status: 'draft' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Song;
}

export async function updateSong(
  id: string,
  fields: Partial<Omit<Song, 'id' | 'created_at'>>
): Promise<Song> {
  const { data, error } = await supabase
    .from('vh_songs')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Song;
}

export async function deleteSong(id: string): Promise<void> {
  const { error } = await supabase
    .from('vh_songs')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Game Sessions ──────────────────────────────────────────────────────────

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createSession(
  songId: string,
  hostId: string
): Promise<GameSession> {
  let attempts = 0;
  while (attempts < 5) {
    const roomCode = generateRoomCode();
    const { data, error } = await supabase
      .from('vh_game_sessions')
      .insert({ song_id: songId, host_id: hostId, room_code: roomCode, status: 'lobby' })
      .select()
      .single();
    if (!error) return data as GameSession;
    // 23505 = unique_violation (room code collision) — retry
    if (error.code !== '23505') throw new Error(error.message);
    attempts++;
  }
  throw new Error('Could not generate a unique room code — try again.');
}

export async function fetchSessionByCode(
  roomCode: string
): Promise<GameSession | null> {
  const { data, error } = await supabase
    .from('vh_game_sessions')
    .select('*')
    .eq('room_code', roomCode.toUpperCase())
    .single();
  if (error) return null;
  return data as GameSession;
}

export async function fetchSession(id: string): Promise<GameSession | null> {
  const { data, error } = await supabase
    .from('vh_game_sessions')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as GameSession;
}

export async function startSession(id: string): Promise<void> {
  const { error } = await supabase
    .from('vh_game_sessions')
    .update({ status: 'playing', started_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function endSession(id: string): Promise<void> {
  const { error } = await supabase
    .rpc('vh_finalise_session', { s_id: id });
  if (error) throw new Error(error.message);
}

// ── Players ────────────────────────────────────────────────────────────────

export async function joinSession(
  sessionId: string,
  playerName: string,
  partIndex: number
): Promise<SessionPlayer> {
  const { data, error } = await supabase
    .from('vh_session_players')
    .insert({ session_id: sessionId, player_name: playerName, part_index: partIndex })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as SessionPlayer;
}

export async function fetchPlayers(sessionId: string): Promise<SessionPlayer[]> {
  const { data, error } = await supabase
    .from('vh_session_players')
    .select('*')
    .eq('session_id', sessionId)
    .order('score', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as SessionPlayer[];
}

export async function incrementScore(
  playerId: string,
  delta: number
): Promise<void> {
  const { error } = await supabase
    .rpc('vh_increment_player_score', { p_id: playerId, delta });
  if (error) throw new Error(error.message);
}

// ── Real-time subscriptions ────────────────────────────────────────────────

// Returns an unsubscribe function
export function subscribeToPlayers(
  sessionId: string,
  onUpdate: (players: SessionPlayer[]) => void
): () => void {
  const channel = supabase
    .channel(`vh_session_players:${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'vh_session_players',
        filter: `session_id=eq.${sessionId}`,
      },
      async () => {
        // Re-fetch full sorted list on any change
        const players = await fetchPlayers(sessionId);
        onUpdate(players);
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

export function subscribeToSession(
  sessionId: string,
  onUpdate: (session: GameSession) => void
): () => void {
  const channel = supabase
    .channel(`vh_game_sessions:${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'vh_game_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => {
        onUpdate(payload.new as GameSession);
      }
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

// ── High Scores ────────────────────────────────────────────────────────────

export async function fetchHighScores(
  songId: string,
  partIndex: number
): Promise<HighScore[]> {
  const { data, error } = await supabase
    .from('vh_high_scores')
    .select('*')
    .eq('song_id', songId)
    .eq('part_index', partIndex)
    .order('score', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as HighScore[];
}
