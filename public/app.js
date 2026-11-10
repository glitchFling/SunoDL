const $ = selector => document.querySelector(selector);
const form = $('#form'), go = $('#go'), status = $('#status'), loading = $('#loading');
const progress = $('#progress'), label = $('#progress-label'), value = $('#progress-value');
const cancel = $('#cancel'), saveAgain = $('#save-again');
const stages = ['loading', 'preparing', 'cleaning', 'downloading'];
let jobId = null, busy = false, cancelled = false;
const remember = id => { try { id ? sessionStorage.setItem('sunodl-job', id) : sessionStorage.removeItem('sunodl-job'); } catch {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function state(name) { document.body.dataset.state = name; }
function setBusy(enabled) {
  busy = enabled;
  go.disabled = enabled;
  form.setAttribute('aria-busy', String(enabled));
  go.querySelector('span').textContent = enabled ? 'Export in progress' : 'Export playlist';
  cancel.hidden = !enabled;
}
function stage(name, message, percent, detail = '') {
  loading.hidden = false;
  label.textContent = message;
  $('#progress-detail').textContent = detail;
  if (Number.isFinite(percent)) { progress.value = Math.max(0, Math.min(100, percent)); value.textContent = `${Math.floor(progress.value)}%`; }
  else { progress.removeAttribute('value'); value.textContent = ''; }
  document.querySelectorAll('[data-stage]').forEach(item => {
    const index = stages.indexOf(item.dataset.stage), current = stages.indexOf(name);
    item.classList.toggle('active', index === current);
    item.classList.toggle('done', index < current || name === 'ready');
  });
}
async function jsonRequest(url, options = {}, timeoutMs = 30000) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(timeoutMs)});
  let data;
  try { data = await response.json(); } catch { throw Error('The service could not respond. Please try again.'); }
  if (!response.ok) throw Error(data.error || 'The export could not be started.');
  return data;
}
function saveZip(id, filename) {
  stage('downloading', 'Sending the ZIP to your browser', 100);
  cancel.hidden = true;
  const link = document.createElement('a');
  // Let the browser stream and save the response itself. Fetching a Blob here
  // used to delay the download handoff until the entire file was in memory.
  link.href = `/api/jobs/${id}/download`; link.download = filename || 'Suno Playlist.zip';
  document.body.append(link); link.click(); link.remove();
}

let previewKey = '';
function showArtwork(job) {
  if (!job.title || !job.previewTracks) return;
  const key = job.id + job.cover;
  if (key === previewKey) return;
  previewKey = key;
  $('#playlist-preview').hidden = false;
  $('#playlist-title').textContent = job.title;
  $('#playlist-summary').textContent = `${job.total} tracks · Matching covers applied to your audio`;
  const image = $('#playlist-cover');
  image.hidden = !job.cover;
  if (job.cover) {
    image.src = job.cover; image.alt = `${job.title} playlist artwork`;
    $('#hero-cover-image').src = job.cover;
    $('#hero-cover-image').alt = `${job.title} playlist artwork`;
    $('#hero-cover-title').textContent = job.title;
    $('#hero-cover').hidden = false;
    $('.record-scene').classList.add('has-artwork');
  }
  const strip = $('#track-artwork'); strip.replaceChildren();
  job.previewTracks.filter(track=>track.image).forEach(track=>{
    const cover = document.createElement('img');
    cover.src=track.image; cover.alt=`${track.title} artwork`; cover.title=track.title;
    cover.loading='lazy'; cover.referrerPolicy='no-referrer'; strip.append(cover);
  });
}
async function followJob(id) {
  let connectionFailures = 0;
  while (true) {
    let job;
    try { job = await jsonRequest(`/api/jobs/${id}`, {}, 30000); connectionFailures = 0; }
    catch (error) {
      if (/expired/i.test(error.message)) throw error;
      if (++connectionFailures > 5) throw Error('Connection lost. Refresh this page to reconnect to your export.');
      status.textContent = 'Reconnecting to your export…';
      await sleep(2000); continue;
    }
    if (job.status === 'failed' || job.status === 'cancelled') { remember(null); throw Error(job.error || 'Export cancelled.'); }
    showArtwork(job);
    if (job.status === 'ready') {
      saveAgain.href = `/api/jobs/${id}/download`;
      saveAgain.download = job.filename || 'Suno Playlist.zip';
      saveAgain.hidden = false;
      await saveZip(id, job.filename);
      state('ready'); stage('ready', 'Your ZIP is ready', 100);
      $('#session-badge').textContent = 'EXPORT COMPLETE';
      $('#session-heading').textContent = 'Made for the replay.';
      status.textContent = `${job.tracks} tracks · ${job.embeddedArtworkCount || 0} embedded covers · ${(job.bytes / 1048576).toFixed(1)} MB. ${job.warning || 'ZIP sent to your browser. See Downloads for transfer progress.'}`;
      remember(null);
      return;
    }
    if (cancelled) status.textContent = 'Cancelling your export…';
    else {
      $('#session-heading').textContent = job.total ? `${job.total} tracks. One clean ZIP.` : 'Finding your next replay.';
      status.textContent = 'Keep this tab open. Your export is running and updates automatically.';
    }
    stage(job.stage, job.message, job.percent, job.detail);
    await sleep(1200);
  }
}
async function run(existingId) {
  if (busy) return;
  setBusy(true); cancelled = false; state('running'); saveAgain.hidden = true;
  $('#session-badge').textContent = 'LIVE EXPORT';
  $('#session-heading').textContent = 'Finding your next replay.';
  status.textContent = 'Opening your playlist. We’ll take it from here.';
  stage('loading', 'Opening your playlist', null);
  try {
    if (!existingId) {
      const job = await jsonRequest('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
        playlist: $('#playlist').value, format: $('input[name=format]:checked').value, lyrics: $('#lyrics').checked
      })}, 60000);
      jobId = job.id;
    } else jobId = existingId;
    remember(jobId);
    await followJob(jobId);
  } catch (error) {
    if (/expired/i.test(error.message)) remember(null);
    state('failed'); loading.hidden = true;
    $('#session-badge').textContent = cancelled ? 'CANCELLED' : 'NEEDS A RETRY';
    $('#session-heading').textContent = cancelled ? 'Paused the music.' : 'Let’s give that another go.';
    status.textContent = error.message;
  } finally { setBusy(false); }
}
form.addEventListener('submit', event => { event.preventDefault(); run(); });
cancel.addEventListener('click', async () => {
  if (!jobId) return;
  cancel.disabled = true;
  try { await jsonRequest(`/api/jobs/${jobId}`, {method: 'DELETE'}, 30000); cancelled = true; }
  catch (error) { status.textContent = error.message; }
  finally { cancel.disabled = false; }
});
try { const existing = sessionStorage.getItem('sunodl-job'); if (existing) run(existing); } catch {}
