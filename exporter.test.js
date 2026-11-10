import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {chromium} from 'playwright';
import {exportPlaylist, playlistUrl} from './exporter.js';

test('playlist validation accepts only a full public playlist URL', () => {
  assert.equal(playlistUrl('https://suno.com/playlist/2259b722-dc70-43d2-9921-21ef9a0030d2'), 'https://suno.com/playlist/2259b722-dc70-43d2-9921-21ef9a0030d2');
  for (const url of ['https://example.com/playlist/2259b722-dc70-43d2-9921-21ef9a0030d2', 'https://suno.com/@user', 'http://suno.com/playlist/test']) assert.throws(() => playlistUrl(url));
});

test('export clicks the notice, receives a ZIP, and cleans real ZIP streams', async () => {
  const zip = new JSZip();
  zip.file('Track - usesuno.com.mp3', 'ID3-test-audio');
  zip.file('lyrics/Track.txt', 'lyrics');
  zip.file('usesuno.com.txt', 'promotion');
  const base64 = await zip.generateAsync({type:'base64'});
  const html = `<!doctype html><textarea id="pl-input"></textarea><button id="pl-submit">Load</button>
    <input id="pl-select-all" type="checkbox"><input data-select-index="0" type="checkbox">
    <button id="pl-batch-btn">Export</button><button data-audio-format-choice="mp3" onclick="document.querySelector('[data-download-continue]').hidden=false">MP3</button>
    <button data-download-continue hidden onclick="const a=document.createElement('a');a.href='data:application/zip;base64,${base64}';a.download='test.zip';a.click()">Continue download</button>`;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sunodl-regression-'));
  try {
    const result = await exportPlaylist({playlist:'https://suno.com/playlist/2259b722-dc70-43d2-9921-21ef9a0030d2',format:'mp3',lyrics:false,folder,update:()=>{},launch:async()=>{
      const browser=await chromium.launch();
      const newContext=browser.newContext.bind(browser);
      browser.newContext=async options=>{const context=await newContext(options);await context.route('https://usesuno.com/tools/playlist/',route=>route.fulfill({contentType:'text/html',body:html}));return context;};
      return browser;
    }});
    assert.equal(result.tracks,1);
    const cleaned=await JSZip.loadAsync(await readFile(result.file),{checkCRC32:true});
    assert.deepEqual(Object.keys(cleaned.files),['Track.mp3']);
    assert.equal(await cleaned.file('Track.mp3').async('string'),'ID3-test-audio');
  } finally { await rm(folder,{recursive:true,force:true}); }
});
