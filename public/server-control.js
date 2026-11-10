const serverStatus = document.querySelector('#server-status');
const serverStatusLabel = document.querySelector('#server-status-label');
const serverToggle = document.querySelector('#server-toggle');
const serverToggleLabel = document.querySelector('#server-toggle-label');
let currentServerState = 'checking';
let changingServerState = false;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function renderServerState(state, message) {
  currentServerState = state;
  serverStatus.dataset.state = state.toLowerCase();
  serverStatusLabel.textContent = message || ({
    running: 'AZURE · ONLINE',
    stopped: 'AZURE · PAUSED',
    starting: 'AZURE · STARTING',
    stopping: 'AZURE · PAUSING',
    progressing: 'AZURE · CHANGING',
    unavailable: 'AZURE · STATUS UNAVAILABLE',
    checking: 'CHECKING AZURE'
  })[state] || 'AZURE · UPDATING';

  const stable = state === 'running' || state === 'stopped';
  serverToggle.disabled = !stable || changingServerState;
  serverToggle.setAttribute('aria-pressed', String(state === 'running'));
  serverToggle.setAttribute('aria-label', state === 'running' ? 'Pause Azure server' : 'Start Azure server');
  serverToggleLabel.textContent = state === 'running' ? 'Pause server' : state === 'stopped' ? 'Start server' : 'Please wait…';
}

async function readServerState() {
  const response = await fetch('/api/server', {cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(30000)});
  let data;
  try { data = await response.json(); } catch { throw Error('The server monitor could not respond.'); }
  if (!response.ok) throw Error(data.error || 'The server status could not be read.');
  return String(data.status || '').toLowerCase();
}

async function refreshServerState() {
  if (changingServerState) return;
  try {
    const state = await readServerState();
    renderServerState(state);
  } catch {
    renderServerState('unavailable');
    serverToggle.disabled = true;
  }
}

serverToggle.addEventListener('click', async () => {
  const action = currentServerState === 'running' ? 'stop' : currentServerState === 'stopped' ? 'start' : null;
  if (!action || changingServerState) return;
  if (action === 'stop' && !window.confirm('Pause the Azure server? Any export in progress will be interrupted. The Cloudflare page will stay online.')) return;

  changingServerState = true;
  renderServerState(action === 'stop' ? 'stopping' : 'starting');
  try {
    const response = await fetch('/api/server', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action}),
      signal: AbortSignal.timeout(60000)
    });
    let data;
    try { data = await response.json(); } catch { throw Error('Azure did not confirm the server change.'); }
    if (!response.ok) throw Error(data.error || 'Azure could not change the server state.');

    const desired = action === 'stop' ? 'stopped' : 'running';
    for (let attempt = 0; attempt < 48; attempt++) {
      await pause(2500);
      const state = await readServerState();
      renderServerState(state);
      if (state === desired) return;
      if (!['starting', 'stopping', 'progressing', 'running', 'stopped'].includes(state)) break;
    }
    throw Error(action === 'stop' ? 'Azure accepted the pause, but it is still changing state.' : 'Azure accepted the start, but it is still changing state.');
  } catch (error) {
    const message = error.name === 'TimeoutError' || /signal timed out/i.test(error.message)
      ? 'Azure is taking longer than usual to respond.'
      : error.message || 'AZURE · CONTROL ERROR';
    renderServerState('unavailable', message);
  } finally {
    changingServerState = false;
    if (currentServerState === 'unavailable') await refreshServerState();
    else renderServerState(currentServerState);
  }
});

refreshServerState();
setInterval(refreshServerState, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshServerState(); });
