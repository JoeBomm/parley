import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeFile } from '../src/adapters/stt-client.js';

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
}

const fakeRead = async () => Buffer.from('RIFFfake');

test('transcribeFile returns parsed body on success', async () => {
  const fetchImpl = fakeFetch([{ ok: true, status: 200, body: { text: 'hi', words: [] } }]);
  const out = await transcribeFile('/tmp/a.wav', { model: 'small', language: 'auto' },
    { baseUrl: 'http://x', fetchImpl, readFile: fakeRead });
  assert.equal(out.text, 'hi');
});

test('transcribeFile retries once then succeeds', async () => {
  const fetchImpl = fakeFetch([new Error('boom'), { ok: true, status: 200, body: { text: 'ok', words: [] } }]);
  const out = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 });
  assert.equal(out.text, 'ok');
});

test('transcribeFile throws after exhausting retries', async () => {
  const fetchImpl = fakeFetch([new Error('boom'), new Error('boom2')]);
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 }),
    /boom2/
  );
});

test('transcribeFile does NOT retry a 4xx (client error)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 400, json: async () => ({}) }; };
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 3, backoffMs: 0 }),
    /HTTP 400/
  );
  assert.equal(calls, 1, 'a 4xx must fail fast without re-uploading');
});

test('transcribeFile DOES retry a 5xx (transient server error)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ text: 'recovered', words: [] }) };
  };
  const out = await transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: fakeRead, retries: 1, backoffMs: 0 });
  assert.equal(out.text, 'recovered');
  assert.equal(calls, 2);
});

test('transcribeFile surfaces a timeout abort error after retries', async () => {
  // fetchImpl that always throws a TimeoutError-like error, ignoring the signal
  const fetchImpl = async () => { throw new Error('The operation timed out'); };
  await assert.rejects(
    transcribeFile('/tmp/a.wav', {}, { baseUrl: 'http://x', fetchImpl, readFile: async () => Buffer.from('x'), retries: 1, timeoutMs: 5 }),
    /timed out/
  );
});
