import { chromium } from 'playwright';
import JSZip from 'jszip';
import { parseBuffer } from 'music-metadata';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPlaylistUrl = 'https://suno.com/playlist/2259b722-dc70-43d2-9921-21ef9a0030d2';
const defaultAppUrl = process.env.SUNODL_URL || 'https://sunodl-55q.pages.dev/';
const credentialsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deployment-credentials.txt');
const defaultDownloadDirectory = path.join(os.tmpdir(), 'sunodl-playwright-downloads');
const defaultDownloadTimeout = 15 * 60 * 1000;

function credentialsFromFile(overrides = {}) {
  if (overrides.username && overrides.password) return { username: overrides.username, password: overrides.password };
  if (!existsSync(credentialsFile)) return null;
  const text = readFileSync(credentialsFile, 'utf8');
  const read = key => text.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*(.*?)\\s*$`, 'im'))?.[1];
  const username = process.env.SUNODL_USERNAME || read('Username');
  const password = process.env.SUNODL_PASSWORD || read('Password');
  return username && password ? { username, password } : null;
}

async function openApp(browser, appUrl, credentials) {
  let context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const response = await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  if (response?.status() !== 401) return { context, page };

  await context.close();
  if (!credentials) {
    throw new Error('SunoDL requires HTTP Basic credentials, but none were found in the environment or deployment-credentials.txt.');
  }

  context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: credentials
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const authenticatedResponse = await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  if (authenticatedResponse?.status() === 401) {
    await context.close();
    throw new Error('SunoDL rejected the local Basic Auth credentials.');
  }
  return { context, page };
}

async function validateArtwork(zipPath) {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const tracks = Object.entries(zip.files)
    .filter(([name, file]) => !file.dir && /\.mp3$/i.test(name));

  if (tracks.length === 0) throw new Error('The downloaded ZIP contains no MP3 tracks.');

  const missingArtwork = [];
  for (const [name, entry] of tracks) {
    const bytes = await entry.async('nodebuffer');
    try {
      const metadata = await parseBuffer(bytes, { mimeType: 'audio/mpeg', size: bytes.length });
      const hasEmbeddedArtwork = (metadata.common.picture || []).some(picture =>
        picture.data?.length > 0 && /^image\/(jpeg|png|webp|gif|bmp)$/i.test(picture.format || '')
      );
      if (!hasEmbeddedArtwork) missingArtwork.push(name);
    } catch {
      missingArtwork.push(name);
    }
  }

  return { total: tracks.length, missingArtwork };
}

export async function runArtworkCheck({
  playlist = defaultPlaylistUrl,
  appUrl = defaultAppUrl,
  username = process.env.SUNODL_USERNAME,
  password = process.env.SUNODL_PASSWORD,
  downloadDirectory = defaultDownloadDirectory,
  downloadTimeout = defaultDownloadTimeout,
  keepZip = true
} = {}) {
  const startedAt = new Date().toISOString();
  const runDirectory = path.join(downloadDirectory, `run-${Date.now()}-${process.pid}`);
  await mkdir(runDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let context;
  let zipPath;

  try {
    ({ context } = await openApp(browser, appUrl, credentialsFromFile({ username, password })));
    const page = context.pages()[0];
    await page.locator('#playlist').fill(playlist);
    await page.locator('input[name="format"][value="mp3"]').check();

    const downloadPromise = page.waitForEvent('download', { timeout: downloadTimeout });
    await page.locator('#go').click();
    const download = await downloadPromise;

    if (!/\.zip$/i.test(download.suggestedFilename())) {
      throw new Error('SunoDL returned a file that is not a ZIP archive.');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}-${path.basename(download.suggestedFilename())}`;
    zipPath = path.join(runDirectory, filename);
    await download.saveAs(zipPath);

    const result = await validateArtwork(zipPath);
    const passed = result.missingArtwork.length === 0;
    return {
      passed,
      title: path.basename(download.suggestedFilename()).replace(/\.zip$/i, ''),
      tracks: result.total,
      embeddedArtworkCount: result.total - result.missingArtwork.length,
      missingArtwork: result.missingArtwork,
      format: 'MP3',
      startedAt,
      completedAt: new Date().toISOString(),
      ...(keepZip ? { zipPath } : {}),
      ...(passed ? {} : { error: `Embedded artwork found in ${result.total - result.missingArtwork.length}/${result.total} MP3 tracks.` })
    };
  } catch (error) {
    return {
      passed: false,
      format: 'MP3',
      startedAt,
      completedAt: new Date().toISOString(),
      error: error.message || 'The artwork check failed.'
    };
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    if (!keepZip) await rm(runDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await mkdir(defaultDownloadDirectory, { recursive: true });
  const result = await runArtworkCheck({ downloadDirectory: defaultDownloadDirectory });
  if (result.passed) {
    console.log(`PASS: embedded artwork found in all ${result.tracks} MP3 tracks.`);
    if (result.zipPath) console.log(`ZIP: ${result.zipPath}`);
    return;
  }
  console.error(`FAIL: ${result.error}`);
  if (result.missingArtwork?.length) console.error(`Tracks missing artwork: ${result.missingArtwork.join(', ')}`);
  if (result.zipPath) console.error(`ZIP: ${result.zipPath}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
