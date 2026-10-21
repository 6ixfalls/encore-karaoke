# Stateless server operations

Encore needs one Node.js server process with no durable application data or database. All rooms, pairing codes, participants, queues, current playback, recent scores, command retries and rate limits exist only in memory. A restart ends all rooms; visitors launch karaoke again and phones join the new code. Running multiple independent replicas requires routing each room and its requests to the same process.

## Start with Docker

1. Copy `deploy/.env.example` to `deploy/.env` and configure `PUBLIC_BASE_URL` and `KARAOKE_HOST` with your trusted HTTPS hostname.
2. From `deploy/`, run `docker compose up --build -d`.
3. Open the main screen and click **Launch karaoke**. Its click enables browser audio, creates a room and shows a stable six-digit code and QR.
4. On phones, choose **Control** and enter the code, or scan the QR to join automatically. No account, password, admin credential or YouTube API key is required.

The application container runs with a read-only filesystem, RAM-backed `/tmp` for processing scratch, and a disk-backed `encore-media` scratch volume at `/var/cache/encore-media`. yt-dlp searches and resolves remote media with its disk cache disabled. FFmpeg and Demucs process bounded streams; instrumental fragments are retained in a private temporary file until playback is retired. Model weights are installed at image build time. NVIDIA deployment options remain in `compose.gpu.yaml`.

Prepared videos are capped at 1 GiB per job. Keep at least that much free host disk space plus headroom. `separation_storage_full` means the media filesystem has exhausted space or quota; rebuilding and recreating the container with the updated Compose file moves prepared media out of `/tmp`. For custom deployments, mount writable disk storage owned by the image's `node` user at `/var/cache/encore-media`, or set `SEPARATION_STORAGE_DIR` to a dedicated writable directory. Local Node runs use OS temp unless this variable is set. Each configured directory must belong to one server process: startup deletes its `encore-media-*` subdirectories to reclaim crash leftovers. This scratch volume contains no recoverable rooms or scores.

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

## Kubernetes media permissions

Use [the Kubernetes example](../deploy/kubernetes.yaml) or merge its pod security context, volumes and volume mounts into your existing workload. Media stays at `/var/cache/encore-media`. Mount a disk-backed `emptyDir` there (omit `medium: Memory`), and set pod `runAsUser`, `runAsGroup` and `fsGroup` to `1000`. Keep `readOnlyRootFilesystem: true`. A separate writable `/tmp` is needed for Python/FFmpeg scratch. The media mount needs at least 1 GiB per active job plus headroom. The example reserves 4 GiB for media.

`separation_storage_unwritable` means `EACCES`, `EPERM` or `EROFS`. Image-layer ownership does not make an unmounted path writable on a read-only root filesystem, and a mounted volume hides the image directory’s ownership. For CSI-backed volumes, check that the driver honors `fsGroup`; otherwise configure ownership through that driver’s supported mechanism. Do not make the application run as root. The server probes an explicitly configured media directory before accepting traffic and logs the failing path, OS error, uid/gid and mount guidance. Full volumes remain a separate `separation_storage_full` error.

To inspect an existing pod, replace the namespace and pod name:

```sh
kubectl -n YOUR_NAMESPACE exec YOUR_POD -- id
kubectl -n YOUR_NAMESPACE exec YOUR_POD -- ls -ld /var/cache/encore-media
kubectl -n YOUR_NAMESPACE get pod YOUR_POD -o yaml
```

Changing a deployment’s pod security context or volume mounts requires recreating its pods. Rooms and queues end on restart; downloaded recordings remain on the client. No cluster changes are performed by the build.
