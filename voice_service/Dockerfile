# GPU image for the Chatterbox-Turbo voice service (Linux + NVIDIA CUDA).
#
#   docker build -t morning-brief-voice .
#   docker run --gpus all -p 8090:8090 \
#     -v voice-models:/models \
#     -v "$PWD/data/voices:/app/data/voices" \
#     morning-brief-voice
#
# The base image already carries Python 3.11 and a CUDA build of PyTorch, which is
# what chatterbox-tts 0.1.7 wants, so nothing re-downloads torch. Mount a volume at
# HF_HOME to keep the model weights (and the precomputed .conds.pt files) across
# container restarts; otherwise each cold start re-fetches them.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    VOICE_DIR=/app/data/voices \
    PORT=8090 \
    PRELOAD_VOICE=1

# libsndfile for soundfile; ffmpeg for librosa's non-WAV inputs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY api ./api
COPY turbo_voice ./turbo_voice
COPY data/voices ./data/voices
RUN pip install -e .

# Pre-download the Chatterbox-Turbo weights during build so cold-starts never fetch over WAN
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('ResembleAI/chatterbox-turbo', allow_patterns=['*.safetensors', '*.json', '*.txt', '*.pt', '*.model'])"

EXPOSE 8090
CMD ["sh", "-c", "exec uvicorn --app-dir . api.app:app --host 0.0.0.0 --port ${PORT:-8090} --workers 1"]
