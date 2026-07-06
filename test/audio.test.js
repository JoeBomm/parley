import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcmName, parsePcmName, wavHeader, convertPcmToWav } from '../src/voice/audio.js';

test('pcmName + parsePcmName roundtrip (userId may contain no underscores)', () => {
  const name = pcmName('123', 4567);
  assert.equal(name, '123_4567.pcm');
  assert.deepEqual(parsePcmName(name), { userId: '123', startMs: 4567 });
});

test('wavHeader builds a valid 44-byte RIFF/WAVE header for 16k mono s16', () => {
  const dataLength = 1000;
  const buf = wavHeader(dataLength);
  assert.equal(buf.length, 44);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + dataLength);
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.readUInt32LE(16), 16); // fmt chunk size
  assert.equal(buf.readUInt16LE(20), 1); // PCM format
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), 16000); // sample rate
  assert.equal(buf.readUInt32LE(28), 32000); // byte rate
  assert.equal(buf.readUInt16LE(32), 2); // block align
  assert.equal(buf.readUInt16LE(34), 16); // bits per sample
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), dataLength);
});

test('convertPcmToWav writes a header + raw PCM bytes to wavPath', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-test-'));
  try {
    const pcmPath = join(dir, 'in.pcm');
    const wavPath = join(dir, 'out.wav');
    const pcm = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
    await writeFile(pcmPath, pcm);

    const result = await convertPcmToWav(pcmPath, wavPath);
    assert.equal(result, wavPath);

    const out = await readFile(wavPath);
    assert.equal(out.length, 44 + pcm.length);
    assert.deepEqual(out.subarray(0, 44), wavHeader(pcm.length));
    assert.deepEqual(out.subarray(44), pcm);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('convertPcmToWav streams a large PCM correctly (header length + bytes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-big-'));
  try {
    const pcmPath = join(dir, 'big.pcm');
    const wavPath = join(dir, 'big.wav');
    // ~5 MB — exercises the streaming path across many chunks.
    const pcm = Buffer.alloc(5 * 1024 * 1024, 0xab);
    await writeFile(pcmPath, pcm);
    await convertPcmToWav(pcmPath, wavPath);
    const out = await readFile(wavPath);
    assert.equal(out.length, 44 + pcm.length);
    assert.deepEqual(out.subarray(0, 44), wavHeader(pcm.length));
    assert.equal(out.readUInt32LE(40), pcm.length); // data chunk length matches
    assert.deepEqual(out.subarray(44, 44 + 8), pcm.subarray(0, 8));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('convertPcmToWav handles an empty PCM (silent track)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parley-audio-empty-'));
  try {
    const pcmPath = join(dir, 'empty.pcm');
    const wavPath = join(dir, 'empty.wav');
    await writeFile(pcmPath, Buffer.alloc(0));
    await convertPcmToWav(pcmPath, wavPath);
    const out = await readFile(wavPath);
    assert.equal(out.length, 44);
    assert.equal(out.readUInt32LE(40), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
