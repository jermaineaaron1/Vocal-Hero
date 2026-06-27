'use client';

// MIDI device capture for instrumentalists (Phase 3b). Three small, separate
// pieces, mirroring the PitchEngine/ScoreEngine split: MidiEngine talks to
// the actual Web MIDI API (browser-only, untestable without hardware);
// MidiRecorder is pure note-on/off pairing logic (no DOM dependency, fully
// testable with synthetic events); Metronome is a small Web Audio click
// track giving recordings a tempo reference, reusing the same AudioContext
// pattern already established in pitchEngine.ts.

import type { SongNote } from './types';

export interface MidiNoteEvent {
  type: 'on' | 'off';
  midi: number;
  velocity: number;   // 0-127
  timestamp: number;  // seconds since this MidiEngine connected
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── MidiEngine — thin Web MIDI wrapper ──────────────────────────────────────

export class MidiEngine {
  private access: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private startTime = 0;

  static get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async listDevices(): Promise<MidiDeviceInfo[]> {
    if (!MidiEngine.isSupported) return [];
    this.access = await navigator.requestMIDIAccess();
    return Array.from(this.access.inputs.values()).map(i => ({
      id: i.id,
      name: i.name ?? 'Unknown device',
      manufacturer: i.manufacturer ?? '',
    }));
  }

  connect(deviceId: string, onEvent: (e: MidiNoteEvent) => void): boolean {
    if (!this.access) return false;
    const input = this.access.inputs.get(deviceId);
    if (!input) return false;

    this.input = input;
    this.startTime = performance.now() / 1000;
    this.input.onmidimessage = (msg: MIDIMessageEvent) => {
      const data = msg.data;
      if (!data || data.length < 3) return;
      const status = data[0], note = data[1], velocity = data[2];
      const cmd = status & 0xf0;
      const timestamp = performance.now() / 1000 - this.startTime;
      if (cmd === 0x90 && velocity > 0) {
        onEvent({ type: 'on', midi: note, velocity, timestamp });
      } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
        onEvent({ type: 'off', midi: note, velocity, timestamp });
      }
    };
    return true;
  }

  disconnect(): void {
    if (this.input) this.input.onmidimessage = null;
    this.input = null;
  }
}

// ── MidiRecorder — pure note-on/off pairing, no Web MIDI/DOM dependency ────

export class MidiRecorder {
  private active = new Map<number, { start: number; velocity: number }>();
  private notes: SongNote[] = [];

  /** Feed it events in time order (as MidiEngine/a synthetic test produces them). */
  handleEvent(e: MidiNoteEvent): void {
    if (e.type === 'on') {
      this.active.set(e.midi, { start: e.timestamp, velocity: e.velocity });
      return;
    }
    const open = this.active.get(e.midi);
    if (!open) return; // note-off with no matching note-on — drop it, nothing to pair
    this.active.delete(e.midi);
    if (e.timestamp <= open.start) return; // degenerate zero/negative-length note — drop it
    this.notes.push({
      id: uid(), part: -1, midi: e.midi,
      start: open.start, end: e.timestamp,
      lyric: '', velocity: open.velocity,
    });
  }

  getNotes(): SongNote[] {
    return [...this.notes].sort((a, b) => a.start - b.start);
  }

  reset(): void {
    this.active.clear();
    this.notes = [];
  }
}

// ── Metronome — Web Audio click track ───────────────────────────────────────

export class Metronome {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private beatIndex = 0;

  start(bpm: number, timeSig: number, onTick?: (beatInBar: number) => void): void {
    this.stop();
    this.ctx = new AudioContext();
    this.beatIndex = 0;
    const beatLen = 60 / Math.max(bpm, 1);

    const tick = () => {
      if (!this.ctx) return;
      const beatInBar = this.beatIndex % Math.max(timeSig, 1);
      const accented = beatInBar === 0;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = accented ? 1320 : 880;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      osc.start(now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.stop(now + 0.08);
      onTick?.(beatInBar);
      this.beatIndex++;
    };

    tick();
    this.timer = setInterval(tick, beatLen * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }
}
