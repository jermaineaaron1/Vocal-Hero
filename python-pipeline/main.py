from fastapi import FastAPI, BackgroundTasks, Header, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pipeline import run_pipeline, run_vocal_detection, run_vocal_detection_from_file
from supabase import create_client
import os, uuid, tempfile, shutil

app = FastAPI()

app.add_middleware(CORSMiddleware,
  allow_origins=["*"],
  allow_methods=["*"],
  allow_headers=["*"])

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
API_SECRET   = os.getenv("PIPELINE_SECRET", "dev-secret")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

def verify(x_api_key: str = Header(None)):
  if x_api_key != API_SECRET:
    raise HTTPException(status_code=401, detail="Unauthorized")

@app.get("/health")
async def health():
  return {"status": "ok"}

@app.get("/debug/formats")
async def debug_formats(url: str, x_api_key: str = Header(None)):
  verify(x_api_key)
  import yt_dlp, tempfile
  cookies = os.getenv("YOUTUBE_COOKIES", "")
  cookie_file = None
  if cookies:
    tf = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    tf.write(cookies)
    tf.close()
    cookie_file = tf.name
  # Test different client combinations
  results = {}
  for label, opts_extra in [
    ("ios+cookies",      {"extractor_args": {"youtube": {"player_client": ["ios"]}}}),
    ("tv_embedded",      {"extractor_args": {"youtube": {"player_client": ["tv_embedded"]}}}),
    ("android+cookies",  {"extractor_args": {"youtube": {"player_client": ["android"]}}}),
  ]:
    opts = {"quiet": True, "noplaylist": True, **opts_extra}
    if cookie_file and "cookies" in label:
      opts["cookiefile"] = cookie_file
    try:
      with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
      results[label] = {"formats": len(info.get("formats", [])), "title": info.get("title", "")}
    except Exception as e:
      results[label] = {"error": str(e)[:120]}
  if cookie_file:
    try: os.unlink(cookie_file)
    except: pass
  return {"cookie_lines": len(cookies.splitlines()) if cookies else 0, "results": results}

@app.post("/pipeline/start")
async def start(body: dict, bg: BackgroundTasks, x_api_key: str = Header(None)):
  verify(x_api_key)
  song_id = body.get("song_id", str(uuid.uuid4()))
  yt_url  = body["yt_url"]
  prim_lang = body.get("prim_lang", "en")
  trans_lang = body.get("trans_lang", "none")
  sb.table("vh_songs").upsert({"id": song_id, "status": "processing"}).execute()
  bg.add_task(run_pipeline, song_id, yt_url, prim_lang, trans_lang, sb)
  return {"status": "queued", "song_id": song_id}

@app.get("/pipeline/status/{song_id}")
async def status(song_id: str, x_api_key: str = Header(None)):
  verify(x_api_key)
  row = sb.table("vh_songs").select("status,pipeline_log").eq("id", song_id).single().execute()
  return row.data

@app.post("/pipeline/vocals/{song_id}")
async def vocals(song_id: str, body: dict, bg: BackgroundTasks, x_api_key: str = Header(None)):
  verify(x_api_key)
  yt_url = body.get("yt_url")
  if not yt_url:
    raise HTTPException(status_code=400, detail="yt_url is required")
  bg.add_task(run_vocal_detection, song_id, yt_url, sb)
  return {"status": "queued", "song_id": song_id}

@app.post("/pipeline/upload/{song_id}")
async def upload_audio(
  song_id: str,
  bg: BackgroundTasks,
  file: UploadFile = File(...),
  prim_lang: str = Form("en"),
  x_api_key: str = Header(None)
):
  verify(x_api_key)
  # Accept MIDI (parsed directly) or audio (Basic Pitch detection).
  # MP3 background music goes to Supabase Storage separately — not here.
  fname = (file.filename or "").lower()
  allowed = (".mid", ".midi", ".mp3", ".wav", ".m4a", ".ogg", ".flac")
  if not any(fname.endswith(ext) for ext in allowed):
    raise HTTPException(
      status_code=415,
      detail=f"Unsupported file type: {file.filename!r}. "
             f"Accepted: MIDI (.mid/.midi) or audio (.mp3/.wav/.m4a)."
    )
  # Save upload to a persistent temp file (BackgroundTask runs after response)
  suffix = os.path.splitext(file.filename or "audio.mp3")[1] or ".mp3"
  tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
  try:
    shutil.copyfileobj(file.file, tmp)
  finally:
    tmp.close()
  sb.table("vh_songs").upsert({"id": song_id, "status": "processing"}).execute()
  bg.add_task(run_vocal_detection_from_file, song_id, tmp.name, prim_lang, sb)
  return {"status": "queued", "song_id": song_id}
