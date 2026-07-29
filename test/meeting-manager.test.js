import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db.js';
import { MeetingManager } from '../src/voice/meeting-manager.js';

function makeManager() {
  const db = openDb(':memory:');
  const started = [];
  const mgr = new MeetingManager({
    db,
    audioRoot: '/tmp/audio',
    startCapture: (ctx) => { started.push(ctx.meetingId); return { registry: { list: () => [] } }; },
    finalize: async () => {},
    now: () => '2026-06-04T10:00:00Z',
  });
  return { db, mgr, started };
}

test('start creates a meeting row, records attendees, tracks active key', () => {
  const { db, mgr } = makeManager();
  const id = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'general', connection: {}, guild: {}, attendees: [{ id: 'u1', displayName: 'Alice' }] });
  assert.equal(db.getMeeting(id).status, 'recording');
  assert.deepEqual(db.listAttendees(id).map((a) => a.display_name), ['Alice']);
  assert.equal(mgr.isActive('g', 'c'), true);
});

test('start is idempotent per guild+channel', () => {
  const { mgr } = makeManager();
  const a = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const b = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  assert.equal(a, b);
});

test('two channels record concurrently', () => {
  const { mgr } = makeManager();
  mgr.start({ guildId: 'g', channelId: 'c1', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  mgr.start({ guildId: 'g', channelId: 'c2', channelName: 'y', connection: {}, guild: {}, attendees: [] });
  assert.equal(mgr.isActive('g', 'c1'), true);
  assert.equal(mgr.isActive('g', 'c2'), true);
});

test('listActive returns plain session data without voice handles', () => {
  const { mgr } = makeManager();
  const id = mgr.start({ guildId: 'g', channelId: 'c1', channelName: 'general', connection: { secret: true }, guild: {}, attendees: [] });
  const active = mgr.listActive();
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], {
    meetingId: id, guildId: 'g', channelId: 'c1', channelName: 'general', startedAt: '2026-06-04T10:00:00Z',
  });
  // No live connection / registry leaks out to the web layer.
  assert.equal('connection' in active[0], false);
  assert.equal('registry' in active[0], false);
});

test('stop finalizes and clears the active key', async () => {
  const { db, mgr } = makeManager();
  const id = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const { meetingId, done } = await mgr.stop('g', 'c');
  await done;
  assert.equal(meetingId, id);
  assert.equal(mgr.isActive('g', 'c'), false);
  assert.ok(db.getMeeting(id));
});

test('stop() twice finalizes once and is a no-op the second time', async () => {
  const db = openDb(':memory:');
  let finalizeCalls = 0;
  const mgr = new MeetingManager({
    db,
    audioRoot: '/tmp/audio',
    startCapture: () => ({ registry: { list: () => [] } }),
    finalize: async () => { finalizeCalls += 1; },
    now: () => '2026-06-04T10:00:00Z',
  });
  mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const first = await mgr.stop('g', 'c');
  const second = await mgr.stop('g', 'c');
  assert.ok(first.meetingId);      // first stop returns { meetingId, done }
  await first.done;
  assert.equal(second, null);       // second stop is a no-op
  assert.equal(finalizeCalls, 1);   // finalize fired exactly once
  assert.equal(mgr.isActive('g', 'c'), false);
});

test('stop flushes via stopAll before harvesting tracks and finalizing', async () => {
  const db = openDb(':memory:');
  const order = [];
  const mgr = new MeetingManager({
    db,
    audioRoot: '/tmp/audio',
    startCapture: () => ({
      registry: { list: () => { order.push('list'); return []; } },
      stopAll: async () => { order.push('stopAll'); },
    }),
    finalize: async () => { order.push('finalize'); },
    now: () => '2026-06-04T10:00:00Z',
  });
  mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const { done } = await mgr.stop('g', 'c');
  await done;
  assert.deepEqual(order, ['stopAll', 'list', 'finalize']);
});

// Build a manager whose finalize blocks until the test releases it, so we can
// observe the window between "recording stopped" and "pipeline finished".
function makeDeferredManager({ fail = false } = {}) {
  const db = openDb(':memory:');
  let release;
  const gate = new Promise((r) => { release = r; });
  const mgr = new MeetingManager({
    db,
    audioRoot: '/tmp/audio',
    startCapture: () => ({ registry: { list: () => [] } }),
    finalize: async () => { await gate; if (fail) throw new Error('pipeline boom'); },
    now: () => '2026-06-04T10:30:00Z',
  });
  return { db, mgr, release };
}

test('stop resolves fast, before finalize settles; listProcessing shows the meeting until then', async () => {
  const { db, mgr, release } = makeDeferredManager();
  const id = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'standup', connection: {}, guild: {}, attendees: [] });

  // stop() returns while finalize is still gated — that's the whole point.
  const { meetingId, done } = await mgr.stop('g', 'c');
  assert.equal(meetingId, id);
  assert.equal(mgr.isActive('g', 'c'), false);
  assert.equal(db.getMeeting(id).status, 'processing');
  assert.equal(db.getMeeting(id).ended_at, '2026-06-04T10:30:00Z');

  const processing = mgr.listProcessing();
  assert.equal(processing.length, 1);
  assert.deepEqual(processing[0], {
    meetingId: id, guildId: 'g', channelId: 'c', channelName: 'standup',
    startedAt: '2026-06-04T10:30:00Z', stoppedAt: '2026-06-04T10:30:00Z',
  });

  release();
  await done;
  assert.equal(mgr.listProcessing().length, 0);
});

test('processing entry clears when finalize fails', async () => {
  const { mgr, release } = makeDeferredManager({ fail: true });
  mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const { done } = await mgr.stop('g', 'c');
  assert.equal(mgr.listProcessing().length, 1);
  release();
  await assert.rejects(done, /pipeline boom/);
  assert.equal(mgr.listProcessing().length, 0);
});

test('ended_at is stamped at recording stop and NOT overwritten at done', async () => {
  const db = openDb(':memory:');
  const mgr = new MeetingManager({
    db,
    audioRoot: '/tmp/audio',
    startCapture: () => ({ registry: { list: () => [] } }),
    // Mimics the orchestrator: it passes its own (later) timestamp at 'done'.
    finalize: async (meetingId) => { db.setMeetingStatus(meetingId, 'done', '2026-06-04T10:45:00Z'); },
    now: () => '2026-06-04T10:30:00Z',
  });
  const id = mgr.start({ guildId: 'g', channelId: 'c', channelName: 'x', connection: {}, guild: {}, attendees: [] });
  const { done } = await mgr.stop('g', 'c');
  await done;
  const m = db.getMeeting(id);
  assert.equal(m.status, 'done');
  // Duration = recording time: the stop timestamp wins over the pipeline-finish one.
  assert.equal(m.ended_at, '2026-06-04T10:30:00Z');
});
