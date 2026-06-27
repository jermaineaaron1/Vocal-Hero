'use client';

// Mic-based note capture for non-MIDI instruments (Phase 3c). Two pure
// segmenters, no Web Audio/DOM dependency — fully testable with synthetic
// sample sequences, mirroring MidiRecorder's pure pairing logic (Phase 3b).
//
// PitchNoteSegmenter: pitched instruments (guitar/bass) — turns a
// continuous pitch/confidence stream (from PitchEngine) into discrete
// onset/offset notes, the audio equivalent of MIDI note-on/note-off.
//
// OnsetSegmenter: percussion (cajon) — has no definite pitch, so it turns
// the amplitude envelope into discrete hit events instead.

import type { SongNote } from './types';

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

function centsDiff(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return 1200 * Math.log2(a / b);
}

// ── PitchNoteSegmenter ──────────────────────────────────────────────────────

export interface PitchSegmenterSample {
  frequency: number;  // Hz, 0 = silence
  confidence: number; // 0-1
  timestamp: number;  // seconds
}

export interface PitchNoteSegmenterOptions {
  confidenceThreshold?: number; // default 0.85 — below this, treated as unvoiced
  pitchJumpCents?: number;      // default 150 — bigger jump than this starts a new note
}

interface OpenNote {
  startHz: number;
  startTimestamp: number;
  lastHz: number;
  lastTimestamp: number;
}

export class PitchNoteSegmenter {
  private open: OpenNote | null = null;
  private notes: SongNote[] = [];
  private readonly opts: Required<PitchNoteSegmenterOptions>;

  constructor(options: PitchNoteSegmenterOptions = {}) {
    this.opts = { confidenceThreshold: 0.85, pitchJumpCents: 150, ...options };
  }

  handleSample(sample: PitchSegmenterSample): void {
    const voiced = sample.frequency > 0 && sample.confidence >= this.opts.confidenceThreshold;

    if (!voiced) {
      this.closeOpenNote(this.open?.lastTimestamp ?? sample.timestamp);
      return;
    }

    if (!this.open) {
      this.open = { startHz: sample.frequency, startTimestamp: sample.timestamp, lastHz: sample.frequency, lastTimestamp: sample.timestamp };
      return;
    }

    if (Math.abs(centsDiff(sample.frequency, this.open.startHz)) > this.opts.pitchJumpCents) {
      this.closeOpenNote(this.open.lastTimestamp);
      this.open = { startHz: sample.frequency, startTimestamp: sample.timestamp, lastHz: sample.frequency, lastTimestamp: sample.timestamp };
      return;
    }

    this.open.lastHz = sample.frequency;
    this.open.lastTimestamp = sample.timestamp;
  }

  private closeOpenNote(endTimestamp: number): void {
    if (!this.open) return;
    const { startHz, startTimestamp } = this.open;
    this.open = null;
    if (endTimestamp <= startTimestamp) return; // degenerate zero/negative-length note
    this.notes.push({
      id: uid(), part: -1, midi: hzToMidi(startHz),
      start: startTimestamp, end: endTimestamp,
      lyric: '', velocity: 100,
    });
  }

  /** Call once when the recording stops — closes any note still open. */
  finish(): void {
    if (this.open) this.closeOpenNote(this.open.lastTimestamp);
  }

  getNotes(): SongNote[] {
    return [...this.notes].sort((a, b) => a.start - b.start);
  }

  reset(): void {
    this.open = null;
    this.notes = [];
  }
}

// ── OnsetSegmenter ──────────────────────────────────────────────────────────

export interface OnsetSegmenterSample {
  amplitude: number; // RMS, ~0-1
  timestamp: number; // seconds
}

export interface OnsetSegmenterOptions {
  threshold?: number;      // default 0.05 — amplitude must cross above this to fire
  refractorySec?: number;  // default 0.08 — minimum gap between onsets
  hitDurationSec?: number; // default 0.1 — fixed duration given to each hit "note"
  sentinelMidi?: number;   // default 60 — pitch is meaningless for percussion
}

export class OnsetSegmenter {
  private below = true; // whether amplitude was below threshold on the last sample
  private lastOnsetAt = -Infinity;
  private notes: SongNote[] = [];
  private readonly opts: Required<OnsetSegmenterOptions>;

  constructor(options: OnsetSegmenterOptions = {}) {
    this.opts = { threshold: 0.05, refractorySec: 0.08, hitDurationSec: 0.1, sentinelMidi: 60, ...options };
  }

  handleSample(sample: OnsetSegmenterSample): void {
    const above = sample.amplitude >= this.opts.threshold;
    const risingEdge = above && this.below;
    const pastRefractory = sample.timestamp - this.lastOnsetAt >= this.opts.refractorySec;

    if (risingEdge && pastRefractory) {
      this.lastOnsetAt = sample.timestamp;
      const velocity = Math.round(Math.max(0, Math.min(1, sample.amplitude)) * 127);
      this.notes.push({
        id: uid(), part: -1, midi: this.opts.sentinelMidi,
        start: sample.timestamp, end: sample.timestamp + this.opts.hitDurationSec,
        lyric: '', velocity,
      });
    }

    this.below = !above;
  }

  /** No-op (kept for symmetry with PitchNoteSegmenter — onsets are emitted immediately, nothing stays "open"). */
  finish(): void {}

  getNotes(): SongNote[] {
    return [...this.notes].sort((a, b) => a.start - b.start);
  }

  reset(): void {
    this.below = true;
    this.lastOnsetAt = -Infinity;
    this.notes = [];
  }
}
