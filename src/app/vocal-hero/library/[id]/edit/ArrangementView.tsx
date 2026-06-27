'use client';

// Chord-chart reading aid for instrumentalists (Phase 3a), plus MIDI
// recording capture (Phase 3b). Chords are derived on-the-fly from the
// song's existing SATB notes — nothing here is persisted except a saved
// recording itself, so there's no stale-vs-edited reconciliation to manage
// for the chart. Comparing a recording against the chart and giving
// feedback is a later phase — this is pure capture.

import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveChordChart } from '@/lib/vocal-hero/chords';
import { MidiEngine, MidiRecorder, Metronome, type MidiDeviceInfo } from '@/lib/vocal-hero/midiEngine';
import { PitchEngine } from '@/lib/vocal-hero/pitchEngine';
import { PitchNoteSegmenter, OnsetSegmenter } from '@/lib/vocal-hero/micRecorder';
import { analyzePitchedRecording, analyzePercussionRecording, summarize, type FeedbackMetrics } from '@/lib/vocal-hero/feedback';
import type { Recording, SongNote } from '@/lib/vocal-hero/types';

interface Props {
  songId: string;
  notes: SongNote[];
  bpm: number;
  timeSig: number;
  duration: number;
}

const GROUP_SIZE = 4; // bars per groove-cue group (a typical phrase length)

export default function ArrangementView({ songId, notes, bpm, timeSig, duration }: Props) {
  const hasHarmony = notes.some(n => n.part >= 0 && n.part < 4);

  const events = useMemo(
    () => (hasHarmony ? deriveChordChart(notes, bpm, timeSig, duration) : []),
    [notes, bpm, timeSig, duration, hasHarmony]
  );

  // Free-text groove cue per bar-group — manually entered, not auto-detected,
  // and session-local for this phase (not yet saved to the song record).
  const [grooveTags, setGrooveTags] = useState<Record<number, string>>({});

  // ── My Recordings + rule-based feedback (Phase 3d) ────────────────────────
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [analyzed, setAnalyzed] = useState<Record<string, FeedbackMetrics>>({});

  async function reloadRecordings() {
    try {
      const res = await fetch(`/api/recordings?songId=${songId}`);
      if (res.ok) setRecordings(await res.json());
    } catch { /* non-fatal — list just stays as-is */ }
  }

  useEffect(() => { reloadRecordings(); }, [songId]);

  function handleAnalyze(rec: Recording) {
    const metrics = rec.source === 'mic-percussion'
      ? analyzePercussionRecording(rec.notes, bpm, timeSig, duration)
      : analyzePitchedRecording(rec.notes, events, bpm, timeSig);
    setAnalyzed(a => ({ ...a, [rec.id]: metrics }));
  }

  const SOURCE_LABEL: Record<Recording['source'], string> = {
    midi: '🎹 MIDI', 'mic-pitch': '🎤 Mic (pitched)', 'mic-percussion': '🎤 Mic (percussion)',
  };

  // ── MIDI recording (Phase 3b) ─────────────────────────────────────────────
  const midiSupported = MidiEngine.isSupported;
  const [devices, setDevices] = useState<MidiDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [lastRecordedCount, setLastRecordedCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [recMsg, setRecMsg] = useState('');

  const engineRef = useRef<MidiEngine | null>(null);
  const recorderRef = useRef<MidiRecorder | null>(null);
  const metronomeRef = useRef<Metronome | null>(null);

  async function handleListDevices() {
    if (!engineRef.current) engineRef.current = new MidiEngine();
    try {
      const found = await engineRef.current.listDevices();
      setDevices(found);
      if (found.length && !deviceId) setDeviceId(found[0].id);
      if (!found.length) setRecMsg('No MIDI devices found — plug one in and try again.');
      else setRecMsg('');
    } catch {
      setRecMsg('Could not access MIDI devices — check browser permissions.');
    }
  }

  function handleConnect() {
    if (!engineRef.current || !deviceId) return;
    recorderRef.current = new MidiRecorder();
    const ok = engineRef.current.connect(deviceId, e => recorderRef.current?.handleEvent(e));
    setConnected(ok);
    setRecMsg(ok ? '' : 'Could not connect to that device.');
  }

  function handleRecordToggle() {
    if (!recording) {
      recorderRef.current?.reset();
      metronomeRef.current = new Metronome();
      metronomeRef.current.start(bpm, timeSig);
      setRecording(true);
      setLastRecordedCount(null);
      setRecMsg('');
    } else {
      metronomeRef.current?.stop();
      metronomeRef.current = null;
      const captured = recorderRef.current?.getNotes() ?? [];
      setLastRecordedCount(captured.length);
      setRecording(false);
    }
  }

  async function handleSaveRecording() {
    const captured = recorderRef.current?.getNotes() ?? [];
    if (!captured.length) { setRecMsg('Nothing captured yet — record a take first.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/recordings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId, partIndex: -1, source: 'midi', notes: captured }),
      });
      if (res.ok) { setRecMsg(`✓ Saved (${captured.length} notes).`); reloadRecordings(); }
      else { const er = await res.json().catch(() => ({})); setRecMsg('Save failed: ' + (er.error ?? res.statusText)); }
    } catch (err) {
      setRecMsg('Save failed: ' + String(err));
    } finally {
      setSaving(false);
    }
  }

  // ── Mic recording (Phase 3c) ───────────────────────────────────────────────
  const [micMode, setMicMode] = useState<'pitch' | 'percussion'>('pitch');
  const [micRecording, setMicRecording] = useState(false);
  const [micLastCount, setMicLastCount] = useState<number | null>(null);
  const [micSaving, setMicSaving] = useState(false);
  const [micMsg, setMicMsg] = useState('');

  const pitchEngineRef = useRef<PitchEngine | null>(null);
  const pitchSegmenterRef = useRef<PitchNoteSegmenter | null>(null);
  const onsetSegmenterRef = useRef<OnsetSegmenter | null>(null);
  const micMetronomeRef = useRef<Metronome | null>(null);

  async function handleMicRecordToggle() {
    if (!micRecording) {
      setMicMsg('');
      if (micMode === 'pitch') pitchSegmenterRef.current = new PitchNoteSegmenter();
      else onsetSegmenterRef.current = new OnsetSegmenter();

      // Wide enough to cover bass (open E ~41Hz) through guitar — wider than
      // PitchEngine's vocalist-tuned default, passed per-instance here only.
      const engine = new PitchEngine({
        minHz: 38, maxHz: 1200,
        onPitch: sample => {
          if (micMode === 'pitch') {
            pitchSegmenterRef.current?.handleSample(sample);
          } else {
            onsetSegmenterRef.current?.handleSample(sample);
          }
        },
      });
      try {
        await engine.start();
      } catch {
        setMicMsg('Could not access the microphone — check browser permissions.');
        return;
      }
      pitchEngineRef.current = engine;
      micMetronomeRef.current = new Metronome();
      micMetronomeRef.current.start(bpm, timeSig);
      setMicLastCount(null);
      setMicRecording(true);
    } else {
      pitchEngineRef.current?.stop();
      pitchEngineRef.current = null;
      micMetronomeRef.current?.stop();
      micMetronomeRef.current = null;
      const segmenter = micMode === 'pitch' ? pitchSegmenterRef.current : onsetSegmenterRef.current;
      segmenter?.finish();
      const captured = segmenter?.getNotes() ?? [];
      setMicLastCount(captured.length);
      setMicRecording(false);
    }
  }

  async function handleSaveMicRecording() {
    const segmenter = micMode === 'pitch' ? pitchSegmenterRef.current : onsetSegmenterRef.current;
    const captured = segmenter?.getNotes() ?? [];
    if (!captured.length) { setMicMsg('Nothing captured yet — record a take first.'); return; }
    setMicSaving(true);
    try {
      const res = await fetch('/api/recordings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId, partIndex: -1, source: micMode === 'pitch' ? 'mic-pitch' : 'mic-percussion', notes: captured }),
      });
      if (res.ok) { setMicMsg(`✓ Saved (${captured.length} notes).`); reloadRecordings(); }
      else { const er = await res.json().catch(() => ({})); setMicMsg('Save failed: ' + (er.error ?? res.statusText)); }
    } catch (err) {
      setMicMsg('Save failed: ' + String(err));
    } finally {
      setMicSaving(false);
    }
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
      {/* ── MIDI recording panel ── */}
      <div className="mb-3 bg-[#14142a] border border-purple-900/30 rounded p-3">
        {!midiSupported ? (
          <div className="text-xs text-gray-500">
            🎹 MIDI recording needs Chrome or Edge — not supported in this browser.
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 font-bold">🎹 MIDI:</span>
            {!devices.length ? (
              <button onClick={handleListDevices}
                className="text-xs bg-[#1a1a2e] hover:bg-[#22223a] border border-purple-900/40 text-[#22d3ee] px-3 py-1 rounded transition-colors">
                Connect MIDI Device
              </button>
            ) : (
              <>
                <select value={deviceId} onChange={e => { setDeviceId(e.target.value); setConnected(false); }}
                  className="bg-[#1a1a2e] border border-purple-900/30 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none">
                  {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                {!connected ? (
                  <button onClick={handleConnect}
                    className="text-xs bg-[#1a1a2e] hover:bg-[#22223a] border border-purple-900/40 text-[#22d3ee] px-3 py-1 rounded transition-colors">
                    Connect
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-green-400">● connected</span>
                    <button onClick={handleRecordToggle}
                      className={`text-xs px-3 py-1 rounded font-bold transition-colors ${recording ? 'bg-red-900/60 border border-red-500 text-red-200' : 'bg-[#1a1a2e] border border-purple-900/40 text-[#22d3ee] hover:bg-[#22223a]'}`}>
                      {recording ? '■ Stop' : '● Record'}
                    </button>
                    {lastRecordedCount !== null && !recording && (
                      <>
                        <span className="text-xs text-gray-400">{lastRecordedCount} notes captured</span>
                        <button onClick={handleSaveRecording} disabled={saving}
                          className="text-xs bg-purple-900 hover:bg-purple-800 disabled:opacity-40 text-purple-200 px-3 py-1 rounded transition-colors">
                          {saving ? 'Saving…' : 'Save Recording'}
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {recMsg && <span className="text-xs text-gray-500">{recMsg}</span>}
          </div>
        )}
      </div>

      {/* ── Mic recording panel (guitar/bass/cajon) ── */}
      <div className="mb-3 bg-[#14142a] border border-purple-900/30 rounded p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 font-bold">🎤 Mic:</span>
          <select value={micMode} onChange={e => setMicMode(e.target.value as 'pitch' | 'percussion')}
            disabled={micRecording}
            className="bg-[#1a1a2e] border border-purple-900/30 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none disabled:opacity-50">
            <option value="pitch">Pitched (Guitar/Bass)</option>
            <option value="percussion">Percussion (Cajon)</option>
          </select>
          <button onClick={handleMicRecordToggle}
            className={`text-xs px-3 py-1 rounded font-bold transition-colors ${micRecording ? 'bg-red-900/60 border border-red-500 text-red-200' : 'bg-[#1a1a2e] border border-purple-900/40 text-[#22d3ee] hover:bg-[#22223a]'}`}>
            {micRecording ? '■ Stop' : '● Record'}
          </button>
          {micLastCount !== null && !micRecording && (
            <>
              <span className="text-xs text-gray-400">{micLastCount} notes captured</span>
              <button onClick={handleSaveMicRecording} disabled={micSaving}
                className="text-xs bg-purple-900 hover:bg-purple-800 disabled:opacity-40 text-purple-200 px-3 py-1 rounded transition-colors">
                {micSaving ? 'Saving…' : 'Save Recording'}
              </button>
            </>
          )}
          {micMsg && <span className="text-xs text-gray-500">{micMsg}</span>}
        </div>
      </div>

      {/* ── My Recordings + rule-based feedback ── */}
      <div className="mb-3 bg-[#14142a] border border-purple-900/30 rounded p-3">
        <div className="text-xs text-gray-500 font-bold mb-2">📊 My Recordings</div>
        {!recordings.length ? (
          <div className="text-xs text-gray-600">No recordings saved yet — record a take above to see it here.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {recordings.map(rec => {
              const metrics = analyzed[rec.id];
              return (
                <div key={rec.id} className="border border-purple-900/20 rounded p-2">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="text-gray-300">{SOURCE_LABEL[rec.source]}</span>
                    <span className="text-gray-600">{new Date(rec.created_at).toLocaleString()}</span>
                    <span className="text-gray-600">{rec.notes.length} notes</span>
                    <button onClick={() => handleAnalyze(rec)}
                      className="text-xs bg-[#1a1a2e] hover:bg-[#22223a] border border-purple-900/40 text-[#22d3ee] px-2 py-0.5 rounded transition-colors">
                      Analyze
                    </button>
                  </div>
                  {metrics && (
                    <div className="mt-2 text-xs text-gray-400">
                      <div className="flex gap-4 flex-wrap mb-1">
                        {metrics.chordToneAccuracy !== undefined && (
                          <span>Chord-tone accuracy: <strong className="text-gray-200">{Math.round(metrics.chordToneAccuracy * 100)}%</strong></span>
                        )}
                        <span>Timing deviation: <strong className="text-gray-200">{Math.round(metrics.onsetMeanAbsDeviationMs)}ms</strong></span>
                        <span>Bars covered: <strong className="text-gray-200">{metrics.barsCovered}/{metrics.totalBars}</strong></span>
                      </div>
                      <ul className="list-disc list-inside">
                        {summarize(metrics).map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!hasHarmony ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm text-center px-8 py-10">
          No chords detected yet — harmonize the melody first (Import MIDI, Detect Vocals, or Regenerate Harmony on the Piano Roll tab).
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
