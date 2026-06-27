FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  build-essential \
  nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip setuptools wheel

# PyTorch CPU-only
RUN pip install --no-cache-dir torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

# Whisper transcription via openai-whisper (uses PyTorch, no ctranslate2/av build deps)
RUN pip install --no-cache-dir openai-whisper

# Remaining dependencies
RUN pip install --no-cache-dir \
    fastapi==0.111.0 \
    uvicorn==0.29.0 \
    "yt-dlp" \
    "librosa>=0.10.2" \
    "numpy==1.26.4" \
    "supabase==2.4.6" \
    "python-multipart==0.0.9" \
    "httpx==0.27.0" \
    "soundfile==0.12.1" \
    "basic-pitch"

# Pre-download model weights into the image so runtime needs no network fetch
RUN python -c "import whisper; whisper.load_model('tiny')"
RUN python -c "from basic_pitch import ICASSP_2022_MODEL_PATH; print('Basic Pitch model path:', ICASSP_2022_MODEL_PATH)"

COPY . .

EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
