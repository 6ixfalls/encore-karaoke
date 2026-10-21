# Encore Karaoke

Self-hosted karaoke with a browser display and EnMoku phone controllers. The server runs without Electron, a desktop environment, an audio device, or external relay services. Rooms, queues, participants and playback coordination live only in memory; the main screen browser owns playback. Restarting the server ends every room and invalidates its code.

The hosted path supports **YouTube Music search and metadata through yt-dlp, seekable instrumental playback, timed lyrics, shared queues, microphone scoring, and local performance recording**. There is one main karaoke screen per room; phones join as controllers using its code or QR. There are no accounts, administrator logins, display invitations, disk song libraries, databases, migrations, or backup/restore operations. See [hosted media features](docs/hosted-media.md).

## Run locally

To build and start the full container from the current working tree, with yt-dlp, FFmpeg, Python dependencies and model weights included:

```sh
npm run start:container
```

Requires a running Docker daemon with Compose. The command rebuilds the image, replaces the local container when needed, and stays attached in the foreground, streaming its logs. Keep the terminal open while using the app, then press Ctrl+C to stop it. Once the server is ready, open [localhost:3000](http://localhost:3000). It listens on loopback only, using CPU separation and a Docker volume for temporary media. The first build downloads dependencies and model weights; later builds reuse cached layers. Run `npm run stop:container` to stop and remove the local container. Stop any existing server on port 3000 before starting the container.

Use Node.js 24 LTS. Install yt-dlp, FFmpeg and the Python dependencies in `server/separation-requirements.txt` for playback, or use the provided container with dependencies and model weights included.

```sh
npm ci
npm run build
export PUBLIC_BASE_URL=http://localhost:3000
npm start
```

Open [localhost:3000](http://localhost:3000). The dashboard has two choices: **Launch karaoke** opens a TV appliance with its own private room; **Control** joins using that TV's six-digit code. No account, host credential, or administrator panel is required. Clicking **Launch karaoke** enables browser audio and starts the TV immediately; scan its QR on your phone to connect. Scanning opens `/control` and joins the correct room automatically. The code remains stable until **End room**. Phones can queue songs, control playback and enable a microphone with browser permission. Rooms have separate queues, playback, pairing grants and owners. Inactive public rooms expire after 24 hours; active TVs renew that lifetime.

The TV presentation reuses the desktop's standby, player, QR, menu and queue styles. Core assets are served locally. Each tab receives a temporary participant token stored in browser session storage so the main screen and controllers remain separate, even on the same device. This is room membership, with no account or password. Only the room's original main screen can start playback; there is no display handoff. A heartbeat pauses output on disconnect. Reloading the main tab preserves its room while this server process is running; after a missed heartbeat, the screen reconnects automatically. If the browser requires audio activation after a reload, any click or keypress unlocks it.

The application keeps no durable room data. Rooms, codes, participant tokens, scores, retry records and rate limits disappear on restart. Media is processed through bounded streams, with prepared videos held in temporary disk storage for seeking. Compose provides a disk-backed `encore-media` scratch volume so long songs do not fill the RAM-backed `/tmp`. Playback retirement deletes its files, and startup clears abandoned media from the dedicated storage directory. yt-dlp disk caching is disabled. Model weights are installed in the container image. Recordings stay in browser memory until downloaded. The optional Caddy proxy retains its own certificate/CA data separately.

For phones and other computers, configure a trusted HTTPS hostname and `PUBLIC_BASE_URL`; a LAN IP served over HTTP is rejected. Follow the [operator guide](docs/server-hosted-operations.md) for Docker and local DNS/TLS.

## Configuration

| Variable                        | Default / purpose                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`               | `http://localhost:3000`; exact origin used for invitations, Origin checks, and Socket.IO |
| `YT_DLP_PATH` | yt-dlp executable (default `yt-dlp`); structured search and signed stream extraction |
| `FFMPEG_PATH` | FFmpeg executable (default `ffmpeg`); live decoding and video/instrumental muxing |
| `SEPARATION_PYTHON` | Python environment with `server/separation-requirements.txt` installed (default `python3`) |
| `SEPARATION_DEVICE` | `cpu` by default; `cuda` or `cuda:N` for NVIDIA inference; `mps` follows Nightingale's CPU fallback |
| `SEPARATION_STORAGE_DIR` | Dedicated writable media scratch directory; defaults to OS temp locally, `/var/cache/encore-media` in the image. Use disk storage with at least 1 GiB free plus headroom; one server process per directory. Startup removes `encore-media-*` subdirectories. |
| `FFMPEG_VIDEO_MODE` | `copy` by default (no video transcoding); `nvidia` enables CUDA video decoding and H.264 NVENC encoding |
| `FFMPEG_GPU` | NVIDIA video device index (default `0`), independent of the Demucs device |
| `WEB_DIR`                       | `./dist/web`; compiled browser assets                                                    |
| `PORT` / `LISTEN_HOST`          | `3000` / `0.0.0.0`; bind loopback when testing without a proxy                           |
| `TRUSTED_PROXIES`               | Empty by default; comma-separated trusted reverse-proxy IPs or CIDRs; Compose trusts only its Caddy address |

The web server exposes no filesystem browser, arbitrary file API, native IPC bridge, or legacy relay. It serves only the built hosted frontend and room-scoped yt-dlp media. Core fonts, scripts, icons, and QR generation are local. YouTube search and stream URL extraction use server-side yt-dlp. A bounded worker separates vocals with the maintained adefossez/demucs fork and muxes original video with the instrumental for native playback. Prepared instrumentals are temporary files supporting byte-range seeks and are deleted when the song or room is retired. The display uses native video with Web Audio for scoring and mixed recording. Desktop presentation styles are shared with the hosted TV; native renderer services remain excluded from the hosted runtime.

## Development and checks

The Container GitHub Actions workflow runs the build, lint, and tests before building separate Linux AMD64 CPU and NVIDIA GPU images with `deploy/Dockerfile`. The CPU variant uses the PyTorch CPU index; the GPU variant uses CUDA 12.8 (`cu128`). Branch pushes and same-repository pull requests publish to `ghcr.io/6ixfalls/encore-karaoke` with `sha-<commit>-cpu` / `sha-<commit>-gpu`, `<branch>-cpu` / `<branch>-gpu`, and `pr-<number>-cpu` / `pr-<number>-gpu` tags as applicable. The default branch also updates `latest-cpu` and `latest-gpu`. Existing unsuffixed tags, including `latest`, remain aliases for the CPU variant. Each variant has a separate build cache. Fork pull requests build both variants without publishing. Published images include provenance and an SBOM. The workflow uses `GITHUB_TOKEN` with package write permission and creates no version tags, changelogs, or GitHub releases.

`npm run build` type-checks and compiles the server, then builds the browser assets. `npm start` runs the compiled server; build first after changing server sources. `npm run build:server` compiles only the server and shared contracts. Development mode watches server sources with `tsx`; `npm test` recompiles the server before testing the production output.

```sh
npm run build
npm run test:types
npm test
# Verify Python dependencies and model preload on Linux AMD64:
npm run test:container
# Rebuild browser edits with npm run build; watch TypeScript server edits:
npm run dev
```

Tests cover in-memory reset and expiry, one-main-screen ownership, code/QR joining, three concurrent Socket.IO controllers, reservation/rate limits, command retry deduplication, playback fencing, Origin checks, yt-dlp extraction and live separation. Physical audio timing, phone compatibility and low-end performance still need device testing.

`npm run test:container` requires a running Docker daemon and a Buildx builder with Linux AMD64 support (a native worker or emulation). It builds the complete production image for the CI platform, including Python packages and the Demucs model preload, without publishing images. GitHub Actions builds and publishes only Linux AMD64 images. Run this check after changes to the Dockerfile or Python dependencies; `npm test` alone does not check container dependencies.

## Project layout

- `server/`: strict TypeScript HTTP/Socket.IO service, ephemeral participants, rooms and streamed media; compiles to `dist/server/`.
- `shared/`: TypeScript protocol version, command allowlist, validation, and defaults; compiles to `dist/shared/`.
- `src/platform/`: explicit browser service adapter.
- `src/hosted/`: main screen, controller, browser audio output gate and scoring.
- `deploy/`: non-root container and Caddy/Compose LAN HTTPS example.
- `tests/server/`: room, transport, separation and browser-player tests.

Encore includes no song library. Use media you have permission to use. No ads, tracking, or external analytics are included. Original credits and asset licensing are retained in the source assets and repository history. Distributed under [GNU GPL-3.0-only](LICENSE.txt). Nightingale-derived scoring and retained MIT notices are documented in [third-party notices](THIRD_PARTY_NOTICES.md). The built app provides license, credits and corresponding source downloads.
