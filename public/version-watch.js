(() => {
  const badge = document.getElementById('app-version');
  if (!badge) return;

  let currentVersion = null;
  let requestInFlight = false;

  async function fetchVersion() {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const response = await fetch(`/VERSION?check=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`VERSION request failed (${response.status})`);

      const version = (await response.text()).trim();
      if (!version) throw new Error('VERSION file is empty');

      if (currentVersion && version !== currentVersion) {
        badge.textContent = `UPDATE AVAILABLE · v${version}`;
        badge.title = 'A new version is live. Reload this page to update.';
        badge.setAttribute('aria-label', `Update available: version ${version}`);
      } else {
        currentVersion = version;
        badge.textContent = `VERSION ${version}`;
        badge.title = 'Checking for updates every second.';
        badge.setAttribute('aria-label', `Version ${version}`);
      }
    } catch {
      if (!currentVersion) badge.textContent = 'VERSION UNAVAILABLE';
    } finally {
      requestInFlight = false;
    }
  }

  fetchVersion();
  window.setInterval(fetchVersion, 1000);
})();
