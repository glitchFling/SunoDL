import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import JSZip from 'jszip';
import {chromium} from 'playwright';
import {parseBuffer} from 'music-metadata';
import {songUrls, exportSongs} from './song-export.js';

const suno = 'https://suno.com/song/2259b722-dc70-43d2-9921-21ef9a0030d2';
const apple = 'https://music.apple.com/us/song/test/123456789';

test('multiline input validates every provider URL and preserves input order', () => {
  assert.deepEqual(songUrls(` ${suno}\r\n\n${apple}\n${suno}`).map(song => song.provider), ['suno', 'apple', 'suno']);
  assert.equal(songUrls('https://music.apple.com/us/album/test/123?i=456')[0].provider, 'apple');
  for (const value of ['', 'https://evil.test/song/test', apple.replace('https:', 'http:'),
    apple.replace('music.apple.com', 'music.apple.com.evil.test'), 'https://music.apple.com/us/album/test/123',
    suno.replace('suno.com', 'user@suno.com'), `${suno}\ninvalid`]) assert.throws(() => songUrls(value));
});

test('mixed song batch downloads through the Apple UI and preserves numbering and audio tags', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sunodl-songs-test-'));
  const originalFetch = globalThis.fetch;
  try {
    const source = path.join(folder, 'tone.mp3');
    await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', source]);
    const audio = await readFile(source);
    globalThis.fetch = async url => new Response(String(url).includes('cdn1.suno.ai') ? audio : '<title>Suno Song | Suno</title>');
    const result = await exportSongs({songs: songUrls(`${suno}\n${apple}\n${suno}`), format: 'mp3', folder,
      update: () => {}, signal: new AbortController().signal,
      launch: async () => {
        const browser = await chromium.launch();
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async options => {
          const context = await newContext(options);
          await context.route('https://aaplmusicdownloader.com/**', route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname === '/audio.mp3') return route.fulfill({headers: {'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="Apple Song.mp3"'}, body: audio});
            if (pathname === '/song.php') return route.fulfill({contentType: 'text/html', body: `
              <button id="download_btn" track_name="Apple Song" onclick="document.querySelector('#qformats').hidden=false">Download</button>
              <div id="qformats" hidden><button id="audioDropdownTrigger">Quality</button>
              <button onclick="selectAudioQuality('320')">MP3</button></div><div id="zlink" hidden></div>
              <script>function selectAudioQuality(value) { document.querySelector('#zlink').hidden=false;
                document.querySelector('#zlink').innerHTML='<a href="/audio.mp3">Download</a>'; location.href='/audio.mp3'; }</script>`});
            return route.fulfill({contentType: 'text/html', body: '<input id="id_url" oninput="location.href=\'/song.php\'">'});
          });
          return context;
        };
        return browser;
      }});
    const zip = await JSZip.loadAsync(await readFile(result.file), {checkCRC32: true});
    const names = Object.keys(zip.files);
    assert.deepEqual(names, ['01 - Suno Song.mp3', '02 - Apple Song.mp3', '03 - Suno Song.mp3']);
    const second = await parseBuffer(await zip.file(names[1]).async('nodebuffer'));
    assert.equal(second.common.title, '02 - Apple Song');
    assert.equal(second.common.track.no, 2);
    assert.equal(result.tracks, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, {recursive: true, force: true});
  }
});

test('Apple CAPTCHA rejects promptly and closes the browser', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sunodl-captcha-test-'));
  let browser;
  try {
    await assert.rejects(exportSongs({songs: songUrls(apple), format: 'mp3', folder,
      update: () => {}, signal: new AbortController().signal,
      launch: async () => {
        browser = await chromium.launch();
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async options => {
          const context = await newContext(options);
          await context.route('https://aaplmusicdownloader.com/**', route => route.fulfill({
            contentType: 'text/html', body: '<input id="id_url"><div id="captcha_form">CAPTCHA</div>'
          }));
          return context;
        };
        return browser;
      }}), /requires a CAPTCHA/);
    assert.equal(browser.isConnected(), false);
  } finally {
    await browser?.close();
    await rm(folder, {recursive: true, force: true});
  }
});

test('Suno song exports support Original and WAV with the selected audio format', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sunodl-song-formats-'));
  const originalFetch = globalThis.fetch;
  try {
    const source = path.join(folder, 'tone.mp3');
    await promisify(execFile)(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', source]);
    const audio = await readFile(source);
    globalThis.fetch = async url => new Response(String(url).includes('cdn1.suno.ai') ? audio : '<title>Test Song | Suno</title>');
    for (const format of ['original', 'wav']) {
      const result = await exportSongs({songs: songUrls(suno), format, folder, update: () => {}, signal: new AbortController().signal});
      const zip = await JSZip.loadAsync(await readFile(result.file));
      const extension = format === 'original' ? 'mp3' : 'wav';
      const bytes = await zip.file(`01 - Test Song.${extension}`).async('nodebuffer');
      const metadata = await parseBuffer(bytes);
      assert.equal(metadata.common.title, '01 - Test Song');
      if (format === 'wav') assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, {recursive: true, force: true});
  }
});
