'use client';

import { useEffect, useRef, useState } from 'react';
import type { SongNote } from '@/lib/vocal-hero/types';

// Shared SATB note lane — one full-width row per voice part, used by the
// host (all 4 parts, always), the phone's "My Part" view (one lane), and
// the phone's "All Voices" view (4 lanes, only the viewer's own part gets a
// live pitch dot). Guitar-Hero-style: notes scroll right→left through a
// fixed lookahead window toward a glowing cue line, each lane normalizes
// pitch against its OWN sung range (not a fixed 4-octave range) so pitch
// movement is actually visible even for narrow-range harmony parts, and
// already-passed notes turn green (hit) or dim red (miss) once a result
// for that note id arrives.

const DEFAULT_MIDI_LO = 36; // C2 — fallback when a lane has no notes yet
const DEFAULT_MIDI_HI = 84; // C6
const MIN_SPAN = 12;        // never normalize against less than one octave

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

export interface SatbLaneProps {
  partIndex: number;
  partName: string;
  colour: string;
  elapsed: number;
  notes: SongNote[];
  pitchHz?: number;     // raw frequency — only passed for the viewer's own part
  onTarget?: boolean;
  playerCount?: number; // host use — small "N×" badge
  windowSec?: number;
  noteResults?: Record<string, boolean>; // noteId -> hit(true)/miss(false), resolved notes only
}

export function SatbLane({
  partIndex, partName, colour, elapsed, notes,
  pitchHz, onTarget, playerCount, windowSec = 10, noteResults,
}: SatbLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [flash, setFlash] = useState<'hit' | 'miss' | null>(null);
  const seenResultsRef = useRef<Set<string>>(new Set());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Transient badge glow — fires once per NEW resolved note for this part.
  // Runs only when noteResults changes, not on every animation frame.
  useEffect(() => {
    if (!noteResults) return;
    const partNoteIds = new Set(notes.filter(n => n.part === partIndex).map(n => n.id));
    for (const [noteId, hit] of Object.entries(noteResults)) {
      if (!partNoteIds.has(noteId)) continue;
      if (seenResultsRef.current.has(noteId)) continue;
      seenResultsRef.current.add(noteId);
      setFlash(hit ? 'hit' : 'miss');
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(null), 700);
    }
  }, [noteResults, notes, partIndex]);

  useEffect(() => {
    return () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); };
  }, []);

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

    // Alternating depth bands
    for (let i = 0; i <= 8; i++) {
      const y = (i / 8) * H;
      ctx.strokeStyle = i % 2 === 0 ? '#1e293b' : '#172033';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const partNotes = notes.filter(n => n.part === partIndex);

    // Normalize this lane against its OWN sung range, not a fixed 4-octave
    // span — otherwise a narrow-range harmony part barely moves vertically.
    let midiLo = DEFAULT_MIDI_LO, midiHi = DEFAULT_MIDI_HI;
    if (partNotes.length > 0) {
      let lo = Math.min(...partNotes.map(n => n.midi)) - 2;
      let hi = Math.max(...partNotes.map(n => n.midi)) + 2;
      if (hi - lo < MIN_SPAN) {
        const mid = (hi + lo) / 2;
        lo = mid - MIN_SPAN / 2;
        hi = mid + MIN_SPAN / 2;
      }
      midiLo = lo; midiHi = hi;
    }
    const pitchToY = (midi: number, noteH: number) => {
      const norm = (midi - midiLo) / (midiHi - midiLo);
      return H - norm * (H - noteH * 1.5) - noteH;
    };

    const cursorX  = W * 0.22;
    const pxPerSec = (W * 0.78) / windowSec;
    const noteH    = Math.max(20, H * 0.22);

    partNotes.forEach(n => {
      const x    = cursorX + (n.start - elapsed) * pxPerSec;
      const endX = cursorX + (n.end   - elapsed) * pxPerSec;
      if (endX < 0 || x > W) return;

      const y      = pitchToY(n.midi, noteH);
      const noteW  = Math.max(4, endX - x - 3);
      const drawX  = Math.max(0, x);
      const drawW  = Math.min(noteW, W - drawX);
      const isCurr = elapsed >= n.start && elapsed < n.end;
      const isPast = n.end <= elapsed;
      const result = noteResults?.[n.id]; // true=hit, false=miss, undefined=unknown

      // Misses vanish entirely — the badge glow (below) is the feedback.
      if (isPast && result === false) return;

      let fill = colour + '70';   // upcoming — soft persistent glow
      let glow = colour;
      let glowBlur = 4;
      if (isCurr) {
        fill = colour; glow = colour; glowBlur = 16;
      } else if (isPast) {
        if (result === true) { fill = '#22c55e'; glow = '#22c55e'; glowBlur = 10; }
        else                  { fill = colour + '40'; glow = 'transparent'; glowBlur = 0; }
      }

      ctx.save();
      ctx.shadowColor = glow;
      ctx.shadowBlur  = glowBlur;
      ctx.fillStyle   = fill;
      rr(ctx, drawX, Math.max(2, y), drawW, noteH, 7);
      ctx.fill();
      ctx.restore();

      if (n.lyric && drawW > 22) {
        ctx.fillStyle = '#ffffff';
        ctx.font      = `bold ${Math.min(14, noteH - 4)}px system-ui,sans-serif`;
        ctx.fillText(n.lyric, drawX + 6, Math.max(2, y) + noteH - 5, drawW - 10);
      }
    });

    // Cue line — solid, thick, glowing gold "strike zone".
    ctx.save();
    ctx.shadowColor = '#f0b429';
    ctx.shadowBlur  = 16;
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth   = 3;
    ctx.beginPath(); ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, H); ctx.stroke();
    ctx.restore();

    // Live pitch dot (own part only) — converted to the SAME midi scale the
    // notes use, so it actually lines up with what's being sung.
    if (pitchHz !== undefined && pitchHz > 0) {
      const midi = hzToMidi(pitchHz);
      const norm = (midi - midiLo) / (midiHi - midiLo);
      const py   = H - Math.max(0, Math.min(1, norm)) * H;
      ctx.shadowColor = onTarget ? colour : 'transparent';
      ctx.shadowBlur  = onTarget ? 20 : 0;
      ctx.fillStyle   = onTarget ? colour : '#94a3b8';
      ctx.beginPath();
      ctx.arc(cursorX, py, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cursorX, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (partNotes.length === 0) {
      ctx.fillStyle = colour + '44';
      ctx.font      = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No notes assigned', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
  }, [partIndex, elapsed, notes, colour, pitchHz, onTarget, windowSec, noteResults]);

  return (
    <div
      className="flex items-stretch rounded-xl overflow-hidden border border-gray-800"
      style={{ minHeight: 92, flex: 1 }}
    >
      <div
        className="flex flex-col items-center justify-center flex-shrink-0 gap-0.5 transition-shadow duration-150"
        style={{
          width: 72,
          background: flash === 'hit' ? '#22c55e33' : flash === 'miss' ? '#ef444433' : colour + '22',
          borderRight: `1px solid ${colour}55`,
          boxShadow: flash === 'hit' ? 'inset 0 0 24px 4px #22c55e' : flash === 'miss' ? 'inset 0 0 24px 4px #ef4444' : 'none',
        }}
      >
        <span className="text-lg font-bold" style={{ color: colour }}>{partName[0]}</span>
        <span className="text-[10px] uppercase tracking-wide" style={{ color: colour + 'cc' }}>{partName}</span>
        {playerCount !== undefined && playerCount > 0 && (
          <span className="text-[10px] font-mono" style={{ color: colour }}>{playerCount}×</span>
        )}
      </div>
      <canvas ref={canvasRef} className="flex-1 h-full" />
    </div>
  );
}
