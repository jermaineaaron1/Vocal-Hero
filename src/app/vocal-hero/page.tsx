'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAllSongs,
  createSession,
  startSession,
  endSession,
  fetchPlayers,
  subscribeToPlayers,
  subscribeToSession,
} from '@/lib/vocal-hero/supabaseClient';
import { PitchEngine } from '@/lib/vocal-hero/pitchEngine';
import type { Song, GameSession, SessionPlayer, SongNote } from '@/lib/vocal-hero/types';

// ── Constants ──────────────────────────────────────────────────────────────

const PART_COLOURS = ['#f472b6', '#fb923c', '#60a5fa', '#34d399']; // S A T B
const PART_NAMES   = ['Soprano', 'Alto', 'Tenor', 'Bass'];
const HOST_ID      = 'host';

type Screen = 'idle' | 'lobby' | 'playing' | 'ended';

// ── Component ──────────────────────────────────────────────────────────────

export default function VocalHeroHostPage() {
  const [screen,   setScreen]   = useState<Screen>('idle');
  const [songs,    setSongs]    = useState<Song[]>([]);
  const [song,     setSong]     = useState<Song | null>(null);
  const [session,  setSession]  = useState<GameSession | null>(null);
  const [players,  setPlayers]  = useState<SessionPlayer[]>([]);
  const [elapsed,  setElapsed]  = useState(0);
  const [error,    setError]    = useState('');

  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef   = useRef<(() => void)[]>([]);

  // ── Load songs on mount ──────────────────────────────────────────────────
  useEffect(() => {
    fetchAllSongs()
      .then(s => setSongs(s.filter(x => x.status === 'ready')))
      .catch(() => setError('Failed to load songs'));
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      unsubRef.current.forEach(fn => fn());
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current)  clearInterval(pollRef.current);
    };
  }, []);

  // ── Poll for players while in lobby (Realtime fallback) ──────────────────
  useEffect(() => {
    if (screen === 'lobby' && session) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const updated = await fetchPlayers(session.id);
        setPlayers(updated);
      }, 3000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  }, [screen, session]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handlePickSong(s: Song) {
    setError('');
    setSong(s);
    try {
      const sess = await createSession(s.id, HOST_ID);
      setSession(sess);

      // Subscribe to player + session changes
      const u1 = subscribeToPlayers(sess.id, setPlayers);
      const u2 = subscribeToSession(sess.id, setSession);
      unsubRef.current = [u1, u2];

      // Initial player fetch
      setPlayers(await fetchPlayers(sess.id));
      setScreen('lobby');
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  async function handleStart() {
    if (!session) return;
    setError('');
    try {
      await startSession(session.id);
      setElapsed(0);
      setScreen('playing');

      // Elapsed timer
      timerRef.current = setInterval(() => {
        setElapsed(prev => {
          if (!song) return prev;
          if (prev >= song.duration) {
            handleEnd();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  const handleEnd = useCallback(async () => {
    if (!session) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { await endSession(session.id); } catch { /* ignore */ }
    setPlayers(await fetchPlayers(session.id));
    setScreen('ended');
  }, [session]);

  function handleReset() {
    unsubRef.current.forEach(fn => fn());
    unsubRef.current = [];
    setSong(null);
    setSession(null);
    setPlayers([]);
    setElapsed(0);
    setScreen('idle');
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">

      {/* Top bar */}
      <header className="flex items-center gap-4 px-6 py-3 bg-gray-900 border-b border-gray-800 flex-shrink-0">
        <span className="font-bold text-emerald-400 font-mono text-lg tracking-tight">🎤 Vocal Hero</span>
        {song && <span className="text-gray-300 text-sm truncate flex-1">{song.title}{song.artist ? ` — ${song.artist}` : ''}</span>}
        {session && screen !== 'idle' && (
          <span className="text-xs bg-gray-800 border border-gray-600 px-3 py-1 rounded-full font-mono tracking-widest">
            Room: <strong className="text-yellow-300">{session.room_code}</strong>
          </span>
        )}
        {screen === 'playing' && song && (
          <span className="text-xs text-gray-400 tabular-nums font-mono">
            {fmtTime(elapsed)} / {fmtTime(song.duration)}
          </span>
        )}
        {screen !== 'idle' && (
          <button
            onClick={handleReset}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors ml-auto"
          >
            ✕ Exit
          </button>
        )}
      </header>

      {error && (
        <div className="bg-red-900/50 border-b border-red-700 text-red-300 text-sm px-6 py-2">
          {error}
        </div>
      )}

      {/* Screens */}
      <main className="flex-1 overflow-auto">
        {screen === 'idle'    && <IdleScreen    songs={songs}   onPick={handlePickSong} />}
        {screen === 'lobby'   && session && song && (
          <LobbyScreen session={session} song={song} players={players} onStart={handleStart} />
        )}
        {screen === 'playing' && session && song && (
          <PlayingScreen song={song} players={players} elapsed={elapsed} onEnd={handleEnd} />
        )}
        {screen === 'ended'   && song && (
          <EndedScreen song={song} players={players} onReset={handleReset} />
        )}
      </main>
    </div>
  );
}

// ── IdleScreen ─────────────────────────────────────────────────────────────

function IdleScreen({ songs, onPick }: { songs: Song[]; onPick: (s: Song) => void }) {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h2 className="text-xl font-semibold mb-6 text-gray-200">Pick a Song to Start</h2>
      {songs.length === 0 && (
        <div className="text-gray-500 text-center py-16">
          <p className="text-4xl mb-3">🎵</p>
          <p>No ready songs yet.</p>
          <a href="/vocal-hero/library" className="text-emerald-400 hover:underline text-sm mt-2 block">
            → Go to Song Library to add one
          </a>
        </div>
      )}
      <div className="space-y-3">
        {songs.map(s => (
          <button
            key={s.id}
            onClick={() => onPick(s)}
            className="w-full text-left bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-emerald-600 rounded-xl p-4 transition-all group"
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎵</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm group-hover:text-emerald-300 transition-colors">{s.title}</p>
                <p className="text-gray-400 text-xs">{s.artist} · {fmtTime(s.duration)} · {s.prim_lang?.toUpperCase()}</p>
              </div>
              <div className="flex gap-1">
                {(s.parts ?? []).slice(0, 4).map((_, i) => (
                  <span key={i} className="w-2 h-2 rounded-full" style={{ background: PART_COLOURS[i] }} />
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── LobbyScreen ────────────────────────────────────────────────────────────

function LobbyScreen({
  session, song, players, onStart,
}: {
  session: GameSession;
  song: Song;
  players: SessionPlayer[];
  onStart: () => void;
}) {
  const phoneUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/vocal-hero/phone?room=${session.room_code}`
    : '';

  const qrSrc = phoneUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=111827&color=ffffff&data=${encodeURIComponent(phoneUrl)}`
    : '';

  return (
    <div className="max-w-3xl mx-auto p-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">

        {/* QR + join info */}
        <div className="flex flex-col items-center gap-4 bg-gray-900 border border-gray-700 rounded-2xl p-6">
          {qrSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrSrc} alt="Join QR code" className="rounded-xl w-48 h-48" />
          )}
          <p className="text-gray-400 text-sm text-center">Scan to join on your phone</p>
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-1">Room code</p>
            <p className="text-4xl font-bold font-mono tracking-widest text-yellow-300">{session.room_code}</p>
          </div>
          <p className="text-xs text-gray-600 text-center break-all">{phoneUrl}</p>
        </div>

        {/* Song info + player list */}
        <div className="flex flex-col gap-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Song</p>
            <p className="font-semibold">{song.title}</p>
            <p className="text-gray-400 text-sm">{song.artist}</p>
            <p className="text-gray-500 text-xs mt-1">{fmtTime(song.duration)}</p>
          </div>

          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 flex-1">
            <p className="text-xs text-gray-500 mb-2">Players ({players.length})</p>
            {players.length === 0 && (
              <p className="text-gray-600 text-sm">Waiting for players to join…</p>
            )}
            <div className="space-y-2">
              {players.map(p => (
                <div key={p.id} className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: PART_COLOURS[p.part_index] ?? '#fff' }}
                  />
                  <span className="text-sm font-medium">{p.player_name}</span>
                  <span className="text-xs text-gray-500">{PART_NAMES[p.part_index]}</span>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={onStart}
            disabled={players.length === 0}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl transition-colors text-lg"
          >
            {players.length === 0 ? 'Waiting for players…' : '▶ Start Game'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── YouTube helpers ────────────────────────────────────────────────────────

function extractYtId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── PlayingScreen ──────────────────────────────────────────────────────────

function PlayingScreen({
  song, players, elapsed, onEnd,
}: {
  song: Song;
  players: SessionPlayer[];
  elapsed: number;
  onEnd: () => void;
}) {
  const progress = song.duration > 0 ? elapsed / song.duration : 0;
  const videoId  = song.yt_url ? extractYtId(song.yt_url) : null;

  // Current lyric — only from manually-placed notes in the piano roll
  const currentNote = (song.notes ?? []).find(n => elapsed >= n.start && elapsed < n.end && n.lyric);
  const lyric = currentNote ? { primary: currentNote.lyric, translation: '' } : null;

  return (
    <div className="flex flex-col h-full p-4 gap-4">

      {/* YouTube mini player — must be visible for autoplay to work */}
      {videoId && (
        <iframe
          key={videoId}
          src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`}
          allow="autoplay; encrypted-media"
          style={{ width: '100%', height: 36, borderRadius: 8, border: 'none', opacity: 0.01, pointerEvents: 'none', flexShrink: 0 }}
          title="music"
        />
      )}

      {/* Progress bar */}
      <div className="w-full bg-gray-800 rounded-full h-1.5">
        <div
          className="bg-emerald-500 h-1.5 rounded-full transition-all"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Current lyric — top, above the rolls */}
      <div className="text-center min-h-[2.5rem] flex flex-col items-center justify-center">
        {lyric ? (
          <>
            <p className="text-2xl font-bold text-white leading-tight">{lyric.primary}</p>
            {lyric.translation && (
              <p className="text-sm text-gray-400 mt-0.5 italic">{lyric.translation}</p>
            )}
          </>
        ) : (
          <p className="text-gray-600 text-sm">♪ ♪ ♪</p>
        )}
      </div>

      {/* SATB piano rolls */}
      <div className="grid grid-cols-2 gap-3 flex-1 min-h-0">
        {[0, 1, 2, 3].map(i => {
          const partPlayers = players.filter(p => p.part_index === i);
          return (
            <PianoRollCanvas
              key={i}
              partIndex={i}
              progress={progress}
              players={partPlayers}
              notes={song.notes ?? []}
              songDuration={song.duration}
            />
          );
        })}
      </div>

      {/* Live leaderboard + end button */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex gap-3 flex-wrap flex-1">
          {[...players]
            .sort((a, b) => b.score - a.score)
            .slice(0, 6)
            .map((p, rank) => (
              <div key={p.id} className="flex items-center gap-1.5 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1">
                <span className="text-xs text-gray-500">#{rank + 1}</span>
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: PART_COLOURS[p.part_index] }}
                />
                <span className="text-xs font-medium">{p.player_name}</span>
                <span className="text-xs text-emerald-400 font-mono">{p.score}</span>
              </div>
            ))}
        </div>
        <button
          onClick={onEnd}
          className="bg-red-800 hover:bg-red-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors flex-shrink-0"
        >
          End Game
        </button>
      </div>
    </div>
  );
}

// ── PianoRollCanvas (host) ────────────────────────────────────────────────
// Draws note blocks like a piano roll. Each of the 24 keyframes = one block
// placed vertically by its normalised pitch. Playhead sweeps left→right.

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // roundRect polyfill
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// MIDI range must match the editor constants
const GAME_MIDI_LO = 36;
const GAME_MIDI_HI = 84;

function PianoRollCanvas({
  partIndex, progress, players, notes, songDuration,
}: {
  partIndex: number;
  progress: number;
  players: SessionPlayer[];
  notes: SongNote[];
  songDuration?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colour    = PART_COLOURS[partIndex] ?? '#fff';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width  = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    // Horizontal pitch lanes
    for (let lane = 0; lane <= 8; lane++) {
      const y = (lane / 8) * H;
      ctx.strokeStyle = lane % 2 === 0 ? '#1e293b' : '#172033';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const dur     = Math.max(songDuration ?? 1, 1);
    const noteH   = Math.max(10, H * 0.12);
    const pad     = 2;
    const elapsed = progress * dur;

    // Only render notes assigned to this part from the piano roll
    const partNotes = notes.filter(n => n.part === partIndex);

    partNotes.forEach(n => {
      const norm   = (n.midi - GAME_MIDI_LO) / (GAME_MIDI_HI - GAME_MIDI_LO);
      const x      = (n.start / dur) * W + pad;
      const w      = Math.max(4, ((n.end - n.start) / dur) * W - pad * 2);
      const y      = H - norm * (H - noteH * 1.5) - noteH;
      const isPast = n.end < elapsed - 0.2;
      const isCurr = elapsed >= n.start && elapsed < n.end;

      ctx.fillStyle   = isCurr ? colour : isPast ? colour + '33' : colour + '55';
      ctx.strokeStyle = isCurr ? colour : 'transparent';
      ctx.lineWidth   = 2;
      rr(ctx, x, Math.max(4, y), w, noteH, 4);
      ctx.fill();
      if (isCurr) ctx.stroke();

      // Lyric inside note
      if (n.lyric && w > 20) {
        ctx.fillStyle = isCurr ? '#fff' : '#ffffff88';
        ctx.font      = `bold ${Math.min(10, noteH - 4)}px system-ui,sans-serif`;
        ctx.fillText(n.lyric, x + 4, Math.max(4, y) + noteH - 3, w - 6);
      }
    });

    // Playhead
    const px = progress * W;
    ctx.strokeStyle = '#ffffffaa';
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.setLineDash([]);

    // Part label
    ctx.fillStyle = colour;
    ctx.font      = 'bold 11px monospace';
    ctx.fillText(PART_NAMES[partIndex], 8, 16);

    if (players.length > 0) {
      ctx.fillStyle = colour;
      ctx.font      = '10px monospace';
      ctx.fillText(`${players.length}×`, W - 24, 16);
    }

    // Empty state hint
    if (partNotes.length === 0) {
      ctx.fillStyle = colour + '33';
      ctx.font      = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No notes assigned', W / 2, H / 2);
      ctx.textAlign = 'left';
    }

  }, [partIndex, progress, players, notes, colour, songDuration]);

  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-800" style={{ minHeight: 140 }}>
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}

// ── EndedScreen ────────────────────────────────────────────────────────────

function EndedScreen({
  song, players, onReset,
}: {
  song: Song;
  players: SessionPlayer[];
  onReset: () => void;
}) {
  const sorted = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className="max-w-xl mx-auto p-8">
      <div className="text-center mb-8">
        <p className="text-5xl mb-3">🏆</p>
        <h2 className="text-2xl font-bold text-yellow-300">Game Over!</h2>
        <p className="text-gray-400 text-sm mt-1">{song.title}</p>
      </div>

      <div className="space-y-3 mb-8">
        {sorted.map((p, rank) => (
          <div
            key={p.id}
            className="flex items-center gap-3 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3"
          >
            <span className="text-lg font-bold w-8 text-center">
              {rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : `#${rank + 1}`}
            </span>
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ background: PART_COLOURS[p.part_index] }}
            />
            <span className="flex-1 font-semibold">{p.player_name}</span>
            <span className="text-xs text-gray-400">{PART_NAMES[p.part_index]}</span>
            <span className="font-mono text-emerald-400 font-bold text-lg">{p.score}</span>
          </div>
        ))}
        {sorted.length === 0 && (
          <p className="text-gray-500 text-center">No players scored.</p>
        )}
      </div>

      <button
        onClick={onReset}
        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition-colors"
      >
        Play Again
      </button>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
