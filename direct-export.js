import {stat} from 'node:fs/promises';
import path from 'node:path';
import {MAX_FILE_BYTES, MAX_TOTAL_BYTES} from './limits.js';
import {artworkUrl, collectArtwork} from './artwork.js';
import {embedArtwork} from './embedded-artwork.js';
import {createZipWriter} from './zip-stream.js';

const AUDIO_HOST = 'd2lwuy8qc234o3.cloudfront.net';
const trackIdPattern = /^[\da-f-]{36}$/i;

export class DirectSourceUnavailable extends Error {}

function decodeJsonString(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function readJsonString(text, key) {
  const match = text.match(new RegExp(`"${key}":("(?:\\\\.|[^"\\\\])*")`));
  return match ? decodeJsonString(match[1]) : '';
}

function readTrackObjects(decoded) {
  const markers = [...decoded.matchAll(/"contentId":"([\da-f-]{36})"/gi)];
  const tracks = new Map();
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = markers[i + 1]?.index ?? decoded.length;
    const segment = decoded.slice(start, end);
    if (!segment.includes('"contentType":"clip"')) continue;
    const itemStart = segment.indexOf('"contentItem":{');
    const item = itemStart >= 0 ? segment.slice(itemStart) : segment;
    const title = readJsonString(item, 'title');
    const media = item.match(/"url":("https:\/\/d2lwuy8qc234o3\.cloudfront\.net\/1\/clip\/[\da-f-]+\.m4a")/i);
    const id = markers[i][1];
    if (!title || !media || !trackIdPattern.test(id)) continue;
    const url = decodeJsonString(media[1]);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== AUDIO_HOST || parsed.port || parsed.username || parsed.password || parsed.pathname !== `/1/clip/${id}.m4a`) continue;
    const image = artworkUrl(readJsonString(item, 'imageUrl'));
    const duration = Number(item.match(/"duration":([\d.]+)/)?.[1] || 0);
    tracks.set(id, {id, title, url, image, duration});
  }
  return [...tracks.values()];
}

function playlistTitleFromHtml(html) {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const title = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s*\|\s*Suno\s*$/i, '').replace(/\s+by\s+@[^|]+$/i, '').trim();
  return title || 'Suno Playlist';
}

async function loadPlaylist(playlist, signal) {
  let html;
  try {
    const response = await fetch(playlist, {
      headers: {Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 SunoDL/1.0'},
      redirect: 'follow',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
    });
    if (!response.ok) throw new Error(`Suno returned HTTP ${response.status}.`);
    html = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DirectSourceUnavailable(`The public playlist page could not be read (${error.message}).`);
  }

  const tracks = new Map();
  const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const body = script[1];
    if (!body.includes('self.__next_f.push')) continue;
    const pushes = body.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g);
    for (const push of pushes) {
      const decoded = decodeJsonString(push[1]);
      if (typeof decoded !== 'string') continue;
      for (const track of readTrackObjects(decoded)) tracks.set(track.id, track);
    }
  }

  if (!tracks.size) throw new DirectSourceUnavailable('No direct Suno M4A tracks were found in the public playlist page.');
  const ordered = [...tracks.values()];
  const cover = artworkUrl(html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] || ordered[0].image);
  return {title: playlistTitleFromHtml(html), cover, tracks: ordered};
}

async function fetchTrack(track, signal) {
  let response;
  try {
    response = await fetch(track.url, {
      headers: {Accept: 'audio/mp4,application/octet-stream'},
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])])
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DirectSourceUnavailable(`Track ${track.title} could not be fetched from Suno's media CDN (${error.message}).`);
  }
  if (!response.ok || !response.body) throw new DirectSourceUnavailable(`Track ${track.title} returned HTTP ${response.status} from Suno's media CDN.`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_FILE_BYTES) throw Error('A single audio track exceeds the 256 MiB per-track limit.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw Error(`Track ${track.title} is empty.`);
  if (bytes.length > MAX_FILE_BYTES) throw Error('A single audio track exceeds the 256 MiB per-track limit.');
  const mp4Box = bytes.length >= 8 ? bytes.toString('ascii', 4, 8) : '';
  if (!['ftyp','styp'].includes(mp4Box)) {
    throw new DirectSourceUnavailable(`Suno's CDN returned a non-standalone audio payload for ${track.title}.`);
  }
  return bytes;
}

const cleanFileStem = value => String(value || 'Track').normalize('NFC')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 150) || 'Track';

export async function exportDirectPlaylist({playlist, folder, update, signal}) {
  const {title, cover, tracks} = await loadPlaylist(playlist, signal);
  const metadata = {
    title,
    cover,
    previewTracks: tracks.map(track => ({title: track.title, exportStem: track.title, image: track.image}))
  };
  update({stage: 'preparing', message: `Preparing ${tracks.length} original tracks`, total: tracks.length, percent: 0, ...metadata});
  const artworkPromise = collectArtwork(metadata, signal);
  const images = await artworkPromise;
  const imagesByTrack = new Map(images.files.filter(file => Number.isInteger(file.trackIndex)).map(file => [file.trackIndex, file]));
  if (!tracks.length) throw Error('This playlist has no available tracks.');
  const filename = `${cleanFileStem(title).slice(0, 100)}.zip`;
  const file = path.join(folder, filename);
  const output = createZipWriter(file);
  let embeddedArtworkCount = 0, artworkCount = 0, budget = MAX_TOTAL_BYTES;
  try {
    for (let index = 0; index < tracks.length; index++) {
      if (signal?.aborted) throw Error('Export cancelled.');
      const track = tracks[index], image = imagesByTrack.get(index) || null;
      update({stage: 'preparing', message: `Downloading original audio · ${index + 1} of ${tracks.length}`, percent: Math.floor(index / tracks.length * 55)});
      const sourceBytes = await fetchTrack(track, signal);
      const number = index + 1;
      const numberedTitle = `${number}. ${track.title}`;
      update({stage: 'cleaning', message: `Numbering and tagging · Track ${number} of ${tracks.length}`, percent: 55 + Math.floor((index / tracks.length) * 40)});
      const tagged = await embedArtwork(sourceBytes, '.m4a', image, {
        folder, index, signal, title: numberedTitle, album: title, track: `${number}/${tracks.length}`
      });
      budget -= tagged.bytes.length;
      if (budget < 0) throw Error('Playlist contents exceed the 5 GB expanded-data limit.');
      if (tagged.bytes.length > MAX_FILE_BYTES) throw Error('A single audio track exceeds the 256 MiB per-track limit.');
      if (tagged.embedded) embeddedArtworkCount++;
      await output.append(tagged.bytes, `${number}. ${cleanFileStem(track.title)}.m4a`);
    }

    for (const image of images.files) {
      if (budget < image.bytes.length) continue;
      budget -= image.bytes.length;
      await output.append(image.bytes, image.name);
      artworkCount++;
    }
    await output.finish();
  } catch (error) {
    await output.abort();
    throw error;
  }
  const warnings = [];
  if (images.failed) warnings.push(`${images.failed} cover image(s) could not be retrieved.`);
  if (embeddedArtworkCount < tracks.length) warnings.push(`Embedded covers verified in ${embeddedArtworkCount} of ${tracks.length} tracks.`);
  return {
    file, filename, title, tracks: tracks.length, total: tracks.length,
    bytes: (await stat(file)).size, artworkCount, embeddedArtworkCount,
    warning: warnings.join(' ')
  };
}
