// Auto-generate SATB harmony from a melody: diatonic parallel-interval
// harmonization. Detects a likely key, then places Alto/Tenor/Bass a
// scale-snapped interval below the part above, clamped to each part's vocal
// range with octave correction and basic voice-crossing avoidance.
//
// Deliberately NOT full chord/voice-leading analysis — that's a much bigger
// problem. This gives a real, in-key, editable starting point per the
// roadmap ("generate automatically... customize manually after").

import type { SongNote } from './types';

export interface DetectedKey {
  root: number;    // 0-11 pitch class
  isMinor: boolean;
}

// Standard Krumhansl-Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]; // natural minor only

// Soprano/Alto/Tenor/Bass vocal ranges (Hz) — matches PART_HZ in the editor
// and PART_RANGES in phone/page.tsx.
const PART_RANGES_HZ = [
  { min: 260, max: 1050 }, // Soprano
  { min: 175, max: 700 },  // Alto
  { min: 130, max: 525 },  // Tenor
  { min: 80, max: 330 },   // Bass
];

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

function rangeToMidi(rangeHz: { min: number; max: number }): { lo: number; hi: number } {
  return { lo: hzToMidi(rangeHz.min), hi: hzToMidi(rangeHz.max) };
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/** Duration-weighted pitch-class histogram correlated against major/minor key profiles. */
export function detectKey(notes: SongNote[]): DetectedKey {
  const hist = new Array(12).fill(0);
  notes.forEach(n => {
    const pc = ((n.midi % 12) + 12) % 12;
    hist[pc] += Math.max(n.end - n.start, 0.01);
  });
  const total = hist.reduce((s, v) => s + v, 0);
  if (total <= 0) return { root: 0, isMinor: false };

  let best: DetectedKey & { score: number } = { root: 0, isMinor: false, score: -Infinity };
  for (let root = 0; root < 12; root++) {
    const rotatedMajor = Array.from({ length: 12 }, (_, pc) => MAJOR_PROFILE[((pc - root) % 12 + 12) % 12]);
    const rotatedMinor = Array.from({ length: 12 }, (_, pc) => MINOR_PROFILE[((pc - root) % 12 + 12) % 12]);
    const scoreMajor = pearsonCorrelation(hist, rotatedMajor);
    const scoreMinor = pearsonCorrelation(hist, rotatedMinor);
    if (scoreMajor > best.score) best = { root, isMinor: false, score: scoreMajor };
    if (scoreMinor > best.score) best = { root, isMinor: true, score: scoreMinor };
  }
  return { root: best.root, isMinor: best.isMinor };
}

/** The 7 pitch classes (0-11) of the major or natural-minor scale starting at `root`. */
export function scaleDegrees(root: number, isMinor: boolean): number[] {
  const steps = isMinor ? MINOR_STEPS : MAJOR_STEPS;
  return steps.map(s => ((root + s) % 12 + 12) % 12);
}

/** Nearest in-scale MIDI note to `midi`, ties broken toward the lower pitch. */
export function snapToScale(midi: number, scalePCs: number[]): number {
  const inScale = (m: number) => scalePCs.includes(((m % 12) + 12) % 12);
  if (inScale(midi)) return midi;
  for (let d = 1; d <= 6; d++) {
    if (inScale(midi - d)) return midi - d;
    if (inScale(midi + d)) return midi + d;
  }
  return midi; // unreachable — every chromatic neighborhood contains a scale tone within 6 semitones
}

/** Octave-shift `midi` until it falls within [loMidi, hiMidi]. */
export function clampToRange(midi: number, loMidi: number, hiMidi: number): number {
  let m = midi;
  while (m < loMidi) m += 12;
  while (m > hiMidi) m -= 12;
  return m;
}

/**
 * Nearest in-scale MIDI note to `target` that also falls within [lo, hi].
 * Searching for both constraints together (rather than snapping to scale
 * first and octave-clamping after) avoids a full-octave jump when the
 * scale-snapped pitch is only a semitone or two outside the range — e.g.
 * snapping then clamping could jump 52 -> 64 to clear a floor of 53, when
 * 55 (also in-scale, in-range) is right there.
 */
function snapToScaleInRange(target: number, scalePCs: number[], lo: number, hi: number): number {
  for (let d = 0; d <= 24; d++) {
    const candidates = d === 0 ? [target] : [target - d, target + d];
    for (const cand of candidates) {
      if (cand >= lo && cand <= hi && scalePCs.includes(((cand % 12) + 12) % 12)) return cand;
    }
  }
  return clampToRange(snapToScale(target, scalePCs), lo, hi); // unreachable in practice
}

/** Nearest occurrence of pitch class `pc` to `target` that falls within [lo, hi]. */
function nearestPitchClassInRange(target: number, pc: number, lo: number, hi: number): number {
  for (let d = 0; d <= 24; d++) {
    const candidates = d === 0 ? [target] : [target - d, target + d];
    for (const cand of candidates) {
      if (cand >= lo && cand <= hi && ((cand % 12) + 12) % 12 === pc) return cand;
    }
  }
  return clampToRange(target, lo, hi); // unreachable in practice
}

/**
 * Nudge Alto/Tenor/Bass so each stays at or below the part above it
 * (soprano >= alto >= tenor >= bass), re-clamping into range afterward.
 * Range-correctness wins if a crossing-fix would push a part out of range.
 */
export function fixVoiceCrossing(
  sopranoMidi: number,
  altoMidi: number,
  tenorMidi: number,
  bassMidi: number,
  ranges: { altoLo: number; altoHi: number; tenorLo: number; tenorHi: number; bassLo: number; bassHi: number }
): { alto: number; tenor: number; bass: number } {
  let alto = altoMidi;
  let tenor = tenorMidi;
  let bass = bassMidi;

  if (alto > sopranoMidi) alto = clampToRange(alto - 12, ranges.altoLo, ranges.altoHi);
  if (tenor > alto) tenor = clampToRange(tenor - 12, ranges.tenorLo, ranges.tenorHi);
  if (bass > tenor) bass = clampToRange(bass - 12, ranges.bassLo, ranges.bassHi);

  return { alto, tenor, bass };
}

/**
 * Generate Alto/Tenor/Bass from a melody, returning the full 4-part note
 * array (melody reassigned to part 0). One harmony note per melody note,
 * sharing its timing — "parallel" diatonic harmonization.
 */
export function harmonizeSatb(melodyNotes: SongNote[]): { notes: SongNote[]; detectedKey: DetectedKey } {
  const detectedKey = detectKey(melodyNotes);
  const scalePCs = scaleDegrees(detectedKey.root, detectedKey.isMinor);

  const altoRange = rangeToMidi(PART_RANGES_HZ[1]);
  const tenorRange = rangeToMidi(PART_RANGES_HZ[2]);
  const bassRange = rangeToMidi(PART_RANGES_HZ[3]);

  const soprano: SongNote[] = melodyNotes.map(n => ({ ...n, part: 0 }));
  const alto: SongNote[] = [];
  const tenor: SongNote[] = [];
  const bass: SongNote[] = [];

  melodyNotes.forEach(m => {
    const altoTarget = snapToScaleInRange(m.midi - 3, scalePCs, altoRange.lo, altoRange.hi);
    const tenorTarget = snapToScaleInRange(m.midi - 7, scalePCs, tenorRange.lo, tenorRange.hi);
    const bassTarget = nearestPitchClassInRange(m.midi - 12, detectedKey.root, bassRange.lo, bassRange.hi);

    const fixed = fixVoiceCrossing(m.midi, altoTarget, tenorTarget, bassTarget, {
      altoLo: altoRange.lo, altoHi: altoRange.hi,
      tenorLo: tenorRange.lo, tenorHi: tenorRange.hi,
      bassLo: bassRange.lo, bassHi: bassRange.hi,
    });

    alto.push({ id: uid(), part: 1, midi: fixed.alto, start: m.start, end: m.end, lyric: '', velocity: m.velocity });
    tenor.push({ id: uid(), part: 2, midi: fixed.tenor, start: m.start, end: m.end, lyric: '', velocity: m.velocity });
    bass.push({ id: uid(), part: 3, midi: fixed.bass, start: m.start, end: m.end, lyric: '', velocity: m.velocity });
  });

  return { notes: [...soprano, ...alto, ...tenor, ...bass], detectedKey };
}

/**
 * Sample a part's notes into the legacy 24-keyframe curve format (normalized
 * 0-1 within [midiLo, midiHi]) — same math as the editor's handleSave used
 * to build inline, extracted here so both share one implementation.
 */
export function notesToCurve(notes: SongNote[], partIndex: number, duration: number, midiLo: number, midiHi: number): number[] {
  const pn = notes.filter(n => n.part === partIndex).sort((a, b) => a.start - b.start);
  const span = Math.max(midiHi - midiLo, 1);
  const norm = (midi: number) => (midi - midiLo) / span;

  return Array.from({ length: 24 }, (_, k) => {
    const t = (k / 23) * Math.max(duration, 1);
    const hit = pn.find(n => t >= n.start && t < n.end);
    if (hit) return norm(hit.midi);

    const prev = [...pn].reverse().find(n => n.end <= t);
    const next = pn.find(n => n.start > t);
    if (prev && next) {
      const span2 = next.start - prev.end;
      const a = span2 > 0 ? (t - prev.end) / span2 : 0;
      return norm(prev.midi) * (1 - a) + norm(next.midi) * a;
    }
    if (prev) return norm(prev.midi);
    if (next) return norm(next.midi);
    return 0.5;
  });
}
