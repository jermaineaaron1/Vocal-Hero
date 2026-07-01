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
  subscribeToNoteResults,
  setSessionPaused,
  restartSession,
} from '@/lib/vocal-hero/supabaseClient';
import { SatbLane } from './SatbLane';
import type { Song, GameSession, SessionPlayer } from '@/lib/vocal-hero/types';

// ── Constants ──────────────────────────────────────────────────────────────

const PART_COLOURS = ['#f472b6', '#fb923c', '#60a5fa', '#34d399']; // S A T B
const PART_NAMES   = ['Soprano', 'Alto', 'Tenor', 'Bass'];
const HOST_ID      = 'host';

const C = {
  bg: '#0b1026', bg2: '#161a40', ink: '#f4f1e6', muted: '#9aa0c8',
  gold: '#f0b429', goldSoft: '#ffd97a', line: '#2c3470',
};

type Screen = 'idle' | 'lobby' | 'playing' | 'ended';

// ── Component ──────────────────────────────────────────────────────────────

export default function VocalHeroHostPage() {
  const [screen,   setScreen]   = useState<Screen>('idle');
  const [songs,    setSongs]    = useState<Song[]>([]);
  const [song,     setSong]     = useState<Song | null>(null);
  const [session,  setSession]  = useState<GameSession | null>(null);
  const [players,  setPlayers]  = useState<SessionPlayer[]>([]);
  const [elapsed,  setElapsed]  = useState(0);
  const [elapsedHiRes, setElapsedHiRes] = useState(0);
  const [noteResults, setNoteResults]   = useState<Record<string, boolean>>({});
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error,    setError]    = useState('');

  const timerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef          = useRef<(() => void)[]>([]);
  const rafRef            = useRef<number | null>(null);
  const playStartRef      = useRef(0);
  const countdownRafRef   = useRef<number | null>(null);
  const elapsedHiResRef   = useRef(0);   // mirrors state — avoids stale closure on pause
  const pausedRef         = useRef(false);
  const lastRestartSeqRef = useRef<number | undefined>(undefined);
  const songRef           = useRef<Song | null>(null); // stable ref for timer callbacks

  // Keep songRef in sync
  useEffect(() => { songRef.current = song; }, [song]);

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
      if (rafRef.current)   cancelAnimationFrame(rafRef.current);
      if (countdownRafRef.current) cancelAnimationFrame(countdownRafRef.current);
    };
  }, []);

  // ── Poll for players while in lobby ──────────────────────────────────────
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

  // ── Smooth scrolling rAF loop — extracted so pause/restart can reuse it ──
  const beginPlayback = useCallback(() => {
    playStartRef.current = performance.now() - elapsedHiResRef.current * 1000;
    const rafTick = () => {
      const t = (performance.now() - playStartRef.current) / 1000;
      elapsedHiResRef.current = t;
      setElapsedHiRes(t);
      rafRef.current = requestAnimationFrame(rafTick);
    };
    rafRef.current = requestAnimationFrame(rafTick);
  }, []);

  // ── 1Hz elapsed timer — extracted so pause/restart can reuse it ──────────
  const beginTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setElapsed(prev => {
        const s = songRef.current;
        if (!s) return prev;
        if (prev >= s.duration) {
          handleEnd();
          return prev;
        }
        return prev + 1;
      });
    }, 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pause-reaction ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session || screen !== 'playing') return;
    if (session.paused) {
      // Freeze animation and score timer
      pausedRef.current = true;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    } else if (pausedRef.current) {
      // Resume from frozen position
      pausedRef.current = false;
      beginPlayback();
      beginTimer();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.paused, screen]);

  // ── Restart-reaction ──────────────────────────────────────────────────────
  useEffect(() => {
    const seq = session?.restart_seq;
    if (seq === undefined) return;
    if (lastRestartSeqRef.current === undefined) {
      lastRestartSeqRef.current = seq;
      return;
    }
    if (seq <= lastRestartSeqRef.current) return;
    lastRestartSeqRef.current = seq;

    // Cancel any in-progress playback
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (countdownRafRef.current) { cancelAnimationFrame(countdownRafRef.current); countdownRafRef.current = null; }

    // Reset state
    elapsedHiResRef.current = 0;
    pausedRef.current = false;
    setElapsed(0);
    setElapsedHiRes(0);
    setNoteResults({});
    setCountdown(null);
    setScreen('playing');

    runCountdown().then(() => {
      beginTimer();
      beginPlayback();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.restart_seq]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handlePickSong(s: Song) {
    setError('');
    setSong(s);
    try {
      const sess = await createSession(s.id, HOST_ID);
      setSession(sess);

      const u1 = subscribeToPlayers(sess.id, setPlayers);
      const u2 = subscribeToSession(sess.id, setSession);
      const u3 = subscribeToNoteResults(sess.id, r =>
        setNoteResults(prev => ({ ...prev, [r.noteId]: r.hit }))
      );
      unsubRef.current = [u1, u2, u3];

      setPlayers(await fetchPlayers(sess.id));
      setScreen('lobby');
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  function runCountdown(durationSec = 5): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now();
      const tick = () => {
        const sec = (performance.now() - start) / 1000;
        if (sec >= durationSec) {
          setCountdown(null);
          elapsedHiResRef.current = 0;
          setElapsedHiRes(0);
          countdownRafRef.current = null;
          resolve();
          return;
        }
        elapsedHiResRef.current = sec - durationSec;
        setElapsedHiRes(sec - durationSec);
        setCountdown(Math.ceil(durationSec - sec));
        countdownRafRef.current = requestAnimationFrame(tick);
      };
      countdownRafRef.current = requestAnimationFrame(tick);
    });
  }

  async function handleStart() {
    if (!session) return;
    setError('');
    try {
      await startSession(session.id);
      elapsedHiResRef.current = 0;
      setElapsed(0);
      setElapsedHiRes(0);
      setScreen('playing');

      await runCountdown();

      beginTimer();
      beginPlayback();
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  const handleEnd = useCallback(async () => {
    if (!session) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (rafRef.current)   { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (countdownRafRef.current) { cancelAnimationFrame(countdownRafRef.current); countdownRafRef.current = null; }
    setCountdown(null);
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
    setElapsedHiRes(0);
    elapsedHiResRef.current = 0;
    setNoteResults({});
    setCountdown(null);
    pausedRef.current = false;
    lastRestartSeqRef.current = undefined;
    setScreen('idle');
  }

  async function handlePause() {
    if (!session) return;
    try {
      await setSessionPaused(session.id, !session.paused);
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  async function handleRestart() {
    if (!session) return;
    try {
      await restartSession(session.id);
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen text-white flex flex-col"
      style={{
        background: `radial-gradient(120% 80% at 80% -10%, rgba(240,180,41,.18), transparent 55%), radial-gradient(120% 90% at 10% 110%, rgba(90,209,155,.12), transparent 50%), linear-gradient(160deg, ${C.bg}, ${C.bg2})`,
        fontFamily: '"DM Mono", monospace',
      }}
    >
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Top bar */}
      <header
        className="flex items-center gap-4 px-6 py-3 flex-shrink-0"
        style={{ background: 'rgba(255,255,255,.03)', borderBottom: `1px solid ${C.line}` }}
      >
        <span className="font-extrabold text-lg tracking-tight" style={{ fontFamily: '"Fraunces", serif', color: C.gold }}>
          VOCAL<span style={{ color: C.ink }}>hero</span>
        </span>
        {song && <span className="text-sm truncate flex-1" style={{ color: C.muted }}>{song.title}{song.artist ? ` — ${song.artist}` : ''}</span>}
        {session && screen !== 'idle' && (
          <span className="text-xs px-3 py-1 rounded-full tracking-widest" style={{ background: 'rgba(255,255,255,.04)', border: `1px solid ${C.line}` }}>
            Room: <strong style={{ color: C.goldSoft }}>{session.room_code}</strong>
          </span>
        )}
        {screen === 'playing' && song && (
          <span className="text-xs tabular-nums" style={{ color: C.muted }}>
            {fmtTime(elapsed)} / {fmtTime(song.duration)}
          </span>
        )}
        {screen !== 'idle' && (
          <button
            onClick={handleReset}
            className="text-xs transition-colors ml-auto"
            style={{ color: C.muted }}
            onMouseEnter={e => (e.currentTarget.style.color = '#e05a6b')}
            onMouseLeave={e => (e.currentTarget.style.color = C.muted)}
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
          <PlayingScreen
            song={song}
            players={players}
            elapsed={elapsed}
            elapsedHiRes={elapsedHiRes}
            noteResults={noteResults}
            countdown={countdown}
            isPaused={!!session.paused}
            onEnd={handleEnd}
            onPause={handlePause}
            onRestart={handleRestart}
          />
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
    <div className="max-w-xl mx-auto px-6 py-12 flex flex-col items-center text-center">
      <div className="font-extrabold tracking-tight" style={{ fontFamily: '"Fraunces", serif', lineHeight: 0.9 }}>
        <span className="block" style={{ fontSize: 'clamp(40px,10vw,80px)', color: C.gold, fontStyle: 'italic' }}>VOCAL</span>
        <span className="block" style={{ fontSize: 'clamp(40px,10vw,80px)', color: C.ink }}>hero</span>
      </div>
      <p className="mt-4 text-sm max-w-sm" style={{ color: C.muted }}>
        Pick a song to start a session.
      </p>

      {songs.length === 0 && (
        <div className="text-center py-16" style={{ color: C.muted }}>
          <p className="text-4xl mb-3">🎵</p>
          <p>No ready songs yet.</p>
          <a href="/vocal-hero/library" className="hover:underline text-sm mt-2 block" style={{ color: C.gold }}>
            → Go to Song Library to add one
          </a>
        </div>
      )}

      <div className="mt-8 flex flex-col gap-3 w-full" style={{ maxWidth: 440 }}>
        {songs.map(s => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-2xl px-4 py-3 transition-colors"
            style={{ background: 'rgba(255,255,255,.04)', border: `1px solid ${C.line}` }}
          >
            <button
              onClick={() => onPick(s)}
              className="flex-1 min-w-0 text-left flex items-center gap-3 cursor-pointer"
            >
              <span className="text-2xl">🎵</span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate" style={{ color: C.ink }}>{s.title}</p>
                <p className="text-xs truncate" style={{ color: C.muted }}>{s.artist} · {fmtTime(s.duration)} · {s.prim_lang?.toUpperCase()}</p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {(s.parts ?? []).slice(0, 4).map((_, i) => (
                  <span key={i} className="w-2 h-2 rounded-full" style={{ background: PART_COLOURS[i] }} />
                ))}
              </div>
            </button>
            <div className="flex gap-2 flex-shrink-0">
              <a
                href={`/vocal-hero/library/${s.id}/edit`}
                onClick={e => e.stopPropagation()}
                className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: 'transparent', border: `1px solid ${C.gold}`, color: C.goldSoft }}
              >
                ✏ Edit
              </a>
              <button
                onClick={() => onPick(s)}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: C.gold, color: C.bg }}
              >
                ▶ Play
              </button>
            </div>
          </div>
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
  song, players, elapsed, elapsedHiRes, noteResults, countdown, isPaused, onEnd, onPause, onRestart,
}: {
  song: Song;
  players: SessionPlayer[];
  elapsed: number;
  elapsedHiRes: number;
  noteResults: Record<string, boolean>;
  countdown: number | null;
  isPaused: boolean;
  onEnd: () => void;
  onPause: () => void;
  onRestart: () => void;
}) {
  const progress = song.duration > 0 ? elapsed / song.duration : 0;
  const videoId  = song.yt_url ? extractYtId(song.yt_url) : null;

  const sopranoNote = (song.notes ?? []).find(n => n.part === 0 && elapsedHiRes >= n.start && elapsedHiRes < n.end && n.lyric);

  return (
    <div className="flex flex-col h-full p-4 gap-4 relative">
      {countdown !== null && (
        <div
          className="absolute inset-0 flex items-center justify-center z-50"
          style={{ background: (countdown ?? 0) > 3 ? 'rgba(0,0,0,0.6)' : 'transparent' }}
        >
          <span className="text-9xl font-extrabold" style={{ color: '#f0b429' }}>
            {countdown > 0 ? countdown : 'Sing!'}
          </span>
        </div>
      )}

      {/* YouTube mini player */}
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

      {/* SATB lanes */}
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <div className="text-center min-h-[2rem] flex items-center justify-center">
          {sopranoNote ? (
            <p className="text-xl font-bold text-white leading-tight">{sopranoNote.lyric}</p>
          ) : (
            <p className="text-gray-600 text-sm">♪ ♪ ♪</p>
          )}
        </div>
        {[0, 1, 2, 3].map(i => {
          const partPlayers = players.filter(p => p.part_index === i);
          return (
            <SatbLane
              key={i}
              partIndex={i}
              partName={PART_NAMES[i]}
              colour={PART_COLOURS[i]}
              elapsed={elapsedHiRes}
              notes={song.notes ?? []}
              playerCount={partPlayers.length}
              noteResults={noteResults}
            />
          );
        })}
      </div>

      {/* Live leaderboard + game controls */}
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
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={onPause}
            className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            style={{ background: isPaused ? '#16a34a' : '#374151', color: '#fff', border: '1px solid #4b5563' }}
          >
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button
            onClick={onRestart}
            className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors bg-gray-700 hover:bg-gray-600 text-white border border-gray-600"
          >
            ↺ Restart
          </button>
          <button
            onClick={onEnd}
            className="bg-red-800 hover:bg-red-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            End Game
          </button>
        </div>
      </div>
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
