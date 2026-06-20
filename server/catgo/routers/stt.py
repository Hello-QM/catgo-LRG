"""Local speech-to-text — pluggable native engine + optional GPU accelerator.

Desktop/Tauri voice dictation routes audio here instead of running Whisper in
the webview (WebKit webviews leak ~0.8 GB of unreclaimable WASM memory per
inference and OOM). Two engines, chosen at runtime (engine_state, persisted):

- ``faster-whisper`` (default): CTranslate2. CPU int8 everywhere, CUDA float16
  on NVIDIA. Bundled in the sidecar.
- ``whispercpp``: shells out to a whisper.cpp ``whisper-cli`` built with Vulkan
  (AMD/Intel iGPU) or Metal (Apple). Not bundled — downloaded on demand via the
  /accel/* endpoints into a per-user dir (see catgo.stt.accel).

The browser still runs the Silero VAD and POSTs each segment as raw
little-endian float32 PCM at 16 kHz. zh Traditional→Simplified stays client-side.
"""

import logging
import os
import subprocess
import tempfile
import threading
import wave

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Query, Request
from pydantic import BaseModel

from ..stt import accel, engine_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stt", tags=["stt"])

# CPU inference threads. CTranslate2 defaults to a conservative 4; whisper.cpp
# uses this for -t too. Overridable via CATGO_STT_CPU_THREADS.
_CPU_THREADS = int(os.environ.get("CATGO_STT_CPU_THREADS") or min(8, os.cpu_count() or 4))

_SIZE_ALIASES = {
    "tiny": "tiny", "tiny.en": "tiny.en",
    "base": "base", "base.en": "base.en",
    "small": "small", "small.en": "small.en",
    "medium": "medium", "medium.en": "medium.en",
    "large": "large-v3", "large-v2": "large-v2", "large-v3": "large-v3",
    "large-v3-turbo": "large-v3-turbo", "turbo": "large-v3-turbo",
}


def _resolve_size(model: str) -> str:
    name = (model or "").split("/")[-1].lower().replace("whisper-", "")
    return _SIZE_ALIASES.get(name, "base")


def _whispercpp_bin() -> str:
    return os.environ.get("CATGO_WHISPERCPP_BIN") or str(accel.binary_path())


def _whispercpp_model_path(size: str) -> str:
    override = os.environ.get("CATGO_WHISPERCPP_MODELS")
    if override:
        return os.path.join(override, f"ggml-{size}.bin")
    return str(accel.model_path(size))


# ─── faster-whisper engine ───────────────────────────────────────────────
_model_cache: dict[str, object] = {}
_device_compute: tuple[str, str] | None = None
# Serializes model build + the cuda→cpu fallback. FastAPI runs sync endpoints in
# a threadpool, so concurrent first requests could otherwise build the same model
# twice or race on _device_compute during fallback.
_model_lock = threading.Lock()


def _select_device() -> tuple[str, str]:
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception as exc:  # pragma: no cover - best-effort probe
        logger.debug("CUDA probe failed, using CPU: %s", exc)
    return "cpu", "int8"


def _build_model(size: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    kwargs: dict = {"device": device, "compute_type": compute_type}
    if device == "cpu":
        kwargs["cpu_threads"] = _CPU_THREADS
    try:
        return WhisperModel(size, **kwargs)
    except Exception as exc:
        if os.environ.get("HF_ENDPOINT"):
            raise
        logger.warning(
            "STT model %s download failed (%s); retrying via hf-mirror.com", size, exc
        )
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
        return WhisperModel(size, **kwargs)


def _get_model(size: str):
    global _device_compute
    with _model_lock:
        if _device_compute is None:
            _device_compute = _select_device()
            logger.info("STT engine: faster-whisper device=%s compute=%s", *_device_compute)
        device, compute_type = _device_compute
        key = f"{size}:{device}"
        if key in _model_cache:
            return _model_cache[key]
        logger.info(
            "STT loading model %s (%s/%s, cpu_threads=%s)",
            size, device, compute_type, _CPU_THREADS if device == "cpu" else "-",
        )
        try:
            _model_cache[key] = _build_model(size, device, compute_type)
        except Exception as exc:
            if device != "cuda":
                raise
            logger.warning("CUDA STT load failed (%s); falling back to CPU int8", exc)
            _device_compute = ("cpu", "int8")
            device, compute_type = _device_compute
            key = f"{size}:{device}"
            if key not in _model_cache:
                _model_cache[key] = _build_model(size, device, compute_type)
        return _model_cache[key]


def _transcribe_faster_whisper(audio: np.ndarray, lang: str | None, size: str):
    whisper = _get_model(size)
    segments, info = whisper.transcribe(audio, language=lang, beam_size=1, vad_filter=False)
    text = "".join(seg.text for seg in segments).strip()
    return text, getattr(info, "language", None)


# ─── whisper.cpp (Vulkan/Metal) engine ───────────────────────────────────
def _transcribe_whispercpp(audio: np.ndarray, lang: str | None, size: str):
    model_path = _whispercpp_model_path(size)
    if not os.path.exists(model_path):
        raise HTTPException(
            status_code=503,
            detail=f"whisper.cpp model missing: ggml-{size}.bin (download it first)",
        )
    pcm16 = np.clip(audio * 32767.0, -32768, 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = tf.name
    try:
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm16.tobytes())
        cmd = [_whispercpp_bin(), "-m", model_path, "-f", wav_path, "-nt", "-t", str(_CPU_THREADS)]
        if lang:
            cmd += ["-l", lang]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except FileNotFoundError:
            raise HTTPException(status_code=503, detail="whisper-cli not installed")
        if proc.returncode != 0:
            logger.error("whisper.cpp failed: %s", proc.stderr[-500:])
            raise HTTPException(status_code=500, detail="whisper.cpp transcription failed")
        text = " ".join(line.strip() for line in proc.stdout.splitlines() if line.strip())
        return text.strip(), lang
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


# ─── API models ──────────────────────────────────────────────────────────
class STTHealth(BaseModel):
    available: bool
    engine: str
    device: str
    compute_type: str


class STTResult(BaseModel):
    text: str
    language: str | None = None


class AccelStatus(BaseModel):
    platform_key: str | None
    gpu_api: str | None
    gpu_name: str | None
    engine: str
    binary_installed: bool
    models_installed: list[str]
    download: dict


class EngineChoice(BaseModel):
    engine: str


# ─── Transcription ─────────────────────────────────────────────────────────
@router.get("/health", response_model=STTHealth)
def health() -> STTHealth:
    engine = engine_state.get_engine()
    if engine == "whispercpp":
        ok = os.path.exists(_whispercpp_bin())
        return STTHealth(available=ok, engine="whispercpp", device="vulkan/metal/cpu", compute_type="ggml")
    try:
        import faster_whisper  # noqa: F401

        device, compute_type = _select_device()
        return STTHealth(available=True, engine="faster-whisper", device=device, compute_type=compute_type)
    except Exception as exc:
        logger.info("Native STT unavailable: %s", exc)
        return STTHealth(available=False, engine="faster-whisper", device="none", compute_type="none")


@router.post("/transcribe", response_model=STTResult)
async def transcribe(
    request: Request,
    language: str = Query("en", description="BCP-47-ish tag; 'auto'/'' = detect"),
    model: str = Query("base", description="Client model id or size alias"),
) -> STTResult:
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio body")
    if len(raw) % 4 != 0:
        raise HTTPException(status_code=400, detail="body length not float32-aligned")
    audio = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if audio.size == 0:
        return STTResult(text="", language=None)

    size = _resolve_size(model)
    lang = None if language in ("", "auto") else language.split("-")[0]
    try:
        if engine_state.get_engine() == "whispercpp":
            text, out_lang = _transcribe_whispercpp(audio, lang or "en", size)
        else:
            text, out_lang = _transcribe_faster_whisper(audio, lang, size)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("STT transcription failed")
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}")
    return STTResult(text=text, language=out_lang)


# ─── Accelerator management ────────────────────────────────────────────────
@router.get("/accel/status", response_model=AccelStatus)
def accel_status() -> AccelStatus:
    gpu = accel.detect_gpu()
    return AccelStatus(
        platform_key=accel.platform_key(),
        gpu_api=gpu["gpu_api"],
        gpu_name=gpu["gpu_name"],
        engine=engine_state.get_engine(),
        binary_installed=accel.binary_installed(),
        models_installed=accel.installed_models(),
        download=accel.get_download(),
    )


@router.post("/accel/install")
def accel_install(background: BackgroundTasks) -> dict:
    if accel.get_download().get("active"):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    if not accel.platform_key():
        raise HTTPException(status_code=400, detail="no GPU accelerator for this platform")
    background.add_task(accel.install_binary)
    return {"started": True}


@router.post("/accel/model")
def accel_model(background: BackgroundTasks, size: str = Query(...)) -> dict:
    if accel.get_download().get("active"):
        raise HTTPException(status_code=409, detail="a download is already in progress")
    background.add_task(accel.download_model, _resolve_size(size))
    return {"started": True}


@router.post("/accel/engine")
def accel_engine(choice: EngineChoice = Body(...)) -> dict:
    engine = choice.engine
    if engine not in engine_state.VALID_ENGINES:
        raise HTTPException(status_code=400, detail=f"unknown engine: {engine}")
    if engine == "whispercpp" and not os.path.exists(_whispercpp_bin()):
        raise HTTPException(status_code=400, detail="whisper.cpp not installed — download it first")
    engine_state.set_engine(engine)
    return {"engine": engine}
