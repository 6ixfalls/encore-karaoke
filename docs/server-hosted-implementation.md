# Server-hosted implementation status

Implementation: October 18, 2026. This checkout replaces the Electron entrypoint and packaging workflow with a standalone Node/Express/Socket.IO server. `npm run build` compiles the hosted frontend; `npm start` runs the headless service. The original renderer modules remain available as reference for later playback work, but are neither built nor served. The [architecture draft](server-hosted-overhaul-draft.md) remains the broader delivery plan; this document records the implemented MP3/LRC slice and outstanding gates rather than declaring the entire roadmap complete.

## Implemented

| Area | Available behavior |
| --- | --- |
| Server and build | No Electron/native runtime dependency; Node 24 container target; three production packages; independent browser build with local scripts/fonts/icons/QR generation; default build/start and CI use the headless path |
| Authentication | Provisioned admin and host credentials; durable revocable device sessions; Secure/HttpOnly/SameSite cookies; exact Origin and CSRF checks; persistent authentication epochs; role/capability checks on HTTP and Socket.IO |
| Rooms | Room creation, lock/end, expiring and rotatable guest QR/manual invitation exchange, single-use display pairing, device revocation, snapshots/reconnect, credential-based host ownership, multiple rooms with isolated authority |
| Queue | SQLite serialization and transactions; configurable guest/room reservation caps; rolling device/room enqueue limits including failed submissions and hosts; persistent device/server budgets for all fresh commands; 24-hour accepted-command deduplication across restarts, one-minute rejection retention, no retry record for over-budget requests; expected revisions; original cached retry results; explicit overload errors without automatic retries |
| Playback state | Desired versus observed state; unique playback IDs; display-only telemetry; reservation remains until `playing` confirmation; duplicate/stale ends rejected; paused restart/recovery; host play/pause/skip/reorder/seek/volume/tempo controls |
| Display fencing | Deployment-scoped generations; durable grants/deadlines; monotonic server expiry; conservative round-trip-based browser lease budgets; initially closed output gate and scheduled gain cutoff; disconnect pause; suspension retirement; cooperative stopped-output release; acknowledgment-only takeover and audited admin physical retirement |
| Media | Server-owned MP3/LRC index with stable opaque IDs and relative references; no general filesystem API; symlink/canonical-path checks repeated on open; authenticated bounded transfers; content types, byte ranges, ETags, last-modified; paginated library search |
| Browser UI | Combined display/host/EnMoku controller frontend; responsive songbook/queue/room controls; LRC from the display media clock; all untrusted strings rendered as text; validated same-origin dynamic invitation URLs; restrictive CSP |
| Persistence and recovery | SQLite WAL with full synchronous durability; kernel-backed singleton lock; consistent verified backup with settings/schema/checksum; atomic restore with new auth epoch, new deployment epoch at boot, fresh login/pairing/invitations, paused queues, and mandatory all-outstanding-display physical recovery |
| Migrations | Transactional schema initialization and version-1 to version-2 indexes; verified pre-upgrade backup; refusal of unknown future schema; older-version rollback can archive newer target data before restore |
| Deployment | Non-root Dockerfile; Compose resource/process bounds and read-only library; Caddy internal TLS example; operator instructions for DNS, trust, renewal, quotas, backups/rollback, and lost-display retirement |

The first hosted player intentionally has only one audible MP3 route. No old microphone/SFX/MIDI/video route is reachable through it. Deadlines are an additional output precaution; **deadline-based takeover is not enabled or claimed**. Takeover always needs a stopped-output acknowledgment or an administrator’s physical-retirement confirmation. Restore additionally requires isolation of every possibly outstanding display, including grants newer than the backup. This remains mandatory even if a recorded old generation acknowledges release.

## Verification performed

- Clean dependency installation, browser build, and ESLint.
- State, HTTP, Socket.IO, recovery, schema, and simulated browser-player tests under `tests/server/`.
- Three simultaneous Socket.IO controllers: snapshots, queue insertion, retry after reconnect, concurrent room-cap overflow, denied controls, and session revocation.
- Authenticated byte ranges and validators, missing credentials, cross-room access, foreign Origin, wrong CSRF, traversal, symlink escape, and registered-target replacement.
- State-machine coverage for confirmation/duplicate end events, reservation/rate admission, restart deduplication, wall-clock changes, generation fencing, physical retirement, restored authentication invalidation, and grants newer than snapshots.
- Recovery tests for corrupt checksums, active-process exclusion, schema upgrade, SQL failure/rollback, process kill before commit, compatible restore from an unsupported future schema, and original snapshot preservation.
- Simulated player tests for closed routing, cutoff preservation during volume changes, delayed lookup/renewal races, disconnect, permanent retirement, stopped audio clock, and release retry. These test control logic, **not physical audible output**.
- An actual local Chromium-based in-app browser loaded the hosted frontend, signed in, created a room, indexed/queued/played an MP3 fixture, advanced LRC text against media time, displayed an HTML/event-handler lyric payload literally, and returned to idle on track completion. The fixture was a temporary silent MP3 encoded locally for testing; it is not distributed as a song/library asset.

No physical latency measurements, low-end profiling, trusted-LAN phone tests, or Docker runtime validation have been performed. The local Docker daemon was unavailable. CI contains a container build check, but adding that check is not evidence that it has run.

## Outstanding roadmap and release gates

| Phase | Remaining work / evidence |
| --- | --- |
| 0 | Phone-to-display microphone feasibility spike on real target hardware; trusted custom-domain HTTPS capture; repeatable mouth-to-speaker delay measurements and device matrix |
| 1 | Execute the supplied container/TLS/DNS setup on a real installation; fresh phone/display profiles and no WAN; verify every required asset and browser API in that environment |
| 2 | Actual TV plus at least three phones, QR/manual pairing through trusted custom DNS, fresh-cache/no-WAN flow, real main-thread stalls and browser/OS suspension including stopped audio clocks, physical speaker cutoff and cooperative release, crashed-display retirement, backup/restore and failed-upgrade drills on container volumes; full multi-role injection matrix; low-end resource profiling |
| 3 | MIDI/SoundFont and reference melody, CD+G, multiplex pan, video/container/codec probing, bounded FFmpeg compatibility jobs/cache, key shifting, representative playback/seek/timing fixtures |
| 4 | Remote microphone grants and generation-scoped signaling; receive-side revocation/emergency mute; one/two independent singer audio graphs; capture presets, calibration, scoring/score-only fallback, STUN/TURN provisioning, Android/iOS foreground/background and Wi-Fi-loss checks; hardware latency/feedback evidence before amplified vocals |
| 5 | Expanded recovery and device matrix; optional opt-in recording/integrations; retention/quotas; full release operational hardening |

Phone microphones and signaling are rejected explicitly. No automatic microphone permission request is made. Scoring, chat, cheers, camera sharing, YouTube, recording, Discord/OBS/native system volume, library metadata import previews, optional host-approval joins, administrator user management, and broader format parity are not implemented in the hosted path. File naming currently provides artist/title; existing manifests and `songdb.json` are not imported. Scanning is bounded to one job, but large-library indexing and search still need low-end profiling and background-worker refinement before the larger format library rollout.

Operator secrets are provisioned outside backups. A credential rotation changes that host identity; use an administrator to recover/reassign rooms rather than treating old browser sessions as proof of identity. The service does not yet provide multi-user account/password management. General host configuration is never exposed to guests.
