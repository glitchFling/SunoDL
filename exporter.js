import { chromium } from 'playwright';
import unzipper from 'unzipper';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { byteLimit, isLyrics, MAX_ZIP_BYTES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES } from './limits.js';
import { artworkUrl, collectArtwork } from './artwork.js';
import { embedArtwork } from './embedded-artwork.js';
import {DirectSourceUnavailable, exportDirectPlaylist} from './direct-export.js';
import {createZipWriter} from './zip-stream.js';

const MAX_EXPORT_TIME_MS = 2 * 60 * 60 * 1000;

async function readArchiveEntry(entry, budget) {
  const declared = Number(entry.vars?.uncompressedSize);
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw Error('An individual archive entry exceeds the 256 MiB per-file limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of entry) {
    size += chunk.length;
    budget.remaining -= chunk.length;
    if (size > MAX_FILE_BYTES) throw Error('An individual archive entry exceeds the 256 MiB per-file limit.');
    if (budget.remaining < 0) throw Error('Playlist contents exceed the 5 GB expanded-data limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function drainEntry(entry, budget) {
  for await (const chunk of entry) {
    budget.remaining -= chunk.length;
    if (budget.remaining < 0) throw Error('Playlist contents exceed the 5 GB expanded-data limit.');
  }
}

export function playlistUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['suno.com', 'www.suno.com'].includes(url.hostname) || !/^\/playlist\/[\da-f-]{36}\/?$/i.test(url.pathname)) {
    throw Error('Paste a public Suno playlist link, such as https://suno.com/playlist/…');
  }
  return url.href;
}

const cleanName = name => path.posix.basename(name.replaceAll('\\', '/'))
  .replace(/\s*[-_ ]*usesuno\.com\s*[-_ ]*/gi, ' ')
  .replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/\s+(\.[^.]+)$/, '$1');

function archiveFilename(title) {
  let name = String(title || 'Suno Playlist').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 100).trim().replace(/[. ]+$/g, '');
  if (!name) name = 'Suno Playlist';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `${name} (Playlist)`;
  return `${name}.zip`;
}

export async function exportPlaylist(options) {
  if (options.format === 'original') {
    try { return await exportDirectPlaylist(options); }
    catch (error) {
      if (!(error instanceof DirectSourceUnavailable) || options.signal?.aborted) throw error;
      console.warn(`Direct Suno media path unavailable; using the playlist exporter fallback: ${error.message}`);
    }
  }
  return exportPlaylistViaBrowser(options);
}

async function exportPlaylistViaBrowser({ playlist, format, lyrics, folder, update, signal,
  launch = () => chromium.launch({headless: true, args: ['--disable-dev-shm-usage']}) }) {
  const browser = await launch();
  let expired = false;
  let operation = 'starting the browser';
  const stop = () => browser.close().catch(() => {});
  const deadline = setTimeout(() => { expired = true; stop(); }, MAX_EXPORT_TIME_MS);
  signal?.addEventListener('abort', stop, {once: true});
  try {
    if (signal?.aborted) throw Error('Export cancelled.');
    const context = await browser.newContext({acceptDownloads: true});
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(120_000);
    update({stage: 'loading', message: 'Opening your playlist', percent: null});
    operation = 'opening the playlist exporter';
    await page.goto('https://usesuno.com/tools/playlist/', {waitUntil: 'domcontentloaded', timeout: 120_000});
    operation = 'loading your playlist';
    await page.locator('#pl-input').fill(playlist);
    await page.locator('#pl-submit').click();
    try { await page.locator('#pl-select-all').check({timeout: 120_000}); }
    catch {
      const notice = await page.locator('#pl-load-error-description').textContent().catch(() => '');
      throw Error(notice?.trim() || 'The playlist could not be loaded. Check that it is public and try again.');
    }
    const total = await page.locator('input[data-select-index]').count();
    if (!total) throw Error('This playlist has no available tracks.');
    const metadata = await page.evaluate(() => { const usedNames=new Set(); return ({
      title: document.querySelector('#pl-name')?.textContent?.trim() || 'Your playlist',
      cover: document.querySelector('#pl-cover')?.getAttribute('src') || '',
      previewTracks: [...document.querySelectorAll('.pl-item')].map((row,index)=>{
        const title=row.querySelector('.pl-title')?.textContent?.trim() || `Track ${index+1}`;
        const stem=window.UseSunoFilename?.stem(title) || title;
        return {title,exportStem:window.UseSunoZip?.uniqueName(stem,usedNames) || stem,
          image:row.querySelector('img.pl-thumb')?.getAttribute('src') || ''};
      })
    }); });
    metadata.cover = artworkUrl(metadata.cover);
    metadata.previewTracks = metadata.previewTracks.map(track=>({...track,image:artworkUrl(track.image)}));
    // Fetch covers while the source prepares audio, rather than adding another
    // serial download phase at the end of every export.
    const artwork = collectArtwork(metadata, signal);
    update({stage: 'preparing', message: `Preparing ${total} tracks`, total, percent: 0, ...metadata});
    operation = 'starting audio preparation';
    await page.locator('#pl-batch-btn').click();
    // Attach a rejection handler immediately; browser cancellation must never
    // leave an unhandled download waiter behind.
    const downloadResult = page.waitForEvent('download', {timeout: 0})
      .then(download => ({download}), error => ({error}));
    operation = 'choosing the audio format';
    await page.locator(`[data-audio-format-choice="${format}"]`).click();
    // Each fresh browser context displays this informational notice before
    // preparation starts. Format selection alone does not start the export.
    operation = 'confirming the download';
    await page.locator('[data-download-continue]').click({timeout: 30_000});
    let download;
    while (!download) {
      const result = await Promise.race([downloadResult, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
      if (result?.error) throw result.error;
      if (result?.download) { download = result.download; break; }
      operation = 'waiting for the source ZIP';
      const state = await page.evaluate(() => {
        const error = document.querySelector('#download-error-description');
        const visibleError = error && error.getBoundingClientRect().height > 0;
        const bar = document.querySelector('.download-progress-track');
        return {
          error: visibleError ? error.textContent : '',
          percent: bar ? Number(bar.getAttribute('aria-valuenow')) : null,
          message: document.querySelector('.download-progress-phase')?.textContent,
          detail: document.querySelector('[data-processed]')?.textContent
        };
      });
      if (state.error) throw Error(state.error.trim());
      update({stage: 'preparing', message: state.message || 'Preparing your audio', detail: state.detail || '', percent: state.percent});
    }
    if (!/\.zip$/i.test(download.suggestedFilename())) throw Error('The source returned an unexpected file instead of a ZIP.');
    update({stage: 'cleaning', message: 'Cleaning up filenames and packaging your ZIP', percent: null});
    operation = 'reading the source ZIP';
    const stream = await download.createReadStream();
    if (!stream) throw Error('The source ZIP could not be read. Please retry.');
    const images = await artwork;
    const trackByStem=new Map(metadata.previewTracks.map((track,index)=>[
      cleanName(track.exportStem).toLowerCase(),{track,index}
    ]));
    const trackImages=new Map(images.files.filter(image=>Number.isInteger(image.trackIndex))
      .map(image=>[image.trackIndex,image]));
    const filename = archiveFilename(metadata.title);
    const file = path.join(folder, filename);
    const output = createZipWriter(file), used = new Set(), budget = {remaining: MAX_TOTAL_BYTES};
    const parser = unzipper.Parse({forceStream: true});
    let sourceEntries = 0, tracks = 0, embeddedArtworkCount = 0, artworkCount = 0;
    const sourceDone = pipeline(stream, byteLimit(MAX_ZIP_BYTES), parser);
    // Attach immediately so a source stream failure cannot surface as an
    // unhandled rejection while the parser is being consumed asynchronously.
    sourceDone.catch(() => {});
    try {
      for await (const entry of parser) {
        if (++sourceEntries > MAX_ENTRIES) throw Error('This playlist has too many files. Export a smaller playlist.');
        const name = entry.path || '';
        if (entry.type === 'Directory' || name.endsWith('/')) { await drainEntry(entry, budget); continue; }
        if (!lyrics && isLyrics(name)) { await drainEntry(entry, budget); continue; }
        const clean = cleanName(name);
        if (!/\.(mp3|wav|flac|m4a|mp4|aac|ogg|opus|webm|jpe?g|png|webp|lrc|txt)$/i.test(clean) ||
          (/usesuno\.com/i.test(name) && /\.(txt|html?|url)$/i.test(name))) {
          await drainEntry(entry, budget);
          continue;
        }
        const ext = path.extname(clean), stem = clean.slice(0, -ext.length).slice(0, 160);
        const isAudio = /\.(mp3|wav|flac|m4a|mp4|aac|ogg|opus|webm)$/i.test(ext);
        const trackInfo = isAudio ? trackByStem.get(clean.slice(0, -ext.length).toLowerCase()) : null;
        const trackNumber = trackInfo ? trackInfo.index + 1 : tracks + 1;
        const trackTitle = `${trackNumber}. ${trackInfo?.track.title || stem}`;
        const outputStem = isAudio ? cleanName(trackTitle).slice(0, 160) : stem;
        let candidate = outputStem + ext, duplicate = 2;
        while (used.has(candidate.toLowerCase())) candidate = `${outputStem} (${duplicate++})${ext}`;
        used.add(candidate.toLowerCase());
        let bytes = await readArchiveEntry(entry, budget);
        if (isAudio) {
          const image = trackInfo ? trackImages.get(trackInfo.index) : null;
          update({stage: 'cleaning', message: `Numbering and tagging · Track ${trackNumber} of ${total}`, percent: Math.floor(tracks / total * 100)});
          const tagged = await embedArtwork(bytes, ext, image, {folder, index: tracks, signal, title: trackTitle,
            album: metadata.title, track: `${trackNumber}/${total}`});
          budget.remaining -= Math.max(0, tagged.bytes.length - bytes.length);
          if (budget.remaining < 0) throw Error('Playlist contents exceed the 5 GB expanded-data limit.');
          if (tagged.bytes.length > MAX_FILE_BYTES) throw Error('A single audio track exceeds the 256 MiB per-track limit.');
          bytes = tagged.bytes;
          if (tagged.embedded) embeddedArtworkCount++;
          tracks++;
        }
        await output.append(bytes, candidate);
      }
      await sourceDone;
      if (!tracks) throw Error('No audio could be exported. Try Original format or a smaller playlist.');
      for (const image of images.files) {
        if (budget.remaining < image.bytes.length) continue;
        budget.remaining -= image.bytes.length;
        await output.append(image.bytes, image.name);
        artworkCount++;
      }
      await output.finish();
    } catch (error) {
      parser.destroy(error);
      await sourceDone.catch(() => {});
      await output.abort();
      throw error;
    }
    const warnings = [];
    if (tracks < total) warnings.push(`${tracks} of ${total} tracks exported. The source could not prepare the remaining tracks.`);
    if (images.failed) warnings.push(`${images.failed} cover image(s) could not be retrieved.`);
    if(embeddedArtworkCount<tracks)warnings.push(`Embedded covers verified in ${embeddedArtworkCount} of ${tracks} tracks. Some formats or unavailable covers may prevent embedding.`);
    return {file, filename, bytes:(await stat(file)).size, tracks, total, artworkCount, embeddedArtworkCount, warning:warnings.join(' ')};
  } catch (error) {
    if (signal?.aborted) throw Error('Export cancelled.');
    if (expired) throw Error('The export took longer than 2 hours. Try a smaller playlist or retry later.');
    if (/exceed.*5 GB.*limit/i.test(error.message)) throw Error('This export exceeds the 5 GB ZIP or expanded-data limit. Try MP3 or a smaller playlist.');
    if (/Timeout|Target.*closed|browser.*closed/i.test(error.message)) {
      console.error(`SunoDL export timed out while ${operation}.`);
      throw Error(`The source timed out while ${operation}. Please retry, or choose Original format.`);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    await stop();
  }
}
