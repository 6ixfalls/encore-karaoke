# Stateless server operations

Encore needs one Node.js server process with no persistent application volume or database. All rooms, pairing codes, participants, queues, current playback, recent scores, command retries and rate limits exist only in memory. A restart ends all rooms; visitors launch karaoke again and phones join the new code. Running multiple independent replicas requires routing each room and its requests to the same process.

## Start with Docker

1. Copy `deploy/.env.example` to `deploy/.env` and configure `PUBLIC_BASE_URL` and `KARAOKE_HOST` with your trusted HTTPS hostname.
2. From `deploy/`, run `docker compose up --build -d`.
3. Open the main screen and click **Launch karaoke**. Its click enables browser audio, creates a room and shows a stable six-digit code and QR.
4. On phones, choose **Control** and enter the code, or scan the QR to join automatically. No account, password, admin credential or YouTube API key is required.

The application container runs with a read-only filesystem and temporary `/tmp`. It mounts no library, data or media-cache volumes. yt-dlp searches and resolves remote media with its disk cache disabled. FFmpeg and Demucs process bounded streams; instrumental fragments are retained in a private temporary file until the playback is retired. Model weights are installed at image build time. NVIDIA deployment options remain in `compose.gpu.yaml`.

Caddy's `caddy-data` and `caddy-config` volumes belong to the HTTPS proxy. Protect its CA private key. For Caddy's local CA, export its public root certificate with `docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./encore-root.crt` and install/trust it on the main screen and phones. Configure DNS to resolve the hostname to your server. Do not distribute the private CA key.

## Rooms and playback

Each room has one main screen: the tab that launched karaoke. Joined phones can queue, cheer, control permitted playback actions and enable direct WebRTC microphones. They cannot become displays. There is no display invitation, takeover, physical retirement or administrator recovery flow.

Temporary participant tokens distinguish tabs and scope HTTP/Socket.IO access to a room. Tokens are held in browser session storage and server memory, not cookies or a persistent account database. Mutations require the configured Origin. The main screen can remove a participant or end the room. Locking blocks new joins. End room invalidates participant access and the code.

Keep the main screen tab foreground. Its audio gate closes on disconnect or a missed heartbeat. Start karaoke on the same screen to continue after stopping; competing starts cannot interrupt its current output. If the main screen is lost, launch a fresh room. If the server restarts, reload the main screen and join the new code. There are no backups, schema upgrades or restore commands.

Rooms expire after 24 hours without main-screen heartbeats; active heartbeats extend the code and main-screen lifetime. Expired rooms, participants, codes and retry records are removed from memory. Recent cheers and scores are bounded. Queue and request limits remain in effect during the process lifetime; they reset on restart.

## Media and recordings

Search and playback require internet access to YouTube. Install dependencies before running the local Node server, or use the provided image. Live separation allows one job per server, limits tracks to ten minutes and starts with a sixteen-second scoring buffer; seeking while processing is limited to buffered media, with full byte ranges available when complete. Cancellation, room end, stale playback, stalled processing and shutdown terminate jobs.

Microphone capture needs browser permission and a trusted HTTPS origin (localhost is allowed for development). Phone audio uses direct WebRTC without a TURN relay; typically devices need to share a LAN. Recordings remain in browser memory until downloaded and are never uploaded to the server. Download them before closing or reloading the page.

Check `/healthz` and `/readyz` for liveness/readiness. Run `npm run build` and `npm test` before deployment. Browser/device audio, microphone, recording and GPU behavior still require manual validation.
