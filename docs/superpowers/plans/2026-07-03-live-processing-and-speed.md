# Plan: Live "Processing" state + pipeline speed-ups — 2026-07-03

Written by Fable as planning-only. Implementation goes to a coding agent/session.
Constraint: do NOT restart the currently running `node src/index.js` instance while
implementing; land changes on the branch, reload later at a natural break.

Companion audit: `../audits/2026-07-03-app-audit.md` (fix IDs referenced below).

---

## Part 1 — "Processing" in the Live page (fixes audit A1, A4)

### Problem
When a recording stops, the session vanishes from `manager.active` immediately, but
transcription + summarization can run for minutes. The Live page says "Nothing
recording" while the meeting is actually being processed. The Stop button also blocks
for the whole pipeline.

### Design
Keep a second in-memory registry of post-recording, in-flight meetings, and make stop
non-blocking.

#### 1. `MeetingManager`: split stop from finalize
`src/voice/meeting-manager.js`

- Add `this.processing = new Map()` keyed by meetingId →
  `{ meetingId, guildId, channelId, channelName, startedAt, stoppedAt }`.
- `stop()` becomes:
  1. remove from `active`, `await session.stopAll()` (fast — just flushes streams),
  2. stamp `ended_at` now: `db.setMeetingStatus(meetingId, 'processing', now())`
     (see schema note below), add to `this.processing`,
  3. kick `finalize` WITHOUT awaiting; on settle (then/finally) delete from
     `this.processing`,
  4. return `{ meetingId, done: finalizePromise }` — callers that genuinely need to
     wait (tests, CLI scripts) can await `done`; the API and bot handlers don't.
- Add `listProcessing()` mirroring `listActive()`.

`setMeetingStatus(id, status, endedAt)` already accepts endedAt — today it's only
passed at `done`. Pass it at `processing` instead, and make the `done` transition NOT
overwrite it (`ended_at = COALESCE(ended_at, ?)` or only set when null). This fixes
audit A4 (durations currently include processing time).

#### 2. `BotController.liveMeetings()` → include phase
`src/bot-controller.js`

Return a single list with a `phase` field:

```js
liveMeetings() {
  if (!this.manager) return [];
  return [
    ...this.manager.listActive().map((s) => ({ ...s, phase: 'recording' })),
    ...this.manager.listProcessing().map((s) => ({ ...s, phase: 'processing' })),
  ];
}
```

`stopMeeting()` awaits only the new fast `stop()` (returns as soon as capture is
flushed), so the dashboard Stop resolves in ~1s and the card flips to Processing on
the next poll.

#### 3. API: no shape change needed, but enrich
`src/web/api.js` `liveMeetings()` already spreads the session; `phase` flows through.
For `phase: 'processing'` skip the voice-channel roster lookup (channel members are
irrelevant once the bot left) and use stored attendees; include `stoppedAt`.

Bot `/leave` handler (`src/bot.js` `stopAndLeave`): unchanged call site works, but the
reply can now honestly say "Stopped. Processing — notes will post shortly." A nice
touch: after `manager.stop()` returns, don't await `done`.

#### 4. Web UI
- `web/src/components/Live.jsx`: `LiveCard` branches on `session.phase`:
  - `recording` (default): unchanged — red REC dot, ticking timer, Stop button.
  - `processing`: amber left border (`var(--warn)`), spinner instead of REC dot,
    label "Processing", frozen duration (`stoppedAt - startedAt`), subtitle
    "Transcribing and summarizing — notes will post when done." NO Stop button;
    link to `/meetings/:id` instead.
- `web/src/pages/Live.jsx`: subtitle counts both ("1 recording · 1 processing");
  empty state only when both lists are empty. Key cards by `meetingId` (channel key
  breaks when the same channel is processing + recording again).
- `web/src/pages/Dashboard.jsx`: uses the same `LiveCard`, gets processing for free.
- `LiveContext` polling (4s) is fine. Optional: poll at 2s while any `processing`
  card exists so completion is snappy.

#### 5. Fallback for restarts / standalone server
In-memory `processing` dies with the bot. Cheap belt-and-braces: the Live endpoint can
also union recent DB meetings with `status='processing'` for that guild
(`started_at` within the last few hours) marked `phase: 'processing', source: 'db'`.
That covers the standalone read-only server and a mid-processing crash (until the
orphan sweep marks it failed on next boot). Keep it simple: one indexed query.

#### 6. Tests
- meeting-manager: `stop()` resolves before finalize settles; `listProcessing()` shows
  the meeting until finalize settles (use a deferred finalize in the test); the entry
  clears on both success and failure.
- live-api: fake bot returns mixed phases; assert phase passthrough and that
  processing entries skip the roster override.
- ended_at: stamped at processing, not overwritten at done.

### Acceptance criteria
1. Stop from dashboard returns < 2s; card flips Recording → Processing → gone (and the
   meeting appears as `done` in Meetings).
2. `/leave` in Discord replies immediately; notes still post.
3. Live page shows a Processing card for the whole pipeline duration.
4. Meeting duration shown in UI = recording duration, not recording + pipeline.
5. All existing tests pass; new tests cover the above.

---

## Part 2 — Speed-up plan (ordered by impact/effort)

### S1. GPU for the local sidecar (audit B2) — biggest win, tiny diff
`stt_sidecar/server.py`: `device = os.environ.get("STT_DEVICE", "auto")`,
`compute_type = os.environ.get("STT_COMPUTE", "auto")`; faster-whisper accepts
`device="auto"` (picks cuda when available) and auto compute type. Docker compose for
the sidecar gains an optional gpu deploy block (commented). Expected 5–15x on the
RTX 4070 vs current cpu/int8. Note: needs cuDNN/cuBLAS present; keep cpu fallback on
init failure (try cuda, catch, rebuild cpu).

### S2. Unblock the sidecar event loop (audit B1)
Change `async def transcribe` → `def transcribe` (FastAPI threadpools it) and read the
upload before, via `file.file.read()`. `/health` stays responsive during jobs; enables
S3 concurrency to actually help.

### S3. Concurrent track transcription (audit C)
`transcribeTracks`: replace the serial loop with a small worker pool.
`STT_CONCURRENCY` default: 4 for cloud (`openai`), 2 for sidecar. Preserve output
determinism by collecting results with their index and sorting at the end (order
doesn't matter semantically — orchestrator sorts by startMs — but keep tests stable).
Combine with per-track error tolerance (audit A2): failures collect into
`failedTracks`, only throw if ALL tracks failed.

### S4. Drop ffmpeg from the hot path
PCM is already s16le/16k/mono. Write the 44-byte WAV header in JS
(`wavHeader(dataLength)` + copy/stream) instead of spawning ffmpeg per track.
Keep `convertPcmToWav` name/signature; swap the implementation, keep a test comparing
output against a known-good header. Saves ~50–150ms per track and removes a spawn.

### S5. Transcribe-as-you-go (bigger refactor, do last)
Hook registry `finish(userId)` → enqueue the finished turn's PCM for transcription
immediately, while the meeting continues. Meeting end then only waits for queue drain
+ summary. Cuts end-of-meeting latency to roughly (last turn + summary). Also the
foundation for a live transcript view in the Live page. Needs: queue with the S3 pool,
partial-utterance persistence, and care with retry semantics (PCM lifecycle stays the
same). Ship Part 1 + S1–S4 first; measure; only do S5 if end-of-meeting latency is
still annoying.

### Measurement (build this with S1, keep forever)
Add per-stage timing to `processMeeting`: `{ transcribeMs, summarizeMs, tracks,
audioMs }` logged as one line and stored on the summary row (new JSON column or into
`model_used` metadata). This makes every speed claim verifiable and gives a
hill-climbable number: end-of-meeting → notes-posted latency.

---

## Sequencing for the implementing agent

1. Part 1 (processing state) — self-contained, user-visible, no perf risk.
2. S2 + S1 (sidecar) — python-only, doesn't touch the running node process.
3. S3 + A2 error tolerance (one PR — same loop).
4. S4. Then measure. Decide on S5.
5. Cherry-pick audit fixes: D1 (Secure cookie), E1 (indexes), A5 (joinKey leak),
   A3 (disconnect handling — schedule with Part 1 since both touch session lifecycle).

Do not restart the live instance; validate via `npm test` + a scratch DB
(`DATA_DIR=/tmp/parley-dev npm run web`).
