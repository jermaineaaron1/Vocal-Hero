'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import {
  supabase,
  fetchSessionByCode,
  fetchSong,
  joinSession,
  subscribeToSession,
  openNoteResultsChannel,
  setSessionPaused,
  restartSession,
} from '@/lib/vocal-hero/supabaseClient';
import { PitchEngine } from '@/lib/vocal-hero/pitchEngine';
import { ScoreEngine, CENT_TOLERANCE } from '@/lib/vocal-hero/scoreEngine';
import { SatbLane } from '../SatbLane';
import type { Song, GameSession, SessionPlayer, SatbPart, SongNote } from '@/lib/vocal-hero/types';

const PART_NAMES   = ['Soprano', 'Alto', 'Tenor', 'Bass'];
const PART_COLOURS = ['#f472b6', '#fb923c', '#60a5fa', '#34d399'];
const PART_RANGES  = [
  { label: 'High female voice',    min: 260, max: 1050 },
  { label: 'Low female voice',     min: 175, max: 700  },
  { label: 'High male voice',      min: 130, max: 525  },
  { label: 'Low male voice',       min: 80,  max: 330  },
];

type Screen = 'join' | 'lobby' | 'playing' | 'ended';

// ── Wrapped with Suspense for useSearchParams ──────────────────────────────

export default function PhonePage() {
  return (
    <Suspense fallback={<FullScreenMsg>Loading…</FullScreenMsg>}>
      <PhonePageInner />
    </Suspense>
  );
}

function PhonePageInner() {
  const params = useSearchParams();
  const initialRoom = params.get('room') ?? '';

  const [screen,  setScreen]  = useState<Screen>('join');
  const [room,    setRoom]    = useState(initialRoom.toUpperCase());
  const [name,    setName]    = useState('');
  const [partIdx, setPartIdx] = useState(0);
  const [session, setSession] = useState<GameSession | null>(null);
  const [song,    setSong]    = useState<Song | null>(null);
  const [player,  setPlayer]  = useState<SessionPlayer | null>(null);
  const [error,   setError]   = useState('');
  const [joining, setJoining] = useState(false);
  const [isSpectator, setIsSpectator] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Pitch / score state
  const [pitchHz,      setPitchHz]      = useState(0);
  const [targetNorm,   setTargetNorm]   = useState(0);
  const [localScore,   setLocalScore]   = useState(0);
  const [centsDiff,    setCentsDiff]    = useState(0);
  const [elapsed,      setElapsed]      = useState(0);
  const [elapsedHiRes, setElapsedHiRes] = useState(0);
  const [noteResults,  setNoteResults]  = useState<Record<string, boolean>>({});
  const [micAllowed,   setMicAllowed]   = useState<boolean | null>(null);

  const pitchRef          = useRef<PitchEngine | null>(null);
  const scoreRef          = useRef<ScoreEngine | null>(null);
  const timerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef          = useRef<(() => void) | null>(null);
  const noteChannelRef    = useRef<ReturnType<typeof openNoteResultsChannel> | null>(null);
  const countdownRafRef   = useRef<number | null>(null);

  // Pause state
  const pausedRef         = useRef(false);
  const pauseAccumMsRef   = useRef(0);   // total wall-clock ms spent paused
  const pauseWallStartRef = useRef(0);   // wall time when current pause began
  const lastTimestampRef  = useRef(0);   // last AudioContext timestamp seen in onPitch

  // Restart state
  const lastRestartSeqRef = useRef<number | undefined>(undefined);

  // Stable refs for callbacks
  const songRef       = useRef<Song | null>(null);
  const partIdxRef    = useRef(0);
  const sessionRef    = useRef<GameSession | null>(null);
  const isSpectatorRef = useRef(false);
  const playerRef     = useRef<SessionPlayer | null>(null);

  useEffect(() => { songRef.current = song; }, [song]);
  useEffect(() => { partIdxRef.current = partIdx; }, [partIdx]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { isSpectatorRef.current = isSpectator; }, [isSpectator]);
  useEffect(() => { playerRef.current = player; }, [player]);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      pitchRef.current?.stop();
      scoreRef.current?.stop();
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current)  clearInterval(pollRef.current);
      if (countdownRafRef.current) cancelAnimationFrame(countdownRafRef.current);
      unsubRef.current?.();
      if (noteChannelRef.current) supabase.removeChannel(noteChannelRef.current);
    };
  }, []);

  // ── Poll session status while in lobby or playing ────────────────────────
  // During lobby: detects game start. During playing: fallback for
  // pause/restart when Realtime WebSocket is unreliable.
  useEffect(() => {
    if ((screen === 'lobby' || screen === 'playing') && session) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const updated = await import('@/lib/vocal-hero/supabaseClient')
          .then(m => m.fetchSession(session.id));
        if (updated) setSession(updated);
      }, 1000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, session?.id]);

  // ── Game start triggered by session status change ─────────────────────────
  useEffect(() => {
    if (session?.status === 'playing' && screen === 'lobby') {
      handleGameStart();
    }
    if (session?.status === 'ended' && screen === 'playing') {
      handleGameEnd();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status]);

  // ── Pause-reaction ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!session || screen !== 'playing') return;
    if (session.paused) {
      pausedRef.current = true;
      pauseWallStartRef.current = performance.now();
    } else if (pausedRef.current) {
      // Resume — accumulate the wall time spent paused so we can subtract it
      // from the AudioContext clock to keep elapsedHiRes continuous.
      pausedRef.current = false;
      pauseAccumMsRef.current += performance.now() - pauseWallStartRef.current;
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

    // Stop everything and restart
    pitchRef.current?.stop(); pitchRef.current = null;
    scoreRef.current?.stop(); scoreRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (countdownRafRef.current) { cancelAnimationFrame(countdownRafRef.current); countdownRafRef.current = null; }
    if (noteChannelRef.current) { supabase.removeChannel(noteChannelRef.current); noteChannelRef.current = null; }

    // Reset pause/time accumulators
    pausedRef.current = false;
    pauseAccumMsRef.current = 0;
    lastTimestampRef.current = 0;

    // Reset UI state
    setElapsed(0); setElapsedHiRes(0); setLocalScore(0); setNoteResults({});
    setPitchHz(0); setTargetNorm(0); setCentsDiff(0); setCountdown(null);

    // Re-enter game flow
    handleGameStart();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.restart_seq]);

  // ── Join ─────────────────────────────────────────────────────────────────
  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Enter your name'); return; }
    if (!room.trim())  { setError('Enter a room code'); return; }
    setError('');
    setJoining(true);

    try {
      const sess = await fetchSessionByCode(room);
      if (!sess) { setError('Room not found. Check the code and try again.'); return; }
      if (sess.status === 'ended') { setError('That game has already ended.'); return; }

      const s = await fetchSong(sess.song_id);
      if (!s) { setError('Song not found.'); return; }

      const p = await joinSession(sess.id, name.trim(), partIdx);
      setSession(sess);
      setSong(s);
      setPlayer(p);

      unsubRef.current = subscribeToSession(sess.id, updated => setSession(updated));

      setScreen(sess.status === 'playing' ? 'playing' : 'lobby');
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setJoining(false);
    }
  }

  // ── Watch (spectator) ─────────────────────────────────────────────────────
  async function handleWatch() {
    if (!room.trim()) { setError('Enter a room code'); return; }
    setError('');
    setJoining(true);

    try {
      const sess = await fetchSessionByCode(room);
      if (!sess) { setError('Room not found. Check the code and try again.'); return; }
      if (sess.status === 'ended') { setError('That game has already ended.'); return; }

      const s = await fetchSong(sess.song_id);
      if (!s) { setError('Song not found.'); return; }

      setIsSpectator(true);
      setSession(sess);
      setSong(s);

      unsubRef.current = subscribeToSession(sess.id, updated => setSession(updated));

      setScreen(sess.status === 'playing' ? 'playing' : 'lobby');
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setJoining(false);
    }
  }

  // ── Piano preview — plays first 3 notes of the singer's part as piano tones ──
  function playPreviewNotes(pIdx: number, notes: SongNote[]) {
    const partNotes = notes
      .filter(n => n.part === pIdx)
      .slice()
      .sort((a, b) => a.start - b.start)
      .slice(0, 3);
    if (partNotes.length === 0) return;

    try {
      const ctx = new AudioContext();
      partNotes.forEach((note, i) => {
        const hz   = 440 * Math.pow(2, (note.midi - 69) / 12);
        const when = ctx.currentTime + i * 0.8;
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.25, when);
        gain.gain.exponentialRampToValueAtTime(0.001, when + 0.6);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(when);
        osc.stop(when + 0.65);
      });
      // AudioContext self-GCs once all oscillators stop
    } catch {
      // Non-fatal — preview is best-effort (blocked by browser policy, etc.)
    }
  }

  // ── Countdown lead-in ────────────────────────────────────────────────────
  function runCountdown(durationSec = 5): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now();
      const tick = () => {
        const sec = (performance.now() - start) / 1000;
        if (sec >= durationSec) {
          setCountdown(null);
          setElapsedHiRes(0);
          countdownRafRef.current = null;
          resolve();
          return;
        }
        setElapsedHiRes(sec - durationSec);
        setCountdown(Math.ceil(durationSec - sec));
        countdownRafRef.current = requestAnimationFrame(tick);
      };
      countdownRafRef.current = requestAnimationFrame(tick);
    });
  }

  // ── Game start ────────────────────────────────────────────────────────────
  const handleGameStart = useCallback(async () => {
    const song      = songRef.current;
    const player    = playerRef.current;
    const pIdx      = partIdxRef.current;
    const spectator = isSpectatorRef.current;
    const sess      = sessionRef.current;

    if (!song) return;
    if (!spectator && !player) return;
    const part: SatbPart | undefined = spectator ? undefined : (song.parts?.[pIdx] ?? song.parts?.[0]);
    if (!spectator && !part) return;

    setScreen('playing');
    setElapsed(0);
    setElapsedHiRes(0);
    setLocalScore(0);
    setNoteResults({});

    // Open note-results broadcast channel (spectators receive only, singers send+receive)
    const noteChannel = openNoteResultsChannel(sess!.id, r =>
      setNoteResults(prev => ({ ...prev, [r.noteId]: r.hit }))
    );
    noteChannelRef.current = noteChannel;

    // Piano preview fires at countdown start (before scoring/mic starts)
    if (!spectator) {
      playPreviewNotes(pIdx, song.notes ?? []);
    }

    // 5-second countdown — notes scroll in from the right, no scoring yet
    await runCountdown();

    if (spectator) {
      timerRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);
      return;
    }
    if (!part || !player) return;

    // Start score engine
    const score = new ScoreEngine({
      part,
      partIndex:    pIdx,
      notes:        song.notes ?? [],
      songDuration: song.duration,
      playerId:     player.id,
      sessionId:    sess!.id,
      difficulty:   'medium',
      onScoreUpdate: (_, total) => setLocalScore(total),
      onNoteResult: (result) => {
        const hit = result.points > 0;
        setNoteResults(prev => ({ ...prev, [result.noteId]: hit }));
        noteChannel.send({ type: 'broadcast', event: 'note_result', payload: { partIndex: pIdx, noteId: result.noteId, hit } });
      },
    });
    scoreRef.current = score;
    score.start();

    // Start pitch engine
    try {
      const engine = new PitchEngine({
        onPitch: ({ frequency, confidence, timestamp }) => {
          lastTimestampRef.current = timestamp;

          // While paused, freeze all updates — scoring and elapsed stop advancing
          if (pausedRef.current) return;

          // Subtract accumulated pause duration to keep elapsedHiRes continuous
          const adjusted = timestamp - pauseAccumMsRef.current / 1000;

          setPitchHz(frequency);
          setMicAllowed(true);
          setElapsedHiRes(adjusted);

          const currentPart = songRef.current?.parts?.[pIdx];
          if (!currentPart) return;

          const tgt = scoreRef.current?.targetNormAt(adjusted) ?? 0;
          setTargetNorm(tgt);
          const tgtHz = PitchEngine.denormalise(tgt, currentPart.rangeMin, currentPart.rangeMax);
          setCentsDiff(PitchEngine.centsDiff(frequency, tgtHz));

          if (confidence > 0.85) {
            scoreRef.current?.scorePitch(frequency, adjusted);
          }
        },
        confidenceThreshold: 0.85,
        smoothing: 0.75,
      });
      pitchRef.current = engine;
      await engine.start();
      setMicAllowed(true);
    } catch {
      setMicAllowed(false);
    }

    timerRef.current = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);
  // handleGameStart reads stable refs only — no reactive deps needed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Game end ──────────────────────────────────────────────────────────────
  const handleGameEnd = useCallback(async () => {
    pitchRef.current?.stop();
    pitchRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (countdownRafRef.current) { cancelAnimationFrame(countdownRafRef.current); countdownRafRef.current = null; }
    setCountdown(null);
    if (noteChannelRef.current) { supabase.removeChannel(noteChannelRef.current); noteChannelRef.current = null; }
    await scoreRef.current?.stop();
    scoreRef.current = null;
    setScreen('ended');
  }, []);

  // ── Pause/Restart controls ────────────────────────────────────────────────
  async function handlePauseToggle() {
    if (!session) return;
    try {
      await setSessionPaused(session.id, !session.paused);
    } catch { /* ignore */ }
  }

  async function handleRestart() {
    if (!session) return;
    try {
      await restartSession(session.id);
    } catch { /* ignore */ }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (screen === 'join')    return <JoinScreen room={room} setRoom={setRoom} name={name} setName={setName} partIdx={partIdx} setPartIdx={setPartIdx} onSubmit={handleJoin} onWatch={handleWatch} error={error} joining={joining} />;
  if (screen === 'lobby')   return <LobbyScreen song={song} partIdx={partIdx} isSpectator={isSpectator} />;
  if (screen === 'playing') return isSpectator ? (
    <SpectatorScreen
      song={song}
      elapsed={elapsedHiRes}
      noteResults={noteResults}
      countdown={countdown}
      isPaused={!!session?.paused}
      onPause={handlePauseToggle}
      onRestart={handleRestart}
    />
  ) : (
    <PlayingScreen
      song={song}
      partIdx={partIdx}
      elapsed={elapsed}
      elapsedHiRes={elapsedHiRes}
      pitchHz={pitchHz}
      targetNorm={targetNorm}
      centsDiff={centsDiff}
      localScore={localScore}
      micAllowed={micAllowed}
      noteResults={noteResults}
      countdown={countdown}
      isPaused={!!session?.paused}
      onPause={handlePauseToggle}
      onRestart={handleRestart}
    />
  );
  if (screen === 'ended')   return <EndedScreen localScore={localScore} partIdx={partIdx} playerName={player?.player_name ?? ''} />;
  return null;
}

// ── JoinScreen ────────────────────────────────────────────────────────────

function JoinScreen({ room, setRoom, name, setName, partIdx, setPartIdx, onSubmit, onWatch, error, joining }: {
  room: string; setRoom: (v: string) => void;
  name: string; setName: (v: string) => void;
  partIdx: number; setPartIdx: (v: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  onWatch: () => void;
  error: string; joining: boolean;
}) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <p className="text-5xl mb-2">🎤</p>
          <h1 className="text-2xl font-bold text-emerald-400 font-mono">Vocal Hero</h1>
          <p className="text-gray-400 text-sm mt-1">Join a game and sing your part</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Room Code</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded-xl px-4 py-3 text-center text-2xl font-mono font-bold tracking-widest uppercase focus:outline-none"
              placeholder="XXXXX"
              maxLength={5}
              value={room}
              onChange={e => setRoom(e.target.value.toUpperCase())}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Your Name</label>
            <input
              className="w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded-xl px-4 py-3 text-sm focus:outline-none"
              placeholder="e.g. Mary"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2">Choose Your Part</label>
            <div className="grid grid-cols-2 gap-2">
              {PART_NAMES.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPartIdx(i)}
                  className={`rounded-xl py-3 px-2 text-sm font-semibold border transition-all ${
                    partIdx === i
                      ? 'border-transparent text-white'
                      : 'border-gray-700 text-gray-400 bg-gray-900 hover:border-gray-500'
                  }`}
                  style={partIdx === i ? { background: PART_COLOURS[i] + '33', borderColor: PART_COLOURS[i], color: PART_COLOURS[i] } : {}}
                >
                  <span className="block text-base">{p}</span>
                  <span className="block text-xs opacity-70 mt-0.5">{PART_RANGES[i].label}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={joining}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl text-lg transition-colors"
          >
            {joining ? 'Joining…' : 'Join Game'}
          </button>
        </form>

        <button
          type="button"
          onClick={onWatch}
          disabled={joining}
          className="w-full mt-3 text-gray-500 hover:text-gray-300 disabled:opacity-50 text-sm transition-colors"
        >
          👀 Just want to watch?
        </button>
      </div>
    </div>
  );
}

// ── LobbyScreen (phone) ────────────────────────────────────────────────────

function LobbyScreen({ song, partIdx, isSpectator }: { song: Song | null; partIdx: number; isSpectator: boolean }) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6 text-center">
      <div className="animate-pulse text-5xl mb-4">{isSpectator ? '👀' : '🎵'}</div>
      <h2 className="text-xl font-bold text-emerald-400 mb-2">You&apos;re in!</h2>
      {song && <p className="text-gray-300 font-semibold">{song.title}</p>}
      {isSpectator ? (
        <p className="text-gray-500 text-sm mt-1">Watching — not singing a part</p>
      ) : (
        <p className="text-gray-500 text-sm mt-1">
          You&apos;re singing <span style={{ color: PART_COLOURS[partIdx] }} className="font-bold">{PART_NAMES[partIdx]}</span>
        </p>
      )}
      <p className="text-gray-600 text-sm mt-6">Waiting for the host to start…</p>
    </div>
  );
}

// ── CountdownOverlay ──────────────────────────────────────────────────────

function CountdownOverlay({ countdown }: { countdown: number | null }) {
  if (countdown === null) return null;
  const isLight = (countdown ?? 0) <= 3;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-50"
      style={{ background: isLight ? 'transparent' : 'rgba(0,0,0,0.6)' }}
    >
      <span className="text-8xl font-extrabold" style={{ color: '#f0b429' }}>
        {countdown > 0 ? countdown : 'Sing!'}
      </span>
    </div>
  );
}

// ── Game controls row — shared between PlayingScreen and SpectatorScreen ──

function GameControls({ isPaused, onPause, onRestart }: {
  isPaused: boolean;
  onPause: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="flex gap-2 justify-center">
      <button
        onClick={onPause}
        className="text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        style={{ background: isPaused ? '#16a34a' : '#374151', color: '#fff', border: '1px solid #4b5563' }}
      >
        {isPaused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button
        onClick={onRestart}
        className="text-sm font-semibold px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 transition-colors"
      >
        ↺ Restart
      </button>
    </div>
  );
}

// ── SpectatorScreen (phone) ────────────────────────────────────────────────

function SpectatorScreen({
  song, elapsed, noteResults, countdown, isPaused, onPause, onRestart,
}: {
  song: Song | null;
  elapsed: number;
  noteResults: Record<string, boolean>;
  countdown: number | null;
  isPaused: boolean;
  onPause: () => void;
  onRestart: () => void;
}) {
  const progress = song ? elapsed / song.duration : 0;
  const sopranoNote = (song?.notes ?? []).find(n => n.part === 0 && elapsed >= n.start && elapsed < n.end && n.lyric);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col p-4 gap-3 relative">
      <CountdownOverlay countdown={countdown} />

      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500">👀 Watching</p>
          <p className="text-sm font-bold text-gray-200">{song?.title}</p>
        </div>
        <GameControls isPaused={isPaused} onPause={onPause} onRestart={onRestart} />
      </div>

      <div className="w-full bg-gray-800 rounded-full h-1">
        <div className="h-1 rounded-full bg-emerald-500 transition-all" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="text-center min-h-[2rem] flex items-center justify-center">
        {sopranoNote
          ? <p className="text-lg font-bold leading-snug">{sopranoNote.lyric}</p>
          : <p className="text-gray-600 text-sm">♪</p>
        }
      </div>

      <div className="flex flex-col gap-2 flex-1 min-h-0">
        {[0, 1, 2, 3].map(i => (
          <SatbLane
            key={i}
            partIndex={i}
            partName={PART_NAMES[i]}
            colour={PART_COLOURS[i]}
            elapsed={elapsed}
            notes={song?.notes ?? []}
            noteResults={noteResults}
          />
        ))}
      </div>
    </div>
  );
}

// ── PlayingScreen (phone) ─────────────────────────────────────────────────

function PlayingScreen({
  song, partIdx, elapsed, elapsedHiRes, pitchHz,
  targetNorm, centsDiff, localScore, micAllowed, noteResults, countdown,
  isPaused, onPause, onRestart,
}: {
  song: Song | null;
  partIdx: number;
  elapsed: number;
  elapsedHiRes: number;
  pitchHz: number;
  targetNorm: number;
  centsDiff: number;
  localScore: number;
  micAllowed: boolean | null;
  noteResults: Record<string, boolean>;
  countdown: number | null;
  isPaused: boolean;
  onPause: () => void;
  onRestart: () => void;
}) {
  const [viewMode, setViewMode] = useState<'mine' | 'all'>('mine');
  const colour    = PART_COLOURS[partIdx];
  const tolerance = CENT_TOLERANCE['medium'];
  const absCents  = Math.abs(centsDiff);
  const onTarget  = pitchHz > 0 && absCents < tolerance;
  const progress  = song ? elapsed / song.duration : 0;

  const currentNote = (song?.notes ?? []).find(n => n.part === partIdx && elapsedHiRes >= n.start && elapsedHiRes < n.end && n.lyric);
  const lyric = currentNote?.lyric ?? null;

  // targetNorm is in scope but only used for the tuning bar indirectly via centsDiff
  void targetNorm;

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col p-4 gap-3 relative">
      <CountdownOverlay countdown={countdown} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500">{song?.title}</p>
          <p className="text-sm font-bold" style={{ color: colour }}>{PART_NAMES[partIdx]}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold font-mono text-emerald-400">{localScore}</p>
          <p className="text-xs text-gray-500">pts</p>
        </div>
      </div>

      {/* Game controls */}
      <GameControls isPaused={isPaused} onPause={onPause} onRestart={onRestart} />

      {/* My Part / All Voices toggle */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-700 rounded-full p-0.5 self-center">
        <button
          onClick={() => setViewMode('mine')}
          className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${viewMode === 'mine' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}
        >
          My Part
        </button>
        <button
          onClick={() => setViewMode('all')}
          className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors ${viewMode === 'all' ? 'bg-gray-700 text-white' : 'text-gray-500'}`}
        >
          All Voices
        </button>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-800 rounded-full h-1">
        <div className="h-1 rounded-full transition-all" style={{ width: `${progress * 100}%`, background: colour }} />
      </div>

      {/* Current lyric */}
      <div className="text-center min-h-[2.5rem] flex items-center justify-center">
        {lyric
          ? <p className="text-lg font-bold leading-snug">{lyric}</p>
          : <p className="text-gray-600 text-sm">♪</p>
        }
      </div>

      {/* Main game view */}
      {viewMode === 'mine' ? (
        <div className="flex-1 min-h-0">
          <SatbLane
            partIndex={partIdx}
            partName={PART_NAMES[partIdx]}
            colour={colour}
            elapsed={elapsedHiRes}
            notes={song?.notes ?? []}
            pitchHz={pitchHz}
            onTarget={onTarget}
            noteResults={noteResults}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 flex-1 min-h-0">
          {[0, 1, 2, 3].map(i => (
            <SatbLane
              key={i}
              partIndex={i}
              partName={PART_NAMES[i]}
              colour={PART_COLOURS[i]}
              elapsed={elapsedHiRes}
              notes={song?.notes ?? []}
              pitchHz={i === partIdx ? pitchHz : undefined}
              onTarget={i === partIdx ? onTarget : undefined}
              noteResults={noteResults}
            />
          ))}
        </div>
      )}

      {/* Note name + tuning indicator */}
      <div className="flex items-center justify-between px-2">
        <p className="text-2xl font-bold font-mono" style={{ color: onTarget ? colour : '#64748b' }}>
          {pitchHz > 0 ? PitchEngine.toNoteName(pitchHz) : '—'}
        </p>

        {pitchHz > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-gray-600 text-xs">♭</span>
            <div className="relative w-32 h-2 bg-gray-800 rounded-full overflow-hidden">
              <div className="absolute left-1/2 top-0 w-px h-full bg-gray-600" />
              <div
                className="absolute top-0 h-full rounded-full"
                style={{
                  width: `${Math.min(absCents / tolerance, 1) * 50}%`,
                  left: centsDiff < 0 ? `${50 - Math.min(absCents / tolerance, 1) * 50}%` : '50%',
                  background: onTarget ? colour : '#ef4444',
                }}
              />
            </div>
            <span className="text-gray-600 text-xs">♯</span>
          </div>
        )}

        {onTarget
          ? <span className="text-sm font-bold animate-pulse" style={{ color: colour }}>✨ On pitch!</span>
          : <span className="text-xs text-gray-600">{pitchHz > 0 ? `${Math.round(pitchHz)} Hz` : 'Sing!'}</span>
        }
      </div>

      {micAllowed === false && (
        <div className="bg-red-900/50 border border-red-700 rounded-xl p-3 text-center text-sm text-red-300">
          Microphone access denied — please allow mic and rejoin.
        </div>
      )}
    </div>
  );
}

// ── EndedScreen (phone) ────────────────────────────────────────────────────

function EndedScreen({ localScore, partIdx, playerName }: {
  localScore: number; partIdx: number; playerName: string;
}) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6 text-center">
      <p className="text-6xl mb-4">🎉</p>
      <h2 className="text-2xl font-bold text-yellow-300 mb-1">Well done, {playerName}!</h2>
      <p className="text-gray-400 text-sm mb-6">
        You sang <span style={{ color: PART_COLOURS[partIdx] }} className="font-bold">{PART_NAMES[partIdx]}</span>
      </p>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl px-10 py-6 mb-6">
        <p className="text-gray-400 text-sm mb-1">Your score</p>
        <p className="text-5xl font-bold font-mono text-emerald-400">{localScore}</p>
      </div>
      <p className="text-gray-600 text-sm">Check the main screen for final results!</p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function FullScreenMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">
      {children}
    </div>
  );
}
