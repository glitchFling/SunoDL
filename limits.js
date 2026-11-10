import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ZIP64 supports archives above the classic 4 GiB ZIP boundary.
export const MAX_ZIP_BYTES = 5_000_000_000;
// Buffering/tagging is per track, so keep a safe ceiling below the 4 GiB
// container memory allocation while allowing larger WAV exports.
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 5_000_000_000;
export const MAX_ENTRIES = 2000;

export function byteLimit(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes ? Error('ZIP exceeds the 5 GB output limit.') : null, chunk);
    }
  });
}

export async function readEntry(file, budget) {
  const chunks = [];
  let size = 0;
  // JSZip uses readable-stream v2, whose streams do not implement async
  // iteration. pipeline supports that stream and still stops inflation early.
  await pipeline(file.nodeStream('nodebuffer'), new Writable({
    write(chunk, encoding, callback) {
      size += chunk.length;
      budget.remaining -= chunk.length;
      if (size > MAX_FILE_BYTES) return callback(Error('A single file exceeds the 256 MiB per-file limit.'));
      if (budget.remaining < 0) return callback(Error('Playlist contents exceed the 5 GB expanded-data limit.'));
      chunks.push(chunk);
      callback();
    }
  }));
  return Buffer.concat(chunks, size);
}

export function isLyrics(name) {
  return /(?:^|[\s_.\/\\-])(lyrics?|lrc)(?:[\s_.\/\\-]|$)/i.test(name) || /\.(lrc|srt|vtt)$/i.test(name);
}

export async function clickDownload(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.locator(selector).click()
  ]);
  return download;
}
