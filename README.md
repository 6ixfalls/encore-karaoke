# Encore Karaoke

Self-hosted karaoke with a browser display and EnMoku phone controllers. The server runs without Electron, a desktop environment, an audio device, or external relay services. It owns rooms, library indexing, authorization, and queues; the display browser owns playback and lyric timing.

The implemented hosted path supports **MP3 with optional companion LRC**. The [overhaul draft](docs/server-hosted-overhaul-draft.md) describes the larger roadmap. [Implementation status and remaining release gates](docs/server-hosted-implementation.md) distinguish completed code from work still required before release. MIDI, CD+G, conversion, scoring, recording, and phone microphones are not enabled in this hosted build.

## Run locally

Use Node.js 24 LTS (Node 22.15 or later has the required SQLite API).

```sh
npm ci
npm run build
mkdir -p library
# Place Artist - Song.mp3 and Artist - Song.lrc inside library/.
# Provision a random credential of at least 24 characters. Keep it private.
export ADMIN_KEY_FILE=/absolute/path/to/admin-key
export PUBLIC_BASE_URL=http://localhost:3000
npm start
```

Open [localhost:3000](http://localhost:3000), sign in, create a room, select **Start karaoke on this display**, queue a song, and press **Play / resume**. A host can refresh a guest invitation to show its QR and manual code, or issue a single-use display pairing invitation. A new display must also select **Start karaoke** to unlock browser audio. Keep the display tab visible. Use separate browser profiles/devices for hosts, displays, and guests: cookies identify a device session, not a tab.

For phones and other computers, configure a trusted HTTPS hostname and `PUBLIC_BASE_URL`; a LAN IP served over HTTP is rejected. Follow the [operator guide](docs/server-hosted-operations.md) for Docker, local DNS/TLS, backups, and lost-display recovery.

## Configuration

| Variable                        | Default / purpose                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`               | `http://localhost:3000`; exact origin used for invitations, Origin checks, and Socket.IO |
| `ADMIN_KEY_FILE` or `ADMIN_KEY` | Required, at least 24 characters; provision outside the library and backups              |
| `HOST_KEY_FILE` or `HOST_KEY`   | Optional separate host credential, at least 24 characters                                |
| `DATA_DIR`                      | `./data`; SQLite, server settings, room state, sessions, audit records                   |
| `LIBRARY_DIR`                   | `./library`; mount read-only; filenames supply artist/title; same-stem `.lrc` companions |
| `WEB_DIR`                       | `./dist/web`; compiled browser assets                                                    |
| `PORT` / `LISTEN_HOST`          | `3000` / `0.0.0.0`; bind loopback when testing without a proxy                           |
| `TRUSTED_PROXIES`               | Empty by default; comma-separated trusted reverse-proxy IPs or CIDRs; Compose trusts only its Caddy address |

The web server exposes no filesystem browser, arbitrary file API, native IPC bridge, or legacy relay. It serves only the built hosted frontend and registered authorized media. Required fonts, scripts, icons, and QR generation are local. The old renderer modules remain as reference material for later playback parity; they are excluded from the hosted build and runtime.

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

Encore includes no song library. Use media you have permission to use. No ads, tracking, or external analytics are included. Original credits and asset licensing are retained in the source assets and repository history. Licensed under [MIT](LICENSE.txt).
