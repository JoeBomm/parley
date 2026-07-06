import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { processMeeting } from '../src/pipeline/orchestrator.js';
import { FakeSummarizer } from '../src/adapters/summarizer/fake.js';

function seed() {
  const db = openDb(':memory:');
  const id = db.createMeeting({ guildId: 'g', channelId: 'c', channelName: 'general', startedAt: 't' });
  db.addAttendee(id, 'u1', 'Alice');
  return { db, id };
}

const tracks = [{ userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' }];

test('processMeeting transcribes, summarizes, stores, sets done, delivers', async () => {
  const { db, id } = seed();
  let delivered = null;
  await processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake', whisperModel: 'small', language: 'auto' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hello team' }], failures: [] }),
    deliver: async (notes, talktime) => { delivered = { notes, talktime }; },
  });
  assert.equal(db.getMeeting(id).status, 'done');
  assert.equal(db.listUtterances(id).length, 1);
  assert.ok(db.getSummary(id));
  assert.ok(delivered.notes.tldr);
  assert.equal(delivered.talktime[0].displayName, 'Alice');
});

test('processMeeting marks transcription_failed and rethrows on STT error', async () => {
  const { db, id } = seed();
  await assert.rejects(processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => { throw new Error('sidecar down'); },
    deliver: async () => {},
  }), /sidecar down/);
  assert.equal(db.getMeeting(id).status, 'transcription_failed');
});

test('processMeeting keeps a meeting alive when only some tracks fail transcription', async () => {
  const { db, id } = seed();
  const { notes, talktime } = await processMeeting(db, id, {
    tracks: [
      { userId: 'u1', displayName: 'Alice', startMs: 0, pcmPath: '/a.pcm' },
      { userId: 'u2', displayName: 'Bob', startMs: 1000, pcmPath: '/b.pcm' },
    ],
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => ({
      utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hello team' }],
      failures: [{ userId: 'u2', displayName: 'Bob', error: 'corrupt pcm' }],
    }),
    deliver: async () => {},
  });
  assert.equal(db.getMeeting(id).status, 'done');
  assert.equal(db.listUtterances(id).length, 1);
  assert.ok(notes.tldr);
  assert.equal(talktime[0].displayName, 'Alice');
});

test('processMeeting marks transcription_failed when every track fails (no partial results)', async () => {
  const { db, id } = seed();
  await assert.rejects(processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => ({ utterances: [], failures: [{ userId: 'u1', displayName: 'Alice', error: 'sidecar down' }] }),
    deliver: async () => {},
  }), /All 1 track\(s\) failed transcription/);
  assert.equal(db.getMeeting(id).status, 'transcription_failed');
  assert.equal(db.listUtterances(id).length, 0);
});

test('processMeeting marks summary_failed when summarizer throws', async () => {
  const { db, id } = seed();
  const boom = { summarize: async () => { throw new Error('429'); } };
  await assert.rejects(processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: boom,
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hi' }], failures: [] }),
    deliver: async () => {},
  }), /429/);
  assert.equal(db.getMeeting(id).status, 'summary_failed');
  assert.equal(db.listUtterances(id).length, 1); // transcript still saved
});

test('processMeeting measures and stores per-stage timings on the summary row', async () => {
  const { db, id } = seed();
  await processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hello team' }], failures: [] };
    },
    deliver: async () => {},
  });
  const summary = db.getSummary(id);
  assert.ok(summary.timings);
  assert.equal(typeof summary.timings.transcribeMs, 'number');
  assert.equal(typeof summary.timings.summarizeMs, 'number');
  assert.ok(summary.timings.transcribeMs >= 0);
  assert.ok(summary.timings.summarizeMs >= 0);
  assert.equal(summary.timings.tracks, 1);
});

test('processMeeting keeps a meeting done when delivery fails (notes still saved)', async () => {
  const { db, id } = seed();
  const { delivered, deliveryError } = await processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hello team' }], failures: [] }),
    deliver: async () => { throw new Error('missing permissions'); },
  });
  // Delivery threw, but the meeting is done and the summary is persisted.
  assert.equal(db.getMeeting(id).status, 'done');
  assert.ok(db.getSummary(id));
  assert.equal(delivered, false);
  assert.match(deliveryError, /missing permissions/);
});

test('processMeeting reports delivered:true on a successful post', async () => {
  const { db, id } = seed();
  const { delivered, deliveryError } = await processMeeting(db, id, {
    tracks,
    cfg: { summarizerProvider: 'fake' },
    summarizer: new FakeSummarizer(),
    transcribe: async () => ({ utterances: [{ userId: 'u1', displayName: 'Alice', startMs: 0, endMs: 1000, text: 'hi' }], failures: [] }),
    deliver: async () => {},
  });
  assert.equal(delivered, true);
  assert.equal(deliveryError, null);
});
