# Partial Transcript Recovery Design

**Date:** 2026-07-27
**Scope:** Prevent partial transcript persistence from causing retries to skip recoverable audio.

## Problem

`processMeeting()` currently inserts utterances one row at a time. If the process or database fails during that loop, the meeting can retain only part of its transcript. On restart, the meeting becomes `transcription_failed`, but `retryPlan()` sees that at least one utterance exists and chooses `resummarize`. That permanently skips the remaining PCM tracks even though their audio is still available.

A related case occurs when track-level transcription partially succeeds, then summarization fails. The partial transcript is deliberately retained, but the retry path cannot tell that some tracks failed and again chooses `resummarize` instead of retrying STT from the retained PCM.

## Goals

1. Transcript persistence is atomic. A write failure leaves either the previous transcript or no transcript, never a partially replaced transcript.
2. Retry selection distinguishes a complete transcript from an incomplete one.
3. Retranscription replaces existing utterances rather than appending duplicates.
4. Legacy failed meetings are recovered conservatively when PCM still exists.
5. Normal `summary_failed` meetings with a known-complete transcript continue to skip STT.

## Non-goals

- Persisting detailed per-track error records.
- Retrying only individual failed tracks.
- Changing the policy that a meeting may finish successfully with a usable partial transcript.
- Delivery-state persistence, retention pruning, or unrelated open tasks.

## Approaches Considered

### 1. Compare PCM count with transcribed users

This avoids a schema migration, but the comparison is not reliable. A user can have multiple PCM clips, silent clips legitimately produce no utterance, and one clip can produce multiple utterance-like results in future implementations. Distinct user counts do not represent track completion.

### 2. Atomic replacement plus a completion flag

Add a nullable `meetings.transcription_complete` integer and update it in the same transaction that replaces utterances. `1` means every submitted track completed without a transcription failure. `0` means STT failed or returned usable partial results. `NULL` represents a legacy row whose completeness is unknown.

This is the selected approach. It is small, directly represents the decision retry needs, and does not introduce per-track lifecycle complexity.

### 3. Per-track transcription status table

A dedicated table would precisely track every PCM clip and enable selective retries. It also requires stable track identifiers, reconciliation rules, cleanup behavior, and more migration surface. That capability is unnecessary for the current recovery bug.

## Data Model

Add to `meetings`:

```sql
transcription_complete INTEGER
```

Values:

- `1`: all submitted tracks transcribed without reported failures, and the resulting utterances were committed atomically.
- `0`: transcription threw, every track failed, or usable partial results included one or more failed tracks.
- `NULL`: legacy or otherwise unknown state.

New meetings may begin with `NULL`. The pipeline sets the value once it has transcription evidence. This avoids treating a recording that has not reached STT as either complete or incomplete.

## Database Interface

Add `replaceUtterances(meetingId, utterances, { complete })` to the DB adapter.

The method performs one SQLite transaction:

1. Delete all existing utterances for the meeting.
2. Insert the supplied utterances.
3. Set `meetings.transcription_complete` to `1` or `0`.
4. Commit.

If any statement fails, it rolls back. Existing utterances and the previous completion value remain unchanged. The existing FTS delete/insert triggers keep the search index synchronized.

Add a small method for marking transcription incomplete when STT fails before replacement, such as `setTranscriptionComplete(meetingId, false)`. This update does not need to be coupled to utterance replacement because no new transcript is being committed in that path.

## Pipeline Flow

After `transcribeTracks()` returns:

- If every track failed and there are no utterances, mark transcription incomplete, set `transcription_failed`, and throw as today.
- Otherwise call `replaceUtterances()` once.
- Pass `complete: failures.length === 0`.
- If replacement throws, set the meeting to `transcription_failed`, attach a useful transcription persistence error, and rethrow.
- Continue summarization from the in-memory utterances.

Partial track failures remain non-fatal when usable text exists. If summarization succeeds, the meeting may still become `done` under the existing policy. If summarization fails while PCM remains, retry recognizes that the transcript was incomplete and retranscribes.

## Retry Decision

`retryPlan()` uses this order:

1. Inspect whether PCM files remain.
2. If PCM exists and `transcription_complete !== 1`, choose `retranscribe`.
   - This includes explicit incomplete state (`0`).
   - This also conservatively includes legacy unknown state (`NULL`).
3. Otherwise, if utterances exist, choose `resummarize`.
4. Otherwise, if PCM exists, choose `retranscribe`.
5. Otherwise report the meeting as unrecoverable.

This means a legacy `summary_failed` meeting with PCM is retranscribed once rather than risking summarization from a partial transcript. A known-complete transcript continues to use the cheaper summary-only path.

The retranscription path invokes `processMeeting()`, whose atomic replacement removes old utterances before inserting the new transcript. It must not clear utterances in a separate transaction beforehand, because doing so would discard recoverable data if the replacement fails.

## Error Handling

- STT failure: completion becomes `0`; status becomes `transcription_failed`; PCM remains.
- Atomic replacement failure: transaction rolls back; status becomes `transcription_failed`; PCM remains.
- Partial STT followed by summary failure: completion remains `0`; retry chooses retranscription while PCM exists.
- Known-complete STT followed by summary failure: completion is `1`; retry chooses resummarization.
- Retranscription failure after a previous partial transcript: rollback preserves the previous transcript for inspection and another retry.

## Migration Compatibility

`openDb()` checks `PRAGMA table_info(meetings)` and adds `transcription_complete` when absent. Existing rows receive `NULL` and are handled conservatively by retry only when PCM is still present.

No destructive migration or backfill is required.

## Tests

### Database

- `replaceUtterances()` replaces prior rows and updates the completion flag.
- A forced insert failure rolls back the entire replacement, preserving prior utterances and completion state.
- FTS results reflect replacement rather than retaining deleted text.

### Orchestrator

- Successful full transcription stores utterances with completion `1`.
- Usable partial transcription stores utterances with completion `0`.
- Total STT failure records completion `0`.
- Persistence failure marks the meeting `transcription_failed` and does not leave a partial replacement.

### Retry

- Known-complete transcript plus `summary_failed` chooses `resummarize` even if PCM remains.
- Incomplete transcript plus PCM chooses `retranscribe`.
- Legacy unknown transcript plus PCM chooses `retranscribe`.
- Incomplete transcript without PCM falls back to `resummarize` when utterances exist.
- Successful retranscription replaces old utterances without duplicates.

## Documentation

Update `docs/audit-2026-07-06.md` so finding #7 is no longer inaccurately described as already resolved. Update `todo.md` to mark the atomic persistence and retry-routing work complete after verification.

## Acceptance Criteria

1. No code path inserts a pipeline transcript row-by-row outside a transaction.
2. A simulated mid-replacement database error leaves the prior transcript intact.
3. Retry routes incomplete or unknown transcripts with retained PCM through retranscription.
4. Retry routes known-complete transcripts through resummarization.
5. Retranscription cannot create duplicate utterances.
6. The full Node test suite passes.
