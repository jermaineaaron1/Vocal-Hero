'use client';

import { useEffect, useRef } from 'react';
import type { SongNote } from '@/lib/vocal-hero/types';

// Shared SATB note lane — one full-width row per voice part, used by both
// the host (all 4 parts, always) and the phone ("All Voices" view, with the
// player's own part highlighted). Generalizes the scrolling-cursor pattern
// that already worked well on the phone's single-part view: notes scroll
// right→left through a fixed lookahead window toward a cue line, instead of
// squeezing the whole song into one static width (which is what made notes
// on the host screen unreadably small).

const MIDI_LO = 36; // C2 — must match the editor's range
const MIDI_HI = 84; // C6

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
  pitchNorm?: number;   // only passed for the viewer's own part — draws the live dot
  onTarget?: boolean;
  playerCount?: number; // host use — small "N×" badge
  windowSec?: number;
}

export function SatbLane({
  partIndex, partName, colour, elapsed, notes,
  pitchNorm, onTarget, playerCount, windowSec = 10,
}: SatbLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // Alternating pitch-lane bands
    for (let i = 0; i <= 8; i++) {
      const y = (i / 8) * H;
      ctx.strokeStyle = i % 2 === 0 ? '#1e293b' : '#172033';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const cursorX  = W * 0.22;
    const pxPerSec = (W * 0.78) / windowSec;
    const noteH    = Math.max(16, H * 0.16);

    const partNotes = notes.filter(n => n.part === partIndex);

    partNotes.forEach(n => {
      const x    = cursorX + (n.start - elapsed) * pxPerSec;
      const endX = cursorX + (n.end   - elapsed) * pxPerSec;
      if (endX < 0 || x > W) return;

      const norm   = (n.midi - MIDI_LO) / (MIDI_HI - MIDI_LO);
      const y      = H - norm * (H - noteH * 1.5) - noteH;
      const noteW  = Math.max(4, endX - x - 3);
      const drawX  = Math.max(0, x);
      const drawW  = Math.min(noteW, W - drawX);
      const isCurr = elapsed >= n.start && elapsed < n.end;

      ctx.fillStyle   = isCurr ? colour : colour + '55';
      ctx.strokeStyle = isCurr ? colour + 'cc' : 'transparent';
      ctx.lineWidth   = 1.5;
      rr(ctx, drawX, Math.max(2, y), drawW, noteH, 6);
      ctx.fill();
      if (isCurr) ctx.stroke();

      if (n.lyric && drawW > 20) {
        ctx.fillStyle = isCurr ? '#fff' : '#ffffff88';
        ctx.font      = `bold ${Math.min(13, noteH - 4)}px system-ui,sans-serif`;
        ctx.fillText(n.lyric, drawX + 5, Math.max(2, y) + noteH - 4, drawW - 8);
      }
    });

    // Cue line — solid, thick, glowing gold. This is the "sing now" marker.
    ctx.save();
    ctx.shadowColor = '#f0b429';
    ctx.shadowBlur  = 14;
    ctx.strokeStyle = '#f0b429';
    ctx.lineWidth   = 3;
    ctx.beginPath(); ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, H); ctx.stroke();
    ctx.restore();

    // Live pitch dot (own part only)
    if (pitchNorm !== undefined && pitchNorm > 0) {
      const py = H - pitchNorm * H;
      ctx.shadowColor = onTarget ? colour : 'transparent';
      ctx.shadowBlur  = onTarget ? 18 : 0;
      ctx.fillStyle   = onTarget ? colour : '#94a3b8';
      ctx.beginPath();
      ctx.arc(cursorX, py, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cursorX, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (partNotes.length === 0) {
      ctx.fillStyle = colour + '44';
      ctx.font      = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No notes assigned', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
  }, [partIndex, elapsed, notes, colour, pitchNorm, onTarget, windowSec]);

  return (
    <div
      className="flex items-stretch rounded-xl overflow-hidden border border-gray-800"
      style={{ minHeight: 92, flex: 1 }}
    >
      <div
        className="flex flex-col items-center justify-center flex-shrink-0 gap-0.5"
        style={{ width: 72, background: colour + '22', borderRight: `1px solid ${colour}55` }}
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
