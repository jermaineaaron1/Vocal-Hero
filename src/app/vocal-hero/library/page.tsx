'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Song } from '@/lib/vocal-hero/types';

const PART_NAMES = ['Soprano', 'Alto', 'Tenor', 'Bass'];
const PART_COLOURS = ['#f472b6', '#fb923c', '#60a5fa', '#34d399'];
const STATUS_COLOUR: Record<string, string> = {
  draft:      'bg-gray-700 text-gray-300',
  processing: 'bg-yellow-600 text-yellow-100 animate-pulse',
  ready:      'bg-emerald-700 text-emerald-100',
  error:      'bg-red-800 text-red-200',
};

// ── Generate placeholder SATB curves ──────────────────────────────────────
// Creates 24 smooth keyframe values that approximate a melodic arch shape.
// These are intentionally gentle so manual songs are playable immediately.
function makePlaceholderCurves() {
  const N = 24;
  // Soprano: gentle arch, mid-high range
  const soprano = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    return Math.round((0.45 + 0.25 * Math.sin(Math.PI * t) + 0.05 * Math.sin(3 * Math.PI * t)) * 10000) / 10000;
  });
  // Alto: soprano shifted down ~4 semitones (normalized delta ≈ 0.088)
  const alto = soprano.map(v => Math.max(0, Math.round((v - 0.088) * 10000) / 10000));
  // Tenor: shifted down ~7 semitones (≈ 0.154)
  const tenor = soprano.map(v => Math.max(0, Math.round((v - 0.154) * 10000) / 10000));
  // Bass: shifted down ~12 semitones (≈ 0.264)
  const bass = soprano.map(v => Math.max(0, Math.round((v - 0.264) * 10000) / 10000));

  return [
    { name: 'Soprano', rangeMin: 260, rangeMax: 1050, curve: soprano, aiGen: false, edits: 0 },
    { name: 'Alto',    rangeMin: 175, rangeMax: 700,  curve: alto,    aiGen: false, edits: 0 },
    { name: 'Tenor',   rangeMin: 130, rangeMax: 525,  curve: tenor,   aiGen: false, edits: 0 },
    { name: 'Bass',    rangeMin: 80,  rangeMax: 330,  curve: bass,    aiGen: false, edits: 0 },
  ];
}

type Tab = 'youtube' | 'upload';

export default function VocalHeroLibraryPage() {
  const router                      = useRouter();
  const [songs, setSongs]           = useState<Song[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<Tab>('youtube');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast]           = useState('');
  const [generatingMidi, setGeneratingMidi] = useState<Set<string>>(new Set());
  const pollingRef                  = useRef<ReturnType<typeof setInterval> | null>(null);

  // YouTube pipeline form
  const [ytForm, setYtForm] = useState({
    title: '', artist: '', yt_url: '', prim_lang: 'en', trans_lang: 'none', tags: '',
  });
  const [ytError, setYtError] = useState('');

  // Audio file upload form
  const [upForm, setUpForm] = useState({ title: '', artist: '', prim_lang: 'en', tags: '' });
  const [upFile, setUpFile]   = useState<File | null>(null);  // MIDI for vocals
  const [upAudio, setUpAudio] = useState<File | null>(null);  // MP3 for background music
  const [upError, setUpError] = useState('');
  const [upAudioProgress, setUpAudioProgress] = useState('');

  // ── Fetch ──────────────────────────────────────────────────────────────
  async function loadSongs() {
    const res = await fetch('/api/songs');
    if (res.ok) setSongs(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    loadSongs();
    pollingRef.current = setInterval(() => {
      setSongs(prev => {
        const hasProcessing = prev.some(s => s.status === 'processing');
        if (hasProcessing) loadSongs();
        return prev;
      });
    }, 4000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 4000);
  }

  // ── YouTube pipeline submit ────────────────────────────────────────────
  async function handleYtSubmit(e: React.FormEvent) {
    e.preventDefault();
    setYtError('');
    if (!ytForm.title.trim()) { setYtError('Title is required'); return; }
    if (!ytForm.yt_url.trim()) { setYtError('YouTube URL is required'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ytForm),
      });
      const json = await res.json();
      if (!res.ok) { setYtError(json.error ?? 'Failed to queue — is the Python pipeline deployed?'); return; }
      showToast(`Queued "${ytForm.title}" — processing started`);
      setYtForm({ title: '', artist: '', yt_url: '', prim_lang: 'en', trans_lang: 'none', tags: '' });
      loadSongs();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Audio file upload submit (two-step: prepare → direct upload to Fly) ──
  // Step 1: create song stub via Next.js → get song_id + pipeline URL + key
  // Step 2: POST file directly to Fly.io pipeline (bypasses Vercel 4.5MB limit)
  async function handleUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUpError(''); setUpAudioProgress('');
    if (!upForm.title.trim()) { setUpError('Title is required'); return; }
    if (!upFile) { setUpError('Please select a vocals MIDI file'); return; }

    setSubmitting(true);
    try {
      // Step 1 — create song stub + get Fly upload credentials
      const prepRes = await fetch('/api/pipeline/upload/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:     upForm.title.trim(),
          artist:    upForm.artist.trim(),
          prim_lang: upForm.prim_lang,
          tags:      upForm.tags.trim(),
        }),
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) { setUpError(prep.error ?? 'Failed to prepare upload'); return; }

      const songId: string = prep.song_id;

      // Step 2 — send vocals MIDI to Fly pipeline for note parsing
      const formData = new FormData();
      formData.append('file', upFile, upFile.name);
      formData.append('prim_lang', upForm.prim_lang);

      const upRes = await fetch(prep.upload_url, {
        method: 'POST',
        headers: { 'x-api-key': prep.api_key },
        body: formData,
      });
      if (!upRes.ok) {
        const txt = await upRes.text();
        setUpError(`Pipeline error: ${txt}`);
        return;
      }

      // Step 3 — if an MP3 was provided, upload it to Supabase Storage as audio_url
      if (upAudio && songId) {
        try {
          setUpAudioProgress('Uploading background music…');

          // Get presigned URL from our API
          const sigRes = await fetch('/api/songs/audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ song_id: songId, filename: upAudio.name }),
          });
          const sig = await sigRes.json();
          if (!sigRes.ok) throw new Error(sig.error ?? 'Failed to get upload URL');

          // PUT file directly to Supabase Storage (no Vercel body limit)
          const putRes = await fetch(sig.upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': upAudio.type || 'audio/mpeg' },
            body: upAudio,
          });
          if (!putRes.ok) throw new Error(`Storage upload failed: ${putRes.status}`);

          // Save the public URL on the song
          await fetch(`/api/songs?id=${songId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_url: sig.public_url }),
          });
          setUpAudioProgress('');
        } catch (audioErr) {
          // Non-fatal — notes will still work, just no background music
          setUpAudioProgress(`⚠ Background music upload failed: ${String(audioErr)}`);
        }
      }

      const isMidi = upFile.name.match(/\.midi?$/i);
      showToast(`"${upForm.title}" — ${isMidi ? 'parsing MIDI notes…' : 'Basic Pitch detecting notes (~2 min)…'}${upAudio ? ' + background music saved' : ''}`);
      setUpForm({ title: '', artist: '', prim_lang: 'en', tags: '' });
      setUpFile(null); setUpAudio(null);
      (document.getElementById('upFileInput') as HTMLInputElement | null)?.value && ((document.getElementById('upFileInput') as HTMLInputElement).value = '');
      (document.getElementById('upAudioInput') as HTMLInputElement | null)?.value && ((document.getElementById('upAudioInput') as HTMLInputElement).value = '');
      loadSongs();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Publish / delete ──────────────────────────────────────────────────
  async function togglePublish(song: Song) {
    const newStatus = song.status === 'ready' ? 'draft' : 'ready';
    await fetch(`/api/songs?id=${song.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    loadSongs();
  }

  async function handleDelete(song: Song) {
    if (!confirm(`Delete "${song.title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/songs?id=${song.id}`, { method: 'DELETE' });
    if (res.ok) {
      setSongs(prev => prev.filter(s => s.id !== song.id));
    } else {
      const json = await res.json().catch(() => ({}));
      showToast('Delete failed: ' + (json.error ?? res.statusText));
    }
  }

  async function handleGenerateMidi(song: Song) {
    if (!song.yt_url) {
      showToast('No YouTube URL on this song — add one first');
      return;
    }
    setGeneratingMidi(prev => new Set(prev).add(song.id));
    try {
      const res = await fetch(`/api/pipeline/vocals/${song.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yt_url: song.yt_url }),
      });
      if (res.ok) {
        showToast(`Generating MIDI for "${song.title}" — check back in ~2 min`);
      } else {
        const json = await res.json().catch(() => ({}));
        showToast(json.error ?? 'Failed to start MIDI generation');
      }
    } finally {
      setGeneratingMidi(prev => { const s = new Set(prev); s.delete(song.id); return s; });
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 max-w-4xl mx-auto">

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-mono text-emerald-400 mb-1">
          🎤 Vocal Hero — Song Library
        </h1>
        <p className="text-gray-400 text-sm">
          Upload an audio file or paste a YouTube URL — Basic Pitch will detect the notes and populate the piano roll.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-900 border border-gray-700 rounded-xl p-1 w-fit">
        <button
          onClick={() => setTab('upload')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            tab === 'upload'
              ? 'bg-purple-700 text-white'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          🎵 Audio File
        </button>
        <button
          onClick={() => setTab('youtube')}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            tab === 'youtube'
              ? 'bg-red-700 text-white'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          ▶ YouTube Pipeline
        </button>
      </div>

      {/* Audio File Upload Form */}
      {tab === 'upload' && (
        <form onSubmit={handleUploadSubmit} className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-8 space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">File Upload Pipeline</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              placeholder="Song title *"
              value={upForm.title}
              onChange={e => setUpForm(f => ({ ...f, title: e.target.value }))}
            />
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              placeholder="Artist"
              value={upForm.artist}
              onChange={e => setUpForm(f => ({ ...f, artist: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              value={upForm.prim_lang}
              onChange={e => setUpForm(f => ({ ...f, prim_lang: e.target.value }))}
            >
              <option value="en">English</option>
              <option value="sw">Swahili</option>
              <option value="auto">Auto-detect</option>
            </select>
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-500"
              placeholder="Tags (comma separated)"
              value={upForm.tags}
              onChange={e => setUpForm(f => ({ ...f, tags: e.target.value }))}
            />
          </div>

          {/* Two file pickers side by side */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Vocals — MIDI or Audio */}
            <div className="bg-gray-800/60 border border-purple-900/40 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">🎹</span>
                <span className="text-xs font-semibold text-purple-300">Vocals *</span>
                <span className="text-xs bg-purple-900/60 text-purple-300 px-1.5 py-0.5 rounded-full ml-auto">
                  {upFile ? (upFile.name.match(/\.midi?$/i) ? '🎹 MIDI' : '🎵 Audio') : '.mid / .mp3 / .wav'}
                </span>
              </div>
              <p className="text-gray-500 text-xs">
                Upload a <strong className="text-purple-300">MIDI file</strong> for exact notes, or an <strong className="text-purple-300">MP3/WAV</strong> to detect notes with Basic Pitch AI.
              </p>
              <input
                id="upFileInput"
                type="file"
                accept=".mid,.midi,audio/midi,audio/x-midi,.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
                className="w-full text-xs text-gray-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-purple-800 file:text-purple-200 hover:file:bg-purple-700"
                onChange={e => setUpFile(e.target.files?.[0] ?? null)}
              />
              {upFile && (
                <p className="text-xs text-emerald-400">
                  ✓ {upFile.name} ({(upFile.size / 1024).toFixed(0)} KB)
                </p>
              )}
            </div>

            {/* Background Music MP3 */}
            <div className="bg-gray-800/60 border border-cyan-900/40 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">🎵</span>
                <span className="text-xs font-semibold text-cyan-300">Background Music</span>
                <span className="text-xs bg-cyan-900/40 text-cyan-400 px-1.5 py-0.5 rounded-full ml-auto">optional</span>
              </div>
              <p className="text-gray-500 text-xs">MP3/M4A of the full song — played during gameplay. May or may not include vocals.</p>
              <input
                id="upAudioInput"
                type="file"
                accept="audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a,.wav,audio/wav"
                className="w-full text-xs text-gray-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-cyan-800 file:text-cyan-200 hover:file:bg-cyan-700"
                onChange={e => setUpAudio(e.target.files?.[0] ?? null)}
              />
              {upAudio && (
                <p className="text-xs text-cyan-400">
                  ✓ {upAudio.name} ({(upAudio.size / 1024 / 1024).toFixed(1)} MB)
                </p>
              )}
              {upAudioProgress && (
                <p className={`text-xs ${upAudioProgress.startsWith('⚠') ? 'text-yellow-400' : 'text-cyan-400'}`}>
                  {upAudioProgress}
                </p>
              )}
            </div>
          </div>

          {upError && <p className="text-red-400 text-xs">{upError}</p>}

          <button
            type="submit"
            disabled={submitting || !upFile}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors"
          >
            {submitting ? '⏳ Uploading…' : `🎹 Upload${upAudio ? ' + Music' : ''}`}
          </button>
        </form>
      )}

      {/* YouTube Pipeline Form */}
      {tab === 'youtube' && (
        <form onSubmit={handleYtSubmit} className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-8 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">YouTube Pipeline</h2>
            <span className="text-xs bg-emerald-900 text-emerald-300 px-2 py-0.5 rounded-full">~7 min background job</span>
          </div>
          <p className="text-gray-500 text-xs">
            Paste a YouTube URL. The pipeline will download audio, detect pitch, generate SATB curves, and transcribe lyrics automatically.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
              placeholder="Song title *"
              value={ytForm.title}
              onChange={e => setYtForm(f => ({ ...f, title: e.target.value }))}
            />
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
              placeholder="Artist"
              value={ytForm.artist}
              onChange={e => setYtForm(f => ({ ...f, artist: e.target.value }))}
            />
          </div>
          <input
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
            placeholder="YouTube URL *  (e.g. https://www.youtube.com/watch?v=...)"
            value={ytForm.yt_url}
            onChange={e => setYtForm(f => ({ ...f, yt_url: e.target.value }))}
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
              value={ytForm.prim_lang}
              onChange={e => setYtForm(f => ({ ...f, prim_lang: e.target.value }))}
            >
              <option value="en">English</option>
              <option value="sw">Swahili</option>
              <option value="auto">Auto-detect</option>
            </select>
            <select
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
              value={ytForm.trans_lang}
              onChange={e => setYtForm(f => ({ ...f, trans_lang: e.target.value }))}
            >
              <option value="none">No translation</option>
              <option value="en">→ English</option>
              <option value="sw">→ Swahili</option>
            </select>
            <input
              className="bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
              placeholder="Tags"
              value={ytForm.tags}
              onChange={e => setYtForm(f => ({ ...f, tags: e.target.value }))}
            />
          </div>

          {ytError && <p className="text-red-400 text-xs">{ytError}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors"
          >
            {submitting ? 'Queueing…' : '▶ Queue Pipeline'}
          </button>
        </form>
      )}

      {/* Song list */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          All Songs ({songs.length})
        </h2>

        {loading && <p className="text-gray-500 text-sm">Loading…</p>}
        {!loading && songs.length === 0 && (
          <p className="text-gray-600 text-sm">No songs yet. Add one above.</p>
        )}

        {songs.map(song => (
          <div key={song.id} className="bg-gray-900 border border-gray-700 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm truncate">{song.title}</span>
                {song.artist && <span className="text-gray-400 text-xs">— {song.artist}</span>}
                <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${STATUS_COLOUR[song.status] ?? 'bg-gray-700 text-gray-300'}`}>
                  {song.status}
                </span>
                {song.audio_url && (
                  <span className="text-xs text-cyan-500" title="Has background music">🎵 audio</span>
                )}
                {song.pipeline_log === 'manually added' && (
                  <span className="text-xs text-gray-600">✏️ manual</span>
                )}
              </div>
              {song.pipeline_log && song.pipeline_log !== 'manually added' && (
                <p className="text-gray-500 text-xs mt-1 font-mono truncate">{song.pipeline_log}</p>
              )}
              {song.parts && song.parts.length > 0 && (
                <div className="flex gap-2 mt-1 flex-wrap">
                  {song.parts.map((p, i) => (
                    <span key={i} className="text-xs px-1.5 py-0.5 rounded font-mono"
                      style={{ background: PART_COLOURS[i] + '22', color: PART_COLOURS[i] }}>
                      {PART_NAMES[i] ?? p.name}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-gray-600 text-xs mt-1">
                {song.duration ? `${Math.floor(song.duration / 60)}m ${song.duration % 60}s` : ''}
                {song.prim_lang ? ` · ${song.prim_lang.toUpperCase()}` : ''}
                {song.tags ? ` · ${song.tags}` : ''}
                {song.timed_lyrics?.length ? ` · ${song.timed_lyrics.length} lyric section${song.timed_lyrics.length > 1 ? 's' : ''}` : ''}
              </p>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
              <button
                onClick={() => router.push(`/vocal-hero/library/${song.id}/edit`)}
                className="text-xs bg-blue-900 hover:bg-blue-800 text-blue-200 px-3 py-1.5 rounded-lg transition-colors">
                ✏️ Edit
              </button>
              <button
                onClick={() => handleGenerateMidi(song)}
                disabled={generatingMidi.has(song.id)}
                title={song.yt_url ? 'Convert audio to MIDI notes via Basic Pitch' : 'No YouTube URL — add one in Edit first'}
                className="text-xs bg-purple-900 hover:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed text-purple-200 px-3 py-1.5 rounded-lg transition-colors">
                {generatingMidi.has(song.id) ? '⏳ Generating…' : '🎹 Gen MIDI'}
              </button>
              {song.status === 'draft' && (
                <button onClick={() => togglePublish(song)}
                  className="text-xs bg-emerald-800 hover:bg-emerald-700 text-emerald-200 px-3 py-1.5 rounded-lg transition-colors">
                  Publish
                </button>
              )}
              {song.status === 'ready' && (
                <button onClick={() => togglePublish(song)}
                  className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded-lg transition-colors">
                  Unpublish
                </button>
              )}
              <button onClick={() => handleDelete(song)}
                className="text-xs bg-red-900 hover:bg-red-800 text-red-200 px-3 py-1.5 rounded-lg transition-colors">
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-700 text-white text-sm px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
