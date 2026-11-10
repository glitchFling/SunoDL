import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { byteLimit, readEntry, isLyrics, clickDownload, MAX_FILE_BYTES } from './limits.js';
import JSZip from 'jszip';

test('reads and bounds actual JSZip entry streams', async () => {
  const zip = new JSZip();
  zip.file('track.mp3', Buffer.alloc(100000, 42));
  const archive = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const source = await JSZip.loadAsync(archive);
  assert.equal((await readEntry(source.file('track.mp3'), {remaining:100000})).length,100000);
  await assert.rejects(readEntry(source.file('track.mp3'), {remaining:50000}), /expanded size limit/);
});

test('lyrics filtering includes directory names and Windows paths', () => {
  for (const name of ['lyrics/Track.txt', 'album\\lyrics\\Track.txt', 'Track.lrc', 'Track lyrics.txt']) {
    assert.equal(isLyrics(name), true, name);
  }
  assert.equal(isLyrics('album/Track.mp3'), false);
});

test('compressed input rejects bytes beyond its limit', async () => {
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), byteLimit(5),
    new Writable({write(chunk, encoding, cb) { cb(); }})), /size limit/);
});

test('entry reads preserve content and enforce both expanded limits', async () => {
  const file = {nodeStream: () => Readable.from([Buffer.from('hello')])};
  assert.equal((await readEntry(file, {remaining: 5})).toString(), 'hello');
  await assert.rejects(readEntry(file, {remaining: 4}), /expanded size limit/);
  const oversized = {nodeStream: () => Readable.from((function* () {
    for (let i = 0; i <= MAX_FILE_BYTES / 1048576; i++) yield Buffer.alloc(1048576);
  })())};
  await assert.rejects(readEntry(oversized, {remaining: Infinity}), /expanded size limit/);
});

test('failed click handles a later rejection from the download waiter', async () => {
  let rejectDownload;
  const page = {
    waitForEvent: () => new Promise((resolve, reject) => { rejectDownload = reject; }),
    locator: () => ({click: async () => { throw Error('click failed'); }})
  };
  await assert.rejects(clickDownload(page, '#download'), /click failed/);
  rejectDownload(Error('browser closed'));
  await new Promise(resolve => setImmediate(resolve));
});
