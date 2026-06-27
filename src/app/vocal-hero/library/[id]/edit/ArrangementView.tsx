'use client';

// Chord-chart reading aid for instrumentalists (Phase 3a). Chords are
// derived on-the-fly from the song's existing SATB notes — nothing here is
// persisted, so there's no stale-vs-edited reconciliation to manage.

import { useMemo, useState } from 'react';
import { deriveChordChart } from '@/lib/vocal-hero/chords';
import type { SongNote } from '@/lib/vocal-hero/types';

interface Props {
  notes: SongNote[];
  bpm: number;
  timeSig: number;
  duration: number;
}

const GROUP_SIZE = 4; // bars per groove-cue group (a typical phrase length)

export default function ArrangementView({ notes, bpm, timeSig, duration }: Props) {
  const hasHarmony = notes.some(n => n.part >= 0 && n.part < 4);

  const events = useMemo(
    () => (hasHarmony ? deriveChordChart(notes, bpm, timeSig, duration) : []),
    [notes, bpm, timeSig, duration, hasHarmony]
  );

  // Free-text groove cue per bar-group — manually entered, not auto-detected,
  // and session-local for this phase (not yet saved to the song record).
  const [grooveTags, setGrooveTags] = useState<Record<number, string>>({});

  if (!hasHarmony) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm text-center px-8" style={{ minHeight: 0 }}>
        No chords detected yet — harmonize the melody first (Import MIDI, Detect Vocals, or Regenerate Harmony on the Piano Roll tab).
      </div>
    );
  }

  function lyricForBar(start: number, end: number): string {
    return notes
      .filter(n => n.part === 0 && n.lyric && n.start < end && n.end > start)
      .sort((a, b) => a.start - b.start)
      .map(n => n.lyric)
      .join(' ');
  }

  return (
    <div className="flex-1 overflow-auto px-3 py-3" style={{ minHeight: 0 }}>
      <div className="text-xs text-gray-500 mb-2">
        Chord chart auto-derived from the SATB harmony — one chord per bar at {bpm} BPM, {timeSig}/4 time.
        Plain-text chord symbols work for Piano/Guitar/Bass; the groove cue is a free-text reminder for
        Drums/Cajon (not saved yet — a fast-follow).
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-gray-500 text-xs">
            <th className="py-1 pr-3 w-12">Bar</th>
            <th className="py-1 pr-3 w-20">Chord</th>
            <th className="py-1 pr-3">Lyric</th>
            <th className="py-1 pr-3 w-40">Groove cue</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev, i) => {
            const groupStart = Math.floor(i / GROUP_SIZE) * GROUP_SIZE;
            const groupSpan = Math.min(GROUP_SIZE, events.length - groupStart);
            const showGrooveInput = i === groupStart;
            return (
              <tr key={ev.bar} className="border-t border-purple-900/15">
                <td className="py-1.5 pr-3 text-gray-600 font-mono">{ev.bar + 1}</td>
                <td className="py-1.5 pr-3 font-bold text-[#22d3ee]">{ev.symbol}</td>
                <td className="py-1.5 pr-3 text-gray-300">{lyricForBar(ev.start, ev.end)}</td>
                <td className="py-1.5 pr-3">
                  {showGrooveInput && (
                    <input
                      placeholder="e.g. verse groove"
                      value={grooveTags[groupStart] ?? ''}
                      onChange={e => setGrooveTags(g => ({ ...g, [groupStart]: e.target.value }))}
                      title={`Bars ${groupStart + 1}-${groupStart + groupSpan}`}
                      className="bg-[#1a1a2e] border border-purple-900/30 rounded px-2 py-0.5 text-xs text-gray-300 w-full focus:outline-none focus:border-[#7c3aed]"
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
