import yt_dlp, librosa, numpy as np, os, tempfile, traceback, uuid
import whisper
from harmoniser import harmonise_satb

_model = None

def get_model():
  global _model
  if _model is None:
    _model = whisper.load_model("tiny", device="cpu")
  return _model

def log(sb, song_id, stage, msg):
  try:
    sb.table("vh_songs").update({
      "pipeline_log": f"{stage}: {msg}"
    }).eq("id", song_id).execute()
  except:
    pass

def extract_audio(yt_url: str, out_path: str):
  opts = {
    "format": "bestaudio/best",
    "outtmpl": out_path,
    "postprocessors": [{
      "key": "FFmpegExtractAudio",
      "preferredcodec": "mp3",
      "preferredquality": "128"
    }],
    "noplaylist": True,
    "quiet": True,
  }
  with yt_dlp.YoutubeDL(opts) as ydl:
    info = ydl.extract_info(yt_url, download=True)
  return info.get("duration", 180), info.get("title", ""), info.get("uploader", "")

def extract_melody(audio_path: str, n_keyframes=24):
  # 8kHz is sufficient for vocal pitch range (80-1050 Hz); halves computation vs 16kHz
  # 90s is enough to capture melody shape; halves CPU time vs 180s
  audio, sr = librosa.load(audio_path, sr=8000, mono=True, duration=90)
  # YIN pitch detection: O(N) per frame, much faster than piptrack's STFT-based approach
  # hop_length=1024 halves frame count vs 512 → 2x faster YIN; 24 keyframes don't need fine resolution
  f0 = librosa.yin(audio, fmin=80.0, fmax=1050.0, sr=sr, hop_length=1024)
  pitch_arr = np.where(f0 < 80.0, 0.0, f0)
  pitch_arr = np.where(pitch_arr < 80, 0, pitch_arr)
  pitch_arr = np.where(pitch_arr > 1050, 0, pitch_arr)
  nz = pitch_arr > 0
  if nz.sum() > 2:
    x = np.arange(len(pitch_arr))
    pitch_arr = np.interp(x, x[nz], pitch_arr[nz])
  indices = np.linspace(0, len(pitch_arr)-1, n_keyframes, dtype=int)
  melody = pitch_arr[indices]
  VMIN, VMAX = 80.0, 1050.0
  melody_norm = np.clip(
    np.log2(np.maximum(melody, VMIN) / VMIN) / np.log2(VMAX / VMIN),
    0, 1
  )
  return melody_norm.tolist()

def transcribe_audio(audio_path: str, hint_lang: str = "en"):
  import whisper as wh
  m = get_model()
  # Load only first 90s at 16kHz (whisper native sample rate) — avoids transcribing full song
  audio_arr = wh.load_audio(audio_path)[:90 * 16000]
  # beam_size=1 (greedy) is ~3x faster than beam_size=5 on CPU
  result = m.transcribe(
    audio_arr,
    beam_size=1,
    language=hint_lang if hint_lang != "auto" else None,
    fp16=False
  )
  lang = result.get("language") or "en"
  segments = result.get("segments", [])
  sections = []
  buf, t0 = [], 0.0
  for i, seg in enumerate(segments):
    buf.append(seg["text"].strip())
    if seg["end"] - t0 >= 7 or i == len(segments) - 1:
      sections.append({
        "primary": " ".join(buf),
        "translation": "",
        "start": round(t0, 1),
        "end": round(seg["end"], 1)
      })
      buf, t0 = [], seg["end"]
  return sections, lang

def extract_notes_basic_pitch(audio_path: str, hint_lang: str = "en") -> list:
  """
  Use Spotify Basic Pitch for accurate audio-to-MIDI note detection, then
  align Whisper word timestamps to assign lyrics to notes.
  Returns a list of SongNote-compatible dicts.
  """
  from basic_pitch.inference import predict
  import whisper as wh

  # ── 1. Basic Pitch: audio → MIDI notes ──────────────────────────────────
  # Try to get the bundled model path; fall back to letting predict() find it
  try:
    from basic_pitch import ICASSP_2022_MODEL_PATH
    model_arg = ICASSP_2022_MODEL_PATH
  except (ImportError, AttributeError):
    model_arg = None

  try:
    if model_arg is not None:
      result = predict(audio_path, model_arg)
    else:
      result = predict(audio_path)
    # predict() returns (model_output, midi_data, note_events) — unpack safely
    midi_data = result[1] if len(result) > 1 else None
  except TypeError:
    # Some versions swap the argument order
    result = predict(model_arg, audio_path) if model_arg else predict(audio_path)
    midi_data = result[1] if len(result) > 1 else None

  raw_notes = []
  if midi_data is not None and hasattr(midi_data, 'instruments'):
    for instrument in midi_data.instruments:
      for note in instrument.notes:
        # Filter to singable vocal range (C2–C7 = MIDI 36–96)
        if 36 <= note.pitch <= 96:
          raw_notes.append({
            "id":       str(uuid.uuid4()),
            "part":     -1,
            "midi":     int(note.pitch),
            "start":    round(float(note.start), 3),
            "end":      round(float(note.end), 3),
            "lyric":    "",
            "velocity": int(note.velocity),
          })

  if not raw_notes:
    return []

  raw_notes.sort(key=lambda n: n["start"])

  # ── 2. Whisper: audio → word timestamps ─────────────────────────────────
  try:
    m = get_model()
    max_s = min(int(raw_notes[-1]["end"]) + 5, 120)
    audio_arr = wh.load_audio(audio_path)[:max_s * 16000]
    result = m.transcribe(
      audio_arr,
      beam_size=1,
      language=hint_lang if hint_lang not in ("auto", None) else None,
      fp16=False,
      word_timestamps=True,
    )
    words = []
    for seg in result.get("segments", []):
      for w in seg.get("words", []):
        text = w.get("word", "").strip()
        t0   = float(w.get("start", 0.0))
        t1   = float(w.get("end",   t0 + 0.3))
        if text and t1 > t0:
          words.append({"lyric": text, "start": t0, "end": t1})

    # ── 3. Align: assign each word to the note with the best time overlap ──
    for word in words:
      best_note    = None
      best_overlap = 0.0
      for note in raw_notes:
        overlap = min(note["end"], word["end"]) - max(note["start"], word["start"])
        if overlap > best_overlap:
          best_overlap = overlap
          best_note    = note
      if best_note and best_overlap > 0:
        sep = " " if best_note["lyric"] else ""
        best_note["lyric"] += sep + word["lyric"]

  except Exception:
    pass  # lyrics are optional; notes are the primary output

  return raw_notes


def extract_notes_from_midi(midi_path: str) -> list:
  """Parse a MIDI file and return SongNote-compatible dicts using pretty_midi.

  If the file has multiple melodic tracks (e.g. a full arrangement), we pick
  the single track whose notes best fit the vocal range (MIDI 48-84, C3-C6).
  Drum/percussion tracks are always skipped.
  """
  import pretty_midi
  VOCAL_LO, VOCAL_HI = 36, 88   # generous range: C2–E6

  pm = pretty_midi.PrettyMIDI(midi_path)

  # Collect non-drum tracks that have at least one note
  melodic = [inst for inst in pm.instruments if not inst.is_drum and inst.notes]

  if not melodic:
    return []

  if len(melodic) == 1:
    # Only one track — use it directly
    chosen = melodic
  else:
    # Score each track by the fraction of notes inside the vocal range.
    # The track with the highest score is treated as the vocal track.
    def vocal_score(inst):
      pitches = [n.pitch for n in inst.notes]
      in_range = sum(1 for p in pitches if VOCAL_LO <= p <= VOCAL_HI)
      return in_range / max(len(pitches), 1)

    best = max(melodic, key=vocal_score)
    chosen = [best]

  notes = []
  for instrument in chosen:
    for note in instrument.notes:
      notes.append({
        "id":       str(uuid.uuid4()),
        "part":     -1,
        "midi":     int(note.pitch),
        "start":    round(float(note.start), 3),
        "end":      round(float(note.end), 3),
        "lyric":    "",
        "velocity": int(note.velocity),
      })
  notes.sort(key=lambda n: n["start"])
  return notes


def run_vocal_detection_from_file(song_id, file_path, hint_lang, sb):
  """Process an uploaded audio or MIDI file and detect/parse notes."""
  try:
    is_midi = file_path.lower().endswith(('.mid', '.midi'))

    if is_midi:
      log(sb, song_id, "midi1", "Parsing MIDI file...")
      notes = extract_notes_from_midi(file_path)
      log(sb, song_id, "midi2", f"Saving {len(notes)} notes...")
    else:
      log(sb, song_id, "vocals1", "Processing uploaded audio...")
      log(sb, song_id, "vocals2", "Running Basic Pitch note detection...")
      notes = extract_notes_basic_pitch(file_path, hint_lang=hint_lang)
      log(sb, song_id, "vocals3", f"Saving {len(notes)} notes...")

    sb.table("vh_songs").update({
      "notes": notes,
      "status": "draft",
      "pipeline_log": f"{'midi' if is_midi else 'vocals'}: {len(notes)} notes detected"
    }).eq("id", song_id).execute()
  except Exception:
    sb.table("vh_songs").update({
      "status": "error",
      "pipeline_log": f"vocals-error: {traceback.format_exc()}"
    }).eq("id", song_id).execute()
  finally:
    try: os.unlink(file_path)
    except: pass


def run_vocal_detection(song_id, yt_url, sb):
  """Download audio, run Basic Pitch + Whisper, save notes[] to vh_songs."""
  try:
    log(sb, song_id, "vocals1", "Downloading audio...")
    with tempfile.TemporaryDirectory() as tmp:
      audio_path = os.path.join(tmp, "audio")
      _, _, _ = extract_audio(yt_url, audio_path)
      audio_file = audio_path + ".mp3"

      log(sb, song_id, "vocals2", "Running Basic Pitch note detection...")
      notes = extract_notes_basic_pitch(audio_file, hint_lang="en")

      log(sb, song_id, "vocals3", f"Saving {len(notes)} notes...")
      sb.table("vh_songs").update({
        "notes": notes,
        "status": "draft",
        "pipeline_log": f"vocals: {len(notes)} notes detected"
      }).eq("id", song_id).execute()

  except Exception:
    sb.table("vh_songs").update({
      "status": "error",
      "pipeline_log": f"vocals-error: {traceback.format_exc()}"
    }).eq("id", song_id).execute()


def run_pipeline(song_id, yt_url, prim_lang, trans_lang, sb):
  try:
    log(sb, song_id, "stage1", "Extracting audio from YouTube...")
    with tempfile.TemporaryDirectory() as tmp:
      audio_path = os.path.join(tmp, "audio")
      duration, yt_title, yt_artist = extract_audio(yt_url, audio_path)
      audio_file = audio_path + ".mp3"

      log(sb, song_id, "stage2", "Detecting melody pitch...")
      soprano_curve = extract_melody(audio_file)

      log(sb, song_id, "stage3", "Generating SATB harmonies...")
      parts = harmonise_satb(soprano_curve)

      log(sb, song_id, "stage4", "Transcribing lyrics with Whisper...")
      sections, detected_lang = transcribe_audio(audio_file, hint_lang=prim_lang)

      use_lang = prim_lang if prim_lang != "auto" else detected_lang

      log(sb, song_id, "stage5", "Saving to database...")
      sb.table("vh_songs").update({
        "status": "draft",
        "duration": int(duration),
        "parts": parts,
        "timed_lyrics": sections,
        "prim_lang": use_lang,
        "pipeline_log": "complete"
      }).eq("id", song_id).execute()

  except Exception as e:
    sb.table("vh_songs").update({
      "status": "error",
      "pipeline_log": f"error: {traceback.format_exc()}"
    }).eq("id", song_id).execute()
