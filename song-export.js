import {chromium} from 'playwright';
import {stat, readFile, writeFile, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {parseBuffer} from 'music-metadata';
import {MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES} from './limits.js';
import {embedArtwork} from './embedded-artwork.js';
import {createZipWriter} from './zip-stream.js';
import {artworkUrl, collectArtwork} from './artwork.js';

const run = promisify(execFile);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const stem = value => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 150) || 'Song';

export function songUrls(value) {
  if (typeof value !== 'string') throw Error('Enter one song URL per line.');
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_ENTRIES) throw Error(`Enter between 1 and ${MAX_ENTRIES} song URLs.`);
  return lines.map((line, index) => {
    let url;
    try { url = new URL(line); } catch { throw Error(`Line ${index + 1} is not a valid URL.`); }
    const suno = ['suno.com', 'www.suno.com'].includes(url.hostname) && new RegExp(`^/song/${uuid}/?$`, 'i').test(url.pathname);
    const apple = url.hostname === 'music.apple.com' && (
      /^\/[a-z]{2}\/song\/[^/]+\/\d+\/?$/i.test(url.pathname) ||
      (/^\/[a-z]{2}\/album\/[^/]+\/\d+\/?$/i.test(url.pathname) && (!url.searchParams.has('i') || /^\d+$/.test(url.searchParams.get('i') || ''))));
    if (url.protocol !== 'https:' || url.port || url.username || url.password || (!suno && !apple)) {
      throw Error(`Line ${index + 1}: use an HTTPS Suno /song/ link or an Apple Music song or album link.`);
    }
    url.hash = '';
    return {url: url.href, provider: suno ? 'suno' : 'apple', id: suno ? url.pathname.split('/')[2] : null};
  });
}

export async function expandSongUrls(songs, signal) {
  const expanded = [];
  for (const song of songs) {
    signal?.throwIfAborted();
    const url = new URL(song.url);
    if (song.provider !== 'apple' || !url.pathname.includes('/album/') || url.searchParams.has('i')) {
      expanded.push(song);
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      const albumId = parts.at(-1);
      const response = await fetch(`https://itunes.apple.com/lookup?id=${albumId}&entity=song&country=${parts[0]}&limit=2000`, {
        redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
      });
      if (!response.ok || !response.body) throw Error(`Apple Music album lookup returned HTTP ${response.status}.`);
      const data = JSON.parse((await readAudio(response.body, signal, 4 * 1024 * 1024)).toString('utf8'));
      const tracks = (data.results || []).filter(track => track.kind === 'song' && String(track.collectionId) === albumId)
        .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || a.trackNumber - b.trackNumber);
      if (!tracks.length) throw Error('Apple Music returned no available songs for this album in its selected country.');
      for (const track of tracks) {
        const trackUrl = new URL(url);
        trackUrl.search = `?i=${track.trackId}`;
        expanded.push(songUrls(trackUrl.href)[0]);
      }
    }
    if (expanded.length > MAX_ENTRIES) throw Error(`Albums expand to more than the ${MAX_ENTRIES} track limit.`);
  }
  return expanded;
}

async function readAudio(stream, signal, maximum = MAX_FILE_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    length += chunk.length;
    if (length > maximum) throw Error('The source exceeds the allowed file size.');
    chunks.push(Buffer.from(chunk));
  }
  if (!length) throw Error('The source returned an empty song.');
  return Buffer.concat(chunks, length);
}

async function sunoSong(track, signal) {
  const page = await fetch(track.url, {headers: {Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 SunoDL/1.0'},
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])});
  if (!page.ok || !page.body) throw Error(`Suno song page returned HTTP ${page.status}.`);
  const html = (await readAudio(page.body, signal, 4 * 1024 * 1024)).toString('utf8');
  const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s*\|\s*Suno\s*$/i, '').replace(/\s+by\s+@[^|]+$/i, '').trim();
  const image = artworkUrl(decode(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] || ''));
  const response = await fetch(`https://cdn1.suno.ai/${track.id}.mp3`, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  });
  if (!response.ok || !response.body) throw Error(`Suno audio returned HTTP ${response.status}.`);
  const artwork = image ? await collectArtwork({title, previewTracks: [{title, image}]}, signal) : null;
  return {bytes: await readAudio(response.body, signal), extension: '.mp3', fallbackTitle: title || track.id,
    image: artwork?.files.find(file => file.trackIndex === 0) || null};
}

async function appleSong(track, context, signal, format, update) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(90_000);
    let dialogMessage = '';
    page.on('dialog', dialog => { dialogMessage = dialog.message(); dialog.dismiss().catch(() => {}); });
    const response = await page.goto('https://aaplmusicdownloader.com/', {waitUntil: 'domcontentloaded'});
    if (!response?.ok()) throw Error(`AAPLmusicDownloader returned HTTP ${response?.status() || 'error'}. Please try again later.`);
    await page.locator('#id_url').fill(track.url);
    // Filling the field triggers the site's own input handler.
    await waitForSource(page, '#download_btn', signal);
    const fallbackTitle = await page.locator('#download_btn').getAttribute('track_name') || 'Apple Music Song';
    update({stage: 'preparing', message: `Preparing ${fallbackTitle} through AAPLmusicDownloader`});
    const pending = page.waitForEvent('download', {timeout: 180_000})
      .then(download => ({download}), error => ({error}));
    try {
      await page.locator('#download_btn').click();
      await waitForSource(page, '#qformats', signal);
      await page.locator('#audioDropdownTrigger').click();
      await page.locator(`button[onclick*="selectAudioQuality('${format === 'original' ? 'm4a' : '320'}'"]`).click();
      await waitForSource(page, '#zlink a', signal);
      if (dialogMessage) throw Error(dialogMessage);
      const result = await pending;
      if (result.error) throw result.error;
      const stream = await result.download.createReadStream();
      if (!stream) throw Error('Apple Music audio could not be read.');
      const extension = path.extname(result.download.suggestedFilename()).toLowerCase();
      if (!['.mp3', '.m4a'].includes(extension)) throw Error('Apple Music returned an unexpected file type.');
      return {bytes: await readAudio(stream, signal), extension, fallbackTitle};
    } finally {
      await page.close();
      await pending;
    }
  } finally { await page.close(); }
}

async function waitForSource(page, selector, signal) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await page.locator(selector).first().isVisible()) return;
    if (/\/users\//.test(new URL(page.url()).pathname)) throw Error('AAPLmusicDownloader requires sign-in or has reached its download limit.');
    if (await page.locator('#captcha_form, .cf-turnstile').first().isVisible()) {
      throw Error('AAPLmusicDownloader requires a CAPTCHA. Complete your download on its website and retry later.');
    }
    if (await page.locator('#error').isVisible()) throw Error('AAPLmusicDownloader could not prepare this song. It may be unavailable or rate limited.');
    await page.waitForTimeout(500);
  }
  throw Error('AAPLmusicDownloader timed out. Please try again later.');
}

export async function exportSongs({songs, format, folder, update, signal,
  launch = () => chromium.launch({headless: true, args: ['--disable-dev-shm-usage']})}) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Error('Song export timed out.')), 2 * 60 * 60 * 1000);
  signal = AbortSignal.any([signal, controller.signal]);
  const filename = 'Songs.zip', file = path.join(folder, filename);
  let browser, context, output, embeddedArtworkCount = 0, remaining = MAX_TOTAL_BYTES;
  const stop = () => browser?.close().catch(() => {});
  signal.addEventListener('abort', stop, {once: true});
  try {
    signal.throwIfAborted();
    update({stage: 'loading', message: 'Loading song links and expanding albums', percent: null});
    songs = await expandSongUrls(songs, signal);
    if (songs.some(song => song.provider === 'apple')) {
      browser = await launch();
      context = await browser.newContext({acceptDownloads: true,
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`});
    }
    signal.throwIfAborted();
    output = createZipWriter(file);
    update({total: songs.length, title: 'Songs', stage: 'preparing', message: 'Downloading songs', percent: 0});
    for (let index = 0; index < songs.length; index++) {
      signal.throwIfAborted();
      update({stage: 'preparing', message: `Downloading song ${index + 1} of ${songs.length}`, percent: Math.floor(index / songs.length * 100)});
      let {bytes, extension, fallbackTitle, image} = songs[index].provider === 'suno'
        ? await sunoSong(songs[index], signal)
        : await appleSong(songs[index], context, signal, format, update);
      const metadata = await parseBuffer(bytes, {size: bytes.length});
      const title = `${String(index + 1).padStart(2, '0')} - ${metadata.common.title || fallbackTitle}`;
      if (format === 'wav' || (format === 'mp3' && extension !== '.mp3')) {
        const input = path.join(folder, `convert-${index}${extension}`);
        const converted = path.join(folder, `convert-${index}.${format}`);
        try {
          await writeFile(input, bytes);
          const conversion = await run(ffmpeg, ['-nostdin', '-v', 'warning', '-y', '-i', input, '-map', '0:a:0', '-map_metadata', '0', '-fs', String(MAX_FILE_BYTES + 1), converted], {signal, timeout: 120_000});
          if (/filesize|file size|size limit/i.test(conversion.stderr)) throw Error('A converted song exceeds the 256 MiB per-track limit.');
          bytes = await readFile(converted);
          if (bytes.length > MAX_FILE_BYTES) throw Error('A converted song exceeds the 256 MiB per-track limit.');
          extension = `.${format}`;
        } finally { await Promise.all([input, converted].map(file => rm(file, {force: true}))); }
      }
      update({stage: 'cleaning', message: `Tagging song ${index + 1} of ${songs.length}`});
      const tagged = await embedArtwork(bytes, extension, image || null, {folder, index, signal, title, track: `${index + 1}/${songs.length}`});
      remaining -= tagged.bytes.length;
      if (tagged.bytes.length > MAX_FILE_BYTES || remaining < 0) throw Error('Song export exceeds the audio size limit.');
      if (tagged.embedded) embeddedArtworkCount++;
      await output.append(tagged.bytes, `${stem(title)}${extension}`);
    }
    await output.finish();
    return {file, filename, title: 'Songs', tracks: songs.length, total: songs.length, embeddedArtworkCount, bytes: (await stat(file)).size};
  } catch (error) {
    await output?.abort();
    throw error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
    await browser?.close();
  }
}
