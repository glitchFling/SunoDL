const hosts = new Set(['cdn.suno.ai', 'cdn1.suno.ai', 'cdn2.suno.ai', 'cdn.suno.com']);
const MAX_ARTWORK_BYTES = 128 * 1024 * 1024;
export function artworkUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.has(url.hostname) && !url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function fetchArtwork(url, {signal, fetchImage = fetch} = {}) {
  if (!artworkUrl(url)) throw Error('Unsupported artwork URL.');
  const response = await fetchImage(url, {redirect:'error', signal:AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])});
  if (!response.ok || !response.body) throw Error('Artwork could not be retrieved.');
  const max = 2 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw Error('Artwork is too large.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  const ext = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpg'
    : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'webp' : null;
  if (!ext) throw Error('The artwork was not a supported image.');
  return {bytes, ext};
}

export async function collectArtwork(metadata, signal) {
  const requests = [];
  if (metadata.cover) requests.push({name:'cover', url:metadata.cover});
  metadata.previewTracks.forEach((track,index) => {
    if (track.image) requests.push({trackIndex:index,name:`Artwork/${String(index+1).padStart(2,'0')} - ${track.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,130)}`,url:track.image});
  });
  const results = [], cache = new Map();
  let next = 0, failed = 0, totalBytes = 0;
  await Promise.all(Array.from({length:Math.min(4,requests.length)}, async () => {
    while (next < requests.length) {
      const request = requests[next++];
      try {
        if (!cache.has(request.url)) cache.set(request.url, fetchArtwork(request.url,{signal}));
        const image = await cache.get(request.url);
        if (totalBytes + image.bytes.length > MAX_ARTWORK_BYTES) { failed++; continue; }
        totalBytes += image.bytes.length;
        results.push({name:`${request.name}.${image.ext}`,bytes:image.bytes,ext:image.ext,trackIndex:request.trackIndex});
      } catch { failed++; }
    }
  }));
  return {files:results, failed};
}
