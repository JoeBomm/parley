// test/live-api.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { apiRouter } from '../src/web/api.js';

// A fake bot controller exposing just the live surface the API uses.
function fakeBot(sessions = [], client = null) {
  return {
    client,
    _sessions: [...sessions],
    liveMeetings() { return this._sessions; },
    async stopMeeting(guildId, channelId) {
      const before = this._sessions.length;
      this._sessions = this._sessions.filter((s) => !(s.guildId === guildId && s.channelId === channelId));
      if (this._sessions.length === before) return { ok: false, error: 'No active recording in that channel.' };
      return { ok: true };
    },
  };
}

function appWith(db, bot) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ db, bot }));
  return app;
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('GET /guilds/:g/live returns the bot live sessions, scoped by guild', async () => {
  const db = openDb(':memory:');
  const m = db.createMeeting({ guildId: 'g1', channelId: 'c1', channelName: 'standup', startedAt: 'now' });
  db.addAttendee(m, 'u1', 'Alice');
  const bot = fakeBot([
    { meetingId: m, guildId: 'g1', channelId: 'c1', channelName: 'standup', startedAt: '2026-06-30T10:00:00Z' },
    { meetingId: 99, guildId: 'g2', channelId: 'cz', channelName: 'other', startedAt: '2026-06-30T10:00:00Z' },
  ]);
  const { base, close } = await listen(appWith(db, bot));
  try {
    const { live } = await (await fetch(`${base}/api/guilds/g1/live`)).json();
    assert.equal(live.length, 1);
    assert.equal(live[0].channelName, 'standup');
    // Falls back to stored attendees when there's no live Discord client.
    assert.deepEqual(live[0].attendees.map((a) => a.displayName), ['Alice']);
  } finally { close(); }
});

test('POST /guilds/:g/live/:channelId/stop stops a recording', async () => {
  const db = openDb(':memory:');
  const bot = fakeBot([{ meetingId: 1, guildId: 'g1', channelId: 'c1', channelName: 'standup', startedAt: 'now' }]);
  const { base, close } = await listen(appWith(db, bot));
  try {
    const ok = await fetch(`${base}/api/guilds/g1/live/c1/stop`, { method: 'POST' });
    assert.equal(ok.status, 200);
    // Now it's gone from the live list.
    const { live } = await (await fetch(`${base}/api/guilds/g1/live`)).json();
    assert.equal(live.length, 0);
    // Stopping a channel with nothing live → 404.
    const missing = await fetch(`${base}/api/guilds/g1/live/c1/stop`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally { close(); }
});

test('live endpoints degrade gracefully with no bot attached', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, null));
  try {
    const { live } = await (await fetch(`${base}/api/guilds/g1/live`)).json();
    assert.deepEqual(live, []);
    const stop = await fetch(`${base}/api/guilds/g1/live/c1/stop`, { method: 'POST' });
    assert.equal(stop.status, 400); // not managed here
  } finally { close(); }
});

test('phase passes through; processing entries skip the live roster override', async () => {
  const db = openDb(':memory:');
  const rec = db.createMeeting({ guildId: 'g1', channelId: 'c1', channelName: 'standup', startedAt: 'now' });
  db.addAttendee(rec, 'u1', 'Alice');
  const proc = db.createMeeting({ guildId: 'g1', channelId: 'c2', channelName: 'retro', startedAt: 'now' });
  db.addAttendee(proc, 'u2', 'Bob');
  // Both channels have live voice members named Zoe — only the recording
  // session may use that roster; the processing one keeps stored attendees.
  const client = {
    guilds: { cache: new Map([['g1', { channels: { cache: new Map([
      ['c1', { members: new Map([['z', { id: 'z', displayName: 'Zoe', user: { bot: false } }]]) }],
      ['c2', { members: new Map([['z', { id: 'z', displayName: 'Zoe', user: { bot: false } }]]) }],
    ]) } }]]) },
  };
  const bot = fakeBot([
    { meetingId: rec, guildId: 'g1', channelId: 'c1', channelName: 'standup', startedAt: '2026-07-03T10:00:00Z', phase: 'recording' },
    { meetingId: proc, guildId: 'g1', channelId: 'c2', channelName: 'retro', startedAt: '2026-07-03T09:00:00Z', stoppedAt: '2026-07-03T09:30:00Z', phase: 'processing' },
  ], client);
  const { base, close } = await listen(appWith(db, bot));
  try {
    const { live } = await (await fetch(`${base}/api/guilds/g1/live`)).json();
    assert.equal(live.length, 2);
    const recording = live.find((s) => s.phase === 'recording');
    const processing = live.find((s) => s.phase === 'processing');
    // Recording: live voice-channel roster wins.
    assert.deepEqual(recording.attendees.map((a) => a.displayName), ['Zoe']);
    // Processing: bot already left the channel — stored attendees, stoppedAt kept.
    assert.deepEqual(processing.attendees.map((a) => a.displayName), ['Bob']);
    assert.equal(processing.stoppedAt, '2026-07-03T09:30:00Z');
  } finally { close(); }
});
