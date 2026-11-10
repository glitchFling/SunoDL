# SunoDL

Node.js 22+ required.

```bash
npm install
npx playwright install chromium
npm start
```

Open http://localhost:3000.

The server binds to IPv4 loopback (`127.0.0.1`) and accepts one export or ZIP download at a time; overlapping requests receive HTTP 429. ZIP64 archives are limited to 5 GB compressed, 2,000 entries, 256 MiB per file, and 5 GB expanded data. The browser fallback streams the source ZIP and processes one file at a time.

The automation loads a playlist, selects its tracks, opens ZIP export, chooses a format, and continues through the source site's informational download notice. It reads the source's actual progress and errors while the export runs. Third-party UI and network behavior may change. Use only for content you have permission to download.

Exports use background jobs: `POST /api/jobs` starts a job, `GET /api/jobs/:id` returns its status, `DELETE /api/jobs/:id` cancels it, and `GET /api/jobs/:id/download` retrieves the finished ZIP. The frontend polls short requests rather than waiting for one long HTTP request. Exports have a two-hour overall deadline. Keep the tab open while preparing an export; jobs and files are temporary and do not survive a container restart. Finished exports expire after 30 minutes, and prior archives are removed when a new export starts. Run a single replica because job state is held in that process.

Build the Azure-ready container with `docker build -t sunodlc .`. It installs Chromium and its Linux dependencies and listens on port 3000. Local runs default to loopback; `HOST` and `PORT` override the address. Set `APP_PASSWORD` to require HTTP Basic authentication (username `sunodlc`); use HTTPS for hosted access. `/healthz` remains available for health probes. The deployment script builds privately, stores a generated password as an Azure secret, and enables HTTPS ingress after applying it. Credentials are saved to the ignored local file `deployment-credentials.txt`.

Failed and expired ZIP data is removed automatically. Audio files are numbered in playlist order, with the number added to each filename and Title tag. The playlist name is written to each supported audio file's Album tag, and its Track tag records the number and playlist length. Matching cover art is embedded in MP3, MP4/M4A, FLAC and WAV audio metadata and then verified by reading the picture bytes back. FFmpeg copies audio packets when writing metadata, without audio re-encoding; WAV uses an ID3 RIFF chunk (player support for WAV artwork varies). Duplicate track titles are matched using the source's unique export filenames. Available playlist artwork is also included as `cover.jpg` (or its PNG/WebP extension), with individual track covers under `Artwork/`. Covers are fetched from approved Suno CDN hosts alongside audio preparation; unavailable images or unverified embeddings are reported as a warning. The ZIP excludes promotional URL text files, removes `usesuno.com` from names, and excludes lyric-named files unless opted in. Embedded lyrics inside audio metadata are retained. Hosted access should use `APP_PASSWORD` and HTTPS.

Finished ZIPs are named from the sanitized playlist title and streamed directly to the browser's download manager, with normal HTTP range support. The frontend does not fetch the whole archive into a Blob first. ZIP packaging uses STORE because the audio and image files are already compressed. Original format fetches each M4A-Opus track directly from Suno's media CDN when those public assets are available, with the existing browser-based exporter as a fallback; MP3 and WAV continue through the source conversion flow.

## Cloudflare Pages frontend

The static `public/` site can run on Cloudflare Pages while the API and export
worker stay on Azure Container Apps. The Pages Function in `functions/api/`
streams `/api/*` requests to Azure, so large ZIP downloads do not need to be
buffered in the browser. The root Pages middleware protects the static site and
API proxy with the same HTTP Basic password used by Azure.

The Cloudflare Pages server switch uses a separate Pages Function to read the
Azure Container App state and call its start/stop operations. It remains
available while the Azure app is stopped. Its Azure service principal has a
custom role scoped to this app with only read, start, and stop permissions.
Cloudflare stores the identity credentials as encrypted Pages secrets.

Deploy from this directory with Wrangler. Create the Pages project named
`sunodl`, set the `APP_PASSWORD` Pages secret to the value in
`deployment-credentials.txt`, then deploy `public/` with the Functions folder
present in the project root. Keep Azure's `APP_PASSWORD` secret set to the same
value. Pages will provide a `sunodl.pages.dev` hostname, so no custom domain is
required.
