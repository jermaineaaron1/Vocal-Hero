// Rule-based feedback on a recorded take (Phase 3d). Pure functions, no
// DOM/network dependency — no LLM call here by design (see plan): the
// numbers below already answer "is this take solid or should I redo it,"
// and an LLM-written qualitative critique on top of them is a deliberate
// fast-follow once an API key is provisioned.

import type { SongNote } from './types';
import { chordToneSet, type ChordEvent } from './chords';

export interface FeedbackMetrics {
  totalNotes: number;
  barsCovered: number;     // distinct bars that have at least one recorded note
  totalBars: number;
  chordToneAccuracy?: number;          // 0-1, pitched takes only
  onsetMeanAbsDeviationMs: number;     // average distance from the nearest beat
  onsetWithinHalfBeatFraction: number; // 0-1, fraction "close enough" to a beat
}

function nearestBeatDeviationSec(timestamp: number, beatLen: number): number {
  if (beatLen <= 0) return 0;
  const nearestBeatIndex = Math.round(timestamp / beatLen);
  return Math.abs(timestamp - nearestBeatIndex * beatLen);
}

function timingStats(notes: SongNote[], bpm: number): { meanAbsDeviationMs: number; withinHalfBeatFraction: number } {
  if (!notes.length) return { meanAbsDeviationMs: 0, withinHalfBeatFraction: 0 };
  const beatLen = 60 / Math.max(bpm, 1);
  const deviations = notes.map(n => nearestBeatDeviationSec(n.start, beatLen));
  const meanAbsDeviationMs = (deviations.reduce((s, d) => s + d, 0) / deviations.length) * 1000;
  const withinHalfBeatFraction = deviations.filter(d => d <= beatLen / 2).length / deviations.length;
  return { meanAbsDeviationMs, withinHalfBeatFraction };
}

function countBarsCovered(notes: SongNote[], barLen: number): number {
  const bars = new Set(notes.map(n => Math.floor(n.start / Math.max(barLen, 0.0001))));
  return bars.size;
}

/** Pitched instruments (guitar/bass/piano) — compares each recorded note against the active chord. */
export function analyzePitchedRecording(
  recordingNotes: SongNote[],
  chordEvents: ChordEvent[],
  bpm: number,
  timeSig: number
): FeedbackMetrics {
  const barLen = (60 / Math.max(bpm, 1)) * Math.max(timeSig, 1);
  const { meanAbsDeviationMs, withinHalfBeatFraction } = timingStats(recordingNotes, bpm);

  let matched = 0;
  recordingNotes.forEach(n => {
    const chord = chordEvents.find(c => n.start >= c.start && n.start < c.end);
    if (!chord) return;
    const tones = chordToneSet(chord.root, chord.quality);
    if (tones.has(((n.midi % 12) + 12) % 12)) matched++;
  });

  return {
    totalNotes: recordingNotes.length,
    barsCovered: countBarsCovered(recordingNotes, barLen),
    totalBars: chordEvents.length,
    chordToneAccuracy: recordingNotes.length ? matched / recordingNotes.length : undefined,
    onsetMeanAbsDeviationMs: meanAbsDeviationMs,
    onsetWithinHalfBeatFraction: withinHalfBeatFraction,
  };
}

/** Percussion (cajon) — no pitch to judge, just rhythm-vs-beat-grid tightness. */
export function analyzePercussionRecording(
  recordingNotes: SongNote[],
  bpm: number,
  timeSig: number,
  duration: number
): FeedbackMetrics {
  const barLen = (60 / Math.max(bpm, 1)) * Math.max(timeSig, 1);
  const totalBars = Math.max(1, Math.ceil(duration / barLen));
  const { meanAbsDeviationMs, withinHalfBeatFraction } = timingStats(recordingNotes, bpm);

  return {
    totalNotes: recordingNotes.length,
    barsCovered: countBarsCovered(recordingNotes, barLen),
    totalBars,
    onsetMeanAbsDeviationMs: meanAbsDeviationMs,
    onsetWithinHalfBeatFraction: withinHalfBeatFraction,
  };
}

/** Canned, threshold-based suggestions — the "improve or scrap" signal, no LLM. */
export function summarize(metrics: FeedbackMetrics): string[] {
  const out: string[] = [];

  if (metrics.totalNotes === 0) {
    return ['Nothing was captured in this take — try recording again.'];
  }

  if (metrics.chordToneAccuracy !== undefined) {
    if (metrics.chordToneAccuracy >= 0.8) {
      out.push('Notes mostly match the chord changes well.');
    } else if (metrics.chordToneAccuracy >= 0.5) {
      out.push('Some notes clash with the chord — worth reviewing the bars where they disagree.');
    } else {
      out.push('Many notes don’t match the underlying chords — consider revisiting this part before performing it.');
    }
  }

  if (metrics.onsetMeanAbsDeviationMs < 40) {
    out.push('Timing is tight and close to the beat.');
  } else if (metrics.onsetMeanAbsDeviationMs < 100) {
    out.push('Timing is a little loose — practicing with the metronome more could help.');
  } else {
    out.push('Notes are landing noticeably off the beat — consider a slower practice tempo.');
  }

  if (metrics.totalBars > 0 && metrics.barsCovered < metrics.totalBars * 0.5) {
    out.push('Large stretches of the song have no notes at all — this take may be incomplete.');
  }

  return out;
}
