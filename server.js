import express from 'express';
import {randomUUID} from 'node:crypto';
import {mkdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {passwordGate} from './auth.js';
import {exportPlaylist, playlistUrl} from './exporter.js';
import {runArtworkCheck} from './root.playwright.js';

const app = express();
app.use(passwordGate(process.env.APP_PASSWORD));
app.use(express.json({limit: '32kb'}));
app.use(express.static('public'));
app.get('/healthz', (req, res) => res.json({status: 'ok'}));
const jobs = new Map();
const artworkChecks = new Map();
const activeDownloads = new Set();
let active = null;
let activeArtworkCheck = false;
let lastActivityAt = Date.now();
const retention = 30 * 60 * 1000;

const publicJob = job => ({
  id: job.id, status: job.status, stage: job.stage, message: job.message,
  percent: job.percent, detail: job.detail, total: job.total,
  tracks: job.tracks, bytes: job.bytes, warning: job.warning,
  title: job.title, cover: job.cover, previewTracks: job.previewTracks?.slice(0, 24) || [], artworkCount:job.artworkCount,
  embeddedArtworkCount:job.embeddedArtworkCount,
  error: job.error, filename: job.filename || 'Suno Playlist.zip'
});

app.post('/api/jobs', async (req, res) => {
  if (active || activeDownloads.size) return res.status(429).json({error: 'Another export or ZIP download is running. Please wait until it finishes.'});
  let playlist, format;
  try {
    playlist = playlistUrl(req.body?.playlist);
    format = req.body?.format;
    if (!['mp3', 'wav', 'original'].includes(format)) throw Error('Choose MP3, WAV, or Original.');
  } catch (error) { return res.status(400).json({error: error.message}); }
  const id = randomUUID();
  const job = {id, status: 'running', stage: 'loading', message: 'Starting your export', percent: null,
    folder: path.join(os.tmpdir(), `sunodl-${id}`), controller: new AbortController(), created: Date.now()};
  active = id;
  lastActivityAt = Date.now();
  // A single ZIP can approach 5 GiB, so remove old completed archives before
  // creating another one. This keeps temporary storage within the app's disk cap.
  const completed = [...jobs.values()].filter(item => item.finished);
  for (const old of completed) {
    jobs.delete(old.id);
    await rm(old.folder, {recursive: true, force: true}).catch(() => {});
  }
  jobs.set(id, job);
  res.status(202).json(publicJob(job));
  // The HTTP request ends here. Long exports continue independently while the
  // client polls short status requests, avoiding Azure's request timeout.
  (async () => {
    try {
      await mkdir(job.folder, {recursive: true, mode: 0o700});
      const result = await exportPlaylist({playlist, format, lyrics: req.body.lyrics === true,
        folder: job.folder, signal: job.controller.signal, update: state => Object.assign(job, state)});
      Object.assign(job, result, {status: 'ready', stage: 'ready', percent: 100, message: 'Your ZIP is ready'});
    } catch (error) {
      Object.assign(job, {status: job.controller.signal.aborted ? 'cancelled' : 'failed', error: error.message});
      await rm(job.folder, {recursive: true, force: true}).catch(() => {});
    } finally { job.finished = Date.now(); lastActivityAt = Date.now(); active = null; }
  })();
});

app.get('/api/jobs/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({error: 'This export has expired. Start a new export.'});
  res.json(publicJob(job));
});
app.post('/api/artwork-checks', (req, res) => {
  let playlist;
  try {
    playlist = playlistUrl(req.body?.playlist);
    if (req.body?.format !== 'mp3') throw Error('The artwork check requires MP3 format.');
  } catch (error) { return res.status(400).json({error: error.message}); }
  if (activeArtworkCheck) return res.status(429).json({error: 'An artwork check is already running.'});
  const id = randomUUID();
  const check = {id, status: 'running', format: 'MP3', startedAt: new Date().toISOString()};
  artworkChecks.set(id, check);
  activeArtworkCheck = true;
  lastActivityAt = Date.now();
  res.status(202).json({id, status: check.status, format: check.format, startedAt: check.startedAt});
  runArtworkCheck({
    playlist,
    appUrl: process.env.SUNODL_URL || 'https://sunodl-55q.pages.dev/',
    username: 'sunodlc',
    password: process.env.APP_PASSWORD,
    keepZip: false
  }).then(result => {
    Object.assign(check, result, {status: result.passed ? 'ready' : 'failed'});
  }).catch(error => {
    Object.assign(check, {status: 'failed', passed: false, completedAt: new Date().toISOString(), error: error.message || 'The artwork check failed.'});
  }).finally(() => {
    check.finished = Date.now();
    lastActivityAt = Date.now();
    activeArtworkCheck = false;
  });
});
app.get('/api/artwork-checks/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const check = artworkChecks.get(req.params.id);
  if (!check) return res.status(404).json({error: 'This artwork check has expired. Start a new check.'});
  const {finished, ...result} = check;
  res.json(result);
});
app.get('/api/activity', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const job = active ? jobs.get(active) : null;
  res.json({active: Boolean(job) || activeArtworkCheck, status: activeArtworkCheck ? 'artwork-check' : job?.status || 'idle', stage: activeArtworkCheck ? 'validating artwork' : job?.stage || null,
    lastActivityAt: new Date(lastActivityAt).toISOString()});
});
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({error: 'Export not found.'});
  if (job.status === 'running') job.controller.abort();
  res.json({status: 'cancelling'});
});
app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({error: 'This export has expired. Start a new export.'});
  if (job.status !== 'ready') return res.status(409).json({error: 'This export is not ready yet.'});
  job.finished = Date.now();
  activeDownloads.add(job.id);
  const releaseDownload = () => activeDownloads.delete(job.id);
  res.once('finish', releaseDownload);
  res.once('close', releaseDownload);
  res.set('Cache-Control', 'no-store');
  res.download(job.file, job.filename || path.basename(job.file), error => {
    if (error && !res.headersSent) res.status(500).json({error: 'The ZIP could not be sent. Please try downloading it again.'});
  });
});
setInterval(() => {
  for (const [id, job] of jobs) {
    if (job.finished && Date.now() - job.finished > retention) {
      jobs.delete(id);
      rm(job.folder, {recursive: true, force: true}).catch(() => {});
    }
  }
  for (const [id, check] of artworkChecks) {
    if (check.finished && Date.now() - check.finished > retention) artworkChecks.delete(id);
  }
}, 60000).unref();

app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('SunoDL is listening'));
