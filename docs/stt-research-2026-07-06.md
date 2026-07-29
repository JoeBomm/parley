# STT engine research — findings & recommendations (2026-07-06)

**TL;DR:** You are already on the fast Whisper (faster-whisper / CTranslate2), so the
engine isn't really the problem. The lag on large recordings comes from two things:
(1) running on **CPU instead of the GPU you have**, and (2) Parley transcribing
**one short clip at a time** instead of batching. Both are fixable without leaving
faster-whisper. I benchmarked the alternatives on *your* hardware with *your* real
recorded audio to prove it.

---

## What Parley runs today

- Engine: **faster-whisper 1.2.1** (CTranslate2 4.7.2) in the Python sidecar. This is
  already the optimized Whisper, not the slow reference implementation.
- Model: **`small`**, device `auto` (tries CUDA, falls back to CPU/int8).
- Architecture: each speaker's **each speaking turn** is a separate audio file,
  transcribed **sequentially** through a worker pool of **2** (`transcribe.js`),
  `word_timestamps=True`.

The kicker from your real data (meeting in `audio/3`): **651 clips, 45 min total,
but the median clip is 0.80s.** Whisper internally **pads every clip to 30s**, so a
0.8s "yeah" costs almost the same as a 30s sentence. You are paying full Whisper
overhead 650 times per meeting. That is the structural inefficiency.

---

## Benchmarks on YOUR box (RTX 4070 Laptop 8GB, i7-13700HX)

Same ~150-clip slice of your real meeting, median clip 0.80s. Numbers are wall time
to transcribe the whole slice and the resulting realtime multiple (higher = faster).

### GPU (the hardware you already have)
| Config | Time | Realtime | vs current |
| --- | --- | --- | --- |
| `small` sequential — **CURRENT (GPU)** | 22.6s | 26.0x | 1.00x |
| `small` **batched(8)** | **12.8s** | **45.7x** | **1.76x** |
| `large-v3-turbo` sequential | 40.6s | 14.5x | 0.56x |
| `large-v3-turbo` batched(8) | 24.1s | 24.4x | 0.94x |

### CPU (what most self-hosters, and your fallback, actually run)
| Config | Time | Realtime |
| --- | --- | --- |
| `small` sequential — **CURRENT default on CPU** | 144.9s | 3.3x |
| `small` batched(8) | 84.3s | 5.7x |
| `base` sequential | 73.7s | 6.5x |
| `base` **batched(8)** | **28.7s** | **16.8x** |
| `tiny` sequential | 30.0s | 16.1x |
| `tiny` **batched(8)** | **16.8s** | **28.7x** |
| Moonshine tiny (ONNX, EN-only) | 110.6s | 4.4x |
| Moonshine base (ONNX, EN-only) | 162.5s | 3.0x |

**The single most important number:** the same `small` model is **~7x slower on CPU
(145s) than on your GPU (22.6s)**. If a user feels lag, they are almost certainly on
the CPU path. Accuracy (character counts) stayed within ~5% across sequential vs
batched, so batching is close to free.

---

## What I looked at, and the verdict on each

| Engine | Verdict for Parley |
| --- | --- |
| **faster-whisper batched pipeline** (already installed, v1.1+) | ✅ **Do this.** 1.7-2.6x faster on both GPU and CPU, same model, same accuracy, no new dependency. |
| **smaller model (`base`/`tiny`)** on CPU | ✅ **Do this for the no-GPU path.** `base` batched (16.8x) is **5x faster** than the current `small` sequential (3.3x), with only a small accuracy drop. `small` is overkill for Discord chatter. |
| **large-v3-turbo** | ⚠️ Optional quality upgrade. It's *slower* than `small` (bigger model) but far more accurate and still comfortably realtime **on GPU** (24x batched). Good as an opt-in "accuracy" preset for GPU users. Not for CPU. |
| **Moonshine** (Useful Sensors, EN-only) | ❌ Slower than faster-whisper here (4.4x vs tiny's 28.7x batched) and caps clips at 64s. Its win is *streaming ultra-short* commands, not batch meeting transcription. Skip. |
| **whisper.cpp** | ❌ Ties faster-whisper on GPU and is *slower* than faster-whisper int8 on CPU. Its only edge is portability (Apple Metal, no Python). You already have the Python sidecar. Skip. |
| **NVIDIA Parakeet TDT / Canary** | 🔭 Fastest & most accurate on the Open ASR Leaderboard (Parakeet RTFx ~3386, WER 6.05), but **English-only** (v2), needs the heavy **NeMo** runtime + a real GPU, and 8GB VRAM is tight. Compelling as a future "English + GPU" power option, not a default for a self-hosted multilingual tool. |
| **distil-whisper / WhisperX** | 🔭 distil is English-only; WhisperX is really about diarization + word alignment (which you get another way). Neither is a clear win over batched faster-whisper for your case. |

---

## Recommendation (in priority order)

1. **Batch the pipeline (biggest win, no new deps, GPU *and* CPU).**
   Switch the sidecar to `BatchedInferencePipeline`. Even one-file-at-a-time it's
   1.7-2.6x. Better: hand it the whole meeting's audio at once so its internal VAD
   batches across turns and the 30s-padding waste disappears. This alone likely
   removes the lag you're seeing.

2. **Make the default model GPU-aware.** On CPU, default to **`base`** (5x faster
   than today's `small`, barely-worse accuracy). On GPU, keep `small` or offer
   `large-v3-turbo` as an "accuracy" preset. Expose it as a simple
   Fast / Balanced / Accurate switch instead of raw model names.

3. **Surface the device in the dashboard.** The sidecar already knows if it fell back
   to CPU (`/health` returns `device`). Show a "running on CPU (slow) — enable GPU"
   badge. Most "it's laggy" reports are silent CPU fallback, and users don't know.

4. **Raise transcribe concurrency on GPU.** `transcribe.js` uses concurrency 2; the
   4070 can do more. Minor next to batching, but cheap.

5. **(Later) Optional Parakeet backend for English+GPU power users.** High ceiling,
   but a big dependency and English-only, so it's a separate opt-in provider, not a
   default.

**Net:** stay on faster-whisper, turn on batching, pick the model by device, and tell
the user when they're on CPU. That converts the current 3.3x-realtime CPU crawl into
16x (base+batched) and the 26x GPU into 45x, using code and hardware you already have.

*(All timings measured 2026-07-06 on this machine with `/tmp/stt-bench/*.py` against
the real recordings in `audio/3`. Reproducible.)*
