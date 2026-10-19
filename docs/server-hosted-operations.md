# Hosted Encore operator guide

This is an initial MP3/LRC implementation. Complete the manual acceptance gates in [implementation status](server-hosted-implementation.md) before describing an installation as supported. The current display is **acknowledgment-only**: expiry never proves that a lost device stopped audible output.

## Installation and LAN HTTPS

Use one server process and a local persistent filesystem for SQLite. Do not run multiple Encore processes against the same data volume or use a network filesystem for the database. Node.js 24 is the deployment target; the repository's `.nvmrc` selects it. The runtime uses Node's built-in SQLite driver, Express, Socket.IO, and QRCode. The server image does not need Electron or FFmpeg for the first MP3 format.

1. Copy `deploy/.env.example` to `deploy/.env`. Set `LIBRARY_DIR` to an absolute host path, `KARAOKE_HOST` to a local DNS hostname (for example `karaoke.home.arpa`), and `PUBLIC_BASE_URL` to the corresponding exact HTTPS origin.
2. Configure your router/local DNS resolver to map that hostname to the server's fixed LAN address. Every phone and display must use that resolver. A hosts-file entry on the server alone does not provision phone DNS. Disable conflicting encrypted/private DNS on test clients or configure it to resolve the local zone.
3. Create `deploy/secrets/` with mode 0700. Generate separate random admin and host secrets (for example `openssl rand -hex 32`), store them in `admin_key` and `host_key`, and set the secret files to mode 0444 for the non-root container. The enclosing 0700 directory restricts host access to the operator; Docker Compose file-backed secrets preserve host file ownership, so mode 0600 files owned by another host UID cannot be read by the container’s `node` user. Do not mount the secrets into any other service. Never use the default desktop PIN. Do not put secrets in `PUBLIC_BASE_URL`.
4. From `deploy/`, run `docker compose up --build -d`. The example keeps Encore off host ports; Caddy terminates HTTPS. `/library` is read-only; `/data` persists database/settings; `/cache` is reserved for later generated media. No recordings are currently made. Compose bounds memory, CPU, temporary storage, and process count; use host filesystem quotas for `/data`, `/cache`, backups, and Caddy volumes.
5. The example uses Caddy's internal CA for LAN-only operation. Export its **public root certificate** with `docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./encore-root.crt`. Verify the certificate fingerprint over a trusted channel before distributing it. Install this CA in each display/phone trust store. On iOS, install the profile and explicitly enable full trust for that CA. On Android, install it as a user CA; confirm the intended browser trusts it. Desktop Firefox may require a separate certificate import. Keep the CA private key in Caddy's protected persistent data volume; never distribute it.
6. Open the configured hostname on fresh display and phone profiles. There must be no certificate warning. Do not bypass a browser TLS warning. Caddy renews leaf certificates automatically; retain its `/data` volume so renewal uses the same trusted CA. Monitor certificate expiry and plan CA replacement by provisioning the new root to clients before removing the old one. See [Caddy internal TLS](https://caddyserver.com/docs/caddyfile/directives/tls) and [automatic HTTPS](https://caddyserver.com/docs/automatic-https).
7. With DNS/TLS already provisioned, disable WAN access and test fresh profiles with empty caches: display and three phones must load, join by QR/manual code, search, queue, and play MP3/LRC. No required resource should use an external origin. Caddy internal issuance and renewal work locally. Download/build images and dependencies before disconnecting WAN.

For publicly issued TLS, remove `tls internal`, use a domain you control, and configure DNS and ACME reachability or a DNS challenge provider. Keep `PUBLIC_BASE_URL` aligned with the actual origin. Do not expose Encore's internal HTTP port publicly. Remote phone audio/TURN is not supported by this release.

## Roles and first session

A locally provisioned admin credential signs in with server-administration rights. The separate host credential can create rooms and manage rooms owned by that credential’s host identity, including after a fresh login. Different host identities cannot control each other’s rooms. Guests need a current invitation; display pairing grants are single-use and expire in 15 minutes. Guest invitations and manual codes last 15 minutes and can admit multiple devices until refreshed. Refresh revokes previous codes. Invitations use fragments and are erased from history before connecting; avoid logging client-side secrets or copying invitation URLs into public channels.

Sessions use HttpOnly, SameSite=Strict cookies, Secure on HTTPS, with CSRF and exact Origin checks. Sessions expire after seven days and survive an ordinary restart. A socket connection ID does not define device identity. Joining again creates a fresh session, so room-wide limits also apply. Revoking a device disconnects its sockets and invalidates its cookie. Signing out a display requires a stopped-output release first; the display must not simply be replaced if that release fails.

Login and invitation exchange are throttled per client IP. Direct installations ignore forwarding headers. Behind a reverse proxy, set `TRUSTED_PROXIES` to only its addresses (comma-separated IPs or narrowly scoped CIDRs), keep the backend port private, and ensure the proxy overwrites or appends the actual connecting client address in `X-Forwarded-For`. The supplied Compose network gives Caddy a fixed address and trusts only that address. If its subnet overlaps an existing network, change `ENCORE_NETWORK_SUBNET` and `ENCORE_PROXY_IP` together in `deploy/.env`. Do not trust every proxy or use a hop count when alternate paths can reach the backend. See [Express proxy trust](https://expressjs.com/en/guide/behind-proxies.html).

The default queue allows 100 outstanding room reservations and five per guest session. Hosts count toward room capacity. New enqueue attempts are limited to five/device and 20/room per rolling ten seconds, including failed attempts. All fresh commands also share a persistent budget of 20/device and 100/server per rolling ten seconds across HTTP and Socket.IO. Requests beyond that budget return 429 without adding database records. Hosts can change guest allowance and guest control policy; admins can change room capacity. Reducing limits preserves existing reservations. Accepted command IDs are deduplicated for 24 hours, including across ordinary restarts; admitted rejections are cached for one minute to bound rejected-command storage. Cached retries bypass fresh-command admission. Fresh IDs and expired retry records incur fresh admission checks. Do not blindly retry overload errors. API rate limits use HTTP 429 and `Retry-After`.

The server preserves a loading reservation until the active display confirms `playing`. Duplicate ends and stale generation/playback IDs cannot advance the queue. Every browser start and ordinary restart leaves playback paused until the host resumes. A brief server disconnect pauses browser playback; the gate remains closed until revalidation. Hidden/backgrounded displays retire their generation. Keep the display foreground, disable sleep for a session, and use a wired HDMI output during validation.

## Replacing or recovering a display

For a reachable display, select **Release display**. It closes its only audio-output route, pauses/unloads media, suspends its audio context, drains the reported output buffering, permanently retires the generation, then acknowledges stopped output. Only then pair/start the replacement and explicitly resume. A host requesting another display while one remains outstanding gets `display_release_pending`; the old display is asked to release. Retry pairing/start after that acknowledgment. Delayed commands cannot reactivate a retired generation.

For a closed/crashed/unreachable display, **waiting is insufficient**, even after server restart. An administrator must:

1. Identify the outstanding device and exact generation shown under **Server administration → Physically retire a lost display**.
2. Power that device off or physically disconnect its audio output. A disconnect icon, timeout, remote mute command, paused UI, or expired lease is insufficient.
3. Keep that output isolated. Terminate the old browser instance and clear its Encore pairing/cookies before reconnecting it.
4. Sign in with a fresh admin session, check the physical-isolation and termination/pairing confirmations, identify the exact generation, and confirm retirement. After any restore, isolate **every possibly outstanding device**, including devices paired after the snapshot, and confirm that separately. If isolation cannot be confirmed, leave takeover pending.
5. Retirement is recorded with administrator identity, time, and confirmations. The old display pairing/session is revoked. The queue is preserved and playback remains paused. Pair a fresh display and have the host explicitly resume. A retired device needs fresh pairing before reuse.

An admin browser that itself held the retired display is also revoked; sign in again before pairing. If a browser reload loses its in-memory release token, use this physical procedure. Tokens are deliberately not saved to local/session storage where duplicated tabs could incorrectly acknowledge another still-playing tab. A connected old instance can retry an unsent release when connectivity returns. The narrowly scoped `POST /display-release/:roomId` bearer secret can retire only its recorded generation after restore; it cannot restore authentication, renew, pair, read media, or control rooms. A successful old release does not waive restore's all-device isolation requirement.

The browser schedules a conservative AudioParam cutoff and a main-thread fallback, but that does not establish safety across suspension, stopped audio clocks, device changes, arbitrary hardware buffering, or browser bugs. Deadline-based takeover is disabled. Validate every output path before ever enabling such a mode. No phone inputs, MIDI/SFX, or video output bypasses this hosted player's single MP3 output gate because those paths are currently disabled.

## Backup, restore, and upgrades

Keep the original library separately backed up. The database contains library IDs/relative references, room queues/policies, credentials for active sessions, invitation hashes, settings, and audit records. The admin/host deployment secrets and Caddy CA keys are intentionally outside it; protect and back up deployment secrets separately. `/cache` contains no required source data and can be rebuilt. Treat snapshots as credentials: access-restrict and encrypt offline copies. SQLite settings and schema version are captured in the same consistent snapshot.

Local installation:

```sh
# Online backup to a NEW directory; never copy a live SQLite file/WAL by hand.
DATA_DIR=/srv/encore/data npm run backup:server -- /srv/backups/encore-before-upgrade
# Stop the original server, and physically isolate every possibly outstanding display.
DATA_DIR=/srv/encore/data npm run restore:server -- /srv/backups/encore-before-upgrade
```

Containers (run from `deploy/`; use a new backup destination each time):

```sh
docker compose exec encore node dist/server/operations.js backup /data/backups/before-upgrade
docker compose cp encore:/data/backups/before-upgrade ./before-upgrade
# Stop the ORIGINAL server and isolate all display outputs before restoring.
docker compose stop encore
docker compose run --rm -v "$PWD/before-upgrade:/backup:ro" encore node dist/server/operations.js restore /backup
docker compose up -d encore
```

Use a unique backup folder per operation. The backup utility uses SQLite [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html), checks integrity/schema and records a checksum, application version, and timestamp. It flushes the completed snapshot and metadata before success. A failed backup directory is not recoverable until the utility completes; do not reuse that directory. Verify a backup by restoring it into an isolated disposable data volume with the compatible application version, confirm host login via the provisioned secret, compare library counts, queue, and policies, and leave displays physically isolated during the drill.

Restore refuses to run while the original server holds the data volume’s separate SQLite singleton lock. The kernel releases this lock on process termination; it works across container PID namespaces. Never bypass the lock or restore a copied backup while the original server remains running elsewhere. Restore verifies integrity/checksum/schema, saves a new pre-restore backup if a database exists, prepares the replacement file, durably persists a **fresh authentication epoch**, deletes all restored sessions/invitations/pending pairing grants/command retries, marks all rooms paused and requiring physical recovery, checkpoints the old WAL, and atomically replaces the database. Each server boot creates a fresh deployment epoch so generation values cannot collide. Ordinary restarts preserve authentication epochs; restores and migration rollbacks never do.

After restore, all previous cookies, revoked or valid, QR links, manual codes, and display pairing grants are invalid for HTTP and Socket.IO. Sign in freshly using the provisioned recovery/admin credential, physically retire all possibly outstanding display outputs as above, issue fresh display/guest invitations, and explicitly resume. The replacement stays blocked until manual recovery is confirmed. This conservative acknowledgment-only policy covers grants newer than the backup and wall-clock jumps without depending on a deadline wait.

Before any future schema migration, create and verify a backup, record the image/commit/version, and stop the original server. The current schema is version 2. The version-1 to version-2 migration adds expiry/search indexes, automatically saves a verified snapshot under `/data/backups/` before changing the schema, and applies the upgrade transactionally. Schemas newer than version 2 are rejected. Initial schema creation is transactional. Restore accepts version-1 or version-2 snapshots and startup upgrades version 1 after saving its own backup; rollback can archive an unknown newer target schema before replacing it with a supported snapshot. If an upgrade/migration fails or is interrupted, stop the new server, use the previous compatible application image/version to run the restore utility against the verified snapshot, and follow the full authentication/physical-recovery procedure. Never reopen a restored file directly without running restore, including during rollback. Preserve the original backup. Automated tests cover successful upgrades, SQL failure, process kill before commit, rollback from an unknown newer schema, and backup preservation. Container-volume upgrade/interruption drills remain a release gate.

`/healthz` reports process health; `/readyz` checks SQLite and shows the indexing state. Library scans preserve the prior index on failure. Watch readiness/library status and disk usage; the process does not currently refuse readiness when the operator starts with a missing library. Keep library mounts read-only while serving to prevent filesystem races. The service logs no invitations, credentials, media paths, or request URLs by default.
