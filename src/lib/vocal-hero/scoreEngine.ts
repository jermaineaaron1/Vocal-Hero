'use client';

// Scoring logic. When the player's part has discrete SongNote[] data, scores
// onset timing + hold duration + pitch accuracy per note. Falls back to the
// legacy smooth-curve comparison for parts that only have a SatbPart.curve
// (older songs generated before per-note data existed).
//
// Deltas accumulate into `total`/`pendingDeltas` and batch-flush to Supabase
// every flushIntervalMs — that pipeline is unchanged by the note-vs-curve
// scoring mode.

import { PitchEngine } from './pitchEngine';
import type { SatbPart, SongNote } from './types';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Tolerance in cents for each difficulty level */
export const CENT_TOLERANCE: Record<Difficulty, number> = {
  easy:   100,
  medium:  50,
  hard:    25,
};

/** Maximum points awarded per frame at perfect pitch (legacy curve mode) */
const MAX_DELTA = 10;

/** How close to note.start (seconds, either side) an onset still counts */
const ONSET_WINDOW_SEC = 0.35;

/** Points awarded for a note resolved at 100% on all three sub-scores */
const NOTE_MAX_POINTS = 30;

/** How onset/hold/pitch combine into one composite note score */
const WEIGHTS = { onset: 0.25, hold: 0.35, pitch: 0.40 };

export interface NoteScoreResult {
  noteId: string;
  onset:  number; // 0–1
  hold:   number; // 0–1
  pitch:  number; // 0–1
  points: number;
}

export interface ScoreEngineOptions {
  part:            SatbPart;
  partIndex:       number;     // which SATB part this player is singing (0=S,1=A,2=T,3=B)
  notes?:          SongNote[]; // full song.notes — engine filters to partIndex itself
  songDuration:    number;     // seconds — used by legacy curve mode
  playerId:        string;
  sessionId:       string;
  difficulty?:     Difficulty;
  flushIntervalMs?: number;    // default 500
  onScoreUpdate:   (delta: number, total: number) => void;
  onNoteResult?:   (result: NoteScoreResult) => void; // optional — for future UI hookup
}

interface ActiveNoteTracking {
  note:           SongNote;
  onsetCaptured:  boolean;
  onsetDelaySec:  number | null; // signed: actual onset time - note.start
  voicedSec:      number;        // time voiced while inside [note.start, note.end)
  inTuneSec:      number;        // subset of voicedSec that was in-tune
}

export class ScoreEngine {
  private total         = 0;
  private pendingDeltas: number[] = [];
  private flushTimer:   ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<ScoreEngineOptions>;

  // ── Note-mode state ──────────────────────────────────────────────────────
  private readonly noteList: SongNote[];
  private readonly useNotes: boolean;
  private cursor = 0;
  private current: ActiveNoteTracking | null = null;
  private lastSampleSec = 0;

  constructor(options: ScoreEngineOptions) {
    this.opts = {
      difficulty:      'medium',
      flushIntervalMs: 500,
      notes:           [],
      onNoteResult:    () => {},
      ...options,
    };

    this.noteList = (this.opts.notes ?? [])
      .filter(n => n.part === this.opts.partIndex)
      .slice()
      .sort((a, b) => a.start - b.start);
    this.useNotes = this.noteList.length > 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.opts.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Finalize whatever note was still in progress — otherwise the last
    // active note of a song silently scores 0.
    if (this.current) {
      this.finalizeNote(this.current.note);
    }
    await this.flush(); // drain remaining deltas
  }

  reset(): void {
    this.total = 0;
    this.pendingDeltas = [];
    this.cursor = 0;
    this.current = null;
    this.lastSampleSec = 0;
  }

  get currentTotal(): number {
    return this.total;
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /**
   * Call this on every pitch sample from PitchEngine.
   *
   * @param playerHz   Raw frequency from mic (0 = silence)
   * @param elapsedSec High-resolution seconds since the song started
   *                   (PitchSample.timestamp — not a 1Hz UI timer)
   * @returns Points awarded this call (0 most frames; a lump when a note resolves)
   */
  scorePitch(playerHz: number, elapsedSec: number): number {
    if (!this.useNotes) {
      return this.legacyCurveScore(playerHz, elapsedSec);
    }
    return this.noteScore(playerHz, elapsedSec);
  }

  private noteScore(playerHz: number, elapsedSec: number): number {
    const dt = Math.min(Math.max(elapsedSec - this.lastSampleSec, 0), 0.25);
    this.lastSampleSec = elapsedSec;

    let pointsAwarded = 0;

    // Advance past any notes whose window has fully ended, finalizing each.
    while (this.cursor < this.noteList.length && this.noteList[this.cursor].end <= elapsedSec) {
      pointsAwarded += this.finalizeNote(this.noteList[this.cursor]);
      this.cursor += 1;
    }

    if (this.cursor >= this.noteList.length) return pointsAwarded;

    const candidate = this.noteList[this.cursor];
    if (elapsedSec < candidate.start - ONSET_WINDOW_SEC) {
      return pointsAwarded; // note hasn't started yet
    }

    if (!this.current || this.current.note.id !== candidate.id) {
      this.current = { note: candidate, onsetCaptured: false, onsetDelaySec: null, voicedSec: 0, inTuneSec: 0 };
    }

    const targetHz = PitchEngine.midiToHz(candidate.midi);
    const isVoiced = playerHz > 0;
    const cents    = isVoiced ? Math.abs(PitchEngine.centsDiff(playerHz, targetHz)) : Infinity;
    const inTune   = isVoiced && cents <= CENT_TOLERANCE[this.opts.difficulty];

    if (!this.current.onsetCaptured && isVoiced) {
      this.current.onsetCaptured = true;
      this.current.onsetDelaySec = elapsedSec - candidate.start;
    }

    if (elapsedSec >= candidate.start && elapsedSec < candidate.end) {
      if (isVoiced) {
        this.current.voicedSec += dt;
        if (inTune) this.current.inTuneSec += dt;
      }
    }

    return pointsAwarded;
  }

  /** Resolve one note into a single composite point value and award it. */
  private finalizeNote(note: SongNote): number {
    const tracking = this.current && this.current.note.id === note.id ? this.current : null;
    this.current = null;

    if (!tracking) {
      this.opts.onNoteResult({ noteId: note.id, onset: 0, hold: 0, pitch: 0, points: 0 });
      return 0;
    }

    const duration = Math.max(note.end - note.start, 0.0001);
    const onsetScore = tracking.onsetCaptured && tracking.onsetDelaySec !== null
      ? clamp01(1 - Math.abs(tracking.onsetDelaySec) / ONSET_WINDOW_SEC)
      : 0;
    const holdRatio  = clamp01(tracking.voicedSec / duration);
    const pitchRatio = tracking.voicedSec > 0 ? clamp01(tracking.inTuneSec / tracking.voicedSec) : 0;

    const composite = WEIGHTS.onset * onsetScore + WEIGHTS.hold * holdRatio + WEIGHTS.pitch * pitchRatio;
    const points = Math.round(composite * NOTE_MAX_POINTS);

    if (points > 0) {
      this.total += points;
      this.pendingDeltas.push(points);
      this.opts.onScoreUpdate(points, this.total);
    }

    this.opts.onNoteResult({ noteId: note.id, onset: onsetScore, hold: holdRatio, pitch: pitchRatio, points });
    return points;
  }

  /** Legacy: compare live pitch against the smooth SatbPart.curve. */
  private legacyCurveScore(playerHz: number, elapsedSec: number): number {
    const { part, songDuration, difficulty } = this.opts;
    const curve = part.curve;

    if (!curve || curve.length === 0) return 0;

    const targetNorm = interpolateCurve(curve, elapsedSec, songDuration);

    if (playerHz <= 0) return 0; // silence — no points, no penalty

    const targetHz = PitchEngine.denormalise(targetNorm, part.rangeMin, part.rangeMax);
    const cents    = Math.abs(PitchEngine.centsDiff(playerHz, targetHz));
    const tol      = CENT_TOLERANCE[difficulty];

    const delta = cents >= tol ? 0 : Math.round(MAX_DELTA * (1 - cents / tol));

    if (delta > 0) {
      this.total += delta;
      this.pendingDeltas.push(delta);
      this.opts.onScoreUpdate(delta, this.total);
    }

    return delta;
  }

  /**
   * Returns the target normalised pitch (0–1) at a given elapsed time.
   * Useful for drawing the target line on screen. Note-mode finds whichever
   * note covers elapsedSec; curve-mode interpolates the legacy curve.
   */
  targetNormAt(elapsedSec: number): number {
    if (!this.useNotes) {
      const curve = this.opts.part.curve;
      if (!curve || curve.length === 0) return 0;
      return interpolateCurve(curve, elapsedSec, this.opts.songDuration);
    }

    const note = this.noteList.find(n => elapsedSec >= n.start && elapsedSec < n.end);
    if (!note) return 0;
    return PitchEngine.normalise(PitchEngine.midiToHz(note.midi), this.opts.part.rangeMin, this.opts.part.rangeMax);
  }

  /**
   * Returns accuracy as a percentage (0–100) based on frames with score > 0.
   * Must be tracked externally — here we provide a helper that takes totals.
   */
  static accuracy(scoredFrames: number, totalFrames: number): number {
    if (totalFrames === 0) return 0;
    return Math.round((scoredFrames / totalFrames) * 100);
  }

  // ── Flush to Supabase ─────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.pendingDeltas.length === 0) return;

    const batch = [...this.pendingDeltas];
    this.pendingDeltas = [];

    const total = batch.reduce((s, d) => s + d, 0);
    if (total === 0) return;

    try {
      await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId:  this.opts.playerId,
          sessionId: this.opts.sessionId,
          delta:     total,
        }),
      });
    } catch {
      // Non-fatal — score is already tracked locally in this.total
      // Put deltas back so next flush retries them
      this.pendingDeltas.unshift(...batch);
    }
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Shared 24-keyframe curve interpolation used by both legacy score + target paths. */
function interpolateCurve(curve: number[], elapsedSec: number, songDuration: number): number {
  const progress = Math.min(elapsedSec / songDuration, 1);
  const rawIndex  = progress * (curve.length - 1);
  const loIdx     = Math.floor(rawIndex);
  const hiIdx     = Math.min(loIdx + 1, curve.length - 1);
  const frac      = rawIndex - loIdx;
  return curve[loIdx] * (1 - frac) + curve[hiIdx] * frac;
}
