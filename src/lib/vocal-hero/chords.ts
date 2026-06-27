// Chord-symbol inference for the Arrangement view: derives plain-text chord
// symbols (e.g. "C", "G7", "Am7", "C/G") from the song's existing SATB
// harmony notes, one chord per musical bar. Reuses harmonize.ts's key
// detection for diatonic context rather than duplicating pitch-class math.
//
// Computed on-the-fly each time the Arrangement view opens — not persisted —
// so there's no "auto-generate vs. respect edits" reconciliation problem
// (unlike Phase 2's harmony notes, there's no saved chord baseline to clash
// with a later regeneration).

import type { SongNote } from './types';
import { detectKey, scaleDegrees } from './harmonize';

export type ChordQuality = 'maj' | 'min' | 'dom7' | 'maj7' | 'min7' | 'dim';

export interface ChordEvent {
  bar: number;
  start: number;       // seconds
  end: number;          // seconds
  root: number;         // pitch class 0-11
  quality: ChordQuality;
  bassPC?: number;      // present only when the sounding bass note differs from the root
  symbol: string;       // e.g. "C", "G7", "Am7", "C/G", or "—" for a silent/undetected bar
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '', min: 'm', dom7: '7', maj7: 'maj7', min7: 'm7', dim: 'dim',
};

const CHORD_TEMPLATES: { quality: ChordQuality; intervals: number[] }[] = [
  { quality: 'maj', intervals: [0, 4, 7] },
  { quality: 'min', intervals: [0, 3, 7] },
  { quality: 'dom7', intervals: [0, 4, 7, 10] },
  { quality: 'maj7', intervals: [0, 4, 7, 11] },
  { quality: 'min7', intervals: [0, 3, 7, 10] },
  { quality: 'dim', intervals: [0, 3, 6] },
];

function chordSymbol(root: number, quality: ChordQuality): string {
  return NOTE_NAMES[((root % 12) + 12) % 12] + QUALITY_SUFFIX[quality];
}

/** Pitch class with the most sounding duration among `notes` within [start,end). */
function dominantPitchClass(notes: SongNote[], start: number, end: number): number | null {
  const weights = new Array(12).fill(0);
  let any = false;
  notes.forEach(n => {
    const overlap = Math.min(n.end, end) - Math.max(n.start, start);
    if (overlap <= 0) return;
    any = true;
    weights[((n.midi % 12) + 12) % 12] += overlap;
  });
  if (!any) return null;
  let best = 0;
  for (let pc = 1; pc < 12; pc++) if (weights[pc] > weights[best]) best = pc;
  return best;
}

function detectChordForWindow(
  notesInWindow: SongNote[],
  scalePCs: Set<number>,
  start: number,
  end: number,
  bar: number
): ChordEvent {
  const weights = new Array(12).fill(0);
  notesInWindow.forEach(n => {
    const overlap = Math.min(n.end, end) - Math.max(n.start, start);
    if (overlap <= 0) return;
    weights[((n.midi % 12) + 12) % 12] += overlap;
  });

  // Whether ANY note actually sounds in this bar — independent of the
  // diatonic tie-breaker below, which must never by itself manufacture a
  // chord out of silence (it only breaks ties among real candidates).
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    return { bar, start, end, root: 0, quality: 'maj', symbol: '—' };
  }

  let best = { root: 0, quality: CHORD_TEMPLATES[0].quality, score: -Infinity };
  for (let root = 0; root < 12; root++) {
    for (const tpl of CHORD_TEMPLATES) {
      // Coverage = fraction of this template's chord tones that are present
      // at all (boolean, not weighted by how long/how doubled). Duration-
      // weighting here would let a doubled root (e.g. the bass singing the
      // same pitch class as the lead) inflate a smaller triad's average
      // past a larger chord that's just as fully present (e.g. a real G7
      // losing to "G" only because the root happens to sound twice) — a
      // common real case since basses often double the root.
      const present = tpl.intervals.filter(iv => weights[(root + iv) % 12] > 0).length;
      let score = present / tpl.intervals.length;
      // On an exact coverage tie, prefer the larger/more specific template
      // (e.g. a fully-sounding G7 over a fully-sounding plain G triad) and
      // use the diatonic root as a final, tiny tie-breaker.
      score += tpl.intervals.length * 0.001;
      if (scalePCs.has(root)) score += 0.0001;
      if (score > best.score) best = { root, quality: tpl.quality, score };
    }
  }

  const bassNotes = notesInWindow.filter(n => n.part === 3);
  const bassPC = dominantPitchClass(bassNotes, start, end);
  const bassDiffers = bassPC !== null && bassPC !== best.root;

  return {
    bar, start, end, root: best.root, quality: best.quality,
    bassPC: bassDiffers ? bassPC! : undefined,
    symbol: chordSymbol(best.root, best.quality) + (bassDiffers ? '/' + NOTE_NAMES[bassPC!] : ''),
  };
}

/**
 * One chord per bar, derived from the duration-weighted pitch-class content
 * of all SATB notes sounding within that bar.
 */
export function deriveChordChart(notes: SongNote[], bpm: number, timeSig: number, duration: number): ChordEvent[] {
  const barLen = (60 / Math.max(bpm, 1)) * Math.max(timeSig, 1);
  const totalBars = Math.max(1, Math.ceil(duration / barLen));
  const detected = detectKey(notes);
  const scalePCs = new Set(scaleDegrees(detected.root, detected.isMinor));

  const events: ChordEvent[] = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const start = bar * barLen;
    const end = Math.min((bar + 1) * barLen, duration);
    const inWindow = notes.filter(n => n.start < end && n.end > start);
    events.push(detectChordForWindow(inWindow, scalePCs, start, end, bar));
  }
  return events;
}
