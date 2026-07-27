# Parley — session todos

Source: codebase + UI audit conducted this session. Each item carries file:line pointers and a severity.

## Done this session

- [x] `src/web/api.js:251` — gate `PATCH /todos/:id` behind `requireAdmin`. Action-item toggle now admin-only; non-admin receives 403.
- [x] `src/pipeline/orchestrator.js:88` — `seedTodos` createdAt = `meeting.started_at` (not `now()`). Long transcription queues no longer drag action items onto "today" in the timeline.
- [x] `src/voice/meeting-manager.js:73-82` — fail-loud `.catch` on `finalize` escape: logs stack, flips `processing` → `transcription_failed` (only if still `processing`), re-throws so `done` awaiters still see rejection. Resolves "stuck Processing card between restarts".
- [x] `src/pipeline/retry.js:73` — `seedTodos` createdAt = `meeting.started_at` (consistency with orchestrator path).
- [x] `src/web/api.js:231` — merge `seedTodos` createdAt = `target.started_at` (same alignment).
- [x] `web/src/pages/ActionItems.jsx:69-83` + `:124-127` — wrap toggle in try/catch; surface `toggleErr` banner. Non-admin 403 path now shows "Only admins can edit action items." instead of uncaught rejection.
- [x] `web/src/pages/Search.jsx:1` + `:8-23` — `Fragment` import added; `highlight` loops over all matches, not just first.
- [x] `src/store/db.js` + `src/pipeline/orchestrator.js` — atomically replace meeting utterances and persist transcript completeness; failed replacement rolls back without leaving a partial transcript.
- [x] `src/pipeline/retry.js` — retranscribe retained PCM for incomplete or legacy-unknown transcript state; known-complete transcripts still re-summarize without STT.
- [x] `docs/audit-2026-07-06.md` — reconcile audit #7 with the actual transactional persistence and PCM-aware retry fix.
- [x] Repository DB hygiene verified — `*.db`, `*.db-shm`, and `*.db-wal` are already ignored, and `git log --all -- meetings.db` is clean.

Verified: `npm test` 270/270 pass. `npm --prefix web run build` 64 modules, 282 kB bundle, clean. Sidecar: 10/10 pass (one known Starlette deprecation warning).

---

## Open — backend / pipeline

### High

- [ ] **`src/pipeline/orchestrator.js:91-102` — persist `delivered`/`deliveryError` to the meetings table (audit #14, half-closed).** Returned but never stored; `/meetings/:id` can't surface "notes saved but not posted" or offer a re-post. Fix: schema migration adds `delivered`/`delivery_error` columns; orchestrator writes them; expose via `/meetings/:id`; add `POST /meetings/:id/repost` reusing `postNotes`. ~3 files: `db.js`, `orchestrator.js`, `api.js`; 1 UI line in `Reading.jsx`.
- [ ] **`src/pipeline/retry.js:75` — log delivery failures on the dashboard retry's resummarize path.** Today `deliver(...).catch(() => {})` swallows with no log, while the orchestrator logs the same class (orchestrator.js:99). Pick one behavior.
- [ ] **`src/store/db.js` — retention + VACUUM + scheduled sweep (audit #17).** `meetings`/`utterances`/FTS grow unbounded for done meetings. `reconcileOnBoot` runs once at process start only. Add `pruneOlderThan(days)` callable from a `setInterval` in `index.js` + a `POST /system/prune` admin route.

### Medium

- [ ] **`src/web/auth.js:141` — `requirePasswordChanged` fails open when `req.user` is undefined.** Mirrors pre-fix shape of `requireAdmin` (audit #22). Safe today because `server.js:26` always mounts `attachUser` first, but a future bare-mount on the standalone server reintroduces the default-cred takeover surface. Fix: same `req.authResolved` gating as `requireAdmin`.
- [ ] **`src/store/db.js:53` — `todos_dedup` UNIQUE INDEX lets duplicates in when `meeting_id` is NULL (SQLite NULLs are distinct in UNIQUE indexes).** Every `seedTodos` call today sets `meeting_id`, so it never fires; add an explicit comment for future maintainers noting the invariant.
- [ ] **`src/pipeline/transcribe.js:30` — round-robin worker assignment stalls on a hung `convert`/`stt`.** Minor at default concurrency (2/4); skip unless you scale up.

---

## Open — scripts / project hygiene

- [ ] **Drop one of the duplicated reprocessing script pairs.** `scripts/reprocess-meeting.mjs` ≡ `scripts/resummarize.js`; `scripts/retranscribe-meeting.mjs` ≡ `scripts/retranscribe.js`. `bot.js:77` failure message points at `reprocess-meeting.mjs`; the dashboard Retry button (`api.js:167`) covers the same path. Pick one set, delete the other, update `bot.js` message to point at the dashboard primarily.

---

## Open — UI (audit, intentionally not fixed this round)

### Low / polish

- [ ] **`web/src/pages/Reading.jsx:205` — delete-then-navigate to `/meetings` leaves a stale list.** `Meetings.jsx` `useEffect` only fires on `guildId` change. Fix requires a global meetings cache or a manual refresh signal — bigger refactor.
- [ ] **`web/src/GuildContext.jsx:11-15` — fetches guilds once at mount.** New guilds added in Discord after page load never appear until refresh (bot-controller emits no SSE). Audit #36 category.
- [ ] **`web/src/components/Markdown.jsx` — single-pass line parser, no nested formatting** (e.g. bold link inside a list item). LLM answers are simple; dependency-free intent preserved. `react-markdown` migration optional.
- [ ] **`web/src/components/Layout.jsx` GuildSwitcher — no loading vs empty distinction.** Shows "No servers" both while loading and when truly empty. Minor cosmetic.
- [ ] **`web/src/pages/ForcePasswordChange.jsx:20` — client-side min length hardcoded at 8.** Matches server `PASSWORD_MIN` today; drift risk if server bumps the threshold. Tolerable for self-hosted.
- [ ] **`web/src/pages/Analytics.jsx` — top-N hardcoded at 8.** Could expose a "show all" toggle. Polish only.
- [ ] **`web/src/components/ui.jsx:117` `StatusPill` — only knows 5 statuses.** Unknown states (e.g. `'empty'`) fall through to a generic "Unknown" pill. Today `'empty'` meetings get deleted by `bot.js:65` before they reach the UI, so this is theoretical.

---

## Verification checklist (re-run before any PR)

- [x] `npm test` → 270/270 pass.
- [x] `npm --prefix web run build` → clean, 64 modules.
- [x] `stt_sidecar/.venv/bin/python -m pytest stt_sidecar/test_server.py -q` → 10/10 pass; one known Starlette deprecation warning.
- [ ] Manual smoke: start bot + sidecar, record a short meeting, confirm notes deliver; toggle an action item as admin (works) and as non-admin (403 + UI banner); retry a failed meeting from the dashboard.
