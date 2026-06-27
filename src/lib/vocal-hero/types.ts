// TODO: Implement full TypeScript types for Vocal Hero

export interface SatbPart {
  name: 'Soprano' | 'Alto' | 'Tenor' | 'Bass';
  rangeMin: number;   // Hz
  rangeMax: number;   // Hz
  curve: number[];    // normalised 0–1, length = 24 keyframes
  aiGen: boolean;
  edits: number;
}

export interface TimedLyricSection {
  primary: string;
  translation: string;
  start: number;      // seconds
  end: number;        // seconds
  // Per-part normalized pitch 0-1: [soprano, alto, tenor, bass]
  // When present, overrides the parts[i].curve keyframe for this time range
  pitches?: [number, number, number, number];
}

export interface SongNote {
  id: string;
  part: number;      // 0=Soprano 1=Alto 2=Tenor 3=Bass -1=unassigned
  midi: number;      // MIDI note number (60=C4)
  start: number;     // seconds
  end: number;       // seconds
  lyric: string;     // syllable / word
  velocity: number;  // 0-127 (dynamics)
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  arranged_by: string;
  prim_lang: string;
  trans_lang: string;
  duration: number;   // seconds
  tags: string;
  status: 'draft' | 'processing' | 'ready' | 'error';
  parts: SatbPart[];
  timed_lyrics: TimedLyricSection[];
  notes?: SongNote[];     // DAW-style note events (replaces/augments timed_lyrics)
  pipeline_log: string;
  yt_url: string;
  audio_url?: string;     // direct audio URL for gameplay (MP3 in Supabase Storage)
  bpm?: number;           // beats per minute
  time_sig?: number;      // beats per bar (numerator only — 2, 3, 4, or 6)
  created_at: string;
}

export interface GameSession {
  id: string;
  room_code: string;
  song_id: string;
  status: 'lobby' | 'playing' | 'ended';
  host_id: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface SessionPlayer {
  id: string;
  session_id: string;
  player_name: string;
  part_index: number;   // 0=Soprano, 1=Alto, 2=Tenor, 3=Bass
  score: number;
  accuracy: number;
  joined_at: string;
}

export interface ScoreEvent {
  id: string;
  session_id: string;
  player_id: string;
  delta: number;
  ts: string;
}

export interface HighScore {
  id: string;
  song_id: string;
  part_index: number;
  player_name: string;
  score: number;
  achieved_at: string;
}

export interface PitchSample {
  frequency: number;  // Hz, 0 = silence
  timestamp: number;  // seconds
  confidence: number; // 0–1
}

export interface ScoreBatch {
  playerId: string;
  sessionId: string;
  deltas: number[];
  timestamp: number;
}
