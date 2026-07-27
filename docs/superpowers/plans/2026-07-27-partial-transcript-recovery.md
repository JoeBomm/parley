# Partial Transcript Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript persistence atomic and ensure retries retranscribe retained PCM whenever transcript completeness is incomplete or unknown.

**Architecture:** Add a nullable completion flag to `meetings`, expose one transactional `replaceUtterances()` database operation, and make the pipeline use it as the sole persistence boundary after STT. Retry planning will prefer retained PCM unless the transcript is explicitly known complete.

**Tech Stack:** Node.js ESM, built-in `node:sqlite` `DatabaseSync`, built-in `node:test`, Express API integration tests.

## Global Constraints

- Preserve all existing uncommitted working-tree changes.
- Add no dependencies.
- Keep partial STT success non-fatal when at least one usable utterance exists.
- Never delete an existing transcript before a replacement transaction can commit.
- Existing database rows must migrate without destructive backfill.
- Do not implement delivery persistence, retention pruning, or unrelated todo items.

---

### Task 1: Atomic transcript storage and completion state

**Files:**
- Modify: `src/store/db.js:3-177`
- Test: `test/db.test.js`

**Interfaces:**
- Consumes: utterances shaped as `{ userId, displayName, startMs, endMs, text }`.
- Produces: `db.setTranscriptionComplete(meetingId, complete)` and `db.replaceUtterances(meetingId, utterances, { complete })`.
- `db.getMeeting(id).transcription_complete` returns `1`, `0`, or `null`.

- [ ] **Step 1: Write failing migration and replacement tests**

Add tests that:

```js
const db = openDb(':memory:');
const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'general', startedAt: 'now' });
assert.equal(db.getMeeting(id).transcription_complete, null);

db.replaceUtterances(id, [
  { userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'new transcript' },
], { complete: true });
assert.equal(db.getMeeting(id).transcription_complete, 1);
assert.deepEqual(db.listUtterances(id).map((u) => u.text), ['new transcript']);
```

Add a rollback test that seeds an old utterance, sets completion to true, installs a temporary trigger that aborts insertion when `NEW.text = 'explode'`, then asserts `replaceUtterances()` throws while the old utterance and completion value remain unchanged:

```js
db.addUtterance({ meetingId: id, userId: 'old', displayName: 'Old', startMs: 0, endMs: 1, text: 'preserve me' });
db.setTranscriptionComplete(id, true);
db.sql.exec(`
  CREATE TRIGGER fail_replacement BEFORE INSERT ON utterances
  WHEN NEW.text = 'explode'
  BEGIN
    SELECT RAISE(ABORT, 'forced replacement failure');
  END;
`);
assert.throws(() => db.replaceUtterances(id, [
  { userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'first' },
  { userId: 'u2', displayName: 'Bob', startMs: 1000, endMs: 2000, text: 'explode' },
], { complete: false }), /forced replacement failure/);
assert.deepEqual(db.listUtterances(id).map((u) => u.text), ['preserve me']);
assert.equal(db.getMeeting(id).transcription_complete, 1);
```

Add an FTS assertion proving deleted text no longer matches and replacement text does.

- [ ] **Step 2: Run focused DB tests and verify failure**

Run: `node --test test/db.test.js`

Expected: FAIL because `replaceUtterances` and `setTranscriptionComplete` do not exist and the schema lacks `transcription_complete`.

- [ ] **Step 3: Add schema and migration**

Extend the `meetings` table declaration:

```sql
status TEXT NOT NULL DEFAULT 'recording',
transcription_complete INTEGER
```

After `sql.exec(SCHEMA)`, inspect `PRAGMA table_info(meetings)` and migrate old databases:

```js
const meetingCols = sql.prepare(`PRAGMA table_info(meetings)`).all();
if (!meetingCols.some((c) => c.name === 'transcription_complete')) {
  sql.exec(`ALTER TABLE meetings ADD COLUMN transcription_complete INTEGER`);
}
```

- [ ] **Step 4: Implement atomic replacement**

Add methods near `addUtterance()`:

```js
setTranscriptionComplete(meetingId, complete) {
  sql.prepare(`UPDATE meetings SET transcription_complete = ? WHERE id = ?`)
    .run(complete == null ? null : (complete ? 1 : 0), meetingId);
},
replaceUtterances(meetingId, utterances, { complete }) {
  const insert = sql.prepare(
    `INSERT INTO utterances (meeting_id, user_id, display_name, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  sql.exec('BEGIN');
  try {
    sql.prepare(`DELETE FROM utterances WHERE meeting_id = ?`).run(meetingId);
    for (const u of utterances) {
      insert.run(meetingId, u.userId, u.displayName, u.startMs, u.endMs, u.text);
    }
    sql.prepare(`UPDATE meetings SET transcription_complete = ? WHERE id = ?`)
      .run(complete ? 1 : 0, meetingId);
    sql.exec('COMMIT');
  } catch (err) {
    sql.exec('ROLLBACK');
    throw err;
  }
},
```

Keep `addUtterance()` for scripts/tests that append individual historical rows. The pipeline will stop using it.

- [ ] **Step 5: Run focused DB tests**

Run: `node --test test/db.test.js`

Expected: PASS, including rollback and FTS replacement coverage.

- [ ] **Step 6: Commit the database unit**

```bash
git add src/store/db.js test/db.test.js
git commit -m "fix(store): replace transcripts atomically"
```

---

### Task 2: Pipeline completeness and retry routing

**Files:**
- Modify: `src/pipeline/orchestrator.js:7-55`
- Modify: `src/pipeline/retry.js:27-38,79-101`
- Test: `test/orchestrator.test.js`
- Test: `test/retry.test.js`

**Interfaces:**
- Consumes: Task 1 methods `setTranscriptionComplete()` and `replaceUtterances()`.
- Produces: retry decisions where PCM plus `transcription_complete !== 1` means `retranscribe`.

- [ ] **Step 1: Write failing orchestrator tests**

Extend existing tests to assert:

```js
assert.equal(db.getMeeting(id).transcription_complete, 1);
```

for full transcription, and:

```js
assert.equal(db.getMeeting(id).transcription_complete, 0);
```

for partial and total failure.

Add a persistence-failure test using the same abort trigger from Task 1. Seed a prior utterance before calling `processMeeting()`, return two new utterances where the second has text `explode`, and assert:

```js
await assert.rejects(processMeeting(/* ... */), /forced replacement failure/);
assert.equal(db.getMeeting(id).status, 'transcription_failed');
assert.deepEqual(db.listUtterances(id).map((u) => u.text), ['preserve me']);
```

- [ ] **Step 2: Write failing retry tests**

Create an audio directory with PCM and cover four decisions:

```js
// Explicit complete transcript skips STT.
db.setTranscriptionComplete(id, true);
assert.equal(retryPlan(db, id, { dataDir: dir }).action, 'resummarize');

// Explicit incomplete transcript retries STT.
db.setTranscriptionComplete(id, false);
assert.equal(retryPlan(db, id, { dataDir: dir }).action, 'retranscribe');

// Legacy NULL transcript retries STT conservatively.
db.setTranscriptionComplete(id, null);
assert.equal(retryPlan(db, id, { dataDir: dir }).action, 'retranscribe');

// Without PCM, partial stored text remains available for summary-only recovery.
assert.equal(retryPlan(db, id, { dataDir: noAudioDir }).action, 'resummarize');
```

Add an integration-style retranscription test that starts with an old utterance, runs `retryMeeting()`, and asserts the resulting transcript contains only the retranscribed rows with no duplicates.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `node --test test/orchestrator.test.js test/retry.test.js`

Expected: FAIL because the pipeline does not set completeness or replace utterances, and retry still prioritizes any existing utterance.

- [ ] **Step 4: Update pipeline persistence**

In the STT exception path and total-failure path, call:

```js
db.setTranscriptionComplete(meetingId, false);
```

Replace the row-by-row loop with:

```js
try {
  db.replaceUtterances(meetingId, utterances, { complete: failures.length === 0 });
} catch (err) {
  db.setMeetingStatus(meetingId, 'transcription_failed');
  err.userMessage = `Transcription could not be saved safely. (${err.message})`;
  throw err;
}
```

This call also handles an empty, genuinely silent meeting by atomically recording an empty but complete transcript before setting status `empty`.

- [ ] **Step 5: Update retry selection**

Count PCM before choosing an action, then use:

```js
if (pcmCount > 0 && meeting.transcription_complete !== 1) {
  return { ok: true, action: 'retranscribe', meeting };
}
if (hasUtterances) return { ok: true, action: 'resummarize', meeting };
if (pcmCount > 0) return { ok: true, action: 'retranscribe', meeting };
```

Do not clear utterances before `processMeeting()`. Task 1 replacement owns deletion and rollback.

- [ ] **Step 6: Run focused pipeline and retry tests**

Run: `node --test test/orchestrator.test.js test/retry.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the pipeline unit**

```bash
git add src/pipeline/orchestrator.js src/pipeline/retry.js test/orchestrator.test.js test/retry.test.js
git commit -m "fix(pipeline): retry incomplete transcripts"
```

---

### Task 3: Documentation reconciliation and full verification

**Files:**
- Modify: `docs/audit-2026-07-06.md:5-11,52-55`
- Modify: `todo.md:19-27,37-42,59-64`

**Interfaces:**
- Consumes: verified behavior from Tasks 1 and 2.
- Produces: accurate audit and current-session task status.

- [ ] **Step 1: Correct the audit status**

Keep finding #7 marked resolved only after describing the actual fix: transactional replacement, persisted completeness, and PCM-aware retry routing. Remove wording that implies per-track status was already present before this work.

- [ ] **Step 2: Update the current task ledger**

Move the two partial-transcript items from Open to Done, summarizing:

```markdown
- [x] `src/store/db.js` + `src/pipeline/orchestrator.js` — atomically replace meeting utterances and persist transcript completeness; failed replacement rolls back.
- [x] `src/pipeline/retry.js` — retranscribe retained PCM for incomplete/legacy transcript state; known-complete transcripts re-summarize without STT.
```

Remove the stale repository-database warning because `*.db`, `*.db-shm`, and `*.db-wal` are already ignored and Git history is clean. Mark the audit reconciliation item complete.

- [ ] **Step 3: Run formatting checks**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Run focused verification**

Run:

```bash
node --test test/db.test.js test/orchestrator.test.js test/retry.test.js
```

Expected: all selected tests pass.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm --prefix web run build
stt_sidecar/.venv/bin/python -m pytest stt_sidecar/test_server.py -q
```

Expected:
- Node suite: 0 failures.
- Vite production build: exit 0.
- Sidecar tests: 10 passed; the known Starlette deprecation warning is acceptable.

- [ ] **Step 6: Review only intended changes**

Run:

```bash
git status --short
git diff --stat HEAD
git diff HEAD -- src/store/db.js src/pipeline/orchestrator.js src/pipeline/retry.js test/db.test.js test/orchestrator.test.js test/retry.test.js docs/audit-2026-07-06.md todo.md
```

Confirm unrelated pre-existing modifications remain unstaged and unchanged.

- [ ] **Step 7: Commit documentation and any remaining tests**

```bash
git add docs/audit-2026-07-06.md todo.md
git commit -m "docs: close transcript recovery audit gap"
```

- [ ] **Step 8: Final history and cleanliness check**

Run:

```bash
git log -3 --oneline
git status --short
```

Expected: the recovery commits are present; unrelated pre-existing changes may remain in the working tree and must not be committed.
