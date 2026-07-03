import ctypes, glob, logging, os, sysconfig, tempfile

import numpy as np
from fastapi import FastAPI, UploadFile, File, Form

log = logging.getLogger("stt_sidecar")

# Device selection (audit B2): STT_DEVICE=auto tries cuda/float16 first and falls
# back to cpu/int8 on any init failure. Explicit values are used as-is.
STT_DEVICE = os.environ.get("STT_DEVICE", "auto")
STT_COMPUTE = os.environ.get("STT_COMPUTE", "auto")


def _preload_cuda_libs():
    """Load pip-installed NVIDIA runtime libs (cublas/cudnn/cuda_nvrtc/...) into
    the process before ctranslate2 dlopen()s them at inference time.

    The `nvidia-*-cu12` wheels ship their .so files under
    site-packages/nvidia/<pkg>/lib/ instead of on the system loader path, so a
    fresh model *loads* fine on cuda but the first inference call fails with
    'Library libcublas.so.12 is not found or cannot be loaded'. Preloading them
    with RTLD_GLOBAL makes them visible to ctranslate2's later dlopen calls
    without needing LD_LIBRARY_PATH set externally.
    """
    purelib = sysconfig.get_paths()["purelib"]
    pattern = os.path.join(purelib, "nvidia", "*", "lib", "*.so*")
    for path in glob.glob(pattern):
        try:
            ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
        except OSError as err:
            log.debug("Could not preload %s (%s); ignoring", path, err)


if STT_DEVICE in ("auto", "cuda"):
    _preload_cuda_libs()

from faster_whisper import WhisperModel  # noqa: E402 (must follow lib preload above)

app = FastAPI()
_state = {"model": None, "model_name": None, "device": None, "compute": None}

def _candidates():
    """Ordered (device, compute_type) pairs to try when building a model."""
    if _state["device"] is not None:
        # A device already worked once; don't retry cuda on every model rebuild.
        return [(_state["device"], _state["compute"])]
    if STT_DEVICE != "auto":
        compute = STT_COMPUTE if STT_COMPUTE != "auto" else "default"
        return [(STT_DEVICE, compute)]
    return [
        ("cuda", STT_COMPUTE if STT_COMPUTE != "auto" else "float16"),
        ("cpu", STT_COMPUTE if STT_COMPUTE != "auto" else "int8"),
    ]

def get_model(name: str):
    if _state["model"] is not None and _state["model_name"] == name:
        return _state["model"]  # warm: rebuilds only when the requested model name changes
    candidates = _candidates()
    last_err = None
    for device, compute in candidates:
        try:
            model = WhisperModel(name, device=device, compute_type=compute)
            # Model *construction* can succeed on cuda even when the runtime is
            # broken (e.g. pip nvidia libs not on the loader path): ctranslate2
            # only dlopen()s cublas/cudnn lazily on the first inference call.
            # Do a throwaway inference here so a broken cuda runtime falls back
            # to cpu instead of 500ing every real /transcribe request.
            if device != "cpu":
                warmup_segments, _ = model.transcribe(np.zeros(1600, dtype=np.float32))
                list(warmup_segments)  # transcribe() is lazy; force real inference now
        except Exception as err:  # e.g. no CUDA runtime / missing cuDNN — fall back
            last_err = err
            log.warning("STT device %s/%s unavailable (%s); falling back", device, compute, err)
            continue
        _state.update(model=model, model_name=name, device=device, compute=compute)
        if device != "cpu":
            log.info("STT model %s running on %s/%s", name, device, compute)
        return model
    raise last_err

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": _state["model_name"],
        "device": _state["device"],
        "compute": _state["compute"],
    }

# Plain `def` (audit B1): FastAPI runs sync endpoints in its threadpool, so the
# event loop — and /health — stay responsive during long transcriptions.
@app.post("/transcribe")
def transcribe(file: UploadFile = File(...), model: str = Form("small"), language: str = Form("auto")):
    m = get_model(model)
    suffix = os.path.splitext(file.filename or "a.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file.file.read())
        path = tmp.name
    try:
        lang = None if language == "auto" else language
        segments, info = m.transcribe(path, language=lang, word_timestamps=True)
        words, texts = [], []
        for seg in segments:
            texts.append(seg.text)
            for w in (getattr(seg, "words", None) or []):
                words.append({"word": w.word, "start": w.start, "end": w.end})
        return {"text": " ".join(t.strip() for t in texts).strip(),
                "words": words,
                "language": getattr(info, "language", language)}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass  # cleanup failure must not mask a transcription error

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=os.environ.get("STT_HOST", "127.0.0.1"),
        port=int(os.environ.get("STT_PORT", "8000")),
    )
