# Encore Karaoke

Self-hosted karaoke with a browser display and EnMoku phone controllers. The server runs without Electron, a desktop environment, an audio device, or external relay services. It owns rooms, library indexing, authorization, and queues; the display browser owns playback and lyric timing.

The hosted path supports **local audio/video, MIDI/KAR, companion LRC and CD+G, YouTube queueing/playback, shared cheers, display microphone scoring, and local performance recording**. The [overhaul draft](docs/server-hosted-overhaul-draft.md) describes the larger roadmap. [Implementation status and remaining release gates](docs/server-hosted-implementation.md) distinguish completed code from work still required before release. Native media codecs depend on the display browser. MIDI uses a portable synthesized fallback rather than the desktop soundfont engine. Local-file server conversion remains pending; YouTube audio is decoded and muxed for live vocal separation. Phone microphones use room-scoped WebRTC; device/network compatibility still requires validation. See [hosted media features](docs/hosted-media.md) for formats, Nightingale scoring, prepared vocal references, recording and YouTube setup.

## Run locally

Use Node.js 24 LTS (Node 22.15 or later has the required SQLite API).

```sh
npm ci
npm run build
mkdir -p library
# Place Artist - Song.mp3 and Artist - Song.lrc inside library/.
export PUBLIC_BASE_URL=http://localhost:3000
npm start
```

Open [localhost:3000](http://localhost:3000). The dashboard has two choices: **Launch karaoke** opens a TV appliance with its own private room; **Control** joins using that TV's six-digit code. No account, host credential, or administrator panel is required. Clicking **Launch karaoke** enables browser audio and starts the TV immediately; scan its QR on your phone to connect. Scanning opens `/control` and joins the correct room automatically. The code remains stable until **End room**. Phones can queue songs, control playback and enable a microphone with browser permission. Rooms have separate queues, playback, pairing grants and owners. Inactive public rooms expire after 24 hours; active TVs renew that lifetime.

The TV presentation reuses the desktop's standby, player, QR, menu and queue styles. Native-only desktop services and MIDI synthesis still differ. Core assets are local. Phone audio uses direct WebRTC and may require the phone and TV to be on the same network; no TURN relay is configured. Keep the TV tab visible. Use separate browser profiles/devices for TVs and phones: cookies identify a device session, not a tab.

The server currently uses SQLite for room/session coordination and library indexing; visitors do not provision storage or credentials. Recordings stay in the browser. Operators may use temporary storage if restart persistence is unnecessary. Optional administrator credentials protect maintenance APIs (library rescans and physical display recovery); these APIs have no user-facing admin panel.

For phones and other computers, configure a trusted HTTPS hostname and `PUBLIC_BASE_URL`; a LAN IP served over HTTP is rejected. Follow the [operator guide](docs/server-hosted-operations.md) for Docker, local DNS/TLS, backups, and lost-display recovery.

## Configuration

| Variable                        | Default / purpose                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`               | `http://localhost:3000`; exact origin used for invitations, Origin checks, and Socket.IO |
| `DATA_DIR`                      | `./data`; SQLite, server settings, room state, sessions, audit records                   |
| `LIBRARY_DIR`                   | `./library`; mount read-only; filenames supply artist/title; same-stem `.lrc` companions |
| `YT_DLP_PATH` | yt-dlp executable (default `yt-dlp`); structured search and signed stream extraction |
| `FFMPEG_PATH` | FFmpeg executable (default `ffmpeg`); live decoding and video/instrumental muxing |
| `SEPARATION_PYTHON` | Python environment with `server/separation-requirements.txt` installed (default `python3`) |
| `SEPARATION_DEVICE` | `cpu` by default; `cuda` or `cuda:N` for NVIDIA inference; `mps` follows Nightingale's CPU fallback |
| `FFMPEG_VIDEO_MODE` | `copy` by default (no video transcoding); `nvidia` enables CUDA video decoding and H.264 NVENC encoding |
| `FFMPEG_GPU` | NVIDIA video device index (default `0`), independent of the Demucs device |
| `WEB_DIR`                       | `./dist/web`; compiled browser assets                                                    |
| `PORT` / `LISTEN_HOST`          | `3000` / `0.0.0.0`; bind loopback when testing without a proxy                           |
| `TRUSTED_PROXIES`               | Empty by default; comma-separated trusted reverse-proxy IPs or CIDRs; Compose trusts only its Caddy address |

The web server exposes no filesystem browser, arbitrary file API, native IPC bridge, or legacy relay. It serves only the built hosted frontend and registered authorized media. Core fonts, scripts, icons, and QR generation are local. YouTube search and stream URL extraction use server-side yt-dlp. A bounded live worker separates vocals with the maintained adefossez/demucs fork and muxes original video with the instrumental for native playback. The display uses native video with Web Audio for scoring and mixed recording. Desktop presentation styles are shared with the hosted TV; native renderer services remain excluded from the hosted runtime.

## Development and checks

The Container GitHub Actions workflow runs the build, lint, and tests before building Linux AMD64 and ARM64 images with `deploy/Dockerfile`. Branch pushes and same-repository pull requests publish to `ghcr.io/6ixfalls/encore-karaoke` with `sha-<commit>`, branch, and `pr-<number>` tags as applicable; the default branch also updates `latest`. Fork pull requests build without publishing. Images include provenance and an SBOM. The workflow uses `GITHUB_TOKEN` with package write permission and creates no version tags, changelogs, or GitHub releases.

`npm run build` type-checks and compiles the server, then builds the browser assets. `npm start` and the backup/restore commands run the compiled server; build first after changing server sources. `npm run build:server` compiles only the server and shared contracts. Development mode watches server sources with `tsx`; `npm test` recompiles the server before testing the production output.

```sh
npm run build
npm run test:types
npm test
# Rebuild browser edits with npm run build; watch TypeScript server edits:
npm run dev
```

Tests cover room authority, three concurrent Socket.IO controllers, reservation/rate limits, retry deduplication, playback fencing, origin/CSRF checks, byte ranges, symlink rejection, backup integrity, restore invalidation, and physical retirement. Automated tests do not establish physical audio deadlines, phone compatibility, LAN-only operation, or low-end performance. See the status document for those manual gates.

## Project layout

- `server/`: strict TypeScript HTTP/Socket.IO service, auth, SQLite persistence, rooms, media, and operations; compiles to `dist/server/`.
- `shared/`: TypeScript protocol version, command allowlist, validation, and defaults; compiles to `dist/shared/`.
- `src/platform/`: explicit browser service adapter.
- `src/hosted/`: display, controller, browser audio output gate, and shared LRC parser.
- `deploy/`: non-root container and Caddy/Compose LAN HTTPS example.
- `tests/server/`: state, recovery, transport, and browser-player tests.

Encore includes no song library. Use media you have permission to use. No ads, tracking, or external analytics are included. Original credits and asset licensing are retained in the source assets and repository history. Distributed under [GNU GPL-3.0-only](LICENSE.txt). Nightingale-derived scoring and retained MIT notices are documented in [third-party notices](THIRD_PARTY_NOTICES.md). The built app provides license, credits and corresponding source downloads.
